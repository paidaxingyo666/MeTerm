import {
  decodeHello,
  decodeMessage,
  encodeMessage,
  ErrSessionNotFound,
  ErrNotMaster,
  ErrKicked,
  MsgError,
  MsgHello,
  MsgOutput,
  MsgPong,
  MsgRoleChange,
  MsgSessionEnd,
  MsgSetEncoding,
  MsgMasterRequestNotify,
  MsgPairNotify,
  MsgFileListResp,
  MsgOscEvent,
} from './protocol';
import { buildWsProtocols, buildWsUrl } from './connection';
import { DrawerManager } from './drawer';
import { setSSHDirProbe } from './terminal-file-link';
import { filterPostResizeNewlines } from './terminal-resize';
import { IpcTransport } from './terminal-transport';
import type { AppSettings } from './themes';
import type { ManagedTerminal } from './terminal-types';

export interface WsCallbacks {
  scheduleSettleResize: (mt: ManagedTerminal) => void;
  getSettings: () => AppSettings | null;
  sendEncoding: (mt: ManagedTerminal, encoding: string) => void;
  getOutputListeners: (sessionId: string) => Set<(data: string) => void> | undefined;
  updateShellTitle: (mt: ManagedTerminal) => void;
  setPongTime: (sessionId: string, time: number) => void;
  getPingTimestamp: (sessionId: string) => number | undefined;
  deletePingTimestamp: (sessionId: string) => void;
  onReconnectNeeded: (mt: ManagedTerminal) => void;
  /** Handle OSC events from Rust backend (MSG_OSC_EVENT) */
  onOscEvent: (mt: ManagedTerminal, payload: Uint8Array) => void;
}

export function handleIncomingMessage(
  mt: ManagedTerminal,
  data: ArrayBuffer,
  callbacks: WsCallbacks,
  closeFn?: () => void,
): void {
  const decoded = decodeMessage(data);
  const type = decoded.type;
  const payload = decoded.payload;

  if (type === MsgHello) {
    const hello = decodeHello(payload);
    mt.clientId = hello.client_id;
    return;
  }

  if (type === MsgOscEvent) {
    callbacks.onOscEvent(mt, payload);
    return;
  }

  if (type === MsgOutput) {
    let outData: Uint8Array | null = payload;
    if (mt._postResizeNewlineFilter > 0) {
      outData = filterPostResizeNewlines(mt, outData);
      if (!outData) return;
    }

    const outListeners = callbacks.getOutputListeners(mt.id);
    if (outListeners && outListeners.size > 0) {
      const text = new TextDecoder().decode(outData);
      outListeners.forEach(cb => cb(text));
    }

    mt.terminal.write(outData);
    mt.thumbnailTerminal.write(outData);

    if (!mt.hasOscTitle) {
      callbacks.updateShellTitle(mt);
    }
    return;
  }

  if (type === MsgRoleChange) {
    const role = payload[0];
    if (mt._transferGrace) {
      if (role === 1) {
        mt._transferGrace = false;
      }
      return;
    }
    if (mt.ended) return;
    if (role === 0) {
      document.dispatchEvent(new CustomEvent('master-lost', { detail: { sessionId: mt.id } }));
    } else if (role === 1) {
      document.dispatchEvent(new CustomEvent('master-gained', { detail: { sessionId: mt.id } }));
    }
    return;
  }

  if (type === MsgMasterRequestNotify) {
    try {
      const d = JSON.parse(new TextDecoder().decode(payload));
      document.dispatchEvent(new CustomEvent('master-request', {
        detail: { sessionId: d.session_id, requesterId: d.requester_id },
      }));
    } catch { /* ignore malformed */ }
    return;
  }

  if (type === MsgPairNotify) {
    try {
      const d = JSON.parse(new TextDecoder().decode(payload));
      document.dispatchEvent(new CustomEvent('pair-request', {
        detail: { pairId: d.pair_id, deviceInfo: d.device_info, remoteAddr: d.remote_addr },
      }));
    } catch { /* ignore malformed */ }
    return;
  }

  if (type === MsgSessionEnd) {
    console.warn(`[terminal] MsgSessionEnd received for session ${mt.id} — marking as ended`);
    mt.ended = true;
    mt.onStatus('ended');
    DrawerManager.notifyDisconnect(mt.id);
    if (closeFn) closeFn();
    return;
  }

  if (type === MsgPong) {
    callbacks.setPongTime(mt.id, Date.now());
    const sentTs = callbacks.getPingTimestamp(mt.id);
    if (sentTs !== undefined) {
      callbacks.deletePingTimestamp(mt.id);
      let rtt: number;
      if (payload.length >= 4) {
        const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
        rtt = view.getUint32(0);
      } else {
        rtt = Date.now() - sentTs;
      }
      document.dispatchEvent(new CustomEvent('status-bar-pong', { detail: { sessionId: mt.id, rtt } }));
    }
    return;
  }

  if (type === MsgError) {
    const code = payload[0];
    if (code === ErrSessionNotFound) {
      mt.ended = true;
      mt.onStatus('notfound');
      if (closeFn) closeFn();
    } else if (code === ErrKicked) {
      mt.ended = true;
      mt.kicked = true;
      mt.onStatus('ended');
      document.dispatchEvent(new CustomEvent('client-kicked', { detail: { sessionId: mt.id } }));
      if (closeFn) closeFn();
    } else if (code === ErrNotMaster) {
      document.dispatchEvent(new CustomEvent('master-request-denied', { detail: { sessionId: mt.id } }));
    }
    return;
  }
}

