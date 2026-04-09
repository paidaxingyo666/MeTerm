import { Terminal } from '@xterm/xterm';
import { CanvasAddon } from '@xterm/addon-canvas';
import { FitAddon } from '@xterm/addon-fit';
import { ImageAddon } from '@xterm/addon-image';
import { LigaturesAddon } from '@xterm/addon-ligatures';
import { SerializeAddon } from '@xterm/addon-serialize';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { openUrl } from '@tauri-apps/plugin-opener';
import { WebglAddon } from '@xterm/addon-webgl';
import {
  encodeMessage,
  MsgInput,
  MsgPing,
  MsgSetEncoding,
  MsgMasterRequest,
  MsgMasterApproval,
  MsgMasterReclaim,
  MsgPairApproval,
} from './protocol';
import { AppSettings, getTheme, getColorSchemeBg, hexToRgba } from './themes';
import { loadFont, getFontFamily, getEffectiveFontWeight } from './fonts';
import { DrawerManager } from './drawer';
import { registerFileLinkProvider, getSSHDirProbe, clearSSHDirProbe } from './terminal-file-link';
import { isWindowsPlatform } from './app-state';
import type { SessionStatus, SessionInfo, ManagedTerminal } from './terminal-types';
export type { SessionStatus, SessionInfo, ManagedTerminal } from './terminal-types';
import { patchCanvasBgOpacity, patchOverlayScrollbar, patchCanvasTextRendering, patchCanvasSharpness } from './terminal-patches';

// Patch canvas text rendering BEFORE any Terminal instance is created.
// This makes xterm.js glyph rendering sharper — closer to native Core Text.
patchCanvasTextRendering();
import {
  applySettingsToTerminal,
  registerOscColorHandlers,
} from './terminal-settings';
import { scheduleResize as _scheduleResize, sendResize } from './terminal-resize';
import { setupKeyHandler, setupPasteListener, applyWKWebViewIMEFix } from './terminal-ime';
import { handleOscEvents, type OscHandlerCallbacks } from './terminal-osc';
import { setShellType } from './ai-tools';
import { connectTerminal, connectWebSocket, scheduleReconnect as _scheduleReconnect } from './terminal-websocket';
import { sendToTerminal } from './terminal-transport';
import { InlineCompletion } from './cmd-completion';
import { globalCompletionIndex } from './cmd-completion-data';
import { setupClickToMoveCursor } from './terminal-click-move';

/**
 * Detect xterm.js auto-responses to terminal queries (DA, DECRQM, DSR,
 * window ops, OSC color reports, etc.).  These must NOT be sent back to
 * the PTY — if they reach the shell while it's at an idle prompt the
 * escape prefix gets consumed by zle and the payload appears as visible
 * garbage text (e.g. "1016,2$y", "10;rgb:d4d4/…", "570;1043t").
 */
function isTerminalAutoResponse(data: string): boolean {
  const c = data.charCodeAt(0);
  if (c !== 0x1b) return false;               // must start with ESC
  const c1 = data.charCodeAt(1);
  if (c1 === 0x5b) {                           // ESC [ — CSI sequence
    // DA1  : \x1b[?<digits;…>c
    // DA2  : \x1b[><digits;…>c
    // DSR  : \x1b[<digits;…>R   (cursor position report)
    // DECRQM: \x1b[?<digits;…>$y
    // Window ops: \x1b[<digits;…>t
    // DSR status: \x1b[<digits>n
    const tail = data.charAt(data.length - 1);
    if (tail === 'c' || tail === 'R' || tail === 't' || tail === 'n') return true;
    if (data.endsWith('$y')) return true;
    return false;
  }
  if (c1 === 0x5d) {                           // ESC ] — OSC sequence
    // OSC color reports: \x1b]<N>;rgb:…\x07  or  \x1b]<N>;rgb:…\x1b\\
    if (data.charCodeAt(data.length - 1) === 0x07) return true;
    if (data.endsWith('\x1b\\')) return true;
    return false;
  }
  return false;
}

class TerminalRegistryClass {
  private terminals = new Map<string, ManagedTerminal>();
  private resizeGeneration = new Map<string, number>();
  private settings: AppSettings | null = null;
  private inputListeners = new Map<string, Set<(data: string) => void>>();
  /** Output listeners for event-driven output capture (used by AI agent) */
  private outputListeners = new Map<string, Set<(data: string) => void>>();
  /** Shell state listeners — called when shell transitions to idle (OSC 7768) */
  private shellStateListeners = new Map<string, Set<() => void>>();
  private pingTimestamps = new Map<string, number>();
  /** Timestamp of last pong received per session — used for input-triggered health checks */
  private lastPongTime = new Map<string, number>();
  /** Debounce: don't send input-triggered pings more often than every 5s */
  private lastInputPingTime = new Map<string, number>();

