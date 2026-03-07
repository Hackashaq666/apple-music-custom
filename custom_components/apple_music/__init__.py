"""Apple Music integration."""
from __future__ import annotations

import asyncio
import json
import logging
from datetime import timedelta

import aiohttp
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .const import CONF_HOST, CONF_PORT, DOMAIN, SCAN_INTERVAL_SECONDS

_LOGGER = logging.getLogger(__name__)

PLATFORMS = [Platform.MEDIA_PLAYER]
SSE_RECONNECT_DELAY = 5   # seconds between SSE reconnect attempts
POLL_INTERVAL_SSE   = 30  # poll interval when SSE is active (for position/airplay sync)
POLL_INTERVAL_FALLBACK = SCAN_INTERVAL_SECONDS  # poll interval when SSE is down


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up Apple Music from a config entry."""
    host = entry.data[CONF_HOST]
    port = entry.data[CONF_PORT]
    session = async_get_clientsession(hass)

    coordinator = AppleMusicCoordinator(hass, session, host, port)

    # Do first refresh — raises ConfigEntryNotReady if server unreachable
    await coordinator.async_config_entry_first_refresh()

    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = coordinator

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)

    # Start SSE listener in background
    hass.async_create_task(coordinator._async_sse_listener())

    # Trigger library cache warm in the background so media browser is ready
    hass.async_create_task(_async_warm_library_cache(coordinator))

    return True


async def _async_warm_library_cache(coordinator) -> None:
    """Hit the library endpoint once at startup to warm the server-side cache."""
    try:
        await asyncio.sleep(5)
        await coordinator.async_get("/library/albums?limit=1")
        _LOGGER.debug("Apple Music library cache warmed successfully")
    except Exception as err:
        _LOGGER.debug("Library cache warm failed (non-fatal): %s", err)


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    coordinator = hass.data[DOMAIN].get(entry.entry_id)
    if coordinator:
        coordinator._sse_running = False
    unload_ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unload_ok:
        hass.data[DOMAIN].pop(entry.entry_id)
    return unload_ok


class AppleMusicCoordinator(DataUpdateCoordinator):
    """Coordinator that uses SSE for instant updates with polling fallback."""

    def __init__(
        self,
        hass: HomeAssistant,
        session: aiohttp.ClientSession,
        host: str,
        port: int,
    ) -> None:
        self.session = session
        self.base_url = f"http://{host}:{port}"
        self._airplay_devices: dict[str, dict] = {}
        self._sse_running = True
        self._sse_connected = False

        super().__init__(
            hass,
            _LOGGER,
            name=DOMAIN,
            update_interval=timedelta(seconds=POLL_INTERVAL_FALLBACK),
        )

    async def _async_sse_listener(self) -> None:
        """Connect to /events SSE stream and update state on push."""
        while self._sse_running:
            try:
                _LOGGER.debug("Apple Music: connecting to SSE stream")
                async with self.session.get(
                    f"{self.base_url}/events",
                    timeout=aiohttp.ClientTimeout(total=None, connect=10),
                    headers={"Accept": "text/event-stream"},
                ) as resp:
                    resp.raise_for_status()
                    _LOGGER.debug("Apple Music: SSE connected — switching to %ds poll interval", POLL_INTERVAL_SSE)
                    self._sse_connected = True
                    self.update_interval = timedelta(seconds=POLL_INTERVAL_SSE)

                    buffer = ""
                    async for chunk in resp.content.iter_chunked(1024):
                        if not self._sse_running:
                            break
                        buffer += chunk.decode("utf-8", errors="ignore")
                        while "\n\n" in buffer:
                            event, buffer = buffer.split("\n\n", 1)
                            for line in event.splitlines():
                                if line.startswith("data:"):
                                    raw = line[5:].strip()
                                    try:
                                        update = json.loads(raw)
                                        await self._async_apply_sse_update(update)
                                    except json.JSONDecodeError:
                                        pass

            except asyncio.CancelledError:
                break
            except Exception as err:
                _LOGGER.debug("Apple Music SSE disconnected: %s — retrying in %ds", err, SSE_RECONNECT_DELAY)

            self._sse_connected = False
            self.update_interval = timedelta(seconds=POLL_INTERVAL_FALLBACK)
            if self._sse_running:
                await asyncio.sleep(SSE_RECONNECT_DELAY)

    async def _async_apply_sse_update(self, update: dict) -> None:
        """Merge SSE notification data into current state and notify listeners."""
        current = dict(self.data or {})

        # Map notification player state
        state = update.get("player_state", "")
        if state:
            current["player_state"] = state

        # Update track info if track changed.
        # Ignore id "0" or "" — shuffle/seek notifications from macOS sometimes
        # fire with PersistentID=0 (no track change), which would wrongly reset artwork.
        new_id = update.get("id", "")
        valid_new_id = new_id and new_id != "0"
        if valid_new_id and new_id != current.get("id"):
            current["id"]              = new_id
            current["name"]            = update.get("name", current.get("name"))
            current["artist"]          = update.get("artist", current.get("artist"))
            current["album"]           = update.get("album", current.get("album"))
            current["player_duration"] = update.get("player_duration", current.get("player_duration"))
            current["player_position"] = 0
            current["position_timestamp"] = update.get("position_timestamp", current.get("position_timestamp"))
        elif update.get("name"):
            current["name"]   = update.get("name", current.get("name"))
            current["artist"] = update.get("artist", current.get("artist"))
            current["album"]  = update.get("album", current.get("album"))
            current["position_timestamp"] = update.get("position_timestamp", current.get("position_timestamp"))

        self.async_set_updated_data(current)

    async def _async_update_data(self) -> dict:
        """Poll for full player state and AirPlay devices."""
        try:
            async with self.session.get(
                f"{self.base_url}/now_playing", timeout=aiohttp.ClientTimeout(total=5)
            ) as resp:
                resp.raise_for_status()
                now_playing = await resp.json()
        except Exception as err:
            raise UpdateFailed(f"Error communicating with Apple Music API: {err}") from err

        try:
            async with self.session.get(
                f"{self.base_url}/airplay_devices", timeout=aiohttp.ClientTimeout(total=5)
            ) as resp:
                resp.raise_for_status()
                airplay_data = await resp.json()
                self._airplay_devices = {
                    d["id"]: d for d in airplay_data.get("airplay_devices", [])
                }
        except Exception as err:
            _LOGGER.debug("AirPlay poll failed (non-fatal): %s", err)

        return now_playing

    async def async_send_command(self, method: str, path: str, **kwargs) -> dict | None:
        """Send a command to the server and return the response JSON."""
        try:
            async with self.session.request(
                method,
                f"{self.base_url}{path}",
                timeout=aiohttp.ClientTimeout(total=30),
                **kwargs,
            ) as resp:
                resp.raise_for_status()
                return await resp.json()
        except Exception as err:
            _LOGGER.error("Command %s %s failed: %s", method, path, err)
            return None

    async def async_get(self, path: str) -> dict | list | None:
        """GET a path and return parsed JSON."""
        url = f"{self.base_url}{path}"
        try:
            async with self.session.get(
                url, timeout=aiohttp.ClientTimeout(total=120)
            ) as resp:
                resp.raise_for_status()
                return await resp.json(content_type=None)
        except Exception as err:
            _LOGGER.error("GET %s failed: %s - %s", path, type(err).__name__, err)
            return None