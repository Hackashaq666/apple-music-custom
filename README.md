# Apple Music for Home Assistant

Control Apple Music on macOS from Home Assistant — with native media browser, AirPlay device control, album art, and real-time playback progress tracking.

---

## Credits

The Mac server is based on [itunes-api](https://github.com/maddox/itunes-api) by [Jon Maddox](https://github.com/maddox), with further updates by [chasut](https://github.com/chasut/itunes-api) for compatibility with the modern Apple Music app. This project extends that work with progress tracking, library browsing, and a modernized install process.

---

## Overview

This integration has two parts:

1. **A REST API server** that runs on your Mac and exposes the Apple Music app over HTTP
2. **A Home Assistant custom integration** that connects to that server

---

## Features

- Play, pause, stop, next, previous, seek
- Volume and mute control
- Shuffle and repeat modes
- Real-time playback progress bar
- Album art (updates per track)
- AirPlay device selection and volume control
- Native HA media browser — browse Playlists, Artists, and Albums
- Config flow UI setup — no YAML required

---

## Requirements

- macOS 12 or later
- Node.js 18 or later
- Apple Music app
- Home Assistant 2024.1 or later

---

## Part 1 — Mac Server Setup

The server runs on your Mac and gives Home Assistant a local REST API to control the Music app.

### Install

```bash
git clone https://github.com/Hackashaq666/apple-music-hacs.git
cd apple-music-hacs/server
npm run install-service
```

The server starts immediately on port `8181` and will auto-start at login and restart if it crashes. No other dependencies required.

To use a different port:

```bash
PORT=9000 npm run install-service
```

### Verify

Open `http://localhost:8181` in your browser. You should see the Apple Music API status page showing what's currently playing.

Or test via curl:

```bash
curl http://localhost:8181/now_playing
```

### Dev mode (optional)

To run in the foreground with console logging:

```bash
npm run dev
```

### Uninstall server

```bash
cd apple-music-hacs/server
npm run uninstall-service
```

### Server API

The server runs on your Mac's local IP (e.g. `http://192.168.1.100:8181`). Key endpoints:

| Method | Endpoint | Description |
|---|---|---|
| GET | `/now_playing` | Current player state with progress |
| GET | `/artwork` | Current track album art (JPEG) |
| PUT | `/play` | Play |
| PUT | `/pause` | Pause |
| PUT | `/next` | Next track |
| PUT | `/previous` | Previous track |
| PUT | `/seek` | Seek to position (body: `position=90.5`) |
| PUT | `/volume` | Set volume (body: `level=60`) |
| PUT | `/shuffle` | Set shuffle (body: `mode=songs\|off`) |
| PUT | `/repeat` | Set repeat (body: `mode=all\|one\|off`) |
| GET | `/playlists` | List playlists |
| PUT | `/playlists/:id/play` | Play a playlist |
| GET | `/library/artists` | Browse artists |
| GET | `/library/albums` | Browse albums |
| GET | `/library/albums/:artist/:album/tracks` | Tracks in an album |
| PUT | `/library/tracks/:id/play` | Play a track by ID |
| GET | `/library/search?q=query` | Search tracks |
| GET | `/airplay_devices` | List AirPlay devices |
| PUT | `/airplay_devices/:id/on` | Enable AirPlay device |
| PUT | `/airplay_devices/:id/off` | Disable AirPlay device |

---

## Part 2 — Home Assistant Integration

### Install via HACS

1. In HACS, go to **Integrations**
2. Click the three-dot menu → **Custom repositories**
3. Add `https://github.com/Hackashaq666/apple-music-hacs` as an **Integration**
4. Search for **Apple Music** in HACS and install it
5. Restart Home Assistant

### Manual install

Copy the `custom_components/apple_music/` folder into your HA `config/custom_components/` directory and restart Home Assistant.

### Setup

1. Go to **Settings → Integrations → Add Integration**
2. Search for **Apple Music**
3. Enter your Mac's IP address and port (`8181`)
4. Click **Submit**

Home Assistant will discover your Apple Music player and all AirPlay devices automatically.

---

## Entities

| Entity | Type | Description |
|---|---|---|
| `media_player.apple_music` | Media Player | Main Apple Music player |
| `media_player.<airplay_device>` | Media Player | One per AirPlay device |

### Media Browser

The integration supports HA's native media browser. Navigate to:

- **Playlists** — play any playlist
- **Artists** → Albums → Tracks
- **Albums** → Tracks

The library cache warms automatically when the server starts and refreshes every 30 minutes in the background. The media browser should always be fast after the initial startup warm.

---

## Notes

- The server must be running on your Mac for the integration to work
- Apple Music must be open (it launches automatically when the server starts a track)
- AirPlay device state updates every 5 seconds alongside the player state
- The library cache refreshes every 30 minutes in the background and stays valid for 60 minutes — the media browser should always be fast
- Album art is fetched from the local Mac — it is not externally accessible

---

## Troubleshooting

**Integration shows unavailable**
- Check the server is running: `curl http://<mac-ip>:8181/_ping`
- Check the Mac firewall allows connections on port 8181

**Media browser is slow on first open**
- The library cache is still warming on startup. Wait 30–60 seconds after the server starts and try again. After that it stays warm indefinitely via background refresh.

**Artwork not updating**
- Make sure you are running the latest version of both the server and the integration

**AirPlay devices not appearing**
- Reload the integration: Settings → Integrations → Apple Music → Reload

---

## Contributing

1. Fork the repo
2. Create a feature branch
3. Open a pull request

---

## License

MIT
