import { Terminal } from '@xterm/xterm';
import { CanvasAddon } from '@xterm/addon-canvas';
import { FitAddon } from '@xterm/addon-fit';
import { LigaturesAddon } from '@xterm/addon-ligatures';
import { SerializeAddon } from '@xterm/addon-serialize';
import { WebglAddon } from '@xterm/addon-webgl';
import {
  decodeHello,
  decodeMessage,
  encodeMessage,
  encodeResize,
  ErrSessionNotFound,
  ErrNotMaster,
  ErrKicked,
  MsgError,
  MsgHello,
  MsgInput,
  MsgOutput,
  MsgPing,
  MsgPong,
  MsgRoleChange,
  MsgSessionEnd,
  MsgSetEncoding,
  MsgMasterRequest,
  MsgMasterRequestNotify,
  MsgMasterApproval,
  MsgMasterReclaim,
  MsgPairNotify,
  MsgPairApproval,
} from './protocol';
import { buildWsProtocols, buildWsUrl } from './connection';
import { readText as clipboardReadText, writeText as clipboardWriteText } from '@tauri-apps/plugin-clipboard-manager';
import { AppSettings, getTheme, getColorSchemeBg, hexToRgba, hexToOscRgb } from './themes';
import { loadFont, getFontFamily } from './fonts';
import { DrawerManager } from './drawer';

const isWindowsPlatform = navigator.userAgent.toLowerCase().includes('windows');

function sanitizeNotificationText(text: string): string {
  return text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').slice(0, 200);
}


/**
 * Patch xterm.js viewport on Windows: force scrollBarWidth=0 so FitAddon
 * allocates full width, then attach a custom overlay scrollbar.
 */
