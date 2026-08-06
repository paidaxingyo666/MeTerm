/**
 * Main-window side of the file editor bridge.
 *
 * Content moves only through target-scoped Tauri events. Canonical remote
 * paths and transport handles remain in this window and are never accepted
 * back from the editor when a save is requested.
 */
import { emitTo, listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { confirm } from '@tauri-apps/plugin-dialog';
import { encodeMessage, MsgFileReadRequest, MsgFileSaveRequest } from './protocol';
import { t } from './i18n';
import { openEditorWindow } from './view-manager';
import type { TerminalTransport } from './terminal-transport';
import { isImageFile, getImageMimeType, bytesToBase64 } from './file-editor-md';
import {
  EDITOR_CONTENT_EVENT,
  EDITOR_DISCONNECTED_EVENT,
  EDITOR_OPEN_EVENT,
  EDITOR_PING_EVENT,
  EDITOR_PONG_EVENT,
  EDITOR_SAVE_REQUEST_EVENT,
  EDITOR_SAVE_RESULT_EVENT,
  EDITOR_TAB_CLOSED_EVENT,
  EDITOR_WINDOW_CLOSED_EVENT,
  EDITOR_WINDOW_LABEL,
  MAX_EDITOR_FILE_BYTES,
  editorTextFitsLimit,
  isValidEditorNonce,
  purgeLegacyEditorStorage,
  type EditorContent,
  type EditorDisconnected,
  type EditorOpen,
  type EditorPong,
  type EditorSaveRequest,
  type EditorSaveResult,
  type EditorTabClosed,
} from './file-editor-events';

type EditorSource = WebSocket | TerminalTransport;

interface EditorConnection {
  readonly source: EditorSource;
  send(data: Uint8Array): void;
  readonly isOpen: boolean;
}

interface TabContext {
  tabId: string;
  tabKey: string;
  sessionId: string;
  filePath: string;
  connection: EditorConnection;
}

interface PendingRead {
  tabId: string;
  source: EditorSource;
  request: Uint8Array;
  isImage: boolean;
  mimeType: string;
  sent: boolean;
  cancelled: boolean;
}

interface PendingSave {
  tabId: string;
  source: EditorSource;
  filePath: string;
  timer: ReturnType<typeof setTimeout>;
  timedOut: boolean;
  orphaned: boolean;
}

const tabs = new Map<string, TabContext>();
const tabIdsByKey = new Map<string, string>();
const pendingReads: PendingRead[] = [];
const pendingSaves: PendingSave[] = [];
const handshakes = new Map<string, () => void>();
let bridgeListeners: Promise<void> | null = null;

purgeLegacyEditorStorage(localStorage);

function wrapConnection(source: EditorSource): EditorConnection {
  if (source instanceof WebSocket) {
    return {
      source,
      send: data => source.send(data),
      get isOpen() { return source.readyState === WebSocket.OPEN; },
    };
  }
  return {
    source,
    send: data => source.send(data),
    get isOpen() { return source.connected; },
  };
}

function makeTabKey(sessionId: string, filePath: string): string {
  return `${sessionId}\0${filePath}`;
}

function safeError(error: unknown, fallback: string): string {
  const text = typeof error === 'string'
    ? error
    : error instanceof Error
      ? error.message
      : fallback;
  return text.slice(0, 512) || fallback;
}

function emitEditor<T>(event: string, payload: T): void {
  void emitTo(EDITOR_WINDOW_LABEL, event, payload).catch(() => {
    // The editor may have closed between the operation and its response.
  });
}

function emitSaveResult(result: EditorSaveResult): void {
  emitEditor(EDITOR_SAVE_RESULT_EVENT, result);
}

function forgetTab(tabId: string): void {
  const context = tabs.get(tabId);
  if (!context) return;
  tabs.delete(tabId);
  tabIdsByKey.delete(context.tabKey);

  for (let index = pendingReads.length - 1; index >= 0; index--) {
    const pending = pendingReads[index];
    if (pending.tabId !== tabId) continue;
    if (pending.sent) pending.cancelled = true;
    else pendingReads.splice(index, 1);
  }
  for (const pending of pendingSaves) {
    if (pending.tabId === tabId) pending.orphaned = true;
  }
}

function resetClosedEditor(): void {
  for (const tabId of [...tabs.keys()]) forgetTab(tabId);
}

async function installBridgeListeners(): Promise<void> {
  if (bridgeListeners) return bridgeListeners;
  bridgeListeners = Promise.all([
    listen<EditorPong>(EDITOR_PONG_EVENT, event => {
      const requestId = event.payload?.requestId;
      if (!isValidEditorNonce(requestId)) return;
      handshakes.get(requestId)?.();
    }),
    listen<EditorSaveRequest>(EDITOR_SAVE_REQUEST_EVENT, event => {
      void processSaveRequest(event.payload);
    }),
    listen<EditorTabClosed>(EDITOR_TAB_CLOSED_EVENT, event => {
      if (isValidEditorNonce(event.payload?.tabId)) forgetTab(event.payload.tabId);
    }),
    listen(EDITOR_WINDOW_CLOSED_EVENT, resetClosedEditor),
  ]).then(() => undefined);
  return bridgeListeners;
}

async function waitForEditorReady(): Promise<void> {
  const ownerLabel = getCurrentWindow().label;
  const requestId = crypto.randomUUID();
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearInterval(pingTimer);
      clearTimeout(timeout);
      handshakes.delete(requestId);
      if (error) reject(error);
      else resolve();
    };
    handshakes.set(requestId, () => finish());
    const ping = () => {
      void emitTo(EDITOR_WINDOW_LABEL, EDITOR_PING_EVENT, { ownerLabel, requestId }).catch(() => {});
    };
    const pingTimer = setInterval(ping, 100);
    const timeout = setTimeout(() => finish(new Error('Editor window did not become ready')), 5_000);
    ping();
  });
}

