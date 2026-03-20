import { encodeMessage, MsgFileList } from './protocol';
import { sanitizeNotificationText } from './terminal-patches';
import { prefetchDirCache } from './terminal-file-link';
import { DrawerManager } from './drawer';
import type { ManagedTerminal } from './terminal-types';

export interface OscHandlerCallbacks {
  /** Called when shell state transitions to idle (OSC 7768) */
  onShellIdle: (sessionId: string) => void;
  /** Called when hook reports its shell type via OSC 7766 meterm_init */
  onShellTypeDetected?: (sessionId: string, shellType: string) => void;
}

/**
 * Handle OSC events received from the Rust backend via MSG_OSC_EVENT.
 *
 * The Rust OscFilter intercepts OSC 7/7766/7768/9/777 sequences from terminal
 * output and sends them as structured JSON events over WebSocket. This function
 * processes those events — updating shell state, triggering callbacks, etc.
 *
 * OSC 10/11 (color queries) are NOT intercepted by Rust and continue to be
 * handled directly by xterm.js in terminal-settings.ts.
 */
export function handleOscEvents(
  mt: ManagedTerminal,
  payload: Uint8Array,
  callbacks: OscHandlerCallbacks,
  options: { includePrefetch?: boolean } = {},
): void {
  const { includePrefetch = true } = options;
  let events: OscEventPayload[];
  try {
    events = JSON.parse(new TextDecoder().decode(payload));
    if (!Array.isArray(events)) events = [events];
  } catch {
    return;
  }

  for (const ev of events) {
    switch (ev.t) {
      case 'cwd': {
        const cwd = ev.cwd;
        if (cwd && cwd !== mt.shellState.cwd) {
          mt.shellState.cwd = cwd;
          if (DrawerManager.getServerInfo(mt.id)) {
            // SSH session: request remote directory listing via SFTP
            if (mt.ws?.readyState === WebSocket.OPEN) {
              try {
                const req = JSON.stringify({ path: cwd });
                mt.ws.send(encodeMessage(MsgFileList, new TextEncoder().encode(req)));
              } catch { /* ignore */ }
            }
          } else {
            // Local session: prefetch local directory cache
            prefetchDirCache(cwd);
          }
        }
        break;
      }
      case 'marker': {
        const { id, data } = ev;
        if (id === 'meterm_init') {
          const shellTypes = ['bash', 'zsh', 'fish', 'powershell'] as const;
          const code = parseInt(data, 10);
          if (!isNaN(code) && code >= 0 && code < shellTypes.length) {
            callbacks.onShellTypeDetected?.(mt.id, shellTypes[code]);
          }
          mt.shellState.hookInjected = true;
        } else {
          const resolver = mt._oscMarkerResolvers.get(id);
          if (resolver) {
            mt._oscMarkerResolvers.delete(id);
            resolver(parseInt(data, 10) || 0);
          }
        }
        break;
      }
      case 'shell': {
        mt.shellState.lastExitCode = ev.exit ?? 0;
        mt.shellState.cwd = ev.cwd ?? '';
        mt.shellState.lastCommand = ev.cmd ?? '';
        mt.shellState.phase = 'ready';
        mt.shellState.hookInjected = true;
        if (includePrefetch && ev.cwd) {
          prefetchDirCache(ev.cwd);
        }
        callbacks.onShellIdle(mt.id);
        break;
      }
      case 'progress': {
        const state = ev.state ?? 0;
        const percent = ev.percent ?? 0;
        if (state < 0 || state > 3) break;
        document.dispatchEvent(new CustomEvent('osc-progress', {
          detail: { sessionId: mt.id, state, percent: state === 0 ? 0 : percent },
        }));
        break;
      }
      case 'notify': {
        const title = sanitizeNotificationText(ev.title || 'Terminal');
        const body = sanitizeNotificationText(ev.body || '');
        if (!body) break;
        document.dispatchEvent(new CustomEvent('osc-notify', {
          detail: { sessionId: mt.id, title, body },
        }));
        break;
      }
    }
  }
}

// --- Legacy xterm.js OSC handler registration (kept for OSC 7766 marker resolvers) ---
// OSC 7/7768/9/777 are now handled by Rust OscFilter + handleOscEvents above.
// OSC 7766 marker resolvers still need xterm.js registration because the AI agent
// sends commands and waits for marker responses — but since Rust now intercepts 7766,
// the resolver is triggered by handleOscEvents, not xterm.js.
// So we keep registerOscHandlers as a no-op (callers still import it for type compat).

/**
 * @deprecated OSC handlers are now processed via Rust MSG_OSC_EVENT.
 * This function is kept for backward compatibility but registers nothing.
 */
export function registerOscHandlers(
  _mt: ManagedTerminal,
  _terminal: import('@xterm/xterm').Terminal,
  _callbacks: OscHandlerCallbacks,
  _options?: { includeOsc7?: boolean; includePrefetch?: boolean },
): void {
  // No-op: OSC 7/7766/7768/9/777 are intercepted by Rust OscFilter.
  // OSC 10/11 are registered in terminal-settings.ts (unchanged).
}

/** Payload types matching Rust OscEvent serde output */
interface OscCwd { t: 'cwd'; cwd: string }
interface OscMarker { t: 'marker'; id: string; data: string }
interface OscShellState { t: 'shell'; exit: number; cwd: string; cmd: string }
interface OscProgress { t: 'progress'; state: number; percent: number }
interface OscNotify { t: 'notify'; title: string; body: string }
type OscEventPayload = OscCwd | OscMarker | OscShellState | OscProgress | OscNotify;
