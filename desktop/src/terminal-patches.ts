import type { Terminal } from '@xterm/xterm';

export function sanitizeNotificationText(text: string): string {
  return text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').slice(0, 200);
}


/**
 * Make TUI explicit backgrounds semi-transparent (iTerm2-like behavior).
 *
 * xterm.js Canvas addon draws cell backgrounds via fillRect and text via
 * drawImage. By patching fillRect on the text-layer canvas to reduce
 * globalAlpha, explicit backgrounds become semi-transparent while text
 * stays at full opacity.
 *
 * A MutationObserver re-applies the patch if the canvas is replaced (e.g.
 * when allowTransparency toggles and _setTransparency clones the canvas).
 */
export function patchCanvasBgOpacity(container: HTMLElement, opacity: number): void {
  // Clean up previous observer if any
  const prevObs = (container as any).__bgOpacityObs as MutationObserver | undefined;
  if (prevObs) {
    prevObs.disconnect();
    delete (container as any).__bgOpacityObs;
  }
  if (opacity >= 1) return;

  const patchCtx = (canvas: HTMLCanvasElement) => {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    // If already patched (same or different opacity), get original fillRect
    const orig: typeof ctx.fillRect = (ctx as any).__origFillRect || ctx.fillRect.bind(ctx);
    (ctx as any).__origFillRect = orig;
    ctx.fillRect = function (x: number, y: number, w: number, h: number) {
      const saved = this.globalAlpha;
      this.globalAlpha = saved * opacity;
      orig(x, y, w, h);
      this.globalAlpha = saved;
    };
  };
  const tryPatch = () => {
    const cv = container.querySelector('.xterm-screen canvas.xterm-text-layer') as HTMLCanvasElement | null;
    if (cv) patchCtx(cv);
  };
  tryPatch();
  // Re-patch if the canvas is replaced (e.g. _setTransparency clones it)
  const obs = new MutationObserver(tryPatch);
  obs.observe(container, { childList: true, subtree: true });
  (container as any).__bgOpacityObs = obs;
}

/**
 * Patch xterm.js viewport on Windows: force scrollBarWidth=0 so FitAddon
 * allocates full width, then attach a custom overlay scrollbar.
 */
export function patchOverlayScrollbar(terminal: Terminal, container: HTMLElement): void {
  const core = (terminal as any)._core;
  if (core?.viewport) {
    core.viewport.scrollBarWidth = 0;
  }

  const xtermEl = container.querySelector('.xterm') as HTMLElement | null;
  const viewport = container.querySelector('.xterm-viewport') as HTMLElement | null;
  if (!xtermEl || !viewport) return;

  // Build overlay structure
  const bar = document.createElement('div');
  bar.className = 'xterm-overlay-scrollbar';
  const track = document.createElement('div');
  track.className = 'xterm-overlay-scrollbar-track';
  const thumb = document.createElement('div');
  thumb.className = 'xterm-overlay-scrollbar-thumb';
  track.appendChild(thumb);
  bar.appendChild(track);
  xtermEl.appendChild(bar);

  // Track whether we're in alternate screen buffer (TUI apps).
  // In alternate mode there is no scrollback, so hide the scrollbar.
  let inAlternate = terminal.buffer.active.type === 'alternate';
  terminal.buffer.onBufferChange((buf) => {
    inAlternate = buf.type === 'alternate';
    sync();
  });

  // --- sync thumb position / size ---
  function sync(): void {
    if (inAlternate) {
      bar.style.display = 'none';
      return;
    }
    const sh = viewport!.scrollHeight;
    const ch = viewport!.clientHeight;
    if (sh <= ch) {
      bar.style.display = 'none';
      return;
    }
    bar.style.display = '';
    const ratio = ch / sh;
    const thumbH = Math.max(20, ratio * ch);
    const maxScroll = sh - ch;
    const pct = viewport!.scrollTop / maxScroll;
    const thumbTop = pct * (ch - thumbH);
    thumb.style.height = `${thumbH}px`;
    thumb.style.transform = `translateY(${thumbTop}px)`;
  }

  viewport.addEventListener('scroll', sync, { passive: true });
  const ro = new ResizeObserver(sync);
  ro.observe(viewport);
  // Catch buffer changes (new lines, clear, etc.)
  const mo = new MutationObserver(sync);
  mo.observe(viewport, { childList: true, subtree: true, characterData: true });
  sync();

  // --- drag support ---
  let dragging = false;
  let dragStartY = 0;
  let dragStartScroll = 0;

  thumb.addEventListener('mousedown', (e: MouseEvent) => {
    dragging = true;
    dragStartY = e.clientY;
    dragStartScroll = viewport!.scrollTop;
    bar.classList.add('dragging');
    e.preventDefault();
    e.stopPropagation();
  });

  const onMouseMove = (e: MouseEvent): void => {
    if (!dragging) return;
    const ch = viewport!.clientHeight;
    const sh = viewport!.scrollHeight;
    const ratio = ch / sh;
    const thumbH = Math.max(20, ratio * ch);
    const trackH = ch - thumbH;
    const maxScroll = sh - ch;
    const dy = e.clientY - dragStartY;
    viewport!.scrollTop = dragStartScroll + (dy / trackH) * maxScroll;
  };

  const onMouseUp = (): void => {
    if (!dragging) return;
    dragging = false;
    bar.classList.remove('dragging');
  };

  // Use AbortController so document-level listeners are cleaned up when
  // the terminal DOM is removed (container.remove() in destroy()).
  const ac = new AbortController();
  document.addEventListener('mousemove', onMouseMove, { signal: ac.signal });
  document.addEventListener('mouseup', onMouseUp, { signal: ac.signal });

  // --- click-on-track to jump ---
  track.addEventListener('mousedown', (e: MouseEvent) => {
    if (e.target === thumb) return; // handled by thumb drag
    const rect = track.getBoundingClientRect();
    const clickY = e.clientY - rect.top;
    const ch = viewport!.clientHeight;
    const sh = viewport!.scrollHeight;
    const maxScroll = sh - ch;
    viewport!.scrollTop = (clickY / ch) * maxScroll;
    e.preventDefault();
  });

  // Cleanup: observe container removal from DOM to abort document listeners
  const cleanupObs = new MutationObserver(() => {
    if (!container.isConnected) {
      ac.abort();
      ro.disconnect();
      mo.disconnect();
      cleanupObs.disconnect();
    }
  });
  if (container.parentElement) {
    cleanupObs.observe(container.parentElement, { childList: true });
  }
}