async function ensureEditorWindow(): Promise<void> {
  await installBridgeListeners();
  let editor = await WebviewWindow.getByLabel(EDITOR_WINDOW_LABEL);
  if (!editor) {
    resetClosedEditor();
    await openEditorWindow();
    editor = await WebviewWindow.getByLabel(EDITOR_WINDOW_LABEL);
  }
  if (!editor) throw new Error('Editor window could not be created');
  await waitForEditorReady();
  await editor.show();
  await editor.setFocus();
}

function sendNextRead(source: EditorSource): void {
  const pending = pendingReads.find(item => item.source === source);
  if (!pending || pending.sent) return;
  const context = tabs.get(pending.tabId);
  if (!context || !context.connection.isOpen) {
    pendingReads.splice(pendingReads.indexOf(pending), 1);
    if (context) {
      emitEditor<EditorContent>(EDITOR_CONTENT_EVENT, {
        tabId: pending.tabId,
        error: 'Session disconnected',
      });
    }
    sendNextRead(source);
    return;
  }
  pending.sent = true;
  try {
    context.connection.send(pending.request);
  } catch {
    pendingReads.splice(pendingReads.indexOf(pending), 1);
    emitEditor<EditorContent>(EDITOR_CONTENT_EVENT, {
      tabId: pending.tabId,
      error: 'Unable to request file',
    });
    sendNextRead(source);
  }
}

