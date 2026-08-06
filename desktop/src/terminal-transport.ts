import { invoke, Channel } from '@tauri-apps/api/core';
import { MsgInput, MsgResize } from './protocol';
import type { ManagedTerminal } from './terminal-types';

export interface TerminalTransport {
  send(data: Uint8Array): void;
  close(): void;
  readonly connected: boolean;
  onmessage: ((data: ArrayBuffer) => void) | null;
  onclose: (() => void) | null;
}

export class IpcTransport implements TerminalTransport {
  private _connected = false;
  private _sessionId: string;
  private _clientId: string | null = null;
  /** Per-transfer queues to serialize ipc_session_control invokes per transferId */
  private _controlQueues: Map<number, Promise<void>> = new Map();
  onmessage: ((data: ArrayBuffer) => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(sessionId: string) { this._sessionId = sessionId; }

  get connected(): boolean { return this._connected; }
  get clientId(): string | null { return this._clientId; }

  async connect(): Promise<{ client_id: string; role: string; cols: number; rows: number }> {
    const channel = new Channel<number[]>();
    channel.onmessage = (payload: number[]) => {
      if (this.onmessage) {
        this.onmessage(new Uint8Array(payload).buffer);
      }
    };

    const raw = await invoke<string>('ipc_connect_session', {
      sessionId: this._sessionId,
      onOutput: channel,
    });
    const hello = JSON.parse(raw);
    this._clientId = hello.client_id;
    this._connected = true;
    return hello;
  }

  send(data: Uint8Array): void {
    if (!this._connected || !this._clientId) return;
    const msgType = data[0];
    const payload = Array.from(data.slice(1));

    if (msgType === MsgInput) {
      void invoke('ipc_session_input', {
        sessionId: this._sessionId,
        clientId: this._clientId,
        data: payload,
      });
    } else if (msgType === MsgResize) {
      if (payload.length >= 4) {
        const cols = (payload[0] << 8) | payload[1];
        const rows = (payload[2] << 8) | payload[3];
        void invoke('ipc_session_resize', {
          sessionId: this._sessionId,
          clientId: this._clientId,
          cols, rows,
        });
      }
    } else {
      // Per-transfer queues to guarantee ordering within each transfer while
      // allowing different transfers to proceed in parallel.
      let queueKey = 0;
      if ((msgType === 0x0c || msgType === 0x0d || msgType === 0x0e || msgType === 0x14 || msgType === 0x15
           || msgType === 0x20 || msgType === 0x21 || msgType === 0x22) && payload.length >= 4) {
        if (msgType === 0x0d) {
          // Upload chunk: payload starts with [4B transferId]
          queueKey = (payload[0] << 24) | (payload[1] << 16) | (payload[2] << 8) | payload[3];
        } else {
          // JSON payloads: try parse transferId
          try {
            const json = JSON.parse(new TextDecoder().decode(new Uint8Array(payload)));
            queueKey = json.transferId || 0;
          } catch { queueKey = 0; }
        }
      }

      let queue = this._controlQueues.get(queueKey) || Promise.resolve();
      queue = queue.then(() =>
        invoke('ipc_session_control', {
          sessionId: this._sessionId,
          clientId: this._clientId,
          msgType,
          payload,
        }) as Promise<void>
      ).catch(err => console.error('IPC control error:', err));
      this._controlQueues.set(queueKey, queue);
    }
  }

  close(): void {
    if (this._connected && this._clientId) {
      void invoke('ipc_disconnect_session', {
        sessionId: this._sessionId,
        clientId: this._clientId,
      });
    }
    this._connected = false;
    this._clientId = null;
  }
}

interface RemoteBrokerEvent {
  kind: 'message' | 'closed';
  data?: number[];
  reason?: string | null;
}

/**
 * Native remote-desktop transport. Rust owns the saved bearer token and the
 * authenticated WebSocket; the WebView sees only terminal protocol frames.
 */
export class RemoteBrokerTransport implements TerminalTransport {
  private _connected = false;
  private _handle: string | null = null;
  private _cancelled = false;
  private _sendQueue: Promise<void> = Promise.resolve();
  onmessage: ((data: ArrayBuffer) => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly sessionId: string,
    private readonly reconnectClientId: string | null,
  ) {}

  get connected(): boolean { return this._connected; }

  async connect(): Promise<void> {
    this._cancelled = false;
    const channel = new Channel<RemoteBrokerEvent>();
    let closedBeforeReady = false;
    channel.onmessage = (event) => {
      if (event.kind === 'message' && event.data) {
        this.onmessage?.(new Uint8Array(event.data).buffer);
      } else if (event.kind === 'closed') {
        closedBeforeReady = !this._connected;
        this._connected = false;
        this._handle = null;
        this.onclose?.();
      }
    };
    const handle = await invoke<string>('remote_connect_session', {
      host: this.host,
      port: this.port,
      sessionId: this.sessionId,
      clientId: this.reconnectClientId,
      onEvent: channel,
    });
    if (closedBeforeReady || this._cancelled) {
      void invoke('remote_close_session', { handle });
      throw new Error('remote broker connection closed during setup');
    }
    this._handle = handle;
    this._connected = true;
  }

  send(data: Uint8Array): void {
    if (!this._connected || !this._handle) return;
    const handle = this._handle;
    const bytes = Array.from(data);
    this._sendQueue = this._sendQueue
      .then(() => invoke('remote_send_frame', { handle, data: bytes }) as Promise<void>)
      .catch((error) => {
        console.error('Remote broker send error:', error);
      });
  }

  close(): void {
    this._cancelled = true;
    const handle = this._handle;
    this._connected = false;
    this._handle = null;
    if (handle) void invoke('remote_close_session', { handle });
  }
}

export function sendToTerminal(mt: ManagedTerminal, data: Uint8Array): void {
  if (mt.transport && mt.transport.connected) {
    mt.transport.send(data);
  } else if (mt.ws && mt.ws.readyState === WebSocket.OPEN) {
    mt.ws.send(data);
  }
}
