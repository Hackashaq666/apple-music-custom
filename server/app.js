var fs = require('fs')
var path = require('path')
var express = require('express')
var morgan = require('morgan')
var bodyParser = require('body-parser')


var iTunes = require('local-itunes')
var osa = require('osa')
var osascript = require('osascript')
var parameterize = require('parameterize');

var app = express()
app.use(bodyParser.urlencoded({ extended: false }))
app.use(express.static(path.join(__dirname, 'public')));


var logFormat = "'[:date[iso]] - :remote-addr - :method :url :status :response-time ms - :res[content-length]b'"
app.use(morgan(logFormat))


function getCurrentState() {
  var itunes;
  try {
    itunes = Application('Music');
  } catch (error) {
    itunes = Application('iTunes');
  }

  var playerState = itunes.playerState();
  var currentState = {};
  currentState['player_state'] = playerState;

  if (playerState != 'stopped') {
    var currentTrack = itunes.currentTrack;

    currentState['id']                 = currentTrack.persistentID();
    currentState['name']               = currentTrack.name();
    currentState['artist']             = currentTrack.artist();
    currentState['album']              = currentTrack.album();
    currentState['volume']             = itunes.soundVolume();
    currentState['muted']              = itunes.mute();
    currentState['repeat']             = itunes.songRepeat();
    currentState['shuffle']            = itunes.shuffleEnabled() && itunes.shuffleMode();
    currentState['player_position']    = itunes.playerPosition();
    currentState['player_duration']    = currentTrack.duration();
    currentState['position_timestamp'] = Date.now();

    if (currentTrack.year()) {
      currentState['album'] += ' (' + currentTrack.year() + ')';
    }

    try {
      currentState['playlist'] = itunes.currentPlaylist.name();
    } catch (e) {
      currentState['playlist'] = '';
    }
  }

  return currentState;
}

function seekToPosition(position) {
  var itunes;
  try {
    itunes = Application('Music');
  } catch (error) {
    itunes = Application('iTunes');
  }
  itunes.playerPosition = parseFloat(position);
  return true;
}

function setVolume(level) {
  var itunes;
  try {
    itunes = Application('Music');
  } catch (error) {
    itunes = Application('iTunes');
  }
  if (level) {
    itunes.soundVolume = parseInt(level);
    return true;
  }
  return false;
}

function setMuted(muted) {
  var itunes;
  try {
    itunes = Application('Music');
  } catch (error) {
    itunes = Application('iTunes');
  }
  if (muted) {
    itunes.mute = muted;
    return true;
  }
  return false;
}

function setShuffle(mode) {
  var itunes;
  try {
    itunes = Application('Music');
  } catch (error) {
    itunes = Application('iTunes');
  }
  if (!mode) { mode = 'songs'; }
  if (mode == 'false' || mode == 'off') {
    itunes.shuffleEnabled = false;
    return false;
  } else {
    itunes.shuffleEnabled = true;
    itunes.shuffleMode = mode;
    return true;
  }
}

function setRepeat(mode) {
  var itunes;
  try {
    itunes = Application('Music');
  } catch (error) {
    itunes = Application('iTunes');
  }
  if (!mode) { mode = 'all'; }
  if (mode == 'false' || mode == 'off') {
    itunes.songRepeat = false;
    return false;
  } else {
    itunes.songRepeat = mode;
    return true;
  }
}




var execFile = require('child_process').execFile;
var sharp   = require('sharp');
var os      = require('os');

var FETCH_TRACKS_SCRIPT = [
  'var app;',
  'try { app = Application("Music"); } catch(e) { app = Application("iTunes"); }',
  'var tracks = [];',
  'try {',
  '  var lib = app.libraryPlaylists[0];',
  '  var allIDs = lib.tracks.persistentID();',
  '  var allKinds = lib.tracks.mediaKind();',
  '  var allNames = lib.tracks.name();',
  '  var allArtists = lib.tracks.artist();',
  '  var allAlbumArtists = lib.tracks.albumArtist();',
  '  var allAlbums = lib.tracks.album();',
  '  var allTrackNums = lib.tracks.trackNumber();',
  '  var allDiscNums = lib.tracks.discNumber();',
  '  var allDurations = lib.tracks.duration();',
  '  var allMediaKinds = lib.tracks.mediaKind();',
  '  var allGenres = lib.tracks.genre();',
  '  var allCompilations = lib.tracks.compilation();',
  '  for (var i = 0; i < allIDs.length; i++) {',
  '    var kind = allKinds[i] || "";',
  '    if (kind !== "song" && kind !== "music video" && kind !== "" && kind !== undefined) { continue; }',
  '    var id = allIDs[i] || "";',
  '    if (!id) { continue; }',
  '    tracks.push({ id: id, name: allNames[i] || "", artist: allArtists[i] || "", albumArtist: allAlbumArtists[i] || "", album: allAlbums[i] || "", track_number: allTrackNums[i] || 0, disc_number: allDiscNums[i] || 1, duration: allDurations[i] || 0, compilation: allCompilations[i] === true, mediaKind: allMediaKinds[i] || "song", genre: allGenres[i] || "" });',
  '  }',
  '} catch(bulkErr) {',
  '  try {',
  '    var raw = app.tracks();',
  '    for (var i = 0; i < raw.length; i++) {',
  '      try {',
  '        var t = raw[i];',
  '        var kind = ""; try { kind = t.mediaKind(); } catch(e) {}',
  '        if (kind !== "song" && kind !== "music video" && kind !== "" && kind !== undefined) { continue; }',
  '        var id = ""; try { id = t.persistentID(); } catch(e) {}',
  '        if (!id) { continue; }',
  '        tracks.push({ id: id, name: (function(){ try { return t.name() || ""; } catch(e) { return ""; } })(), artist: (function(){ try { return t.artist() || ""; } catch(e) { return ""; } })(), albumArtist: (function(){ try { return t.albumArtist() || ""; } catch(e) { return ""; } })(), album: (function(){ try { return t.album() || ""; } catch(e) { return ""; } })(), track_number: (function(){ try { return t.trackNumber(); } catch(e) { return 0; } })(), disc_number: (function(){ try { return t.discNumber(); } catch(e) { return 1; } })(), duration: (function(){ try { return t.duration(); } catch(e) { return 0; } })(), compilation: (function(){ try { return t.compilation() === true; } catch(e) { return false; } })(), mediaKind: (function(){ try { return t.mediaKind() || "song"; } catch(e) { return "song"; } })(), genre: (function(){ try { return t.genre() || ""; } catch(e) { return ""; } })() });',
  '      } catch(e) {}',
  '    }',
  '  } catch(e) {}',
  '}',
  'JSON.stringify(tracks);'
].join(' ');







function playTrackByID(persistentID) {
  var itunes;
  try {
    itunes = Application('Music');
  } catch (e) {
    itunes = Application('iTunes');
  }
  try {
    var matches = itunes.tracks.whose({ persistentID: { '=': persistentID } });
    if (matches.length > 0) { matches[0].play(); return true; }
  } catch(e) {}
  return false;
}




// playAlbumByName and playArtistTracks are handled via AppleScript files


function listAirPlayDevicesJXA() {
  try { itunes = Application('Music'); } catch(e) { itunes = Application('iTunes'); }
  var airPlayDevices = itunes.airplayDevices();
  var results = [];
  for (var i = 0; i < airPlayDevices.length; i++) {
    var d = airPlayDevices[i];
    var deviceData = {};
    if (d.networkAddress()) {
      deviceData.id = d.networkAddress().replace(/:/g, '-');
    } else {
      deviceData.id = d.name();
    }
    deviceData.name           = d.name();
    deviceData.kind           = d.kind();
    deviceData.active         = d.active();
    deviceData.selected       = d.selected();
    deviceData.sound_volume   = d.soundVolume();
    deviceData.supports_video = d.supportsVideo();
    deviceData.supports_audio = d.supportsAudio();
    deviceData.network_address = d.networkAddress();
    results.push(deviceData);
  }
  return results;
}

