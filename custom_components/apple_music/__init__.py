"""Apple Music integration."""
from __future__ import annotations

import asyncio
import json
import logging
from datetime import timedelta

import aiohttp
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform, EVENT_HOMEASSISTANT_STARTED
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .const import CONF_HOST, CONF_PORT, DOMAIN, SCAN_INTERVAL_SECONDS

_LOGGER = logging.getLogger(__name__)

PLATFORMS = [Platform.MEDIA_PLAYER]
POLL_INTERVAL_SSE   = 30  # poll interval when SSE is active
POLL_INTERVAL_FALLBACK = SCAN_INTERVAL_SECONDS  # poll interval when SSE is down (5s)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up Apple Music from a config entry."""
    host = entry.data[CONF_HOST]
    port = entry.data[CONF_PORT]
    session = async_get_clientsession(hass)

    coordinator = AppleMusicCoordinator(hass, session, host, port)

    # First refresh checks server availability - will raise ConfigEntryNotReady if down
    await coordinator.async_config_entry_first_refresh()

    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = coordinator
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)

    # Fix 1: Start listener only after HA bootstrap is finished
    async def _start_background_tasks(_):
        """Start persistent tasks after HA bootstrap is complete."""
        entry.async_create_background_task(
            hass, coordinator._async_sse_listener(), "apple_music_sse_listener"
        )
        # Fix 2: Warm cache with short 10s timeout
        await coordinator._async_warm_library_cache()

    entry.async_on_unload(
        hass.bus.async_listen_once(EVENT_HOMEASSISTANT_STARTED, _start_background_tasks)
    )

    return True


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

    def __init__(self, hass, session, host, port):
        self.session = session
        self.base_url = f"http://{host}:{port}"
        self._airplay_devices = {}
        self._sse_running = True
        self._sse_connected = False

        super().__init__(
            hass,
            _LOGGER,
            name=DOMAIN,
            update_interval=timedelta(seconds=POLL_INTERVAL_FALLBACK),
        )

    async def _async_warm_library_cache(self) -> None:
        """Warms the library cache with a fail-fast 10s timeout."""
        try:
            # Fix 2: Explicit 10s timeout to prevent HA 2-minute stall
            async with self.session.get(
                f"{self.base_url}/library/albums?limit=1",
                timeout=aiohttp.ClientTimeout(total=10)
            ) as resp:
                resp.raise_for_status()
                await resp.json(content_type=None)
                _LOGGER.info("Apple Music library cache warmed")
        except Exception as err:
            _LOGGER.debug("Library cache warm skipped (non-fatal): %s", err)

    async def _async_sse_listener(self) -> None:
        """Connect to /events SSE stream with exponential backoff."""
        backoff = 5
        while self._sse_running:
            try:
                _LOGGER.info("Connecting to Apple Music SSE stream at %s", self.base_url)
                async with self.session.get(
                    f"{self.base_url}/events",
                    timeout=aiohttp.ClientTimeout(total=None, connect=10),
                    headers={"Accept": "text/event-stream"},
                ) as resp:
                    resp.raise_for_status()
                    _LOGGER.info("SSE connected — using %ds poll interval", POLL_INTERVAL_SSE)
                    self._sse_connected = True
                    self.update_interval = timedelta(seconds=POLL_INTERVAL_SSE)
                    backoff = 5 # Reset on success

                    buffer = ""
                    async for chunk in resp.content.iter_chunked(1024):
                        if not self._sse_running:
                            break
                        buffer += chunk.decode("utf-8", errors="ignore")
                        while "\n\n" in buffer:
                            event, buffer = buffer.split("\n\n", 1)
                            for line in event.splitlines():
                                if line.startswith("data:"):
                                    try:
                                        update = json.loads(line[5:].strip())
                                        await self._async_apply_sse_update(update)
                                    except:
                                        pass
            except asyncio.CancelledError:
                break
            except Exception as err:
                _LOGGER.error("SSE connection lost: %s. Retrying in %ds", err, backoff)
            
            self._sse_connected = False
            self.update_interval = timedelta(seconds=POLL_INTERVAL_FALLBACK)
            
            if self._sse_running:
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 60) # Exponential backoff

    async def _async_apply_sse_update(self, update: dict) -> None:
        """Merge SSE notification data into current state."""
        current = dict(self.data or {})
        state = update.get("player_state")
        if state:
            current["player_state"] = state

        new_id = update.get("id")
        if new_id and new_id != "0" and new_id != current.get("id"):
            current.update({
                "id": new_id,
                "name": update.get("name"),
                "artist": update.get("artist"),
                "album": update.get("album"),
                "player_duration": update.get("player_duration"),
                "player_position": 0,
                "position_timestamp": update.get("position_timestamp")
            })
        elif update.get("name"):
            current.update({
                "name": update.get("name"),
                "artist": update.get("artist"),
                "album": update.get("album"),
                "position_timestamp": update.get("position_timestamp")
            })
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
            raise UpdateFailed(f"API Error: {err}") from err

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
        """Send a command to the server."""
        try:
            async with self.session.request(
                method,
                f"{self.base_url}{path}",
                timeout=aiohttp.ClientTimeout(total=10),
                **kwargs,
            ) as resp:
                resp.raise_for_status()
                return await resp.json()
        except Exception as err:
            _LOGGER.error("Command %s %s failed: %s", method, path, err)
            return None

    async def async_get(self, path: str) -> dict | list | None:
        """General GET request helper."""
        try:
            async with self.session.get(
                f"{self.base_url}{path}", timeout=aiohttp.ClientTimeout(total=30)
            ) as resp:
                resp.raise_for_status()
                return await resp.json(content_type=None)
        except Exception as err:
            _LOGGER.error("GET %s failed: %s", path, err)
            return None