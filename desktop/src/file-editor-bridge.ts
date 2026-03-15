/**
 * file-editor-bridge.ts — Main window side: manages the singleton editor window
 * and bridges FileManager (WebSocket) ↔ editor window via localStorage.
 */
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { confirm } from '@tauri-apps/plugin-dialog';
import { encodeMessage, MsgFileReadRequest, MsgFileSaveRequest } from './protocol';
import { t } from './i18n';
import { openEditorWindow } from './view-manager';

const LS_PREFIX = 'meterm-editor-';
const EDITOR_WINDOW_LABEL = 'editor';

interface PendingRead {
  tabId: string;
  filePath: string;
}

/** Maps tabId → WebSocket (for save requests) */
const tabWsMap = new Map<string, WebSocket>();

/** Pending file reads waiting for MsgFileReadResponse */
const pendingReads: PendingRead[] = [];

/** Pending saves: maps filePath → tabId */
const pendingSaves = new Map<string, string>();

let pollRunning = false;
let editorWindowCreated = false;

function makeTabId(sessionId: string, filePath: string): string {
  return `${sessionId}::${filePath}`;
}

/**
 * Start polling localStorage for save requests from the editor window.
 */
let pollTimer: ReturnType<typeof setTimeout> | null = null;

function startPolling(): void {
  if (pollRunning && pollTimer !== null) return;
  pollRunning = true;

  const poll = () => {
    // Debug: log poll state every 5s
    if (Date.now() % 5000 < 200) {
      console.log(`[Bridge] Poll running. tabWsMap keys: [${[...tabWsMap.keys()].join(', ')}]`);
    }
    // Check save requests from each tracked tab
    for (const [tabId, ws] of tabWsMap) {
      const reqKey = `${LS_PREFIX}savereq-${tabId}`;
      const raw = localStorage.getItem(reqKey);
      if (raw) {
        localStorage.removeItem(reqKey);
        processSaveRequest(tabId, ws, raw);
      }
    }

    // Check if editor window was closed
    if (localStorage.getItem(`${LS_PREFIX}closed`)) {
      localStorage.removeItem(`${LS_PREFIX}closed`);
      editorWindowCreated = false;
      tabWsMap.clear();
      pendingReads.length = 0;
      pendingSaves.clear();
    }

    if (editorWindowCreated) {
      pollTimer = setTimeout(poll, 200);
    } else {
      pollRunning = false;
      pollTimer = null;
    }
  };
  poll();
}

function processSaveRequest(tabId: string, ws: WebSocket, raw: string): void {
  console.log(`[Bridge] Processing save request: tabId=${tabId}, wsState=${ws?.readyState}`);
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    localStorage.setItem(`${LS_PREFIX}save-${tabId}`, JSON.stringify({
      success: false, error: 'Session disconnected',
    }));
    return;
  }

  // Timeout: if no response within 30s, mark as failed
  setTimeout(() => {
    // Check if this save is still pending
    for (const [path, id] of pendingSaves) {
      if (id === tabId) {
        pendingSaves.delete(path);
        localStorage.setItem(`${LS_PREFIX}save-${tabId}`, JSON.stringify({
          success: false, error: 'Save timeout - connection may be lost',
        }));
        break;
      }
    }
  }, 30_000);

  const data = JSON.parse(raw) as { filePath: string; content: string };
  const encoder = new TextEncoder();
  const pathBytes = encoder.encode(data.filePath);
  const contentBytes = encoder.encode(data.content);
  const payload = new Uint8Array(4 + pathBytes.length + contentBytes.length);
  const dv = new DataView(payload.buffer);
  dv.setUint32(0, pathBytes.length);
  payload.set(pathBytes, 4);
  payload.set(contentBytes, 4 + pathBytes.length);

  ws.send(encodeMessage(MsgFileSaveRequest, payload));
  pendingSaves.set(data.filePath, tabId);
}

/**
 * Ensure the singleton editor window exists.
 */
async function ensureEditorWindow(): Promise<void> {
  if (editorWindowCreated) {
    // Focus existing window
    const win = await WebviewWindow.getByLabel(EDITOR_WINDOW_LABEL);
    if (win) {
      void win.show();
      void win.setFocus();
      startPolling(); // Ensure poll is always running
      return;
    }
    // Window was closed unexpectedly
    editorWindowCreated = false;
  }

  // Use openEditorWindow() from view-manager — same pattern as openSettings() which has working drag
  await openEditorWindow();
  editorWindowCreated = true;
  startPolling();
}

