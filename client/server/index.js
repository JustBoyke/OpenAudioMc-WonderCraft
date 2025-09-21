const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const http = require("http");
const path = require("path");
const { WebSocketServer } = require("ws");

// --- Config ---
const PORT = process.env.PORT || 8080;
// For a real deployment, terminate TLS at a proxy (nginx/traefik) and use wss:// upstream.

// --- App/HTTP ---
const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(helmet());
app.use(morgan("dev"));
app.use(express.json());

// In-memory stores (replace with Redis if you want multiple instances)
const clientsByToken = new Map(); // token -> { ws, playerId, lastSeen }
const tokenToPlayerId = new Map(); // optional helper if you map tokens => playerId
const activeMediaByToken = new Map(); // token -> media state snapshot
// In practice, you should authenticate and map token -> unique player identity.

// --- Token validation (STUB) ---
// Replace this with a call to your Minecraft plugin (e.g., via RCON, gRPC, HTTP, or a custom socket)
// The plugin should return: { ok: true, playerId: "uuid-or-name" } if token valid.
async function validateOAToken(token) {
  // TEMP: accept any non-empty token and fake a playerId
  if (!token || token.length < 3) return { ok: false };
  // TODO: implement real validation against MC plugin using ClientBaseAuthentication#getToken()
  const fakePlayerId = `player-${token.slice(0, 6)}`;
  return { ok: true, playerId: fakePlayerId };
}

const ADMIN_STATIC_DIR = path.join(__dirname, "admin");

// --- HTTP admin endpoints (you can protect with an admin secret) ---
function requireAdmin(req, res, next) {
  const hdr = req.get("x-admin-key");
  if (!process.env.ADMIN_KEY || hdr === process.env.ADMIN_KEY) return next();
  return res.status(401).json({ error: "unauthorized" });
}

app.use("/admin/static", express.static(ADMIN_STATIC_DIR));

app.get("/admin/dashboard", (_req, res) => {
  res.sendFile(path.join(ADMIN_STATIC_DIR, "dashboard.html"));
});

function snapshotPayload(payload) {
  return payload ? JSON.parse(JSON.stringify(payload)) : payload;
}

function ensureMediaRecord(token) {
  let record = activeMediaByToken.get(token);
  if (!record) {
    record = {
      init: null,
      state: { status: 'idle' },
      sessionId: null,
      lastCommand: null,
      lastUpdate: 0,
    };
    activeMediaByToken.set(token, record);
  }
  return record;
}

function pruneStaleMedia(ttl = 15 * 60 * 1000) {
  const cutoff = Date.now() - ttl;
  for (const [token, record] of activeMediaByToken) {
    if (!record?.lastUpdate || record.lastUpdate < cutoff) {
      activeMediaByToken.delete(token);
    }
  }
}

function registerMediaCommand(token, payload, context = {}) {
  if (!payload || typeof payload.type !== "string" || !payload.type.startsWith("VIDEO_")) return;

  if (payload.type === "VIDEO_CLOSE") {
    activeMediaByToken.delete(token);
    return;
  }

  const now = Date.now();
  const record = ensureMediaRecord(token);
  record.lastUpdate = now;
  if (context.sessionId != null) {
    record.sessionId = context.sessionId;
  }

  const cloned = snapshotPayload(payload);

  switch (payload.type) {
    case "VIDEO_INIT": {
      const startAt = (typeof cloned.startAtEpochMs === "number" && Number.isFinite(cloned.startAtEpochMs))
        ? cloned.startAtEpochMs
        : now;
      cloned.startAtEpochMs = startAt;
      cloned.autoclose = Boolean(cloned.autoclose);
      record.init = cloned;
      record.state = {
        status: "ready",
        startedAtEpochMs: startAt,
        pausedAtMs: null,
        muted: cloned.muted ?? false,
        volume: cloned.volume ?? 1.0,
        url: cloned.url,
        autoclose: Boolean(cloned.autoclose),
      };
      record.lastCommand = cloned;
      break;
    }
    case "VIDEO_PLAY": {
      const state = record.state || {};
      const atMs = Number.isFinite(cloned.atMs) ? cloned.atMs : Math.max(now - (state.startedAtEpochMs ?? now), 0);
      const startedAtEpochMs = Number.isFinite(cloned.startAtEpochMs)
        ? cloned.startAtEpochMs
        : state.startedAtEpochMs ?? record.init?.startAtEpochMs ?? (now - atMs);
      const autoclose = typeof cloned.autoclose === "boolean"
        ? cloned.autoclose
        : state.autoclose ?? record.init?.autoclose ?? false;
      cloned.autoclose = autoclose;
      record.state = {
        ...state,
        status: "playing",
        startedAtEpochMs,
        pausedAtMs: null,
        muted: cloned.muted ?? state.muted ?? false,
        volume: cloned.volume ?? state.volume ?? 1.0,
        url: state.url ?? record.init?.url ?? null,
        autoclose,
      };
      record.lastCommand = { ...cloned, atMs, startAtEpochMs, autoclose };
      break;
    }
    case "VIDEO_PAUSE": {
      const state = record.state || {};
      const pausedAtMs = Number.isFinite(cloned.atMs) ? cloned.atMs : Math.max(now - (state.startedAtEpochMs ?? now), 0);
      const autoclose = typeof cloned.autoclose === "boolean"
        ? cloned.autoclose
        : state.autoclose ?? record.init?.autoclose ?? false;
      cloned.autoclose = autoclose;
      record.state = {
        ...state,
        status: "paused",
        pausedAtMs,
        muted: cloned.muted ?? state.muted ?? false,
        volume: cloned.volume ?? state.volume ?? 1.0,
        autoclose,
      };
      record.lastCommand = { ...cloned, atMs: pausedAtMs, autoclose };
      break;
    }
    case "VIDEO_SEEK": {
      const state = record.state || {};
      const toMs = Number.isFinite(cloned.toMs) ? cloned.toMs : 0;
      const startedAtEpochMs = now - toMs;
      const autoclose = typeof cloned.autoclose === "boolean"
        ? cloned.autoclose
        : state.autoclose ?? record.init?.autoclose ?? false;
      cloned.autoclose = autoclose;
      record.state = {
        ...state,
        status: "playing",
        startedAtEpochMs,
        pausedAtMs: null,
        muted: cloned.muted ?? state.muted ?? false,
        volume: cloned.volume ?? state.volume ?? 1.0,
        autoclose,
      };
      record.lastCommand = { ...cloned, toMs, autoclose };
      break;
    }
    default:
      break;
  }

  pruneStaleMedia();
}

