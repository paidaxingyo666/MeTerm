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
      void invoke('ipc_session_control', {
        sessionId: this._sessionId,
        clientId: this._clientId,
        msgType,
        payload,
      });
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

export function sendToTerminal(mt: ManagedTerminal, data: Uint8Array): void {
  if (mt.transport && mt.transport.connected) {
    mt.transport.send(data);
  } else if (mt.ws && mt.ws.readyState === WebSocket.OPEN) {
    mt.ws.send(data);
  }
}
