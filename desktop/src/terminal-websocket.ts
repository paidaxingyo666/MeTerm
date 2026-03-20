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
      // 监听 MsgFileListResp 更新远程目录缓存
      socket.addEventListener('message', (ev) => {
        try {
          const buf = ev.data as ArrayBuffer;
          if (buf.byteLength < 2) return;
          const msgType = new DataView(buf).getUint8(0);
          if (msgType === MsgFileListResp) {
            const payload = new Uint8Array(buf, 1);
            const resp = JSON.parse(new TextDecoder().decode(payload));
            if (resp.path && Array.isArray(resp.files)) {
              setSSHDirProbe(mt.id, resp.path, resp.files);
            }
          }
        } catch { /* ignore */ }
      });

    }
  };

  socket.onmessage = (event) => {
    const decoded = decodeMessage(event.data as ArrayBuffer);
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
      let data: Uint8Array | null = payload;
      // Filter pure-newline chunks that zsh themes output before prompt redraw after SIGWINCH
      if (mt._postResizeNewlineFilter > 0) {
        data = filterPostResizeNewlines(mt, data);
        if (!data) return;
      }

      // Notify output listeners (event-driven capture for AI agent)
      const outListeners = callbacks.getOutputListeners(mt.id);
      if (outListeners && outListeners.size > 0) {
        const text = new TextDecoder().decode(data);
        outListeners.forEach(cb => cb(text));
      }

      // Write to terminal — OSC 7766 markers are consumed by the parser
      // and never appear in the terminal buffer, so no filtering needed.
      mt.terminal.write(data);
      mt.thumbnailTerminal.write(data);

      if (!mt.hasOscTitle) {
        callbacks.updateShellTitle(mt);
      }
      return;
    }

    if (type === MsgRoleChange) {
      const role = payload[0]; // 0=viewer, 1=master, 2=readonly
      // Suppress role changes during tab transfer grace period to avoid
      // false "remote control" overlays when both old and new connections
      // are briefly active for the same session.
      if (mt._transferGrace) {
        if (role === 1) {
          // Got master — end grace period early
          mt._transferGrace = false;
        }
        return;
      }
      if (mt.ended) return;
      if (role === 0) {
        // Lost master — show reclaim button
        document.dispatchEvent(new CustomEvent('master-lost', { detail: { sessionId: mt.id } }));
      } else if (role === 1) {
        // Regained master — hide reclaim button
        document.dispatchEvent(new CustomEvent('master-gained', { detail: { sessionId: mt.id } }));
      }
      return;
    }

    if (type === MsgMasterRequestNotify) {
      try {
        const data = JSON.parse(new TextDecoder().decode(payload));
        document.dispatchEvent(new CustomEvent('master-request', {
          detail: { sessionId: data.session_id, requesterId: data.requester_id },
        }));
      } catch { /* ignore malformed */ }
      return;
    }

    if (type === MsgPairNotify) {
      try {
        const data = JSON.parse(new TextDecoder().decode(payload));
        document.dispatchEvent(new CustomEvent('pair-request', {
          detail: { pairId: data.pair_id, deviceInfo: data.device_info, remoteAddr: data.remote_addr },
        }));
      } catch { /* ignore malformed */ }
      return;
    }

    if (type === MsgSessionEnd) {
      console.warn(`[terminal] MsgSessionEnd received for session ${mt.id} — marking as ended`);
      mt.ended = true;
      mt.onStatus('ended');
      DrawerManager.notifyDisconnect(mt.id);
      socket.close();
      return;
    }

    if (type === MsgPong) {
      callbacks.setPongTime(mt.id, Date.now());
      const sentTs = callbacks.getPingTimestamp(mt.id);
      if (sentTs !== undefined) {
        callbacks.deletePingTimestamp(mt.id);
        // Check if backend sent SSH RTT in payload (4 bytes, big-endian uint32)
        let rtt: number;
        if (payload.length >= 4) {
          // SSH session: backend measured actual SSH round-trip time
          const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
          rtt = view.getUint32(0);
        } else {
          // Local session: use client-side RTT measurement
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
        socket.close();
      } else if (code === ErrKicked) {
        mt.ended = true;
        mt.kicked = true;
        mt.onStatus('ended');
        document.dispatchEvent(new CustomEvent('client-kicked', { detail: { sessionId: mt.id } }));
        socket.close();
      } else if (code === ErrNotMaster) {
        document.dispatchEvent(new CustomEvent('master-request-denied', { detail: { sessionId: mt.id } }));
      }
      return;
    }
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

export function scheduleReconnect(mt: ManagedTerminal, connectFn: (mt: ManagedTerminal) => void): void {
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
