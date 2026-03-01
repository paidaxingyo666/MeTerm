import { invoke } from '@tauri-apps/api/core';

export interface MeTermConnectionInfo {
  port: number;
  token: string;
}

export async function getMeTermConnectionInfo(): Promise<MeTermConnectionInfo> {
  return invoke<MeTermConnectionInfo>('get_meterm_connection_info');
}

export async function waitForMeTerm(maxRetries = 20, intervalMs = 300): Promise<MeTermConnectionInfo> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const info = await getMeTermConnectionInfo();
      await invoke<string>('list_sessions');
      return info;
    } catch {
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('meterm not ready');
}

export function buildWsUrl(port: number, sessionId: string, clientId: string | null): string {
  let url = `ws://127.0.0.1:${port}/ws/${encodeURIComponent(sessionId)}`;
  if (clientId) {
    url += `?client_id=${encodeURIComponent(clientId)}`;
  }
  return url;
}

export function buildWsProtocols(token: string): string[] {
  return ['meterm.v1', `bearer.${token}`];
}