function setAirPlaySelectionJXA(id, selected) {
  try { itunes = Application('Music'); } catch(e) { itunes = Application('iTunes'); }
  var cleanId = id.replace(/-/g, ':');
  var devices = itunes.airplayDevices();
  for (var i = 0; i < devices.length; i++) {
    var d = devices[i];
    if (d.networkAddress() === cleanId || d.name() === id) {
      d.selected = selected;
      return true;
    }
  }
  return false;
}

function setAirPlayVolumeJXA(id, level) {
  try { itunes = Application('Music'); } catch(e) { itunes = Application('iTunes'); }
  var cleanId = id.replace(/-/g, ':');
  var devices = itunes.airplayDevices();
  for (var i = 0; i < devices.length; i++) {
    var d = devices[i];
    if (d.networkAddress() === cleanId || d.name() === id) {
      d.soundVolume = level;
      return true;
    }
  }
  return false;
}

function playByIDsTempScript(playlistName, ids, callback) {
  var tmpFile = path.join(os.tmpdir(), 'play-ids-' + Date.now() + '.js');
  var script = [
    'var music;',
    'try { music = Application("Music"); } catch(e) { music = Application("iTunes"); }',
    'var playlistName = ' + JSON.stringify(playlistName) + ';',
    'var persistentIDs = ' + JSON.stringify(ids) + ';',
    'var playlists = music.userPlaylists();',
    'for (var i = 0; i < playlists.length; i++) {',
    // Für HA_Play_Search: alle alten Timestamps-Varianten löschen
    '  var n = playlists[i].name();',
    '  if (n === playlistName || n === "HA_Play_Search" || n.indexOf("HA_Play_Search_") === 0) {',
    '    try { playlists[i].delete(); } catch(e) {}',
    '  } else if (n === playlistName) {',
    '    try { playlists[i].delete(); } catch(e) {}',
    '  }',
    '}',
    'var tempPL = music.make({ new: "userPlaylist", withProperties: { name: playlistName } });',
    // IDs kommen bereits vorsortiert vom Server – Einfügereihenfolge wird von Music.app respektiert
    'for (var j = 0; j < persistentIDs.length; j++) {',
    '  try {',
    '    var matches = music.tracks.whose({ persistentID: { "=": persistentIDs[j] } });',
    '    if (matches.length > 0) { matches[0].duplicate({ to: tempPL }); }',
    '  } catch(e) {}',
    '}',
    // Shuffle deaktivieren damit die Wiedergabe der Playlist-Reihenfolge folgt
    'try { music.shuffleEnabled.set(false); } catch(e) {}',
    'music.play(tempPL);',
  ].join('\n');
  fs.writeFile(tmpFile, script, function(err) {
    if (err) { return callback(err); }
    execFile('osascript', ['-l', 'JavaScript', tmpFile], function(error, stdout, stderr) {
      fs.unlink(tmpFile, function() {});
      if (error) { return callback(error); }
      callback(null);
    });
  });
}

function sendResponse(error, res) {
  if (error) {
    console.log(error);
    res.sendStatus(500);
  } else {
    osa(getCurrentState, function(error, state) {
      if (error) {
        var msg = (error.message || String(error));
        if (msg.indexOf('-600') !== -1 || msg.indexOf("isn't running") !== -1) {
          // Music.app not running — return stopped state rather than 500
          console.log('Music.app not running (-600), returning stopped state');
          return res.json({ player_state: 'stopped' });
        }
        console.log(error);
        res.sendStatus(500);
      } else {
        res.json(state);
      }
    });
  }
}


var libraryCache = { tracks: null, fetchedAt: 0, ttl: 60 * 60 * 1000, pending: [] };
var albumsCache  = null;
var artistsCache = null;
// Custom addition: short-lived playlist cache used only by the extended /library/search
// endpoint below, so typing in YAMP's search box doesn't trigger an AppleScript exec per
// keystroke. The existing /playlists route is left untouched and still fetches live.
var playlistsCache = { data: null, fetchedAt: 0, ttl: 60 * 60 * 1000 };
function getPlaylistsCached(callback) {
  var now = Date.now();
  if (playlistsCache.data && (now - playlistsCache.fetchedAt) < playlistsCache.ttl) {
    return callback(null, playlistsCache.data);
  }
  var script = path.join(__dirname, 'lib', 'get-playlists.applescript');
  execFile('osascript', [script], function(error, stdout) {
    if (error) { return callback(error); }
    var playlists = [];
    var lines = (stdout || '').trim().split(/\r\n|\r|\n/);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) { continue; }
      var tab = line.indexOf('\t');
      if (tab === -1) { continue; }
      var id   = line.substring(0, tab).trim();
      var name = line.substring(tab + 1).trim();
      if (id && name) { playlists.push({ id: id, name: name }); }
    }
    playlistsCache.data      = playlists;
    playlistsCache.fetchedAt = Date.now();
    callback(null, playlists);
  });
}

// SSE clients and push state
var sseClients = [];
var pushedState = null;

function broadcastSSE(data) {
  var payload = 'data: ' + JSON.stringify(data) + '\n\n';
  sseClients = sseClients.filter(function(res) {
    try { res.write(payload); return true; }
    catch(e) { return false; }
  });
}

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function getLibraryTracks(callback) {
  var now = Date.now();
  if (libraryCache.tracks && (now - libraryCache.fetchedAt) < libraryCache.ttl) {
    return callback(null, libraryCache.tracks);
  }
  libraryCache.pending.push(callback);
  if (libraryCache.pending.length > 1) {
    return;
  }
  execFile(
    'osascript',
    ['-l', 'JavaScript', '-e', FETCH_TRACKS_SCRIPT],
    { maxBuffer: 100 * 1024 * 1024 },
    function(error, stdout, stderr) {
      var callbacks = libraryCache.pending.slice();
      libraryCache.pending = [];
      if (error) {
        callbacks.forEach(function(cb) { cb(error); });
        return;
      }
      try {
        var tracks = JSON.parse(stdout.trim());
        libraryCache.tracks    = tracks;
        libraryCache.fetchedAt = Date.now();
        albumsCache  = null;
        artistsCache = null;
        callbacks.forEach(function(cb) { cb(null, tracks); });
      } catch (e) {
        callbacks.forEach(function(cb) { cb(e); });
      }
    }
  );
}

var VARIOUS_ARTISTS = 'Various Artists';

function buildAlbums(tracks, offset, limit) {
  var seen   = {};
  var albums = [];
  for (var i = 0; i < tracks.length; i++) {
    var t      = tracks[i];
    var name   = t.album;
    if (!name) { continue; }
    // Custom addition: tracks flagged as part of a compilation (Music.app's own
    // "compilation" property) are grouped by album name only, under "Various
    // Artists" — instead of fragmenting into one entry per differing
    // artist/albumArtist tag, which is how compilations are commonly (and
    // inconsistently) tagged in imported libraries.
    var artist = t.compilation === true ? VARIOUS_ARTISTS : (t.albumArtist || t.artist || '');
    var key    = artist + '||' + name;
    if (!seen[key]) {
      seen[key] = true;
      albums.push({ id: slugify(key), name: name, artist: artist });
    }
  }
  albums.sort(function(a, b) { return a.name.toLowerCase().localeCompare(b.name.toLowerCase()); });
  return { total: albums.length, offset: offset, limit: limit, albums: albums.slice(offset, offset + limit) };
}

// Custom addition: shared by /library/albums/:artist/:album/tracks and
// .../play below, so a track matches a requested artist either the normal way
// (albumArtist/artist equals the requested name) or — when the requested
// artist is our "Various Artists" pseudo-artist — by having the
// compilation flag set, regardless of its actual per-track artist tag.
function matchesAlbumArtist(t, artistName) {
  if (artistName === VARIOUS_ARTISTS && t.compilation === true) { return true; }
  var albumArtist = t.albumArtist || t.artist || '';
  var artist      = t.artist || '';
  return albumArtist === artistName || artist === artistName;
}

function buildArtists(tracks, offset, limit) {
  var seen    = {};
  var artists = [];
  for (var i = 0; i < tracks.length; i++) {
    var t    = tracks[i];
    var name = t.albumArtist || t.artist;
    if (name && !seen[name]) {
      seen[name] = true;
      artists.push({ id: slugify(name), name: name });
    }
  }
  artists.sort(function(a, b) { return a.name.toLowerCase().localeCompare(b.name.toLowerCase()); });
  return { total: artists.length, offset: offset, limit: limit, artists: artists.slice(offset, offset + limit) };
}

