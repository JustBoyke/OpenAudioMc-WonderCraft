/* eslint-disable object-curly-newline */
/* eslint-disable no-nested-ternary */
/* eslint-disable no-restricted-syntax */
/* eslint-disable quotes */
const http = require("http");
const path = require("path");
const express = require("express");
const fs = require("fs");
const fsp = require("fs/promises");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const { WebSocketServer } = require("ws");

// Load environment variables from .env file if present
require("dotenv").config();

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
const atcSocketsByToken = new Map(); // token -> Set<ws> (secondary popup connections)
// ATC state and connection tracking
const atcStateByAttraction = new Map(); // attraction_id -> state snapshot
const atcSocketsByAttraction = new Map(); // attraction_id -> Set<ws>
const atcMetaByWs = new WeakMap(); // ws -> { attraction_id, session_id, playername, token }

function getOrInitAtcState(attractionId) {
  if (!attractionId) return null;
  let s = atcStateByAttraction.get(attractionId);
  if (!s) {
    s = {
      atc_power: 0,
      atc_status: 0,
      atc_station: 0,
      atc_gates: 0,
      atc_beugels: 0,
      atc_emercency: 0, // spelling aligned with client
      updatedAt: Date.now(),
    };
    atcStateByAttraction.set(attractionId, s);
  }
  return s;
}

function attachAtcSocket(attractionId, ws) {
  if (!attractionId || !ws) return;
  let set = atcSocketsByAttraction.get(attractionId);
  if (!set) { set = new Set(); atcSocketsByAttraction.set(attractionId, set); }
  set.add(ws);
}

function detachAtcSocket(ws) {
  if (!ws) return;
  const meta = atcMetaByWs.get(ws);
  if (meta && meta.attraction_id) {
    const set = atcSocketsByAttraction.get(meta.attraction_id);
    if (set) {
      set.delete(ws);
      if (set.size === 0) atcSocketsByAttraction.delete(meta.attraction_id);
    }
  }
  atcMetaByWs.delete(ws);
}

function broadcastAtc(attractionId, payload, { except } = {}) {
  const set = atcSocketsByAttraction.get(attractionId);
  if (!set || !payload) return 0;
  let count = 0;
  for (const sock of Array.from(set)) {
    if (except && sock === except) continue;
    if (sock.readyState !== 1) continue;
    try { sock.send(JSON.stringify(payload)); count += 1; } catch { /* ignore */ }
  }
  return count;
}
const tokenToPlayerId = new Map(); // optional helper if you map tokens => playerId
const activeMediaByToken = new Map(); // token -> media state snapshot
const activeMediaByRegion = new Map(); // regionId -> media state snapshot
const tokensByRegion = new Map(); // regionId -> Set<token>
const regionByToken = new Map(); // token -> regionId
const regionByPlayerKey = new Map(); // canonical player key -> regionId
const regionDisplayNames = new Map(); // regionId -> last seen display name
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
const ATTRACTIONS_DIR = path.join(__dirname, "attractions");

function ensureDirSync(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
}

ensureDirSync(ATTRACTIONS_DIR);

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

function includeOptionalBackgroundFields(source, target) {
  if (!source || typeof source !== "object" || !target || typeof target !== "object") return;
  const optionalKeys = [
    "backgroundImageUrl",
    "backgroundImageTarget",
    "backgroundImagePosition",
    "backgroundImagePositionX",
    "backgroundImagePositionY",
    "backgroundImageRepeat",
    "backgroundImageSize",
    "backgroundImageAttachment",
    "backdropBackgroundColor",
    "modalBackgroundColor",
    "backdropColor",
    "modalColor",
  ];

  for (const key of optionalKeys) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) {
      target[key] = value;
    }
  }
}

