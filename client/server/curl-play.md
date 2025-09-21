# Quick Reference – Play Video Via Different Identifiers

All examples hit the local backend (`http://localhost:8080`). Replace the placeholder values with the desired target. **Only provide one identifier per request** – the server will use whichever field you send (`token`, `playerUuid`, `playerId`, or `playerName`).

| Identifier | Field | Example Value |
|------------|-------|---------------|
| Token | `token` | `565` |
| Player UUID | `playerUuid` | `a7b49cc2-2bdb-4e4e-aa45-95daadcc2369` |
| Player ID (custom) | `playerId` | `player-565` |
| Player Name | `playerName` | `boykev` |

Use the same payload structure for each call—swap the identifier field as needed.

```sh
# Play using token
curl -X POST http://localhost:8080/admin/video/play \
  -H "Content-Type: application/json" \
  -H "x-admin-key: changeme" \
  -d '{"token":"565"}'

# Play using player UUID
curl -X POST http://localhost:8080/admin/video/play \
  -H "Content-Type: application/json" \
  -H "x-admin-key: changeme" \
  -d '{"playerUuid":"a7b49cc2-2bdb-4e4e-aa45-95daadcc2369"}'

# Play using playerId (custom identifier your backend assigns)
curl -X POST http://localhost:8080/admin/video/play \
  -H "Content-Type: application/json" \
  -H "x-admin-key: changeme" \
  -d '{"playerId":"player-565"}'

# Play using player name
curl -X POST http://localhost:8080/admin/video/play \
  -H "Content-Type: application/json" \
  -H "x-admin-key: changeme" \
  -d '{"playerName":"boykev"}'
```

To trigger other actions (pause, seek, close, play-instant) simply replace the URL while keeping a single identifier field:

```sh
# Pause example (replace token with any other identifier field)
curl -X POST http://localhost:8080/admin/video/pause \
  -H "Content-Type: application/json" \
  -H "x-admin-key: changeme" \
  -d '{"token":"565", "atMs": 12000}'
```

---

## Minecraft Plugin WebSocket (Development)

If you are working on the Minecraft plugin you can connect it directly to the backend without issuing cURL requests:

* **Endpoint:** `ws://localhost:8080/ws/plugin?token=YOUR_PLUGIN_TOKEN`
* **Token:** supply the same value you configured for `PLUGIN_TOKEN` in `.env` (default `changeme`).

Send JSON payloads with the same `type` names and fields as the HTTP helpers. Example:

```json
{
  "id": "region-sync",
  "type": "SET_REGION",
  "playerUuid": "a7b49cc2-2bdb-4e4e-aa45-95daadcc2369",
  "regionId": "spawn"
}
```

The server answers each command with a `PLUGIN_RESPONSE` message that includes the HTTP status and body you would normally get
back from the REST API.

