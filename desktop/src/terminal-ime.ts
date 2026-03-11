import type { Terminal } from '@xterm/xterm';
import { readText as clipboardReadText, writeText as clipboardWriteText } from '@tauri-apps/plugin-clipboard-manager';
import { encodeMessage, MsgInput } from './protocol';
import type { ManagedTerminal } from './terminal-types';

/**
 * Initialize IME state on ManagedTerminal.
 * Must be called before setupKeyHandler (which references the state).
 */
export function initIMEState(mt: ManagedTerminal): void {
  (mt as any)._imeBlockKd229 = false;
  (mt as any)._imeCompStartLen = 0;
  (mt as any)._imePendingEnd = null;
  (mt as any)._imeKd229NoUpdate = false;
}

/**
 * Set up custom key event handler with IME stuck detection + clipboard shortcuts.
 * Works both before and after terminal.open().
 */
export function setupKeyHandler(mt: ManagedTerminal, terminal: Terminal): void {
  const resetStuckComposition = () => {
    const ch = (terminal as any)._core?._compositionHelper;
    if (!ch?.isComposing) return;
    ch._compositionView.classList.remove('active');
    ch._compositionView.textContent = '';
    ch._isComposing = false;
    ch._isSendingComposition = false;
    if (terminal.textarea) {
      terminal.textarea.value = terminal.textarea.value.substring(0, (mt as any)._imeCompStartLen);
    }
  };

  terminal.attachCustomKeyEventHandler((event) => {
    // WebKit Bug #165004 防护：compositionend 后的 keydown(229) 走旁路发送残留字符
    if (event.type === 'keydown' && event.keyCode === 229 && (mt as any)._imeBlockKd229) {
      return false;
    }

    // IME 卡死修复 A：浏览器已结束 composition（isComposing=false）但 xterm 仍认为在组合中
    if (event.type === 'keydown' && !event.isComposing) {
      const compositionHelper = (terminal as any)._core?._compositionHelper;
      if (compositionHelper?.isComposing) {
        if (terminal.textarea) terminal.textarea.value = '';
        compositionHelper.compositionend();
      }
    }

    // IME 卡死修复 B（flag-based）：上一轮 keydown(229) 没有伴随 compositionupdate → 卡死
    if (event.type === 'keydown' && event.keyCode === 229) {
      const ch = (terminal as any)._core?._compositionHelper;
      if (ch?.isComposing) {
        if ((mt as any)._imeKd229NoUpdate) {
          (mt as any)._imeKd229NoUpdate = false;
          resetStuckComposition();
          return true;
        }
        (mt as any)._imeKd229NoUpdate = true;
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
      if (mt.ws?.readyState === WebSocket.OPEN) {
        mt.ws.send(encodeMessage(MsgInput, new TextEncoder().encode('\x15')));
      }
      return false;
    }
    return true;
  });
}

/**
 * Set up IME composition event listeners on the terminal's textarea.
 * Must be called after terminal.open() (textarea exists only after open).
 */
export function setupCompositionListeners(mt: ManagedTerminal, terminal: Terminal): void {
  if (!terminal.textarea) return;
  const textarea = terminal.textarea;

  // Windows WebView2: 拦截原生 paste 事件，防止文本残留在 textarea 中
  textarea.addEventListener('paste', (e) => {
    e.preventDefault();
  });

  textarea.addEventListener('compositionstart', () => {
    (mt as any)._imeCompStartLen = textarea.value.length;
    (mt as any)._imeBlockKd229 = false;
    (mt as any)._imePendingEnd = null;
    (mt as any)._imeKd229NoUpdate = false;
  });

  // compositionupdate 表明 composition 仍在正常进行 → 清除卡死 flag
  textarea.addEventListener('compositionupdate', () => {
    (mt as any)._imeKd229NoUpdate = false;
  });

  // input 事件：处理 compositionend 后的提交/取消确认
  textarea.addEventListener('input', (e: Event) => {
    if (!(mt as any)._imePendingEnd) return;
    const { inputType } = e as InputEvent;
    if (!inputType) return;

    const saved = (mt as any)._imePendingEnd;
    (mt as any)._imePendingEnd = null;
    (mt as any)._imeBlockKd229 = false;

    if (inputType.startsWith('delete')) return;

    const ch = (terminal as any)._core?._compositionHelper;
    if (!ch || ch._isComposing) return;

    const input = textarea.value.substring(saved.startPos);
    if (input.length > 0) {
      ch._coreService.triggerDataEvent(input, true);
    }
  });

  textarea.addEventListener('compositionend', () => {
    const ch = (terminal as any)._core?._compositionHelper;
    if (!ch) return;
    (mt as any)._imeKd229NoUpdate = false;

    ch._isSendingComposition = false;
    (mt as any)._imeBlockKd229 = true;

    const startPos = ch._compositionPosition.start + ch._dataAlreadySent.length;
    (mt as any)._imePendingEnd = { startPos };

    requestAnimationFrame(() => {
      if (!(mt as any)._imePendingEnd) return;
      const saved = (mt as any)._imePendingEnd;
      (mt as any)._imePendingEnd = null;
      (mt as any)._imeBlockKd229 = false;

      if (ch._isComposing) return;

      const curValue = textarea.value;
      const input = curValue.substring(saved.startPos);

      if (input.length > 0 && curValue.length > (mt as any)._imeCompStartLen) {
        ch._coreService.triggerDataEvent(input, true);
      }
    });
  });
}
