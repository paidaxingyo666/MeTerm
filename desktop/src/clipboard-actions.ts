/**
 * clipboard-actions.ts — Clipboard operations (copy, paste, select all).
 * Extracted from main.ts.
 */
import { TabManager } from './tabs';
import { TerminalRegistry } from './terminal';
import { readText as clipboardReadText, writeText as clipboardWriteText } from '@tauri-apps/plugin-clipboard-manager';

export function getSelection(): string {
  // In split mode, get selection from focused terminal
  const focusedSessionId = TabManager.getActiveSessionId();
  if (focusedSessionId) {
    const sel = TerminalRegistry.getSessionSelection(focusedSessionId);
    if (sel) return sel;
  }
  return TerminalRegistry.getActiveSelection() || window.getSelection()?.toString() || '';
}

export function performCopy(): void {
  const selection = getSelection();
  if (selection) {
    void clipboardWriteText(selection);
  }
}

export function performPaste(): void {
  void clipboardReadText().then((text) => {
    if (!text) return;
    const active = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
    // 排除 xterm 的隐藏 textarea，否则会将文本写入 textarea 导致后续按键异常
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA') &&
        !active.classList.contains('xterm-helper-textarea')) {
      const start = active.selectionStart ?? active.value.length;
      const end = active.selectionEnd ?? active.value.length;
      const nextValue = active.value.slice(0, start) + text + active.value.slice(end);
      active.value = nextValue;
      active.selectionStart = start + text.length;
      active.selectionEnd = start + text.length;
      active.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    const focusedSessionId = TabManager.getActiveSessionId();
    if (focusedSessionId) {
      TerminalRegistry.pasteToSession(focusedSessionId, text);
    } else if (TabManager.activeTabId) {
      TerminalRegistry.pasteToActive(text);
    }
  });
}

export function performSelectAll(): void {
  const active = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
  if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
    active.select();
    return;
  }
  const selection = window.getSelection();
  if (!selection) {
    return;
  }
  const range = document.createRange();
  range.selectNodeContents(document.body);
  selection.removeAllRanges();
  selection.addRange(range);
}
