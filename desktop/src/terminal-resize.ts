import { encodeResize } from './protocol';
import { isWindowsPlatform } from './app-state';
import type { ManagedTerminal } from './terminal-types';

export function isVisible(mt: ManagedTerminal): boolean {
  if (mt.ended || !mt.container.classList.contains('active')) {
    return false;
  }
  const rect = mt.container.getBoundingClientRect();
  return rect.width >= 10 && rect.height >= 10;
}

export function sendResize(mt: ManagedTerminal, cols: number, rows: number): void {
  if (cols <= 0 || rows <= 0) {
    return;
  }
  if (mt.ws?.readyState !== WebSocket.OPEN) {
    return;
  }
  // Always send resize to trigger SIGWINCH for TUI apps
  // The backend will ignore if dimensions unchanged but still sends signal
  mt.ws.send(encodeResize(cols, rows));
  mt.lastSentCols = cols;
  mt.lastSentRows = rows;
}

/**
 * Check if data consists solely of newline characters (\n, \r, \r\n).
 * Only filter when the entire chunk is pure whitespace newlines — never
 * strip \n from chunks that also carry escape sequences or text content.
 */
export function filterPostResizeNewlines(mt: ManagedTerminal, data: Uint8Array): Uint8Array | null {
  for (let i = 0; i < data.length; i++) {
    if (data[i] !== 0x0a && data[i] !== 0x0d) { // not \n and not \r
      // Chunk contains real content — stop filtering, pass through as-is
      mt._postResizeNewlineFilter = 0;
      if (mt._postResizeFilterTimer) {
        clearTimeout(mt._postResizeFilterTimer);
        mt._postResizeFilterTimer = null;
      }
      return data;
    }
  }
  // Entire chunk is only \n / \r — drop it
  mt._postResizeNewlineFilter--;
  if (mt._postResizeNewlineFilter <= 0) {
    mt._postResizeNewlineFilter = 0;
    if (mt._postResizeFilterTimer) {
      clearTimeout(mt._postResizeFilterTimer);
      mt._postResizeFilterTimer = null;
    }
  }
  return null;
}

/**
 * Core resize implementation.
 * @param sendSignal - true: fit display AND send SIGWINCH to PTY.
 *                     false: fit display only (no PTY signal).
 *
 * Separating these two operations prevents scrollback pollution during
 * interactive window drag.  On macOS/Linux we call fitDisplay immediately
 * every frame for a smooth visual resize, but defer sendSignal until the
 * window stops moving.  Without this, zsh (and other shells) redraw their
 * prompt at every intermediate column width and each version is committed to
 * the scrollback buffer.  When the window is later expanded, xterm.js reflow
 * surfaces all those intermediate prompts as duplicate lines.
 */
