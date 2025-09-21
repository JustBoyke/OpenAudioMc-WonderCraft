/*
  OpenAudioMC Client – Video Modal Extension
  -----  // Optional: wait for OA client to be ready (you can wire this to OA's actual ready event)
  function onReady(fn) {
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      setTimeout(fn, 0);
    } else {
      document.addEventListener('DOMContentLoaded', fn);
    }
  }------------------------------------
  Goal: Extend your self-hosted OpenAudioMC web client with a custom modal
  that can play a synced video when instructed by *your* backend over *your* WebSocket.

  Key points:
  - Does NOT touch or modify OpenAudioMC's own socket/protocol.
  - Auth is done using the OA session token presented by the client to *your* backend.
  - Works with plain HTML/CSS/JS (no frameworks).

  How to use (quick):
  1) Add this file to your self-hosted OA client build (e.g., public/oa-video-extension.js).
  2) Include it with a <script src="/oa-video-extension.js" defer></script> after the OA client bundle is loaded.
  3) Define VIDEO_WS_URL below to point to your backend (wss://yourdomain/ws/video or similar).
  4) Ensure your page has <div id="oa-video-root"></div> or let this script create it.
  5) On your backend, once you validate the OA token server-side, send control events to the user's browser via YOUR WebSocket.

  Control message protocol from YOUR backend -> client (JSON):
  - { type: "VIDEO_INIT", url, startAtEpochMs, muted, volume }
  - { type: "VIDEO_PLAY", serverEpochMs }
  - { type: "VIDEO_PAUSE", atMs }
  - { type: "VIDEO_SEEK", toMs }
  - { type: "VIDEO_CLOSE" }
  - { type: "PING", t: <serverEpochMs> } // used for clock skew/drift calc

  The client responds with:
  - { type: "PONG", tClient: Date.now(), tServer: tFromPing }
  - { type: "VIDEO_STATE", state: "ready|playing|paused|ended", positionMs, bufferedMs }

  NOTE: You may adapt field names to your taste, this is just a clear baseline.
*/

