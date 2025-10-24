ATC WebSocket Events and Integration
====================================

This doc describes all Attraction Control (ATC) events used between the web control panel (client), the backend server, and the Minecraft plugin. It also lists related admin endpoints and the on-disk attraction format.

Overview
--------
- The ATC web panel connects to the standard client WebSocket but with `role=atc`.
- On first connect, the panel announces itself; the server replies with an initial snapshot seeded from a per‑attraction JSON file.
- User actions in the web panel are forwarded to the plugin; the plugin replies with the authoritative state update which is saved to disk and broadcast back to the web panel(s).

Endpoints
---------
- Client/ATC WebSocket: `ws://<host>/ws/video?token=...&role=atc`
  - Production via proxy: `wss://<host>/api/ws/video?token=...&role=atc`
  - Optional: `playerUuid` or `playerName` in query
- Plugin WebSocket: `ws://<host>/ws/plugin?token=PLUGIN_TOKEN`
  - Production: `wss://<host>/api/ws/plugin?token=PLUGIN_TOKEN`

State Keys and Semantics
------------------------
- Keys: `atc_power`, `atc_status`, `atc_station`, `atc_gates`, `atc_beugels`, `atc_emercency` (spelling is intentional)
- Values: `0` = false/inactive, `1` = true/active, `2` = disabled/not applicable
- UI semantics:
  - Disabled gates/beugels are treated as “satisfied” for readiness; their badges show green and they do not block dispatch.
  - If either gates or beugels is disabled, the dispatch button is disabled entirely (not needed for that attraction).
  - Status (open/closed) is independent of power; the status can be open when power is off.
  - All operator buttons have a 3s cooldown to prevent spamming.
  - Emergency locks the panel until cleared.

Message Flow (Client ↔ Server)
------------------------------
Client → Server (ATC web panel):
- atc_firstConnection
  ```json
  { "type":"atc_firstConnection", "session_id":"...", "playername":"...", "attraction_id":"..." }
  ```
- atc_update (user action)
  ```json
  { "type":"atc_update", "name":"atc_power|atc_status|atc_station|atc_gates|atc_beugels|atc_emercency", "value":0|1|2, "session_id":"...", "playername":"...", "attraction_id":"..." }
  ```

Server → Client (ATC web panel):
- atc_init (initial snapshot)
  ```json
  {
    "type":"atc_init",
    "session_id":"...",
    "playername":"...",
    "attraction_id":"...",
    "atc_power":0|1|2,
    "atc_status":0|1|2,
    "atc_station":0|1|2,
    "atc_gates":0|1|2,
    "atc_beugels":0|1|2,
    "atc_emercency":0|1|2
  }
  ```
- atc_serverUpdate (authoritative update)
  ```json
  { "type":"atc_serverUpdate", "name":"atc_gates", "value":0|1|2, "session_id":"...", "playername":"...", "attraction_id":"..." }
  ```
  - May also be sent as a partial object with multiple keys in special cases; the client supports both forms.

Message Flow (Server ↔ Plugin)
------------------------------
Server → Plugin (forwarded web action):
- ATC_CLIENT_UPDATE
  ```json
  { "type":"ATC_CLIENT_UPDATE", "attraction_id":"...", "name":"atc_gates", "value":0|1|2, "session_id":"...", "playername":"..." }
  ```
  - Sent when the web panel emits `atc_update`. The plugin should perform the action and then send back the authoritative update below.

Plugin → Server (authoritative update):
- ATC_SERVER_UPDATE
  ```json
  { "type":"ATC_SERVER_UPDATE", "attraction_id":"...", "name":"atc_gates", "value":0|1|2, "session_id":"...", "playername":"..." }
  ```
  - The server updates in‑memory state, persists to disk, and broadcasts `atc_serverUpdate` to connected ATC panels for the same attraction.

Admin HTTP (for operators/tools)
--------------------------------
- POST `/admin/atc/createAttraction` (requires `x-admin-key`)
  - Body: `{ attraction_id, attraction_name, atc_power?, atc_status?, atc_station?, atc_gates?, atc_beugels?, atc_emercency? }`
  - Writes `server/attractions/[attraction_id].json`, defaulting any unspecified state to `2` (disabled). Also seeds in‑memory state.
- POST `/admin/atc/show` (requires `x-admin-key`)
  - Targets a player or region and instructs the client to render the “Open webcontrols” bubble.
  - Body includes: one target (`token|playerId|playerUuid|playerName|regionId`) and `attraction_name` (required) plus optional `attraction_id`, `playername`, `player_uuid`, `session_id`.
- POST `/admin/atc/hide` (requires `x-admin-key`)
  - Hides the bubble and closes the popup for a target player/region.

Attraction Persistence (server/attractions/*.json)
-------------------------------------------------
- Path: `server/attractions/[attraction_id].json`
- Format:
  ```json
  {
    "attraction_id": "fata",
    "attraction_name": "Fata Morgana",
    "atc_power": 2,
    "atc_status": 2,
    "atc_station": 2,
    "atc_gates": 2,
    "atc_beugels": 2,
    "atc_emercency": 2,
    "updatedAt": 1710000000000
  }
  ```
- Usage:
  - On an ATC panel’s first connection (`atc_firstConnection`), the server loads the file (if present) and seeds the `atc_init` snapshot from it.
  - When the plugin sends `ATC_SERVER_UPDATE`, the server merges the change, writes the file, and notifies ATC panels via `atc_serverUpdate`.
  - Web panels never write to this file; they only read indirectly via `atc_init`/`atc_serverUpdate`.

Typical Sequence
----------------
1) Admin sends `/admin/atc/show` → client shows “Open webcontrols” button.
2) Player clicks → popup opens `/atc-controls.html` and connects to WS with `role=atc`.
3) Popup sends `atc_firstConnection` with `{ session_id, playername, attraction_id }`.
4) Server responds `atc_init` (from file + memory).
5) Operator clicks a control → popup sends `atc_update`.
6) Server forwards as `ATC_CLIENT_UPDATE` to plugin.
7) Plugin performs the action and sends `ATC_SERVER_UPDATE`.
8) Server saves the new state to disk and broadcasts `atc_serverUpdate` to the popup.

Notes
-----
- The UI treats disabled controls (value `2`) as non-blocking for readiness. Dispatch is disabled if either gates or beugels is disabled.
- Status is independent from power and can be open while power is off.
- All operator actions in the UI are rate-limited (3s cooldown) to prevent spamming.