export function doResizeInternal(
  mt: ManagedTerminal,
  generation: number,
  sendSignal: boolean,
  resizeGeneration: Map<string, number>,
): void {
  if (!isVisible(mt)) {
    return;
  }
  const currentGen = resizeGeneration.get(mt.id) || 0;
  if (generation !== currentGen) {
    return;
  }

  // During split-pane drag, skip resize entirely to avoid
  // buffer reflow artifacts from rapid intermediate sizes.
  // resizeAll() after drag end handles the final resize.
  if (document.body.classList.contains('split-resizing')) {
    return;
  }

  const rect = mt.container.getBoundingClientRect();
  if (rect.width < 10 || rect.height < 10) {
    return;
  }

  // Check if terminal was scrolled to bottom before resize
  const buf = mt.terminal.buffer.active;
  const wasAtBottom = buf.viewportY >= buf.baseY;

  // Use fitAddon to calculate and apply correct dimensions
  mt.fitAddon.fit();

  const cols = mt.terminal.cols;
  const rows = mt.terminal.rows;

  if (cols <= 0 || rows <= 0) {
    return;
  }

  if (mt.thumbnailTerminal.cols !== cols || mt.thumbnailTerminal.rows !== rows) {
    mt.thumbnailTerminal.resize(cols, rows);
  }

  // Send resize to backend (SIGWINCH) only when explicitly requested and
  // dimensions actually changed.  Deferring this to after the resize settles
  // avoids shells writing a prompt-redraw for every intermediate column count.
  if (sendSignal && (cols !== mt.lastSentCols || rows !== mt.lastSentRows)) {
    const inSplitPane = mt.lastSentCols > 0 && mt.lastSentRows > 0 && mt.container.closest('.split-container');
    if (inSplitPane && !mt._hasUserInput) {
      // Enable post-resize newline filter to prevent blank lines from
      // shell's SIGWINCH response (zsh themes output \n before prompt redraw).
      // Only for fresh terminals with no prior user input — once the user
      // has interacted, the \n spacing between prompts is expected behavior.
      mt._postResizeNewlineFilter = 1;
      if (mt._postResizeFilterTimer) clearTimeout(mt._postResizeFilterTimer);
      mt._postResizeFilterTimer = setTimeout(() => {
        mt._postResizeNewlineFilter = 0;
        mt._postResizeFilterTimer = null;
      }, 600);
    }

    // Bundled conpty.dll (default) does not re-emit screen content on
    // resize, so no mute/suppression is needed — just send the resize
    // and let the TUI handle SIGWINCH naturally. This matches Windows
    // Terminal's approach.
    //
    // If the system falls back to inbox kernel32.dll ConPTY (Win10),
    // ResizePseudoConsole may re-emit phantom screen content. The TUI's
    // own SIGWINCH redraw overwrites it shortly after, so the brief
    // flash is acceptable for the fallback path.
    sendResize(mt, cols, rows);
  }

  // After reflow (cols changed → lines re-wrap), viewport scroll position
  // may become incorrect. Force scroll to bottom if terminal was at bottom.
  if (wasAtBottom) {
    mt.terminal.scrollToBottom();
  }

  // Force full refresh to keep display in sync
  mt.terminal.refresh(0, rows - 1);

  // WKWebView GPU compositing fix: xterm.js schedules its canvas render via
  // requestAnimationFrame (async). During a window shrink on WKWebView/Metal,
  // the compositor may reuse the old (larger) GPU layer from the previous frame
  // before xterm.js's rAF callback fires and redraws with the new dimensions.
  // This causes a transient "more opaque" artifact that can persist.
  //
  // Fix: after the regular rAF render completes, issue one more refresh in the
  // FOLLOWING frame. By that point the compositor has committed the new canvas
  // dimensions and cleared any stale GPU content, so the second refresh renders
  // into a clean layer — eliminating the stale-pixel opacity artifact.
  //
  // Chrome (dev mode) handles this correctly with no extra step needed.
  if (import.meta.env.PROD) {
    requestAnimationFrame(() => {
      if ((resizeGeneration.get(mt.id) || 0) === generation) {
        mt.terminal.refresh(0, mt.terminal.rows - 1);
      }
    });
  }
}

export function doResize(mt: ManagedTerminal, generation: number, resizeGeneration: Map<string, number>): void {
  doResizeInternal(mt, generation, true, resizeGeneration);
}

export function fitDisplay(mt: ManagedTerminal, generation: number, resizeGeneration: Map<string, number>): void {
  doResizeInternal(mt, generation, false, resizeGeneration);
}

export function scheduleResize(mt: ManagedTerminal, resizeGeneration: Map<string, number>): void {
  const generation = (resizeGeneration.get(mt.id) || 0) + 1;
  resizeGeneration.set(mt.id, generation);

  if (mt.resizeDebounce !== null) {
    clearTimeout(mt.resizeDebounce);
  }
  mt.settleTimers.forEach((timer) => clearTimeout(timer));

  if (isWindowsPlatform) {
    // Windows/ConPTY: debounce aggressively to avoid rapid reflow
    // which corrupts line wrapping. Single resize after settle —
    // no extra settle timer to prevent double-resize conflicts
    // with the ConPTY mute window.
    mt.resizeDebounce = setTimeout(() => {
      doResize(mt, generation, resizeGeneration);
      mt.resizeDebounce = null;
    }, 150);
    mt.settleTimers = [];
  } else {
    // macOS/Linux: fit display immediately every frame for smooth visual resize,
    // but defer SIGWINCH until the window stops moving (~80 ms idle).
    // This prevents shells from writing a prompt-redraw into the scrollback
    // buffer at every intermediate column width during a drag resize.
    fitDisplay(mt, generation, resizeGeneration);

    mt.resizeDebounce = setTimeout(() => {
      doResize(mt, generation, resizeGeneration);
      mt.resizeDebounce = null;
    }, 80);

    // Settle passes in case the container size is still unstable.
    // The extra 400 ms pass catches slower layout engines (e.g. x86 WKWebView)
    // where flex siblings (AI bar, drawers) finish layout after 160 ms.
    mt.settleTimers = [
      setTimeout(() => doResize(mt, generation, resizeGeneration), 160),
      setTimeout(() => doResize(mt, generation, resizeGeneration), 400),
    ];
  }
}
