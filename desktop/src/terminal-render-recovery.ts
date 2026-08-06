import type { WebglAddon } from '@xterm/addon-webgl';
import type { ManagedTerminal } from './terminal-types';

/**
 * Rebuild xterm's renderer-only state without resizing the terminal or PTY.
 *
 * This is intentionally separate from forceFullRefresh(), whose temporary
 * cols-1 resize is required to make TUI applications handle SIGWINCH after
 * PiP exit or system wake. A normal macOS focus transition must not mutate
 * terminal dimensions or notify the PTY.
 */
export function recoverTerminalRenderer(mt: ManagedTerminal): void {
  if (mt.ended) return;

  const core = (mt.terminal as any)._core;
  core?._renderService?.onIntersectionChange?.(true);
  core?.viewport?.onIntersectionChange?.(true);

  try {
    // xterm.js documents this as the recovery path for texture corruption
    // after GPU/OS suspend. It also schedules a full renderer refresh.
    mt.terminal.clearTextureAtlas();
  } catch (error) {
    console.warn(`[terminal ${mt.id}] failed to clear texture atlas`, error);
  }

  try {
    mt.terminal.refresh(0, Math.max(0, mt.terminal.rows - 1));
  } catch (error) {
    console.warn(`[terminal ${mt.id}] failed to refresh renderer`, error);
  }
}

export function scheduleTerminalRendererRecovery(terminals: Iterable<ManagedTerminal>): void {
  const targets = Array.from(terminals).filter((mt) =>
    !mt.ended && mt.container.classList.contains('active'));

  // Let WKWebView commit the foreground Metal layer before rebuilding the
  // atlas. A second frame avoids redrawing into the stale backing surface.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      for (const mt of targets) {
        if (!mt.ended && mt.container.classList.contains('active')) {
          recoverTerminalRenderer(mt);
        }
      }
    });
  });
}

/**
 * Fall back to xterm's default renderer if a WebGL context cannot be restored.
 * The addon emits onContextLoss only after its own restoration timeout expires.
 */
export function registerWebglContextLossFallback(mt: ManagedTerminal, addon: WebglAddon): void {
  addon.onContextLoss(() => {
    if (mt.ended || mt.webglAddon !== addon) return;

    console.warn(`[terminal ${mt.id}] WebGL context lost; falling back to the default renderer`);
    try {
      addon.dispose();
    } catch (error) {
      console.warn(`[terminal ${mt.id}] failed to dispose lost WebGL renderer`, error);
    }
    if (mt.webglAddon === addon) mt.webglAddon = null;

    requestAnimationFrame(() => recoverTerminalRenderer(mt));
  });
}