function buildGenres(tracks) {
  var counts = {};
  var kinds  = {};
  for (var i = 0; i < tracks.length; i++) {
    var g = (tracks[i].genre || '').trim();
    if (!g) { continue; }
    counts[g] = (counts[g] || 0) + 1;
    if (!kinds[g]) kinds[g] = [];
    kinds[g].push(tracks[i].mediaKind || 'song');
  }
  var genres = Object.keys(counts).map(function(g) {
    var all = kinds[g] || [];
    var allVideos = all.length > 0 && all.every(function(k) { return k === 'music video'; });
    return { id: slugify(g), name: g, count: counts[g],
             mediaKind: allVideos ? 'music video' : 'song' };
  });
  genres.sort(function(a, b) { return a.name.toLowerCase().localeCompare(b.name.toLowerCase()); });
  return { total: genres.length, genres: genres };
}

function buildAlbumsByArtist(tracks, artistName) {
  var seen      = {};
  var albumKinds = {}; // track mediaKinds per album to detect video-only albums
  var albums    = [];
  for (var i = 0; i < tracks.length; i++) {
    var t           = tracks[i];
    var albumArtist = t.albumArtist || t.artist || '';
    var artist      = t.artist || '';
    if (albumArtist !== artistName && artist !== artistName) { continue; }
    var name = t.album;
    if (!name) { continue; }
    if (!albumKinds[name]) albumKinds[name] = [];
    albumKinds[name].push(t.mediaKind || 'song');
    if (!seen[name]) {
      seen[name] = true;
      albums.push({ id: slugify(artistName + '||' + name), name: name });
    }
  }
  // Markiere Video-only-Alben
  albums.forEach(function(al) {
    var kinds = albumKinds[al.name] || [];
    al.mediaKind = (kinds.length > 0 && kinds.every(function(k) { return k === 'music video'; }))
      ? 'music video' : 'song';
  });
  albums.sort(function(a, b) { return a.name.toLowerCase().localeCompare(b.name.toLowerCase()); });
  return { artist: artistName, albums: albums };
}


app.get('/_ping', function(req, res) {
  res.send('OK');
});

app.get('/events', function(req, res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  // Send current state immediately on connect
  if (pushedState) {
    res.write('data: ' + JSON.stringify(pushedState) + '\n\n');
  }

  sseClients.push(res);

  req.on('close', function() {
    sseClients = sseClients.filter(function(c) { return c !== res; });
  });
});

app.post('/notify', function(req, res) {
  var body = '';
  req.on('data', function(chunk) { body += chunk; });
  req.on('end', function() {
    try {
      var notification = JSON.parse(body);
      var state = notification.player_state.toLowerCase();

      // Map Music notification state to our state format
      var playerState = state === 'playing' ? 'playing'
                      : state === 'paused'  ? 'paused'
                      : state === 'stopped' ? 'stopped'
                      : 'stopped';

      // Build a partial state update from the notification
      // player_position is not available in notifications - HA will use last known
      var update = {
        player_state:      playerState,
        id:                notification.persistent_id,
        name:              notification.name,
        artist:            notification.artist,
        album:             notification.album,
        player_duration:   notification.total_time / 1000,
        position_timestamp: Date.now(),
        _from_notification: true
      };

      pushedState = update;
      broadcastSSE(update);
      res.sendStatus(200);
    } catch(e) {
      res.sendStatus(400);
    }
  });
});

