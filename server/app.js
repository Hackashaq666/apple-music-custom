var fs = require('fs')
var path = require('path')
var util = require('util')
var express = require('express')
var morgan = require('morgan')
var bodyParser = require('body-parser')
var iTunes = require('local-itunes')
var osa = require('osa')
var osascript = require('osascript')
var airplay = require('./lib/airplay')
var parameterize = require('parameterize');

var app = express()
app.use(bodyParser.urlencoded({ extended: false }))
app.use(express.static(path.join(__dirname, 'public')));


var logFormat = "'[:date[iso]] - :remote-addr - :method :url :status :response-time ms - :res[content-length]b'"
app.use(morgan(logFormat))


function getCurrentState() {
  try {
    itunes = Application('Music');
  } catch (error) {
    itunes = Application('iTunes');
  }

  playerState = itunes.playerState();
  currentState = {};
  currentState['player_state'] = playerState;

  if (playerState != 'stopped') {
    currentTrack = itunes.currentTrack;

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
  try {
    itunes = Application('Music');
  } catch (error) {
    itunes = Application('iTunes');
  }
  itunes.playerPosition = parseFloat(position);
  return true;
}

function setVolume(level) {
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

function getPlaylistsFromItunes() {
  try {
    itunes = Application('Music');
  } catch (error) {
    itunes = Application('iTunes');
  }
  playlists = itunes.playlists();
  playlistNames = [];
  for (var i = 0; i < playlists.length; i++) {
    playlist = playlists[i];
    data = {};
    data['id']                  = playlist.id();
    data['name']                = playlist.name();
    data['loved']               = playlist.loved();
    data['duration_in_seconds'] = playlist.duration();
    data['time']                = playlist.time();
    playlistNames.push(data);
  }
  return playlistNames;
}

function playPlaylist(nameOrId) {
  try {
    itunes = Application('Music');
  } catch (error) {
    itunes = Application('iTunes');
  }
  if ((nameOrId - 0) == nameOrId && ('' + nameOrId).trim().length > 0) {
    id = parseInt(nameOrId);
    itunes.playlists.byId(id).play();
  } else {
    itunes.playlists.byName(nameOrId).play();
  }
  return true;
}


var execFile = require('child_process').execFile;

var FETCH_TRACKS_SCRIPT = [
  'try { itunes = Application("Music"); } catch(e) { itunes = Application("iTunes"); }',
  'var raw = itunes.tracks();',
  'var tracks = [];',
  'for (var i = 0; i < raw.length; i++) {',
  '  var t = raw[i];',
  '  tracks.push({',
  '    id: t.persistentID(),',
  '    name: t.name() || "",',
  '    artist: t.artist() || "",',
  '    albumArtist: t.albumArtist() || "",',
  '    album: t.album() || "",',
  '    track_number: t.trackNumber(),',
  '    disc_number: t.discNumber(),',
  '    duration: t.duration()',
  '  });',
  '}',
  'JSON.stringify(tracks);'
].join(' ');







function playTrackByID(persistentID) {
  try {
    itunes = Application('Music');
  } catch (e) {
    itunes = Application('iTunes');
  }
  var allTracks = itunes.tracks();
  for (var i = 0; i < allTracks.length; i++) {
    if (allTracks[i].persistentID() === persistentID) {
      allTracks[i].play();
      return true;
    }
  }
  return false;
}




function sendResponse(error, res) {
  if (error) {
    console.log(error);
    res.sendStatus(500);
  } else {
    osa(getCurrentState, function(error, state) {
      if (error) {
        console.log(error);
        res.sendStatus(500);
      } else {
        res.json(state);
      }
    });
  }
}

function getPlaylists(callback) {
  osa(getPlaylistsFromItunes, function(error, data) {
    if (error) {
      callback(error);
    } else {
      for (var i = 0; i < data.length; i++) {
        data[i]['id'] = parameterize(data[i]['name']);
      }
      callback(null, data);
    }
  });
}

var libraryCache = { tracks: null, fetchedAt: 0, ttl: 5 * 60 * 1000, pending: [] };

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
        callbacks.forEach(function(cb) { cb(null, tracks); });
      } catch (e) {
        callbacks.forEach(function(cb) { cb(e); });
      }
    }
  );
}

function buildAlbums(tracks, offset, limit) {
  var seen   = {};
  var albums = [];
  for (var i = 0; i < tracks.length; i++) {
    var t      = tracks[i];
    var name   = t.album;
    if (!name) { continue; }
    var artist = t.albumArtist || t.artist || '';
    var key    = artist + '||' + name;
    if (!seen[key]) {
      seen[key] = true;
      albums.push({ id: slugify(key), name: name, artist: artist });
    }
  }
  albums.sort(function(a, b) { return a.name.toLowerCase().localeCompare(b.name.toLowerCase()); });
  return { total: albums.length, offset: offset, limit: limit, albums: albums.slice(offset, offset + limit) };
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

function buildAlbumsByArtist(tracks, artistName) {
  var seen   = {};
  var albums = [];
  for (var i = 0; i < tracks.length; i++) {
    var t      = tracks[i];
    var artist = t.albumArtist || t.artist || '';
    if (artist !== artistName) { continue; }
    var name = t.album;
    if (name && !seen[name]) {
      seen[name] = true;
      albums.push({ id: slugify(artistName + '||' + name), name: name });
    }
  }
  albums.sort(function(a, b) { return a.name.toLowerCase().localeCompare(b.name.toLowerCase()); });
  return { artist: artistName, albums: albums };
}


app.get('/_ping', function(req, res) {
  res.send('OK');
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
    res.sendFile('/tmp/currently-playing.jpg');
  });
});

