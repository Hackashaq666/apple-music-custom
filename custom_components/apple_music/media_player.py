"""Apple Music media player entity."""
from __future__ import annotations

import logging
from collections import OrderedDict
from datetime import datetime, timezone

from homeassistant.components.media_player import (
    BrowseMedia,
    MediaPlayerEntity,
    MediaPlayerEntityFeature,
    MediaPlayerState,
    MediaType,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from . import AppleMusicCoordinator
from .browse_media import async_browse_media
from .const import BROWSE_SEP, CONF_HOST, CONF_PORT, DOMAIN

_LOGGER = logging.getLogger(__name__)

# In-memory LRU cache for browse artwork — avoids repeated Mac round trips on scroll
_BROWSE_IMAGE_CACHE: OrderedDict = OrderedDict()
_BROWSE_IMAGE_CACHE_MAX = 200

# Features supported by the main Apple Music player
MAIN_PLAYER_FEATURES = (
    MediaPlayerEntityFeature.PLAY
    | MediaPlayerEntityFeature.PAUSE
    | MediaPlayerEntityFeature.STOP
    | MediaPlayerEntityFeature.NEXT_TRACK
    | MediaPlayerEntityFeature.PREVIOUS_TRACK
    | MediaPlayerEntityFeature.VOLUME_SET
    | MediaPlayerEntityFeature.VOLUME_MUTE
    | MediaPlayerEntityFeature.SHUFFLE_SET
    | MediaPlayerEntityFeature.REPEAT_SET
    | MediaPlayerEntityFeature.SEEK
    | MediaPlayerEntityFeature.PLAY_MEDIA
    | MediaPlayerEntityFeature.BROWSE_MEDIA
)

# Features for AirPlay speaker entities
AIRPLAY_FEATURES = (
    MediaPlayerEntityFeature.VOLUME_SET
    | MediaPlayerEntityFeature.TURN_ON
    | MediaPlayerEntityFeature.TURN_OFF
)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Set up Apple Music media player entities from a config entry."""
    coordinator: AppleMusicCoordinator = hass.data[DOMAIN][entry.entry_id]

    entities: list[MediaPlayerEntity] = [AppleMusicPlayer(coordinator, entry)]

    # Discover AirPlay devices and add each as a separate media player
    airplay_data = await coordinator.async_get("/airplay_devices")
    if airplay_data:
        for device in airplay_data.get("airplay_devices", []):
            entities.append(AirPlaySpeaker(coordinator, entry, device))

    async_add_entities(entities, update_before_add=True)


# ── Main Apple Music player ───────────────────────────────────────────────────

class AppleMusicPlayer(CoordinatorEntity, MediaPlayerEntity):
    """Representation of the Apple Music player on the Mac."""

    _attr_has_entity_name = True
    _attr_name = None  # Uses device name as entity name

    def __init__(self, coordinator: AppleMusicCoordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator)
        self._entry = entry
        self._optimistic_volume = 0.5
        self._optimistic_shuffle: bool | None = None
        self._optimistic_repeat: str | None = None
        self._attr_unique_id = f"{entry.entry_id}_player"
        self._attr_device_info = {
            "identifiers": {(DOMAIN, entry.entry_id)},
            "name": "Apple Music",
            "manufacturer": "Apple",
            "model": "Music for macOS",
            "configuration_url": coordinator.base_url,
        }

    @property
    def supported_features(self) -> MediaPlayerEntityFeature:
        return MAIN_PLAYER_FEATURES

    @property
    def _state_data(self) -> dict:
        return self.coordinator.data or {}

    @property
    def state(self) -> MediaPlayerState:
        s = self._state_data.get("player_state", "stopped")
        return {
            "playing": MediaPlayerState.PLAYING,
            "paused":  MediaPlayerState.PAUSED,
            "stopped": MediaPlayerState.IDLE,
        }.get(s, MediaPlayerState.IDLE)

    @property
    def media_content_type(self) -> str:
        return MediaType.MUSIC

    @property
    def media_title(self) -> str | None:
        return self._state_data.get("name")

    @property
    def media_artist(self) -> str | None:
        return self._state_data.get("artist")

    @property
    def media_album_name(self) -> str | None:
        return self._state_data.get("album")

    @property
    def media_image_url(self) -> str | None:
        if self._state_data.get("player_state") != "stopped":
            track_id = self._state_data.get("id", "")
            return f"{self.coordinator.base_url}/artwork?track={track_id}"
        return None

    @property
    def media_image_remotely_accessible(self) -> bool:
        # Image is served from the local Mac — not reachable from outside the LAN
        return False


    @property
    def volume_level(self) -> float:
        vol = self._state_data.get("volume")
        if vol is not None:
            self._optimistic_volume = float(vol) / 100.0
        return self._optimistic_volume

    @property
    def volume_step(self) -> float:
        return 0.01

    @property
    def is_volume_muted(self) -> bool | None:
        return self._state_data.get("muted")

    @property
    def shuffle(self) -> bool:
        if self._optimistic_shuffle is not None:
            return self._optimistic_shuffle
        return bool(self._state_data.get("shuffle"))

    @property
    def repeat(self) -> str:
        if self._optimistic_repeat is not None:
            return self._optimistic_repeat
        r = self._state_data.get("repeat", "off")
        # HA uses "off", "all", "one" — server uses same values
        return r if r in ("off", "all", "one") else "off"

    # ── Progress tracking ─────────────────────────────────────────────────────
    # HA uses media_position + media_position_updated_at to interpolate the
    # progress bar live between polls — no need to update every second.

    @property
    def media_position(self) -> float | None:
        return self._state_data.get("player_position")

    @property
    def media_position_updated_at(self) -> datetime | None:
        ts = self._state_data.get("position_timestamp")
        if ts is not None:
            # Server sends Unix epoch in milliseconds
            return datetime.fromtimestamp(ts / 1000, tz=timezone.utc)
        return None

    @property
    def media_duration(self) -> float | None:
        return self._state_data.get("player_duration")

    # ── Commands ──────────────────────────────────────────────────────────────

    async def async_media_play(self) -> None:
        await self.coordinator.async_send_command("PUT", "/play")
        await self.coordinator.async_request_refresh()

    async def async_media_pause(self) -> None:
        await self.coordinator.async_send_command("PUT", "/pause")
        await self.coordinator.async_request_refresh()

    async def async_media_stop(self) -> None:
        await self.coordinator.async_send_command("PUT", "/stop")
        await self.coordinator.async_request_refresh()

    async def async_media_next_track(self) -> None:
        await self.coordinator.async_send_command("PUT", "/next")
        await self.coordinator.async_request_refresh()

    async def async_media_previous_track(self) -> None:
        await self.coordinator.async_send_command("PUT", "/previous")
        await self.coordinator.async_request_refresh()

    async def async_set_volume_level(self, volume: float) -> None:
        self._optimistic_volume = float(volume)
        # Patch coordinator data immediately so polls don't snap the slider back
        if self.coordinator.data:
            self.coordinator.data = dict(self.coordinator.data)
            self.coordinator.data["volume"] = int(volume * 100)
        self.async_write_ha_state()
        level = int(volume * 100)
        await self.coordinator.async_send_command("PUT", "/volume", data={"level": level})

    async def async_mute_volume(self, mute: bool) -> None:
        await self.coordinator.async_send_command("PUT", "/mute", data={"muted": str(mute).lower()})
        await self.coordinator.async_request_refresh()

    async def async_set_shuffle(self, shuffle: bool) -> None:
        mode = "songs" if shuffle else "off"
        self._optimistic_shuffle = shuffle
        self.async_write_ha_state()
        await self.coordinator.async_send_command("PUT", "/shuffle", data={"mode": mode})
        self._optimistic_shuffle = None
        await self.coordinator.async_request_refresh()

    async def async_set_repeat(self, repeat: str) -> None:
        self._optimistic_repeat = repeat
        self.async_write_ha_state()
        await self.coordinator.async_send_command("PUT", "/repeat", data={"mode": repeat})
        self._optimistic_repeat = None
        await self.coordinator.async_request_refresh()

    async def async_media_seek(self, position: float) -> None:
        await self.coordinator.async_send_command("PUT", "/seek", data={"position": position})
        await self.coordinator.async_request_refresh()

    async def async_play_media(
        self, media_type: str, media_id: str, **kwargs
    ) -> None:
        """Play media from the browser or directly by ID."""
        parts = media_id.split(BROWSE_SEP)

        if parts[0] == "playlist" and len(parts) == 2:
            await self.coordinator.async_send_command(
                "PUT", f"/playlists/{parts[1]}/play"
            )
        elif parts[0] == "track" and len(parts) == 2:
            # Optimistically update state so UI feels instant
            track_id = parts[1]
            current = dict(self.coordinator.data or {})
            current["player_state"] = "playing"
            current["id"] = track_id
            current["player_position"] = 0
            current["position_timestamp"] = None
            self.coordinator.async_set_updated_data(current)

            # Fire command without blocking — notify.py will push the real state via SSE
            self.hass.async_create_task(
                self.coordinator.async_send_command(
                    "PUT", f"/library/tracks/{track_id}/play"
                )
            )
            return
        else:
            _LOGGER.warning("Unrecognised media_id for play_media: %s", media_id)
            return

        await self.coordinator.async_request_refresh()

    async def async_get_browse_image(
        self,
        media_content_type: str,
        media_content_id: str,
        media_image_id: str | None = None,
    ) -> tuple[bytes | None, str | None]:
        """Proxy browse artwork through HA so mobile clients can access it."""
        if not media_image_id:
            return None, None
        cache_key = media_image_id
        if cache_key in _BROWSE_IMAGE_CACHE:
            _BROWSE_IMAGE_CACHE.move_to_end(cache_key)
            return _BROWSE_IMAGE_CACHE[cache_key]
        url = f"{self.coordinator.base_url}/{media_image_id}"
        result = await self._async_fetch_image(url)
        if result[0] is not None:
            _BROWSE_IMAGE_CACHE[cache_key] = result
            _BROWSE_IMAGE_CACHE.move_to_end(cache_key)
            if len(_BROWSE_IMAGE_CACHE) > _BROWSE_IMAGE_CACHE_MAX:
                _BROWSE_IMAGE_CACHE.popitem(last=False)
        return result

    # ── Media browser ─────────────────────────────────────────────────────────

    async def async_browse_media(
        self,
        media_content_type: str | None = None,
        media_content_id: str | None = None,
    ) -> BrowseMedia:
        return await async_browse_media(
            self.coordinator,
            media_content_type or "",
            media_content_id or "root",
            self,
        )


def _map_airplay_kind(device_data: dict) -> str:
    """Map Music app kind strings to human-readable model names."""
    kind = device_data.get("kind", "")
    name = device_data.get("name", "").lower()

    if kind == "AirPort Express":
        return "AirPort Express"
    if kind == "AirPlay device":
        return "AirPlay Speaker"
    if kind == "computer":
        return "Mac"
    if kind == "unknown":
        if "apple tv" in name:
            return "Apple TV"
        if device_data.get("supports_video"):
            return "Apple TV"
        return "AirPlay Speaker"
    return kind or "AirPlay Device"


# ── AirPlay speaker entity ────────────────────────────────────────────────────

class AirPlaySpeaker(CoordinatorEntity, MediaPlayerEntity):
    """Represents a single AirPlay endpoint as a media player."""

    _attr_has_entity_name = True
    _attr_name = None

    def __init__(
        self,
        coordinator: AppleMusicCoordinator,
        entry: ConfigEntry,
        device_data: dict,
    ) -> None:
        super().__init__(coordinator)
        self._entry = entry
        self._device_id = device_data["id"]
        self._optimistic_volume = float(device_data.get("sound_volume", 0)) / 100.0
        self._attr_unique_id = f"{entry.entry_id}_airplay_{self._device_id}"
        self._attr_device_info = {
            "identifiers": {(DOMAIN, f"{entry.entry_id}_airplay_{self._device_id}")},
            "name": device_data["name"],
            "manufacturer": "Apple",
            "model": _map_airplay_kind(device_data),
        }

    @property
    def supported_features(self) -> MediaPlayerEntityFeature:
        return AIRPLAY_FEATURES

    def _get_device_data(self) -> dict | None:
        """Find this speaker's current data from the coordinator's airplay cache."""
        # AirPlay state is fetched separately; we store it as extra data on the coordinator
        return getattr(self.coordinator, "_airplay_devices", {}).get(self._device_id)

    @property
    def state(self) -> MediaPlayerState:
        data = self._get_device_data()
        if data and data.get("selected"):
            return MediaPlayerState.ON
        return MediaPlayerState.OFF

    @property
    def volume_level(self) -> float:
        data = self._get_device_data()
        if data is not None:
            vol = data.get("sound_volume")
            if vol is not None:
                self._optimistic_volume = float(vol) / 100.0
            return self._optimistic_volume
        return self._optimistic_volume

    @property
    def volume_step(self) -> float:
        return 0.01

    async def async_turn_on(self) -> None:
        devices = getattr(self.coordinator, "_airplay_devices", {})
        if self._device_id in devices:
            devices[self._device_id] = dict(devices[self._device_id])
            devices[self._device_id]["selected"] = True
        self.async_write_ha_state()
        await self.coordinator.async_send_command(
            "PUT", f"/airplay_devices/{self._device_id}/on"
        )
        await self.coordinator.async_request_refresh()

    async def async_turn_off(self) -> None:
        devices = getattr(self.coordinator, "_airplay_devices", {})
        if self._device_id in devices:
            devices[self._device_id] = dict(devices[self._device_id])
            devices[self._device_id]["selected"] = False
        self.async_write_ha_state()
        await self.coordinator.async_send_command(
            "PUT", f"/airplay_devices/{self._device_id}/off"
        )
        await self.coordinator.async_request_refresh()

    async def async_set_volume_level(self, volume: float) -> None:
        volume = float(volume)
        self._optimistic_volume = volume
        # Patch the coordinator cache immediately so polls don't snap the slider back
        devices = getattr(self.coordinator, "_airplay_devices", {})
        if self._device_id in devices:
            devices[self._device_id] = dict(devices[self._device_id])
            devices[self._device_id]["sound_volume"] = int(volume * 100)
        self.async_write_ha_state()
        level = int(volume * 100)
        await self.coordinator.async_send_command(
            "PUT",
            f"/airplay_devices/{self._device_id}/volume",
            data={"level": level},
        )