app.get('/', function(req, res) {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.put('/play', function(req, res) {
  iTunes.play(function(error) { sendResponse(error, res); });
});

app.put('/pause', function(req, res) {
  iTunes.pause(function(error) { sendResponse(error, res); });
});

app.put('/playpause', function(req, res) {
  iTunes.playpause(function(error) { sendResponse(error, res); });
});

app.put('/stop', function(req, res) {
  iTunes.stop(function(error) { sendResponse(error, res); });
});

app.put('/previous', function(req, res) {
  iTunes.previous(function(error) { sendResponse(error, res); });
});

app.put('/next', function(req, res) {
  iTunes.next(function(error) { sendResponse(error, res); });
});

app.put('/volume', function(req, res) {
  osa(setVolume, req.body.level, function(error, data, log) {
    if (error) { console.log(error); res.sendStatus(500); }
    else { sendResponse(null, res); }
  });
});

app.put('/mute', function(req, res) {
  osa(setMuted, req.body.muted, function(error, data, log) {
    if (error) { console.log(error); res.sendStatus(500); }
    else { sendResponse(null, res); }
  });
});

app.put('/shuffle', function(req, res) {
  osa(setShuffle, req.body.mode, function(error, data, log) {
    if (error) { console.log(error); res.sendStatus(500); }
    else { sendResponse(null, res); }
  });
});

app.put('/repeat', function(req, res) {
  osa(setRepeat, req.body.mode, function(error, data, log) {
    if (error) { console.log(error); res.sendStatus(500); }
    else { sendResponse(null, res); }
  });
});

app.put('/seek', function(req, res) {
  var position = req.body.position;
  if (position === undefined || position === null) {
    return res.status(400).json({ error: 'position is required' });
  }
  osa(seekToPosition, position, function(error, data, log) {
    if (error) { console.log(error); res.sendStatus(500); }
    else { sendResponse(null, res); }
  });
});

app.get('/now_playing', function(req, res) {
  sendResponse(null, res);
});

app.get('/artwork', function(req, res) {
  osascript.file(path.join(__dirname, 'lib', 'art.applescript'), function(error, data) {
    res.type('image/jpeg');
    res.set('Cache-Control', 'no-cache');
    res.sendFile('/tmp/currently-playing.jpg');
  });
});

var ARTWORK_DIR = path.join(__dirname, 'artwork-cache');
if (!fs.existsSync(ARTWORK_DIR)) { fs.mkdirSync(ARTWORK_DIR); }

var CUSTOM_ARTWORK_DIR = path.join(__dirname, 'custom-artwork');
if (!fs.existsSync(CUSTOM_ARTWORK_DIR)) { fs.mkdirSync(CUSTOM_ARTWORK_DIR); }

// Serve cached artwork as static files — bypasses route logic for maximum speed
var staticOpts = {
  maxAge: '1y',
  immutable: true,
  setHeaders: function(res) {
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
  }
};
app.use('/artwork-cache', express.static(ARTWORK_DIR, staticOpts));
app.use('/custom-artwork', express.static(CUSTOM_ARTWORK_DIR, staticOpts));

// Unified static artwork endpoint — checks custom-artwork first, then artwork-cache
// Used by browse_media.py for fast direct serving without route logic or AppleScript
app.get('/artwork-static/:file', function(req, res) {
  var file = req.params.file;
  var exts = ['.jpg', '.jpeg', '.png'];
  var base = file.replace(/\.(jpg|jpeg|png)$/, '');

  // Strip prefix (playlist-, artist-) to get the slug used in custom-artwork filenames
  var slug = base.replace(/^(playlist-|artist-)/, '');

  // Check custom-artwork using slug (no prefix) for all extensions
  for (var i = 0; i < exts.length; i++) {
    var custom = path.join(CUSTOM_ARTWORK_DIR, slug + exts[i]);
    if (fs.existsSync(custom)) {
      res.set('Cache-Control', 'public, max-age=31536000, immutable');
      return res.sendFile(custom);
    }
  }

  // Fall back to artwork-cache using full base name
  var cached = path.join(ARTWORK_DIR, base + '.jpg');
  if (fs.existsSync(cached)) {
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    return res.sendFile(cached);
  }

  res.sendStatus(404);
});

function customArtworkPath(name) {
  var slug = slugify(name);
  var exts = ['.jpg', '.jpeg', '.png'];
  for (var i = 0; i < exts.length; i++) {
    var p = path.join(CUSTOM_ARTWORK_DIR, slug + exts[i]);
    if (fs.existsSync(p)) { return p; }
  }
  return null;
}

function artworkFilePath(artist, album) {
  return path.join(ARTWORK_DIR, slugify(artist + '||' + album) + '.jpg');
}

function fetchAndSaveArtwork(artist, album, callback) {
  var tmpFile = '/tmp/album-art-' + Date.now() + '.jpg';
  var scriptFile = path.join(__dirname, 'lib', 'album-art.applescript');
  var destFile = artworkFilePath(artist, album);

  execFile(
    'osascript',
    [scriptFile, artist, album, tmpFile],
    { maxBuffer: 10 * 1024 * 1024 },
    function(error, stdout) {
      if (error) { return callback(error); }
      if (stdout.trim() !== 'ok') { return callback(new Error('no artwork')); }
      fs.rename(tmpFile, destFile, function(err) {
        if (err) {
          fs.unlink(tmpFile, function() {});
          return callback(err);
        }
        callback(null, destFile);
      });
    }
  );
}

function prefetchAllArtwork(tracks) {
  var seen  = {};
  var queue = [];

  function enqueue(artist, album) {
    if (!artist || !album) { return; }
    var key = artist + '||' + album;
    if (seen[key]) { return; }
    seen[key] = true;
    if (!fs.existsSync(artworkFilePath(artist, album))) {
      queue.push({ artist: artist, album: album });
    }
  }

  for (var i = 0; i < tracks.length; i++) {
    var t      = tracks[i];
    var album  = t.album || '';
    var realArtist = t.albumArtist || t.artist || '';
    // Always prefetch under the real per-track artist tag — needed for
    // individual track-level thumbnails (e.g. Tracks-by-letter browse),
    // regardless of compilation status. This is the original behaviour.
    enqueue(realArtist, album);
    // Custom addition: ADDITIONALLY prefetch under the "Various Artists"
    // pseudo-artist for compilation tracks, matching buildAlbums()'s
    // grouping — needed so album-level thumbnails (album browse/search)
    // resolve to a cache file, since /artwork-static only serves from
    // cache and never fetches on demand. This is in addition to, not
    // instead of, the real-artist entry above.
    if (t.compilation === true) {
      enqueue(VARIOUS_ARTISTS, album);
    }
  }

  console.log('Artwork prefetch: ' + queue.length + ' albums to fetch.');
  var idx = 0;

  function next() {
    if (idx >= queue.length) {
      console.log('Artwork prefetch complete.');
      prefetchAllArtistArtwork(libraryCache.tracks || [], function() {
        prefetchAllPlaylistCollages(null);
      });
      return;
    }
    var item = queue[idx++];
    fetchAndSaveArtwork(item.artist, item.album, function(err) {
      if (err) {
        console.log('Artwork prefetch skip (' + item.artist + ' / ' + item.album + '):', err.message);
      }
      setTimeout(next, 500);
    });
  }

  next();
}

function prefetchAllPlaylistCollages(callback) {
  var script = path.join(__dirname, 'lib', 'get-playlists.applescript');
  execFile('osascript', [script], function(error, stdout) {
    if (error) { if (callback) callback(); return; }
    var lines = (stdout || '').trim().split(/\r\n|\r|\n/);
    var queue = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) { continue; }
      var tab = line.indexOf('\t');
      if (tab === -1) { continue; }
      var name = line.substring(tab + 1).trim();
      if (!name) { continue; }
      if (customArtworkPath(name)) { continue; }
      var cacheFile = path.join(ARTWORK_DIR, 'playlist-' + slugify(name) + '.jpg');
      if (!fs.existsSync(cacheFile)) { queue.push(name); }
    }
    console.log('Playlist collage prefetch: ' + queue.length + ' to build.');
    var idx = 0;
    function next() {
      if (idx >= queue.length) {
        console.log('Playlist collage prefetch complete.');
        if (callback) callback();
        return;
      }
      var name = queue[idx++];
      // Ensure first 4 playlist track artworks are cached before building collage
      getPlaylistTracks(name, function(tracks) {
        if (!tracks || tracks.length === 0) {
          buildPlaylistCollage(name, function(err) {
            if (err) { console.log('Playlist collage skip (' + name + '):', err.message); }
            setTimeout(next, 100);
          });
          return;
        }
        var seen = {};
        var missing = [];
        for (var i = 0; i < tracks.length; i++) {
          if (missing.length >= 4 && Object.keys(seen).length >= 4) { break; }
          var t      = tracks[i];
          var artist = t.artist || '';
          var album  = t.album  || '';
          if (!artist || !album) { continue; }
          var key = artist + '||' + album;
          if (seen[key]) { continue; }
          seen[key] = true;
          if (!fs.existsSync(artworkFilePath(artist, album))) {
            missing.push({ artist: artist, album: album });
          }
          if (Object.keys(seen).length >= 4) { break; }
        }
        if (missing.length === 0) {
          buildPlaylistCollage(name, function(err) {
            if (err) { console.log('Playlist collage skip (' + name + '):', err.message); }
            setTimeout(next, 100);
          });
          return;
        }
        var midx = 0;
        function fetchNext() {
          if (midx >= missing.length) {
            buildPlaylistCollage(name, function(err) {
              if (err) { console.log('Playlist collage skip (' + name + '):', err.message); }
              setTimeout(next, 100);
            });
            return;
          }
          var item = missing[midx++];
          fetchAndSaveArtwork(item.artist, item.album, function() {
            setTimeout(fetchNext, 500);
          });
        }
        fetchNext();
      });
    }
    next();
  });
}
function prefetchAllArtistArtwork(tracks, callback) {
  var seen = {};
  var queue = [];
  for (var i = 0; i < tracks.length; i++) {
    var t      = tracks[i];
    var artist = t.albumArtist || t.artist || '';
    var album  = t.album || '';
    if (!artist || !album) { continue; }
    if (seen[artist]) { continue; }
    if (customArtworkPath(artist)) { seen[artist] = true; continue; }
    var cacheFile = path.join(ARTWORK_DIR, 'artist-' + slugify(artist) + '.jpg');
    if (fs.existsSync(cacheFile)) { seen[artist] = true; continue; }
    var albumFile = artworkFilePath(artist, album);
    if (!fs.existsSync(albumFile)) { continue; }
    seen[artist] = true;
    queue.push({ artist: artist, albumFile: albumFile, cacheFile: cacheFile });
  }
  console.log('Artist artwork prefetch: ' + queue.length + ' artists to cache.');
  var idx = 0;
  function next() {
    if (idx >= queue.length) {
      console.log('Artist artwork prefetch complete.');
      if (callback) { callback(); }
      return;
    }
    var item = queue[idx++];
    fs.copyFile(item.albumFile, item.cacheFile, function(err) {
      if (err) { console.log('Artist artwork copy error (' + item.artist + '):', err.message); }
      next();
    });
  }
  next();
}

app.get('/artwork/playlist/:name', function(req, res) {
  var name = req.params.name;
  var custom = customArtworkPath(name);
  if (custom) {
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    return res.sendFile(path.resolve(custom));
  }
  buildPlaylistCollage(name, function(error, filePath) {
    if (error) {
      console.log('Playlist artwork error:', error.message);
      return res.sendStatus(404);
    }
    res.type('image/jpeg');
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.sendFile(path.resolve(filePath));
  });
});

app.get('/artwork/artist/:artist', function(req, res) {
  var artist = req.params.artist;
  var custom = customArtworkPath(artist);
  if (custom) {
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    return res.sendFile(path.resolve(custom));
  }
  var cacheFile = path.join(ARTWORK_DIR, 'artist-' + slugify(artist) + '.jpg');

  if (fs.existsSync(cacheFile)) {
    res.type('image/jpeg');
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    return res.sendFile(path.resolve(cacheFile));
  }

  getLibraryTracks(function(error, tracks) {
    if (error) { return res.sendStatus(500); }
    for (var i = 0; i < tracks.length; i++) {
      var t      = tracks[i];
      var a      = t.albumArtist || t.artist || '';
      var album  = t.album || '';
      if (a !== artist || !album) { continue; }
      var file = artworkFilePath(a, album);
      if (!fs.existsSync(file)) { continue; }
      fs.copyFile(file, cacheFile, function(err) {
        if (err) { console.log('Artist cache copy error:', err.message); }
      });
      res.type('image/jpeg');
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
      return res.sendFile(path.resolve(file));
    }
    console.log('Artist artwork not found for:', artist);
    res.sendStatus(404);
  });
});


