"""Apple Music integration."""
from __future__ import annotations

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

    # Trigger library cache warm in the background so media browser is ready
    hass.async_create_task(_async_warm_library_cache(coordinator))

    return True


async def _async_warm_library_cache(coordinator) -> None:
    """Hit the library endpoint once at startup to warm the server-side cache."""
    import asyncio
    try:
        await asyncio.sleep(5)
        await coordinator.async_get("/library/albums?limit=1")
        _LOGGER.debug("Apple Music library cache warmed successfully")
    except Exception as err:
        _LOGGER.debug("Library cache warm failed (non-fatal): %s", err)


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    unload_ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unload_ok:
        hass.data[DOMAIN].pop(entry.entry_id)
    return unload_ok


class AppleMusicCoordinator(DataUpdateCoordinator):
    """Coordinator that polls the Apple Music API server."""

    def __init__(
        self,
        hass: HomeAssistant,
        session: aiohttp.ClientSession,
        host: str,
        port: int,
    ) -> None:
        """Initialise the coordinator."""
        self.session = session
        self.base_url = f"http://{host}:{port}"
        # Cache of AirPlay device states keyed by device id, updated every poll
        self._airplay_devices: dict[str, dict] = {}

        super().__init__(
            hass,
            _LOGGER,
            name=DOMAIN,
            update_interval=timedelta(seconds=SCAN_INTERVAL_SECONDS),
        )

    async def _async_update_data(self) -> dict:
        """Fetch latest player state and AirPlay device states from the server."""
        try:
            async with self.session.get(
                f"{self.base_url}/now_playing", timeout=aiohttp.ClientTimeout(total=5)
            ) as resp:
                resp.raise_for_status()
                now_playing = await resp.json()
        except Exception as err:
            raise UpdateFailed(f"Error communicating with Apple Music API: {err}") from err

        # Poll AirPlay devices on the same interval and cache by device id
        # so AirPlaySpeaker entities can read current selected/volume state.
        # Failure here is non-fatal — log and keep last known state.
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

    # ── Convenience API methods called by media_player ───────────────────────

    async def async_send_command(self, method: str, path: str, **kwargs) -> dict | None:
        """Send a command to the server and return the response JSON."""
        try:
            async with self.session.request(
                method,
                f"{self.base_url}{path}",
                timeout=aiohttp.ClientTimeout(total=5),
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