function patchOverlayScrollbar(terminal: Terminal, container: HTMLElement): void {
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

// NOTE: patchConPtyAlternateScreen was removed — it called terminal.clear()
// (or CSI 3J) after TUI exit which interfered with ConPTY's normal-screen
// restore sequence, leaving the terminal unusable (no prompt, cursor stuck).
// Scrollback pollution from old Win10 ConPTY is minor and tolerable.

export type SessionStatus = 'connecting' | 'connected' | 'reconnecting' | 'ended' | 'notfound' | 'disconnected';

export interface SessionInfo {
  id: string;
  title: string;
  status: SessionStatus;
}

export interface ManagedTerminal {
  id: string;
  title: string;
  shellTitle: string;
  hasOscTitle: boolean;
  terminal: Terminal;
  thumbnailTerminal: Terminal;
  fitAddon: FitAddon;
  canvasAddon: CanvasAddon | null;
  webglAddon: WebglAddon | null;
  ligaturesAddon: LigaturesAddon | null;
  container: HTMLDivElement;
  thumbnailContainer: HTMLDivElement;
  ws: WebSocket | null;
  clientId: string | null;
  ended: boolean;
  reconnectAttempt: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  resizeDebounce: ReturnType<typeof setTimeout> | null;
  settleTimers: ReturnType<typeof setTimeout>[];
  lastSentCols: number;
  lastSentRows: number;
  observer: ResizeObserver | null;
  onStatus: (status: SessionStatus) => void;
  onTitleChange: (title: string) => void;
  /** Count of \n bytes to filter from incoming data after SIGWINCH, 0 = disabled */
  _postResizeNewlineFilter: number;
  _postResizeFilterTimer: ReturnType<typeof setTimeout> | null;
  /** True once user has sent any input — disables post-resize \n filter */
  _hasUserInput: boolean;
  /** Suppress MsgRoleChange during cross-window tab transfer grace period */
  _transferGrace: boolean;
  /** Remote WebSocket URL override */
  remoteWsUrl?: string;
  /** Remote authentication token */
  remoteToken?: string;
  /** Whether this is a remote viewer session */
  isRemote?: boolean;
  /** Whether this session was kicked by the host */
  kicked?: boolean;
  /** Last reported OSC background color — used to detect actual theme change */
  _lastOscBg?: string;
}

class TerminalRegistryClass {
  private terminals = new Map<string, ManagedTerminal>();
  private resizeGeneration = new Map<string, number>();
  private settings: AppSettings | null = null;
  private inputListeners = new Map<string, Set<(data: string) => void>>();
  private pingTimestamps = new Map<string, number>();
  /** Timestamp of last pong received per session — used for input-triggered health checks */
  private lastPongTime = new Map<string, number>();
  /** Debounce: don't send input-triggered pings more often than every 5s */
  private lastInputPingTime = new Map<string, number>();

  sendPing(sessionId: string): void {
    const mt = this.terminals.get(sessionId);
    if (!mt?.ws || mt.ws.readyState !== WebSocket.OPEN) return;
    const ts = Date.now();
    this.pingTimestamps.set(sessionId, ts);
    const payload = new Uint8Array(4);
    const view = new DataView(payload.buffer);
    view.setUint32(0, ts & 0xffffffff);
    mt.ws.send(encodeMessage(MsgPing, payload));
  }

  /** Send master request (viewer requesting control) */
  sendMasterRequest(sessionId: string): void {
    const mt = this.terminals.get(sessionId);
    if (!mt?.ws || mt.ws.readyState !== WebSocket.OPEN) return;
    mt.ws.send(encodeMessage(MsgMasterRequest, new Uint8Array(0)));
  }

  /** Send master approval/denial for a session */
  sendMasterApproval(sessionId: string, approved: boolean, requesterId: string): void {
    const mt = this.terminals.get(sessionId);
    if (!mt?.ws || mt.ws.readyState !== WebSocket.OPEN) return;
    const requesterBytes = new TextEncoder().encode(requesterId);
    const payload = new Uint8Array(1 + requesterBytes.length);
    payload[0] = approved ? 1 : 0;
    payload.set(requesterBytes, 1);
    mt.ws.send(encodeMessage(MsgMasterApproval, payload));
  }

  /** Reclaim master control for a session */
  sendMasterReclaim(sessionId: string): void {
    const mt = this.terminals.get(sessionId);
    if (!mt?.ws || mt.ws.readyState !== WebSocket.OPEN) return;
    mt.ws.send(encodeMessage(MsgMasterReclaim, new Uint8Array(0)));
  }

  /** Send pairing approval/denial via any active master session.
   *  Returns true if sent via WebSocket, false if no active connection available. */
  sendPairApproval(approved: boolean, pairId: string): boolean {
    const pairIdBytes = new TextEncoder().encode(pairId);
    const payload = new Uint8Array(1 + pairIdBytes.length);
    payload[0] = approved ? 1 : 0;
    payload.set(pairIdBytes, 1);
    // Send through any active WebSocket connection
    for (const mt of this.terminals.values()) {
      if (mt.ws && mt.ws.readyState === WebSocket.OPEN) {
        mt.ws.send(encodeMessage(MsgPairApproval, payload));
        return true;
      }
    }
    return false;
  }

  /** Send an immediate ping if last pong is stale — called on user input for SSH sessions */
  private maybePingOnInput(sessionId: string): void {
    const now = Date.now();
    const lastPong = this.lastPongTime.get(sessionId) ?? 0;
    const lastInputPing = this.lastInputPingTime.get(sessionId) ?? 0;
    // Only trigger if last pong is older than 5s AND we haven't sent an input-triggered ping recently
    if (now - lastPong > 5000 && now - lastInputPing > 5000) {
      this.lastInputPingTime.set(sessionId, now);
      this.sendPing(sessionId);
    }
  }

  async setSettings(settings: AppSettings): Promise<void> {
    const oldEncoding = this.settings?.encoding;
    this.settings = settings;
    await loadFont(settings.fontFamily, settings.enableNerdFont);
    this.terminals.forEach((mt) => {
      this.applySettingsToTerminal(mt);
      if (oldEncoding !== settings.encoding) {
        this.sendEncoding(mt, settings.encoding);
      }
    });
  }

  private sendEncoding(mt: ManagedTerminal, encoding: string): void {
    if (mt.ws?.readyState === WebSocket.OPEN) {
      mt.ws.send(encodeMessage(MsgSetEncoding, new TextEncoder().encode(encoding)));
    }
  }

  private applySettingsToTerminal(mt: ManagedTerminal): void {
    if (!this.settings) return;

    const theme = getTheme(this.settings.theme);
    const fontFamily = getFontFamily(this.settings.fontFamily, this.settings.enableNerdFont);
    const fontWeight = this.settings.enableBoldFont ? 'bold' as const : 'normal' as const;

    // Use rgba background so only the background is transparent, not the text
    const bgHex = getColorSchemeBg(this.settings.colorScheme);
    const opacity = Math.max(20, Math.min(100, this.settings.opacity)) / 100;
    const hasBackgroundImage = !!this.settings.backgroundImage;
    // When a bg image is active, the terminal canvas must be fully transparent so
    // text floats over the image+overlay stack. The container itself is also made
    // transparent so padding areas don't show a mismatched solid color.
    // Without an image, set container background = canvas background so the
    // padding areas (15 px left/right) always match the terminal color.
    const needsTransparency = isWindowsPlatform || opacity < 1 || hasBackgroundImage;
    const bgColor = hasBackgroundImage ? 'rgba(0,0,0,0)' : (opacity < 1 ? hexToRgba(bgHex, opacity) : bgHex);
    mt.terminal.options.allowTransparency = needsTransparency;
    mt.terminal.options.theme = { ...theme, background: bgColor };
    // Padding color fix: match container background to the canvas color so the 15px
    // left/right padding areas don't show a mismatched color from the parent.
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
    mt.terminal.options.fontSize = this.settings.fontSize;
    mt.terminal.options.fontFamily = fontFamily;
    mt.terminal.options.fontWeight = fontWeight;
    mt.terminal.options.fontWeightBold = 'bold';

    if (needsTransparency && !mt.canvasAddon) {
      try {
        const canvasAddon = new CanvasAddon();
        mt.terminal.loadAddon(canvasAddon);
        mt.canvasAddon = canvasAddon;
      } catch {
        // Canvas addon not available
      }
    }

    // Manage WebGL addon based on transparency
    if (needsTransparency && mt.webglAddon) {
      // WebGL doesn't support alpha — dispose it so canvas renderer takes over
      mt.webglAddon.dispose();
      mt.webglAddon = null;
    } else if (!needsTransparency && !mt.webglAddon) {
      // Restore WebGL when transparency is no longer needed
      try {
        const webglAddon = new WebglAddon();
        mt.terminal.loadAddon(webglAddon);
        mt.webglAddon = webglAddon;
      } catch {
        // WebGL not available
      }
    }

    // Keep thumbnail background fully transparent — the app supplies its own
    // background behind the thumbnail, so the thumbnail canvas GPU layer must be
    // entirely see-through to avoid compositing interference in WKWebView.
    mt.thumbnailTerminal.options.theme = { ...theme, background: '#00000000' };
    mt.thumbnailTerminal.options.fontSize = this.settings.fontSize;
    mt.thumbnailTerminal.options.fontFamily = fontFamily;
    mt.thumbnailTerminal.options.fontWeight = fontWeight;
    mt.thumbnailTerminal.options.fontWeightBold = 'bold';

    // Manage ligatures addon
    if (this.settings.enableLigatures && !mt.ligaturesAddon) {
      try {
        const addon = new LigaturesAddon();
        mt.terminal.loadAddon(addon);
        mt.ligaturesAddon = addon;
      } catch {
        // Ligatures may not be supported in all environments
      }
    } else if (!this.settings.enableLigatures && mt.ligaturesAddon) {
      mt.ligaturesAddon.dispose();
      mt.ligaturesAddon = null;
    }

    mt.terminal.refresh(0, mt.terminal.rows - 1);
    mt.thumbnailTerminal.refresh(0, mt.thumbnailTerminal.rows - 1);

    // When theme changes, proactively report the new background/foreground
    // colors via OSC 11/10 responses so running TUI apps can auto-adapt
    // (e.g. switch between light/dark mode without restarting).
    this.notifyColorSchemeChange(mt, theme);
  }

  /**
   * Register OSC 10 (foreground) and OSC 11 (background) color query handlers.
   * When a TUI app sends \x1b]10;?\x07 or \x1b]11;?\x07, we respond with the
   * current theme colors so the app can detect light/dark mode.
   */
  private registerOscColorHandlers(mt: ManagedTerminal, terminal: Terminal): void {
    terminal.parser.registerOscHandler(10, (data: string) => {
      if (data !== '?') return true; // Intercept color SET — prevent xterm.js from overriding our theme
      const theme = this.settings ? getTheme(this.settings.theme) : null;
      if (!theme || !mt.ws || mt.ws.readyState !== WebSocket.OPEN) return true;
      const response = `\x1b]10;${hexToOscRgb(theme.foreground)}\x07`;
      mt.ws.send(encodeMessage(MsgInput, new TextEncoder().encode(response)));
      return true;
    });

    terminal.parser.registerOscHandler(11, (data: string) => {
      if (data !== '?') return true; // Intercept color SET — prevent xterm.js from overriding our theme
      const theme = this.settings ? getTheme(this.settings.theme) : null;
      if (!theme || !mt.ws || mt.ws.readyState !== WebSocket.OPEN) return true;
      const response = `\x1b]11;${hexToOscRgb(theme.background)}\x07`;
      mt.ws.send(encodeMessage(MsgInput, new TextEncoder().encode(response)));
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
  private notifyColorSchemeChange(mt: ManagedTerminal, theme: { foreground: string; background: string }): void {
    if (!mt.ws || mt.ws.readyState !== WebSocket.OPEN) return;
    if (mt._lastOscBg === theme.background) return;
    const isFirstSet = mt._lastOscBg === undefined;
    mt._lastOscBg = theme.background;
    // First call is just initialization — don't nudge on app startup.
    if (isFirstSet) return;

    // Nudge resize: shrink by 1 col then restore after a short delay.
    // This triggers SIGWINCH, causing TUI apps that re-query terminal
    // capabilities on resize to pick up the new background color via OSC 11.
    const cols = mt.lastSentCols || mt.terminal.cols;
    const rows = mt.lastSentRows || mt.terminal.rows;
    if (cols > 1) {
      mt.ws.send(encodeResize(cols - 1, rows));
      setTimeout(() => {
        if (mt.ws?.readyState === WebSocket.OPEN) {
          mt.ws.send(encodeResize(cols, rows));
        }
      }, 80);
    }
  }

  getAllSessions(): SessionInfo[] {
    return Array.from(this.terminals.values()).map((mt) => ({
      id: mt.id,
      title: mt.shellTitle || mt.title,
      status: mt.ended ? 'ended' : mt.ws ? 'connected' : 'disconnected',
    }));
  }

  private updateShellTitle(mt: ManagedTerminal): void {
    const titlePattern = /(?:^|\s)(?:title|session|chat)\s*[:：]\s*(.+)$/i;
    const buffer = mt.terminal.buffer.active;
    const maxScanLines = Math.min(buffer.length, 80);

    for (let i = 0; i < maxScanLines; i += 1) {
      const lineIndex = buffer.length - 1 - i;
      const line = buffer.getLine(lineIndex);
      if (!line) continue;
      const content = line.translateToString(true).trim();
      if (!content) continue;

      const matched = content.match(titlePattern);
      if (!matched) continue;
      const candidate = (matched[1] || '').trim();
      if (!candidate || candidate.length < 2) continue;

      const nextTitle = candidate.slice(-70);
      if (nextTitle !== mt.shellTitle) {
        mt.shellTitle = nextTitle;
        mt.onTitleChange(nextTitle);
      }
      return;
    }
  }

  captureThumbnail(sessionId: string, width: number = 280, height: number = 160): string | null {
    const mt = this.terminals.get(sessionId);
    if (!mt || mt.ended) return null;

    try {
      mt.thumbnailTerminal.refresh(0, Math.max(0, mt.thumbnailTerminal.rows - 1));

      const canvases = Array.from(mt.thumbnailContainer.querySelectorAll('.xterm canvas')) as HTMLCanvasElement[];
      if (canvases.length === 0) return null;

      const thumbCanvas = document.createElement('canvas');
      thumbCanvas.width = width;
      thumbCanvas.height = height;
      const ctx = thumbCanvas.getContext('2d');
      if (!ctx) return null;

      // The thumbnail canvas uses allowTransparency:true, so blank cells are
      // rendered with clearRect (transparent). Fill the output canvas with the
      // theme's solid background first so the thumbnail preview has a proper
      // opaque background matching the terminal's visual appearance.
      const captureTheme = this.settings ? getTheme(this.settings.theme) : null;
      if (captureTheme?.background) {
        ctx.fillStyle = captureTheme.background;
        ctx.fillRect(0, 0, width, height);
      } else {
        ctx.clearRect(0, 0, width, height);
      }

      for (const layer of canvases) {
        if (layer.width <= 0 || layer.height <= 0) continue;
        ctx.drawImage(layer, 0, 0, layer.width, layer.height, 0, 0, width, height);
      }

      const dataUrl = thumbCanvas.toDataURL('image/png');

      if (dataUrl.length < 200) return null;

      return dataUrl;
    } catch {
      return null;
    }
  }

  private isVisible(mt: ManagedTerminal): boolean {
    if (mt.ended || !mt.container.classList.contains('active')) {
      return false;
    }
    const rect = mt.container.getBoundingClientRect();
    return rect.width >= 10 && rect.height >= 10;
  }

  private sendResize(mt: ManagedTerminal, cols: number, rows: number): void {
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
  private filterPostResizeNewlines(mt: ManagedTerminal, data: Uint8Array): Uint8Array | null {
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
  private doResizeInternal(mt: ManagedTerminal, generation: number, sendSignal: boolean): void {
    if (!this.isVisible(mt)) {
      return;
    }
    const currentGen = this.resizeGeneration.get(mt.id) || 0;
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
      this.sendResize(mt, cols, rows);
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
        if ((this.resizeGeneration.get(mt.id) || 0) === generation) {
          mt.terminal.refresh(0, mt.terminal.rows - 1);
        }
      });
    }
  }

  private doResize(mt: ManagedTerminal, generation: number): void {
    this.doResizeInternal(mt, generation, true);
  }

  private fitDisplay(mt: ManagedTerminal, generation: number): void {
    this.doResizeInternal(mt, generation, false);
  }

  private scheduleResize(mt: ManagedTerminal): void {
    const generation = (this.resizeGeneration.get(mt.id) || 0) + 1;
    this.resizeGeneration.set(mt.id, generation);

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
        this.doResize(mt, generation);
        mt.resizeDebounce = null;
      }, 150);
      mt.settleTimers = [];
    } else {
      // macOS/Linux: fit display immediately every frame for smooth visual resize,
      // but defer SIGWINCH until the window stops moving (~80 ms idle).
      // This prevents shells from writing a prompt-redraw into the scrollback
      // buffer at every intermediate column width during a drag resize.
      this.fitDisplay(mt, generation);

      mt.resizeDebounce = setTimeout(() => {
        this.doResize(mt, generation);
        mt.resizeDebounce = null;
      }, 80);

      // One settle pass in case the container size is still unstable at 80 ms
      mt.settleTimers = [
        setTimeout(() => this.doResize(mt, generation), 160),
      ];
    }
  }

  private fitAndSignal(mt: ManagedTerminal, _forceSignal: boolean): void {
    this.scheduleResize(mt);
  }

  private debouncedFitAndSignal(mt: ManagedTerminal): void {
    this.scheduleResize(mt);
  }

  private scheduleSettleResize(mt: ManagedTerminal): void {
    this.scheduleResize(mt);
  }

  create(
    sessionId: string,
    port: number,
    token: string,
    onStatus: (status: SessionStatus) => void,
    onTitleChange: (title: string) => void,
  ): ManagedTerminal {
    const container = document.createElement('div');
    container.className = 'terminal-container';

    const thumbnailContainer = document.createElement('div');
    thumbnailContainer.className = 'terminal-thumbnail-source';
    document.body.appendChild(thumbnailContainer);

    const theme = this.settings ? getTheme(this.settings.theme) : undefined;
    const fontSize = this.settings?.fontSize || 14;
    const fontFamily = this.settings
      ? getFontFamily(this.settings.fontFamily, this.settings.enableNerdFont)
      : 'Menlo, Monaco, "Courier New", monospace';
    const fontWeight = this.settings?.enableBoldFont ? 'bold' as const : 'normal' as const;
    const opacityVal = this.settings ? Math.max(20, Math.min(100, this.settings.opacity)) / 100 : 1;
    const hasBackgroundImage = !!this.settings?.backgroundImage;
    const needsTransparency = isWindowsPlatform || opacityVal < 1 || hasBackgroundImage;

    const terminalTheme = (() => {
      if (!theme) return undefined;
      const bgHex = this.settings ? getColorSchemeBg(this.settings.colorScheme) : theme.background!;
      const bg = hasBackgroundImage ? 'rgba(0,0,0,0)' : (opacityVal < 1 ? hexToRgba(bgHex, opacityVal) : bgHex);
      return { ...theme, background: bg };
    })();

    const terminal = new Terminal({
      cursorBlink: true,
      fontSize,
      fontFamily,
      fontWeight,
      fontWeightBold: 'bold',
      scrollback: 5000,
      theme: terminalTheme,
      allowTransparency: needsTransparency,
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    let canvasAddon: CanvasAddon | null = null;
    if (needsTransparency) {
      try {
        canvasAddon = new CanvasAddon();
        terminal.loadAddon(canvasAddon);
      } catch {
        canvasAddon = null;
      }
    }
    let webglAddon: WebglAddon | null = null;
    if (!needsTransparency && !isWindowsPlatform) {
      try {
        webglAddon = new WebglAddon();
        terminal.loadAddon(webglAddon);
      } catch {
        webglAddon = null;
      }
    }
    let ligaturesAddon: LigaturesAddon | null = null;
    if (this.settings?.enableLigatures) {
      try {
        ligaturesAddon = new LigaturesAddon();
        terminal.loadAddon(ligaturesAddon);
      } catch {
        ligaturesAddon = null;
      }
    }
    terminal.open(container);
    if (hasBackgroundImage) {
      container.style.backgroundColor = 'transparent';
    }
    patchOverlayScrollbar(terminal, container);
    // patchConPtyAlternateScreen removed — see note above

    const thumbnailTerminal = new Terminal({
      cursorBlink: false,
      fontSize,
      fontFamily,
      fontWeight,
      fontWeightBold: 'bold',
      scrollback: 5000,
      // Fully transparent background: the thumbnail is composited inside the app
      // which supplies its own background. A transparent background ensures the
      // thumbnail's GPU canvas layer is entirely see-through — preventing it from
      // bleeding into the main terminal's compositing in WKWebView during resize.
      theme: terminalTheme ? { ...terminalTheme, background: '#00000000' } : undefined,
      allowTransparency: true,
    });
    let thumbnailCanvasAddon: CanvasAddon | null = null;
    try {
      thumbnailCanvasAddon = new CanvasAddon();
      thumbnailTerminal.loadAddon(thumbnailCanvasAddon);
    } catch {
      thumbnailCanvasAddon = null;
    }
    thumbnailTerminal.open(thumbnailContainer);
    // The thumbnail container uses transform:scale(0.001) which makes its visual
    // bounding box ~1.28×0.72 px. Some browsers report isIntersecting=false for
    // sub-pixel boxes, which would pause xterm.js rendering. Disconnect the observer
    // and explicitly resume to guarantee continuous rendering in all environments.
    {
      const termAny = thumbnailTerminal as any;
      if (termAny._intersectionObserver) {
        termAny._intersectionObserver.disconnect();
      }
      // Resume after one frame so any async IntersectionObserver callback that
      // already fired (with isIntersecting=false) is overridden.
      requestAnimationFrame(() => {
        const core = termAny._core;
        core?._renderService?.onIntersectionChange?.(true);
        core?.viewport?.onIntersectionChange?.(true);
      });
    }
    thumbnailTerminal.resize(80, 24);
    thumbnailTerminal.refresh(0, Math.max(0, thumbnailTerminal.rows - 1));
    // Block OSC 10/11 color set commands on the thumbnail terminal.
    // Without this, SSH data containing OSC 11;#color would make the thumbnail
    // background opaque (overriding allowTransparency), causing it to bleed
    // through the main terminal in WKWebView where opacity:0 is unreliable.
    thumbnailTerminal.parser.registerOscHandler(10, (data: string) => data !== '?');
    thumbnailTerminal.parser.registerOscHandler(11, (data: string) => data !== '?');

    const mt: ManagedTerminal = {
      id: sessionId,
      title: `Terminal ${this.terminals.size + 1}`,
      shellTitle: `Terminal ${this.terminals.size + 1}`,
      hasOscTitle: false,
      terminal,
      thumbnailTerminal,
      fitAddon,
      canvasAddon,
      webglAddon,
      ligaturesAddon,
      container,
      thumbnailContainer,
      ws: null,
      clientId: null,
      ended: false,
      reconnectAttempt: 0,
      reconnectTimer: null,
      resizeDebounce: null,
      settleTimers: [],
      lastSentCols: 0,
      lastSentRows: 0,
      observer: null,
      onStatus,
      onTitleChange,
      _postResizeNewlineFilter: 0,
      _postResizeFilterTimer: null,
      _hasUserInput: false,
      _transferGrace: false,
    };

    terminal.attachCustomKeyEventHandler((event) => {
      const isMac = navigator.userAgent.includes('Mac');
      const mod = isMac ? event.metaKey : event.ctrlKey;
      if (!mod) return true;

      if (event.type === 'keydown' && event.key === 'c' && terminal.hasSelection()) {
        clipboardWriteText(terminal.getSelection());
        return false;
      }
      if (event.type === 'keydown' && event.key === 'v') {
        // Prevent the native paste event from firing (would cause double-paste on Windows)
        event.preventDefault();
        clipboardReadText().then((text) => {
          if (text) terminal.paste(text);
        });
        return false;
      }
      // Cmd+Backspace (macOS) / Ctrl+Backspace (Windows): clear current input line
      if (event.type === 'keydown' && event.key === 'Backspace') {
        if (mt.ws?.readyState === WebSocket.OPEN) {
          // Send Ctrl+U (kill line) to shell
          mt.ws.send(encodeMessage(MsgInput, new TextEncoder().encode('\x15')));
        }
        return false;
      }
      return true;
    });

    terminal.onData((data) => {
      mt._hasUserInput = true;
      if (mt.ws?.readyState === WebSocket.OPEN) {
        mt.ws.send(encodeMessage(MsgInput, new TextEncoder().encode(data)));
        // For SSH sessions: if last pong is stale, send an immediate ping to detect dead connections
        this.maybePingOnInput(mt.id);
      }
      // Notify input listeners
      const listeners = this.inputListeners.get(mt.id);
      if (listeners) {
        listeners.forEach((cb) => cb(data));
      }
    });

    terminal.onTitleChange((title) => {
      const normalized = title.trim();
      if (!normalized) return;
      mt.hasOscTitle = true;
      if (normalized !== mt.shellTitle) {
        mt.shellTitle = normalized.slice(-70);
        mt.onTitleChange(mt.shellTitle);
      }
    });

    // OSC 9 handler: progress indicator (4;state;percent) + general notification
    terminal.parser.registerOscHandler(9, (data: string) => {
      const parts = data.split(';');
      if (parts[0] === '4' && parts.length >= 3) {
        const state = parseInt(parts[1], 10);
        const percent = parseInt(parts[2], 10);
        if (isNaN(state) || state < 0 || state > 3) return false;
        if (state !== 0 && state !== 3 && (isNaN(percent) || percent < 0 || percent > 100)) return false;
        document.dispatchEvent(new CustomEvent('osc-progress', {
          detail: { sessionId: mt.id, state, percent: state === 0 ? 0 : percent },
        }));
        return true;
      }
      // General OSC 9 notification (plain text)
      const body = sanitizeNotificationText(data);
      if (!body) return false;
      document.dispatchEvent(new CustomEvent('osc-notify', {
        detail: { sessionId: mt.id, title: 'Terminal', body },
      }));
      return true;
    });

    // OSC 777 handler: notify;title;body
    terminal.parser.registerOscHandler(777, (data: string) => {
      const parts = data.split(';');
      if (parts[0] !== 'notify' || parts.length < 3) return false;
      document.dispatchEvent(new CustomEvent('osc-notify', {
        detail: {
          sessionId: mt.id,
          title: sanitizeNotificationText(parts[1]),
          body: sanitizeNotificationText(parts.slice(2).join(';')),
        },
      }));
      return true;
    });

    // OSC 10/11: foreground/background color queries from TUI apps
    this.registerOscColorHandlers(mt, terminal);

    const observer = new ResizeObserver(() => {
      this.debouncedFitAndSignal(mt);
    });
    observer.observe(container);
    mt.observer = observer;

    this.terminals.set(sessionId, mt);
    // port=-1 means skip auto-connect (used by createRemote)
    if (port >= 0) {
      this.connect(mt, port, token);
    }
    return mt;
  }

  createRemote(
    sessionId: string,
    remoteWsUrl: string,
    remoteToken: string,
    onStatus: (status: SessionStatus) => void,
    onTitleChange: (title: string) => void,
  ): ManagedTerminal {
    // Create terminal UI without connecting (port=-1 signals skip-connect).
    const mt = this.create(sessionId, -1, '', onStatus, onTitleChange);
    mt.remoteWsUrl = remoteWsUrl;
    mt.remoteToken = remoteToken;
    mt.isRemote = true;
    // Now connect with remote URL
    this.connect(mt, 0, '');
    return mt;
  }

  private connect(mt: ManagedTerminal, port: number, token: string): void {
    mt.onStatus('connecting');
    const wsUrl = mt.remoteWsUrl || buildWsUrl(port, mt.id, mt.clientId);
    const wsToken = mt.remoteToken || token;
    const socket = new WebSocket(wsUrl, buildWsProtocols(wsToken));
    socket.binaryType = 'arraybuffer';
    mt.ws = socket;

    socket.onopen = () => {
      mt.reconnectAttempt = 0;
      mt.onStatus('connected');
      this.scheduleSettleResize(mt);

      // 发送当前编码设置
      if (this.settings && this.settings.encoding !== 'utf-8') {
        this.sendEncoding(mt, this.settings.encoding);
      }

      // 通知 DrawerManager WebSocket 已就绪
      DrawerManager.setWebSocket(mt.id, socket);
    };

    socket.onmessage = (event) => {
      const decoded = decodeMessage(event.data as ArrayBuffer);
      const type = decoded.type;
      const payload = decoded.payload;

      if (type === MsgHello) {
        const hello = decodeHello(payload);
        mt.clientId = hello.client_id;
        return;
      }

      if (type === MsgOutput) {
        let data: Uint8Array | null = payload;
        // Filter pure-newline chunks that zsh themes output before prompt redraw after SIGWINCH
        if (mt._postResizeNewlineFilter > 0) {
          data = this.filterPostResizeNewlines(mt, data);
          if (!data) return;
        }
        mt.terminal.write(data);
        mt.thumbnailTerminal.write(data);
        if (!mt.hasOscTitle) {
          this.updateShellTitle(mt);
        }
        return;
      }

      if (type === MsgRoleChange) {
        const role = payload[0]; // 0=viewer, 1=master, 2=readonly
        // Suppress role changes during tab transfer grace period to avoid
        // false "remote control" overlays when both old and new connections
        // are briefly active for the same session.
        if (mt._transferGrace) {
          if (role === 1) {
            // Got master — end grace period early
            mt._transferGrace = false;
          }
          return;
        }
        if (mt.ended) return;
        if (role === 0) {
          // Lost master — show reclaim button
          document.dispatchEvent(new CustomEvent('master-lost', { detail: { sessionId: mt.id } }));
        } else if (role === 1) {
          // Regained master — hide reclaim button
          document.dispatchEvent(new CustomEvent('master-gained', { detail: { sessionId: mt.id } }));
        }
        return;
      }

      if (type === MsgMasterRequestNotify) {
        try {
          const data = JSON.parse(new TextDecoder().decode(payload));
          document.dispatchEvent(new CustomEvent('master-request', {
            detail: { sessionId: data.session_id, requesterId: data.requester_id },
          }));
        } catch { /* ignore malformed */ }
        return;
      }

      if (type === MsgPairNotify) {
        try {
          const data = JSON.parse(new TextDecoder().decode(payload));
          document.dispatchEvent(new CustomEvent('pair-request', {
            detail: { pairId: data.pair_id, deviceInfo: data.device_info, remoteAddr: data.remote_addr },
          }));
        } catch { /* ignore malformed */ }
        return;
      }

      if (type === MsgSessionEnd) {
        console.warn(`[terminal] MsgSessionEnd received for session ${mt.id} — marking as ended`);
        mt.ended = true;
        mt.onStatus('ended');
        socket.close();
        return;
      }

      if (type === MsgPong) {
        this.lastPongTime.set(mt.id, Date.now());
        const sentTs = this.pingTimestamps.get(mt.id);
        if (sentTs !== undefined) {
          this.pingTimestamps.delete(mt.id);
          // Check if backend sent SSH RTT in payload (4 bytes, big-endian uint32)
          let rtt: number;
          if (payload.length >= 4) {
            // SSH session: backend measured actual SSH round-trip time
            const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
            rtt = view.getUint32(0);
          } else {
            // Local session: use client-side RTT measurement
            rtt = Date.now() - sentTs;
          }
          document.dispatchEvent(new CustomEvent('status-bar-pong', { detail: { sessionId: mt.id, rtt } }));
        }
        return;
      }

      if (type === MsgError) {
        const code = payload[0];
        if (code === ErrSessionNotFound) {
          mt.ended = true;
          mt.onStatus('notfound');
          socket.close();
        } else if (code === ErrKicked) {
          mt.ended = true;
          mt.kicked = true;
          mt.onStatus('ended');
          document.dispatchEvent(new CustomEvent('client-kicked', { detail: { sessionId: mt.id } }));
          socket.close();
        } else if (code === ErrNotMaster) {
          document.dispatchEvent(new CustomEvent('master-request-denied', { detail: { sessionId: mt.id } }));
        }
      }
    };

    socket.onclose = () => {
      if (mt.ws === socket) {
        mt.ws = null;
        if (!mt.ended) {
          this.scheduleReconnect(mt, port, token);
        }
      }
    };

    socket.onerror = () => {
      if (!mt.ended) {
        mt.onStatus('disconnected');
      }
    };
  }

  private scheduleReconnect(mt: ManagedTerminal, port: number, token: string): void {
    if (mt.reconnectAttempt >= 10 || mt.ended) {
      mt.onStatus('disconnected');
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, mt.reconnectAttempt), 16000);
    mt.reconnectAttempt += 1;
    mt.onStatus('reconnecting');
    mt.reconnectTimer = setTimeout(() => this.connect(mt, port, token), delay);
  }

  mountTo(sessionId: string, panel: HTMLElement): void {
    const mt = this.terminals.get(sessionId);
    if (!mt) {
      return;
    }
    if (mt.container.parentElement !== panel) {
      panel.appendChild(mt.container);
    }
    mt.container.classList.add('active');
    requestAnimationFrame(() => {
      this.scheduleSettleResize(mt);
      mt.terminal.focus();
    });
  }

  /**
   * Mount terminal into a split-pane element instead of the terminal panel.
   */
  mountToPane(sessionId: string, paneEl: HTMLElement): void {
    const mt = this.terminals.get(sessionId);
    if (!mt) return;
    if (mt.container.parentElement !== paneEl) {
      paneEl.appendChild(mt.container);
    }
    mt.container.classList.add('active');
    requestAnimationFrame(() => {
      this.scheduleSettleResize(mt);
    });
  }

  /**
   * Focus a specific terminal by session ID.
   */
  focusTerminal(sessionId: string): void {
    const mt = this.terminals.get(sessionId);
    if (!mt || mt.ended) return;
    mt.terminal.focus();
  }

  /**
   * Paste text to a specific session's terminal.
   */
  pasteToSession(sessionId: string, text: string): void {
    if (!text) return;
    const mt = this.terminals.get(sessionId);
    if (!mt || mt.ended) return;
    mt.terminal.paste(text);
  }

  /**
   * Clear a specific session's terminal.
   */
  clearSession(sessionId: string): void {
    const mt = this.terminals.get(sessionId);
    if (!mt || mt.ended) return;
    mt.terminal.clear();
  }

  /**
   * Get selection from a specific session's terminal.
   */
  getSessionSelection(sessionId: string): string {
    const mt = this.terminals.get(sessionId);
    if (!mt || !mt.terminal.hasSelection()) return '';
    return mt.terminal.getSelection();
  }

  hideAll(_panel: HTMLElement): void {
    this.terminals.forEach((mt) => {
      mt.container.classList.remove('active');
    });
  }

  show(sessionId: string): void {
    const mt = this.terminals.get(sessionId);
    if (!mt) {
      return;
    }
    mt.container.classList.add('active');
    requestAnimationFrame(() => this.scheduleSettleResize(mt));
  }

  resizeAll(): void {
    this.terminals.forEach((mt) => {
      if (mt.container.classList.contains('active') && !mt.ended) {
        this.debouncedFitAndSignal(mt);
      }
    });
  }

  clearActive(): void {
    this.terminals.forEach((mt) => {
      if (mt.container.classList.contains('active') && !mt.ended) {
        mt.terminal.clear();
      }
    });
  }

  pasteToActive(text: string): void {
    if (!text) return;
    this.terminals.forEach((mt) => {
      if (mt.container.classList.contains('active') && !mt.ended) {
        mt.terminal.paste(text);
      }
    });
  }

  getActiveSelection(): string {
    for (const mt of this.terminals.values()) {
      if (mt.container.classList.contains('active') && mt.terminal.hasSelection()) {
        return mt.terminal.getSelection();
      }
    }
    return '';
  }

  onInput(sessionId: string, callback: (data: string) => void): () => void {
    if (!this.inputListeners.has(sessionId)) {
      this.inputListeners.set(sessionId, new Set());
    }
    this.inputListeners.get(sessionId)!.add(callback);
    return () => { this.inputListeners.get(sessionId)?.delete(callback); };
  }

  sendCommand(sessionId: string, command: string): void {
    const mt = this.terminals.get(sessionId);
    if (!mt?.ws || mt.ws.readyState !== WebSocket.OPEN) return;
    const payload = new TextEncoder().encode('\x15' + command + '\n');
    mt.ws.send(encodeMessage(MsgInput, payload));
  }

  get(sessionId: string): ManagedTerminal | undefined {
    return this.terminals.get(sessionId);
  }

  serializeBuffer(sessionId: string): string | null {
    const mt = this.terminals.get(sessionId);
    if (!mt) return null;
    try {
      const addon = new SerializeAddon();
      mt.terminal.loadAddon(addon);
      const content = addon.serialize();
      addon.dispose();
      return content;
    } catch {
      return null;
    }
  }

  detach(sessionId: string): void {
    const mt = this.terminals.get(sessionId);
    if (!mt) return;
    // Mark as ended to prevent reconnection attempts from onclose handler
    mt.ended = true;
    // Stop timers and observers
    if (mt.reconnectTimer) clearTimeout(mt.reconnectTimer);
    if (mt.resizeDebounce !== null) clearTimeout(mt.resizeDebounce);
    mt.settleTimers.forEach((timer) => clearTimeout(timer));
    if (mt._postResizeFilterTimer) clearTimeout(mt._postResizeFilterTimer);
    if (mt.observer) mt.observer.disconnect();
    this.inputListeners.delete(sessionId);
    // Close WebSocket
    if (mt.ws) mt.ws.close();
    // Dispose xterm instances
    if (mt.ligaturesAddon) mt.ligaturesAddon.dispose();
    if (mt.canvasAddon) mt.canvasAddon.dispose();
    mt.thumbnailTerminal.dispose();
    mt.terminal.dispose();
    mt.thumbnailContainer.remove();
    mt.container.remove();
    // Remove from registry
    this.terminals.delete(sessionId);
    this.resizeGeneration.delete(sessionId);
  }

  /**
   * Phase 1 of cross-window transfer: create terminal structure without opening.
   * terminal.open() is deferred until the container is mounted to the DOM.
   * Call openAndConnect() after mountTo() to finalize.
   */
  attachFromTransfer(
    sessionId: string,
    clientId: string | null,
    onStatus: (status: SessionStatus) => void,
    onTitleChange: (title: string) => void,
  ): ManagedTerminal {
    const container = document.createElement('div');
    container.className = 'terminal-container';

    const thumbnailContainer = document.createElement('div');
    thumbnailContainer.className = 'terminal-thumbnail-source';
    document.body.appendChild(thumbnailContainer);

    const theme = this.settings ? getTheme(this.settings.theme) : undefined;
    const fontSize = this.settings?.fontSize || 14;
    const fontFamily = this.settings
      ? getFontFamily(this.settings.fontFamily, this.settings.enableNerdFont)
      : 'Menlo, Monaco, "Courier New", monospace';
    const fontWeight = this.settings?.enableBoldFont ? 'bold' as const : 'normal' as const;
    const opacityVal = this.settings ? Math.max(20, Math.min(100, this.settings.opacity)) / 100 : 1;
    const hasBackgroundImage = !!this.settings?.backgroundImage;
    const needsTransparency = isWindowsPlatform || opacityVal < 1 || hasBackgroundImage;

    const terminalTheme = (() => {
      if (!theme) return undefined;
      const bgHex = this.settings ? getColorSchemeBg(this.settings.colorScheme) : theme.background!;
      const bg = hasBackgroundImage ? 'rgba(0,0,0,0)' : (opacityVal < 1 ? hexToRgba(bgHex, opacityVal) : bgHex);
      return { ...theme, background: bg };
    })();

    const terminal = new Terminal({
      cursorBlink: true,
      fontSize,
      fontFamily,
      fontWeight,
      fontWeightBold: 'bold',
      scrollback: 5000,
      theme: terminalTheme,
      allowTransparency: needsTransparency,
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    let canvasAddon: CanvasAddon | null = null;
    if (needsTransparency) {
      try {
        canvasAddon = new CanvasAddon();
        terminal.loadAddon(canvasAddon);
      } catch {
        canvasAddon = null;
      }
    }

    // DO NOT call terminal.open() here — container is detached from DOM.
    // WebGL/Ligatures addons are loaded in openAndConnect() after open().

    const thumbnailTerminal = new Terminal({
      cursorBlink: false,
      fontSize,
      fontFamily,
      fontWeight,
      fontWeightBold: 'bold',
      scrollback: 5000,
      // Fully transparent background: the thumbnail is composited inside the app
      // which supplies its own background. A transparent background ensures the
      // thumbnail's GPU canvas layer is entirely see-through — preventing it from
      // bleeding into the main terminal's compositing in WKWebView during resize.
      theme: terminalTheme ? { ...terminalTheme, background: '#00000000' } : undefined,
      allowTransparency: true,
    });
    let thumbnailCanvasAddon: CanvasAddon | null = null;
    try {
      thumbnailCanvasAddon = new CanvasAddon();
      thumbnailTerminal.loadAddon(thumbnailCanvasAddon);
    } catch {
      thumbnailCanvasAddon = null;
    }
    thumbnailTerminal.open(thumbnailContainer);
    // The thumbnail container uses transform:scale(0.001) which makes its visual
    // bounding box ~1.28×0.72 px. Some browsers report isIntersecting=false for
    // sub-pixel boxes, which would pause xterm.js rendering. Disconnect the observer
    // and explicitly resume to guarantee continuous rendering in all environments.
    {
      const termAny = thumbnailTerminal as any;
      if (termAny._intersectionObserver) {
        termAny._intersectionObserver.disconnect();
      }
      // Resume after one frame so any async IntersectionObserver callback that
      // already fired (with isIntersecting=false) is overridden.
      requestAnimationFrame(() => {
        const core = termAny._core;
        core?._renderService?.onIntersectionChange?.(true);
        core?.viewport?.onIntersectionChange?.(true);
      });
    }
    thumbnailTerminal.resize(80, 24);
    thumbnailTerminal.refresh(0, Math.max(0, thumbnailTerminal.rows - 1));
    // Block OSC 10/11 color set commands on the thumbnail terminal.
    // Without this, SSH data containing OSC 11;#color would make the thumbnail
    // background opaque (overriding allowTransparency), causing it to bleed
    // through the main terminal in WKWebView where opacity:0 is unreliable.
    thumbnailTerminal.parser.registerOscHandler(10, (data: string) => data !== '?');
    thumbnailTerminal.parser.registerOscHandler(11, (data: string) => data !== '?');

    const mt: ManagedTerminal = {
      id: sessionId,
      title: `Terminal ${this.terminals.size + 1}`,
      shellTitle: `Terminal ${this.terminals.size + 1}`,
      hasOscTitle: false,
      terminal,
      thumbnailTerminal,
      fitAddon,
      canvasAddon,
      webglAddon: null,
      ligaturesAddon: null,
      container,
      thumbnailContainer,
      ws: null,
      clientId,
      ended: false,
      reconnectAttempt: 0,
      reconnectTimer: null,
      resizeDebounce: null,
      settleTimers: [],
      lastSentCols: 0,
      lastSentRows: 0,
      observer: null,
      onStatus,
      onTitleChange,
      _postResizeNewlineFilter: 0,
      _postResizeFilterTimer: null,
      _hasUserInput: false,
      _transferGrace: true,
    };

    // Register event handlers — these work before open()
    terminal.attachCustomKeyEventHandler((event) => {
      const isMac = navigator.userAgent.includes('Mac');
      const mod = isMac ? event.metaKey : event.ctrlKey;
      if (!mod) return true;

      if (event.type === 'keydown' && event.key === 'c' && terminal.hasSelection()) {
        clipboardWriteText(terminal.getSelection());
        return false;
      }
      if (event.type === 'keydown' && event.key === 'v') {
        // Prevent the native paste event from firing (would cause double-paste on Windows)
        event.preventDefault();
        clipboardReadText().then((text) => {
          if (text) terminal.paste(text);
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

    terminal.onData((data) => {
      mt._hasUserInput = true;
      if (mt.ws?.readyState === WebSocket.OPEN) {
        mt.ws.send(encodeMessage(MsgInput, new TextEncoder().encode(data)));
      }
      const listeners = this.inputListeners.get(mt.id);
      if (listeners) {
        listeners.forEach((cb) => cb(data));
      }
    });

    terminal.onTitleChange((title) => {
      const normalized = title.trim();
      if (!normalized) return;
      mt.hasOscTitle = true;
      if (normalized !== mt.shellTitle) {
        mt.shellTitle = normalized.slice(-70);
        mt.onTitleChange(mt.shellTitle);
      }
    });

    // OSC 9 handler: progress indicator (4;state;percent) + general notification
    terminal.parser.registerOscHandler(9, (data: string) => {
      const parts = data.split(';');
      if (parts[0] === '4' && parts.length >= 3) {
        const state = parseInt(parts[1], 10);
        const percent = parseInt(parts[2], 10);
        if (isNaN(state) || state < 0 || state > 3) return false;
        if (state !== 0 && state !== 3 && (isNaN(percent) || percent < 0 || percent > 100)) return false;
        document.dispatchEvent(new CustomEvent('osc-progress', {
          detail: { sessionId: mt.id, state, percent: state === 0 ? 0 : percent },
        }));
        return true;
      }
      // General OSC 9 notification (plain text)
      const body = sanitizeNotificationText(data);
      if (!body) return false;
      document.dispatchEvent(new CustomEvent('osc-notify', {
        detail: { sessionId: mt.id, title: 'Terminal', body },
      }));
      return true;
    });

    // OSC 777 handler: notify;title;body
    terminal.parser.registerOscHandler(777, (data: string) => {
      const parts = data.split(';');
      if (parts[0] !== 'notify' || parts.length < 3) return false;
      document.dispatchEvent(new CustomEvent('osc-notify', {
        detail: {
          sessionId: mt.id,
          title: sanitizeNotificationText(parts[1]),
          body: sanitizeNotificationText(parts.slice(2).join(';')),
        },
      }));
      return true;
    });

    // OSC 10/11: foreground/background color queries from TUI apps
    this.registerOscColorHandlers(mt, terminal);

    const observer = new ResizeObserver(() => {
      this.debouncedFitAndSignal(mt);
    });
    observer.observe(container);
    mt.observer = observer;

    this.terminals.set(sessionId, mt);
    // DO NOT connect yet — wait for openAndConnect() after container is in DOM
    return mt;
  }

  /**
   * Phase 2 of cross-window transfer: open terminal in DOM-mounted container,
   * load rendering addons, fit, focus, and start WebSocket connection.
   */
  openAndConnect(sessionId: string, port: number, token: string): void {
    const mt = this.terminals.get(sessionId);
    if (!mt) return;

    // Open terminal — container must be in DOM at this point
    mt.terminal.open(mt.container);
    patchOverlayScrollbar(mt.terminal, mt.container);
    // patchConPtyAlternateScreen removed — see note above

    // Load WebGL addon after open (needs rendering context from DOM)
    // Skip WebGL when transparency is active — canvas renderer handles alpha better
    const opacityVal = this.settings ? Math.max(20, Math.min(100, this.settings.opacity)) / 100 : 1;
    if (!isWindowsPlatform && opacityVal >= 1 && !mt.canvasAddon) {
      try {
        const webglAddon = new WebglAddon();
        mt.terminal.loadAddon(webglAddon);
        mt.webglAddon = webglAddon;
      } catch {
        // WebGL not available, falls back to canvas renderer
      }
    }

    // Load Ligatures addon
    if (this.settings?.enableLigatures) {
      try {
        const ligaturesAddon = new LigaturesAddon();
        mt.terminal.loadAddon(ligaturesAddon);
        mt.ligaturesAddon = ligaturesAddon;
      } catch {
        // Ligatures not supported
      }
    }

    // Fit terminal to container dimensions and focus
    mt.fitAddon.fit();
    mt.terminal.focus();

    // Start WebSocket connection
    this.connect(mt, port, token);

    // Clear transfer grace period after connection settles.
    // During this window, MsgRoleChange events are suppressed to prevent
    // false "remote control" overlays caused by the old connection still
    // being active when the new one connects.
    if (mt._transferGrace) {
      setTimeout(() => { mt._transferGrace = false; }, 3000);
    }
  }

  destroy(sessionId: string): void {
    const mt = this.terminals.get(sessionId);
    if (!mt) {
      return;
    }
    mt.ended = true;
    this.inputListeners.delete(sessionId);
    if (mt.reconnectTimer) {
      clearTimeout(mt.reconnectTimer);
    }
    if (mt.resizeDebounce !== null) {
      clearTimeout(mt.resizeDebounce);
    }
    mt.settleTimers.forEach((timer) => clearTimeout(timer));
    if (mt._postResizeFilterTimer) clearTimeout(mt._postResizeFilterTimer);
    if (mt.observer) {
      mt.observer.disconnect();
    }
    if (mt.ligaturesAddon) {
      mt.ligaturesAddon.dispose();
    }
    if (mt.canvasAddon) {
      mt.canvasAddon.dispose();
    }
    if (mt.ws) {
      mt.ws.close();
    }
    mt.thumbnailTerminal.dispose();
    mt.terminal.dispose();
    mt.thumbnailContainer.remove();
    mt.container.remove();
    this.terminals.delete(sessionId);
    this.resizeGeneration.delete(sessionId);
    this.pingTimestamps.delete(sessionId);
    this.lastPongTime.delete(sessionId);
    this.lastInputPingTime.delete(sessionId);
  }
}

export const TerminalRegistry = new TerminalRegistryClass();