app.get('/artwork/:artist/:album', function(req, res) {
  var artist   = req.params.artist;
  var album    = req.params.album;
  var custom   = customArtworkPath(album);
  if (custom) {
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    return res.sendFile(path.resolve(custom));
  }
  var filePath = artworkFilePath(artist, album);

  if (fs.existsSync(filePath)) {
    res.type('image/jpeg');
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    return res.sendFile(filePath);
  }

  fetchAndSaveArtwork(artist, album, function(error, savedPath) {
    if (error) {
      console.log('Artwork fetch error:', error.message);
      return res.sendStatus(404);
    }
    res.type('image/jpeg');
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.sendFile(savedPath);
  });
});

function getPlaylistTracks(playlistName, callback) {
  var script = [
    'try { itunes = Application("Music"); } catch(e) { itunes = Application("iTunes"); }',
    'var name = ' + JSON.stringify(playlistName) + ';',
    'var playlists = itunes.playlists();',
    'var results = [];',
    'for (var i = 0; i < playlists.length; i++) {',
    '  var p = playlists[i];',
    '  if (p.name() === name) {',
    '    var tracks = p.tracks();',
    '    for (var j = 0; j < tracks.length; j++) {',
    '      var t = tracks[j];',
    '      results.push({ artist: t.albumArtist() || t.artist() || "", album: t.album() || "" });',
    '    }',
    '    break;',
    '  }',
    '}',
    'JSON.stringify(results);'
  ].join(' ');

  execFile(
    'osascript',
    ['-l', 'JavaScript', '-e', script],
    { maxBuffer: 10 * 1024 * 1024 },
    function(error, stdout) {
      if (error) { return callback([]); }
      try { callback(JSON.parse(stdout.trim())); }
      catch(e) { callback([]); }
    }
  );
}

function buildCollageFromCovers(covers, cacheFile, callback) {
  while (covers.length < 4) { covers.push(covers[covers.length - 1]); }
  var SIZE = 300;
  var HALF = SIZE / 2;
  Promise.all(covers.map(function(f) {
    return sharp(f).resize(HALF, HALF).toBuffer();
  })).then(function(buffers) {
    return sharp({
      create: { width: SIZE, height: SIZE, channels: 3, background: { r: 0, g: 0, b: 0 } }
    })
    .composite([
      { input: buffers[0], top: 0,    left: 0    },
      { input: buffers[1], top: 0,    left: HALF },
      { input: buffers[2], top: HALF, left: 0    },
      { input: buffers[3], top: HALF, left: HALF }
    ])
    .jpeg()
    .toFile(cacheFile);
  }).then(function() {
    callback(null, cacheFile);
  }).catch(function(e) {
    callback(e);
  });
}

function buildPlaylistCollage(playlistName, callback) {
  var cacheFile = path.join(ARTWORK_DIR, 'playlist-' + slugify(playlistName) + '.jpg');
  if (fs.existsSync(cacheFile)) {
    return callback(null, cacheFile);
  }

  getPlaylistTracks(playlistName, function(tracks) {
    if (!tracks) { tracks = []; }

    var seen   = {};
    var covers = [];

    for (var i = 0; i < tracks.length && covers.length < 4; i++) {
      var t      = tracks[i];
      var artist = t.artist || '';
      var album  = t.album  || '';
      if (!artist || !album) { continue; }
      var key  = artist + '||' + album;
      if (seen[key]) { continue; }
      var file = artworkFilePath(artist, album);
      if (!fs.existsSync(file)) { continue; }
      seen[key] = true;
      covers.push(file);
    }

    if (covers.length === 0) {
      getLibraryTracks(function(err, libTracks) {
        if (err) { return callback(err); }
        var seen2 = {};
        var covers2 = [];
        for (var i = 0; i < libTracks.length && covers2.length < 4; i++) {
          var t      = libTracks[i];
          var artist = t.albumArtist || t.artist || '';
          var album  = t.album || '';
          if (!artist || !album) { continue; }
          var key  = artist + '||' + album;
          if (seen2[key]) { continue; }
          var file = artworkFilePath(artist, album);
          if (!fs.existsSync(file)) { continue; }
          seen2[key] = true;
          covers2.push(file);
        }
        console.log('Playlist fallback covers found:', covers2.length);
        if (covers2.length === 0) { return callback(new Error('no covers found')); }
        buildCollageFromCovers(covers2, cacheFile, callback);
      });
      return;
    }

    buildCollageFromCovers(covers, cacheFile, callback);
  });
}


app.get('/debug/artwork-slugs', function(req, res) {
  var script = path.join(__dirname, 'lib', 'get-playlists.applescript');
  execFile('osascript', [script], function(error, stdout) {
    if (error) { return res.sendStatus(500); }
    var result = [];
    var lines = (stdout || '').trim().split(/\r\n|\r|\n/);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) { continue; }
      var tab = line.indexOf('\t');
      if (tab === -1) { continue; }
      var name = line.substring(tab + 1).trim();
      var slug = slugify(name);
      var custom = customArtworkPath(name);
      result.push({ name: name, slug: slug, filename: slug + '.jpg', custom_found: !!custom });
    }
    res.json(result);
  });
});

app.get('/playlists', function(req, res) {
  var script = path.join(__dirname, 'lib', 'get-playlists.applescript');
  execFile('osascript', [script], function(error, stdout) {
    if (error) { console.log('get-playlists error:', error); return res.sendStatus(500); }
    var playlists = [];
    var lines = (stdout || '').trim().split(/\r\n|\r|\n/);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) { continue; }
      var tab = line.indexOf('\t');
      if (tab === -1) { continue; }
      var id   = line.substring(0, tab).trim();
      var rest = line.substring(tab + 1).trim();
      var tab2 = rest.indexOf('\t');
      var name = tab2 !== -1 ? rest.substring(0, tab2).trim() : rest;
      var mediaKind = tab2 !== -1 ? rest.substring(tab2 + 1).trim() : 'song';
      // Interne HA-Hilfsplaylists ausblenden
      if (id && name && !name.startsWith('HA_Play_')) {
        playlists.push({ id: id, name: name, mediaKind: mediaKind });
      }
    }
    res.json({ playlists: playlists });
  });
});

app.put('/playlists/:id/play', function(req, res) {
  var idOrSlug = req.params.id;
  // If numeric, play directly
  if (/^\d+$/.test(idOrSlug)) {
    var script = path.join(__dirname, 'lib', 'play-playlist.applescript');
    return execFile('osascript', [script, idOrSlug], function(error, stdout) {
      if (error) { console.log('play-playlist error:', error); return res.sendStatus(500); }
      if ((stdout || '').trim() === 'notfound') { return res.sendStatus(404); }
      sendResponse(null, res);
    });
  }
  // Otherwise look up by slug/name
  var listScript = path.join(__dirname, 'lib', 'get-playlists.applescript');
  execFile('osascript', [listScript], function(error, stdout) {
    if (error) { return res.sendStatus(500); }
    var lines = (stdout || '').trim().split(/\r\n|\r|\n/);
    var matchId = null;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) { continue; }
      var tab = line.indexOf('	');
      if (tab === -1) { continue; }
      var pid  = line.substring(0, tab).trim();
      // Lines are `id \t name \t mediaKind`; take only the name field.
      var rest = line.substring(tab + 1);
      var tab2 = rest.indexOf('	');
      var name = (tab2 !== -1 ? rest.substring(0, tab2) : rest).trim();
      if (slugify(name) === idOrSlug || name === idOrSlug) { matchId = pid; break; }
    }
    if (!matchId) { return res.sendStatus(404); }
    var script = path.join(__dirname, 'lib', 'play-playlist.applescript');
    execFile('osascript', [script, matchId], function(error, stdout) {
      if (error) { console.log('play-playlist error:', error); return res.sendStatus(500); }
      if ((stdout || '').trim() === 'notfound') { return res.sendStatus(404); }
      sendResponse(null, res);
    });
  });
});