  sendPing(sessionId: string): void {
    const mt = this.terminals.get(sessionId);
    if (!mt) return;
    const canSend = (mt.transport && mt.transport.connected) || (mt.ws && mt.ws.readyState === WebSocket.OPEN);
    if (!canSend) return;
    const ts = Date.now();
    this.pingTimestamps.set(sessionId, ts);
    const payload = new Uint8Array(4);
    const view = new DataView(payload.buffer);
    view.setUint32(0, ts & 0xffffffff);
    sendToTerminal(mt, encodeMessage(MsgPing, payload));
  }

  /** Send master request (viewer requesting control) */
  sendMasterRequest(sessionId: string): void {
    const mt = this.terminals.get(sessionId);
    if (!mt) return;
    sendToTerminal(mt, encodeMessage(MsgMasterRequest, new Uint8Array(0)));
  }

  /** Send master approval/denial for a session */
  sendMasterApproval(sessionId: string, approved: boolean, requesterId: string): void {
    const mt = this.terminals.get(sessionId);
    if (!mt) return;
    const requesterBytes = new TextEncoder().encode(requesterId);
    const payload = new Uint8Array(1 + requesterBytes.length);
    payload[0] = approved ? 1 : 0;
    payload.set(requesterBytes, 1);
    sendToTerminal(mt, encodeMessage(MsgMasterApproval, payload));
  }

  /** Reclaim master control for a session */
  sendMasterReclaim(sessionId: string): void {
    const mt = this.terminals.get(sessionId);
    if (!mt) return;
    sendToTerminal(mt, encodeMessage(MsgMasterReclaim, new Uint8Array(0)));
  }

