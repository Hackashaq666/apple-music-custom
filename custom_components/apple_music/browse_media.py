"""Media browser for Apple Music."""
from __future__ import annotations
import logging, re
from urllib.parse import quote
from homeassistant.components.media_player import BrowseMedia, MediaClass, MediaType
from homeassistant.components.media_player.errors import BrowseError
from .const import (
    BROWSE_ALBUMS, BROWSE_ARTISTS, BROWSE_GENRES, BROWSE_PLAYLISTS,
    BROWSE_ROOT, BROWSE_SEP, BROWSE_TRACKS,
)

_LOGGER = logging.getLogger(__name__)

def slugify(s): return re.sub(r'^-|-$', '', re.sub(r'[^a-z0-9]+', '-', s.lower()))
def parameterize(s): return slugify(s)
def q(s): return quote(s, safe='')

def _first_letter(name: str) -> str:
    if not name:
        return '#'
    c = name.lstrip(' ').upper()[0]
    return c if c.isalpha() else '#'

def _thumb(hass, base_url, static_file, entity, mtype, cid):
    # Always use HA's media proxy URL instead of the direct server URL.
    # Direct HTTP URLs (http://mac-server:8181/...) cause Mixed Content
    # blocking in Safari when HA is served over HTTPS.
    if not entity:
        return None
    return entity.get_browse_image_url(mtype, cid, media_image_id=f"artwork-static/{static_file}")

def _node(title, mc, mt, cid, play, expand, children=None, thumbnail=None):
    return BrowseMedia(title=title, media_class=mc, media_content_type=mt,
                       media_content_id=cid, can_play=play, can_expand=expand,
                       children=children, thumbnail=thumbnail)

def _track_cid(t, S):
    """media_content_id für einen Track: track||id||artist||album||mediaKind"""
    mk = t.get('mediaKind', 'song')
    return f"track{S}{t.get('id','')}{S}{t.get('albumArtist') or t.get('artist','')}{S}{t.get('album','')}{S}{mk}"

def _track_thumb(t, hu, bu, entity, S):
    """Artwork für einen Track aus albumArtist + album aufbauen."""
    album  = t.get("album") or ""
    artist = t.get("albumArtist") or t.get("artist") or ""
    if not album:
        return None
    static_file = f"{slugify(artist + '||' + album)}.jpg"
    cid = _track_cid(t, S)
    return _thumb(hu, bu, static_file, entity, MediaType.TRACK, cid)