app.get('/playlists/:id/tracks', function(req, res) {
  var plId = req.params.id;
  if (!/^\d+$/.test(plId)) { return res.status(400).json({ error: 'numeric playlist id required' }); }
  var script = path.join(__dirname, 'lib', 'get-playlist-tracks.applescript');
  execFile('osascript', [script, plId], function(error, stdout) {
    if (error) { console.log('get-playlist-tracks error:', error); return res.sendStatus(500); }
    var out = (stdout || '').trim();
    if (out === 'notfound') { return res.sendStatus(404); }
    var tracks = [];
    var lines = out.split(/\r\n|\r|\n/);
    for (var i = 0; i < lines.length; i++) {
      var parts = lines[i].split('\t');
      if (parts.length < 5) { continue; }
      var id        = parts[0].trim();
      var name      = parts[1].trim();
      var artist    = parts[2].trim();
      var albArtist = parts[3].trim();
      var album     = parts[4].trim();
      var mediaKind = parts.length > 5 ? parts[5].trim() : 'song';
      if (id) {
        tracks.push({ id: id, name: name, artist: artist,
                      albumArtist: albArtist, album: album, mediaKind: mediaKind });
      }
    }
    var plName = '';
    getPlaylistsCached(function(err, playlists) {
      if (!err && playlists) {
        for (var i = 0; i < playlists.length; i++) {
          if (String(playlists[i].id) === String(plId)) { plName = playlists[i].name; break; }
        }
      }
      res.json({ playlist: plName, tracks: tracks });
    });
  });
});

app.get('/library/artists', function(req, res) {
  var offset = parseInt(req.query.offset) || 0;
  var limit  = parseInt(req.query.limit)  || 100;
  getLibraryTracks(function(error, tracks) {
    if (error) { console.log(error); return res.sendStatus(500); }
    if (!artistsCache) { artistsCache = buildArtists(tracks, 0, 999999); }
    var result = { total: artistsCache.total, offset: offset, limit: limit,
                   artists: artistsCache.artists.slice(offset, offset + limit) };
    res.json(result);
  });
});

// Titel der gerade laufenden Wiedergabeliste – auch fuer HA_Play_* Hilfslisten,
// die in /playlists bewusst ausgeblendet sind. Ohne laufende Liste: leeres Ergebnis.
function getCurrentPlaylistTracksJXA() {
  var itunes;
  try { itunes = Application('Music'); } catch (e) { itunes = Application('iTunes'); }
  var out = { playlist: '', tracks: [] };
  var pl;
  try { pl = itunes.currentPlaylist(); } catch (e) { return out; }
  if (!pl) { return out; }
  try { out.playlist = pl.name(); } catch (e) { out.playlist = ''; }
  var list;
  try { list = pl.tracks(); } catch (e) { return out; }
  for (var i = 0; i < list.length; i++) {
    var t = list[i];
    var id = '';
    try { id = t.persistentID(); } catch (e) {}
    if (!id) { continue; }
    out.tracks.push({
      id: id,
      name:        (function(){ try { return t.name() || ''; } catch(e) { return ''; } })(),
      artist:      (function(){ try { return t.artist() || ''; } catch(e) { return ''; } })(),
      albumArtist: (function(){ try { return t.albumArtist() || ''; } catch(e) { return ''; } })(),
      album:       (function(){ try { return t.album() || ''; } catch(e) { return ''; } })(),
      mediaKind:   (function(){ try { return t.mediaKind() || 'song'; } catch(e) { return 'song'; } })()
    });
  }
  return out;
}

app.get('/now_playing/tracks', function(req, res) {
  osa(getCurrentPlaylistTracksJXA, function(error, data) {
    if (error) { console.log('now-playing-tracks error:', error); return res.sendStatus(500); }
    res.json(data || { playlist: '', tracks: [] });
  });
});

app.get('/library/genres', function(req, res) {
  getLibraryTracks(function(error, tracks) {
    if (error) { console.log(error); return res.sendStatus(500); }
    res.json(buildGenres(tracks));
  });
});

// Tracks eines Genres, sortiert nach Album/Disc/Track wie die uebrigen Listen
app.get('/library/genres/:genre/tracks', function(req, res) {
  getLibraryTracks(function(error, tracks) {
    if (error) { console.log(error); return res.sendStatus(500); }
    var want = String(req.params.genre || '').toLowerCase();
    var hits = tracks.filter(function(t) {
      return (t.genre || '').toLowerCase() === want;
    });
    hits.sort(function(a, b) {
      var byAlbum = String(a.album || '').toLowerCase()
        .localeCompare(String(b.album || '').toLowerCase());
      if (byAlbum !== 0) { return byAlbum; }
      if ((a.disc_number || 1) !== (b.disc_number || 1)) {
        return (a.disc_number || 1) - (b.disc_number || 1);
      }
      return (a.track_number || 0) - (b.track_number || 0);
    });
    res.json({ genre: req.params.genre, tracks: hits });
  });
});

app.get('/library/artists/:artist/albums', function(req, res) {
  getLibraryTracks(function(error, tracks) {
    if (error) { console.log(error); return res.sendStatus(500); }
    res.json(buildAlbumsByArtist(tracks, req.params.artist));
  });
});

app.get('/library/artists/:artist/tracks', function(req, res) {
  getLibraryTracks(function(error, tracks) {
    if (error) { console.log(error); return res.sendStatus(500); }
    var artistName = req.params.artist;
    var results = [];
    for (var i = 0; i < tracks.length; i++) {
      var t           = tracks[i];
      var albumArtist = t.albumArtist || t.artist || '';
      var artist      = t.artist || '';
      if (albumArtist !== artistName && artist !== artistName) { continue; }
      results.push({
        id:           t.id,
        name:         t.name,
        artist:       t.artist,
        album:        t.album,
        track_number: t.track_number,
        disc_number:  t.disc_number,
        duration:     t.duration
      });
    }
    results.sort(function(a, b) {
      var aAlbum = a.album || '';
      var bAlbum = b.album || '';
      if (aAlbum !== bAlbum) { return aAlbum.localeCompare(bAlbum); }
      if (a.disc_number !== b.disc_number) { return a.disc_number - b.disc_number; }
      return a.track_number - b.track_number;
    });
    res.json({ artist: artistName, tracks: results });
  });
});

app.get('/library/albums', function(req, res) {
  var offset = parseInt(req.query.offset) || 0;
  var limit  = parseInt(req.query.limit)  || 50;
  getLibraryTracks(function(error, tracks) {
    if (error) { console.log(error); return res.sendStatus(500); }
    if (!albumsCache) { albumsCache = buildAlbums(tracks, 0, 999999); }
    var result = { total: albumsCache.total, offset: offset, limit: limit,
                   albums: albumsCache.albums.slice(offset, offset + limit) };
    res.json(result);
  });
});

app.get('/library/albums/:artist/:album/tracks', function(req, res) {
  getLibraryTracks(function(error, tracks) {
    if (error) { console.log(error); return res.sendStatus(500); }
    var artistName = req.params.artist;
    var albumName  = req.params.album;
    var results    = [];
    for (var i = 0; i < tracks.length; i++) {
      var t      = tracks[i];
      var album  = t.album || '';
      if (album !== albumName) { continue; }
      if (!matchesAlbumArtist(t, artistName)) { continue; }
      results.push({
        id:           t.id,
        name:         t.name,
        artist:       t.artist,
        album:        t.album,
        track_number: t.track_number,
        duration:     t.duration,
        disc_number:  t.disc_number
      });
    }
    results.sort(function(a, b) {
      if (a.disc_number !== b.disc_number) return a.disc_number - b.disc_number;
      return a.track_number - b.track_number;
    });
    res.json({ artist: artistName, album: albumName, tracks: results });
  });
});

app.put('/library/tracks/:id/play', function(req, res) {
  // Custom: statt track.play() direkt → temporäre 1-Track-Playlist 'HA_Play_Track' anlegen
  // und spielen, analog zu HA_Play_Album/HA_Play_Artist.
  // Vorteile:
  //   - sauberes Verhalten nach Track-Ende (kein ungewolltes Weitersetzen in der Library)
  //   - konsistentes Verhalten unabhängig von shuffle/repeat-Einstellungen
  //   - Grundlage für spätere "Add to Queue"-Funktion
  //   - 404-Erkennung: playByIDsTempScript schlägt fehl wenn ID unbekannt (duplicate() throws)
  var id = req.params.id;
  playByIDsTempScript('HA_Play_Track', [id], function(error) {
    if (error) {
      console.log('play-track error:', error);
      // Fallback auf direktes play falls temporäre Playlist fehlschlägt
      osa(playTrackByID, id, function(err2, played) {
        if (err2) { return res.sendStatus(500); }
        if (!played) { return res.sendStatus(404); }
        sendResponse(null, res);
      });
      return;
    }
    sendResponse(null, res);
  });
});