function ensureMediaRecord(store, key) {
  let record = store.get(key);
  if (!record) {
    record = {
      init: null,
      state: { status: 'idle' },
      sessionId: null,
      lastCommand: null,
      lastUpdate: 0,
      preload: null,
      playlist: null,
    };
    store.set(key, record);
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
  for (const [regionId, record] of activeMediaByRegion) {
    if (!record?.lastUpdate || record.lastUpdate < cutoff) {
      activeMediaByRegion.delete(regionId);
    }
  }
}

function registerMediaCommand(store, key, payload, context = {}) {
  if (!payload || typeof payload.type !== "string" || !payload.type.startsWith("VIDEO_")) return;

  if (payload.type === "VIDEO_CLOSE") {
    store.delete(key);
    return;
  }

  const now = Date.now();
  const record = ensureMediaRecord(store, key);
  record.lastUpdate = now;
  if (context.sessionId != null) {
    record.sessionId = context.sessionId;
  }

  const cloned = snapshotPayload(payload);

  switch (payload.type) {
    case "VIDEO_INIT": {
      record.playlist = null;
      record.preload = null;
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
        streamType: cloned.streamType || null,
        streamConfig: cloned.streamConfig || null,
      };
      record.lastCommand = cloned;
      break;
    }
    case "VIDEO_PRELOAD": {
      record.preload = {
        url: cloned.url || null,
        requestedAt: now,
      };
      record.lastCommand = cloned;
      break;
    }
    case "VIDEO_PLAYLIST_INIT": {
      const items = Array.isArray(cloned.items)
        ? cloned.items.filter((item) => item && typeof item.url === 'string')
        : [];
      record.playlist = {
        items,
        createdAt: now,
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
      if (cloned.streamType != null) record.state.streamType = cloned.streamType;
      if (cloned.streamConfig != null) record.state.streamConfig = cloned.streamConfig;
      record.lastCommand = { ...cloned, atMs, startAtEpochMs: startedAtEpochMs, autoclose };
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
      if (cloned.streamType != null) record.state.streamType = cloned.streamType;
      if (cloned.streamConfig != null) record.state.streamConfig = cloned.streamConfig;
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
      if (cloned.streamType != null) record.state.streamType = cloned.streamType;
      if (cloned.streamConfig != null) record.state.streamConfig = cloned.streamConfig;
      record.lastCommand = { ...cloned, toMs, autoclose };
      break;
    }
    default:
      record.lastCommand = cloned;
      break;
  }

  pruneStaleMedia();

  // Broadcast updates to admin dashboards
  try {
    broadcastAdminConnections();
    broadcastAdminRegions();
  } catch { /* ignore */ }
}

function rememberRegionDisplayName(regionId, displayName) {
  if (!regionId || typeof displayName !== "string") return;
  const trimmed = displayName.trim();
  if (!trimmed) return;
  regionDisplayNames.set(regionId, trimmed);
}

function getRegionDisplayName(regionId) {
  if (!regionId) return null;
  return regionDisplayNames.get(regionId) || regionId;
}

function normalizeRegionId(value, options = {}) {
  if (value == null) return null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const canonical = trimmed.toLowerCase();
  if (options.rememberDisplay !== false) {
    const display = typeof options.displayName === "string" && options.displayName.trim()
      ? options.displayName.trim()
      : trimmed;
    rememberRegionDisplayName(canonical, display);
  }
  return canonical;
}

function canonicalizePlayerKey(kind, value) {
  if (!kind || typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return `${kind}:${trimmed.toLowerCase()}`;
}

function collectPlayerKeysFromInfo(info = {}) {
  const keys = new Set();
  if (info.playerId) keys.add(canonicalizePlayerKey("id", info.playerId));
  if (info.playerUuid) keys.add(canonicalizePlayerKey("uuid", info.playerUuid));
  if (info.playerName) keys.add(canonicalizePlayerKey("name", info.playerName));
  return Array.from(keys).filter(Boolean);
}

function collectPlayerKeysFromBody(body = {}) {
  const keys = new Set();
  if (typeof body.playerId === "string" && body.playerId.trim()) {
    keys.add(canonicalizePlayerKey("id", body.playerId));
  }
  if (typeof body.playerUuid === "string" && body.playerUuid.trim()) {
    keys.add(canonicalizePlayerKey("uuid", body.playerUuid));
  }
  if (typeof body.playerName === "string" && body.playerName.trim()) {
    keys.add(canonicalizePlayerKey("name", body.playerName));
  }
  return Array.from(keys).filter(Boolean);
}

function assignRegionForPlayerKey(key, regionId) {
  if (!key) return;
  if (!regionId) {
    regionByPlayerKey.delete(key);
  } else {
    regionByPlayerKey.set(key, regionId);
  }
}

function assignRegionForPlayerKeys(keys, regionId) {
  if (!Array.isArray(keys)) return;
  for (const key of keys) {
    assignRegionForPlayerKey(key, regionId);
  }
}

function assignRegionForToken(token, regionId, options = {}) {
  const { alreadyCanonical = false, displayName = null } = options;
  let canonical = null;
  if (alreadyCanonical) {
    if (typeof regionId === "string" && regionId.trim()) {
      canonical = regionId;
    }
  } else {
    canonical = normalizeRegionId(regionId);
  }

  if (canonical && displayName) {
    rememberRegionDisplayName(canonical, displayName);
  }

  const previous = regionByToken.get(token) || null;
  if (previous === canonical) {
    const info = clientsByToken.get(token);
    if (info) {
      info.region = canonical || null;
      info.regionDisplayName = canonical ? getRegionDisplayName(canonical) : null;
    }
    return { changed: false, previous, regionId: canonical };
  }

  if (previous) {
    const set = tokensByRegion.get(previous);
    if (set) {
      set.delete(token);
      if (set.size === 0) {
        tokensByRegion.delete(previous);
      }
    }
  }

  if (!canonical) {
    regionByToken.delete(token);
  } else {
    let set = tokensByRegion.get(canonical);
    if (!set) {
      set = new Set();
      tokensByRegion.set(canonical, set);
    }
    set.add(token);
    regionByToken.set(token, canonical);
  }

  const info = clientsByToken.get(token);
  if (info) {
    info.region = canonical || null;
    info.regionDisplayName = canonical ? getRegionDisplayName(canonical) : null;
  }

  // Broadcast region membership + connections update
  try {
    broadcastAdminConnections();
    broadcastAdminRegions();
  } catch { /* ignore */ }

  return { changed: true, previous, regionId: canonical };
}

function collectTokensForPlayer(value, source) {
  if (!value || !source) return [];
  const lowered = typeof value === "string" ? value.toLowerCase() : null;
  const matches = [];
  for (const [token, info] of clientsByToken) {
    if (!info) continue;
    if (source === "playerId" && info.playerId === value) {
      matches.push(token);
      continue;
    }
    if (lowered) {
      if (source === "playerUuid" && info.playerUuid && info.playerUuid.toLowerCase() === lowered) {
        matches.push(token);
        continue;
      }
      if (source === "playerName" && info.playerName && info.playerName.toLowerCase() === lowered) {
        matches.push(token);
        continue;
      }
    }
    if (token === value) {
      matches.push(token);
    }
  }
  return matches;
}

function getRegionForClient(token, info = clientsByToken.get(token)) {
  if (!info) {
    return regionByToken.get(token) || null;
  }
  const keys = collectPlayerKeysFromInfo(info);
  for (const key of keys) {
    const regionId = regionByPlayerKey.get(key);
    if (regionId) return regionId;
  }
  return regionByToken.get(token) || null;
}

function applyRegionForClient(token, info = clientsByToken.get(token)) {
  const assignedRegion = getRegionForClient(token, info);
  const result = assignRegionForToken(token, assignedRegion, { alreadyCanonical: true });
  if (!result.changed) {
    return result.regionId;
  }

  if (!result.regionId && result.previous) {
    sendToClientByToken(token, { type: "VIDEO_CLOSE" });
    return null;
  }

  if (result.regionId) {
    syncRegionMediaToToken(token, result.regionId);
  }

  return result.regionId;
}

function syncRegionMediaToToken(token, regionId) {
  if (!regionId) return false;
  const record = activeMediaByRegion.get(regionId);
  if (!record || !record.init) {
    sendToClientByToken(token, { type: "VIDEO_CLOSE" });
    return false;
  }

  const context = {};
  if (record.sessionId != null) {
    context.sessionId = record.sessionId;
  }

  const initPayload = { ...record.init, resume: true };
  sendToClientByToken(token, initPayload, context);

  const state = record.state || {};
  const now = Date.now();
  if (state.status === "playing") {
    const positionMs = Math.max(now - (state.startedAtEpochMs ?? now), 0);
    sendToClientByToken(token, {
      type: "VIDEO_PLAY",
      serverEpochMs: now,
      atMs: positionMs,
      volume: state.volume,
      muted: state.muted,
      autoclose: state.autoclose ?? record.init?.autoclose ?? false,
    }, context);
  } else if (state.status === "paused") {
    sendToClientByToken(token, {
      type: "VIDEO_PAUSE",
      atMs: state.pausedAtMs ?? 0,
      volume: state.volume,
      muted: state.muted,
      autoclose: state.autoclose ?? record.init?.autoclose ?? false,
    }, context);
  }
  return true;
}

function handleClientVideoState(token, message = {}) {
  const record = activeMediaByToken.get(token);
  if (!record) return;

  record.lastUpdate = Date.now();
  const state = record.state || {};

  if (typeof message.state === "string") {
    state.status = message.state;
  }
  if (Number.isFinite(message.positionMs)) {
    state.reportedPositionMs = message.positionMs;
  }

  record.state = state;

  const shouldAutoclose = Boolean(state.autoclose ?? record.init?.autoclose ?? false);
  if (shouldAutoclose && (message.state === "ended" || message.state === "idle")) {
    registerMediaCommand(activeMediaByToken, token, { type: "VIDEO_CLOSE" });
    const regionId = regionByToken.get(token);
    if (regionId) {
      const regionRecord = activeMediaByRegion.get(regionId);
      const regionAutoclose = Boolean(regionRecord?.state?.autoclose ?? regionRecord?.init?.autoclose ?? false);
      if (regionAutoclose) {
        let otherActiveMembers = false;
        const members = tokensByRegion.get(regionId);
        if (members) {
          for (const memberToken of members) {
            if (memberToken === token) continue;
            const memberRecord = activeMediaByToken.get(memberToken);
            const memberStatus = memberRecord?.state?.status;
            if (memberStatus && memberStatus !== "idle" && memberStatus !== "ended") {
              otherActiveMembers = true;
              break;
            }
          }
        }
        if (!otherActiveMembers) {
          sendToRegion(regionId, { type: "VIDEO_CLOSE" });
        }
      }
    }
  }

  // Notify admins of state changes
  try {
    broadcastAdminConnections();
    broadcastAdminRegions();
  } catch { /* ignore */ }
}

function sendToClientByToken(token, payload, context) {
  if (payload && payload.type && payload.type.startsWith("VIDEO_")) {
    registerMediaCommand(activeMediaByToken, token, payload, context);
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
        registerMediaCommand(activeMediaByToken, token, payload, context);
      }
      c.ws.send(JSON.stringify(payload));
      return true;
    }
    if (lowered) {
      if (c.playerUuid && c.playerUuid.toLowerCase() === lowered) {
        if (payload && payload.type && payload.type.startsWith("VIDEO_")) {
          registerMediaCommand(activeMediaByToken, token, payload, context);
        }
        c.ws.send(JSON.stringify(payload));
        return true;
      }
      if (c.playerName && c.playerName.toLowerCase() === lowered) {
        if (payload && payload.type && payload.type.startsWith("VIDEO_")) {
          registerMediaCommand(activeMediaByToken, token, payload, context);
        }
        c.ws.send(JSON.stringify(payload));
        return true;
      }
    }
    if (token === playerId) {
      if (payload && payload.type && payload.type.startsWith("VIDEO_")) {
        registerMediaCommand(activeMediaByToken, token, payload, context);
      }
      c.ws.send(JSON.stringify(payload));
      return true;
    }
  }
  return false;
}