async function processSaveRequest(request: EditorSaveRequest): Promise<void> {
  if (!request || !isValidEditorNonce(request.tabId) || typeof request.content !== 'string') return;
  const context = tabs.get(request.tabId);
  if (!context) {
    emitSaveResult({
      tabId: request.tabId,
      success: false,
      error: 'Editor authorization expired; reopen the file',
    });
    return;
  }
  if (!editorTextFitsLimit(request.content)) {
    emitSaveResult({
      tabId: request.tabId,
      success: false,
      error: `File exceeds ${MAX_EDITOR_FILE_BYTES} byte limit`,
    });
    return;
  }
  if (!context.connection.isOpen) {
    emitSaveResult({ tabId: request.tabId, success: false, error: 'Session disconnected' });
    return;
  }
  // The wire protocol has no operation ID. Permit one save per transport so
  // an out-of-order response can never be applied to another editor tab.
  if (pendingSaves.some(pending => pending.source === context.connection.source)) {
    emitSaveResult({
      tabId: request.tabId,
      success: false,
      error: 'Another save is still pending for this session',
    });
    return;
  }

  const pathBytes = new TextEncoder().encode(context.filePath);
  const contentBytes = new TextEncoder().encode(request.content);
  if (pathBytes.byteLength === 0 || pathBytes.byteLength > 65_536) {
    emitSaveResult({ tabId: request.tabId, success: false, error: 'Invalid file path' });
    return;
  }
  const payload = new Uint8Array(4 + pathBytes.length + contentBytes.length);
  const view = new DataView(payload.buffer);
  view.setUint32(0, pathBytes.length);
  payload.set(pathBytes, 4);
  payload.set(contentBytes, 4 + pathBytes.length);

  const pending: PendingSave = {
    tabId: request.tabId,
    source: context.connection.source,
    filePath: context.filePath,
    timer: undefined as unknown as ReturnType<typeof setTimeout>,
    timedOut: false,
    orphaned: false,
  };
  pending.timer = setTimeout(() => {
    pending.timedOut = true;
    if (!pending.orphaned) {
      emitSaveResult({
        tabId: pending.tabId,
        success: false,
        error: 'Save result timed out; reconnect before retrying if it does not arrive',
      });
    }
  }, 30_000);
  pendingSaves.push(pending);
  try {
    context.connection.send(encodeMessage(MsgFileSaveRequest, payload));
  } catch (error) {
    clearTimeout(pending.timer);
    pendingSaves.splice(pendingSaves.indexOf(pending), 1);
    emitSaveResult({
      tabId: request.tabId,
      success: false,
      error: safeError(error, 'Unable to save file'),
    });
  }
}

/** Open or focus a remote file without persisting its content or path. */
export async function openFileInEditor(
  sessionId: string,
  filePath: string,
  fileName: string,
  fileSize: number,
  source: EditorSource,
  host?: string,
): Promise<void> {
  try {
    if (fileSize > 10 * 1024 * 1024) {
      const sizeMB = (fileSize / (1024 * 1024)).toFixed(1);
      const ok = await confirm(
        t('editorLargeFileWarning').replace('{size}', sizeMB),
        { title: t('editorLargeFileTitle'), kind: 'warning' },
      );
      if (!ok) return;
    }

    const tabKey = makeTabKey(sessionId, filePath);
    const existingTabId = tabIdsByKey.get(tabKey);
    await ensureEditorWindow();
    if (existingTabId && tabs.has(existingTabId)) {
      const context = tabs.get(existingTabId)!;
      // Wait until Tauri has accepted the tab-open event before allowing a
      // very fast local file response to enqueue its content event.
      await emitTo(EDITOR_WINDOW_LABEL, EDITOR_OPEN_EVENT, {
        tabId: existingTabId,
        ownerLabel: getCurrentWindow().label,
        sessionId,
        filePath,
        fileName,
        host: host || 'local',
        isImage: isImageFile(fileName),
        mimeType: getImageMimeType(fileName),
      } satisfies EditorOpen);
      context.connection = wrapConnection(source);
      return;
    }

    const tabId = crypto.randomUUID();
    const connection = wrapConnection(source);
    const image = isImageFile(fileName);
    const mimeType = image ? getImageMimeType(fileName) : '';
    const context: TabContext = { tabId, tabKey, sessionId, filePath, connection };
    tabs.set(tabId, context);
    tabIdsByKey.set(tabKey, tabId);

    // Preserve open-before-content ordering even when the desktop endpoint is
    // local and answers the read request immediately.
    await emitTo(EDITOR_WINDOW_LABEL, EDITOR_OPEN_EVENT, {
      tabId,
      ownerLabel: getCurrentWindow().label,
      sessionId,
      filePath,
      fileName,
      host: host || 'local',
      isImage: image,
      mimeType,
    } satisfies EditorOpen);

    const requestPayload = new TextEncoder().encode(JSON.stringify({
      path: filePath,
      max_bytes: MAX_EDITOR_FILE_BYTES,
    }));
    pendingReads.push({
      tabId,
      source,
      request: encodeMessage(MsgFileReadRequest, requestPayload),
      isImage: image,
      mimeType,
      sent: false,
      cancelled: false,
    });
    sendNextRead(source);
  } catch (error) {
    console.error('[editor] unable to open editor window:', safeError(error, 'unknown error'));
  }
}