/**
 * Open a file in the editor window. Creates the window if it doesn't exist.
 */
export async function openFileInEditor(
  sessionId: string,
  filePath: string,
  fileName: string,
  fileSize: number,
  ws: WebSocket,
  host?: string,
): Promise<void> {
  const tabId = makeTabId(sessionId, filePath);

  // Always ensure polling is running
  startPolling();

  // Check if already open — just focus the window
  if (tabWsMap.has(tabId) && editorWindowCreated) {
    // Write pending entry to switch to this tab
    localStorage.setItem(`${LS_PREFIX}pending`, JSON.stringify([
      { tabId, sessionId, filePath, fileName, host: host || sessionId },
    ]));
    const win = await WebviewWindow.getByLabel(EDITOR_WINDOW_LABEL);
    if (win) { void win.show(); void win.setFocus(); }
    return;
  }

  // Large file warning (>10MB)
  if (fileSize > 10 * 1024 * 1024) {
    const sizeMB = (fileSize / (1024 * 1024)).toFixed(1);
    const ok = await confirm(
      t('editorLargeFileWarning').replace('{size}', sizeMB),
      { title: t('editorLargeFileTitle'), kind: 'warning' },
    );
    if (!ok) return;
  }

  // Track this tab's WebSocket
  tabWsMap.set(tabId, ws);

  // Send read request via WebSocket
  const encoder = new TextEncoder();
  const reqPayload = encoder.encode(JSON.stringify({ path: filePath }));
  ws.send(encodeMessage(MsgFileReadRequest, reqPayload));
  pendingReads.push({ tabId, filePath });

  // Write pending file info for editor window
  localStorage.setItem(`${LS_PREFIX}pending`, JSON.stringify([
    { tabId, sessionId, filePath, fileName, host: host || sessionId },
  ]));

  // Ensure editor window exists
  await ensureEditorWindow();
}

/**
 * Handle MsgFileReadResponse from WebSocket.
 * Stores content in localStorage for the editor window to pick up.
 */
export function handleFileReadResponse(payload: Uint8Array): void {
  if (pendingReads.length === 0) {
    console.warn('Received MsgFileReadResponse but no pending reads');
    return;
  }

  const pending = pendingReads.shift()!;

  if (payload.length < 8) {
    localStorage.setItem(`${LS_PREFIX}content-${pending.tabId}`, JSON.stringify({
      error: 'Invalid response from server',
    }));
    return;
  }

  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const totalSize = Number(dv.getBigUint64(0));
  const content = new TextDecoder().decode(payload.slice(8, 8 + totalSize));

  localStorage.setItem(`${LS_PREFIX}content-${pending.tabId}`, JSON.stringify({
    content,
    filePath: pending.filePath,
  }));
}

/**
 * Handle save operation response (MsgFileOperationResp with operation === 'save').
 */
export function handleSaveResponse(filePath: string, success: boolean, error?: string): void {
  console.log(`[Bridge] Save response: filePath=${filePath}, success=${success}, pendingSaves=${[...pendingSaves.keys()].join(',')}`);
  if (filePath) {
    const tabId = pendingSaves.get(filePath);
    if (!tabId) return;
    pendingSaves.delete(filePath);
    localStorage.setItem(`${LS_PREFIX}save-${tabId}`, JSON.stringify({ success, error }));
  } else {
    // No filePath (error case) — notify ALL pending saves
    for (const [path, tabId] of pendingSaves) {
      localStorage.setItem(`${LS_PREFIX}save-${tabId}`, JSON.stringify({ success, error }));
      pendingSaves.delete(path);
    }
  }
}

/**
 * Notify editor window that a session was disconnected.
 */
export function notifyEditorsSessionClosed(sessionId: string): void {
  for (const [tabId] of tabWsMap) {
    if (tabId.startsWith(sessionId + '::')) {
      localStorage.setItem(`${LS_PREFIX}disconnected-${tabId}`, '1');
    }
  }
}