app.put('/library/albums/:artist/:album/play', function(req, res) {
  var artist = req.params.artist;
  var album  = req.params.album;
  getLibraryTracks(function(error, tracks) {
    if (error) { return res.sendStatus(500); }
    var ids = tracks
      .filter(function(t) { return t.album === album && matchesAlbumArtist(t, artist); })
      .sort(function(a, b) {
        var ka = (a.disc_number || 1) * 10000 + (a.track_number || 0);
        var kb = (b.disc_number || 1) * 10000 + (b.track_number || 0);
        return ka - kb;
      })
      .map(function(t) { return t.id; });
    if (ids.length === 0) { return res.sendStatus(404); }
    playByIDsTempScript('HA_Play_Album', ids, function(error) {
      if (error) { console.log('play-album error:', error); return res.sendStatus(500); }
      sendResponse(null, res);
    });
  });
});

app.put('/library/genres/:genre/play', function(req, res) {
  var want = String(req.params.genre || '').toLowerCase();
  getLibraryTracks(function(error, tracks) {
    if (error) { return res.sendStatus(500); }
    var ids = tracks
      .filter(function(t) { return (t.genre || '').toLowerCase() === want; })
      .sort(function(a, b) {
        if (a.album < b.album) { return -1; }
        if (a.album > b.album) { return 1; }
        var ka = (a.disc_number || 1) * 10000 + (a.track_number || 0);
        var kb = (b.disc_number || 1) * 10000 + (b.track_number || 0);
        return ka - kb;
      })
      .map(function(t) { return t.id; });
    if (ids.length === 0) { return res.sendStatus(404); }
    playByIDsTempScript('HA_Play_Genre', ids, function(error) {
      if (error) { console.log('play-genre error:', error); return res.sendStatus(500); }
      sendResponse(null, res);
    });
  });
});

app.put('/library/artists/:artist/play', function(req, res) {
  var artist = req.params.artist;
  getLibraryTracks(function(error, tracks) {
    if (error) { return res.sendStatus(500); }
    var ids = tracks
      .filter(function(t) { return (t.albumArtist || t.artist || '') === artist; })
      .sort(function(a, b) {
        if (a.album < b.album) { return -1; }
        if (a.album > b.album) { return 1; }
        var ka = (a.disc_number || 1) * 10000 + (a.track_number || 0);
        var kb = (b.disc_number || 1) * 10000 + (b.track_number || 0);
        return ka - kb;
      })
      .map(function(t) { return t.id; });
    if (ids.length === 0) { return res.sendStatus(404); }
    playByIDsTempScript('HA_Play_Artist', ids, function(error) {
      if (error) { console.log('play-artist error:', error); return res.sendStatus(500); }
      sendResponse(null, res);
    });
  });
});

// DEBUG: zeigt die sortierte Track-Reihenfolge ohne Playlist zu erstellen
// Aufruf: PUT /debug-play-ids mit body ids=id1,id2,...
app.put('/debug-play-ids', function(req, res) {
  var ids = (req.body.ids || '').split(',').filter(Boolean);
  if (!ids.length) { return res.status(400).json({ error: 'ids required' }); }
  getLibraryTracks(function(error, tracks) {
    if (error) { return res.sendStatus(500); }
    var idSet = {};
    ids.forEach(function(id) { idSet[id] = true; });
    var found = tracks.filter(function(t) { return idSet[t.id]; });
    // Gleiche Sortierung wie im JXA-Script
    found.sort(function(a, b) {
      var ac = (a.album || '').localeCompare(b.album || '');
      if (ac !== 0) return ac;
      if ((a.disc_number || 0) !== (b.disc_number || 0)) return (a.disc_number || 0) - (b.disc_number || 0);
      if ((a.track_number || 0) !== (b.track_number || 0)) return (a.track_number || 0) - (b.track_number || 0);
      return (a.artist || '').localeCompare(b.artist || '');
    });
    res.json({ count: found.length, tracks: found.map(function(t, i) {
      return { pos: i+1, album: t.album, disc: t.disc_number, track: t.track_number,
               artist: t.artist, albumArtist: t.albumArtist, name: t.name, id: t.id };
    })});
  });
});

app.put('/play-search', function(req, res) {
  var ids = (req.body.ids || '').split(',').filter(Boolean);
  if (!ids.length) { return res.status(400).json({ error: 'ids required' }); }
  getLibraryTracks(function(error, tracks) {
    if (error) { return res.sendStatus(500); }
    var trackMap = {};
    tracks.forEach(function(t) { trackMap[t.id] = t; });
    // Wie viele IDs kommen an, wie viele werden gefunden?
    var withMeta = ids.map(function(id) { return trackMap[id]; }).filter(Boolean);
    // Server-seitig sortieren: album → disc_number → track_number
    withMeta.sort(function(a, b) {
      var ac = (a.album || '').localeCompare(b.album || '');
      if (ac !== 0) return ac;
      if ((a.disc_number || 0) !== (b.disc_number || 0)) return (a.disc_number || 0) - (b.disc_number || 0);
      return (a.track_number || 0) - (b.track_number || 0);
    });
    var sortedIds = withMeta.map(function(t) { return t.id; });
    // Eindeutiger Playlist-Name mit Timestamp: verhindert dass Music.app die
    // gespeicherte Sort-Einstellung von früheren HA_Play_Search-Instanzen übernimmt.
    // Alte HA_Play_Search*-Playlists werden beim nächsten Aufruf gelöscht (via playByIDsTempScript).
    var playlistName = 'HA_Play_Search_' + Date.now();
    playByIDsTempScript(playlistName, sortedIds, function(err) {
      if (err) { console.log('play-search error:', err); return res.sendStatus(500); }
      console.log('[play-search] ' + playlistName + ' erstellt mit ' + sortedIds.length + ' Tracks');
      sendResponse(null, res);
    });
  });
});

app.put('/play-search-expand', function(req, res) {
  // Expandiert artist||Name und album||Artist||Album Content-IDs zu Track-IDs
  // und spielt sie als HA_Play_Search. Alle Tracks bereits im libraryCache.
  var rawItems = (req.body.items || '').split(',').filter(Boolean);
  if (!rawItems.length) { return res.status(400).json({ error: 'items required' }); }

  getLibraryTracks(function(error, tracks) {
    if (error) { return res.sendStatus(500); }
    var ids = [];
    var seen = {};
    rawItems.forEach(function(raw) {
      var parts = raw.split('||');
      if (parts[0] === 'artist' && parts[1]) {
        var artist = parts[1];
        tracks.forEach(function(t) {
          var a = t.albumArtist || t.artist || '';
          if (a === artist && !seen[t.id]) { seen[t.id] = true; ids.push(t.id); }
        });
      } else if (parts[0] === 'album' && parts[1] && parts[2]) {
        var albumArtist = parts[1], albumName = parts[2];
        tracks.forEach(function(t) {
          if (t.album === albumName && matchesAlbumArtist(t, albumArtist) && !seen[t.id]) {
            seen[t.id] = true; ids.push(t.id);
          }
        });
      }
    });
    if (!ids.length) { return res.status(404).json({ error: 'no tracks found' }); }
    playByIDsTempScript('HA_Play_Search', ids, function(err) {
      if (err) { console.log('play-search-expand error:', err); return res.sendStatus(500); }
      sendResponse(null, res);
    });
  });
});

