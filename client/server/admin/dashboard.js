(() => {
  const state = {
    adminKey: localStorage.getItem('oaVideoAdminKey') || '',
    pollTimer: null,
    lastData: [],
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
  const tbody = document.getElementById('connectionsBody');
  const modal = document.getElementById('authModal');
  const modalAdminKey = document.getElementById('modalAdminKey');
  const modalApply = document.getElementById('modalApply');
  const modalCancel = document.getElementById('modalCancel');
  const logoutKeyBtn = document.getElementById('logoutKey');

  adminKeyInput.value = state.adminKey;

  function setStatus(message, variant = '') {
    statusText.textContent = message;
    if (variant) {
      statusText.dataset.variant = variant;
    } else {
      delete statusText.dataset.variant;
    }
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

  async function fetchConnections(showErrors = true) {
    if (!state.adminKey) {
      renderRows([]);
      setStatus('Enter the admin key to load data.');
      openAuthModal('');
      return;
    }

    try {
      const response = await fetch(`${basePath}/admin/video/connections`, {
        headers: getHeaders(),
      });
      if (!response.ok) {
        throw new Error(`Request failed (${response.status})`);
      }
      const payload = await response.json();
      const connections = payload.connections || [];
      state.lastData = connections;
      renderRows(connections);
      connCountEl.textContent = connections.length;
      const activeSessions = new Set(
        connections
          .map((c) => c.activeMedia?.sessionId)
          .filter((id) => typeof id === 'string' && id.length > 0)
      );
      activeCountEl.textContent = activeSessions.size;
      lastRefreshEl.textContent = new Date().toLocaleTimeString();
      setStatus(`Updated ${new Date().toLocaleTimeString()}`, 'ok');
    } catch (err) {
      if (showErrors) alert(`Failed to load connections: ${err.message}`);
      setStatus(`Failed to load connections (${err.message})`, 'error');
    }
  }

  function renderRows(connections) {
    tbody.innerHTML = '';
    if (!connections.length) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 9;
      cell.className = 'empty-state';
      cell.textContent = state.adminKey ? 'No active connections.' : 'Enter the admin key to load connections.';
      row.appendChild(cell);
      tbody.appendChild(row);
      return;
    }

    const now = Date.now();
    connections.forEach((conn) => {
      const media = conn.activeMedia || null;
      const position = computePosition(media);
      const autoclose = Boolean(media?.state?.autoclose);
      const row = document.createElement('tr');

      const tokenCell = document.createElement('td');
      tokenCell.className = 'token';
      tokenCell.textContent = conn.token;
      row.appendChild(tokenCell);

      const playerCell = document.createElement('td');
      playerCell.innerHTML = `<div>${conn.playerName || '—'}</div><div class="token" style="font-size:12px;color:var(--text-secondary)">${conn.playerUuid || '—'}</div>`;
      row.appendChild(playerCell);

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
        ? conn.lastSeenAt
        : media?.state?.startedAtEpochMs || media?.state?.pausedAtMs || null;
      updatedCell.textContent = formatAgo(lastUpdate);
      row.appendChild(updatedCell);

      const actionsCell = document.createElement('td');
      actionsCell.className = 'actions';
      const controls = createControls(conn);
      controls.forEach((control) => actionsCell.appendChild(control));
      row.appendChild(actionsCell);

      tbody.appendChild(row);
    });
  }

  function createControls(connection) {
    const { token, activeMedia } = connection;
    const items = [];
    const isPlaying = activeMedia?.state?.status === 'playing';
    const isPaused = activeMedia?.state?.status === 'paused';
    const seekable = ['playing', 'paused', 'ready'].includes(activeMedia?.state?.status);

    items.push(
      createActionButton('Play', () => sendCommand('play', token), isPlaying, 'ghost')
    );
    items.push(
      createActionButton('Pause', () => sendCommand('pause', token), isPaused, 'ghost')
    );
    items.push(
      createActionButton('Stop', () => sendCommand('close', token), false, 'danger')
    );

    if (seekable) {
      items.push(createSeekControl(token));
    }

    items.push(createVolumeControl(token));

    return items;
  }

  function createSeekControl(token) {
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
      sendCommand('seek', token, { toMs: value });
    });

    container.appendChild(input);
    container.appendChild(button);
    return container;
  }

  function createVolumeControl(token) {
    const container = document.createElement('div');

    const input = document.createElement('input');
    input.type = 'range';
    input.min = '0';
    input.max = '100';
    input.value = '100';
    input.style.width = '100px';

    const button = createActionButton('Set Volume', () => {
      const vol = Number(input.value) / 100;
      sendCommand('set-volume', token, { volume: vol });
    });

    container.appendChild(input);
    container.appendChild(button);
    return container;
  }

  function createActionButton(label, handler, disabled = false, variant = 'ghost') {
    const btn = document.createElement('button');
    btn.className = variant;
    btn.textContent = label;
    btn.disabled = disabled;
    btn.addEventListener('click', handler);
    return btn;
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

  async function sendCommand(type, token, extra = {}) {
    if (!state.adminKey) {
      openAuthModal('');
      alert('Set the admin key first.');
      return;
    }
    try {
      const response = await fetch(`${basePath}/admin/video/${type}`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({ token, ...extra }),
      });
      if (!response.ok) {
        throw new Error(`Request failed (${response.status})`);
      }
      await fetchConnections(false);
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
      renderRows([]);
      openAuthModal('');
      return;
    }
    localStorage.setItem('oaVideoAdminKey', trimmed);
    adminKeyInput.value = trimmed;
    closeAuthModal();
    setStatus('Key applied. Fetching…');
    fetchConnections(true);
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

  if (logoutKeyBtn) {
    logoutKeyBtn.addEventListener('click', () => {
      localStorage.removeItem('oaVideoAdminKey');
      state.adminKey = '';
      adminKeyInput.value = '';
      renderRows([]);
      setStatus('Admin key removed.');
      openAuthModal('');
    });
  }

  refreshBtn.addEventListener('click', () => fetchConnections(true));

  if (state.adminKey) {
    setStatus('Using stored admin key. Fetching…');
    fetchConnections(false);
  } else {
    openAuthModal('');
  }

  state.pollTimer = setInterval(() => {
    if (!document.hidden) {
      fetchConnections(false);
    }
  }, 5000);
})();
