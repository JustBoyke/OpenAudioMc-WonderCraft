# Video Control cURL Cheatsheet (Production)

All commands target the production backend (`https://audio.boykevanvugt.nl/api`).
Every request requires the admin header (`x-admin-key: changeme`).

Replace the `TOKEN_HERE` / `PLAYER_ID_HERE` placeholders with the identifiers you want to target. The same payload rules apply as in development—send only one identifier per call.

---

## Initialise a Video
```sh
curl -X POST https://audio.boykevanvugt.nl/api/admin/video/init \
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
curl -X POST https://audio.boykevanvugt.nl/api/admin/video/play \
  -H "Content-Type: application/json" \
  -H "x-admin-key: changeme" \
  -d '{"token":"TOKEN_HERE", "autoclose": false}'
```

## Pause
```sh
curl -X POST https://audio.boykevanvugt.nl/api/admin/video/pause \
  -H "Content-Type: application/json" \
  -H "x-admin-key: changeme" \
  -d '{"token":"TOKEN_HERE", "atMs": 15000}'
```

## Seek
```sh
curl -X POST https://audio.boykevanvugt.nl/api/admin/video/seek \
  -H "Content-Type: application/json" \
  -H "x-admin-key: changeme" \
  -d '{"token":"TOKEN_HERE", "toMs": 45000}'
```

## Play Instant (init + play)
```sh
curl -X POST https://audio.boykevanvugt.nl/api/admin/video/play-instant \
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
curl -X POST https://audio.boykevanvugt.nl/api/admin/video/close \
  -H "Content-Type: application/json" \
  -H "x-admin-key: changeme" \
  -d '{"token":"TOKEN_HERE"}'
```

## List Connections
```sh
curl https://audio.boykevanvugt.nl/api/admin/video/connections \
  -H "x-admin-key: changeme"
```

### Optional: Target by Player ID
All endpoints also accept `playerId` instead of `token`:
```sh
curl -X POST https://audio.boykevanvugt.nl/api/admin/video/play \
  -H "Content-Type: application/json" \
  -H "x-admin-key: changeme" \
  -d '{"playerId":"PLAYER_ID_HERE"}'
```

---

## Minecraft Plugin WebSocket (Production)

For production servers the plugin connects to the API host via WebSocket:

* **Endpoint:** `wss://audio.boykevanvugt.nl/api/ws/plugin?token=YOUR_PLUGIN_TOKEN`
* **Token:** use the `PLUGIN_TOKEN` configured on the server (matches the `.env` value). Connections with an incorrect token are
  closed immediately.

Once connected you can send the same JSON payloads as the REST helpers (`SET_REGION`, `VIDEO_INIT`, `VIDEO_PLAY`, `VIDEO_PAUSE`,
`VIDEO_SEEK`, `VIDEO_CLOSE`, `VIDEO_PLAY_INSTANT`, `VIDEO_PRELOAD`, `VIDEO_PLAYLIST_INIT`). The server responds with
`PLUGIN_RESPONSE` messages mirroring the REST status/body.
