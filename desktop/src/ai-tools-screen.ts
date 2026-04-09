// ─── AI Agent: Terminal Screen Capture ────────────────────
// Grabs a PNG snapshot of the live terminal so the agent can "see"
// what's displayed — useful for TUI programs (vim / htop / tmux /
// ncurses dialogs) where the raw buffer serialization loses color,
// positioning, or line-drawing characters.
//
// Strategy:
//   1. Preferred: composite the xterm.js canvas addon layers. The
//      canvas addon paints the terminal as several overlapping
//      <canvas> elements inside `.xterm-screen` (background, text,
//      selection, link, cursor). We drawImage them in order into a
//      single off-screen canvas and return the PNG.
//   2. Fallback: if no canvases are found (dom renderer, unusual
//      DOM), render the serialized scroll buffer text manually with
//      theme colors so we still return SOMETHING the LLM can see.
//
// Output: base64 PNG (no "data:" prefix) + pixel dimensions, so the
// caller can plug it straight into a ChatMessage.image block.

import { TerminalRegistry } from './terminal';
import { stripAnsi } from './ai-tools-core';

export interface CapturedScreen {
  /** Base64 PNG, no data-URI prefix. */
  data: string;
  /** Pixel dimensions (informational). */
  width: number;
  height: number;
  /** How the image was produced — for debugging. */
  method: 'canvas-composite' | 'text-fallback';
}

/** Max pixel dimension for a captured screen (performance + token cost). */
const MAX_DIMENSION = 1600;

/**
 * Capture the terminal for the given session into a PNG.
 * Returns null if the session cannot be found.
 */
export async function captureTerminalScreen(sessionId: string): Promise<CapturedScreen | null> {
  const mt = TerminalRegistry.get(sessionId);
  if (!mt) return null;

  // (1) Try canvas composite via xterm-addon-canvas.
  const composed = tryCanvasComposite(mt);
  if (composed) return composed;

  // (2) Fallback to text-rendered canvas of the serialized buffer.
  return tryTextFallback(sessionId, mt);
}

// ─── Canvas composite (preferred) ────────────────────────

function tryCanvasComposite(
  mt: { terminal: { element?: HTMLElement | null } },
): CapturedScreen | null {
  const root = mt.terminal.element;
  if (!root) return null;
  const screen = root.querySelector('.xterm-screen') as HTMLElement | null;
  if (!screen) return null;
  const layerCanvases = Array.from(screen.querySelectorAll('canvas'));
  if (layerCanvases.length === 0) return null;

  // Use the first canvas's intrinsic pixel size as our base.
  const srcW = layerCanvases[0].width;
  const srcH = layerCanvases[0].height;
  if (srcW === 0 || srcH === 0) return null;

  // Scale down if huge.
  const scale = Math.min(1, MAX_DIMENSION / Math.max(srcW, srcH));
  const outW = Math.floor(srcW * scale);
  const outH = Math.floor(srcH * scale);

  const out = document.createElement('canvas');
  out.width = outW;
  out.height = outH;
  const ctx = out.getContext('2d');
  if (!ctx) return null;

  // Paint a solid background first — the xterm canvases are
  // transparent so without this we'd get a black PNG that shows
  // nothing in dark mode but random garbage in light mode.
  const bg = getComputedStyle(screen).backgroundColor
    || getComputedStyle(root!).backgroundColor
    || '#1e1e1e';
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, outW, outH);

  for (const layer of layerCanvases) {
    try {
      // drawImage handles scaling natively.
      ctx.drawImage(layer, 0, 0, outW, outH);
    } catch {
      // A tainted canvas (cross-origin) would throw on drawImage —
      // xterm's own canvases shouldn't be tainted, but bail out safely.
      return null;
    }
  }

  try {
    const dataUrl = out.toDataURL('image/png');
    const base64 = dataUrl.substring(dataUrl.indexOf(',') + 1);
    return {
      data: base64,
      width: outW,
      height: outH,
      method: 'canvas-composite',
    };
  } catch {
    return null;
  }
}

// ─── Text fallback (rendering the buffer ourselves) ───────

function tryTextFallback(
  sessionId: string,
  _mt: unknown,
): CapturedScreen | null {
  const raw = TerminalRegistry.serializeBuffer(sessionId);
  if (!raw) return null;
  const plain = stripAnsi(raw).replace(/\r/g, '');
  const lines = plain.split('\n');

  const cellH = 18;
  const cellW = 9;
  const paddingX = 12;
  const paddingY = 12;
  // Cap the rendered area at a reasonable size — we don't want to
  // emit a 20000px tall PNG for a huge scrollback.
  const maxLines = 80;
  const visible = lines.slice(-maxLines);
  const maxCols = Math.min(
    120,
    visible.reduce((m, l) => Math.max(m, l.length), 0) || 1,
  );
  const width = Math.min(MAX_DIMENSION, paddingX * 2 + maxCols * cellW);
  const height = Math.min(MAX_DIMENSION, paddingY * 2 + visible.length * cellH);

  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  const ctx = out.getContext('2d');
  if (!ctx) return null;

  ctx.fillStyle = '#1e1e1e';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#d4d4d4';
  ctx.font = `${Math.round(cellH * 0.75)}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
  ctx.textBaseline = 'top';

  let y = paddingY;
  for (const line of visible) {
    const clipped = line.slice(0, maxCols);
    ctx.fillText(clipped, paddingX, y);
    y += cellH;
    if (y > height - paddingY) break;
  }

  try {
    const dataUrl = out.toDataURL('image/png');
    const base64 = dataUrl.substring(dataUrl.indexOf(',') + 1);
    return {
      data: base64,
      width,
      height,
      method: 'text-fallback',
    };
  } catch {
    return null;
  }
}
