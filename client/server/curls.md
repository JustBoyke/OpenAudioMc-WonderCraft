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
        "volume": 1.0
      }'
```

## Play
```sh
curl -X POST http://localhost:8080/admin/video/play \
  -H "Content-Type: application/json" \
  -H "x-admin-key: changeme" \
  -d '{"token":"TOKEN_HERE"}'
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
        "volume": 1.0
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
