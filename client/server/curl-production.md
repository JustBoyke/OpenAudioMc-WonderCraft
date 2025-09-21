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
        "autoclose": true
      }'
```

## POST /admin/video/play
```sh
curl -X POST https://audio.wondercraftmc.nl/api/admin/video/play \
  -H "Content-Type: application/json" -H "x-admin-key: changeme" \
  -d '{"token":"TOKEN_HERE"}'
```

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
```sh
curl -X POST https://audio.wondercraftmc.nl/api/admin/video/play-instant \
  -H "Content-Type: application/json" -H "x-admin-key: changeme" \
  -d '{"regionId":"spawn","url":"https://example.com/video.mp4","autoclose":true}'
```

## POST /admin/video/preload
```sh
curl -X POST https://audio.wondercraftmc.nl/api/admin/video/preload \
  -H "Content-Type: application/json" -H "x-admin-key: changeme" \
  -d '{"token":"TOKEN_HERE","url":"https://example.com/video.mp4"}'
```

## POST /admin/video/initialize-playlist
```sh
curl -X POST https://audio.wondercraftmc.nl/api/admin/video/initialize-playlist \
  -H "Content-Type: application/json" -H "x-admin-key: changeme" \
  -d '{"regionId":"spawn","items":[{"url":"https://example.com/intro.mp4"},{"url":"https://example.com/loop.mp4","volume":0.8}]}'
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
