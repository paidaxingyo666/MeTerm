import type { Terminal } from '@xterm/xterm';
import { CanvasAddon } from '@xterm/addon-canvas';
import { LigaturesAddon } from '@xterm/addon-ligatures';
import { WebglAddon } from '@xterm/addon-webgl';
import { AppSettings, getTheme, getColorSchemeBg, hexToRgba, hexToOscRgb } from './themes';
import { getFontFamily } from './fonts';
import { encodeMessage, encodeResize, MsgInput } from './protocol';
import { isWindowsPlatform } from './app-state';
import { patchCanvasBgOpacity } from './terminal-patches';
import { sendToTerminal } from './terminal-transport';
import type { ManagedTerminal } from './terminal-types';

export function applySettingsToTerminal(mt: ManagedTerminal, settings: AppSettings): void {
  const theme = getTheme(settings.theme);
  const fontFamily = getFontFamily(settings.fontFamily, settings.enableNerdFont);
  const fontWeight = settings.enableBoldFont ? 'bold' as const : 'normal' as const;

  // Use rgba background so only the background is transparent, not the text
  const bgHex = getColorSchemeBg(settings.colorScheme);
  const opacity = Math.max(20, Math.min(100, settings.opacity)) / 100;
  const hasBackgroundImage = !!settings.backgroundImage;
  // When a bg image is active, the terminal canvas must be fully transparent so
  // text floats over the image+overlay stack. The container itself is also made
  // transparent so padding areas don't show a mismatched solid color.
  // Without an image, set container background = canvas background so the
  // padding areas always match the terminal color.
  const needsTransparency = isWindowsPlatform || opacity < 1 || hasBackgroundImage;
  const bgColor = hasBackgroundImage ? 'rgba(0,0,0,0)' : (opacity < 1 ? hexToRgba(bgHex, opacity) : bgHex);
  mt.terminal.options.allowTransparency = needsTransparency;
  mt.terminal.options.theme = { ...theme, background: bgColor };
  // Padding color fix: match container background to the canvas color so the
  // padding areas don't show a mismatched color from the parent.
  // When bg image is active, keep transparent so image shows through padding areas.
  // When opacity < 1, leave transparent to avoid double-stacking (container rgba
  // on top of canvas rgba makes the terminal appear darker than intended).
  // When opacity == 1 (opaque), set the exact theme color so padding matches canvas.
  if (hasBackgroundImage) {
    mt.container.style.backgroundColor = 'transparent';
  } else if (opacity >= 1) {
    mt.container.style.backgroundColor = bgHex;
  } else {
    mt.container.style.backgroundColor = '';
  }
  mt.terminal.options.fontSize = settings.fontSize;
  mt.terminal.options.fontFamily = fontFamily;
  mt.terminal.options.fontWeight = fontWeight;
  mt.terminal.options.fontWeightBold = 'bold';

  // Manage WebGL addon based on transparency
  if (needsTransparency && mt.webglAddon) {
    // WebGL doesn't support alpha — dispose it so canvas renderer takes over
    mt.webglAddon.dispose();
    mt.webglAddon = null;
  } else if (!needsTransparency && !mt.webglAddon) {
    // Restore WebGL when transparency is no longer needed
    if (mt.canvasAddon) {
      mt.canvasAddon.dispose();
      mt.canvasAddon = null;
    }
    try {
      const webglAddon = new WebglAddon();
      mt.terminal.loadAddon(webglAddon);
      mt.webglAddon = webglAddon;
    } catch {
      // WebGL not available
    }
  }

  if (needsTransparency) {
    // Canvas addon may be stale (its renderer was replaced by WebGL) — detect
    // by checking if the text-layer canvas still exists in the DOM.
    if (mt.canvasAddon && !mt.container.querySelector('.xterm-screen canvas.xterm-text-layer')) {
      mt.canvasAddon.dispose();
      mt.canvasAddon = null;
    }
    if (!mt.canvasAddon) {
      try {
        const canvasAddon = new CanvasAddon();
        mt.terminal.loadAddon(canvasAddon);
        mt.canvasAddon = canvasAddon;
      } catch {
        // Canvas addon not available
      }
    }
    // Apply fillRect opacity patch for iTerm2-like TUI transparency
    patchCanvasBgOpacity(mt.container, opacity);
  }

  // Keep thumbnail background fully transparent — the app supplies its own
  // background behind the thumbnail, so the thumbnail canvas GPU layer must be
  // entirely see-through to avoid compositing interference in WKWebView.
  mt.thumbnailTerminal.options.theme = { ...theme, background: '#00000000' };
  mt.thumbnailTerminal.options.fontSize = settings.fontSize;
  mt.thumbnailTerminal.options.fontFamily = fontFamily;
  mt.thumbnailTerminal.options.fontWeight = fontWeight;
  mt.thumbnailTerminal.options.fontWeightBold = 'bold';

  // Manage ligatures addon
  if (settings.enableLigatures && !mt.ligaturesAddon) {
    try {
      const addon = new LigaturesAddon();
      mt.terminal.loadAddon(addon);
      mt.ligaturesAddon = addon;
    } catch {
      // Ligatures may not be supported in all environments
    }
  } else if (!settings.enableLigatures && mt.ligaturesAddon) {
    mt.ligaturesAddon.dispose();
    mt.ligaturesAddon = null;
  }

  mt.terminal.refresh(0, mt.terminal.rows - 1);
  mt.thumbnailTerminal.refresh(0, mt.thumbnailTerminal.rows - 1);

  // When theme changes, proactively report the new background/foreground
  // colors via OSC 11/10 responses so running TUI apps can auto-adapt
  // (e.g. switch between light/dark mode without restarting).
  notifyColorSchemeChange(mt, theme);
}

