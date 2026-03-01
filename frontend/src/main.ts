import './style.css';
import '@xterm/xterm/css/xterm.css';
import { Terminal } from '@xterm/xterm';

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] ?? ch));
}
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import {
  encodeMessage,
  decodeMessage,
  decodeHello,
  encodeResize,
  MsgInput,
  MsgOutput,
  MsgRoleChange,
  MsgHello,
  MsgSessionEnd,
  MsgError,
  MsgPong,
  MsgMasterRequest,
  MsgMasterRequestNotify,
  ErrSessionNotFound,
  ErrNotMaster,
} from './protocol';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let authToken: string | null = null;
let currentView: 'auth' | 'sessions' | 'terminal' = 'auth';
let sessionsTimer: ReturnType<typeof setInterval> | null = null;

// Terminal state
let terminal: Terminal | null = null;
let fitAddon: FitAddon | null = null;
let ws: WebSocket | null = null;
let clientId: string | null = null;
let currentSessionId: string | null = null;
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let sessionEnded = false;
let currentRole: 'master' | 'viewer' | 'readonly' = 'viewer';
let masterRequestPending = false;

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 16000;
const MAX_RECONNECT_ATTEMPTS = 10;

// ---------------------------------------------------------------------------
// Elements
// ---------------------------------------------------------------------------
const viewAuth = document.getElementById('view-auth')!;
const viewSessions = document.getElementById('view-sessions')!;
const viewTerminal = document.getElementById('view-terminal')!;

const authTokenInput = document.getElementById('auth-token') as HTMLInputElement;
const authConnectBtn = document.getElementById('auth-connect') as HTMLButtonElement;
const authError = document.getElementById('auth-error')!;

const sessionsList = document.getElementById('sessions-list')!;
const sessionsEmpty = document.getElementById('sessions-empty')!;
const sessionsDisconnect = document.getElementById('sessions-disconnect')!;

const terminalBack = document.getElementById('terminal-back')!;
const terminalEl = document.getElementById('terminal')!;
const terminalStatus = document.getElementById('terminal-status')!;
const terminalSessionId = document.getElementById('terminal-session-id')!;
const terminalRoleBadge = document.getElementById('terminal-role-badge')!;
const terminalRequestMaster = document.getElementById('terminal-request-master') as HTMLButtonElement;

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------
function apiHeaders(): HeadersInit {
  return { Authorization: `Bearer ${authToken}` };
}

async function apiGet(path: string): Promise<Response> {
  return fetch(path, { headers: apiHeaders() });
}

