# Quick Reference – All Endpoints (Development)

Base URL: `http://localhost:8080`  •  Use exactly one of `token` | `playerId` | `playerUuid` | `playerName` | `regionId` for targeting. Admin routes require `x-admin-key` if configured.

---

## Set Region
```sh
curl -X POST http://localhost:8080/set-region \
  -H "Content-Type: application/json" \
  -d '{"playerUuid":"a7b49cc2-2bdb-4e4e-aa45-95daadcc2369","regionId":"spawn","regionDisplayName":"Spawn"}'
```

## Init
```sh
curl -X POST http://localhost:8080/admin/video/init \
  -H "Content-Type: application/json" -H "x-admin-key: changeme" \
  -d '{"regionId":"spawn","url":"https://example.com/video.mp4","autoclose":true}'
```
Add optional presentation keys like `backgroundImageUrl`, `backgroundImageTarget`, `backgroundImagePosition`, `backgroundImageRepeat`, `backgroundImageSize`, and `backdropBackgroundColor`/`modalBackgroundColor` to style the player shell. Supply `streamType` to force HLS/DASH/WebRTC handling (`"hls"`, `"dash"`, or `"webrtc"`). When omitted the client auto-detects `.m3u8` (HLS) and `.mpd` (DASH) URLs. Optional `streamConfig` objects are forwarded to the streaming library (for example `{ "hls": { "enableWorker": true } }` for hls.js or `{ "dash": { "streaming": { "lowLatencyEnabled": true } } }` for dash.js).

## Play
```sh
curl -X POST http://localhost:8080/admin/video/play \
  -H "Content-Type: application/json" -H "x-admin-key: changeme" \
  -d '{"token":"565"}'
```
Include `streamType`/`streamConfig` if you need to override the init payload (for example when switching from VOD to a live HLS feed without re-running `/init`).

## Pause
```sh
curl -X POST http://localhost:8080/admin/video/pause \
  -H "Content-Type: application/json" -H "x-admin-key: changeme" \
  -d '{"token":"565","atMs":12000}'
```

## Seek
```sh
curl -X POST http://localhost:8080/admin/video/seek \
  -H "Content-Type: application/json" -H "x-admin-key: changeme" \
  -d '{"playerName":"Steve","toMs":45000}'
```

## Close
```sh
curl -X POST http://localhost:8080/admin/video/close \
  -H "Content-Type: application/json" -H "x-admin-key: changeme" \
  -d '{"token":"565"}'
```

## Play Instant
Include the same optional visual keys as `init` for a custom background.

```sh
curl -X POST http://localhost:8080/admin/video/play-instant \
  -H "Content-Type: application/json" -H "x-admin-key: changeme" \
  -d '{
        "regionId": "spawn",
        "url": "https://example.com/video.mp4",
        "autoclose": true,
        "streamType": "hls",
        "streamConfig": { "hls": { "enableWorker": true } },
        "backgroundImageUrl": "https://example.com/poster.jpg",
        "backgroundImageTarget": "modal",
        "backgroundImageSize": "cover"
      }'
```

## Preload
```sh
curl -X POST http://localhost:8080/admin/video/preload \
  -H "Content-Type: application/json" -H "x-admin-key: changeme" \
  -d '{"token":"565","url":"https://example.com/video.mp4"}'
```
Preload skips streaming URLs—HLS/DASH sources are attached at play time because they require the runtime player to stay active.

## Initialize Playlist
```sh
curl -X POST http://localhost:8080/admin/video/initialize-playlist \
  -H "Content-Type: application/json" -H "x-admin-key: changeme" \
  -d '{"regionId":"spawn","items":[{"url":"https://example.com/intro.mp4"},{"url":"https://example.com/live.m3u8","streamType":"hls"}]}'
```

## List Connections
```sh
curl http://localhost:8080/admin/video/connections -H "x-admin-key: changeme"
```

## List Regions
```sh
curl http://localhost:8080/admin/video/regions -H "x-admin-key: changeme"
```

## Health
```sh
curl http://localhost:8080/healthz
```

---

## Minecraft Plugin WebSocket (Development)

- Endpoint: `ws://localhost:8080/ws/plugin?token=YOUR_PLUGIN_TOKEN`
- Token: same as `PLUGIN_TOKEN` in `.env` (default `changeme`).

Send JSON with `type` set to one of: `SET_REGION`, `VIDEO_INIT`, `VIDEO_PLAY`, `VIDEO_PAUSE`, `VIDEO_SEEK`, `VIDEO_CLOSE`, `VIDEO_PLAY_INSTANT`, `VIDEO_PRELOAD`, `VIDEO_PLAYLIST_INIT`.

Example:
```json
{
  "id": "region-sync",
  "type": "SET_REGION",
  "playerUuid": "a7b49cc2-2bdb-4e4e-aa45-95daadcc2369",
  "regionId": "spawn"
}
```

Each command receives a `PLUGIN_RESPONSE` with the HTTP-like status and body.