function sendToClientByToken(token, payload, context) {
  if (payload && payload.type && payload.type.startsWith("VIDEO_")) {
    registerMediaCommand(token, payload, context);
  }
  const c = clientsByToken.get(token);
  if (c && c.ws.readyState === 1) {
    c.ws.send(JSON.stringify(payload));
    return true;
  }
  return false;
}
function sendToClientByPlayer(playerId, payload, context) {
  const lowered = typeof playerId === "string" ? playerId.toLowerCase() : null;
  for (const [token, c] of clientsByToken) {
    if (!c || c.ws.readyState !== 1) continue;
    if (c.playerId && c.playerId === playerId) {
      if (payload && payload.type && payload.type.startsWith("VIDEO_")) {
        registerMediaCommand(token, payload, context);
      }
      c.ws.send(JSON.stringify(payload));
      return true;
    }
    if (lowered) {
      if (c.playerUuid && c.playerUuid.toLowerCase() === lowered) {
        if (payload && payload.type && payload.type.startsWith("VIDEO_")) {
          registerMediaCommand(token, payload, context);
        }
        c.ws.send(JSON.stringify(payload));
        return true;
      }
      if (c.playerName && c.playerName.toLowerCase() === lowered) {
        if (payload && payload.type && payload.type.startsWith("VIDEO_")) {
          registerMediaCommand(token, payload, context);
        }
        c.ws.send(JSON.stringify(payload));
        return true;
      }
    }
    if (token === playerId) {
      if (payload && payload.type && payload.type.startsWith("VIDEO_")) {
        registerMediaCommand(token, payload, context);
      }
      c.ws.send(JSON.stringify(payload));
      return true;
    }
  }
  return false;
}

function resolveTarget(body = {}) {
  const {
    token,
    playerId,
    playerUuid,
    playerName,
  } = body;

  if (token) return { kind: "token", value: token };

  const playerKey = playerId || playerUuid || playerName;
  if (playerKey) return { kind: "player", value: playerKey };

  return null;
}

function updateClientIdentity(token, patch = {}) {
  const info = clientsByToken.get(token);
  if (!info) return;

  if (typeof patch.playerName === "string" && patch.playerName) {
    info.playerName = patch.playerName;
  }
  if (typeof patch.playerUuid === "string" && patch.playerUuid) {
    info.playerUuid = patch.playerUuid;
  }
  if (typeof patch.publicServerKey === "string" && patch.publicServerKey) {
    info.publicServerKey = patch.publicServerKey;
  }
  if (patch.scope != null) {
    info.scope = patch.scope;
  }

  const derivedId = patch.playerId || patch.playerUuid || patch.playerName;
  if (typeof derivedId === "string" && derivedId) {
    info.playerId = derivedId;
    tokenToPlayerId.set(token, derivedId);
  }

  info.lastSeen = Date.now();
}

