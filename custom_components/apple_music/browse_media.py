"""Media browser for Apple Music."""
from __future__ import annotations
import logging, re
from urllib.parse import quote
from homeassistant.components.media_player import BrowseMedia, MediaClass, MediaType
from homeassistant.components.media_player.errors import BrowseError
from homeassistant.helpers.network import is_internal_request
from .const import BROWSE_ALBUMS, BROWSE_ARTISTS, BROWSE_PLAYLISTS, BROWSE_ROOT, BROWSE_SEP

_LOGGER = logging.getLogger(__name__)

def slugify(s): return re.sub(r'^-|-$', '', re.sub(r'[^a-z0-9]+', '-', s.lower()))
def parameterize(s): return slugify(s)
def q(s): return quote(s, safe='')

def _thumb(hass, base_url, static_file, entity, mtype, cid):
    """Return artwork URL.
    Internal: direct /artwork-static/<file> — checks custom-artwork then artwork-cache.
    External: proxied through HA using artwork-static as image_id so proxy
              also benefits from custom-artwork priority."""
    if not entity:
        return None
    if is_internal_request(hass):
        return f"{base_url}/artwork-static/{static_file}"
    # External: HA proxies via async_get_browse_image which fetches base_url/media_image_id
    return entity.get_browse_image_url(mtype, cid, media_image_id=f"artwork-static/{static_file}")

def _node(title, mc, mt, cid, play, expand, children=None, thumbnail=None):
    return BrowseMedia(title=title, media_class=mc, media_content_type=mt,
                       media_content_id=cid, can_play=play, can_expand=expand,
                       children=children, thumbnail=thumbnail)

async def async_browse_media(coordinator, media_content_type, media_content_id, entity=None):
    C, S = coordinator, BROWSE_SEP
    hu, bu = coordinator.hass, coordinator.base_url

    if not media_content_id or media_content_id == BROWSE_ROOT:
        return _node("Apple Music", MediaClass.DIRECTORY, MediaType.MUSIC, BROWSE_ROOT, False, True, [
            _node("Playlists", MediaClass.PLAYLIST, MediaType.PLAYLIST, BROWSE_PLAYLISTS, False, True),
            _node("Artists",   MediaClass.ARTIST,   MediaType.ARTIST,   BROWSE_ARTISTS,   False, True),
            _node("Albums",    MediaClass.ALBUM,     MediaType.ALBUM,    BROWSE_ALBUMS,    False, True),
        ])

    if media_content_id == BROWSE_PLAYLISTS:
        data = await C.async_get("/playlists") or {}
        kids = [_node(pl["name"], MediaClass.PLAYLIST, MediaType.PLAYLIST,
                      f"playlist{S}{pl['id']}", True, False,
                      thumbnail=_thumb(hu, bu,
                                       f"playlist-{slugify(pl['name'])}.jpg",
                                       entity, MediaType.PLAYLIST,
                                       f"playlist{S}{parameterize(pl['name'])}"))
                for pl in data.get("playlists", [])]
        return _node("Playlists", MediaClass.DIRECTORY, MediaType.PLAYLIST, BROWSE_PLAYLISTS, False, True, kids)

    if media_content_id == BROWSE_ARTISTS:
        data = await C.async_get("/library/artists?offset=0&limit=2000") or {}
        kids = [_node(a["name"], MediaClass.ARTIST, MediaType.ARTIST,
                      f"artist{S}{a['name']}", True, True,
                      thumbnail=_thumb(hu, bu,
                                       f"artist-{slugify(a['name'])}.jpg",
                                       entity, MediaType.ARTIST,
                                       f"artist{S}{a['id']}"))
                for a in data.get("artists", [])]
        return _node("Artists", MediaClass.DIRECTORY, MediaType.ARTIST, BROWSE_ARTISTS, False, True, kids)

    if media_content_id == BROWSE_ALBUMS:
        data = await C.async_get("/library/albums?offset=0&limit=2000") or {}
        kids = [_node(f"{al['name']} — {al['artist']}" if al.get("artist") else al["name"],
                      MediaClass.ALBUM, MediaType.ALBUM,
                      f"album{S}{al['artist']}{S}{al['name']}", True, True,
                      thumbnail=_thumb(hu, bu,
                                       f"{slugify(al['artist'] + '||' + al['name'])}.jpg",
                                       entity, MediaType.ALBUM,
                                       f"album{S}{slugify(al['artist'])}{S}{al['id']}"))
                for al in data.get("albums", [])]
        return _node("Albums", MediaClass.DIRECTORY, MediaType.ALBUM, BROWSE_ALBUMS, False, True, kids)

    parts = media_content_id.split(S)

    if parts[0] == "artist" and len(parts) == 2:
        data = await C.async_get(f"/library/artists/{q(parts[1])}/albums") or {}
        an = data.get("artist", parts[1])
        kids = [_node(al["name"], MediaClass.ALBUM, MediaType.ALBUM,
                      f"album{S}{an}{S}{al['name']}", True, True,
                      thumbnail=_thumb(hu, bu,
                                       f"{slugify(an + '||' + al['name'])}.jpg",
                                       entity, MediaType.ALBUM,
                                       f"album{S}{slugify(an)}{S}{al['id']}"))
                for al in data.get("albums", [])]
        return _node(an, MediaClass.ARTIST, MediaType.ARTIST, f"artist{S}{an}", False, True, kids)

    if parts[0] == "album" and len(parts) == 3:
        data = await C.async_get(f"/library/albums/{q(parts[1])}/{q(parts[2])}/tracks") or {}
        kids = [_node(t["name"], MediaClass.TRACK, MediaType.TRACK,
                      f"track{S}{t['id']}", True, False)
                for t in data.get("tracks", [])]
        return _node(data.get("album", parts[2]), MediaClass.ALBUM, MediaType.ALBUM,
                     f"album{S}{parts[1]}{S}{parts[2]}", False, True, kids)

    raise BrowseError(f"Unknown media_content_id: {media_content_id}")