(function videoExtension() {
  const LOG_DEBUG = window.__OA_VIDEO_DEBUG !== false;
  function dbg(...args) {
    if (LOG_DEBUG) console.info('[OA-Video]', ...args);
  }

  const VIDEO_WS_URL = window.__OA_VIDEO_WS_URL || (() => {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const host = window.location.hostname || 'localhost';
    const explicitPort = window.location.port;
    const isLocalHost = ['localhost', '127.0.0.1', '::1'].includes(host) || Boolean(explicitPort);

    if (isLocalHost) {
      const port = window.__OA_VIDEO_WS_PORT || 8080;
      return `${proto}://${host}:${port}/ws/video`;
    }

    return `${proto}://${host}/api/ws/video`;
  })();

  let ws = null;
  let reconnectTimer = null;
  let currentToken = null;
  let tokenPollTimer = null;

  // ---------- Helper: discover OA token/player info from the OA web client ----------
  function resolveLegacyToken() {
    if (window.__oa && window.__oa.session && window.__oa.session.token) {
      return window.__oa.session.token;
    }
    if (window.OpenAudioMc && window.OpenAudioMc.session && window.OpenAudioMc.session.token) {
      return window.OpenAudioMc.session.token;
    }
    const search = window.location.search;
    if (search && search.includes('session=')) {
      const params = new URLSearchParams(search);
      const sessionRaw = params.get('session');
      if (sessionRaw) {
        try {
          const decoded = atob(sessionRaw);
          const parts = decoded.split(':');
          if (parts.length === 4) {
            const [, playerUuid, , tokenFromQuery] = parts;
            if (tokenFromQuery) {
              return tokenFromQuery;
            }
          }
        } catch (err) {
          dbg('Failed to decode session param', err);
        }
      }
    }
    const meta = document.querySelector('meta[name=\'oa-token\']');
    if (meta && meta.content) return meta.content;
    return null;
  }

  function getOAIdentity() {
    const fromGlobal = window.__oaVideoSession;
    if (fromGlobal && typeof fromGlobal === 'object' && fromGlobal.token) {
      return {
        token: fromGlobal.token,
        playerName: fromGlobal.playerName || null,
        playerUuid: fromGlobal.playerUuid || null,
        publicServerKey: fromGlobal.publicServerKey || null,
        scope: fromGlobal.scope || null,
      };
    }

    const devCache = window._devTokenCache;
    if (devCache && devCache.token) {
      return {
        token: devCache.token,
        playerName: devCache.name || null,
        playerUuid: devCache.uuid || null,
        publicServerKey: devCache.publicServerKey || null,
        scope: devCache.scope || null,
      };
    }

    const legacyToken = resolveLegacyToken();
    if (legacyToken) {
      return { token: legacyToken };
    }

    return null;
  }

  function getOAToken() {
    const identity = getOAIdentity();
    return identity?.token || null;
  }

  let identityCache = null;
  let identityHash = null;
  let identityWatcher = null;
  let autoplayReady = window.__oaVideoAutoplayReady === true;
  let queuedPlayRequest = false;
  let pendingInitPayload = null;
  let preloadedSource = null;
  let activePlaylist = null;
  let pendingModalReveal = false;
  let pendingPlayPayload = null;
  let pendingPlayRetryTimer = null;

  function clearPendingPlayRetry() {
    if (pendingPlayRetryTimer) {
      clearTimeout(pendingPlayRetryTimer);
      pendingPlayRetryTimer = null;
    }
  }

  function schedulePlayRetry(delayMs = 200) {
    clearPendingPlayRetry();
    pendingPlayRetryTimer = setTimeout(() => {
      pendingPlayRetryTimer = null;
      safePlay();
    }, Math.max(0, delayMs));
  }

  function schedulePendingInit() {
    if (!pendingInitPayload || !autoplayReady) return null;
    const { payload, options } = pendingInitPayload;
    pendingInitPayload = null;
    return Promise.resolve()
      .then(() => initVideo(payload, options))
      .then((result) => {
        if (options?.postPlay && result !== false) {
          const { payload: playPayload, options: playOptions, onApplied } = options.postPlay;
          applyPlayPayload(playPayload, playOptions);
          if (typeof onApplied === 'function') {
            try { onApplied(); } catch (err) { dbg('postPlay callback failed', err?.message || err); }
          }
        }
        return result;
      })
      .catch((err) => {
        dbg('Failed to apply pending init payload', err?.message || err);
        return false;
      });
  }

  function handleAutoplayQueue() {
    const pendingInit = schedulePendingInit();
    if (pendingInit && typeof pendingInit.then === 'function') {
      pendingInit.finally(() => { flushQueuedPlay(); });
    } else {
      flushQueuedPlay();
    }
  }

  function clearPlaylist(reason = 'clear') {
    if (activePlaylist) {
      dbg('Clearing playlist', reason);
    }
    activePlaylist = null;
  }

  function buildIdentityKey(identity) {
    if (!identity) return 'none';
    return [
      identity.token || '',
      identity.playerName || '',
      identity.playerUuid || '',
      identity.publicServerKey || '',
      identity.scope || '',
    ].join('|');
  }

  function identityUpdatePayload(identity) {
    if (!identity) return null;
    return {
      type: 'IDENTITY_UPDATE',
      playerId: identity.playerUuid || identity.playerName || null,
      playerName: identity.playerName || null,
      playerUuid: identity.playerUuid || null,
      publicServerKey: identity.publicServerKey || null,
      scope: identity.scope || null,
    };
  }

  function refreshIdentityCache({ notify = true } = {}) {
    const identity = getOAIdentity();
    const key = buildIdentityKey(identity);
    if (key !== identityHash) {
      identityCache = identity;
      identityHash = key;
      if (identity) {
        dbg('Identity cache refreshed', identity.playerName || identity.playerUuid || identity.token || 'unknown');
        if (notify && ws && ws.readyState === WebSocket.OPEN) {
          const update = identityUpdatePayload(identity);
          if (update) send(update);
        }
      }
    }
    return identityCache;
  }

  function flushQueuedPlay() {
    if (!queuedPlayRequest || !autoplayReady) return queuedPlayRequest;
    if (pendingPlayPayload) {
      const { payload, options } = pendingPlayPayload;
      pendingPlayPayload = null;
      applyPlayPayload(payload, options || {});
      return queuedPlayRequest;
    }
    queuedPlayRequest = false;
    setStatus('Starting…');
    resyncToServerClock(true);
    safePlay();
    return queuedPlayRequest;
  }

  function setAutoplayReady(value) {
    const ready = Boolean(value);
    if (autoplayReady === ready) {
      if (ready) {
        if (pendingModalReveal) {
          pendingModalReveal = false;
          showModal();
        }
        handleAutoplayQueue();
      }
      return;
    }
    autoplayReady = ready;
    if (ready) {
      if (pendingModalReveal) {
        pendingModalReveal = false;
        showModal();
      }
      handleAutoplayQueue();
    } else {
      queuedPlayRequest = false;
    }
  }

  window.addEventListener('oa-video-autoplay-ready', () => setAutoplayReady(true));
  window.addEventListener('oa-video-autoplay-reset', () => setAutoplayReady(false));
  setAutoplayReady(autoplayReady);

  // Optional: wait for OA client to be ready (you can wire this to OA’s actual ready event)
  function onReady(fn) {
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      setTimeout(fn, 0);
    } else {
      document.addEventListener('DOMContentLoaded', fn);
    }
  }

  // ---------- Minimal modal UI ----------
  const styles = `
    .oa-vid-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.6); display: none; align-items: center; justify-content: center; z-index: 9999; }
    .oa-vid-modal { background: #111; color: #fff; width: min(900px, 95vw); border-radius: 12px; overflow: hidden; box-shadow: 0 10px 30px rgba(0,0,0,.5); display:flex; flex-direction:column; }
    .oa-vid-modal.is-fullscreen { width: 100vw; height: 100vh; border-radius: 0; box-shadow: none; }
    .oa-vid-header { display:flex; align-items:center; justify-content: space-between; padding: 10px 14px; background: #1b1b1b; }
    .oa-vid-header.is-hidden, .oa-vid-footer.is-hidden { display: none !important; }
    .oa-vid-title { font-size: 14px; opacity: .85; }
    .oa-vid-body { background:#000; position:relative; flex:1; display:flex; min-height:60vh; }
    .oa-vid-body.is-fullscreen { height: 100%; }
    .oa-vid-video { width: 100%; height: 100%; max-height: none; background:#000; object-fit: contain; }
    .oa-vid-footer { display:flex; align-items:center; justify-content: space-between; padding:8px 12px; background:#121212; min-height:36px; gap:8px; }
    .oa-vid-status { font-size:12px; opacity:.7; flex:1; }
    .oa-vid-actions { display:flex; gap:8px; }
    .oa-vid-action { background:#1f1f1f; color:#fff; border:none; border-radius:8px; padding:6px 10px; cursor:pointer; font-size:12px; }
    .oa-vid-action:hover { background:#353535; }
  `;

  function ensureRoot() {
    let root = document.getElementById('oa-video-root');
    if (!root) {
      root = document.createElement('div');
      root.id = 'oa-video-root';
      document.body.appendChild(root);
    }
    return root;
  }

  function injectStyles() {
    const el = document.createElement('style');
    el.textContent = styles;
    document.head.appendChild(el);
  }

  function createModal() {
    const root = ensureRoot();
    const backdrop = document.createElement('div');
    backdrop.className = 'oa-vid-backdrop';
    backdrop.innerHTML = `
      <div class="oa-vid-modal">
        <div class="oa-vid-header">
          <div class="oa-vid-title">Synced Video</div>
        </div>
        <div class="oa-vid-body">
          <video class="oa-vid-video" playsinline></video>
        </div>
        <div class="oa-vid-footer">
          <div class="oa-vid-status">Idle</div>
          <div class="oa-vid-actions">
            <button class="oa-vid-action" data-act="fullscreen">Fullscreen</button>
          </div>
        </div>
      </div>`;
    root.appendChild(backdrop);

    const modal = backdrop.querySelector('.oa-vid-modal');
    const header = backdrop.querySelector('.oa-vid-header');
    const body = backdrop.querySelector('.oa-vid-body');
    const footer = backdrop.querySelector('.oa-vid-footer');
    const video = backdrop.querySelector('.oa-vid-video');
    const status = backdrop.querySelector('.oa-vid-status');
    const fullscreenBtn = backdrop.querySelector('[data-act=fullscreen]');

    video.setAttribute('controlsList', 'nodownload noplaybackrate nofullscreen');
    video.setAttribute('disablePictureInPicture', 'true');
    video.controls = false;

    const suppressContextMenu = (event) => {
      event.preventDefault();
      event.stopPropagation();
    };
    video.addEventListener('contextmenu', suppressContextMenu);
    video.addEventListener('dragstart', suppressContextMenu);
    backdrop.addEventListener('contextmenu', (event) => {
      if (event.target === video || video.contains(event.target)) {
        suppressContextMenu(event);
      }
    });

    fullscreenBtn.addEventListener('click', toggleFullscreen);

    return {
      backdrop,
      modal,
      header,
      body,
      footer,
      video,
      status,
      fullscreenBtn,
    };
  }

  function toggleModalChrome(active) {
    if (!ui) return;
    const { modal, header, body, footer } = ui;
    if (!modal || !header || !body || !footer) return;

    if (active) {
      modal.classList.add('is-fullscreen');
      body.classList.add('is-fullscreen');
      header.classList.add('is-hidden');
      footer.classList.add('is-hidden');
    } else {
      modal.classList.remove('is-fullscreen');
      body.classList.remove('is-fullscreen');
      header.classList.remove('is-hidden');
      footer.classList.remove('is-hidden');
    }
  }

  let ui = null;
  function showModal() {
    if (!ui) ui = createModal();
    bindFullscreenListeners();
    syncFullscreenState();
    ui.backdrop.style.display = 'flex';
    dbg('Modal shown');
  }
  function hideModal() {
    if (!ui) return;
    clearPendingPlayRetry();
    exitFullscreen();
    ui.backdrop.style.display = 'none';
    suppressPauseEvent = true;
    ui.video.pause();
    queueMicrotask(() => { suppressPauseEvent = false; });
    seekVersion += 1;
    ui.video.src = '';
    serverPaused = false;
    backendVolume = 1.0;
    backendMuted = false;
    playAutoclose = false;
    lastAppliedVolume = null;
    lastAppliedMuted = null;
    stopVolumeSync();
    syncFullscreenState();
    desiredPositionMs = 0;
    unbindFullscreenListeners();
    toggleModalChrome(false);
    setStatus('Idle');
    clearPlaylist('hide');
    preloadedSource = null;
    pendingInitPayload = null;
    pendingModalReveal = false;
    pendingPlayPayload = null;
    dbg('Modal hidden');
  }

  // ---------- Clock sync + drift handling ----------
  let timeOffsetMs = 0; // serverEpochMs - clientNow
  function updateTimeOffsetFromPing(serverEpochMs) {
    const clientNow = Date.now();
    // Basic 1-way estimate; for more accuracy, implement round-trip.
    timeOffsetMs = serverEpochMs - clientNow;
  }
  function nowServerMs() {
    return Date.now() + timeOffsetMs;
  }

  // ---------- WebSocket to YOUR backend ----------
  const debug = {
    ping: () => 'pong',
    wsReadyState: () => ws?.readyState ?? WebSocket.CLOSED,
    reconnect: () => {
      if (!currentToken) return false;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.close();
        return true;
      }
      connectWS(currentToken, { force: true });
      return true;
    },
    modalVisible: () => Boolean(ui && ui.backdrop.style.display !== 'none'),
    wsUrl: () => VIDEO_WS_URL,
    identity: () => identityCache || getOAIdentity(),
    refreshIdentity: () => refreshIdentityCache(),
    fullscreen: {
      enter: enterFullscreen,
      exit: exitFullscreen,
      toggle: toggleFullscreen,
    },
    autoplayReady: () => autoplayReady,
    queuedPlay: () => queuedPlayRequest,
    flushAutoplayQueue: () => flushQueuedPlay(),
    resetAutoplayQueue: () => { queuedPlayRequest = false; },
  };
  window.__oaVideoExtensionDebug = debug;
  function connectWS(token, { force = false } = {}) {
    if (force) dbg('Forcing reconnect');
    if (!force && currentToken === token && ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      dbg('Reusing existing socket for token');
      return;
    }
    currentToken = token;
    identityCache = refreshIdentityCache({ notify: false });
    const url = new URL(VIDEO_WS_URL);
    url.searchParams.set('token', token);
    if (identityCache?.playerUuid) {
      url.searchParams.set('playerUuid', identityCache.playerUuid);
    } else if (identityCache?.playerName) {
      url.searchParams.set('playerName', identityCache.playerName);
    }

    const identityLog = identityCache?.playerName || identityCache?.playerUuid || 'unknown-player';
    dbg('Connecting to backend', url.toString(), 'token', token ? `${token.slice(0, 4)}…` : '(empty)', 'identity', identityLog);
    ws = new WebSocket(url);

    ws.onopen = () => {
      dbg('WebSocket established');
      const identity = refreshIdentityCache({ notify: false });
      const hello = {
        type: 'HELLO',
        tClient: Date.now(),
      };
      if (identity) {
        hello.playerId = identity.playerUuid || identity.playerName || null;
        hello.playerName = identity.playerName || null;
        hello.playerUuid = identity.playerUuid || null;
        hello.publicServerKey = identity.publicServerKey || null;
        hello.scope = identity.scope || null;
      }
      send(hello);
      if (identity) {
        const update = identityUpdatePayload(identity);
        if (update) send(update);
      }
    };

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        dbg('Message from backend', msg.type);
        handleMessage(msg);
      } catch (e) {
        // Ignore bad messages
      }
    };

    ws.onclose = (event) => {
      dbg('Socket closed; scheduling reconnect', `code=${event.code}`, event.reason || '');
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => connectWS(token), 3000);
    };

    ws.onerror = () => {
      dbg('Socket error');
      ws.close();
    };
  }

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  }

  // ---------- Video sync engine ----------
  let sourceUrl = null;
  let startedAtEpochMs = null; // When should the video time = 0
  let serverPaused = false; // When true, keep playback halted until backend resumes
  let backendVolume = 1.0;
  let backendMuted = false;
  let suppressPauseEvent = false;
  let suppressPlayEvent = false;
  let volumeSyncTimer = null;
  let lastAppliedVolume = null;
  let lastAppliedMuted = null;
  let seekVersion = 0;
  let fullscreenActive = false;
  let fullscreenListenersBound = false;
  let suppressSeekGuard = false;
  let desiredPositionMs = 0;
  let playAutoclose = false;

  const DEFAULT_CLIENT_VOLUME = 0.35;

  function setStatus(text) { if (ui) ui.status.textContent = text; }

  function clamp01(value) {
    if (!Number.isFinite(value)) return 0;
    return Math.min(Math.max(value, 0), 1);
  }

  function deriveClientVolume() {
    const fromWindow = [
      window.__oa?.settings?.normalVolume,
      window.OpenAudioMc?.settings?.normalVolume,
      window.__oa?.state?.settings?.normalVolume,
      window.OpenAudioMc?.state?.settings?.normalVolume,
    ].find((val) => typeof val === 'number' && !Number.isNaN(val));

    if (fromWindow != null) {
      return clamp01(fromWindow / 100);
    }

    const cookieMatch = document.cookie.match(/(?:^|;\s*)setting_normalVolume=([^;]+)/);
    if (cookieMatch) {
      const parsed = parseFloat(decodeURIComponent(cookieMatch[1]));
      if (Number.isFinite(parsed)) {
        return clamp01(parsed / 100);
      }
    }

    return DEFAULT_CLIENT_VOLUME;
  }

  function applyClientVolume() {
    if (!ui || !ui.video) return;
    const clientVolume = deriveClientVolume();
    const combined = clamp01(clientVolume * backendVolume);
    const shouldMute = backendMuted || combined === 0;

    if (lastAppliedVolume !== combined) {
      ui.video.volume = combined;
      lastAppliedVolume = combined;
      dbg('Applied combined volume', combined.toFixed(3));
    }

    if (lastAppliedMuted !== shouldMute) {
      ui.video.muted = shouldMute;
      lastAppliedMuted = shouldMute;
      dbg('Applied mute state', shouldMute);
    }
  }

  function startVolumeSync() {
    applyClientVolume();
    if (volumeSyncTimer) return;
    volumeSyncTimer = setInterval(applyClientVolume, 2000);
  }

  function stopVolumeSync() {
    if (volumeSyncTimer) {
      clearInterval(volumeSyncTimer);
      volumeSyncTimer = null;
    }
  }

  function safePlay() {
    if (!ui || !ui.video) return;
    clearPendingPlayRetry();
    suppressPlayEvent = true;
    queuedPlayRequest = false;
    const playPromise = ui.video.play();
    if (playPromise && typeof playPromise.then === 'function') {
      playPromise.catch((err) => {
        const errorName = err?.name || '';
        dbg('Autoplay prevented or failed', errorName || err);
        if (errorName === 'AbortError') {
          dbg('Playback aborted during start; retrying shortly');
          schedulePlayRetry(250);
          return;
        }
        queuedPlayRequest = true;
        setStatus('Waiting for activation');
      }).finally(() => {
        suppressPlayEvent = false;
      });
    } else {
      suppressPlayEvent = false;
    }
  }

  function safePause() {
    if (!ui || !ui.video) return;
    clearPendingPlayRetry();
    suppressPauseEvent = true;
    ui.video.pause();
    queueMicrotask(() => { suppressPauseEvent = false; });
  }

  function normalizeStartEpoch(rawStart) {
    const numeric = Number(rawStart);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      const fallback = nowServerMs();
      dbg('startAtEpochMs missing or invalid, defaulting to current server time');
      return fallback;
    }
    if (numeric < 1e11) {
      const fallback = nowServerMs() - numeric;
      dbg('Interpreting startAtEpochMs as offset (ms)', numeric);
      return fallback;
    }
    return numeric;
  }

  function updateStartEpochForPosition(positionMs) {
    const numeric = Number(positionMs);
    if (!Number.isFinite(numeric)) return;
    startedAtEpochMs = nowServerMs() - numeric;
    desiredPositionMs = Math.max(numeric, 0);
  }

  function jumpToPosition(positionMs) {
    if (!ui || !ui.video) return;
    const durationSeconds = Number.isFinite(ui.video.duration)
      ? Math.max(0, ui.video.duration)
      : Infinity;
    const rawSeconds = Number(positionMs) / 1000;
    if (!Number.isFinite(rawSeconds)) return;

    const clampedSeconds = Math.min(Math.max(rawSeconds, 0), Math.max(0, durationSeconds - 0.25));
    desiredPositionMs = Math.max(clampedSeconds * 1000, 0);

    const version = ++seekVersion;
    const apply = () => {
      if (!ui || !ui.video) return;
      if (seekVersion !== version) return;
      const delta = Math.abs(ui.video.currentTime - clampedSeconds);
      if (delta > 0.05) {
        suppressSeekGuard = true;
        ui.video.currentTime = clampedSeconds;
        queueMicrotask(() => { suppressSeekGuard = false; });
      }
    };

    if (ui.video.readyState >= 1) {
      apply();
    } else {
      ui.video.addEventListener('loadedmetadata', function handleMeta() {
        ui.video.removeEventListener('loadedmetadata', handleMeta);
        if (seekVersion === version) apply();
      });
    }

    queueMicrotask(apply);
    setTimeout(apply, 120);
    setTimeout(apply, 320);
  }

  function fullscreenElement() {
    return document.fullscreenElement || document.webkitFullscreenElement || null;
  }

  function syncFullscreenState() {
    const active = Boolean(fullscreenElement());
    fullscreenActive = active;
    if (ui?.fullscreenBtn) {
      ui.fullscreenBtn.textContent = active ? 'Exit Fullscreen' : 'Fullscreen';
    }
    toggleModalChrome(active);
  }

  async function requestFullscreen(element) {
    if (!element) return;
    try {
      if (element.requestFullscreen) {
        await element.requestFullscreen();
      } else if (element.webkitRequestFullscreen) {
        element.webkitRequestFullscreen();
      }
    } catch (err) {
      dbg('Fullscreen request failed', err?.message || err);
    }
  }

  function exitFullscreen() {
    const activeElement = fullscreenElement();
    if (!activeElement) {
      syncFullscreenState();
      return;
    }
    if (document.exitFullscreen) {
      document.exitFullscreen().catch(() => {}).finally(() => {
        queueMicrotask(syncFullscreenState);
      });
    } else if (document.webkitExitFullscreen) {
      try { document.webkitExitFullscreen(); } catch (err) { /* ignore */ }
      queueMicrotask(syncFullscreenState);
    }
    toggleModalChrome(false);
  }

  function bindFullscreenListeners() {
    if (fullscreenListenersBound) return;
    document.addEventListener('fullscreenchange', syncFullscreenState);
    document.addEventListener('webkitfullscreenchange', syncFullscreenState);
    fullscreenListenersBound = true;
  }

  function unbindFullscreenListeners() {
    if (!fullscreenListenersBound) return;
    document.removeEventListener('fullscreenchange', syncFullscreenState);
    document.removeEventListener('webkitfullscreenchange', syncFullscreenState);
    fullscreenListenersBound = false;
  }

  async function enterFullscreen() {
    if (!ui) return;
    const target = ui.modal || ui.backdrop?.querySelector('.oa-vid-modal');
    if (!target) return;
    await requestFullscreen(target);
    syncFullscreenState();
  }

  function toggleFullscreen() {
    if (fullscreenActive) {
      exitFullscreen();
    } else {
      enterFullscreen();
    }
  }

  function normalizeVideoUrl(url) {
    try {
      return new URL(url, window.location.href).href;
    } catch (err) {
      return url;
    }
  }

  async function preloadVideo({ url }) {
    if (!url) return false;
    if (!ui) ui = createModal();
    const { video, backdrop } = ui;
    if (!video) return false;

    if (backdrop && backdrop.style.display !== 'none') {
      dbg('Skipping preload while modal visible');
      return false;
    }

    const normalized = normalizeVideoUrl(url);
    const alreadyLoaded = video.src === normalized && video.readyState >= 1;

    if (video.src !== normalized) {
      video.src = normalized;
    }

    if (!alreadyLoaded) {
      await new Promise((resolve) => {
        let settled = false;
        const cleanup = () => {
          if (settled) return;
          settled = true;
          video.removeEventListener('loadeddata', handleLoaded);
          video.removeEventListener('canplay', handleLoaded);
          video.removeEventListener('error', handleDone);
          video.removeEventListener('abort', handleDone);
          resolve();
        };
        const handleLoaded = () => cleanup();
        const handleDone = () => cleanup();
        video.addEventListener('loadeddata', handleLoaded, { once: true });
        video.addEventListener('canplay', handleLoaded, { once: true });
        video.addEventListener('error', handleDone, { once: true });
        video.addEventListener('abort', handleDone, { once: true });
        try {
          video.load();
        } catch (err) {
          cleanup();
        }
      });
    }

    suppressPauseEvent = true;
    try { video.pause(); } catch { /* ignore */ }
    queueMicrotask(() => { suppressPauseEvent = false; });
    try { video.currentTime = 0; } catch { /* ignore */ }

    preloadedSource = {
      normalized,
      url,
      timestamp: Date.now(),
    };
    dbg('Preloaded video source', normalized);
    send({
      type: 'VIDEO_STATE',
      state: 'preloaded',
      positionMs: 0,
      bufferedMs: 0,
    });
    return true;
  }

  async function initVideo(payload = {}, options = {}) {
    const opts = {
      fromPlaylist: false,
      allowBeforeAutoplay: false,
      showModal: true,
      forceAutoclose: null,
      ...options,
    };

    const {
      url,
      startAtEpochMs,
      muted = false,
      volume = 1.0,
    } = payload;

    if (!url) {
      dbg('Ignoring VIDEO_INIT without url');
      return false;
    }

    if (!opts.fromPlaylist) {
      clearPlaylist('external-init');
    }

    const normalizedUrl = normalizeVideoUrl(url);
    const shouldDelay = !autoplayReady && !opts.allowBeforeAutoplay;
    if (shouldDelay) {
      pendingInitPayload = { payload, options: opts };
      if (opts.showModal !== false) pendingModalReveal = true;
      dbg('Deferring video init until OA client activated');
      return false;
    }

    pendingInitPayload = null;

    if (!ui) ui = createModal();
    const { video } = ui;
    if (!video) return false;

    const shouldShowModal = opts.showModal !== false && autoplayReady;
    if (shouldShowModal) {
      showModal();
    } else if (opts.showModal !== false) {
      pendingModalReveal = true;
    }

    dbg('Initializing video', { url, startAtEpochMs, muted, volume, fromPlaylist: opts.fromPlaylist });

    sourceUrl = url;
    backendMuted = Boolean(muted);
    backendVolume = clamp01(typeof volume === 'number' ? volume : 1.0);
    const forcedAutoclose = opts.forceAutoclose != null
      ? Boolean(opts.forceAutoclose)
      : Boolean(payload.autoclose);
    playAutoclose = forcedAutoclose;

    serverPaused = true;
    lastAppliedVolume = null;
    lastAppliedMuted = null;
    startedAtEpochMs = normalizeStartEpoch(startAtEpochMs);
    desiredPositionMs = 0;

    const canReusePreload = preloadedSource
      && preloadedSource.normalized === normalizedUrl
      && video.readyState >= 1;

    if (!canReusePreload || video.src !== normalizedUrl) {
      try {
        video.src = normalizedUrl;
        await video.load?.();
      } catch (err) {
        dbg('Video load error', err?.message || err);
      }
    } else {
      dbg('Reusing preloaded video source', normalizedUrl);
      suppressPauseEvent = true;
      try { video.pause(); } catch { /* ignore */ }
      queueMicrotask(() => { suppressPauseEvent = false; });
      try { video.currentTime = 0; } catch { /* ignore */ }
    }

    if (!canReusePreload) {
      preloadedSource = null;
    }

    applyClientVolume();
    startVolumeSync();

    setStatus('Ready');
    send({
      type: 'VIDEO_STATE',
      state: 'ready',
      positionMs: 0,
      bufferedMs: 0,
    });

    resyncToServerClock(true);
    return true;
  }

  function applyPlayPayload(msg = {}, options = {}) {
    const receivedAtRaw = options && typeof options.receivedAtMs === 'number' ? options.receivedAtMs : NaN;
    const receivedAtMs = Number.isFinite(receivedAtRaw) ? receivedAtRaw : Date.now();

    const elapsedSinceReceipt = Math.max(0, Date.now() - receivedAtMs);
    const hasServerEpoch = typeof msg.serverEpochMs === 'number' && Number.isFinite(msg.serverEpochMs);
    const effectiveServerEpochMs = hasServerEpoch
      ? msg.serverEpochMs + elapsedSinceReceipt
      : null;

    if (effectiveServerEpochMs != null) {
      updateTimeOffsetFromPing(effectiveServerEpochMs);
    }

    const forcedAutoclose = options?.forceAutoclose;
    if (typeof msg.autoclose === 'boolean') {
      playAutoclose = forcedAutoclose != null ? Boolean(forcedAutoclose) : msg.autoclose;
    } else if (forcedAutoclose != null) {
      playAutoclose = Boolean(forcedAutoclose);
    }

    if (typeof msg.volume === 'number') {
      backendVolume = clamp01(msg.volume);
      lastAppliedVolume = null;
    }
    if (typeof msg.muted === 'boolean') {
      backendMuted = msg.muted;
      lastAppliedMuted = null;
    }
    applyClientVolume();

    const hasAtPosition = typeof msg.atMs === 'number' && Number.isFinite(msg.atMs);
    let effectiveAtMs = hasAtPosition ? msg.atMs : null;
    if (effectiveAtMs != null) {
      if (hasServerEpoch && effectiveServerEpochMs != null) {
        const delta = effectiveServerEpochMs - msg.serverEpochMs;
        if (Number.isFinite(delta) && delta > 0) {
          effectiveAtMs += delta;
        }
      }
      updateStartEpochForPosition(effectiveAtMs);
      jumpToPosition(effectiveAtMs);
    }

    serverPaused = false;
    resyncToServerClock(true);

    const clonedPayload = { ...msg };
    const clonedOptions = options ? { ...options } : {};
    if (!Number.isFinite(clonedOptions.receivedAtMs)) {
      clonedOptions.receivedAtMs = receivedAtMs;
    }

    if (!autoplayReady) {
      queuedPlayRequest = true;
      setStatus('Waiting for activation');
      if (pendingInitPayload) {
        const initOptions = pendingInitPayload.options || (pendingInitPayload.options = {});
        if (!initOptions.postPlay) {
          initOptions.postPlay = { payload: clonedPayload, options: clonedOptions };
        } else {
          pendingPlayPayload = { payload: clonedPayload, options: clonedOptions };
        }
      } else {
        pendingPlayPayload = { payload: clonedPayload, options: clonedOptions };
      }
      return;
    }

    const hasPendingOtherPlay = Boolean(pendingPlayPayload && pendingPlayPayload.payload !== msg);
    if (pendingPlayPayload && pendingPlayPayload.payload === msg) {
      pendingPlayPayload = null;
    }
    if (!hasPendingOtherPlay) {
      queuedPlayRequest = false;
    }
    setStatus('Starting…');
    safePlay();
  }

  function applyPausePayload(msg = {}) {
    serverPaused = true;
    exitFullscreen();
    if (typeof msg.autoclose === 'boolean') {
      playAutoclose = msg.autoclose;
    }
    queuedPlayRequest = false;
    if (typeof msg.volume === 'number') {
      backendVolume = clamp01(msg.volume);
      lastAppliedVolume = null;
    }
    if (typeof msg.muted === 'boolean') {
      backendMuted = msg.muted;
      lastAppliedMuted = null;
    }
    applyClientVolume();
    if (typeof msg.atMs === 'number') {
      updateStartEpochForPosition(msg.atMs);
      jumpToPosition(msg.atMs);
      resyncToServerClock(true);
    }
    safePause();
    setStatus('Paused');
  }

  function applySeekPayload(msg = {}) {
    if (typeof msg.toMs !== 'number') return;
    const atMs = msg.toMs;
    applyPlayPayload({
      atMs,
      volume: msg.volume,
      muted: msg.muted,
      autoclose: msg.autoclose,
    }, { forceAutoclose: msg.autoclose, receivedAtMs: Date.now() });
    if (autoplayReady) {
      sendState('playing');
    }
  }

  function normalizePlaylistItems(items) {
    if (!Array.isArray(items)) return [];
    return items.map((raw) => {
      if (!raw || typeof raw !== 'object' || !raw.url) return null;
      const entry = {
        url: raw.url,
        volume: typeof raw.volume === 'number' ? clamp01(raw.volume) : 1.0,
        muted: typeof raw.muted === 'boolean' ? raw.muted : false,
      };
      if (typeof raw.autoclose === 'boolean') entry.autoclose = raw.autoclose;
      if (Number.isFinite(raw.atMs)) entry.atMs = raw.atMs;
      return entry;
    }).filter(Boolean);
  }

  async function advancePlaylist() {
    if (!activePlaylist || !Array.isArray(activePlaylist.items) || !activePlaylist.items.length) {
      clearPlaylist('advance-empty');
      return false;
    }
    if (activePlaylist.loading) {
      dbg('Playlist advance skipped while loading');
      return true;
    }

    const currentIndex = typeof activePlaylist.index === 'number' ? activePlaylist.index : -1;
    const nextIndex = currentIndex + 1;
    if (nextIndex >= activePlaylist.items.length) {
      clearPlaylist('playlist-complete');
      return false;
    }

    const item = activePlaylist.items[nextIndex];
    const isLast = nextIndex === activePlaylist.items.length - 1;
    const forcedAutoclose = item.autoclose != null ? Boolean(item.autoclose) : isLast;
    const receivedAtMs = Date.now();
    const playPayload = {
      type: 'VIDEO_PLAY',
      serverEpochMs: Date.now(),
      atMs: Number.isFinite(item.atMs) ? item.atMs : 0,
      volume: item.volume,
      muted: item.muted,
      autoclose: forcedAutoclose,
    };

    const postPlay = {
      payload: playPayload,
      options: { forceAutoclose: forcedAutoclose, receivedAtMs },
      onApplied: () => {
        if (activePlaylist) {
          activePlaylist.pendingPlay = null;
        }
      },
    };

    activePlaylist.loading = true;
    try {
      const initResult = await initVideo({
        type: 'VIDEO_INIT',
        url: item.url,
        startAtEpochMs: Date.now(),
        muted: item.muted,
        volume: item.volume,
        autoclose: forcedAutoclose,
      }, { fromPlaylist: true, forceAutoclose: forcedAutoclose, postPlay });
      activePlaylist.index = nextIndex;
      if (initResult === false) {
        activePlaylist.pendingPlay = playPayload;
        dbg('Playlist item queued until activation', { index: nextIndex });
        return true;
      }
      activePlaylist.pendingPlay = null;
      applyPlayPayload(playPayload, { forceAutoclose: forcedAutoclose, receivedAtMs });
      postPlay.onApplied();
      return true;
    } catch (err) {
      dbg('Failed to start playlist item', err?.message || err);
      clearPlaylist('failed');
      return false;
    } finally {
      if (activePlaylist) activePlaylist.loading = false;
    }
  }

  function startPlaylist(rawItems = []) {
    const normalized = normalizePlaylistItems(rawItems);
    if (!normalized.length) {
      dbg('Ignoring empty playlist initialization');
      return;
    }
    clearPlaylist('new-playlist');
    activePlaylist = {
      items: normalized,
      index: -1,
      loading: false,
      pendingPlay: null,
    };
    setStatus('Preparing playlist…');
    Promise.resolve()
      .then(() => advancePlaylist())
      .catch((err) => {
        dbg('Playlist start failed', err?.message || err);
        clearPlaylist('failed-start');
      });
  }

  function resyncToServerClock(force = false) {
    if (!ui || !ui.video || startedAtEpochMs == null) return;
    if (serverPaused && !force) return;
    if (ui.video.readyState < 1) return;
    const serverNow = nowServerMs();
    const targetMs = Math.max(0, serverNow - startedAtEpochMs);
    const curMs = (ui.video.currentTime || 0) * 1000;

    const durationMs = Number.isFinite(ui.video.duration)
      ? Math.max(0, ui.video.duration * 1000)
      : Infinity;
    const clampedTargetMs = Math.min(targetMs, Math.max(0, durationMs - 250));
    const drift = clampedTargetMs - curMs;
    desiredPositionMs = clampedTargetMs;

    if (Math.abs(drift) > 250) { // allow small jitter
      suppressSeekGuard = true;
      ui.video.currentTime = clampedTargetMs / 1000;
      queueMicrotask(() => { suppressSeekGuard = false; });
    }
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case 'PING':
        updateTimeOffsetFromPing(msg.t);
        send({ type: 'PONG', tClient: Date.now(), tServer: msg.t });
        break;

      case 'VIDEO_PRELOAD':
        preloadVideo(msg);
        break;

      case 'VIDEO_PLAYLIST_INIT':
        startPlaylist(msg.items || []);
        break;

      case 'VIDEO_INIT':
        initVideo(msg);
        break;

      case 'VIDEO_PLAY':
        clearPlaylist('server-play');
        applyPlayPayload(msg, { receivedAtMs: Date.now() });
        break;

      case 'VIDEO_PAUSE':
        applyPausePayload(msg);
        break;

      case 'VIDEO_SEEK':
        applySeekPayload(msg);
        break;

      case 'VIDEO_CLOSE':
        clearPlaylist('server-close');
        exitFullscreen();
        queuedPlayRequest = false;
        hideModal();
        break;

      default:
        // Unknown message type - ignore
    }
  }

  // Periodic drift correction while playing
  setInterval(() => {
    if (!ui || !ui.video || ui.backdrop.style.display === 'none') return;
    if (!serverPaused && !ui.video.paused) resyncToServerClock();
  }, 1000);

  // Emit local state -> backend (optional, useful for dashboards)
  function wireVideoEvents() {
    if (!ui) return;
    const v = ui.video;
    v.addEventListener('play', () => {
      const wasSuppressed = suppressPlayEvent;
      if (suppressPlayEvent) suppressPlayEvent = false;

      queuedPlayRequest = false;

      if (serverPaused) {
        dbg('Blocking local play while server paused');
        safePause();
        return;
      }

      setStatus('Playing');
      sendState('playing');

      if (!wasSuppressed) {
        dbg('Video started via user gesture while allowed');
      }
    });
    v.addEventListener('pause', () => {
      const wasSuppressed = suppressPauseEvent;
      if (suppressPauseEvent) suppressPauseEvent = false;

      if (wasSuppressed) {
        if (serverPaused) {
          setStatus('Paused');
          sendState('paused');
        }
        return;
      }

      if (!serverPaused) {
        dbg('User attempted to pause; resuming playback');
        safePlay();
        return;
      }

      setStatus('Paused');
      sendState('paused');
    });
    v.addEventListener('ended', () => {
      serverPaused = true;
      exitFullscreen();
      setStatus('Ended');
      sendState('ended');
      if (activePlaylist) {
        Promise.resolve()
          .then(() => advancePlaylist())
          .then((advanced) => {
            if (!advanced && playAutoclose) hideModal();
          })
          .catch((err) => {
            dbg('Failed to advance playlist', err?.message || err);
            if (playAutoclose) hideModal();
          });
      } else if (playAutoclose) {
        hideModal();
      }
    });
    v.addEventListener('seeking', () => {
      if (suppressSeekGuard) return;
      if (!fullscreenActive) return;
      suppressSeekGuard = true;
      const targetSeconds = (desiredPositionMs || 0) / 1000;
      if (Number.isFinite(targetSeconds)) {
        v.currentTime = targetSeconds;
      }
      queueMicrotask(() => { suppressSeekGuard = false; });
    });
    v.addEventListener('timeupdate', throttle(() => sendState(v.paused ? 'paused' : 'playing'), 1000));
  }

  function sendState(state) {
    if (!ui) return;
    const v = ui.video;
    send({
      type: 'VIDEO_STATE',
      state,
      positionMs: Math.floor(v.currentTime * 1000),
      bufferedMs: v.buffered?.length ? Math.floor((v.buffered.end(v.buffered.length - 1) - v.buffered.start(0)) * 1000) : 0,
    });
  }

  function throttle(fn, interval) {
    let last = 0;
    return function throttled(...args) {
      const now = Date.now();
      if (now - last >= interval) {
        last = now;
        fn.apply(this, args);
      }
    };
  }

  // ---------- Boot ----------
  onReady(() => {
    injectStyles();
    ui = createModal();
    wireVideoEvents();

    refreshIdentityCache({ notify: false });
    if (!identityWatcher) {
      identityWatcher = setInterval(() => refreshIdentityCache(), 2000);
    }

    const token = getOAToken();
    if (token) {
      dbg('Token detected during boot, connecting');
      connectWS(token);
      return;
    }

    // Poll for token if it becomes available after OA bootstraps
    tokenPollTimer = setInterval(() => {
      const discovered = getOAToken();
      if (discovered) {
        clearInterval(tokenPollTimer);
        tokenPollTimer = null;
        dbg('Token detected after bootstrap, connecting');
        refreshIdentityCache({ notify: false });
        connectWS(discovered);
      }
    }, 1000);
    dbg('Waiting for OA token before connecting');
  });
}());