function sendToRegion(regionId, payload, context = {}, options = {}) {
  if (typeof regionId !== "string") return false;
  const trimmed = regionId.trim();
  if (!trimmed) return false;
  const canonical = trimmed.toLowerCase();
  if (options.displayName) {
    rememberRegionDisplayName(canonical, options.displayName);
  } else if (!regionDisplayNames.has(canonical)) {
    rememberRegionDisplayName(canonical, trimmed);
  }

  if (payload && payload.type && payload.type.startsWith("VIDEO_")) {
    registerMediaCommand(activeMediaByRegion, canonical, payload, context);
  }

  let delivered = false;
  const members = tokensByRegion.get(canonical);
  if (members) {
    for (const token of members) {
      const ok = sendToClientByToken(token, payload, context);
      delivered = delivered || ok;
    }
  }
  return delivered;
}

function resolveTarget(body = {}) {
  const {
    token,
    playerId,
    playerUuid,
    playerName,
    regionId,
  } = body;

  const regionTarget = normalizeRegionId(regionId);
  if (regionTarget) return { kind: "region", value: regionTarget };

  if (token) return { kind: "token", value: token };

  const playerKey = playerId || playerUuid || playerName;
  if (playerKey) {
    let source = null;
    if (playerId) source = "playerId";
    else if (playerUuid) source = "playerUuid";
    else if (playerName) source = "playerName";
    return { kind: "player", value: playerKey, source };
  }

  return null;
}

function resolvePlayerReference(body = {}) {
  const { token, playerId, playerUuid, playerName } = body;
  if (typeof token === "string" && token) return { kind: "token", value: token, source: "token" };
  if (typeof playerId === "string" && playerId.trim()) return { kind: "player", value: playerId, source: "playerId" };
  if (typeof playerUuid === "string" && playerUuid.trim()) return { kind: "player", value: playerUuid, source: "playerUuid" };
  if (typeof playerName === "string" && playerName.trim()) return { kind: "player", value: playerName, source: "playerName" };
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

  applyRegionForClient(token, info);
  // Notify admins of identity/connection changes
  try { broadcastAdminConnections(); } catch { /* ignore */ }
}

function buildError(status, message) {
  return { status, body: { error: message } };
}

function deliverPayloadToTarget(target, payload, context = {}, options = {}) {
  if (!target) {
    return { delivered: false, response: { delivered: false, target: null } };
  }

  const { displayName = null, responseExtras = {} } = options;
  let delivered = false;
  if (target.kind === "token") {
    delivered = sendToClientByToken(target.value, payload, context);
  } else if (target.kind === "player") {
    delivered = sendToClientByPlayer(target.value, payload, context);
  } else if (target.kind === "region") {
    delivered = sendToRegion(target.value, payload, context, { displayName });
  }

  const response = { delivered, target: target.kind, ...responseExtras };
  if (target.kind === "region") {
    response.regionId = target.value;
    response.regionDisplayName = getRegionDisplayName(target.value);
  }

  return { delivered, response };
}