// ---------------------------------------------------------------------------
// View switching
// ---------------------------------------------------------------------------
function showView(view: 'auth' | 'sessions' | 'terminal') {
  currentView = view;
  viewAuth.style.display = view === 'auth' ? 'flex' : 'none';
  viewSessions.style.display = view === 'sessions' ? 'flex' : 'none';
  viewTerminal.style.display = view === 'terminal' ? 'flex' : 'none';

  if (view === 'sessions') {
    startSessionsPolling();
  } else {
    stopSessionsPolling();
  }

  if (view === 'terminal' && fitAddon) {
    requestAnimationFrame(() => fitAddon!.fit());
  }
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
async function attemptAuth(token: string): Promise<boolean> {
  try {
    const res = await fetch('/api/info', {
      headers: { Authorization: `Bearer ${token}` },
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function handleConnect() {
  const token = authTokenInput.value.trim();
  if (!token) {
    authError.textContent = 'Please enter a token';
    return;
  }

  authConnectBtn.disabled = true;
  authError.textContent = '';

  const ok = await attemptAuth(token);
  if (ok) {
    authToken = token;
    sessionStorage.setItem('meterm-token', token);
    showView('sessions');
  } else {
    authError.textContent = 'Invalid token or server unreachable';
  }
  authConnectBtn.disabled = false;
}

authConnectBtn.addEventListener('click', handleConnect);
authTokenInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') handleConnect();
});

// ---------------------------------------------------------------------------
// Sessions list
// ---------------------------------------------------------------------------
interface SessionItem {
  id: string;
  state: string;
  clients: number;
  executor_type: string;
  created_at: string;
}

async function loadSessions() {
  try {
    const res = await apiGet('/api/sessions');
    if (!res.ok) {
      if (res.status === 401) {
        showView('auth');
        authError.textContent = 'Session expired';
      }
      return;
    }
    const data = await res.json();
    const sessions: SessionItem[] = data.sessions || [];
    renderSessions(sessions);
  } catch {
    // Network error, keep showing last state
  }
}

function renderSessions(sessions: SessionItem[]) {
  if (sessions.length === 0) {
    sessionsList.style.display = 'none';
    sessionsEmpty.style.display = 'flex';
    return;
  }

  sessionsList.style.display = 'block';
  sessionsEmpty.style.display = 'none';
  sessionsList.innerHTML = '';

  for (const s of sessions) {
    const card = document.createElement('div');
    card.className = 'session-card';
    card.onclick = () => openTerminal(s.id);

    const shortId = s.id.length > 12 ? s.id.slice(0, 8) + '...' : s.id;
    const created = new Date(s.created_at).toLocaleTimeString();

    card.innerHTML = `
      <div class="session-card-top">
        <span class="session-card-id">${escapeHtml(shortId)}</span>
        <span class="session-card-state ${escapeHtml(s.state)}">${escapeHtml(s.state)}</span>
      </div>
      <div class="session-card-bottom">
        <span>${escapeHtml(s.executor_type)}</span>
        <span>${s.clients} client${s.clients !== 1 ? 's' : ''}</span>
        <span>${escapeHtml(created)}</span>
      </div>
    `;
    sessionsList.appendChild(card);
  }
}

function startSessionsPolling() {
  loadSessions();
  sessionsTimer = setInterval(loadSessions, 5000);
}

function stopSessionsPolling() {
  if (sessionsTimer) {
    clearInterval(sessionsTimer);
    sessionsTimer = null;
  }
}

sessionsDisconnect.addEventListener('click', () => {
  authToken = null;
  sessionStorage.removeItem('meterm-token');
  showView('auth');
});

// ---------------------------------------------------------------------------
// Terminal observation
// ---------------------------------------------------------------------------
function openTerminal(sessionId: string) {
  currentSessionId = sessionId;
  sessionEnded = false;
  reconnectAttempt = 0;
  masterRequestPending = false;
  currentRole = 'viewer';

  terminalSessionId.textContent = sessionId.slice(0, 8) + '...';
  updateRoleBadge();
  updateRequestButton();

  // Create or reset terminal
  if (terminal) {
    terminal.dispose();
  }
  terminalEl.innerHTML = '';

  terminal = new Terminal({
    cursorBlink: true,
    fontSize: 14,
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    disableStdin: true, // Start as viewer (read-only)
  });

  fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(terminalEl);

  try {
    const webglAddon = new WebglAddon();
    terminal.loadAddon(webglAddon);
  } catch {
    // WebGL not available
  }

  fitAddon.fit();
  terminal.focus();

  // Input handler (only sends when master)
  terminal.onData((data) => {
    if (currentRole === 'master' && ws?.readyState === WebSocket.OPEN) {
      ws.send(encodeMessage(MsgInput, new TextEncoder().encode(data)));
    }
  });

  terminal.onResize(({ cols, rows }) => {
    if (currentRole === 'master' && ws?.readyState === WebSocket.OPEN) {
      ws.send(encodeResize(cols, rows));
    }
  });

  showView('terminal');
  connect();
}

function buildWsUrl(): string {
  const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  let url = `${wsProto}//${location.host}/ws/${currentSessionId}?mode=readonly`;
  if (clientId) {
    url += `&client_id=${clientId}`;
  }
  return url;
}

function connect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  setStatus('Connecting...');
  const socket = new WebSocket(buildWsUrl(), ['meterm.v1', `bearer.${authToken}`]);
  socket.binaryType = 'arraybuffer';
  ws = socket;

  socket.onopen = () => {
    reconnectAttempt = 0;
    setStatus('Connected', 'connected');
  };

  socket.onmessage = (event) => handleMessage(event);

  socket.onclose = () => {
    if (ws === socket) {
      ws = null;
      scheduleReconnect();
    }
  };

  socket.onerror = () => {};
}

function handleMessage(event: MessageEvent) {
  const { type, payload } = decodeMessage(event.data);

  switch (type) {
    case MsgHello: {
      const hello = decodeHello(payload);
      clientId = hello.client_id;
      break;
    }

    case MsgOutput:
      terminal?.write(payload);
      break;

    case MsgRoleChange: {
      const role = payload[0];
      if (role === 1) {
        currentRole = 'master';
        if (terminal) terminal.options.disableStdin = false;
        masterRequestPending = false;
        showToast('You now have control', 'success');
      } else if (role === 2) {
        currentRole = 'readonly';
        if (terminal) terminal.options.disableStdin = true;
      } else {
        currentRole = 'viewer';
        if (terminal) terminal.options.disableStdin = true;
        if (masterRequestPending) {
          masterRequestPending = false;
        }
      }
      updateRoleBadge();
      updateRequestButton();
      updateStatus();
      break;
    }

    case MsgSessionEnd:
      sessionEnded = true;
      setStatus('Session ended');
      ws?.close();
      break;

    case MsgError: {
      const errorCode = payload[0];
      if (errorCode === ErrSessionNotFound) {
        sessionEnded = true;
        terminal?.write('\r\n\x1b[31mSession not found.\x1b[0m\r\n');
        setStatus('Session not found');
        ws?.close();
      } else if (errorCode === ErrNotMaster) {
        // Master request denied
        masterRequestPending = false;
        updateRequestButton();
        showToast('Control request denied', 'error');
      }
      break;
    }

    case MsgPong:
      // Heartbeat response
      break;

    case MsgMasterRequestNotify:
      // Web viewer shouldn't receive this (only desktop master gets it)
      break;
  }
}

function scheduleReconnect() {
  if (sessionEnded || reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
    setStatus(sessionEnded ? 'Session ended' : 'Disconnected (max retries)');
    return;
  }

  const delayMs = Math.min(RECONNECT_BASE_MS * Math.pow(2, reconnectAttempt), RECONNECT_MAX_MS);
  reconnectAttempt++;
  setStatus(`Reconnecting (${reconnectAttempt}/${MAX_RECONNECT_ATTEMPTS})...`);
  reconnectTimer = setTimeout(() => connect(), delayMs);
}

function closeTerminal() {
  if (ws) {
    ws.close();
    ws = null;
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  clientId = null;
  currentSessionId = null;
  showView('sessions');
}

// ---------------------------------------------------------------------------
// Master request
// ---------------------------------------------------------------------------
function requestMaster() {
  if (!ws || ws.readyState !== WebSocket.OPEN || currentRole === 'master' || masterRequestPending) return;

  masterRequestPending = true;
  ws.send(encodeMessage(MsgMasterRequest, new Uint8Array(0)));
  updateRequestButton();
  showToast('Control request sent...', 'info');
}

terminalRequestMaster.addEventListener('click', requestMaster);

// ---------------------------------------------------------------------------
// UI updates
// ---------------------------------------------------------------------------
function updateRoleBadge() {
  terminalRoleBadge.textContent = currentRole.toUpperCase();
  terminalRoleBadge.className = currentRole;
}

function updateRequestButton() {
  if (currentRole === 'master') {
    terminalRequestMaster.style.display = 'none';
  } else {
    terminalRequestMaster.style.display = 'inline-block';
    if (masterRequestPending) {
      terminalRequestMaster.textContent = 'Pending...';
      terminalRequestMaster.classList.add('pending');
      terminalRequestMaster.disabled = true;
    } else {
      terminalRequestMaster.textContent = 'Request Control';
      terminalRequestMaster.classList.remove('pending');
      terminalRequestMaster.disabled = false;
    }
  }
}

function setStatus(text: string, className?: string) {
  terminalStatus.textContent = text;
  terminalStatus.className = className || '';
}

function updateStatus() {
  if (currentRole === 'master') {
    setStatus('MASTER - You have control', 'master');
  } else {
    setStatus('VIEWER - Observing', 'viewer');
  }
}

function showToast(message: string, type: 'info' | 'error' | 'success') {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------
terminalBack.addEventListener('click', closeTerminal);

// Resize handler
window.addEventListener('resize', () => {
  if (currentView === 'terminal' && fitAddon) {
    fitAddon.fit();
  }
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
(function init() {
  // Check for token in URL params
  const params = new URLSearchParams(window.location.search);
  const urlToken = params.get('token');

  // Immediately clean token from URL to prevent leakage via Referer/history
  if (urlToken) {
    window.history.replaceState({}, '', window.location.pathname);
  }

  // Check for saved token
  const savedToken = sessionStorage.getItem('meterm-token');

  const tokenToTry = urlToken || savedToken;

  if (tokenToTry) {
    authTokenInput.value = tokenToTry;
    attemptAuth(tokenToTry).then((ok) => {
      if (ok) {
        authToken = tokenToTry;
        sessionStorage.setItem('meterm-token', tokenToTry);
        showView('sessions');
      }
      // If auto-auth fails, stay on auth view
    });
  }
})();