app.get('/library/search', function(req, res) {
  var query = (req.query.q || '').toLowerCase();
  if (!query) {
    return res.status(400).json({ error: 'q parameter is required' });
  }
  // Custom addition: optional media_type filter ('all' | 'track' | 'artist' | 'album' |
  // 'playlist') and a per-category limit, so callers (e.g. HA's media_player.search_media)
  // can narrow the request the way YAMP's media-type chips expect. Defaults preserve the
  // previous track-only behaviour shape, just with the extra (empty) keys added.
  var mediaType = (req.query.media_type || 'all').toLowerCase();
  var limit = parseInt(req.query.limit) || 100;
  var wantTracks    = mediaType === 'all' || mediaType === 'track';
  var wantArtists   = mediaType === 'all' || mediaType === 'artist';
  var wantAlbums    = mediaType === 'all' || mediaType === 'album';
  var wantPlaylists = mediaType === 'all' || mediaType === 'playlist';
  var wantGenres    = mediaType === 'all' || mediaType === 'genre';

  getLibraryTracks(function(error, tracks) {
    if (error) { console.log(error); return res.sendStatus(500); }

    var trackResults = [];
    if (wantTracks) {
      // Sortiere vor der Suche nach Album → Disc → Track-Nummer, damit Suchergebnisse
      // automatisch in Album-Reihenfolge kommen (keine Nachsortierung nötig)
      var sorted = tracks.slice().sort(function(a, b) {
        var ac = (a.album || '').localeCompare(b.album || '');
        if (ac !== 0) return ac;
        var dd = (a.disc_number || 0) - (b.disc_number || 0);
        if (dd !== 0) return dd;
        return (a.track_number || 0) - (b.track_number || 0);
      });
      for (var i = 0; i < sorted.length && trackResults.length < limit; i++) {
        var t = sorted[i];
        if ((t.name || '').toLowerCase().indexOf(query) === -1) { continue; }
        trackResults.push({
          id: t.id, name: t.name, artist: t.artist, album: t.album,
          albumArtist: t.albumArtist, mediaKind: t.mediaKind || 'song'
        });
      }
    }

    var artistResults = [];
    if (wantArtists) {
      if (!artistsCache) { artistsCache = buildArtists(tracks, 0, 999999); }
      // Prüfen ob Künstler nur Musikvideos hat (für Video-Filter in der Karte)
      var artistKinds = {};
      tracks.forEach(function(t) {
        var a = t.albumArtist || t.artist || '';
        if (!artistKinds[a]) artistKinds[a] = [];
        artistKinds[a].push(t.mediaKind || 'song');
      });
      artistResults = artistsCache.artists
        .filter(function(a) { return a.name.toLowerCase().indexOf(query) !== -1; })
        .map(function(a) {
          var kinds = artistKinds[a.name] || [];
          var allVideos = kinds.length > 0 && kinds.every(function(k) { return k === 'music video'; });
          return { id: a.id, name: a.name, mediaKind: allVideos ? 'music video' : 'song' };
        })
        .slice(0, limit);
    }

    var albumResults = [];
    if (wantAlbums) {
      if (!albumsCache) { albumsCache = buildAlbums(tracks, 0, 999999); }
      // Prüfen ob Album nur Musikvideos enthält (für Video-Filter in der Karte)
      var trackMap = {};
      tracks.forEach(function(t) {
        var key = (t.albumArtist || t.artist || '') + '||' + (t.album || '');
        if (!trackMap[key]) trackMap[key] = [];
        trackMap[key].push(t.mediaKind || 'song');
      });
      albumResults = albumsCache.albums
        .filter(function(al) { return al.name.toLowerCase().indexOf(query) !== -1; })
        .map(function(al) {
          var key = al.artist + '||' + al.name;
          var kinds = trackMap[key] || [];
          var allVideos = kinds.length > 0 && kinds.every(function(k) { return k === 'music video'; });
          return { id: al.id, name: al.name, artist: al.artist, mediaKind: allVideos ? 'music video' : 'song' };
        })
        .slice(0, limit);
    }

    var genreResults = [];
    if (wantGenres) {
      genreResults = buildGenres(tracks).genres
        .filter(function(g) { return g.name.toLowerCase().indexOf(query) !== -1; })
        .slice(0, limit);
    }

    function sendResults(playlists) {
      var playlistResults = wantPlaylists
        ? playlists.filter(function(pl) { return pl.name.toLowerCase().indexOf(query) !== -1; }).slice(0, limit)
        : [];
      res.json({
        query: query,
        tracks: trackResults,
        artists: artistResults,
        albums: albumResults,
        playlists: playlistResults,
        genres: genreResults
      });
    }

    if (wantPlaylists) {
      getPlaylistsCached(function(plError, playlists) {
        if (plError) {
          // Degrade gracefully: a playlist-fetch failure shouldn't fail the whole search
          console.log('playlist search error:', plError);
          return sendResults([]);
        }
        sendResults(playlists);
      });
    } else {
      sendResults([]);
    }
  });
});



app.get('/airplay_devices', function(req, res) {
  osa(listAirPlayDevicesJXA, function(error, devices) {
    if (error) { console.log('airplay list error:', error); return res.sendStatus(500); }
    res.json({ airplay_devices: devices || [] });
  });
});

app.get('/airplay_devices/:id', function(req, res) {
  osa(listAirPlayDevicesJXA, function(error, devices) {
    if (error) { return res.sendStatus(500); }
    for (var i = 0; i < devices.length; i++) {
      if (devices[i].id === req.params.id) { return res.json(devices[i]); }
    }
    res.sendStatus(404);
  });
});

app.put('/airplay_devices/:id/on', function(req, res) {
  osa(setAirPlaySelectionJXA, req.params.id, true, function(error) {
    if (error) { console.log('airplay-on error:', error); return res.sendStatus(500); }
    sendResponse(null, res);
  });
});

app.put('/airplay_devices/:id/off', function(req, res) {
  osa(setAirPlaySelectionJXA, req.params.id, false, function(error) {
    if (error) { console.log('airplay-off error:', error); return res.sendStatus(500); }
    sendResponse(null, res);
  });
});

app.put('/airplay_devices/:id/volume', function(req, res) {
  osa(setAirPlayVolumeJXA, req.params.id, parseInt(req.body.level), function(error) {
    if (error) { console.log('airplay-volume error:', error); return res.sendStatus(500); }
    sendResponse(null, res);
  });
});

process.on('uncaughtException', function(err) {
  console.error('[uncaughtException] Server kept alive:', err.message || err);
});

process.on('unhandledRejection', function(reason) {
  console.error('[unhandledRejection] Server kept alive:', reason);
});

app.get('/library/tracks', function(req, res) {
  var offset = parseInt(req.query.offset) || 0;
  var limit  = parseInt(req.query.limit)  || 100;
  var letter = (req.query.letter || '').toUpperCase();
  getLibraryTracks(function(error, tracks) {
    if (error) { console.log(error); return res.sendStatus(500); }
    var filtered = tracks;
    if (letter) {
      filtered = tracks.filter(function(t) {
        if (!t.name) { return letter === '#'; }
        var c = t.name.trim()[0].toUpperCase();
        return letter === '#' ? !/[A-Z]/.test(c) : c === letter;
      });
    }
    var sorted = filtered.slice().sort(function(a, b) {
      return (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase());
    });
    res.json({
      total:  sorted.length,
      offset: offset,
      limit:  limit,
      letter: letter || null,
      tracks: sorted.slice(offset, offset + limit)
    });
  });
});

app.listen(process.env.PORT || 8181);

getLibraryTracks(function(error, tracks) {
  if (error) {
    console.log('Library cache warm failed:', error.message || error);
  } else {
    console.log('Library cache warmed: ' + tracks.length + ' tracks loaded.');
    albumsCache  = buildAlbums(tracks, 0, 999999);
    artistsCache = buildArtists(tracks, 0, 999999);
    console.log('Albums/artists cache built: ' + albumsCache.total + ' albums, ' + artistsCache.total + ' artists.');
    prefetchAllArtwork(tracks);
  }
});

setInterval(function() {
  libraryCache.fetchedAt = 0;
  getLibraryTracks(function(error, tracks) {
    if (error) {
      console.log('Library cache refresh failed:', error.message || error);
    } else {
      albumsCache  = buildAlbums(tracks, 0, 999999);
      artistsCache = buildArtists(tracks, 0, 999999);
      console.log('Library cache refreshed: ' + tracks.length + ' tracks.');
    }
  });
}, 30 * 60 * 1000);
