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
