import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export interface LanAccessState {
  enabled: boolean;
  discoverable: boolean;
  lan_port: number;
}

const LAN_STATE_EVENT = 'lan-access-state-changed';

function parseLanAccessState(value: unknown): LanAccessState {
  if (!value || typeof value !== 'object') {
    throw new Error('invalid LAN access state');
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.enabled !== 'boolean'
    || typeof candidate.discoverable !== 'boolean'
    || typeof candidate.lan_port !== 'number'
    || !Number.isInteger(candidate.lan_port)
    || candidate.lan_port < 0
    || candidate.lan_port > 65_535
  ) {
    throw new Error('invalid LAN access state');
  }
  return {
    enabled: candidate.enabled,
    discoverable: candidate.discoverable,
    lan_port: candidate.lan_port,
  };
}

export async function getLanAccessState(): Promise<LanAccessState> {
  return parseLanAccessState(await invoke<unknown>('get_lan_access_state'));
}

export async function setLanAccess(enabled: boolean): Promise<LanAccessState> {
  return parseLanAccessState(await invoke<unknown>('set_lan_access', { enabled }));
}

export async function setLanDiscovery(enabled: boolean): Promise<LanAccessState> {
  return parseLanAccessState(await invoke<unknown>('set_lan_discovery', { enabled }));
}

export function listenLanAccessState(
  handler: (state: LanAccessState) => void,
): Promise<UnlistenFn> {
  return listen<unknown>(LAN_STATE_EVENT, (event) => {
    try {
      handler(parseLanAccessState(event.payload));
    } catch (error) {
      console.error('ignored invalid LAN access state event:', error);
    }
  });
}