/**
 * Register OSC 10 (foreground) and OSC 11 (background) color query handlers.
 * When a TUI app sends \x1b]10;?\x07 or \x1b]11;?\x07, we respond with the
 * current theme colors so the app can detect light/dark mode.
 */
export function registerOscColorHandlers(
  mt: ManagedTerminal,
  terminal: Terminal,
  getSettings: () => AppSettings | null,
): void {
  terminal.parser.registerOscHandler(10, (data: string) => {
    if (data !== '?') return true; // Intercept color SET — prevent xterm.js from overriding our theme
    const settings = getSettings();
    const theme = settings ? getTheme(settings.theme) : null;
    if (!theme) return true;
    const canSend = (mt.transport && mt.transport.connected) || (mt.ws && mt.ws.readyState === WebSocket.OPEN);
    if (!canSend) return true;
    const response = `\x1b]10;${hexToOscRgb(theme.foreground)}\x07`;
    sendToTerminal(mt, encodeMessage(MsgInput, new TextEncoder().encode(response)));
    return true;
  });

  terminal.parser.registerOscHandler(11, (data: string) => {
    if (data !== '?') return true; // Intercept color SET — prevent xterm.js from overriding our theme
    const settings = getSettings();
    const theme = settings ? getTheme(settings.theme) : null;
    if (!theme) return true;
    const canSend = (mt.transport && mt.transport.connected) || (mt.ws && mt.ws.readyState === WebSocket.OPEN);
    if (!canSend) return true;
    const response = `\x1b]11;${hexToOscRgb(theme.background)}\x07`;
    sendToTerminal(mt, encodeMessage(MsgInput, new TextEncoder().encode(response)));
    return true;
  });
}

/**
 * Notify running TUI apps that the terminal color scheme changed.
 *
 * We do NOT send unsolicited OSC 10/11 reports via MsgInput because on
 * Windows, ConPTY treats them as keyboard input — the ESC byte becomes an
 * Escape key press and the remaining bytes are echoed as visible garbage
 * on the shell prompt (e.g. "]11;rgb:1e1e/1e1e/1e1e^G").
 *
 * Instead we use a resize nudge (shrink 1 col then restore) which triggers
 * SIGWINCH / WindowSizeMsg.  TUI apps that re-query OSC 11 on resize
 * (vim, neovim, etc.) will pick up the new background color.  Apps that
 * don't re-query on resize (like opencode) won't auto-switch — that's a
 * limitation of the app, not the terminal.
 */
export function notifyColorSchemeChange(mt: ManagedTerminal, theme: { foreground: string; background: string }): void {
  const canSend = (mt.transport && mt.transport.connected) || (mt.ws && mt.ws.readyState === WebSocket.OPEN);
  if (!canSend) return;
  if (mt._lastOscBg === theme.background) return;
  const isFirstSet = mt._lastOscBg === undefined;
  mt._lastOscBg = theme.background;
  if (isFirstSet) return;

  const cols = mt.lastSentCols || mt.terminal.cols;
  const rows = mt.lastSentRows || mt.terminal.rows;
  if (cols > 1) {
    sendToTerminal(mt, encodeResize(cols - 1, rows));
    setTimeout(() => {
      const stillConnected = (mt.transport && mt.transport.connected) || (mt.ws && mt.ws.readyState === WebSocket.OPEN);
      if (stillConnected) {
        sendToTerminal(mt, encodeResize(cols, rows));
      }
    }, 80);
  }
}
