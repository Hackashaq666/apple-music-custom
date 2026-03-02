"""Media browser implementation for Apple Music."""
from __future__ import annotations

import logging

from homeassistant.components.media_player import BrowseMedia, MediaClass, MediaType
from homeassistant.components.media_player.errors import BrowseError

from .const import (
    BROWSE_ALBUMS,
    BROWSE_ARTISTS,
    BROWSE_PLAYLISTS,
    BROWSE_ROOT,
    BROWSE_SEP,
)

_LOGGER = logging.getLogger(__name__)

# ── Content ID scheme ─────────────────────────────────────────────────────────
#
#   root                          → top-level menu
#   playlists                     → list all playlists
#   artists                       → list all artists
#   albums                        → list all albums (paginated, first page)
#   artist||<artist_id>           → albums by a specific artist
#   album||<artist_id>||<album_id>→ tracks in a specific album
#


async def async_browse_media(coordinator, media_content_type: str, media_content_id: str) -> BrowseMedia:
    """Return a BrowseMedia tree node for the given content id."""

    if media_content_id == BROWSE_ROOT or media_content_id is None:
        return _build_root()

    if media_content_id == BROWSE_PLAYLISTS:
        return await _browse_playlists(coordinator)

    if media_content_id == BROWSE_ARTISTS:
        return await _browse_artists(coordinator)

    if media_content_id == BROWSE_ALBUMS:
        return await _browse_albums(coordinator)

    parts = media_content_id.split(BROWSE_SEP)

    if parts[0] == "artist" and len(parts) == 2:
        return await _browse_artist_albums(coordinator, parts[1])

    if parts[0] == "album" and len(parts) == 3:
        return await _browse_album_tracks(coordinator, parts[1], parts[2])

    raise BrowseError(f"Unknown media_content_id: {media_content_id}")


# ── Root ──────────────────────────────────────────────────────────────────────

def _build_root() -> BrowseMedia:
    return BrowseMedia(
        title="Apple Music",
        media_class=MediaClass.DIRECTORY,
        media_content_type=MediaType.MUSIC,
        media_content_id=BROWSE_ROOT,
        can_play=False,
        can_expand=True,
        children=[
            BrowseMedia(
                title="Playlists",
                media_class=MediaClass.PLAYLIST,
                media_content_type=MediaType.PLAYLIST,
                media_content_id=BROWSE_PLAYLISTS,
                can_play=False,
                can_expand=True,
            ),
            BrowseMedia(
                title="Artists",
                media_class=MediaClass.ARTIST,
                media_content_type=MediaType.ARTIST,
                media_content_id=BROWSE_ARTISTS,
                can_play=False,
                can_expand=True,
            ),
            BrowseMedia(
                title="Albums",
                media_class=MediaClass.ALBUM,
                media_content_type=MediaType.ALBUM,
                media_content_id=BROWSE_ALBUMS,
                can_play=False,
                can_expand=True,
            ),
        ],
    )


# ── Playlists ─────────────────────────────────────────────────────────────────

async def _browse_playlists(coordinator) -> BrowseMedia:
    data = await coordinator.async_get("/playlists")
    if not data:
        raise BrowseError("Could not fetch playlists")

    children = [
        BrowseMedia(
            title=pl["name"],
            media_class=MediaClass.PLAYLIST,
            media_content_type=MediaType.PLAYLIST,
            media_content_id=f"playlist{BROWSE_SEP}{pl['id']}",
            can_play=True,
            can_expand=False,
        )
        for pl in data.get("playlists", [])
    ]

    return BrowseMedia(
        title="Playlists",
        media_class=MediaClass.DIRECTORY,
        media_content_type=MediaType.PLAYLIST,
        media_content_id=BROWSE_PLAYLISTS,
        can_play=False,
        can_expand=True,
        children=children,
    )


# ── Artists ───────────────────────────────────────────────────────────────────

