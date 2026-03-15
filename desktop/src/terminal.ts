import { Terminal } from '@xterm/xterm';
import { CanvasAddon } from '@xterm/addon-canvas';
import { FitAddon } from '@xterm/addon-fit';
import { LigaturesAddon } from '@xterm/addon-ligatures';
import { SerializeAddon } from '@xterm/addon-serialize';
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
import { loadFont, getFontFamily } from './fonts';
import { DrawerManager } from './drawer';
import { registerFileLinkProvider, getSSHDirProbe, clearSSHDirProbe } from './terminal-file-link';
import { isWindowsPlatform } from './app-state';
import type { SessionStatus, SessionInfo, ManagedTerminal } from './terminal-types';
export type { SessionStatus, SessionInfo, ManagedTerminal } from './terminal-types';
import { patchCanvasBgOpacity, patchOverlayScrollbar } from './terminal-patches';
import {
  applySettingsToTerminal,
  registerOscColorHandlers,
} from './terminal-settings';
import { scheduleResize as _scheduleResize, sendResize } from './terminal-resize';
import { initIMEState, setupKeyHandler, setupCompositionListeners } from './terminal-ime';
import { registerOscHandlers } from './terminal-osc';
import { setShellType } from './ai-tools';
import { connectWebSocket, scheduleReconnect as _scheduleReconnect } from './terminal-websocket';
import { InlineCompletion } from './cmd-completion';
import { globalCompletionIndex } from './cmd-completion-data';

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
      this._applySettingsToTerminal(mt);
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

  private _applySettingsToTerminal(mt: ManagedTerminal): void {
    if (!this.settings) return;
    applySettingsToTerminal(mt, this.settings);
  }

  private _registerOscColorHandlers(mt: ManagedTerminal, terminal: Terminal): void {
    registerOscColorHandlers(mt, terminal, () => this.settings);
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

  private scheduleResize(mt: ManagedTerminal): void {
    _scheduleResize(mt, this.resizeGeneration);
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
    // Apply opacity to explicit TUI backgrounds so they become semi-transparent
    // (like iTerm2's window-level transparency). xterm.js Canvas addon draws
    // explicit backgrounds via fillRect; text is drawn via drawImage (unaffected).
    patchCanvasBgOpacity(container, opacityVal);
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
      shellState: { phase: 'unknown', lastExitCode: 0, cwd: '', hookInjected: false, lastInputSource: 'none', lastUserInputAt: 0, agentCommandSeq: 0, lastCommand: '' },
    };

    // Register all OSC handlers (7766, 7, 7768, 9, 777)
    registerOscHandlers(mt, terminal, {
      onShellIdle: (sid) => {
        const listeners = this.shellStateListeners.get(sid);
        if (listeners) listeners.forEach(cb => cb());
      },
      onShellTypeDetected: setShellType,
    });

    // IME 修复 + 快捷键处理
    initIMEState(mt);
    setupKeyHandler(mt, terminal);
    setupCompositionListeners(mt, terminal);

    // Inline ghost text completion
    if (this.settings?.cmdCompletionEnabled && globalCompletionIndex.ready) {
      const ic = new InlineCompletion(sessionId, terminal, container, globalCompletionIndex);
      ic.attach();
      (mt as any)._inlineCompletion = ic;
    }

    terminal.onData((data) => {
      mt._hasUserInput = true;
      mt.shellState.lastUserInputAt = Date.now();
      if (mt.shellState.phase === 'agent_executing') {
        mt.shellState.lastInputSource = 'user';
      }
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
  };

  private connect(mt: ManagedTerminal): void {
    connectWebSocket(mt, this.wsCallbacks);
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

  /**
   * Force xterm.js + TUI apps to fully redraw after PiP exit.
   *
   * Both xterm.js terminal.resize() and fitAddon.fit() are no-ops
   * when cols/rows haven't changed. The CSS transform during PiP
   * may leave the canvas/WebGL renderer stale. We force a real
   * resize cycle by temporarily changing dimensions, then restoring.
   */
  forceFullRefresh(): void {
    this.terminals.forEach((mt) => {
      if (!mt.container.classList.contains('active') || mt.ended) return;

      const cols = mt.terminal.cols;
      const rows = mt.terminal.rows;
      if (cols <= 1 || rows <= 0) return;

      // Force xterm.js to resize by temporarily changing cols,
      // then fitting back to correct dimensions.
      mt.terminal.resize(cols - 1, rows);
      mt.fitAddon.fit();

      // Send resize to backend to trigger SIGWINCH
      const newCols = mt.terminal.cols;
      const newRows = mt.terminal.rows;
      sendResize(mt, newCols, newRows);

      // Full visual repaint
      mt.terminal.refresh(0, newRows - 1);
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
    if (!mt?.ws || mt.ws.readyState !== WebSocket.OPEN) return;
    const payload = new TextEncoder().encode('\x15' + command + '\n');
    mt.ws.send(encodeMessage(MsgInput, payload));
  }

  /**
   * Send a command to the terminal for AI agent execution.
   * Uses Ctrl+U to clear current line before injecting the command.
   * Automatically transitions shellState to agent_executing.
   */
  sendAgentCommand(sessionId: string, command: string): void {
    const mt = this.terminals.get(sessionId);
    if (!mt?.ws || mt.ws.readyState !== WebSocket.OPEN) return;
    mt.shellState.phase = 'agent_executing';
    mt.shellState.lastInputSource = 'agent';
    mt.shellState.agentCommandSeq++;
    const payload = new TextEncoder().encode('\x15' + command + '\n');
    mt.ws.send(encodeMessage(MsgInput, payload));
  }

  /**
   * Send raw input to the terminal (for responding to interactive prompts).
   * Unlike sendAgentCommand, this does NOT change shell state or add Ctrl+U prefix.
   */
  sendInput(sessionId: string, text: string): void {
    const mt = this.terminals.get(sessionId);
    if (!mt?.ws || mt.ws.readyState !== WebSocket.OPEN) return;
    const payload = new TextEncoder().encode(text);
    mt.ws.send(encodeMessage(MsgInput, payload));
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
      shellState: { phase: 'unknown', lastExitCode: 0, cwd: '', hookInjected: false, lastInputSource: 'none', lastUserInputAt: 0, agentCommandSeq: 0, lastCommand: '' },
    };

    // Register all OSC handlers (7766, 7768, 9, 777) — skip OSC 7 and prefetch for transfer
    registerOscHandlers(mt, terminal, {
      onShellIdle: (sid) => {
        const listeners = this.shellStateListeners.get(sid);
        if (listeners) listeners.forEach(cb => cb());
      },
      onShellTypeDetected: setShellType,
    }, { includeOsc7: false, includePrefetch: false });

    // IME 修复 + 快捷键处理（register before open — these work before open()）
    initIMEState(mt);
    setupKeyHandler(mt, terminal);

    terminal.onData((data) => {
      mt._hasUserInput = true;
      mt.shellState.lastUserInputAt = Date.now();
      if (mt.shellState.phase === 'agent_executing') {
        mt.shellState.lastInputSource = 'user';
      }
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

    // IME composition event listeners（textarea available after open）
    setupCompositionListeners(mt, mt.terminal);

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
   */
  reconnectAll(port?: number, token?: string): void {
    for (const mt of this.terminals.values()) {
      if (mt.isRemote || mt.ended) continue;

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

      // Close existing WebSocket if still open/connecting
      if (mt.ws) {
        try { mt.ws.close(); } catch { /* ignore */ }
        mt.ws = null;
      }

      // Reconnect
      this.connect(mt);
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
    clearSSHDirProbe(sessionId);
  }
}

export const TerminalRegistry = new TerminalRegistryClass();
