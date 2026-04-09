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

    // Click-to-move selection key handler (registered by terminal-click-move.ts)
    const selHandler = (mt as any)._selectionKeyHandler as ((ev: KeyboardEvent) => boolean) | undefined;
    if (selHandler) {
      const result = selHandler(event);
      if (result === false) return false;
    }

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

/**
 * WKWebView IME 修复：解决中文输入法下非 composing 字符（标点符号等）第一次按键无效的问题。
 *
 * 根因：WKWebView 的中文 IME 在 keydown 之前就把字符写入 textarea，
 * 导致 xterm.js 内部多个路径的时序假设失效，字符可能丢失或重复。
 *
 * 策略（外部补偿，不 patch xterm.js 内部）：
 * 1. 在 textarea 上监听 input 事件，当检测到 IME 模式下的非 composing 字符插入时，
 *    通过 triggerDataEvent 主动发送。
 * 2. 配合 terminal.ts 中 onData 出口的时间窗口去重，确保无论 xterm.js 内部
 *    走了多少条路径，最终只发送一次。
 *
 * 仅在 macOS（WKWebView）上调用。Windows WebView2 是 Chromium 引擎，不需要此修复。
 */
export function applyWKWebViewIMEFix(terminal: Terminal): void {
  const textarea = terminal.textarea;
  if (!textarea) return;

  const core = (terminal as any)._core;
  const coreService = core?.coreService || core?._coreService;
  if (!coreService) return;

  // 追踪是否处于 IME keydown (keyCode 229) 周期
  let inIMEKeydown = false;

  // ─── WKWebView Backspace composition 残留修复 ───
  // WKWebView 的 IME 在 Backspace 删除最后一个 composition 字符时，
  // 不触发 compositionend/compositionupdate/input 事件，textarea 也不更新，
  // 导致 xterm.js compositionView 残留显示最后一个字符。
  //
  // 检测策略：WKWebView 中正常的 Backspace 会在 keydown 之前先触发 compositionupdate；
  // 卡住的最后一个字符则 keydown 之前无 compositionupdate。利用此差异判断。
  let isInComposition = false;
  let hadCompositionUpdateBeforeKeydown = false;

  textarea.addEventListener('compositionstart', () => {
    isInComposition = true;
  });
  textarea.addEventListener('compositionend', () => {
    isInComposition = false;
  });
  textarea.addEventListener('compositionupdate', () => {
    hadCompositionUpdateBeforeKeydown = true;
  });

  textarea.addEventListener('keydown', (ev) => {
    if (ev.keyCode === 229) inIMEKeydown = true;

    if (ev.key === 'Backspace' && isInComposition) {
      const hadUpdate = hadCompositionUpdateBeforeKeydown;
      hadCompositionUpdateBeforeKeydown = false;

      if (!hadUpdate) {
        // keydown 之前没有 compositionupdate → WKWebView 吞掉了这次 Backspace
        // 清空 textarea 防止 _finalizeComposition 把残留字符发送到 PTY
        setTimeout(() => {
          if (isInComposition) {
            textarea.value = '';
            textarea.dispatchEvent(new CompositionEvent('compositionend', { data: '' }));
          }
        }, 0);
      }
    } else {
      hadCompositionUpdateBeforeKeydown = false;
    }
  }, true);

  textarea.addEventListener('keyup', () => {
    inIMEKeydown = false;
  }, true);

  // 监听 input 事件：IME 模式下的非 composing 字符插入（中文标点等）
  // input 事件的 data 属性是可靠的数据源，不依赖 textarea 值对比
  textarea.addEventListener('input', (ev: Event) => {
    const e = ev as InputEvent;
    if (inIMEKeydown && e.inputType === 'insertText' && !e.isComposing && e.data) {
      coreService.triggerDataEvent(e.data, true);
    }
  });
}
