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
  MsgResize,
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
import { applyMirror, clearMirror, enterMirror, exitMirror, isMirrored } from './viewer-mirror';
import { IpcTransport, RemoteBrokerTransport } from './terminal-transport';
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
    // 以非 master 身份接入(重连时会话被手机主控/跨窗口转移后新建连接):
    // 立即按 HELLO 的 PTY 尺寸进入镜像,不等主控下一次 resize(否则空窗内全错位)。
    if (hello.role && hello.role !== 'master' && hello.cols && hello.rows) {
      enterMirror(mt.id);
      applyMirror(mt, hello.cols, hello.rows);
    }
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
    mt.thumbnailTerminal?.write(outData);

    if (!mt.hasOscTitle) {
      callbacks.updateShellTitle(mt);
    }
    return;
  }

  if (type === MsgResize) {
    // 下行 resize 广播:仅发给非 master(观看方)。主控 PTY 尺寸变了,
    // 镜像渲染按新尺寸 resize + 等比缩放居中(viewer-mirror)。
    // isMirrored 守卫:服务端广播按锁外 master_id 快照过滤,与夺回 master 并发时
    // 可能给刚变 master 的本端也发一份——无守卫会把主控终端重新标记成镜像,
    // resize 链路从此死锁(审查确认的 TOCTOU)。合法 viewer 必先经
    // master-lost/HELLO 进入镜像,守卫不影响正常路径。
    if (isMirrored(mt.id) && payload.length >= 4) {
      const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
      applyMirror(mt, view.getUint16(0), view.getUint16(2));
    }
    return;
  }

  if (type === MsgRoleChange) {
    const role = payload[0];
    if (mt._transferGrace) {
      if (role === 1) {
        mt._transferGrace = false;
        // grace 吞掉了 master-gained 事件,镜像状态要在这里同步退出,
        // 否则 exitMirror 永远无人调用,终端卡死在镜像缩放(审查确认)。
        if (isMirrored(mt.id)) exitMirror(mt);
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
      const decoded: unknown = JSON.parse(new TextDecoder().decode(payload));
      if (decoded === null || typeof decoded !== 'object') return;
      const d = decoded as Record<string, unknown>;
      const requesterConnGen = d.conn_gen;
      if (
        typeof d.session_id !== 'string'
        || typeof d.requester_id !== 'string'
        || typeof requesterConnGen !== 'number'
        || !Number.isSafeInteger(requesterConnGen)
        || requesterConnGen < 0
        || d.session_id !== mt.id
      ) {
        return;
      }
      document.dispatchEvent(new CustomEvent('master-request', {
        detail: {
          sessionId: d.session_id,
          requesterId: d.requester_id,
          requesterConnGen,
        },
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
    clearMirror(mt.id);   // 会话终结,清镜像状态(防 Map 泄漏/同 id 复用残留)
    // payload[0]==1 = 被显式删除(手机端关闭):自动移除标签;
    // 自然退出(无 payload)保持现状——标签显示"已结束"供回看。
    if (payload.length >= 1 && payload[0] === 1) {
      document.dispatchEvent(new CustomEvent('session-deleted', { detail: { sessionId: mt.id } }));
    }
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
  const wsUrl = buildWsUrl(mt._port, mt.id, mt.clientId);
  const wsToken = mt._token;
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

async function connectRemoteBroker(mt: ManagedTerminal, callbacks: WsCallbacks): Promise<void> {
  if (!mt.remoteHost || !mt.remotePort) {
    mt.onStatus('disconnected');
    return;
  }
  mt.onStatus('connecting');
  const transport = new RemoteBrokerTransport(mt.remoteHost, mt.remotePort, mt.id, mt.clientId);
  transport.onmessage = (data) => {
    handleIncomingMessage(mt, data, callbacks, () => transport.close());
  };
  transport.onclose = () => {
    if (mt.transport === transport) {
      mt.transport = null;
      DrawerManager.notifyDisconnect(mt.id);
      if (!mt.ended) callbacks.onReconnectNeeded(mt);
    }
  };

  try {
    await transport.connect();
    mt.transport = transport;
    mt.reconnectAttempt = 0;
    mt.onStatus('connected');
    callbacks.scheduleSettleResize(mt);
    const settings = callbacks.getSettings();
    if (settings && settings.encoding !== 'utf-8') {
      callbacks.sendEncoding(mt, settings.encoding);
    }
    DrawerManager.setTransport(mt.id, transport);
  } catch (error) {
    console.error(`[terminal] Remote broker connect failed for session ${mt.id}:`, error);
    mt.onStatus('disconnected');
    callbacks.onReconnectNeeded(mt);
  }
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
    void connectRemoteBroker(mt, callbacks);
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