// Example: init a video
app.post("/admin/video/init", requireAdmin, (req, res) => {
  const body = req.body || {};
  const target = resolveTarget(body);
  if (!target) {
    return res.status(400).json({ error: "token, playerId, playerUuid, or playerName required" });
  }

  const {
    url,
    startAtEpochMs,
    muted = false,
    volume = 1.0,
    sessionId = null,
  } = body;

  const payload = {
    type: "VIDEO_INIT",
    url,
    startAtEpochMs,
    muted,
    volume,
    autoclose: Boolean(body.autoclose),
  };
  const ok = target.kind === "token"
    ? sendToClientByToken(target.value, payload, { sessionId })
    : sendToClientByPlayer(target.value, payload, { sessionId });
  return res.json({ delivered: ok });
});

// Example: play/pause/seek/close
app.post("/admin/video/play", requireAdmin, (req, res) => {
  const body = req.body || {};
  const target = resolveTarget(body);
  if (!target) {
    return res.status(400).json({ error: "token, playerId, playerUuid, or playerName required" });
  }

  const payload = { type: "VIDEO_PLAY", serverEpochMs: Date.now() };
  if (Number.isFinite(body.atMs)) payload.atMs = body.atMs;
  if (typeof body.volume === "number") payload.volume = body.volume;
  if (typeof body.muted === "boolean") payload.muted = body.muted;
  if (typeof body.autoclose === "boolean") payload.autoclose = body.autoclose;
  const ok = target.kind === "token"
    ? sendToClientByToken(target.value, payload)
    : sendToClientByPlayer(target.value, payload);
  return res.json({ delivered: ok });
});
app.post("/admin/video/pause", requireAdmin, (req, res) => {
  const body = req.body || {};
  const target = resolveTarget(body);
  if (!target) {
    return res.status(400).json({ error: "token, playerId, playerUuid, or playerName required" });
  }

  const { atMs } = body;
  const payload = { type: "VIDEO_PAUSE", atMs };
  const ok = target.kind === "token"
    ? sendToClientByToken(target.value, payload)
    : sendToClientByPlayer(target.value, payload);
  return res.json({ delivered: ok });
});
app.post("/admin/video/seek", requireAdmin, (req, res) => {
  const body = req.body || {};
  const target = resolveTarget(body);
  if (!target) {
    return res.status(400).json({ error: "token, playerId, playerUuid, or playerName required" });
  }

  const { toMs } = body;
  const payload = { type: "VIDEO_SEEK", toMs };
  const ok = target.kind === "token"
    ? sendToClientByToken(target.value, payload)
    : sendToClientByPlayer(target.value, payload);
  return res.json({ delivered: ok });
});
app.post("/admin/video/close", requireAdmin, (req, res) => {
  const body = req.body || {};
  const target = resolveTarget(body);
  if (!target) {
    return res.status(400).json({ error: "token, playerId, playerUuid, or playerName required" });
  }

  const payload = { type: "VIDEO_CLOSE" };
  const ok = target.kind === "token"
    ? sendToClientByToken(target.value, payload)
    : sendToClientByPlayer(target.value, payload);
  return res.json({ delivered: ok });
});

app.post("/admin/video/play-instant", requireAdmin, (req, res) => {
  const body = req.body || {};
  const target = resolveTarget(body);
  if (!target) {
    return res.status(400).json({ error: "token, playerId, playerUuid, or playerName required" });
  }

  const {
    url,
    startAtEpochMs,
    muted = false,
    volume = 1.0,
    startOffsetMs = 0,
    sessionId = null,
  } = body;

  if (!url) {
    return res.status(400).json({ error: "url required" });
  }

  const baseStart = typeof startAtEpochMs === "number" && Number.isFinite(startAtEpochMs)
    ? startAtEpochMs
    : Date.now();
  const computedStart = baseStart + (Number.isFinite(startOffsetMs) ? startOffsetMs : 0);

  const initPayload = {
    type: "VIDEO_INIT",
    url,
    startAtEpochMs: computedStart,
    muted,
    volume,
    autoclose: Boolean(body.autoclose),
  };

  const deliverInit = target.kind === "token"
    ? sendToClientByToken(target.value, initPayload, { sessionId })
    : sendToClientByPlayer(target.value, initPayload, { sessionId });

  if (!deliverInit) {
    return res.json({ delivered: false, stage: "init" });
  }

  const playPayload = {
    type: "VIDEO_PLAY",
    serverEpochMs: Date.now(),
    atMs: 0,
    muted,
    volume,
  };
  if (typeof body.autoclose === "boolean") {
    playPayload.autoclose = body.autoclose;
  }

  const deliverPlay = target.kind === "token"
    ? sendToClientByToken(target.value, playPayload)
    : sendToClientByPlayer(target.value, playPayload);

  return res.json({ delivered: deliverInit && deliverPlay, stage: deliverPlay ? "play" : "init" });
});

