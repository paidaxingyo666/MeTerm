// ─── AI Capsule: Terminal Command Capture ──────────────────
// Listens on the session's input stream to maintain a line buffer
// (used by command completion) and records executed commands into
// history — either via shell hook (OSC 7768) or fallback Enter parse.

import { TerminalRegistry } from './terminal';
import { globalCompletionIndex } from './cmd-completion-data';
import { loadSettings } from './themes';
import { injectShellHook } from './ai-tools';
import { jumpServerConfigMap, sshConfigMap, remoteInfoMap } from './app-state';
import type { AICapsuleInstance } from './ai-capsule-types';

export function startTerminalCapture(
  instance: AICapsuleInstance,
  addHistory: (inst: AICapsuleInstance, cmd: string, src: 'manual' | 'ai') => void,
): void {
  instance.lineBuffer = '';
  let escState: 'none' | 'esc' | 'csi' | 'ss3' | 'str_seq' | 'str_esc' = 'none';

  // Track user input for lineBuffer (used by completion), but NOT for history recording.
  instance.unsubInput = TerminalRegistry.onInput(instance.sessionId, (data) => {
    for (const ch of data) {
      const code = ch.charCodeAt(0);

      if (escState === 'str_seq') {
        if (ch === '\x07') { escState = 'none'; }
        else if (ch === '\x1b') { escState = 'str_esc'; }
        continue;
      }
      if (escState === 'str_esc') {
        escState = ch === '\\' ? 'none' : 'str_seq';
        continue;
      }
      if (escState === 'esc') {
        if (ch === '[') { escState = 'csi'; }
        else if (ch === 'O') { escState = 'ss3'; }
        else if (ch === ']' || ch === 'P' || ch === 'X' || ch === '^' || ch === '_') { escState = 'str_seq'; }
        else { escState = 'none'; }
        continue;
      }
      if (escState === 'csi') {
        if (code >= 0x40 && code <= 0x7E) escState = 'none';
        continue;
      }
      if (escState === 'ss3') { escState = 'none'; continue; }

      if (ch === '\x1b') { escState = 'esc'; continue; }

      if (ch === '\r' || ch === '\n') {
        // Fallback history: when hook is not installed (SSH without injection),
        // record from lineBuffer.
        const mt = TerminalRegistry.get(instance.sessionId);
        if (!mt?.shellState.hookInjected && instance.lineBuffer.trim()) {
          addHistory(instance, instance.lineBuffer.trim(), 'manual');
          globalCompletionIndex.addHistoryEntry(instance.lineBuffer.trim());
        }
        instance.lineBuffer = '';
      } else if (ch === '\x7f' || ch === '\b') {
        instance.lineBuffer = instance.lineBuffer.slice(0, -1);
      } else if (ch === '\x15') {
        instance.lineBuffer = '';
      } else if (ch === '\x03') {
        instance.lineBuffer = '';
      } else if (code >= 32) {
        instance.lineBuffer += ch;
      }
    }
  });

  // Record history from shell hook
  instance.unsubShellIdle = TerminalRegistry.onShellIdle(instance.sessionId, () => {
    const mt = TerminalRegistry.get(instance.sessionId);
    const lastCmd = mt?.shellState.lastCommand?.trim();
    if (lastCmd) {
      addHistory(instance, lastCmd, 'manual');
      globalCompletionIndex.addHistoryEntry(lastCmd);
    }
  });

  // Shell hook injection for SSH/remote sessions
  const sid = instance.sessionId;
  const isRemoteSession = sshConfigMap.has(sid) || remoteInfoMap.has(sid);
  if (isRemoteSession && !jumpServerConfigMap.has(sid) && loadSettings().shellHookInjection) {
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const tryInject = () => {
      unsubOutput();
      const mt = TerminalRegistry.get(sid);
      if (mt && !mt.shellState.hookInjected) injectShellHook(sid);
    };
    const resetTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(tryInject, 2000);
    };
    const unsubOutput = TerminalRegistry.onOutput(sid, () => {
      const mt = TerminalRegistry.get(sid);
      if (mt?.shellState.hookInjected) { unsubOutput(); return; }
      resetTimer();
    });
    resetTimer();
  }
}
