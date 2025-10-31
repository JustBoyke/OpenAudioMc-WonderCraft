# Video Control cURL Cheatsheet (Production)

Base URL: `https://audio.wondercraftmc.nl/api/`

- Send JSON bodies (`-H "Content-Type: application/json"`).
- Admin endpoints require `-H "x-admin-key: <your-admin-key>"`.
- Target a recipient with exactly one of: `token`, `playerId`, `playerUuid`, `playerName`, or `regionId`.

---

## POST /set-region
Assign or clear a player's region mapping.

```sh
curl -X POST https://audio.wondercraftmc.nl/api/set-region \
  -H "Content-Type: application/json" \
  -d '{"playerUuid":"a7b49cc2-2bdb-4e4e-aa45-95daadcc2369","regionId":"spawn","regionDisplayName":"Spawn"}'
```

Clear mapping:
```sh
curl -X POST https://audio.wondercraftmc.nl/api/set-region \
  -H "Content-Type: application/json" \
  -d '{"token":"TOKEN_HERE","regionId":null}'
```

---

## POST /admin/video/init
```sh
curl -X POST https://audio.wondercraftmc.nl/api/admin/video/init \
  -H "Content-Type: application/json" -H "x-admin-key: changeme" \
  -d '{
        "regionId": "spawn",
        "url": "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4",
        "autoclose": true,
        "backgroundImageUrl": "https://example.com/poster.jpg",
        "backgroundImageTarget": "modal",
        "backgroundImageSize": "cover"
      }'
```
Optional extras: `backgroundImageTarget`, `backgroundImagePosition` (or `backgroundImagePositionX`/`backgroundImagePositionY`), `backgroundImageRepeat`, `backgroundImageAttachment`, `backgroundImageSize`, `backdropBackgroundColor`, `modalBackgroundColor`.
Use `streamType` to force the streaming backend (`"hls"`, `"dash"`, `"webrtc"`) and `streamConfig` to forward library options (for example `{ "hls": { "enableWorker": true } }`). When omitted, `.m3u8` and `.mpd` URLs are detected automatically.

## POST /admin/video/play
```sh
curl -X POST https://audio.wondercraftmc.nl/api/admin/video/play \
  -H "Content-Type: application/json" -H "x-admin-key: changeme" \
  -d '{"token":"TOKEN_HERE"}'
```
Add `streamType`/`streamConfig` if you need to override the active stream without re-running `/init`.

## POST /admin/video/pause
```sh
curl -X POST https://audio.wondercraftmc.nl/api/admin/video/pause \
  -H "Content-Type: application/json" -H "x-admin-key: changeme" \
  -d '{"token":"TOKEN_HERE","atMs":15000}'
```

## POST /admin/video/seek
```sh
curl -X POST https://audio.wondercraftmc.nl/api/admin/video/seek \
  -H "Content-Type: application/json" -H "x-admin-key: changeme" \
  -d '{"playerName":"Steve","toMs":45000}'
```

## POST /admin/video/close
```sh
curl -X POST https://audio.wondercraftmc.nl/api/admin/video/close \
  -H "Content-Type: application/json" -H "x-admin-key: changeme" \
  -d '{"token":"TOKEN_HERE"}'
```

## POST /admin/video/play-instant
Supports the same optional visual keys as `/admin/video/init`.

```sh
curl -X POST https://audio.wondercraftmc.nl/api/admin/video/play-instant \
  -H "Content-Type: application/json" -H "x-admin-key: changeme" \
  -d '{
        "regionId": "spawn",
        "url": "https://example.com/video.mp4",
        "autoclose": true,
        "streamType": "dash",
        "streamConfig": { "dash": { "streaming": { "lowLatencyEnabled": true } } },
        "backgroundImageUrl": "https://example.com/poster.jpg",
        "backgroundImageTarget": "modal",
        "backgroundImageSize": "cover"
      }'
```

## POST /admin/video/preload
```sh
curl -X POST https://audio.wondercraftmc.nl/api/admin/video/preload \
  -H "Content-Type: application/json" -H "x-admin-key: changeme" \
  -d '{"token":"TOKEN_HERE","url":"https://example.com/video.mp4"}'
```
Streaming URLs (HLS/DASH) are not preloaded—the client binds them when playback starts so the player instance can manage the media source.

## POST /admin/video/initialize-playlist
```sh
curl -X POST https://audio.wondercraftmc.nl/api/admin/video/initialize-playlist \
  -H "Content-Type: application/json" -H "x-admin-key: changeme" \
  -d '{"regionId":"spawn","items":[{"url":"https://example.com/intro.mp4"},{"url":"https://example.com/live/playlist.m3u8","streamType":"hls"}]}'
```

## GET /admin/video/connections
```sh
curl https://audio.wondercraftmc.nl/api/admin/video/connections -H "x-admin-key: changeme"
```

## GET /admin/video/regions
```sh
curl https://audio.wondercraftmc.nl/api/admin/video/regions -H "x-admin-key: changeme"
```

## GET /healthz
```sh
curl https://audio.wondercraftmc.nl/api/healthz
```

---

## Minecraft Plugin WebSocket (Production)

- Endpoint: `wss://audio.wondercraftmc.nl/api/ws/plugin?token=YOUR_PLUGIN_TOKEN`
- Token: value must match `PLUGIN_TOKEN` on the server.

Send JSON payloads with the same `type` names and fields as the REST helpers: `SET_REGION`, `VIDEO_INIT`, `VIDEO_PLAY`, `VIDEO_PAUSE`, `VIDEO_SEEK`, `VIDEO_CLOSE`, `VIDEO_PLAY_INSTANT`, `VIDEO_PRELOAD`, `VIDEO_PLAYLIST_INIT`.

The server responds with `PLUGIN_RESPONSE` messages including the echoed `id` (if sent), status and body.

---

## ATC (Attraction Controls)

### POST /admin/atc/createAttraction
Create or overwrite an attraction definition on disk. The server writes `server/attractions/[attraction_id].json` and uses it to seed the web control panel state. All states default to `2` (disabled) unless overridden.

```sh
curl -X POST https://audio.wondercraftmc.nl/api/admin/atc/createAttraction \
  -H "Content-Type: application/json" -H "x-admin-key: changeme" \
  -d '{
        "attraction_id": "baron-1898",
        "attraction_name": "Baron 1898",
        "atc_power": 2,
        "atc_status": 2,
        "atc_station": 2,
        "atc_gates": 2,
        "atc_beugels": 2,
        "atc_emercency": 2
      }'
```

Notes:
- Web panels are read-only with respect to persistence. Only the plugin updates the file by sending `ATC_SERVER_UPDATE` on the plugin WebSocket; the server then broadcasts `atc_serverUpdate` to connected panels so the UI syncs.
- Web panels send `atc_update`; the server forwards to the plugin as `ATC_CLIENT_UPDATE`. The plugin executes and responds with `ATC_SERVER_UPDATE` containing the authoritative new value.