  /** Send pairing approval/denial via any active master session.
   *  Returns true if sent via WebSocket, false if no active connection available. */
  sendPairApproval(approved: boolean, pairId: string): boolean {
    const pairIdBytes = new TextEncoder().encode(pairId);
    const payload = new Uint8Array(1 + pairIdBytes.length);
    payload[0] = approved ? 1 : 0;
    payload.set(pairIdBytes, 1);
    // Send through any active connection (IPC or WebSocket)
    for (const mt of this.terminals.values()) {
      const canSend = (mt.transport && mt.transport.connected) || (mt.ws && mt.ws.readyState === WebSocket.OPEN);
      if (canSend) {
        sendToTerminal(mt, encodeMessage(MsgPairApproval, payload));
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
    await loadFont(settings.fontFamily, settings.enableNerdFont, settings.fontWeight);
    this.terminals.forEach((mt) => {
      this._applySettingsToTerminal(mt);
      if (oldEncoding !== settings.encoding) {
        this.sendEncoding(mt, settings.encoding);
      }
    });
  }

  private sendEncoding(mt: ManagedTerminal, encoding: string): void {
    sendToTerminal(mt, encodeMessage(MsgSetEncoding, new TextEncoder().encode(encoding)));
  }

  private _applySettingsToTerminal(mt: ManagedTerminal): void {
    if (!this.settings) return;
    applySettingsToTerminal(mt, this.settings);
  }

  private _registerOscColorHandlers(mt: ManagedTerminal, terminal: Terminal): void {
    registerOscColorHandlers(mt, terminal, () => this.settings);
  }

  isSessionActive(sessionId: string): boolean {
    const mt = this.terminals.get(sessionId);
    return !!mt && !mt.ended;
  }

  getAllSessions(): SessionInfo[] {
    return Array.from(this.terminals.values()).map((mt) => ({
      id: mt.id,
      title: mt.shellTitle || mt.title,
      status: mt.ended ? 'ended' : (mt.transport?.connected || mt.ws) ? 'connected' : 'disconnected',
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
    if (!mt || mt.ended || !mt.thumbnailTerminal) return null;

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

  private scheduleResize(mt: ManagedTerminal): void {
    _scheduleResize(mt, this.resizeGeneration);
  }

  private debouncedFitAndSignal(mt: ManagedTerminal): void {
    this.scheduleResize(mt);
  }

  private scheduleSettleResize(mt: ManagedTerminal): void {
    this.scheduleResize(mt);
  }

  private _createThumbnailTerminal(
    container: HTMLDivElement,
    opts: { fontSize: number; fontFamily: string; fontWeight: number; terminalTheme: any },
  ): Terminal | null {
    if (this.settings?.enableThumbnail === false) return null;
    const tt = new Terminal({
      cursorBlink: false,
      fontSize: opts.fontSize,
      fontFamily: opts.fontFamily,
      fontWeight: opts.fontWeight as any,
      fontWeightBold: 'bold',
      scrollback: 5000,
      theme: opts.terminalTheme ? { ...opts.terminalTheme, background: '#00000000' } : undefined,
      allowTransparency: true,
    });
    try { tt.loadAddon(new CanvasAddon()); } catch { /* ignore */ }
    tt.open(container);
    {
      const termAny = tt as any;
      if (termAny._intersectionObserver) termAny._intersectionObserver.disconnect();
      requestAnimationFrame(() => {
        const core = termAny._core;
        core?._renderService?.onIntersectionChange?.(true);
        core?.viewport?.onIntersectionChange?.(true);
      });
    }
    tt.resize(80, 24);
    tt.refresh(0, Math.max(0, tt.rows - 1));
    // Block OSC 10/11/12 color set on thumbnail to prevent opaque background bleed
    tt.parser.registerOscHandler(10, (d: string) => d !== '?');
    tt.parser.registerOscHandler(11, (d: string) => d !== '?');
    tt.parser.registerOscHandler(12, (d: string) => d !== '?');
    tt.parser.registerOscHandler(104, () => true);
    tt.parser.registerOscHandler(110, () => true);
    tt.parser.registerOscHandler(111, () => true);
    tt.parser.registerOscHandler(112, () => true);
    return tt;
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
    const rawWeight = this.settings?.fontWeight || 400;
    const fontFamily = this.settings
      ? getFontFamily(this.settings.fontFamily, this.settings.enableNerdFont, rawWeight, this.settings.cjkFontFamily)
      : 'Menlo, Monaco, "Courier New", monospace';
    const fontWeight = this.settings
      ? getEffectiveFontWeight(this.settings.fontFamily, rawWeight)
      : 400;
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
    // Unicode 11 wide character support — improves CJK character alignment
    try {
      const unicode11 = new Unicode11Addon();
      terminal.loadAddon(unicode11);
      terminal.unicode.activeVersion = '11';
    } catch { /* ignore */ }
    terminal.open(container);
    // OSC 8 hyperlink support — makes URLs in terminal output clickable
    try { terminal.loadAddon(new WebLinksAddon((_e, uri) => { void openUrl(uri); })); } catch { /* ignore */ }
    // Sixel / iTerm2 inline image support
    try { terminal.loadAddon(new ImageAddon()); } catch { /* ignore */ }
    if (hasBackgroundImage) {
      container.style.backgroundColor = 'transparent';
    }
    // Apply opacity to explicit TUI backgrounds so they become semi-transparent
    // (like iTerm2's window-level transparency). xterm.js Canvas addon draws
    // explicit backgrounds via fillRect; text is drawn via drawImage (unaffected).
    patchCanvasBgOpacity(container, opacityVal);
    patchCanvasSharpness(container, !!this.settings?.fontSharpness);
    patchOverlayScrollbar(terminal, container);
    // patchConPtyAlternateScreen removed — see note above

    const thumbnailTerminal = this._createThumbnailTerminal(thumbnailContainer, {
      fontSize, fontFamily, fontWeight, terminalTheme,
    });

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
      transport: null,
      clientId: null,
      ended: false,
      reconnectAttempt: 0,
      reconnectTimer: null,
      _port: port,
      _token: token,
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
      _oscMarkerResolvers: new Map(),
      shellState: { phase: 'unknown', lastExitCode: 0, cwd: '', hookInjected: false, lastInputSource: 'none', lastUserInputAt: 0, agentCommandSeq: 0, lastCommand: '', promptRow: -1, promptCol: 0 },
    };

    // OSC 7/7766/7768/9/777 are intercepted by Rust OscFilter and delivered
    // via MSG_OSC_EVENT → wsCallbacks.onOscEvent → handleOscEvents.
    // OSC 10/11 (color queries) remain in terminal-settings.ts.

    // Viewport scroll stabilization.
    //
    // xterm.js's _refresh() transiently sets scrollArea.style.height to
    // smaller values during buffer reflow (e.g. Ink cursor-up + rewrite).
    // This causes the BROWSER to natively clamp scrollTop (bypassing any
    // JS-level interception). When the height recovers, scrollTop stays
    // at the clamped value — the viewport jumps to the top.
    //
    // Fix: block transient shrinks during buffer reflow but allow
    // legitimate shrinks after data stabilizes.  When a shrink is blocked,
    // a 150 ms decay timer starts.  If the height recovers before the
    // timer fires it was a transient reflow and the block was correct.
    // If the timer fires without recovery the floor is lowered to the
    // pending height — eliminating stale blank space below the prompt.
    const viewportEl = container.querySelector('.xterm-viewport') as HTMLElement | null;
    if (viewportEl) {
      const scrollAreaEl = viewportEl.querySelector('.xterm-scroll-area') as HTMLElement | null;
      if (scrollAreaEl) {
        let _heightFloor = 0;
        let _userScrolledUp = false;
        let _floorDecayTimer: ReturnType<typeof setTimeout> | null = null;
        let _pendingHeight = 0;

        viewportEl.addEventListener('wheel', (e) => {
          if (e.deltaY < 0) _userScrolledUp = true;
        }, { passive: true, capture: true });

        viewportEl.addEventListener('scroll', () => {
          const maxScroll = viewportEl.scrollHeight - viewportEl.clientHeight;
          if (maxScroll <= 0 || viewportEl.scrollTop >= maxScroll - 1) {
            _userScrolledUp = false;
          }
        }, { passive: true });

        // Intercept style.height on the scroll area element.
        const styleProto = Object.getPrototypeOf(scrollAreaEl.style);
        const heightDesc = Object.getOwnPropertyDescriptor(styleProto, 'height')
          || Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype, 'height');
        if (heightDesc?.set && heightDesc?.get) {
          const origGet = heightDesc.get;
          const origSet = heightDesc.set;
          Object.defineProperty(scrollAreaEl.style, 'height', {
            get() { return origGet.call(this); },
            set(v: string) {
              const num = parseFloat(v);
              if (!isNaN(num)) {
                if (num >= _heightFloor) {
                  // Height increasing or equal — update floor.
                  // Cancel any pending decay since height recovered.
                  _heightFloor = num;
                  _pendingHeight = 0;
                  if (_floorDecayTimer) {
                    clearTimeout(_floorDecayTimer);
                    _floorDecayTimer = null;
                  }
                } else if (!_userScrolledUp) {
                  // Height shrinking while viewport at bottom — block it
                  // to prevent browser scrollTop clamping during reflow.
                  // Schedule a decay: if height doesn't recover within
                  // 150 ms this is a legitimate shrink, not a transient
                  // reflow, so lower the floor.
                  _pendingHeight = num;
                  if (!_floorDecayTimer) {
                    _floorDecayTimer = setTimeout(() => {
                      _floorDecayTimer = null;
                      _heightFloor = _pendingHeight;
                      origSet.call(scrollAreaEl.style, _pendingHeight + 'px');
                    }, 150);
                  }
                  origSet.call(this, _heightFloor + 'px');
                  return;
                }
                // If user scrolled up, allow shrinking (don't interfere)
              }
              origSet.call(this, v);
            },
            configurable: true,
          });
        }

        // Expose floor reset so terminal-resize.ts can disable the floor
        // before fitAddon.fit(), allowing legitimate resize height changes
        // to pass through the interceptor.
        mt._resetScrollFloor = () => {
          _heightFloor = 0;
          _pendingHeight = 0;
          if (_floorDecayTimer) {
            clearTimeout(_floorDecayTimer);
            _floorDecayTimer = null;
          }
        };

        // Reset height floor on terminal resize (legitimate height change).
        terminal.onResize(() => {
          _heightFloor = 0;
          _pendingHeight = 0;
          if (_floorDecayTimer) {
            clearTimeout(_floorDecayTimer);
            _floorDecayTimer = null;
          }
        });
      }
    }

    // 快捷键 + paste 事件处理
    setupKeyHandler(mt, terminal);
    setupPasteListener(terminal);

    // macOS WKWebView IME 修复：Shift+符号键需按两次的问题
    if (!isWindowsPlatform) {
      applyWKWebViewIMEFix(terminal);
    }

    // Inline ghost text completion
    if (this.settings?.cmdCompletionEnabled && globalCompletionIndex.ready) {
      const ic = new InlineCompletion(sessionId, terminal, container, globalCompletionIndex);
      ic.attach();
      (mt as any)._inlineCompletion = ic;
    }

    // Click-to-move-cursor: 点击提示符区域移动光标
    setupClickToMoveCursor(mt);

    // WKWebView IME 去重状态（配合 applyWKWebViewIMEFix 的 input 事件补偿）
    let _dedupData = '';
    let _dedupTime = 0;

    terminal.onData((data) => {
      // Filter out terminal auto-responses that xterm.js generates in reply to
      // queries from shell/programs.  If sent back to PTY they appear as garbage
      // text on the prompt when the shell is idle.
      if (isTerminalAutoResponse(data)) return;
      // WKWebView IME 去重：10ms 内的相同数据只发送一次
      const now = performance.now();
      if (data === _dedupData && now - _dedupTime < 10) return;
      _dedupData = data;
      _dedupTime = now;
      mt._hasUserInput = true;
      mt.shellState.lastUserInputAt = Date.now();
      if (mt.shellState.phase === 'agent_executing') {
        mt.shellState.lastInputSource = 'user';
      }
      // When user presses Enter at a ready prompt, assume a command is being
      // submitted → switch to 'user_active' so click-to-move won't fire while
      // a foreground process is running (no preexec hook to detect this).
      // The next precmd (OSC 7768) will reset phase back to 'ready'.
      if (data === '\r' && mt.shellState.phase === 'ready') {
        mt.shellState.phase = 'user_active';
      }
      sendToTerminal(mt, encodeMessage(MsgInput, new TextEncoder().encode(data)));
      // For SSH sessions: if last pong is stale, send an immediate ping to detect dead connections
      this.maybePingOnInput(mt.id);
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

    // OSC 10/11: foreground/background color queries from TUI apps
    this._registerOscColorHandlers(mt, terminal);

    const observer = new ResizeObserver(() => {
      this.debouncedFitAndSignal(mt);
    });
    observer.observe(container);
    mt.observer = observer;

    // Register file link provider for clickable paths in terminal output
    registerFileLinkProvider(terminal, {
      getCwd: () => mt.shellState.cwd,
      isSSH: () => !!DrawerManager.getServerInfo(sessionId),
      onSSHNavigate: (dirPath) => DrawerManager.navigateToPath(sessionId, dirPath),
      getRemoteDirEntries: () => DrawerManager.getRemoteDirEntries(sessionId) || getSSHDirProbe(sessionId),
    });

    this.terminals.set(sessionId, mt);
    // port=-1 means skip auto-connect (used by createRemote)
    if (port >= 0) {
      this.connect(mt);
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
    this.connect(mt);
    return mt;
  }

  private oscCallbacks: OscHandlerCallbacks = {
    onShellIdle: (sid) => {
      const listeners = this.shellStateListeners.get(sid);
      if (listeners) listeners.forEach(cb => cb());
    },
    onShellTypeDetected: setShellType,
  };

  private wsCallbacks = {
    scheduleSettleResize: (mt: ManagedTerminal) => this.scheduleSettleResize(mt),
    getSettings: () => this.settings,
    sendEncoding: (mt: ManagedTerminal, encoding: string) => this.sendEncoding(mt, encoding),
    getOutputListeners: (sessionId: string) => this.outputListeners.get(sessionId),
    updateShellTitle: (mt: ManagedTerminal) => this.updateShellTitle(mt),
    setPongTime: (sessionId: string, time: number) => this.lastPongTime.set(sessionId, time),
    getPingTimestamp: (sessionId: string) => this.pingTimestamps.get(sessionId),
    deletePingTimestamp: (sessionId: string) => this.pingTimestamps.delete(sessionId),
    onReconnectNeeded: (mt: ManagedTerminal) => this.scheduleReconnect(mt),
    onOscEvent: (mt: ManagedTerminal, payload: Uint8Array) => {
      handleOscEvents(mt, payload, this.oscCallbacks);
    },
  };

  private connect(mt: ManagedTerminal): void {
    connectTerminal(mt, this.wsCallbacks);
  }

  private scheduleReconnect(mt: ManagedTerminal): void {
    _scheduleReconnect(mt, (m) => this.connect(m));
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
    // Windows WebView2: 清理隐藏 textarea 残留内容，防止后续按键被吞
    if (mt.terminal.textarea) {
      mt.terminal.textarea.value = '';
    }
    mt.terminal.focus();
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

  /** Reset lastSentCols/Rows to 0 so the next resize always sends SIGWINCH. */
  resetLastSentDimensions(): void {
    this.terminals.forEach((mt) => {
      mt.lastSentCols = 0;
      mt.lastSentRows = 0;
    });
  }

  /** Cancel all pending debounce and settle timers to prevent interference. */
  cancelPendingResizeTimers(): void {
    this.terminals.forEach((mt) => {
      if (mt.resizeDebounce !== null) {
        clearTimeout(mt.resizeDebounce);
        mt.resizeDebounce = null;
      }
      mt.settleTimers.forEach((t) => clearTimeout(t));
      mt.settleTimers = [];
    });
  }

  /**
   * Force xterm.js + TUI apps to fully redraw after PiP exit.
   *
   * POSIX ioctl(TIOCSWINSZ) only generates SIGWINCH when the PTY
   * size actually changes. During PiP the PTY dimensions are frozen,
   * so on exit the cols/rows are identical to what the PTY already has.
   * Sending the same size produces no SIGWINCH and the TUI never redraws.
   *
   * Fix: send cols-1 to the backend first (real PTY size change → SIGWINCH),
   * wait for the signal to be delivered and handled, then restore the
   * correct cols (another change → another SIGWINCH → TUI full redraw).
   *
   * The delay between steps is critical: POSIX signals are not queued —
   * if a second SIGWINCH arrives before the first is handled, it is
   * silently dropped by the kernel.
   */
  async forceFullRefresh(): Promise<void> {
    const targets: { mt: ManagedTerminal; cols: number; rows: number }[] = [];

    this.terminals.forEach((mt) => {
      if (!mt.container.classList.contains('active') || mt.ended) return;
      const cols = mt.terminal.cols;
      const rows = mt.terminal.rows;
      if (cols <= 1 || rows <= 0) return;
      targets.push({ mt, cols, rows });
    });

    if (targets.length === 0) return;

    // Step 1: shrink cols by 1 in both xterm.js AND the backend PTY.
    for (const { mt, cols, rows } of targets) {
      mt.terminal.resize(cols - 1, rows);
      sendResize(mt, cols - 1, rows);
    }

    // Wait for SIGWINCH delivery + TUI signal handler to run
    await new Promise(resolve => setTimeout(resolve, 100));

    // Step 2: restore correct dimensions via fitAddon + backend.
    for (const { mt } of targets) {
      mt.fitAddon.fit();
      const newCols = mt.terminal.cols;
      const newRows = mt.terminal.rows;
      sendResize(mt, newCols, newRows);
      mt.terminal.refresh(0, newRows - 1);
    }
  }

  /**
   * Restore xterm.js rendering state after system wake / screen unlock.
   *
   * During screen-off the GPU context may be reclaimed and xterm.js
   * IntersectionObserver marks the terminal as invisible, pausing rendering.
   *
   * @param skipSigwinch  If true, only fix IntersectionObserver + repaint.
   *   Caller is responsible for SIGWINCH (e.g. reconnectAll does its own).
   */
  async refreshAfterWake(skipSigwinch = false): Promise<void> {
    // Restore xterm.js IntersectionObserver state + repaint buffer
    for (const mt of this.terminals.values()) {
      if (mt.ended) continue;
      const termAny = mt.terminal as any;
      const core = termAny._core;
      core?._renderService?.onIntersectionChange?.(true);
      core?.viewport?.onIntersectionChange?.(true);
      mt.terminal.refresh(0, mt.terminal.rows - 1);
    }

    if (!skipSigwinch) {
      await this.forceFullRefresh();
    }
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
        // Windows WebView2: 清理隐藏 textarea 残留内容，防止后续按键被吞
        if (mt.terminal.textarea) mt.terminal.textarea.value = '';
        mt.terminal.focus();
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
    if (!mt) return;
    const payload = new TextEncoder().encode('\x15' + command + '\n');
    sendToTerminal(mt, encodeMessage(MsgInput, payload));
  }

  /**
   * Send a command to the terminal for AI agent execution.
   * Uses Ctrl+U to clear current line before injecting the command.
   * For PowerShell, Ctrl+U is not recognized (echoes as ^U and breaks parsing),
   * so we skip the clear-line prefix — the prompt should be clean when the agent
   * is controlling execution.
   * Automatically transitions shellState to agent_executing.
   */
  sendAgentCommand(sessionId: string, command: string, shellType?: string): void {
    const mt = this.terminals.get(sessionId);
    if (!mt) return;
    mt.shellState.phase = 'agent_executing';
    mt.shellState.lastInputSource = 'agent';
    mt.shellState.agentCommandSeq++;
    // PowerShell does not support Ctrl+U (unix-line-discard); skip prefix to avoid ^U echo.
    const prefix = shellType === 'powershell' ? '' : '\x15';
    // Terminator: use CR (\r) to emulate a real Enter keypress, which
    // matches what xterm.js sends when the user hits Return. A cooked-
    // mode shell (bash/zsh/fish/PowerShell prompt) converts CR→LF via
    // its line discipline, so commands still execute. Programs in raw
    // mode (sudo's read -s, ssh password, ncurses apps) require CR to
    // register Enter and would hang on a bare LF.
    const payload = new TextEncoder().encode(prefix + command + '\r');
    sendToTerminal(mt, encodeMessage(MsgInput, payload));
  }

  /**
   * Send raw input to the terminal (for responding to interactive prompts).
   * Unlike sendAgentCommand, this does NOT change shell state or add Ctrl+U prefix.
   */
  sendInput(sessionId: string, text: string): void {
    const mt = this.terminals.get(sessionId);
    if (!mt) return;
    const payload = new TextEncoder().encode(text);
    sendToTerminal(mt, encodeMessage(MsgInput, payload));
  }

  /**
   * Register a callback for when an OSC 7766 marker fires.
   * Returns an unsubscribe function.
   */
  onOscMarker(sessionId: string, markerId: string, callback: (exitCode: number) => void): () => void {
    const mt = this.terminals.get(sessionId);
    if (!mt) return () => {};
    mt._oscMarkerResolvers.set(markerId, callback);
    return () => { mt._oscMarkerResolvers.delete(markerId); };
  }

  /** Subscribe to raw PTY output text for a session (event-driven capture). */
  onOutput(sessionId: string, callback: (data: string) => void): () => void {
    if (!this.outputListeners.has(sessionId)) {
      this.outputListeners.set(sessionId, new Set());
    }
    this.outputListeners.get(sessionId)!.add(callback);
    return () => { this.outputListeners.get(sessionId)?.delete(callback); };
  }

  /**
   * Subscribe to shell idle events (OSC 7768 prompt hook fired).
   * Returns an unsubscribe function.
   */
  onShellIdle(sessionId: string, callback: () => void): () => void {
    if (!this.shellStateListeners.has(sessionId)) {
      this.shellStateListeners.set(sessionId, new Set());
    }
    this.shellStateListeners.get(sessionId)!.add(callback);
    return () => { this.shellStateListeners.get(sessionId)?.delete(callback); };
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
    // Detach inline completion
    const ic = (mt as any)._inlineCompletion as InlineCompletion | undefined;
    if (ic) ic.detach();
    this.inputListeners.delete(sessionId);
    this.outputListeners.delete(sessionId);
    this.shellStateListeners.delete(sessionId);
    // Close transport (IPC) and WebSocket
    if (mt.transport) mt.transport.close();
    if (mt.ws) mt.ws.close();
    // Dispose xterm instances
    if (mt.ligaturesAddon) mt.ligaturesAddon.dispose();
    if (mt.canvasAddon) mt.canvasAddon.dispose();
    if (mt.webglAddon) mt.webglAddon.dispose();
    mt._oscMarkerResolvers.clear();
    mt.thumbnailTerminal?.dispose();
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
    const rawWeight = this.settings?.fontWeight || 400;
    const fontFamily = this.settings
      ? getFontFamily(this.settings.fontFamily, this.settings.enableNerdFont, rawWeight, this.settings.cjkFontFamily)
      : 'Menlo, Monaco, "Courier New", monospace';
    const fontWeight = this.settings
      ? getEffectiveFontWeight(this.settings.fontFamily, rawWeight)
      : 400;
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

    // Unicode 11 wide character support — can load before open()
    try {
      const unicode11 = new Unicode11Addon();
      terminal.loadAddon(unicode11);
      terminal.unicode.activeVersion = '11';
    } catch { /* ignore */ }
    // DO NOT call terminal.open() here — container is detached from DOM.
    // WebGL/Ligatures/WebLinks/Image addons are loaded in openAndConnect() after open().

    const thumbnailTerminal = this._createThumbnailTerminal(thumbnailContainer, {
      fontSize, fontFamily, fontWeight, terminalTheme,
    });

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
      transport: null,
      clientId,
      ended: false,
      reconnectAttempt: 0,
      reconnectTimer: null,
      _port: 0,
      _token: '',
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
      _oscMarkerResolvers: new Map(),
      shellState: { phase: 'unknown', lastExitCode: 0, cwd: '', hookInjected: false, lastInputSource: 'none', lastUserInputAt: 0, agentCommandSeq: 0, lastCommand: '', promptRow: -1, promptCol: 0 },
    };

    // OSC handlers are processed by Rust OscFilter → MSG_OSC_EVENT → handleOscEvents.

    // 快捷键处理（register before open — works before open()）
    setupKeyHandler(mt, terminal);

    // WKWebView IME 去重状态
    let _dedupData = '';
    let _dedupTime = 0;

    terminal.onData((data) => {
      // Filter out terminal auto-responses — see isTerminalAutoResponse().
      if (isTerminalAutoResponse(data)) return;
      // WKWebView IME 去重：10ms 内的相同数据只发送一次
      const now = performance.now();
      if (data === _dedupData && now - _dedupTime < 10) return;
      _dedupData = data;
      _dedupTime = now;
      mt._hasUserInput = true;
      mt.shellState.lastUserInputAt = Date.now();
      if (mt.shellState.phase === 'agent_executing') {
        mt.shellState.lastInputSource = 'user';
      }
      if (data === '\r' && mt.shellState.phase === 'ready') {
        mt.shellState.phase = 'user_active';
      }
      sendToTerminal(mt, encodeMessage(MsgInput, new TextEncoder().encode(data)));
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

    // OSC 10/11: foreground/background color queries from TUI apps
    this._registerOscColorHandlers(mt, terminal);

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

    // paste 事件监听（textarea available after open）
    setupPasteListener(mt.terminal);

    // macOS WKWebView IME 修复（textarea available after open）
    if (!isWindowsPlatform) {
      applyWKWebViewIMEFix(mt.terminal);
    }

    // Apply opacity to explicit TUI backgrounds (iTerm2-like transparency)
    const opacityVal = this.settings ? Math.max(20, Math.min(100, this.settings.opacity)) / 100 : 1;
    patchCanvasBgOpacity(mt.container, opacityVal);

    // Load WebGL addon after open (needs rendering context from DOM)
    // Skip WebGL when transparency is active — canvas renderer handles alpha better
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
    // OSC 8 hyperlink support
    try { mt.terminal.loadAddon(new WebLinksAddon((_e, uri) => { void openUrl(uri); })); } catch { /* ignore */ }
    // Sixel / iTerm2 inline image support
    try { mt.terminal.loadAddon(new ImageAddon()); } catch { /* ignore */ }

    // Fit terminal to container dimensions and focus
    mt.fitAddon.fit();
    mt.terminal.focus();

    // Update port/token and start WebSocket connection
    mt._port = port;
    mt._token = token;
    this.connect(mt);

    // Clear transfer grace period after connection settles.
    // During this window, MsgRoleChange events are suppressed to prevent
    // false "remote control" overlays caused by the old connection still
    // being active when the new one connects.
    if (mt._transferGrace) {
      setTimeout(() => { mt._transferGrace = false; }, 3000);
    }
  }

  /**
   * Force reconnect all local (non-remote) sessions.
   * Called after system wake from sleep/hibernate or after sidecar restart.
   * If port/token are provided, updates stored values first (sidecar restarted on new port).
   *
   * The server sends RIS (\x1bc) before the ring-buffer replay, which resets
   * all terminal modes including mouse tracking.  We snapshot mouse state
   * before reconnect and restore it after the replay finishes.
   */
  reconnectAll(port?: number, token?: string): void {
    // Snapshot mouse modes BEFORE reconnect (RIS will wipe them).
    const mouseSnapshots = new Map<string, { protocol: string; encoding: string }>();

    for (const mt of this.terminals.values()) {
      if (mt.isRemote || mt.ended) continue;

      // Save mouse mode state from xterm.js internals
      try {
        const cms = (mt.terminal as any)._core?.coreMouseService;
        if (cms) {
          mouseSnapshots.set(mt.id, {
            protocol: cms.activeProtocol ?? 'NONE',
            encoding: cms.activeEncoding ?? 'DEFAULT',
          });
        }
      } catch { /* ignore */ }

      // Update port/token if sidecar restarted on a new port
      if (port !== undefined && port > 0) mt._port = port;
      if (token !== undefined && token !== '') mt._token = token;

      // Cancel any pending reconnect timer
      if (mt.reconnectTimer) {
        clearTimeout(mt.reconnectTimer);
        mt.reconnectTimer = null;
      }

      // Reset reconnect counter
      mt.reconnectAttempt = 0;

      // Close existing transport/WebSocket if still open/connecting
      if (mt.transport) {
        try { mt.transport.close(); } catch { /* ignore */ }
        mt.transport = null;
      }
      if (mt.ws) {
        try { mt.ws.close(); } catch { /* ignore */ }
        mt.ws = null;
      }

      // Suppress role-change events during the reconnect window to prevent
      // false "remote control" overlays when both old and new server-side
      // connections are briefly active for the same session.
      mt._transferGrace = true;
      setTimeout(() => { mt._transferGrace = false; }, 3000);

      // Reconnect
      this.connect(mt);
    }

    // After ring-buffer replay completes:
    //  1. Restore mouse modes (RIS wiped them).
    //  2. Trigger SIGWINCH so TUI apps fully redraw (ring buffer is partial).
    // 1.5s is generous enough for typical ring-buffer sizes over IPC.
    if (mouseSnapshots.size > 0) {
      setTimeout(() => {
        for (const [id, snap] of mouseSnapshots) {
          const mt = this.terminals.get(id);
          if (!mt || mt.ended) continue;
          const seq = buildMouseModeRestoreSeq(snap.protocol, snap.encoding);
          if (seq) mt.terminal.write(seq);
        }
        void this.forceFullRefresh();
      }, 1500);
    }
  }

  destroy(sessionId: string): void {
    const mt = this.terminals.get(sessionId);
    if (!mt) {
      return;
    }
    mt.ended = true;
    this.inputListeners.delete(sessionId);
    this.outputListeners.delete(sessionId);
    this.shellStateListeners.delete(sessionId);
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
    if (mt.webglAddon) {
      mt.webglAddon.dispose();
    }
    if (mt.transport) {
      mt.transport.close();
    }
    if (mt.ws) {
      mt.ws.close();
    }
    mt._oscMarkerResolvers.clear();
    mt.thumbnailTerminal?.dispose();
    mt.terminal.dispose();
    mt.thumbnailContainer.remove();
    mt.container.remove();
    this.terminals.delete(sessionId);
    this.resizeGeneration.delete(sessionId);
    this.pingTimestamps.delete(sessionId);
    this.lastPongTime.delete(sessionId);
    this.lastInputPingTime.delete(sessionId);
    clearSSHDirProbe(sessionId);
  }
}

export const TerminalRegistry = new TerminalRegistryClass();

/**
 * Build an escape sequence string that re-enables the given mouse tracking
 * protocol and encoding.  Returns empty string if no mouse mode was active.
 *
 * Protocol names match xterm.js CoreMouseService._activeProtocol.
 * Encoding names match xterm.js CoreMouseService._activeEncoding.
 */
function buildMouseModeRestoreSeq(protocol: string, encoding: string): string {
  let seq = '';

  // Mouse tracking protocol
  switch (protocol) {
    case 'X10':   seq += '\x1b[?9h';    break; // X10 mouse reporting
    case 'VT200': seq += '\x1b[?1000h'; break; // Normal tracking mode
    case 'DRAG':  seq += '\x1b[?1002h'; break; // Button-event tracking
    case 'ANY':   seq += '\x1b[?1003h'; break; // Any-event tracking
    default:      return '';                    // NONE — nothing to restore
  }

  // Mouse encoding extension
  switch (encoding) {
    case 'SGR':        seq += '\x1b[?1006h'; break;
    case 'SGR_PIXELS': seq += '\x1b[?1016h'; break;
    // 'DEFAULT' uses X10-compatible encoding, no extra sequence needed
  }

  return seq;
}