async def _browse_artists(coordinator) -> BrowseMedia:
    data = await coordinator.async_get("/library/artists?offset=0&limit=2000")
    if not data:
        raise BrowseError("Could not fetch artists")

    children = [
        BrowseMedia(
            title=artist["name"],
            media_class=MediaClass.ARTIST,
            media_content_type=MediaType.ARTIST,
            media_content_id=f"artist{BROWSE_SEP}{artist['name']}",
            can_play=False,
            can_expand=True,
        )
        for artist in data.get("artists", [])
    ]

    return BrowseMedia(
        title="Artists",
        media_class=MediaClass.DIRECTORY,
        media_content_type=MediaType.ARTIST,
        media_content_id=BROWSE_ARTISTS,
        can_play=False,
        can_expand=True,
        children=children,
    )


# ── Albums (all) ──────────────────────────────────────────────────────────────

async def _browse_albums(coordinator) -> BrowseMedia:
    data = await coordinator.async_get("/library/albums?offset=0&limit=2000")
    if not data:
        raise BrowseError("Could not fetch albums")

    children = [
        BrowseMedia(
            title=f"{album['name']} — {album['artist']}" if album.get("artist") else album["name"],
            media_class=MediaClass.ALBUM,
            media_content_type=MediaType.ALBUM,
            media_content_id=f"album{BROWSE_SEP}{album['artist']}{BROWSE_SEP}{album['name']}",
            can_play=False,
            can_expand=True,
        )
        for album in data.get("albums", [])
    ]

    return BrowseMedia(
        title="Albums",
        media_class=MediaClass.DIRECTORY,
        media_content_type=MediaType.ALBUM,
        media_content_id=BROWSE_ALBUMS,
        can_play=False,
        can_expand=True,
        children=children,
    )


# ── Albums by artist ──────────────────────────────────────────────────────────

async def _browse_artist_albums(coordinator, artist_id: str) -> BrowseMedia:
    from urllib.parse import quote
    data = await coordinator.async_get(f"/library/artists/{quote(artist_id, safe='')}/albums")
    if not data:
        raise BrowseError(f"Could not fetch albums for artist {artist_id}")

    artist_name = data.get("artist", artist_id)
    children = [
        BrowseMedia(
            title=album["name"],
            media_class=MediaClass.ALBUM,
            media_content_type=MediaType.ALBUM,
            media_content_id=f"album{BROWSE_SEP}{artist_name}{BROWSE_SEP}{album['name']}",
            can_play=False,
            can_expand=True,
        )
        for album in data.get("albums", [])
    ]

    return BrowseMedia(
        title=artist_name,
        media_class=MediaClass.ARTIST,
        media_content_type=MediaType.ARTIST,
        media_content_id=f"artist{BROWSE_SEP}{artist_name}",
        can_play=False,
        can_expand=True,
        children=children,
    )


# ── Tracks in album ───────────────────────────────────────────────────────────

async def _browse_album_tracks(coordinator, artist_id: str, album_id: str) -> BrowseMedia:
    from urllib.parse import quote
    data = await coordinator.async_get(
        f"/library/albums/{quote(artist_id, safe='')}/{quote(album_id, safe='')}/tracks"
    )
    if not data:
        raise BrowseError(f"Could not fetch tracks for album {album_id}")

    album_name = data.get("album", album_id)
    children = [
        BrowseMedia(
            title=track["name"],
            media_class=MediaClass.TRACK,
            media_content_type=MediaType.TRACK,
            media_content_id=f"track{BROWSE_SEP}{track['id']}",
            can_play=True,
            can_expand=False,
        )
        for track in data.get("tracks", [])
    ]

    return BrowseMedia(
        title=album_name,
        media_class=MediaClass.ALBUM,
        media_content_type=MediaType.ALBUM,
        media_content_id=f"album{BROWSE_SEP}{artist_id}{BROWSE_SEP}{album_id}",
        can_play=False,
        can_expand=True,
        children=children,
    )
