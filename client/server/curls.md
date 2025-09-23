# Video Control API – cURL (Development)

Base URL: `http://localhost:8080`

- Send JSON bodies (`-H "Content-Type: application/json"`).
- Admin endpoints require `-H "x-admin-key: <your-admin-key>"` (if `ADMIN_KEY` is set).
- Target a recipient using exactly one of: `token`, `playerId`, `playerUuid`, `playerName`, or `regionId`.

Tip: in the browser client, you can inspect the current token via `window.__oaVideoExtensionDebug.wsUrl()` in DevTools.

---

## Targeting Helpers

- Player/Token fields (choose one): `token` | `playerId` | `playerUuid` | `playerName`
- Region broadcast: use `regionId` instead of a player/token.

Examples:

```sh
# Target a specific token
"token": "TOKEN_HERE"

# Target by player UUID (case-insensitive)
"playerUuid": "a7b49cc2-2bdb-4e4e-aa45-95daadcc2369"

# Broadcast to a region (all members in that region)
"regionId": "spawn"
```

---

## POST /set-region
Assign or clear a player's region mapping. The server also maintains canonical mappings for `playerId`/`playerUuid`/`playerName` so future sessions inherit the region.

Body:
- One player reference: `token` | `playerId` | `playerUuid` | `playerName`
- Region: `region` or `regionId` (string). Use `null` to clear.
- Optional label: `regionDisplayName` (or `regionName`/`regionLabel`).

Examples:

```sh
# Set region "spawn" for a player UUID
curl -X POST http://localhost:8080/set-region \
  -H "Content-Type: application/json" \
  -d '{
        "playerUuid": "a7b49cc2-2bdb-4e4e-aa45-95daadcc2369",
        "regionId": "spawn",
        "regionDisplayName": "Spawn"
      }'

# Clear region for a connected token
curl -X POST http://localhost:8080/set-region \
  -H "Content-Type: application/json" \
  -d '{ "token": "TOKEN_HERE", "regionId": null }'
```

---

## POST /admin/video/init
Prepare a video for a target or region.

Body fields:
- Required: `url`
- Optional playback: `startAtEpochMs`, `muted` (bool), `volume` (0.0–1.0), `sessionId`, `autoclose` (bool)
- Streaming: `streamType` (`"hls"`, `"dash"`, `"webrtc"`) to force a backend, and `streamConfig` to forward player options (e.g. `{ "hls": { "enableWorker": true } }`). When omitted the client auto-detects `.m3u8`/`.mpd` URLs and prefers native playback when available.
- Optional visuals: `backgroundImageUrl`, `backgroundImageTarget` (`"backdrop"` or `"modal"`), `backgroundImagePosition` (or `backgroundImagePositionX`/`backgroundImagePositionY`), `backgroundImageRepeat`, `backgroundImageSize`, `backgroundImageAttachment`, `backdropBackgroundColor`, `modalBackgroundColor`
- Target: one of the targeting fields above

Examples:

```sh
curl -X POST http://localhost:8080/admin/video/init \
  -H "Content-Type: application/json" \
  -H "x-admin-key: changeme" \
  -d '{
        "token": "TOKEN_HERE",
        "url": "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4",
        "startAtEpochMs": 1720000000000,
        "muted": false,
        "volume": 1.0,
        "sessionId": "area-lobby",
        "autoclose": false,
        "backgroundImageUrl": "https://example.com/poster.jpg",
        "backgroundImageTarget": "backdrop",
        "backgroundImagePosition": "center center",
        "backdropBackgroundColor": "rgba(0,0,0,0.65)"
      }'

# Region broadcast
curl -X POST http://localhost:8080/admin/video/init \
  -H "Content-Type: application/json" \
  -H "x-admin-key: changeme" \
  -d '{
        "regionId": "spawn",
        "url": "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4",
        "autoclose": true
      }'
```

---

## POST /admin/video/play
Start or resume playback. Optional overrides: `atMs`, `volume`, `muted`, `autoclose`, plus `streamType`/`streamConfig` if you need to swap streaming modes without running `/init` again.

```sh
curl -X POST http://localhost:8080/admin/video/play \
  -H "Content-Type: application/json" \
  -H "x-admin-key: changeme" \
  -d '{"regionId":"spawn", "autoclose": false}'
```

## POST /admin/video/pause
Pause at current position or at a specific `atMs`.

```sh
curl -X POST http://localhost:8080/admin/video/pause \
  -H "Content-Type: application/json" \
  -H "x-admin-key: changeme" \
  -d '{"token":"TOKEN_HERE", "atMs": 15000}'
```

