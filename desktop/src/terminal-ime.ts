import type { Terminal } from '@xterm/xterm';
import { readText as clipboardReadText, writeText as clipboardWriteText } from '@tauri-apps/plugin-clipboard-manager';
import { encodeMessage, MsgInput } from './protocol';
import { sendToTerminal } from './terminal-transport';
import type { ManagedTerminal } from './terminal-types';
import type { InlineCompletion } from './cmd-completion';

/**
 * Set up custom key event handler with clipboard shortcuts + inline completion.
 * IME composition is left entirely to xterm.js's built-in compositionHelper.
 * Works both before and after terminal.open().
 */
export function setupKeyHandler(mt: ManagedTerminal, terminal: Terminal): void {
  terminal.attachCustomKeyEventHandler((event) => {

    // Inline ghost text completion key interception
    if (event.type === 'keydown' && !event.isComposing) {
      const completion = (mt as any)._inlineCompletion as InlineCompletion | undefined;
      if (completion?.isActive()) {
        if (event.key === 'ArrowRight' && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
          if (completion.handleRightArrow()) {
            event.preventDefault();
            return false;
          }
        }
        if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && !event.shiftKey && !event.ctrlKey) {
          if (completion.handleUpDown(event.key === 'ArrowUp' ? 'up' : 'down')) {
            event.preventDefault();
            return false;
          }
        }
        if (event.key === 'Escape') {
          completion.hideGhost();
          // Don't return false — let Escape propagate
        }
      }
    }

    // 阻止单独按下修饰键时 xterm.js 自动滚到底部（影响 Ctrl/Cmd+Click 文件链接）
    if (event.key === 'Meta' || event.key === 'Control') return false;

    const isMac = navigator.userAgent.includes('Mac');
    const mod = isMac ? event.metaKey : event.ctrlKey;
    if (!mod) return true;

    if (event.type === 'keydown' && event.key === 'c' && terminal.hasSelection()) {
      clipboardWriteText(terminal.getSelection());
      return false;
    }
    if (event.type === 'keydown' && event.key === 'v') {
      event.preventDefault();
      clipboardReadText().then((text) => {
        if (text) {
          terminal.paste(text);
          // Windows WebView2: 清理隐藏 textarea 残留内容，防止后续按键被吞
          if (terminal.textarea) terminal.textarea.value = '';
          terminal.focus();
        }
      });
      return false;
    }
    if (event.type === 'keydown' && event.key === 'Backspace') {
      sendToTerminal(mt, encodeMessage(MsgInput, new TextEncoder().encode('\x15')));
      return false;
    }
    return true;
  });
}

/**
 * Set up paste event listener on the terminal's textarea.
 * Must be called after terminal.open() (textarea exists only after open).
 */
export function setupPasteListener(terminal: Terminal): void {
  if (!terminal.textarea) return;
  // Windows WebView2: 拦截原生 paste 事件，防止文本残留在 textarea 中
  terminal.textarea.addEventListener('paste', (e) => {
    e.preventDefault();
  });
}
