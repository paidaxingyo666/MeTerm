import type { Terminal } from '@xterm/xterm';
import { encodeMessage, MsgFileList } from './protocol';
import { sanitizeNotificationText } from './terminal-patches';
import { prefetchDirCache } from './terminal-file-link';
import { DrawerManager } from './drawer';
import type { ManagedTerminal } from './terminal-types';

export interface OscHandlerCallbacks {
  /** Called when shell state transitions to idle (OSC 7768) */
  onShellIdle: (sessionId: string) => void;
}

/**
 * Register all OSC handlers on a terminal instance.
 * Shared between create() and attachFromTransfer().
 *
 * @param includeOsc7 - Whether to register OSC 7 (CWD tracking). Set false for
 *   attachFromTransfer where OSC 7 is not needed before connection.
 * @param includePrefetch - Whether to call prefetchDirCache in OSC 7768 handler.
 */
export function registerOscHandlers(
  mt: ManagedTerminal,
  terminal: Terminal,
  callbacks: OscHandlerCallbacks,
  options: { includeOsc7?: boolean; includePrefetch?: boolean } = {},
): void {
  const { includeOsc7 = true, includePrefetch = true } = options;

  // OSC 7766: agent command completion markers.
  // The shell sends `printf '\033]7766;MARKER_ID;EXIT_CODE\007'` which
  // xterm.js consumes silently (never written to terminal buffer).
  terminal.parser.registerOscHandler(7766, (data: string) => {
    const sep = data.indexOf(';');
    if (sep === -1) return true;
    const markerId = data.slice(0, sep);
    const exitCode = parseInt(data.slice(sep + 1), 10);
    const resolver = mt._oscMarkerResolvers.get(markerId);
    if (resolver) {
      mt._oscMarkerResolvers.delete(markerId);
      resolver(isNaN(exitCode) ? -1 : exitCode);
    }
    return true;
  });

  // OSC 7: CWD tracking.
  // macOS zsh emits this by default (via /etc/zshrc update_terminal_cwd).
  // Windows: PowerShell/cmd.exe hook injected by Go backend at shell startup.
  // SSH sessions receive OSC 7 from injected hook.
  // Format: file://hostname/path/to/dir  or  file:///path/to/dir
  if (includeOsc7) {
    terminal.parser.registerOscHandler(7, (data: string) => {
      try {
        const url = new URL(data);
        if (url.protocol === 'file:') {
          let cwd = decodeURIComponent(url.pathname);
          // Windows: URL.pathname gives /C:/path — strip leading / for valid path
          if (/^\/[A-Za-z]:/.test(cwd)) cwd = cwd.slice(1);
          if (cwd && cwd !== mt.shellState.cwd) {
            mt.shellState.cwd = cwd;
            // 本地会话：预取本地目录缓存
            // SSH 会话：通过 SFTP 请求远程目录列表
            if (DrawerManager.getServerInfo(mt.id)) {
              if (mt.ws?.readyState === WebSocket.OPEN) {
                try {
                  const req = JSON.stringify({ path: cwd });
                  mt.ws.send(encodeMessage(MsgFileList, new TextEncoder().encode(req)));
                } catch { /* ignore */ }
              }
            } else {
              prefetchDirCache(cwd);
            }
          }
        }
      } catch { /* ignore malformed URLs */ }
      return true;
    });
  }

  // OSC 7768: shell state machine (prompt hook).
  // The injected __meterm_precmd sends `\033]7768;EXIT_CODE;CWD\007` before each prompt.
  terminal.parser.registerOscHandler(7768, (data: string) => {
    const sep = data.indexOf(';');
    if (sep === -1) return true;
    const exitCode = parseInt(data.slice(0, sep), 10);
    const cwd = data.slice(sep + 1);
    mt.shellState.lastExitCode = isNaN(exitCode) ? -1 : exitCode;
    mt.shellState.cwd = cwd;
    mt.shellState.phase = 'ready';
    if (includePrefetch) {
      prefetchDirCache(cwd);
    }
    callbacks.onShellIdle(mt.id);
    return true;
  });

  // OSC 9: progress indicator (4;state;percent) + general notification
  terminal.parser.registerOscHandler(9, (data: string) => {
    const parts = data.split(';');
    if (parts[0] === '4' && parts.length >= 3) {
      const state = parseInt(parts[1], 10);
      const percent = parseInt(parts[2], 10);
      if (isNaN(state) || state < 0 || state > 3) return false;
      if (state !== 0 && state !== 3 && (isNaN(percent) || percent < 0 || percent > 100)) return false;
      document.dispatchEvent(new CustomEvent('osc-progress', {
        detail: { sessionId: mt.id, state, percent: state === 0 ? 0 : percent },
      }));
      return true;
    }
    // General OSC 9 notification (plain text)
    const body = sanitizeNotificationText(data);
    if (!body) return false;
    document.dispatchEvent(new CustomEvent('osc-notify', {
      detail: { sessionId: mt.id, title: 'Terminal', body },
    }));
    return true;
  });

  // OSC 777: notify;title;body
  terminal.parser.registerOscHandler(777, (data: string) => {
    const parts = data.split(';');
    if (parts[0] !== 'notify' || parts.length < 3) return false;
    document.dispatchEvent(new CustomEvent('osc-notify', {
      detail: {
        sessionId: mt.id,
        title: sanitizeNotificationText(parts[1]),
        body: sanitizeNotificationText(parts.slice(2).join(';')),
      },
    }));
    return true;
  });
}