## POST /admin/video/seek
Jump to `toMs` (ms from start). Optional: `startAtEpochMs`, `volume`, `muted`, `autoclose`.

```sh
curl -X POST http://localhost:8080/admin/video/seek \
  -H "Content-Type: application/json" \
  -H "x-admin-key: changeme" \
  -d '{"playerName":"Steve", "toMs": 45000}'
```

## POST /admin/video/close
Stop and clear video state for the target.

```sh
curl -X POST http://localhost:8080/admin/video/close \
  -H "Content-Type: application/json" \
  -H "x-admin-key: changeme" \
  -d '{"token":"TOKEN_HERE"}'
```

## POST /admin/video/play-instant
Convenience: init and immediately play.

Optional playback: `startAtEpochMs`, `startOffsetMs`, `muted`, `volume`, `sessionId`, `autoclose`.
Streaming fields `streamType`/`streamConfig` work here as well.

Optional visuals (same as `/admin/video/init`):
`backgroundImageUrl`, `backgroundImageTarget` (`"backdrop"` or `"modal"`),
`backgroundImagePosition` (or `backgroundImagePositionX`/`backgroundImagePositionY`),
`backgroundImageRepeat`, `backgroundImageSize`, `backgroundImageAttachment`,
`backdropBackgroundColor`, `modalBackgroundColor`.

```sh
curl -X POST http://localhost:8080/admin/video/play-instant \
  -H "Content-Type: application/json" \
  -H "x-admin-key: changeme" \
  -d '{
        "regionId": "spawn",
        "url": "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4",
        "muted": false,
        "volume": 1.0,
        "autoclose": true,
        "backgroundImageUrl": "https://example.com/poster.jpg",
        "backgroundImageTarget": "modal",
        "backgroundImageSize": "cover",
        "backdropBackgroundColor": "rgba(0,0,0,0.7)"
      }'
```

## POST /admin/video/preload
Ask clients to preload a `url` (optionally with `volume`, `muted`, `sessionId`). Streaming URLs are skipped because HLS/DASH sources stay attached to the player instance instead of being cached up front.

```sh
curl -X POST http://localhost:8080/admin/video/preload \
  -H "Content-Type: application/json" \
  -H "x-admin-key: changeme" \
  -d '{"token":"TOKEN_HERE", "url": "https://example.com/video.mp4"}'
```

## POST /admin/video/initialize-playlist
Initialize a playlist. Body: `items` array with `{ url, volume?, muted?, autoclose?, atMs?, streamType?, streamConfig? }`.

```sh
curl -X POST http://localhost:8080/admin/video/initialize-playlist \
  -H "Content-Type: application/json" \
  -H "x-admin-key: changeme" \
  -d '{
        "regionId": "spawn",
        "items": [
          { "url": "https://example.com/intro.mp4", "autoclose": true },
          { "url": "https://example.com/loop.mp4", "muted": false, "volume": 0.8 }
        ]
      }'
```

## GET /admin/video/connections
List connected clients and their current media state.

```sh
curl http://localhost:8080/admin/video/connections -H "x-admin-key: changeme"
```

## GET /admin/video/regions
List known regions, members, and active media.

```sh
curl http://localhost:8080/admin/video/regions -H "x-admin-key: changeme"
```

## GET /healthz
Simple health probe (no auth).

```sh
curl http://localhost:8080/healthz
```

---

## Minecraft Plugin WebSocket

Use WebSocket instead of REST to issue the same commands from your plugin.

- Endpoint: `ws://localhost:8080/ws/plugin?token=YOUR_PLUGIN_TOKEN`
- Token: must match `PLUGIN_TOKEN` in `.env`.

Commands: `SET_REGION`, `VIDEO_INIT`, `VIDEO_PLAY`, `VIDEO_PAUSE`, `VIDEO_SEEK`, `VIDEO_CLOSE`, `VIDEO_PLAY_INSTANT`, `VIDEO_PRELOAD`, `VIDEO_PLAYLIST_INIT` (alias: `VIDEO_INITIALIZE_PLAYLIST`). Include the same targeting fields as the REST examples.

Example message:

```json
{
  "id": "trigger-1",
  "type": "VIDEO_PLAY_INSTANT",
  "regionId": "spawn",
  "url": "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4",
  "autoclose": true
}
```

The server replies with `PLUGIN_RESPONSE` messages that echo the `id` (if provided) and include the HTTP status and body for the handled command.