/** Handle a file-read response from the exact transport that produced it. */
export function handleFileReadResponse(payload: Uint8Array, source?: EditorSource): void {
  const index = source
    ? pendingReads.findIndex(item => item.source === source && item.sent)
    : pendingReads.filter(item => item.sent).length === 1
      ? pendingReads.findIndex(item => item.sent)
      : -1;
  if (index < 0) return;
  const pending = pendingReads.splice(index, 1)[0];

  let result: EditorContent;
  if (payload.length < 8) {
    result = { tabId: pending.tabId, error: 'Invalid response from server' };
  } else {
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const claimed = view.getBigUint64(0);
    const actual = payload.byteLength - 8;
    if (claimed > BigInt(MAX_EDITOR_FILE_BYTES) || claimed !== BigInt(actual)) {
      result = { tabId: pending.tabId, error: 'Invalid or oversized response from server' };
    } else {
      const rawBytes = payload.subarray(8);
      if (pending.isImage) {
        result = {
          tabId: pending.tabId,
          content: `data:${pending.mimeType};base64,${bytesToBase64(rawBytes)}`,
          isImage: true,
          mimeType: pending.mimeType,
        };
      } else {
        result = { tabId: pending.tabId, content: new TextDecoder().decode(rawBytes) };
      }
    }
  }
  if (!pending.cancelled && tabs.has(pending.tabId)) {
    emitEditor(EDITOR_CONTENT_EVENT, result);
  }
  sendNextRead(pending.source);
}

/** Resolve a pending editor read that failed with a protocol error. */
export function handleFileReadError(error: string, source?: EditorSource): boolean {
  const index = source
    ? pendingReads.findIndex(item => item.source === source && item.sent)
    : pendingReads.filter(item => item.sent).length === 1
      ? pendingReads.findIndex(item => item.sent)
      : -1;
  if (index < 0) return false;
  const pending = pendingReads.splice(index, 1)[0];
  if (!pending.cancelled && tabs.has(pending.tabId)) {
    emitEditor<EditorContent>(EDITOR_CONTENT_EVENT, {
      tabId: pending.tabId,
      error: safeError(error, 'Unable to read file'),
    });
  }
  sendNextRead(pending.source);
  return true;
}

/** Handle a save response from the exact transport that produced it. */
export function handleSaveResponse(
  filePath: string,
  success: boolean,
  error?: string,
  source?: EditorSource,
): void {
  const index = pendingSaves.findIndex(pending => {
    if (source && pending.source !== source) return false;
    return !filePath || pending.filePath === filePath;
  });
  if (index < 0) return;
  const pending = pendingSaves.splice(index, 1)[0];
  clearTimeout(pending.timer);
  if (pending.timedOut || pending.orphaned || !tabs.has(pending.tabId)) return;
  emitSaveResult({
    tabId: pending.tabId,
    success,
    error: error ? safeError(error, 'Unable to save file') : undefined,
  });
}

/** Notify only editor tabs that belong to the disconnected session. */
export function notifyEditorsSessionClosed(sessionId: string): void {
  for (const context of [...tabs.values()]) {
    if (context.sessionId !== sessionId) continue;
    emitEditor<EditorDisconnected>(EDITOR_DISCONNECTED_EVENT, { tabId: context.tabId });
    forgetTab(context.tabId);
  }
}
