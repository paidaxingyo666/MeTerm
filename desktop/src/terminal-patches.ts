import type { Terminal } from '@xterm/xterm';
import { createOverlayScrollbar } from './overlay-scrollbar';

/**
 * Patch Canvas 2D text rendering for sharper glyphs.
 *
 * xterm.js draws text on an off-screen atlas canvas via fillText().
 * WKWebView's Canvas 2D text rendering uses a different pipeline than
 * Core Text (used by native apps like iTerm2), resulting in slightly
 * bolder, less crisp text.
 *
 * `textRendering = 'geometricPrecision'` instructs the browser to
 * prioritize geometric accuracy over speed/legibility heuristics,
 * producing thinner, more precise glyph outlines — closer to what
 * Core Text renders natively.
 *
 * Must be called once before any Terminal is created.
 */
let _canvasPatched = false;
export function patchCanvasTextRendering(): void {
  if (_canvasPatched) return;
  _canvasPatched = true;

  const origGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (
    this: HTMLCanvasElement,
    type: string,
    attrs?: any,
  ): any {
    const ctx = origGetContext.call(this, type, attrs);
    if (ctx && type === '2d') {
      // Only apply to xterm canvases — avoid affecting thumbnails, screenshots, etc.
      const isXterm = this.closest?.('.xterm-screen') !== null
        || this.classList?.contains('xterm-text-layer');
      if (isXterm) {
        try { (ctx as any).textRendering = 'geometricPrecision'; } catch { /* unsupported */ }
        try { (ctx as CanvasRenderingContext2D).imageSmoothingEnabled = false; } catch { /* */ }
      }
    }
    return ctx;
  } as any;
}

/**
 * Apply GPU-accelerated CSS filter to xterm canvas for crisper glyph rendering.
 *
 * Canvas 2D fillText() on WKWebView produces softer/bolder glyphs compared
 * to Core Text (native apps like iTerm2). CSS contrast() is GPU-accelerated
 * and pushes semi-transparent AA pixels toward opaque/transparent boundaries,
 * making glyph outlines crisper. brightness() compensates for the slight
 * brightening that contrast introduces.
 *
 * NOTE: Only use CSS filter functions (contrast/brightness/saturate) here —
 * SVG filters (url(#...)) are CPU-rendered and cause frame drops on scroll.
 */
export function patchCanvasSharpness(container: HTMLElement, enabled: boolean): void {
  // Clean up previous observer
  const prevObs = (container as any).__sharpnessObs as MutationObserver | undefined;
  if (prevObs) {
    prevObs.disconnect();
    delete (container as any).__sharpnessObs;
  }

  const filterValue = enabled ? 'contrast(1.2)' : '';
  const apply = () => {
    const canvases = container.querySelectorAll<HTMLCanvasElement>('.xterm-screen canvas');
    canvases.forEach((cv) => {
      cv.style.filter = filterValue;
      cv.style.willChange = enabled ? 'contents' : '';
    });
  };
  apply();

  if (enabled) {
    const obs = new MutationObserver(apply);
    obs.observe(container, { childList: true, subtree: true });
    (container as any).__sharpnessObs = obs;
  }
}

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

  // Track whether we're in alternate screen buffer (TUI apps).
  // In alternate mode there is no scrollback, so hide the scrollbar.
  let inAlternate = terminal.buffer.active.type === 'alternate';

  // Gate the overlay scrollbar on xterm.js's real buffer state instead of
  // the viewport's scrollHeight.  When rows shrink (e.g. entering split-pane
  // layout) xterm.js pushes blank lines into scrollback, inflating
  // scrollHeight even though nothing real is scrollable.  Using
  // buffer.active.baseY === 0 as the "no scrollback" signal keeps the
  // scrollbar hidden until real content actually scrolls off-screen.
  const handle = createOverlayScrollbar({
    viewport,
    container: xtermEl,
    shouldShow: () => !inAlternate && terminal.buffer.active.baseY > 0,
  });

  terminal.buffer.onBufferChange((buf) => {
    inAlternate = buf.type === 'alternate';
    handle.sync();
  });

  handle.sync();
}