function handleSetRegionRequest(body = {}) {
  const target = resolvePlayerReference(body);
  if (!target) {
    return buildError(400, "token, playerId, playerUuid, or playerName required");
  }

  let regionSpecified = false;
  let desiredRegion = null;
  let displayName = body.regionDisplayName || body.regionName || body.regionLabel || null;

  if (Object.prototype.hasOwnProperty.call(body, "region")) {
    regionSpecified = true;
    const value = body.region;
    if (value == null || (typeof value === "string" && !value.trim())) {
      desiredRegion = null;
    } else if (typeof value === "string") {
      displayName = displayName || value;
      desiredRegion = normalizeRegionId(value, { displayName });
    } else {
      return buildError(400, "region must be a string or null");
    }
  } else if (Object.prototype.hasOwnProperty.call(body, "regionId")) {
    regionSpecified = true;
    const value = body.regionId;
    if (value == null || (typeof value === "string" && !value.trim())) {
      desiredRegion = null;
    } else if (typeof value === "string") {
      displayName = displayName || value;
      desiredRegion = normalizeRegionId(value, { displayName });
    } else {
      return buildError(400, "regionId must be a string or null");
    }
  }

  if (!regionSpecified) {
    return buildError(400, "region or regionId required");
  }

  const response = { ok: true, target: target.kind };

  if (target.kind === "token") {
    const token = target.value;
    const info = clientsByToken.get(token);
    const result = assignRegionForToken(token, desiredRegion, { alreadyCanonical: true, displayName });
    response.changed = result.changed;
    response.regionId = result.regionId;
    response.previousRegionId = result.previous;
    response.regionDisplayName = result.regionId ? getRegionDisplayName(result.regionId) : null;

    if (info) {
      const keys = collectPlayerKeysFromInfo(info);
      assignRegionForPlayerKeys(keys, result.regionId);
      if (result.changed) {
        if (result.regionId) {
          syncRegionMediaToToken(token, result.regionId);
        } else if (result.previous) {
          sendToClientByToken(token, { type: "VIDEO_CLOSE" });
        }
      }
    }
  } else if (target.kind === "player") {
    const canonicalKey = canonicalizePlayerKey(
      target.source === "playerUuid" ? "uuid" : target.source === "playerName" ? "name" : "id",
      target.value,
    );
    if (!canonicalKey) {
      return buildError(400, `invalid ${target.source || "playerId"}`);
    }

    assignRegionForPlayerKey(canonicalKey, desiredRegion);
    const extraKeys = collectPlayerKeysFromBody(body).filter((key) => key && key !== canonicalKey);
    assignRegionForPlayerKeys(extraKeys, desiredRegion);

    const affectedTokens = [];
    const candidates = collectTokensForPlayer(target.value, target.source || "playerId");
    for (const token of candidates) {
      const result = assignRegionForToken(token, desiredRegion, { alreadyCanonical: true, displayName });
      affectedTokens.push({
        token,
        changed: result.changed,
        regionId: result.regionId,
        previousRegionId: result.previous,
      });
      if (result.changed) {
        if (result.regionId) {
          syncRegionMediaToToken(token, result.regionId);
        } else if (result.previous) {
          sendToClientByToken(token, { type: "VIDEO_CLOSE" });
        }
      }
    }

    response.regionId = desiredRegion;
    response.regionDisplayName = desiredRegion ? getRegionDisplayName(desiredRegion) : null;
    response.affectedTokens = affectedTokens;
  }

  if (desiredRegion) {
    response.regionId = desiredRegion;
    response.regionDisplayName = getRegionDisplayName(desiredRegion);
  } else {
    response.regionId = null;
    response.regionDisplayName = null;
  }

  return { status: 200, body: response };
}

