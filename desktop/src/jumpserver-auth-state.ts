/**
 * jumpserver-auth-state.ts — JumpServer authentication state (expired flags + logout).
 *
 * Central place to track "session expired" markers and perform logout side
 * effects. Kept separate from jumpserver-handler.ts to avoid circular imports
 * (panel / overlays / toolbar all consume this).
 */

import { emit } from '@tauri-apps/api/event';
import { activeJumpServers } from './app-state';

const expiredConfigs = new Set<string>();

export type JumpServerAuthState = 'expired' | 'active' | 'logged-out';

export interface JumpServerAuthChangedDetail {
  configName: string;
  state: JumpServerAuthState;
}

export function markSessionExpired(configName: string): void {
  if (expiredConfigs.has(configName)) return;
  expiredConfigs.add(configName);
  const detail: JumpServerAuthChangedDetail = { configName, state: 'expired' };
  document.dispatchEvent(new CustomEvent<JumpServerAuthChangedDetail>('jumpserver-auth-changed', { detail }));
}

export function clearExpiredFlag(configName: string): void {
  if (!expiredConfigs.delete(configName)) return;
  const detail: JumpServerAuthChangedDetail = { configName, state: 'active' };
  document.dispatchEvent(new CustomEvent<JumpServerAuthChangedDetail>('jumpserver-auth-changed', { detail }));
}

export function isSessionExpired(configName: string): boolean {
  return expiredConfigs.has(configName);
}

/**
 * Logout a JumpServer connection.
 *
 * Clears the in-memory session state (activeJumpServers map, localStorage
 * mirror, expired flag) and closes the asset browser panel if open.
 *
 * Keychain credentials are intentionally PRESERVED — they are config-level
 * artifacts ("which password to use for this saved connection"), not
 * session-level. Wiping them on every logout would block the natural
 * re-login flow (password + MFA) and produce HTTP 422 missing-field
 * errors the next time the user clicks the saved connection card. To
 * fully purge credentials, remove the JumpServer from settings — that
 * path calls `removeJumpServerConfig` → `deleteJSSecrets`.
 *
 * Does NOT close already-running SSH terminal tabs — their pty sessions
 * are independent of the JumpServer API session (connection tokens are
 * single-use and already consumed). If those tabs later disconnect,
 * `overlays.ts` will route reconnect through `ensureJSAuthenticated(force)`
 * which re-uses the preserved Keychain credentials and re-issues MFA.
 */
export async function logoutJumpServer(configName: string): Promise<void> {
  // 1. Source-of-truth mutations (synchronous)
  activeJumpServers.delete(configName);
  expiredConfigs.delete(configName);

  // 2. Persist to localStorage before UI work so cross-window re-hydration is correct
  try {
    const { syncActiveJumpServersToStorage } = await import('./jumpserver-handler');
    syncActiveJumpServersToStorage();
  } catch (e) {
    console.warn('[jumpserver] syncActiveJumpServersToStorage failed during logout:', e);
  }

  // 4. Notify other windows + same-window listeners (do this BEFORE UI work in case UI step throws)
  void emit('jumpserver-state-changed');
  const detail: JumpServerAuthChangedDetail = { configName, state: 'logged-out' };
  document.dispatchEvent(new CustomEvent<JumpServerAuthChangedDetail>('jumpserver-auth-changed', { detail }));

  // 5. Close side panel if it's showing this config
  try {
    const { isJumpServerPanelOpen, closeJumpServerPanel } = await import('./jumpserver-panel');
    if (isJumpServerPanelOpen()) {
      closeJumpServerPanel();
    }
  } catch (e) {
    console.warn('[jumpserver] closeJumpServerPanel failed during logout:', e);
  }

  // 6. Re-render toolbar (remove the connection's icon if no active connections remain)
  try {
    const { renderToolbarActions } = await import('./toolbar');
    renderToolbarActions();
  } catch (e) {
    console.warn('[jumpserver] renderToolbarActions failed during logout:', e);
  }
}