app.get("/admin/video/connections", requireAdmin, (_req, res) => {
  const now = Date.now();
  const connections = Array.from(clientsByToken.entries()).map(([token, info]) => ({
    token,
    playerId: info.playerId,
    playerUuid: info.playerUuid,
    playerName: info.playerName,
    publicServerKey: info.publicServerKey,
    scope: info.scope,
    connectedAt: info.connectedAt,
    lastSeen: info.lastSeen,
    readyState: info.ws?.readyState,
    idleMs: info.lastSeen ? now - info.lastSeen : null,
    activeMedia: (() => {
      const media = activeMediaByToken.get(token);
      if (!media || !media.state || media.state.status === 'idle') return null;
      return {
        sessionId: media.sessionId || null,
        init: media.init || null,
        state: media.state,
        lastUpdate: media.lastUpdate,
      };
    })(),
  }));
  return res.json({ ok: true, connections });
});

// Simple health
app.get("/healthz", (req, res) => res.json({ ok: true }));

const server = http.createServer(app);

// --- WebSocket server ---
const wss = new WebSocketServer({ noServer: true });

// Optional: keep-alive ping from server
function heartbeat(ws) {
  if (ws.readyState === 1) ws.send(JSON.stringify({ type: "PING", t: Date.now() }));
}

wss.on("connection", async (ws, request) => {
  const params = new URLSearchParams(request.url.split("?")[1] || "");
  const token = params.get("token");
  const hintedPlayerUuid = params.get("playerUuid");
  const hintedPlayerName = params.get("playerName");

  // Validate token
  const result = await validateOAToken(token);
  if (!result.ok) {
    ws.close(1008, "invalid token");
    return;
  }

  let { playerId } = result;
  if (!playerId) {
    playerId = hintedPlayerUuid || hintedPlayerName || `player-${token.slice(0, 6)}`;
  }

  clientsByToken.set(token, {
    ws,
    playerId,
    playerUuid: hintedPlayerUuid || null,
    playerName: hintedPlayerName || null,
    publicServerKey: null,
    scope: null,
    connectedAt: Date.now(),
    lastSeen: Date.now(),
  });
  tokenToPlayerId.set(token, playerId);

  // greet and start ping loop
  ws.send(JSON.stringify({
    type: "HELLO_ACK",
    serverEpochMs: Date.now(),
    playerId,
    playerName: hintedPlayerName || null,
    playerUuid: hintedPlayerUuid || null,
  }));

  const pendingMedia = activeMediaByToken.get(token);
  if (pendingMedia?.init) {
    const initPayload = { ...pendingMedia.init, resume: true };
    ws.send(JSON.stringify(initPayload));

    const state = pendingMedia.state || {};
    const now = Date.now();
    if (state.status === 'playing') {
      const positionMs = Math.max(now - (state.startedAtEpochMs ?? now), 0);
      ws.send(JSON.stringify({
        type: "VIDEO_PLAY",
        serverEpochMs: now,
        atMs: positionMs,
        volume: state.volume,
        muted: state.muted,
        autoclose: state.autoclose ?? pendingMedia.init?.autoclose ?? false,
      }));
    } else if (state.status === 'paused') {
      ws.send(JSON.stringify({
        type: "VIDEO_PAUSE",
        atMs: state.pausedAtMs ?? 0,
        volume: state.volume,
        muted: state.muted,
        autoclose: state.autoclose ?? pendingMedia.init?.autoclose ?? false,
      }));
    }
  }

  const pingIv = setInterval(() => heartbeat(ws), 5000);

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      const clientInfo = clientsByToken.get(token);
      if (clientInfo) {
        clientInfo.lastSeen = Date.now();
      }

      switch (msg.type) {
        case "PONG":
          // optional: compute rtt/skew if you implement round-trip
          break;
        case "VIDEO_STATE":
          // optional: log or store state
          // console.log("STATE", playerId, msg);
          break;
        case "HELLO":
          updateClientIdentity(token, msg);
          break;
        case "IDENTITY_UPDATE":
          updateClientIdentity(token, msg);
          break;
        default:
          break;
      }
    } catch { /* ignore */ }
  });

  ws.on("close", () => {
    clearInterval(pingIv);
    // Cleanup
    clientsByToken.delete(token);
    tokenToPlayerId.delete(token);
  });
});

// Upgrade HTTP -> WS
server.on("upgrade", (req, socket, head) => {
  if (req.url.startsWith("/ws/video")) {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