function handleVideoInitRequest(body = {}) {
  const target = resolveTarget(body);
  if (!target) {
    return buildError(400, "token, playerId, playerUuid, playerName, or regionId required");
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
  if (typeof body.streamType === "string") payload.streamType = body.streamType;
  if (body.streamConfig && typeof body.streamConfig === "object") payload.streamConfig = body.streamConfig;
  includeOptionalBackgroundFields(body, payload);
  const context = {};
  if (sessionId != null) context.sessionId = sessionId;
  const displayName = body.regionDisplayName || body.regionName || body.regionLabel || body.regionId;

  const { response } = deliverPayloadToTarget(target, payload, context, { displayName });
  return { status: 200, body: response };
}

function handleVideoPlayRequest(body = {}) {
  const target = resolveTarget(body);
  if (!target) {
    return buildError(400, "token, playerId, playerUuid, playerName, or regionId required");
  }

  const payload = { type: "VIDEO_PLAY", serverEpochMs: Date.now() };
  if (Number.isFinite(body.atMs)) payload.atMs = body.atMs;
  if (typeof body.volume === "number") payload.volume = body.volume;
  if (typeof body.muted === "boolean") payload.muted = body.muted;
  if (typeof body.autoclose === "boolean") payload.autoclose = body.autoclose;
  if (typeof body.streamType === "string") payload.streamType = body.streamType;
  if (body.streamConfig && typeof body.streamConfig === "object") payload.streamConfig = body.streamConfig;

  const displayName = body.regionDisplayName || body.regionName || body.regionLabel || body.regionId;
  const { response } = deliverPayloadToTarget(target, payload, {}, { displayName });
  return { status: 200, body: response };
}

function handleVideoPauseRequest(body = {}) {
  const target = resolveTarget(body);
  if (!target) {
    return buildError(400, "token, playerId, playerUuid, playerName, or regionId required");
  }

  const payload = { type: "VIDEO_PAUSE" };
  if (Number.isFinite(body.atMs)) payload.atMs = body.atMs;
  if (typeof body.volume === "number") payload.volume = body.volume;
  if (typeof body.muted === "boolean") payload.muted = body.muted;
  if (typeof body.autoclose === "boolean") payload.autoclose = body.autoclose;
  if (typeof body.streamType === "string") payload.streamType = body.streamType;
  if (body.streamConfig && typeof body.streamConfig === "object") payload.streamConfig = body.streamConfig;

  const displayName = body.regionDisplayName || body.regionName || body.regionLabel || body.regionId;
  const { response } = deliverPayloadToTarget(target, payload, {}, { displayName });
  return { status: 200, body: response };
}

function handleVideoSeekRequest(body = {}) {
  const target = resolveTarget(body);
  if (!target) {
    return buildError(400, "token, playerId, playerUuid, playerName, or regionId required");
  }

  const payload = { type: "VIDEO_SEEK" };
  if (Number.isFinite(body.toMs)) payload.toMs = body.toMs;
  if (Number.isFinite(body.startAtEpochMs)) payload.startAtEpochMs = body.startAtEpochMs;
  if (typeof body.volume === "number") payload.volume = body.volume;
  if (typeof body.muted === "boolean") payload.muted = body.muted;
  if (typeof body.autoclose === "boolean") payload.autoclose = body.autoclose;
  if (typeof body.streamType === "string") payload.streamType = body.streamType;
  if (body.streamConfig && typeof body.streamConfig === "object") payload.streamConfig = body.streamConfig;

  const displayName = body.regionDisplayName || body.regionName || body.regionLabel || body.regionId;
  const { response } = deliverPayloadToTarget(target, payload, {}, { displayName });
  return { status: 200, body: response };
}

function handleVideoCloseRequest(body = {}) {
  const target = resolveTarget(body);
  if (!target) {
    return buildError(400, "token, playerId, playerUuid, playerName, or regionId required");
  }

  const payload = { type: "VIDEO_CLOSE" };
  const displayName = body.regionDisplayName || body.regionName || body.regionLabel || body.regionId;
  const { response } = deliverPayloadToTarget(target, payload, {}, { displayName });
  return { status: 200, body: response };
}

function handleVideoPlayInstantRequest(body = {}) {
  const target = resolveTarget(body);
  if (!target) {
    return buildError(400, "token, playerId, playerUuid, playerName, or regionId required");
  }

  const {
    url,
    muted = false,
    volume = 1.0,
    startAtEpochMs,
    startOffsetMs = 0,
    sessionId = null,
  } = body;

  if (!url) {
    return buildError(400, "url required");
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
  if (typeof body.streamType === "string") initPayload.streamType = body.streamType;
  if (body.streamConfig && typeof body.streamConfig === "object") initPayload.streamConfig = body.streamConfig;
  includeOptionalBackgroundFields(body, initPayload);

  const initContext = {};
  if (sessionId != null) initContext.sessionId = sessionId;
  const displayName = body.regionDisplayName || body.regionName || body.regionLabel || body.regionId;

  const { delivered: deliverInit } = deliverPayloadToTarget(target, initPayload, initContext, { displayName });

  const shouldSendPlay = deliverInit || target.kind === "region";

  if (!shouldSendPlay) {
    const response = { delivered: false, stage: "init", target: target.kind };
    if (target.kind === "region") {
      response.regionId = target.value;
      response.regionDisplayName = getRegionDisplayName(target.value);
    }
    return { status: 200, body: response };
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
  if (typeof body.streamType === "string") playPayload.streamType = body.streamType;
  if (body.streamConfig && typeof body.streamConfig === "object") playPayload.streamConfig = body.streamConfig;

  const { delivered: deliverPlay } = deliverPayloadToTarget(target, playPayload, {}, { displayName });

  const response = {
    delivered: deliverInit && deliverPlay,
    stage: deliverPlay
      ? "play"
      : (deliverInit ? "init" : (target.kind === "region" ? "play" : "init")),
    target: target.kind,
  };
  if (target.kind === "region") {
    response.regionId = target.value;
    response.regionDisplayName = getRegionDisplayName(target.value);
    response.initDelivered = deliverInit;
    response.playDelivered = deliverPlay;
  }

  return { status: 200, body: response };
}

function handleVideoPreloadRequest(body = {}) {
  const target = resolveTarget(body);
  if (!target) {
    return buildError(400, "token, playerId, playerUuid, playerName, or regionId required");
  }

  const { url } = body;
  if (!url) {
    return buildError(400, "url required");
  }

  const payload = { type: "VIDEO_PRELOAD", url };
  if (typeof body.volume === "number") payload.volume = body.volume;
  if (typeof body.muted === "boolean") payload.muted = body.muted;
  if (typeof body.streamType === "string") payload.streamType = body.streamType;
  if (body.streamConfig && typeof body.streamConfig === "object") payload.streamConfig = body.streamConfig;

  const context = {};
  if (body.sessionId != null) context.sessionId = body.sessionId;
  const displayName = body.regionDisplayName || body.regionName || body.regionLabel || body.regionId;

  const { response } = deliverPayloadToTarget(target, payload, context, { displayName });
  return { status: 200, body: response };
}

function handleVideoInitializePlaylistRequest(body = {}) {
  const target = resolveTarget(body);
  if (!target) {
    return buildError(400, "token, playerId, playerUuid, playerName, or regionId required");
  }

  const rawItems = Array.isArray(body.items) ? body.items : [];
  const items = rawItems
    .map((item) => {
      if (!item || typeof item !== "object" || !item.url) return null;
      const normalized = { url: item.url };
      if (typeof item.volume === "number") normalized.volume = item.volume;
      if (typeof item.muted === "boolean") normalized.muted = item.muted;
      if (typeof item.autoclose === "boolean") normalized.autoclose = item.autoclose;
      if (Number.isFinite(item.atMs)) normalized.atMs = item.atMs;
      if (typeof item.streamType === "string") normalized.streamType = item.streamType;
      if (item.streamConfig && typeof item.streamConfig === "object") {
        normalized.streamConfig = item.streamConfig;
      }
      return normalized;
    })
    .filter((entry) => entry != null);

  if (!items.length) {
    return buildError(400, "items array with at least one entry required");
  }

  const payload = {
    type: "VIDEO_PLAYLIST_INIT",
    items,
  };

  const context = {};
  if (body.sessionId != null) context.sessionId = body.sessionId;
  const displayName = body.regionDisplayName || body.regionName || body.regionLabel || body.regionId;

  const { response } = deliverPayloadToTarget(target, payload, context, {
    displayName,
    responseExtras: { count: items.length },
  });

  return { status: 200, body: response };
}

function snapshotClientForPlugin(token) {
  const info = clientsByToken.get(token);
  if (!info) {
    return { token };
  }

  return {
    token,
    playerId: info.playerId || null,
    playerUuid: info.playerUuid || null,
    playerName: info.playerName || null,
    regionId: info.region || null,
    regionDisplayName: info.region ? getRegionDisplayName(info.region) : null,
    connectedAt: info.connectedAt || null,
    lastSeen: info.lastSeen || null,
  };
}

function sendPluginResponse(ws, correlationId, status, body) {
  const payload = {
    type: "PLUGIN_RESPONSE",
    status,
    ok: status >= 200 && status < 300,
  };
  if (correlationId != null) {
    payload.id = correlationId;
  }
  if (body !== undefined) {
    payload.body = body;
  }

  try {
    ws.send(JSON.stringify(payload));
  } catch {
    // ignore send errors
  }
}

app.post("/set-region", (req, res) => {
  const { status, body } = handleSetRegionRequest(req.body || {});
  return res.status(status).json(body);
});

// Example: init a video
app.post("/admin/video/init", requireAdmin, (req, res) => {
  const { status, body } = handleVideoInitRequest(req.body || {});
  return res.status(status).json(body);
});

// Example: play/pause/seek/close
app.post("/admin/video/play", requireAdmin, (req, res) => {
  const { status, body } = handleVideoPlayRequest(req.body || {});
  return res.status(status).json(body);
});
app.post("/admin/video/pause", requireAdmin, (req, res) => {
  const { status, body } = handleVideoPauseRequest(req.body || {});
  return res.status(status).json(body);
});
app.post("/admin/video/seek", requireAdmin, (req, res) => {
  const { status, body } = handleVideoSeekRequest(req.body || {});
  return res.status(status).json(body);
});
app.post("/admin/video/close", requireAdmin, (req, res) => {
  const { status, body } = handleVideoCloseRequest(req.body || {});
  return res.status(status).json(body);
});

app.post("/admin/video/play-instant", requireAdmin, (req, res) => {
  const { status, body } = handleVideoPlayInstantRequest(req.body || {});
  return res.status(status).json(body);
});

app.post("/admin/video/preload", requireAdmin, (req, res) => {
  const { status, body } = handleVideoPreloadRequest(req.body || {});
  return res.status(status).json(body);
});

app.post("/admin/video/initialize-playlist", requireAdmin, (req, res) => {
  const { status, body } = handleVideoInitializePlaylistRequest(req.body || {});
  return res.status(status).json(body);
});

app.get("/admin/video/connections", requireAdmin, (_req, res) => {
  const connections = buildConnectionsData();
  return res.json({ ok: true, connections });
});

app.get("/admin/video/regions", requireAdmin, (_req, res) => {
  const regions = buildRegionsData();
  return res.json({ ok: true, regions });
});

// --- ATC (Attraction Controls) ---
function handleAtcShowRequest(body = {}) {
  const target = resolveTarget(body);
  if (!target) {
    return buildError(400, "token, playerId, playerUuid, playerName, or regionId required");
  }

  const attractionName = typeof body.attraction_name === 'string' ? body.attraction_name : null;
  if (!attractionName) {
    return buildError(400, "attraction_name required");
  }

  const payload = {
    type: "ATC_SHOW",
    attraction_name: attractionName,
    attraction_id: body.attraction_id ?? null,
    playername: body.playername ?? null,
    player_uuid: body.player_uuid ?? null,
    session_id: body.session_id ?? null,
  };

  const { response } = deliverPayloadToTarget(target, payload);
  return { status: 200, body: response };
}

app.post("/admin/atc/show", requireAdmin, (req, res) => {
  const { status, body } = handleAtcShowRequest(req.body || {});
  return res.status(status).json(body);
});

function handleAtcHideRequest(body = {}) {
  const target = resolveTarget(body);
  if (!target) {
    return buildError(400, "token, playerId, playerUuid, playerName, or regionId required");
  }
  const payload = { type: "ATC_HIDE" };
  const { response } = deliverPayloadToTarget(target, payload);
  return { status: 200, body: response };
}

app.post("/admin/atc/hide", requireAdmin, (req, res) => {
  const { status, body } = handleAtcHideRequest(req.body || {});
  return res.status(status).json(body);
});

// Create/initialize an attraction definition on disk
async function readAttractionFile(attractionId) {
  if (!attractionId) return null;
  const file = path.join(ATTRACTIONS_DIR, `${attractionId}.json`);
  try {
    const raw = await fsp.readFile(file, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeAttractionFile(attractionId, data) {
  if (!attractionId || !data) return false;
  const file = path.join(ATTRACTIONS_DIR, `${attractionId}.json`);
  const pretty = JSON.stringify(data, null, 2);
  await fsp.writeFile(file, pretty, 'utf8');
  return true;
}

function buildDefaultAttraction(attraction_id, attraction_name, overrides = {}) {
  const defVal = 2;
  const states = {
    atc_power: defVal,
    atc_status: defVal,
    atc_station: defVal,
    atc_gates: defVal,
    atc_beugels: defVal,
    atc_emercency: defVal,
  };
  for (const k of Object.keys(states)) {
    const v = overrides[k];
    if ([0, 1, 2].includes(v)) states[k] = v;
  }
  return { attraction_id, attraction_name, ...states, updatedAt: Date.now() };
}

app.post("/admin/atc/createAttraction", requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const attraction_id = typeof body.attraction_id === 'string' ? body.attraction_id.trim() : '';
    const attraction_name = typeof body.attraction_name === 'string' ? body.attraction_name.trim() : '';
    if (!attraction_id) return res.status(400).json({ ok: false, error: 'attraction_id required' });
    if (!attraction_name) return res.status(400).json({ ok: false, error: 'attraction_name required' });

    const overrides = {};
    for (const key of ['atc_power','atc_status','atc_station','atc_gates','atc_beugels','atc_emercency']) {
      if ([0,1,2].includes(body[key])) overrides[key] = body[key];
    }

    const record = buildDefaultAttraction(attraction_id, attraction_name, overrides);
    ensureDirSync(ATTRACTIONS_DIR);
    await writeAttractionFile(attraction_id, record);

    // Also seed in-memory state so new connections get the same snapshot
    const mem = getOrInitAtcState(attraction_id);
    for (const key of ['atc_power','atc_status','atc_station','atc_gates','atc_beugels','atc_emercency']) {
      mem[key] = record[key];
    }
    mem.updatedAt = Date.now();

    return res.json({ ok: true, attraction: record });
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

// Simple health
app.get("/healthz", (req, res) => res.json({ ok: true }));

const server = http.createServer(app);

// --- WebSocket server ---
const pluginWss = new WebSocketServer({ noServer: true });
const wss = new WebSocketServer({ noServer: true });
const adminWss = new WebSocketServer({ noServer: true });

const pluginClients = new Set();
const adminClients = new Set();

function buildConnectionsData() {
  const now = Date.now();
  return Array.from(clientsByToken.entries()).map(([token, info]) => ({
    token,
    playerId: info.playerId,
    playerUuid: info.playerUuid,
    playerName: info.playerName,
    publicServerKey: info.publicServerKey,
    scope: info.scope,
    region: info.region || null,
    regionDisplayName: info.region ? getRegionDisplayName(info.region) : null,
    connectedAt: info.connectedAt,
    lastSeen: info.lastSeen,
    readyState: info.ws?.readyState,
    idleMs: info.lastSeen ? now - info.lastSeen : null,
    activeMedia: (() => {
      const media = activeMediaByToken.get(token);
      if (!media || !media.state || media.state.status === 'idle') return null;
      return {
        sessionId: media.sessionId || null,
        init: snapshotPayload(media.init),
        state: snapshotPayload(media.state),
        lastUpdate: media.lastUpdate,
      };
    })(),
  }));
}

function buildRegionsData() {
  const regionIds = new Set();
  for (const key of tokensByRegion.keys()) regionIds.add(key);
  for (const key of activeMediaByRegion.keys()) regionIds.add(key);

  return Array.from(regionIds).map((regionId) => {
    const displayName = getRegionDisplayName(regionId);
    const members = Array.from(tokensByRegion.get(regionId) || []).map((token) => {
      const info = clientsByToken.get(token);
      return {
        token,
        playerId: info?.playerId || null,
        playerUuid: info?.playerUuid || null,
        playerName: info?.playerName || null,
        connected: Boolean(info && info.ws?.readyState === 1),
        lastSeen: info?.lastSeen ?? null,
      };
    });

    const record = activeMediaByRegion.get(regionId);
    const activeMedia = (() => {
      if (!record || !record.state || record.state.status === "idle") return null;
      return {
        sessionId: record.sessionId || null,
        init: snapshotPayload(record.init),
        state: snapshotPayload(record.state),
        lastUpdate: record.lastUpdate,
        preload: snapshotPayload(record.preload),
        playlist: snapshotPayload(record.playlist),
        lastCommand: snapshotPayload(record.lastCommand),
      };
    })();

    return {
      regionId,
      displayName,
      memberCount: members.length,
      members,
      activeMedia,
      lastUpdate: record?.lastUpdate || null,
    };
  });
}

function broadcastAdmin(type, payloadBuilder) {
  if (!adminClients.size) return;
  const payload = typeof payloadBuilder === 'function' ? payloadBuilder() : payloadBuilder;
  const json = JSON.stringify({ type, ...payload });
  for (const ws of adminClients) {
    if (ws.readyState === 1) {
      try { ws.send(json); } catch { /* ignore */ }
    }
  }
}

function broadcastAdminSnapshot() {
  broadcastAdmin('ADMIN_SNAPSHOT', () => ({
    connections: buildConnectionsData(),
    regions: buildRegionsData(),
  }));
}

function broadcastAdminConnections() {
  broadcastAdmin('ADMIN_CONNECTIONS', () => ({ connections: buildConnectionsData() }));
}

function broadcastAdminRegions() {
  broadcastAdmin('ADMIN_REGIONS', () => ({ regions: buildRegionsData() }));
}

function resetInMemoryStores() {
  clientsByToken.clear();
  tokenToPlayerId.clear();
  activeMediaByToken.clear();
  activeMediaByRegion.clear();
  tokensByRegion.clear();
  regionByToken.clear();
  regionByPlayerKey.clear();
  regionDisplayNames.clear();
}

// Optional: keep-alive ping from server
function heartbeat(ws) {
  if (ws.readyState === 1) ws.send(JSON.stringify({ type: "PING", t: Date.now() }));
}

pluginWss.on("connection", (ws) => {
  pluginClients.add(ws);

  const hello = {
    type: "PLUGIN_HELLO",
    serverEpochMs: Date.now(),
    connections: Array.from(clientsByToken.keys()).map((token) => snapshotClientForPlugin(token)),
  };

  try {
    ws.send(JSON.stringify(hello));
  } catch {
    // ignore send failures
  }

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      sendPluginResponse(ws, null, 400, { error: "invalid_json" });
      return;
    }

    if (!msg || typeof msg !== "object") {
      sendPluginResponse(ws, null, 400, { error: "invalid_payload" });
      return;
    }

    const correlationId = msg.id ?? msg.correlationId ?? null;
    const type = typeof msg.type === "string" ? msg.type.toUpperCase() : null;
    if (!type) {
      sendPluginResponse(ws, correlationId, 400, { error: "type_required" });
      return;
    }

    if (type === "PING") {
      const payload = { type: "PONG", serverEpochMs: Date.now() };
      if (correlationId != null) payload.id = correlationId;
      try {
        ws.send(JSON.stringify(payload));
      } catch {
        // ignore send errors
      }
      return;
    }

    let result;
    switch (type) {
      case "SET_REGION":
        result = handleSetRegionRequest(msg);
        break;
      case "ATC_SERVER_UPDATE": {
        const {
          attraction_id,
          name,
          value,
          session_id = null,
          playername = null,
        } = msg || {};
        const valid = typeof attraction_id === 'string' && typeof name === 'string' && [0,1,2].includes(value);
        const validNames = new Set(['atc_power','atc_status','atc_station','atc_gates','atc_beugels','atc_emercency']);
        if (!valid || !validNames.has(name)) {
          result = buildError(400, "invalid_atc_update");
          break;
        }
        const state = getOrInitAtcState(attraction_id);
        state[name] = value;
        state.updatedAt = Date.now();

        // Persist to file. Merge with existing to keep attraction_name.
        try {
          const existing = await readAttractionFile(attraction_id);
          const record = {
            attraction_id,
            attraction_name: existing?.attraction_name || null,
            atc_power: state.atc_power ?? existing?.atc_power ?? 2,
            atc_status: state.atc_status ?? existing?.atc_status ?? 2,
            atc_station: state.atc_station ?? existing?.atc_station ?? 2,
            atc_gates: state.atc_gates ?? existing?.atc_gates ?? 2,
            atc_beugels: state.atc_beugels ?? existing?.atc_beugels ?? 2,
            atc_emercency: state.atc_emercency ?? existing?.atc_emercency ?? 2,
            updatedAt: Date.now(),
          };
          await writeAttractionFile(attraction_id, record);
        } catch { /* ignore file errors */ }

        const payload = { type: 'atc_serverUpdate', name, value, session_id, playername, attraction_id };
        const delivered = broadcastAtc(attraction_id, payload);
        result = { status: 200, body: { ok: true, delivered } };
        break;
      }
      case "VIDEO_INIT":
        result = handleVideoInitRequest(msg);
        break;
      case "VIDEO_PLAY":
        result = handleVideoPlayRequest(msg);
        break;
      case "VIDEO_PAUSE":
        result = handleVideoPauseRequest(msg);
        break;
      case "VIDEO_SEEK":
        result = handleVideoSeekRequest(msg);
        break;
      case "VIDEO_CLOSE":
        result = handleVideoCloseRequest(msg);
        break;
      case "VIDEO_PLAY_INSTANT":
        result = handleVideoPlayInstantRequest(msg);
        break;
      case "VIDEO_PRELOAD":
        result = handleVideoPreloadRequest(msg);
        break;
      case "VIDEO_PLAYLIST_INIT":
      case "VIDEO_INITIALIZE_PLAYLIST":
        result = handleVideoInitializePlaylistRequest(msg);
        break;
      default:
        result = buildError(400, `unsupported type ${msg.type}`);
        break;
    }

    sendPluginResponse(ws, correlationId, result.status, result.body);
  });

  ws.on("close", () => {
    pluginClients.delete(ws);
  });
});

adminWss.on("connection", (ws) => {
  adminClients.add(ws);

  // Send initial snapshot immediately
  try {
    ws.send(JSON.stringify({
      type: "ADMIN_SNAPSHOT",
      connections: buildConnectionsData(),
      regions: buildRegionsData(),
    }));
  } catch { /* ignore */ }

  const iv = setInterval(() => heartbeat(ws), 10000);
  ws.on("close", () => {
    clearInterval(iv);
    adminClients.delete(ws);
  });
});

wss.on("connection", async (ws, request) => {
  const params = new URLSearchParams(request.url.split("?")[1] || "");
  const token = params.get("token");
  const hintedPlayerUuid = params.get("playerUuid");
  const hintedPlayerName = params.get("playerName");
  const role = (params.get("role") || params.get("atc") || "").toString().toLowerCase();

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

  const isAtc = role === 'atc' || role === '1' || role === 'true';

  if (isAtc) {
    // Secondary ATC popup connection: don't replace the primary mapping
    let set = atcSocketsByToken.get(token);
    if (!set) { set = new Set(); atcSocketsByToken.set(token, set); }
    set.add(ws);
  } else {
    // Primary client mapping
    clientsByToken.set(token, {
      ws,
      playerId,
      playerUuid: hintedPlayerUuid || null,
      playerName: hintedPlayerName || null,
      publicServerKey: null,
      scope: null,
      connectedAt: Date.now(),
      lastSeen: Date.now(),
      region: null,
      regionDisplayName: null,
    });
    tokenToPlayerId.set(token, playerId);
    try {
      broadcastAdminConnections();
      broadcastAdminRegions();
    } catch { /* ignore */ }

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

    applyRegionForClient(token, clientsByToken.get(token));
  }

  const pingIv = setInterval(() => heartbeat(ws), 5000);

  ws.on("message", async (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (!isAtc) {
        const clientInfo = clientsByToken.get(token);
        if (clientInfo) clientInfo.lastSeen = Date.now();
      }

      switch (msg.type) {
        case "PONG":
          // optional: compute rtt/skew if you implement round-trip
          break;
        case "VIDEO_STATE":
          handleClientVideoState(token, msg);
          break;
        case "HELLO":
          if (!isAtc) updateClientIdentity(token, msg);
          break;
        case "IDENTITY_UPDATE":
          if (!isAtc) updateClientIdentity(token, msg);
          break;
        case "atc_firstConnection": {
          if (!isAtc) break; // ignore if not an ATC connection
          const { session_id, playername, attraction_id } = msg || {};
          if (!attraction_id) break;
          // Remember meta and index by attraction
          atcMetaByWs.set(ws, { session_id: session_id || null, playername: playername || null, attraction_id, token });
          attachAtcSocket(attraction_id, ws);

          // Load file-based state if present
          let fileState = null;
          try { fileState = await readAttractionFile(attraction_id); } catch { /* ignore */ }
          const state = getOrInitAtcState(attraction_id) || {};
          if (fileState) {
            for (const key of ['atc_power','atc_status','atc_station','atc_gates','atc_beugels','atc_emercency']) {
              if ([0,1,2].includes(fileState[key])) state[key] = fileState[key];
            }
          }

          // Send init snapshot including identity
          const payload = {
            type: 'atc_init',
            session_id: session_id || null,
            playername: playername || null,
            attraction_id,
            atc_power: state.atc_power ?? 0,
            atc_status: state.atc_status ?? 0,
            atc_station: state.atc_station ?? 0,
            atc_gates: state.atc_gates ?? 0,
            atc_beugels: state.atc_beugels ?? 0,
            atc_emercency: state.atc_emercency ?? 0,
          };
          try { ws.send(JSON.stringify(payload)); } catch { /* ignore */ }
          break;
        }
        case "atc_update": {
          if (!isAtc) break; // only from ATC client
          const meta = atcMetaByWs.get(ws) || {};
          const attractionId = msg.attraction_id || meta.attraction_id;
          const sessionId = msg.session_id || meta.session_id || null;
          const playername = msg.playername || meta.playername || null;
          const { name, value } = msg || {};
          if (!attractionId || typeof name !== 'string') break;
          const validNames = new Set(['atc_power','atc_status','atc_station','atc_gates','atc_beugels','atc_emercency']);
          if (!validNames.has(name)) break;
          if (![0,1,2].includes(value)) break;
          // Forward to plugin to execute; plugin will respond with ATC_SERVER_UPDATE
          const payload = { type: 'ATC_CLIENT_UPDATE', attraction_id: attractionId, name, value, session_id: sessionId, playername };
          for (const p of pluginClients) {
            try { if (p.readyState === 1) p.send(JSON.stringify(payload)); } catch { /* ignore */ }
          }
          break;
        }
      default:
          break;
      }
    } catch { /* ignore */ }
  });

  ws.on("close", () => {
    clearInterval(pingIv);
    if (isAtc) {
      const set = atcSocketsByToken.get(token);
      if (set) {
        set.delete(ws);
        if (set.size === 0) atcSocketsByToken.delete(token);
      }
      // Also clean up ATC attraction mapping
      try { detachAtcSocket(ws); } catch { /* ignore */ }
    } else {
      // Cleanup primary
      assignRegionForToken(token, null, { alreadyCanonical: true });
      clientsByToken.delete(token);
      tokenToPlayerId.delete(token);
      try {
        broadcastAdminConnections();
        broadcastAdminRegions();
      } catch { /* ignore */ }
    }
  });
});

// Upgrade HTTP -> WS
server.on("upgrade", (req, socket, head) => {
  if (req.url.startsWith("/ws/video") || req.url.startsWith("/api/ws/video")) {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } else if (req.url.startsWith("/ws/plugin")) {
    const params = new URLSearchParams(req.url.split("?")[1] || "");
    const provided = params.get("token") || params.get("key") || params.get("auth");
    const expected = process.env.PLUGIN_TOKEN;
    if (expected && provided !== expected) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    pluginWss.handleUpgrade(req, socket, head, (ws) => pluginWss.emit("connection", ws, req));
  } else if (req.url.startsWith("/ws/admin")) {
    const params = new URLSearchParams(req.url.split("?")[1] || "");
    const provided = params.get("key") || params.get("adminKey") || params.get("auth");
    const expected = process.env.ADMIN_KEY;
    if (expected && provided !== expected) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    adminWss.handleUpgrade(req, socket, head, (ws) => adminWss.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
  });
}

module.exports = {
  app,
  server,
  pluginWss,
  wss,
  adminWss,
  applyRegionForClient,
  assignRegionForPlayerKey,
  assignRegionForPlayerKeys,
  assignRegionForToken,
  canonicalizePlayerKey,
  collectPlayerKeysFromBody,
  collectPlayerKeysFromInfo,
  collectTokensForPlayer,
  getRegionForClient,
  normalizeRegionId,
  rememberRegionDisplayName,
  registerMediaCommand,
  sendToRegion,
  sendToClientByToken,
  syncRegionMediaToToken,
  _internals: {
    clientsByToken,
    tokenToPlayerId,
    activeMediaByToken,
    activeMediaByRegion,
    tokensByRegion,
    regionByToken,
    regionByPlayerKey,
    regionDisplayNames,
    resetInMemoryStores,
    buildConnectionsData,
    buildRegionsData,
  },
};