export function connectWebSocket(mt: ManagedTerminal, callbacks: WsCallbacks): void {
  mt.onStatus('connecting');
  const wsUrl = mt.remoteWsUrl || buildWsUrl(mt._port, mt.id, mt.clientId);
  const wsToken = mt.remoteToken || mt._token;
  const socket = new WebSocket(wsUrl, buildWsProtocols(wsToken));
  socket.binaryType = 'arraybuffer';
  mt.ws = socket;

  socket.onopen = () => {
    mt.reconnectAttempt = 0;
    mt.onStatus('connected');
    callbacks.scheduleSettleResize(mt);

    // 发送当前编码设置
    const settings = callbacks.getSettings();
    if (settings && settings.encoding !== 'utf-8') {
      callbacks.sendEncoding(mt, settings.encoding);
    }

    // 通知 DrawerManager WebSocket 已就绪
    DrawerManager.setWebSocket(mt.id, socket);

    // SSH 会话：CWD 追踪 + 远程目录缓存
    if (DrawerManager.getServerInfo(mt.id)) {
      socket.addEventListener('message', (ev) => {
        try {
          const buf = ev.data as ArrayBuffer;
          if (buf.byteLength < 2) return;
          const msgType = new DataView(buf).getUint8(0);
          if (msgType === MsgFileListResp) {
            const p = new Uint8Array(buf, 1);
            const resp = JSON.parse(new TextDecoder().decode(p));
            if (resp.path && Array.isArray(resp.files)) {
              setSSHDirProbe(mt.id, resp.path, resp.files);
            }
          }
        } catch { /* ignore */ }
      });
    }
  };

  socket.onmessage = (event) => {
    handleIncomingMessage(mt, event.data as ArrayBuffer, callbacks, () => socket.close());
  };

  socket.onclose = () => {
    if (mt.ws === socket) {
      mt.ws = null;
      DrawerManager.notifyDisconnect(mt.id);
      if (!mt.ended) {
        callbacks.onReconnectNeeded(mt);
      }
    }
  };

  socket.onerror = () => {
    if (!mt.ended) {
      mt.onStatus('disconnected');
    }
  };
}

async function connectIpc(mt: ManagedTerminal, callbacks: WsCallbacks): Promise<void> {
  mt.onStatus('connecting');
  const transport = new IpcTransport(mt.id);

  transport.onmessage = (data) => {
    handleIncomingMessage(mt, data, callbacks, () => transport.close());
  };
  transport.onclose = () => {
    if (mt.transport === transport) {
      mt.transport = null;
      DrawerManager.notifyDisconnect(mt.id);
    }
  };

  try {
    await transport.connect();
    mt.transport = transport;
    mt.clientId = transport.clientId;
    mt.onStatus('connected');
    callbacks.scheduleSettleResize(mt);

    const settings = callbacks.getSettings();
    if (settings && settings.encoding !== 'utf-8') {
      callbacks.sendEncoding(mt, settings.encoding);
    }

    DrawerManager.setTransport(mt.id, transport);
  } catch (e) {
    console.error(`[terminal] IPC connect failed for session ${mt.id}:`, e);
    mt.onStatus('disconnected');
  }
}

export function connectTerminal(mt: ManagedTerminal, callbacks: WsCallbacks): void {
  if (mt.isRemote) {
    connectWebSocket(mt, callbacks);
  } else {
    void connectIpc(mt, callbacks);
  }
}

export function scheduleReconnect(mt: ManagedTerminal, connectFn: (mt: ManagedTerminal) => void): void {
  if (!mt.isRemote) return;

  if (mt.reconnectAttempt >= 30 || mt.ended) {
    mt.onStatus('disconnected');
    return;
  }

  // Exponential backoff: 1s, 2s, 4s, 8s, then cap at 10s.
  // 30 attempts × ~10s max ≈ 5 minutes of retries — enough for server restart.
  const delay = Math.min(1000 * Math.pow(2, mt.reconnectAttempt), 10000);
  mt.reconnectAttempt += 1;
  mt.onStatus('reconnecting');
  mt.reconnectTimer = setTimeout(() => {
    // Suppress role-change events briefly to prevent false overlays when old
    // and new server-side connections overlap during reconnect.
    mt._transferGrace = true;
    setTimeout(() => { mt._transferGrace = false; }, 3000);
    connectFn(mt);
  }, delay);
}