app.get('/playlists', function(req, res) {
  getPlaylists(function(error, data) {
    if (error) { console.log(error); res.sendStatus(500); }
    else { res.json({ playlists: data }); }
  });
});

app.put('/playlists/:id/play', function(req, res) {
  osa(getPlaylistsFromItunes, function(error, data) {
    if (error) { return res.sendStatus(500); }
    for (var i = 0; i < data.length; i++) {
      playlist = data[i];
      if (req.params.id == parameterize(playlist['name'])) {
        osa(playPlaylist, playlist['id'], function(error, data) {
          sendResponse(error, res);
        });
        return;
      }
    }
    res.sendStatus(404);
  });
});


app.get('/library/artists', function(req, res) {
  var offset = parseInt(req.query.offset) || 0;
  var limit  = parseInt(req.query.limit)  || 100;
  getLibraryTracks(function(error, tracks) {
    if (error) { console.log(error); res.sendStatus(500); }
    else { res.json(buildArtists(tracks, offset, limit)); }
  });
});

app.get('/library/artists/:artist/albums', function(req, res) {
  getLibraryTracks(function(error, tracks) {
    if (error) { console.log(error); res.sendStatus(500); }
    else { res.json(buildAlbumsByArtist(tracks, req.params.artist)); }
  });
});

app.get('/library/albums', function(req, res) {
  var offset = parseInt(req.query.offset) || 0;
  var limit  = parseInt(req.query.limit)  || 50;
  getLibraryTracks(function(error, tracks) {
    if (error) { console.log(error); res.sendStatus(500); }
    else { res.json(buildAlbums(tracks, offset, limit)); }
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
      var artist = t.albumArtist || t.artist || '';
      var album  = t.album || '';
      if (album !== albumName || artist !== artistName) { continue; }
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
  osa(playTrackByID, req.params.id, function(error, played, log) {
    if (error) { console.log(error); res.sendStatus(500); }
    else if (!played) { res.sendStatus(404); }
    else { sendResponse(null, res); }
  });
});

app.get('/library/search', function(req, res) {
  var query = (req.query.q || '').toLowerCase();
  if (!query) {
    return res.status(400).json({ error: 'q parameter is required' });
  }
  getLibraryTracks(function(error, tracks) {
    if (error) { console.log(error); return res.sendStatus(500); }
    var results = [];
    for (var i = 0; i < tracks.length && results.length < 50; i++) {
      var t = tracks[i];
      if ((t.name || '').toLowerCase().indexOf(query) === -1) { continue; }
      results.push({ id: t.id, name: t.name, artist: t.artist, album: t.album });
    }
    res.json({ query: query, tracks: results });
  });
});


app.get('/airplay_devices', function(req, res) {
  osa(airplay.listAirPlayDevices, function(error, data, log) {
    if (error) { res.sendStatus(500); }
    else { res.json({ airplay_devices: data }); }
  });
});

app.get('/airplay_devices/:id', function(req, res) {
  osa(airplay.listAirPlayDevices, function(error, data, log) {
    if (error) { return res.sendStatus(500); }
    for (var i = 0; i < data.length; i++) {
      device = data[i];
      if (req.params.id == device['id']) {
        res.json(device);
        return;
      }
    }
    res.sendStatus(404);
  });
});

app.put('/airplay_devices/:id/on', function(req, res) {
  osa(airplay.setSelectionStateAirPlayDevice, req.params.id, true, function(error, data, log) {
    if (error) { console.log(error); res.sendStatus(500); }
    else { res.json(data); }
  });
});

app.put('/airplay_devices/:id/off', function(req, res) {
  osa(airplay.setSelectionStateAirPlayDevice, req.params.id, false, function(error, data, log) {
    if (error) { console.log(error); res.sendStatus(500); }
    else { res.json(data); }
  });
});

app.put('/airplay_devices/:id/volume', function(req, res) {
  osa(airplay.setVolumeAirPlayDevice, req.params.id, req.body.level, function(error, data, log) {
    if (error) { console.log(error); res.sendStatus(500); }
    else { res.json(data); }
  });
});

app.listen(process.env.PORT || 8181);

getLibraryTracks(function(error, tracks) {
  if (error) {
    console.log('Library cache warm failed:', error.message || error);
  } else {
    console.log('Library cache warmed: ' + tracks.length + ' tracks loaded.');
  }
});
