# Video Control cURL Cheatsheet

All commands target the local development server (`http://localhost:8080`).
Every request requires the admin header (`x-admin-key: changeme`).

Replace the `TOKEN_HERE` or `PLAYER_ID_HERE` placeholders with the values you want to target. If you are testing with the client we wired up, you can grab the current token from DevTools via `window.__oaVideoExtensionDebug.wsUrl()`.

---

## Initialise a Video
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
        "autoclose": false
      }'
```

## Play
```sh
curl -X POST http://localhost:8080/admin/video/play \
  -H "Content-Type: application/json" \
  -H "x-admin-key: changeme" \
  -d '{"token":"TOKEN_HERE", "autoclose": false}'
```

## Pause
```sh
curl -X POST http://localhost:8080/admin/video/pause \
  -H "Content-Type: application/json" \
  -H "x-admin-key: changeme" \
  -d '{"token":"TOKEN_HERE", "atMs": 15000}'
```

## Seek
```sh
curl -X POST http://localhost:8080/admin/video/seek \
  -H "Content-Type: application/json" \
  -H "x-admin-key: changeme" \
  -d '{"token":"TOKEN_HERE", "toMs": 45000}'
```

## Play Instant (init + play)
```sh
curl -X POST http://localhost:8080/admin/video/play-instant \
  -H "Content-Type: application/json" \
  -H "x-admin-key: changeme" \
  -d '{
        "token": "TOKEN_HERE",
        "url": "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4",
        "muted": false,
        "volume": 1.0,
        "sessionId": "area-lobby",
        "autoclose": true
      }'
```

## Close
```sh
curl -X POST http://localhost:8080/admin/video/close \
  -H "Content-Type: application/json" \
  -H "x-admin-key: changeme" \
  -d '{"token":"TOKEN_HERE"}'
```

## List Connections
```sh
curl http://localhost:8080/admin/video/connections \
  -H "x-admin-key: changeme"
```

### Optional: Target by Player ID
All endpoints also accept `playerId` instead of `token`:
```sh
curl -X POST http://localhost:8080/admin/video/play \
  -H "Content-Type: application/json" \
  -H "x-admin-key: changeme" \
  -d '{"playerId":"PLAYER_ID_HERE"}'
```

---

## Minecraft Plugin WebSocket

The backend also exposes a WebSocket endpoint for the Minecraft plugin so it can push the same JSON payloads without going
through the admin REST API.

* **Endpoint:** `ws://localhost:8080/ws/plugin?token=YOUR_PLUGIN_TOKEN`
* **Token:** matches the `PLUGIN_TOKEN` value in your `.env` (defaults to `changeme`). Connections without the correct token are
  rejected.

When the socket opens the server sends a `PLUGIN_HELLO` payload that lists currently connected browser clients. Afterwards the
plugin can send the same `type` values that the HTTP routes accept (`SET_REGION`, `VIDEO_INIT`, `VIDEO_PLAY`, `VIDEO_PAUSE`,
`VIDEO_SEEK`, `VIDEO_CLOSE`, `VIDEO_PLAY_INSTANT`, `VIDEO_PRELOAD`, `VIDEO_PLAYLIST_INIT`). Include any targeting fields
(`token`, `playerId`, `playerUuid`, `playerName`, or `regionId`) in the payload just like you would in the cURL requests.

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

The server replies with `PLUGIN_RESPONSE` messages that echo the `id` (if provided) and include the HTTP status and body for
the handled command.
