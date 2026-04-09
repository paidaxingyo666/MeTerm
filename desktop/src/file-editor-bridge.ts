/**
 * file-editor-bridge.ts — Main window side: manages the singleton editor window
 * and bridges FileManager (WebSocket / IPC Transport) ↔ editor window via localStorage.
 */
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { confirm } from '@tauri-apps/plugin-dialog';
import { encodeMessage, MsgFileReadRequest, MsgFileSaveRequest } from './protocol';
import { t } from './i18n';
import { openEditorWindow } from './view-manager';
import type { TerminalTransport } from './terminal-transport';
import { isImageFile, getImageMimeType, bytesToBase64 } from './file-editor-md';

const LS_PREFIX = 'meterm-editor-';
const EDITOR_WINDOW_LABEL = 'editor';

/** Abstraction over WebSocket and IpcTransport for file editor communication. */
interface EditorConnection {
  send(data: Uint8Array): void;
  readonly isOpen: boolean;
}

function wrapWebSocket(ws: WebSocket): EditorConnection {
  return { send: (d) => ws.send(d), get isOpen() { return ws.readyState === WebSocket.OPEN; } };
}

function wrapTransport(t: TerminalTransport): EditorConnection {
  return { send: (d) => t.send(d), get isOpen() { return t.connected; } };
}

interface PendingRead {
  tabId: string;
  filePath: string;
  isImage: boolean;
  mimeType: string;
}

/** Maps tabId → connection (for save requests) */
const tabConnMap = new Map<string, EditorConnection>();

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
      console.log(`[Bridge] Poll running. tabConnMap keys: [${[...tabConnMap.keys()].join(', ')}]`);
    }
    // Check save requests from each tracked tab
    for (const [tabId, ws] of tabConnMap) {
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
      tabConnMap.clear();
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

function processSaveRequest(tabId: string, conn: EditorConnection, raw: string): void {
  console.log(`[Bridge] Processing save request: tabId=${tabId}, isOpen=${conn?.isOpen}`);
  if (!conn || !conn.isOpen) {
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

  conn.send(encodeMessage(MsgFileSaveRequest, payload));
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
  conn: WebSocket | TerminalTransport,
  host?: string,
): Promise<void> {
  const tabId = makeTabId(sessionId, filePath);
  const wrapped = conn instanceof WebSocket ? wrapWebSocket(conn) : wrapTransport(conn);

  // Always ensure polling is running
  startPolling();

  // Check if already open — just focus the window
  if (tabConnMap.has(tabId) && editorWindowCreated) {
    // Write pending entry to switch to this tab
    localStorage.setItem(`${LS_PREFIX}pending`, JSON.stringify([
      { tabId, sessionId, filePath, fileName, host: host || 'local' },
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

  // Track this tab's connection
  tabConnMap.set(tabId, wrapped);

  // Detect if file is an image (binary preview instead of text editor)
  const imgFile = isImageFile(fileName);
  const mimeType = imgFile ? getImageMimeType(fileName) : '';

  // Send read request
  const encoder = new TextEncoder();
  const reqPayload = encoder.encode(JSON.stringify({ path: filePath }));
  wrapped.send(encodeMessage(MsgFileReadRequest, reqPayload));
  pendingReads.push({ tabId, filePath, isImage: imgFile, mimeType });

  // Write pending file info for editor window
  localStorage.setItem(`${LS_PREFIX}pending`, JSON.stringify([
    { tabId, sessionId, filePath, fileName, host: host || 'local', isImage: imgFile, mimeType },
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
  const rawBytes = payload.slice(8, 8 + totalSize);

  if (pending.isImage) {
    // Binary file: encode as base64 data URL for image preview
    const base64 = bytesToBase64(rawBytes);
    const dataUrl = `data:${pending.mimeType};base64,${base64}`;
    localStorage.setItem(`${LS_PREFIX}content-${pending.tabId}`, JSON.stringify({
      content: dataUrl,
      filePath: pending.filePath,
      isImage: true,
      mimeType: pending.mimeType,
    }));
  } else {
    const content = new TextDecoder().decode(rawBytes);
    localStorage.setItem(`${LS_PREFIX}content-${pending.tabId}`, JSON.stringify({
      content,
      filePath: pending.filePath,
    }));
  }
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
  for (const [tabId] of tabConnMap) {
    if (tabId.startsWith(sessionId + '::')) {
      localStorage.setItem(`${LS_PREFIX}disconnected-${tabId}`, '1');
    }
  }
}