async def async_browse_media(coordinator, media_content_type, media_content_id, entity=None):
    C, S = coordinator, BROWSE_SEP
    hu, bu = coordinator.hass, coordinator.base_url

    # ── Root ──────────────────────────────────────────────────────────────────
    if not media_content_id or media_content_id == BROWSE_ROOT:
        return _node("Apple Music", MediaClass.DIRECTORY, MediaType.MUSIC, BROWSE_ROOT, False, True, [
            _node("Playlists", MediaClass.PLAYLIST, MediaType.PLAYLIST, BROWSE_PLAYLISTS, False, True),
            _node("Artists",   MediaClass.ARTIST,   MediaType.ARTIST,   BROWSE_ARTISTS,   False, True),
            _node("Albums",    MediaClass.ALBUM,     MediaType.ALBUM,    BROWSE_ALBUMS,    False, True),
            _node("Tracks",    MediaClass.TRACK,     MediaType.TRACK,    BROWSE_TRACKS,    False, True),
            _node("Genres",    MediaClass.GENRE,     MediaType.GENRE,    BROWSE_GENRES,    False, True),
        ])

    # ── Playlists ─────────────────────────────────────────────────────────────
    if media_content_id == BROWSE_PLAYLISTS:
        data = await C.async_get("/playlists") or {}
        kids = [_node(pl["name"], MediaClass.PLAYLIST, MediaType.PLAYLIST,
                      f"playlist{S}{pl['id']}{S}{pl.get('mediaKind','song')}", True, True,
                      thumbnail=_thumb(hu, bu,
                                       f"playlist-{slugify(pl['name'])}.jpg",
                                       entity, MediaType.PLAYLIST,
                                       f"playlist{S}{parameterize(pl['name'])}"))
                for pl in data.get("playlists", [])]
        return _node("Playlists", MediaClass.DIRECTORY, MediaType.PLAYLIST,
                     BROWSE_PLAYLISTS, False, True, kids)

    # ── Genres ────────────────────────────────────────────────────────────────
    if media_content_id == BROWSE_GENRES:
        data = await C.async_get("/library/genres") or {}
        kids = [_node(f"{g['name']} ({g['count']})", MediaClass.GENRE, MediaType.GENRE,
                      f"genre{S}{g['name']}{S}{g.get('mediaKind','song')}", True, True)
                for g in data.get("genres", [])]
        return _node("Genres", MediaClass.DIRECTORY, MediaType.GENRE,
                     BROWSE_GENRES, False, True, kids)

    # ── Artists — Buchstaben-Übersicht ────────────────────────────────────────
    if media_content_id == BROWSE_ARTISTS:
        data = await C.async_get("/library/artists?offset=0&limit=5000") or {}
        buckets: dict[str, list] = {}
        for a in data.get("artists", []):
            buckets.setdefault(_first_letter(a["name"]), []).append(a)
        letters = sorted(l for l in buckets if l != '#') + (['#'] if '#' in buckets else [])
        kids = [_node(f"{l} ({len(buckets[l])})", MediaClass.DIRECTORY, MediaType.ARTIST,
                      f"artists_letter{S}{l}", False, True)
                for l in letters]
        return _node("Artists", MediaClass.DIRECTORY, MediaType.ARTIST,
                     BROWSE_ARTISTS, False, True, kids)

    # ── Artists — Einträge eines Buchstabens ──────────────────────────────────
    if media_content_id.startswith(f"artists_letter{S}"):
        letter = media_content_id[len(f"artists_letter{S}"):]
        data = await C.async_get("/library/artists?offset=0&limit=5000") or {}
        filtered = [a for a in data.get("artists", []) if _first_letter(a["name"]) == letter]
        kids = [_node(a["name"], MediaClass.ARTIST, MediaType.ARTIST,
                      f"artist{S}{a['name']}", True, True,
                      thumbnail=_thumb(hu, bu, f"artist-{slugify(a['name'])}.jpg",
                                       entity, MediaType.ARTIST, f"artist{S}{a['id']}"))
                for a in filtered]
        return _node(f"Artists — {letter}", MediaClass.DIRECTORY, MediaType.ARTIST,
                     media_content_id, False, True, kids)

    # ── Albums — Buchstaben-Übersicht ─────────────────────────────────────────
    if media_content_id == BROWSE_ALBUMS:
        data = await C.async_get("/library/albums?offset=0&limit=10000") or {}
        buckets: dict[str, list] = {}
        for al in data.get("albums", []):
            buckets.setdefault(_first_letter(al["name"]), []).append(al)
        letters = sorted(l for l in buckets if l != '#') + (['#'] if '#' in buckets else [])
        kids = [_node(f"{l} ({len(buckets[l])})", MediaClass.DIRECTORY, MediaType.ALBUM,
                      f"albums_letter{S}{l}", False, True)
                for l in letters]
        return _node("Albums", MediaClass.DIRECTORY, MediaType.ALBUM,
                     BROWSE_ALBUMS, False, True, kids)

    # ── Albums — Einträge eines Buchstabens ───────────────────────────────────
    if media_content_id.startswith(f"albums_letter{S}"):
        letter = media_content_id[len(f"albums_letter{S}"):]
        data = await C.async_get("/library/albums?offset=0&limit=10000") or {}
        filtered = [al for al in data.get("albums", []) if _first_letter(al["name"]) == letter]
        kids = [_node(f"{al['name']} — {al['artist']}" if al.get("artist") else al["name"],
                      MediaClass.ALBUM, MediaType.ALBUM,
                      f"album{S}{al['artist']}{S}{al['name']}", True, True,
                      thumbnail=_thumb(hu, bu,
                                       f"{slugify(al['artist'] + '||' + al['name'])}.jpg",
                                       entity, MediaType.ALBUM,
                                       f"album{S}{slugify(al['artist'])}{S}{al['id']}"))
                for al in filtered]
        return _node(f"Albums — {letter}", MediaClass.DIRECTORY, MediaType.ALBUM,
                     media_content_id, False, True, kids)

    # ── Tracks — Buchstaben-Übersicht ─────────────────────────────────────────
    if media_content_id == BROWSE_TRACKS:
        data_all = await C.async_get("/library/tracks?limit=99999") or {}
        buckets: dict[str, list] = {}
        for t in data_all.get("tracks", []):
            buckets.setdefault(_first_letter(t["name"]), []).append(t)
        total = data_all.get("total", 0)
        letters = sorted(l for l in buckets if l != '#') + (['#'] if '#' in buckets else [])
        kids = [_node(f"{l} ({len(buckets[l])})", MediaClass.DIRECTORY, MediaType.TRACK,
                      f"tracks_letter{S}{l}", False, True)
                for l in letters]
        return _node(f"Tracks ({total})", MediaClass.DIRECTORY, MediaType.TRACK,
                     BROWSE_TRACKS, False, True, kids)

    # ── Tracks — Einträge eines Buchstabens ───────────────────────────────────
    if media_content_id.startswith(f"tracks_letter{S}"):
        letter = media_content_id[len(f"tracks_letter{S}"):]
        data = await C.async_get(f"/library/tracks?letter={quote(letter, safe='')}&limit=2000") or {}
        kids = [_node(
                    f"{t['name']} — {t['artist']}" if t.get("artist") else t["name"],
                    MediaClass.TRACK, MediaType.TRACK,
                    _track_cid(t, S), True, False,
                    thumbnail=_track_thumb(t, hu, bu, entity, S))
                for t in data.get("tracks", [])]
        return _node(f"Tracks — {letter}", MediaClass.DIRECTORY, MediaType.TRACK,
                     media_content_id, False, True, kids)

    # ── Artist → seine Alben ──────────────────────────────────────────────────
    parts = media_content_id.split(S)

    if parts[0] == "artist" and len(parts) >= 2:
        data = await C.async_get(f"/library/artists/{q(parts[1])}/albums") or {}
        an = data.get("artist", parts[1])
        kids = [_node(al["name"], MediaClass.ALBUM, MediaType.ALBUM,
                      f"album{S}{an}{S}{al['name']}{S}{al.get('mediaKind','song')}", True, True,
                      thumbnail=_thumb(hu, bu, f"{slugify(an + '||' + al['name'])}.jpg",
                                       entity, MediaType.ALBUM,
                                       f"album{S}{slugify(an)}{S}{al['id']}"))
                for al in data.get("albums", [])]
        return _node(an, MediaClass.ARTIST, MediaType.ARTIST,
                     f"artist{S}{an}", False, True, kids)

    # ── Album → seine Tracks ──────────────────────────────────────────────────
    if parts[0] == "album" and len(parts) >= 3:
        data = await C.async_get(f"/library/albums/{q(parts[1])}/{q(parts[2])}/tracks") or {}
        kids = [_node(
                    f"{t['name']} — {t['artist']}" if t.get("artist") else t["name"],
                    MediaClass.TRACK, MediaType.TRACK,
                    _track_cid(t, S), True, False,
                    thumbnail=_track_thumb(t, hu, bu, entity, S))
                for t in data.get("tracks", [])]
        return _node(data.get("album", parts[2]), MediaClass.ALBUM, MediaType.ALBUM,
                     f"album{S}{parts[1]}{S}{parts[2]}", False, True, kids)  # parts[3]=mediaKind ignoriert beim Drill-down

    # ── Playlist → ihre Tracks ───────────────────────────────────────────────
    if parts[0] == "genre" and len(parts) >= 2:
        g_name = parts[1]
        data   = await C.async_get(f"/library/genres/{q(g_name)}/tracks") or {}
        kids   = [_node(
                    f"{t['name']} — {t.get('albumArtist') or t.get('artist') or ''}".rstrip(" — "),
                    MediaClass.TRACK, MediaType.TRACK,
                    _track_cid(t, S), True, False,
                    thumbnail=_track_thumb(t, hu, bu, entity, S))
                  for t in data.get("tracks", [])]
        return _node(data.get("genre", g_name), MediaClass.GENRE, MediaType.GENRE,
                     f"genre{S}{g_name}", False, True, kids)

    if parts[0] == "playlist" and len(parts) >= 2:
        pl_id = parts[1]
        data  = await C.async_get(f"/playlists/{q(pl_id)}/tracks") or {}
        kids  = [_node(
                    f"{t['name']} — {t.get('albumArtist') or t.get('artist') or ''}".rstrip(" — "),
                    MediaClass.TRACK, MediaType.TRACK,
                    _track_cid(t, S), True, False,
                    thumbnail=_track_thumb(t, hu, bu, entity, S))
                 for t in data.get("tracks", [])]
        pl_name = data.get("playlist", pl_id)
        return _node(pl_name, MediaClass.PLAYLIST, MediaType.PLAYLIST,
                     f"playlist{S}{pl_id}", False, True, kids)

    raise BrowseError(f"Unknown media_content_id: {media_content_id}")
