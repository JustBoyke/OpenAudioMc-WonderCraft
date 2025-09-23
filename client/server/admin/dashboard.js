(() => {
  const state = {
    adminKey: localStorage.getItem('oaVideoAdminKey') || '',
    pollTimer: null,
    lastConnections: [],
    lastRegions: [],
    activeTab: 'connections',
    adminWs: null,
    wsConnected: false,
    wsReconnectAttempts: 0,
  };

  const basePath = (() => {
    const path = window.location.pathname || '';
    const marker = '/admin/';
    const idx = path.indexOf(marker);
    if (idx >= 0) {
      return path.slice(0, idx);
    }
    return '';
  })();

  const adminKeyInput = document.getElementById('adminKey');
  const applyKeyBtn = document.getElementById('applyKey');
  const refreshBtn = document.getElementById('refreshNow');
  const statusText = document.getElementById('statusText');
  const connCountEl = document.getElementById('connCount');
  const activeCountEl = document.getElementById('activeCount');
  const lastRefreshEl = document.getElementById('lastRefresh');
  const regionCountEl = document.getElementById('regionCount');
  const connectionsBody = document.getElementById('connectionsBody');
  const regionsBody = document.getElementById('regionsBody');
  const tabButtons = Array.from(document.querySelectorAll('.tab-button'));
  const connectionsSection = document.getElementById('connectionsSection');
  const regionsSection = document.getElementById('regionsSection');
  const modal = document.getElementById('authModal');
  const modalAdminKey = document.getElementById('modalAdminKey');
  const modalApply = document.getElementById('modalApply');
  const modalCancel = document.getElementById('modalCancel');
  const logoutKeyBtn = document.getElementById('logoutKey');
  const playModal = document.getElementById('playModal');
  const playUrlInput = document.getElementById('playUrl');
  const playAutocloseInput = document.getElementById('playAutoclose');
  const playConfirmBtn = document.getElementById('playConfirm');
  const playCancelBtn = document.getElementById('playCancel');

  let pendingPlayTarget = null;

  adminKeyInput.value = state.adminKey;

  function setActiveTab(tab) {
    state.activeTab = tab;
    if (tabButtons.length) {
      tabButtons.forEach((button) => {
        const targetTab = button.dataset.tab;
        if (!targetTab) return;
        if (targetTab === tab) {
          button.classList.add('active');
        } else {
          button.classList.remove('active');
        }
      });
    }
    if (connectionsSection) {
      connectionsSection.classList.toggle('hidden', tab !== 'connections');
    }
    if (regionsSection) {
      regionsSection.classList.toggle('hidden', tab !== 'regions');
    }
  }

  function setStatus(message, variant = '') {
    statusText.textContent = message;
    if (variant) {
      statusText.dataset.variant = variant;
    } else {
      delete statusText.dataset.variant;
    }
  }

  function connectAdminWs() {
    if (!state.adminKey) return;
    try { if (state.adminWs && state.adminWs.readyState === WebSocket.OPEN) return; } catch {}

    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const wsUrl = `${proto}://${window.location.host}${basePath}/ws/admin?key=${encodeURIComponent(state.adminKey)}`;

    let ws;
    try {
      ws = new WebSocket(wsUrl);
    } catch {
      return; // fallback to polling
    }
    state.adminWs = ws;

    ws.onopen = () => {
      state.wsConnected = true;
      state.wsReconnectAttempts = 0;
      setStatus('Live updates connected', 'ok');
    };

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (!msg || typeof msg !== 'object') return;
        switch (msg.type) {
          case 'ADMIN_SNAPSHOT':
            if (Array.isArray(msg.connections)) state.lastConnections = msg.connections;
            if (Array.isArray(msg.regions)) state.lastRegions = msg.regions;
            renderConnectionRows(state.lastConnections);
            renderRegionRows(state.lastRegions);
            connCountEl.textContent = state.lastConnections.length;
            if (regionCountEl) {
              const activeRegions = state.lastRegions.filter((r) => r.activeMedia).length;
              regionCountEl.textContent = activeRegions;
            }
            lastRefreshEl.textContent = new Date().toLocaleTimeString();
            break;
          case 'ADMIN_CONNECTIONS':
            if (Array.isArray(msg.connections)) {
              state.lastConnections = msg.connections;
              renderConnectionRows(state.lastConnections);
              connCountEl.textContent = state.lastConnections.length;
              lastRefreshEl.textContent = new Date().toLocaleTimeString();
            }
            break;
          case 'ADMIN_REGIONS':
            if (Array.isArray(msg.regions)) {
              state.lastRegions = msg.regions;
              renderRegionRows(state.lastRegions);
              if (regionCountEl) {
                const activeRegions = state.lastRegions.filter((r) => r.activeMedia).length;
                regionCountEl.textContent = activeRegions;
              }
              lastRefreshEl.textContent = new Date().toLocaleTimeString();
            }
            break;
          default:
            break;
        }
      } catch { /* ignore */ }
    };

    ws.onclose = () => {
      state.wsConnected = false;
      state.adminWs = null;
      const attempt = (state.wsReconnectAttempts || 0) + 1;
      state.wsReconnectAttempts = attempt;
      const delay = Math.min(15000, 500 * Math.pow(2, attempt));
      setTimeout(() => {
        if (state.adminKey) connectAdminWs();
      }, delay);
    };

    ws.onerror = () => {
      // handled by onclose
    };
  }

  function getHeaders() {
    if (!state.adminKey) return {};
    return {
      'Content-Type': 'application/json',
      'x-admin-key': state.adminKey,
    };
  }

  function formatMs(ms) {
    if (!Number.isFinite(ms)) return '—';
    const totalSeconds = Math.max(Math.floor(ms / 1000), 0);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  }

  function formatAgo(timestamp) {
    if (!timestamp) return '—';
    const delta = Date.now() - timestamp;
    if (delta < 1000) return 'just now';
    const seconds = Math.floor(delta / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  function computePosition(media) {
    if (!media) {
      return { status: 'idle', positionMs: 0 };
    }
    const state = media.state || {};
    const now = Date.now();
    if (state.status === 'playing') {
      const pos = Math.max(now - (state.startedAtEpochMs ?? now), 0);
      return { status: 'playing', positionMs: pos };
    }
    if (state.status === 'paused') {
      return { status: 'paused', positionMs: state.pausedAtMs ?? 0 };
    }
    return { status: state.status || 'idle', positionMs: 0 };
  }

  // Preserve in-row input state across refreshes
  function captureInputState(tbody, keyAttr) {
    const snapshot = new Map();
    if (!tbody) return snapshot;
    const rows = Array.from(tbody.querySelectorAll('tr'));
    rows.forEach((row) => {
      const key = row.dataset && row.dataset[keyAttr];
      if (!key) return;
      const input = row.querySelector('input[type="text"]');
      if (!input) return;
      const isFocused = document.activeElement === input;
      let selStart = null;
      let selEnd = null;
      try {
        selStart = input.selectionStart;
        selEnd = input.selectionEnd;
      } catch { /* ignore */ }
      snapshot.set(key, {
        value: input.value,
        focused: isFocused,
        selStart,
        selEnd,
      });
    });
    return snapshot;
  }

  function restoreInputState(tbody, keyAttr, snapshot) {
    if (!tbody || !snapshot || snapshot.size === 0) return;
    const rows = Array.from(tbody.querySelectorAll('tr'));
    rows.forEach((row) => {
      const key = row.dataset && row.dataset[keyAttr];
      if (!key) return;
      const saved = snapshot.get(key);
      if (!saved) return;
      const input = row.querySelector('input[type="text"]');
      if (!input) return;
      // Only restore if user hasn't typed something new in this exact refresh window
      input.value = saved.value;
      if (saved.focused) {
        input.focus({ preventScroll: true });
        try {
          if (saved.selStart != null && saved.selEnd != null) {
            input.setSelectionRange(saved.selStart, saved.selEnd);
          }
        } catch { /* ignore */ }
      }
    });
  }

  function promptFallback(prefill = '') {
    const value = window.prompt('Enter admin key', prefill || state.adminKey || '');
    if (value == null) return;
    applyAdminKey(value);
  }

  function openAuthModal(prefill = '') {
    if (!modal || !modalAdminKey) {
      promptFallback(prefill);
      return;
    }
    modalAdminKey.value = prefill;
    modal.classList.add('visible');
    setTimeout(() => modalAdminKey.focus(), 0);
  }

  function closeAuthModal() {
    if (modal) modal.classList.remove('visible');
  }

  function closePlayModal() {
    if (playModal) playModal.classList.remove('visible');
    pendingPlayTarget = null;
  }

  function getConnectionDefaults(connection) {
    const media = connection?.activeMedia || {};
    const init = media.init || {};
    const state = media.state || {};
    const url = state.url || init.url || '';
    const autoclose = state.autoclose ?? init.autoclose ?? false;
    return { url, autoclose: Boolean(autoclose) };
  }

  function getRegionDefaults(region) {
    const media = region?.activeMedia || {};
    const init = media.init || {};
    const state = media.state || {};
    const url = state.url || init.url || '';
    const autoclose = state.autoclose ?? init.autoclose ?? false;
    return { url, autoclose: Boolean(autoclose) };
  }

  function createConnectionTarget(connection) {
    return {
      kind: 'token',
      token: connection.token,
      sessionId: connection.activeMedia?.sessionId || null,
      defaults: getConnectionDefaults(connection),
    };
  }

  function createRegionTarget(region) {
    return {
      kind: 'region',
      regionId: region.regionId,
      regionDisplayName: region.displayName || null,
      sessionId: region.activeMedia?.sessionId || null,
      defaults: getRegionDefaults(region),
    };
  }

  function triggerPlay(target, url, autoclose) {
    if (!target) return;
    const trimmedUrl = (url || '').trim();
    if (!trimmedUrl) {
      alert('Please provide a video URL.');
      if (playUrlInput) setTimeout(() => playUrlInput.focus(), 0);
      return;
    }

    const payload = {
      url: trimmedUrl,
      autoclose: Boolean(autoclose),
    };

    if (target.sessionId && payload.sessionId == null) {
      payload.sessionId = target.sessionId;
    }

    if (target.kind === 'region' && target.regionDisplayName) {
      payload.regionDisplayName = target.regionDisplayName;
    }

    closePlayModal();
    sendCommand('play-instant', target, payload);
  }

  function openPlayModalForTarget(target) {
    pendingPlayTarget = target;

    const defaults = target?.defaults || { url: '', autoclose: false };

    if (!playModal || !playUrlInput || !playAutocloseInput) {
      const fallbackUrl = window.prompt('Video URL to play', defaults.url || '');
      if (fallbackUrl == null) {
        pendingPlayTarget = null;
        return;
      }
      const fallbackAutoclose = window.confirm('Enable autoclose when playback finishes?');
      triggerPlay(target, fallbackUrl, fallbackAutoclose);
      return;
    }

    playUrlInput.value = defaults.url || '';
    playAutocloseInput.checked = Boolean(defaults.autoclose);
    playModal.classList.add('visible');
    setTimeout(() => playUrlInput.focus(), 0);
  }

  function submitPlayModal() {
    if (!pendingPlayTarget) {
      closePlayModal();
      return;
    }
    const url = playUrlInput ? playUrlInput.value : '';
    const autoclose = playAutocloseInput ? playAutocloseInput.checked : false;
    triggerPlay(pendingPlayTarget, url, autoclose);
  }

  async function fetchDashboardData(showErrors = true) {
    if (!state.adminKey) {
      renderConnectionRows([]);
      renderRegionRows([]);
      setStatus('Enter the admin key to load data.');
      openAuthModal('');
      return;
    }
    if (state.wsConnected) return; // live updates active

    try {
      const headers = getHeaders();
      const [connectionsResp, regionsResp] = await Promise.all([
        fetch(`${basePath}/admin/video/connections`, { headers }),
        fetch(`${basePath}/admin/video/regions`, { headers }),
      ]);
      if (!connectionsResp.ok) {
        throw new Error(`Connections request failed (${connectionsResp.status})`);
      }
      if (!regionsResp.ok) {
        throw new Error(`Regions request failed (${regionsResp.status})`);
      }

      const connectionsPayload = await connectionsResp.json();
      const regionsPayload = await regionsResp.json();

      const connections = connectionsPayload.connections || [];
      const regions = regionsPayload.regions || [];

      state.lastConnections = connections;
      state.lastRegions = regions;

      renderConnectionRows(connections);
      renderRegionRows(regions);

      connCountEl.textContent = connections.length;
      const activeSessions = new Set(
        connections
          .map((c) => c.activeMedia?.sessionId)
          .filter((id) => typeof id === 'string' && id.length > 0)
      );
      activeCountEl.textContent = activeSessions.size;

      if (regionCountEl) {
        const activeRegions = regions.filter((region) => region.activeMedia).length;
        regionCountEl.textContent = activeRegions;
      }

      lastRefreshEl.textContent = new Date().toLocaleTimeString();
      setStatus(`Updated ${new Date().toLocaleTimeString()}`, 'ok');
    } catch (err) {
      if (showErrors) alert(`Failed to load dashboard data: ${err.message}`);
      setStatus(`Failed to load dashboard data (${err.message})`, 'error');
    }
  }

  function renderConnectionRows(connections) {
    const inputSnapshot = captureInputState(connectionsBody, 'token');
    connectionsBody.innerHTML = '';
    if (!connections.length) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 10;
      cell.className = 'empty-state';
      cell.textContent = state.adminKey ? 'No active connections.' : 'Enter the admin key to load connections.';
      row.appendChild(cell);
      connectionsBody.appendChild(row);
      return;
    }

    connections.forEach((conn) => {
      const media = conn.activeMedia || null;
      const position = computePosition(media);
      const autoclose = Boolean(media?.state?.autoclose);
      const row = document.createElement('tr');
      row.dataset.token = conn.token;

      const tokenCell = document.createElement('td');
      tokenCell.className = 'token';
      tokenCell.textContent = conn.token;
      row.appendChild(tokenCell);

      const playerCell = document.createElement('td');
      playerCell.innerHTML = `<div>${conn.playerName || '—'}</div><div class="token" style="font-size:12px;color:var(--text-secondary)">${conn.playerUuid || '—'}</div>`;
      row.appendChild(playerCell);

      const regionCell = document.createElement('td');
      if (conn.region) {
        const display = conn.regionDisplayName || conn.region;
        regionCell.innerHTML = `<div>${display}</div><div class="token" style="font-size:12px;color:var(--text-secondary)">${conn.region}</div>`;
      } else {
        regionCell.textContent = '—';
      }
      row.appendChild(regionCell);

      const sessionCell = document.createElement('td');
      sessionCell.innerHTML = media?.sessionId
        ? `<span class="session-tag">${media.sessionId}</span>`
        : '<span style="color:var(--text-secondary)">—</span>';
      row.appendChild(sessionCell);

      const statusCell = document.createElement('td');
      statusCell.textContent = position.status;
      row.appendChild(statusCell);

      const positionCell = document.createElement('td');
      positionCell.textContent = formatMs(position.positionMs);
      row.appendChild(positionCell);

      const volumeCell = document.createElement('td');
      const volume = media?.state?.volume;
      volumeCell.textContent = Number.isFinite(volume) ? `${Math.round(volume * 100)}%` : '—';
      row.appendChild(volumeCell);

      const autocloseCell = document.createElement('td');
      autocloseCell.textContent = autoclose ? 'Yes' : 'No';
      row.appendChild(autocloseCell);

      const updatedCell = document.createElement('td');
      const lastUpdate = media?.state?.status === 'idle'
        ? conn.lastSeen
        : media?.state?.startedAtEpochMs || media?.state?.pausedAtMs || null;
      updatedCell.textContent = formatAgo(lastUpdate);
      row.appendChild(updatedCell);

      const actionsCell = document.createElement('td');
      actionsCell.className = 'actions';
      const controls = createControls(conn);
      controls.forEach((control) => actionsCell.appendChild(control));
      row.appendChild(actionsCell);

      connectionsBody.appendChild(row);
    });
    restoreInputState(connectionsBody, 'token', inputSnapshot);
  }

  function renderRegionRows(regions) {
    const inputSnapshot = captureInputState(regionsBody, 'regionId');
    regionsBody.innerHTML = '';
    if (!regions.length) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 8;
      cell.className = 'empty-state';
      cell.textContent = state.adminKey ? 'No regions with active media.' : 'Enter the admin key to load regions.';
      row.appendChild(cell);
      regionsBody.appendChild(row);
      return;
    }

    regions.forEach((region) => {
      const media = region.activeMedia || null;
      const position = computePosition(media);
      const autoclose = Boolean(media?.state?.autoclose);
      const row = document.createElement('tr');
      if (region && region.regionId) {
        row.dataset.regionId = region.regionId;
      }

      const nameCell = document.createElement('td');
      const display = region.displayName || region.regionId || '—';
      nameCell.innerHTML = `<div>${display}</div><div class="token" style="font-size:12px;color:var(--text-secondary)">${region.regionId || '—'}</div>`;
      row.appendChild(nameCell);

      const membersCell = document.createElement('td');
      const members = Array.isArray(region.members) ? region.members : [];
      const memberNames = members
        .map((member) => member.playerName || member.playerUuid || member.playerId || member.token)
        .filter(Boolean)
        .slice(0, 3);
      const memberLabel = memberNames.length ? memberNames.join(', ') : '—';
      membersCell.innerHTML = `<div>${region.memberCount ?? members.length} connected</div><div class="token" style="font-size:12px;color:var(--text-secondary)">${memberLabel}</div>`;
      row.appendChild(membersCell);

      const statusCell = document.createElement('td');
      statusCell.textContent = media?.state?.status || position.status;
      row.appendChild(statusCell);

      const positionCell = document.createElement('td');
      positionCell.textContent = formatMs(position.positionMs);
      row.appendChild(positionCell);

      const volumeCell = document.createElement('td');
      const volume = media?.state?.volume;
      volumeCell.textContent = Number.isFinite(volume) ? `${Math.round(volume * 100)}%` : '—';
      row.appendChild(volumeCell);

      const autocloseCell = document.createElement('td');
      autocloseCell.textContent = autoclose ? 'Yes' : 'No';
      row.appendChild(autocloseCell);

      const updatedCell = document.createElement('td');
      updatedCell.textContent = formatAgo(region.lastUpdate || media?.lastUpdate || null);
      row.appendChild(updatedCell);

      const actionsCell = document.createElement('td');
      actionsCell.className = 'actions';
      const controls = createRegionControls(region);
      controls.forEach((control) => actionsCell.appendChild(control));
      row.appendChild(actionsCell);

      regionsBody.appendChild(row);
    });
    restoreInputState(regionsBody, 'regionId', inputSnapshot);
  }

  function createControls(connection) {
    const items = [];
    const target = createConnectionTarget(connection);
    const status = connection.activeMedia?.state?.status;
    const isPlaying = status === 'playing';
    const isPaused = status === 'paused';
    const seekable = ['playing', 'paused', 'ready'].includes(status);

    items.push(
      createActionButton('Play', () => handlePlayClickForTarget(target, connection.activeMedia), isPlaying, 'ghost')
    );
    items.push(
      createActionButton('Pause', () => sendCommand('pause', target), isPaused, 'ghost')
    );
    items.push(
      createActionButton('Stop', () => sendCommand('close', target), false, 'danger')
    );

    if (seekable) {
      items.push(createSeekControl(target));
    }

    return items;
  }

  function createSeekControl(target) {
    const container = document.createElement('div');

    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'mm:ss or secs';
    input.style.width = '110px';

    const button = createActionButton('Seek', () => {
      const value = parseSeekInput(input.value);
      if (!Number.isFinite(value)) {
        alert('Invalid seek value. Use seconds or mm:ss format.');
        return;
      }
      sendCommand('seek', target, { toMs: value });
    });

    container.appendChild(input);
    container.appendChild(button);
    return container;
  }

  function createRegionControls(region) {
    const items = [];
    const target = createRegionTarget(region);
    const status = region.activeMedia?.state?.status;
    const isPlaying = status === 'playing';
    const isPaused = status === 'paused';
    const seekable = ['playing', 'paused', 'ready'].includes(status);

    items.push(
      createActionButton('Play', () => handlePlayClickForTarget(target, region.activeMedia), isPlaying, 'ghost')
    );
    items.push(
      createActionButton('Pause', () => sendCommand('pause', target), isPaused, 'ghost')
    );
    items.push(
      createActionButton('Stop', () => sendCommand('close', target), false, 'danger')
    );

    if (seekable) {
      items.push(createSeekControl(target));
    }

    return items;
  }

  function createActionButton(label, handler, disabled = false, variant = 'ghost') {
    const btn = document.createElement('button');
    btn.className = variant;
    btn.textContent = label;
    btn.disabled = disabled;
    btn.addEventListener('click', handler);
    return btn;
  }

  function handlePlayClickForTarget(target, media) {
    const stateObj = media?.state || {};
    const status = stateObj.status;
    // If media is already initialized or paused, resume instead of asking for URL
    if (status === 'paused') {
      const payload = {};
      if (Number.isFinite(stateObj.pausedAtMs)) {
        const at = Math.max(0, stateObj.pausedAtMs);
        payload.atMs = at;
        payload.startAtEpochMs = Date.now() - at;
      }
      if (typeof stateObj.autoclose === 'boolean') payload.autoclose = stateObj.autoclose;
      if (typeof stateObj.volume === 'number') payload.volume = stateObj.volume;
      if (typeof stateObj.muted === 'boolean') payload.muted = stateObj.muted;
      sendCommand('play', target, payload);
      return;
    }
    if (status === 'ready' || media?.init) {
      const payload = {};
      if (Number.isFinite(stateObj.reportedPositionMs)) {
        const at = Math.max(0, stateObj.reportedPositionMs);
        payload.atMs = at;
        payload.startAtEpochMs = Date.now() - at;
      } else {
        payload.atMs = 0;
        payload.startAtEpochMs = Date.now();
      }
      if (typeof stateObj.autoclose === 'boolean') payload.autoclose = stateObj.autoclose;
      if (typeof stateObj.volume === 'number') payload.volume = stateObj.volume;
      if (typeof stateObj.muted === 'boolean') payload.muted = stateObj.muted;
      sendCommand('play', target, payload);
      return;
    }
    // No media set — ask for URL
    openPlayModalForTarget(target);
  }

  function parseSeekInput(value) {
    if (!value) return NaN;
    const trimmed = value.trim();
    if (!trimmed.length) return NaN;
    if (trimmed.includes(':')) {
      const parts = trimmed.split(':').map((p) => p.trim()).filter((p) => p.length);
      if (!parts.length) return NaN;
      let seconds = 0;
      for (const part of parts) {
        const num = Number(part);
        if (!Number.isFinite(num)) return NaN;
        seconds = seconds * 60 + num;
      }
      return seconds * 1000;
    }
    const numeric = Number(trimmed);
    if (!Number.isFinite(numeric)) return NaN;
    return numeric * 1000;
  }

  async function sendCommand(type, target, extra = {}) {
    if (!state.adminKey) {
      openAuthModal('');
      alert('Set the admin key first.');
      return;
    }

    const resolvedTarget = typeof target === 'string' ? { token: target } : (target || {});

    try {
      const body = { ...extra };
      if (resolvedTarget.token) {
        body.token = resolvedTarget.token;
      }
      if (resolvedTarget.regionId) {
        body.regionId = resolvedTarget.regionId;
        if (resolvedTarget.regionDisplayName) {
          body.regionDisplayName = resolvedTarget.regionDisplayName;
        }
      }
      if (resolvedTarget.sessionId != null && body.sessionId == null) {
        body.sessionId = resolvedTarget.sessionId;
      }

      const response = await fetch(`${basePath}/admin/video/${type}`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        throw new Error(`Request failed (${response.status})`);
      }
      await fetchDashboardData(false);
    } catch (err) {
      alert(`Command failed: ${err.message}`);
    }
  }

  function applyAdminKey(key) {
    const trimmed = (key || '').trim();
    state.adminKey = trimmed;
    if (!trimmed) {
      localStorage.removeItem('oaVideoAdminKey');
      setStatus('Admin key cleared.');
      renderConnectionRows([]);
      renderRegionRows([]);
      connCountEl.textContent = '0';
      activeCountEl.textContent = '0';
      if (regionCountEl) regionCountEl.textContent = '0';
      openAuthModal('');
      return;
    }
    localStorage.setItem('oaVideoAdminKey', trimmed);
    adminKeyInput.value = trimmed;
    closeAuthModal();
    setStatus('Key applied. Fetching…');
    connectAdminWs();
    fetchDashboardData(true);
  }

  applyKeyBtn.addEventListener('click', () => {
    applyAdminKey(adminKeyInput.value);
  });

  adminKeyInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      applyAdminKey(adminKeyInput.value);
    }
  });

  if (modalApply) {
    modalApply.addEventListener('click', () => {
      applyAdminKey(modalAdminKey.value);
    });
  }

  if (modalAdminKey) {
    modalAdminKey.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        applyAdminKey(modalAdminKey.value);
      }
    });
  }

  if (modalCancel) {
    modalCancel.addEventListener('click', () => {
      closeAuthModal();
    });
  }

  if (playCancelBtn) {
    playCancelBtn.addEventListener('click', () => {
      closePlayModal();
    });
  }

  if (playConfirmBtn) {
    playConfirmBtn.addEventListener('click', () => {
      submitPlayModal();
    });
  }

  if (playUrlInput) {
    playUrlInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        submitPlayModal();
      }
    });
  }

  if (playModal) {
    playModal.addEventListener('click', (event) => {
      if (event.target === playModal) {
        closePlayModal();
      }
    });
  }

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (playModal && playModal.classList.contains('visible')) {
        closePlayModal();
      }
    }
  });

  if (tabButtons.length) {
    tabButtons.forEach((button) => {
      button.addEventListener('click', () => {
        const tab = button.dataset.tab;
        if (!tab || tab === state.activeTab) return;
        setActiveTab(tab);
      });
    });
  }

  if (logoutKeyBtn) {
    logoutKeyBtn.addEventListener('click', () => {
      localStorage.removeItem('oaVideoAdminKey');
      state.adminKey = '';
      try { if (state.adminWs) state.adminWs.close(); } catch {}
      state.adminWs = null;
      state.wsConnected = false;
      adminKeyInput.value = '';
      renderConnectionRows([]);
      renderRegionRows([]);
      connCountEl.textContent = '0';
      activeCountEl.textContent = '0';
      if (regionCountEl) regionCountEl.textContent = '0';
      setStatus('Admin key removed.');
      openAuthModal('');
    });
  }

  setActiveTab(state.activeTab);

  refreshBtn.addEventListener('click', () => fetchDashboardData(true));

  if (state.adminKey) {
    setStatus('Using stored admin key. Fetching…');
    connectAdminWs();
    fetchDashboardData(false);
  } else {
    openAuthModal('');
  }

  state.pollTimer = setInterval(() => {
    if (!document.hidden && !state.wsConnected) {
      fetchDashboardData(false);
    }
  }, 5000);
})();
