import type { SessionStatus } from './terminal';
import { t } from './i18n';

// ─── Data Structures ─────────────────────────────────────────────

export interface TransferInfo {
  direction: 'upload' | 'download' | 'mixed';
  fileCount: number;
  progress: number; // 0-100
}

interface CapsuleState {
  connectionStatus: SessionStatus | 'error';
  connectionLabel: string;
  latencyMs: number | null;
  sessionCount: number;
  viewerCount: number;
  transfer: TransferInfo | null;
  aiActive: boolean;
  /** Pane number of the currently-focused pane, or null when the
   *  active tab has only one pane (hidden in that case). */
  paneNumber: number | null;
  /** Total pane count of the active tab (for the "N/M" suffix). */
  paneTotal: number;
}

// ─── Helpers ─────────────────────────────────────────────────────

const HTML_ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => HTML_ESCAPE_MAP[ch] ?? ch);
}

// ─── SVG Icons (12×12 inline, stroke style) ─────────────────────

const SVG_ATTR = 'width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"';

const svgIcons = {
  /** ⚡ latency / bolt */
  bolt: `<svg ${SVG_ATTR}><path d="M9 1.5L4 9h4l-1 5.5L12 7H8z"/></svg>`,
  /** ⩉ sessions / windows grid */
  sessions: `<svg ${SVG_ATTR}><rect x="1.5" y="1.5" width="5.5" height="5.5" rx="1"/><rect x="9" y="1.5" width="5.5" height="5.5" rx="1"/><rect x="1.5" y="9" width="5.5" height="5.5" rx="1"/><rect x="9" y="9" width="5.5" height="5.5" rx="1"/></svg>`,
  /** ↑ upload arrow */
  upload: `<svg ${SVG_ATTR}><path d="M8 13V3"/><path d="M3.5 7.5L8 3l4.5 4.5"/></svg>`,
  /** ↓ download arrow */
  download: `<svg ${SVG_ATTR}><path d="M8 3v10"/><path d="M3.5 8.5L8 13l4.5-4.5"/></svg>`,
  /** ↕ bidirectional transfer */
  transfer: `<svg ${SVG_ATTR}><path d="M5 13V3"/><path d="M2.5 5.5L5 3l2.5 2.5"/><path d="M11 3v10"/><path d="M8.5 10.5L11 13l2.5-2.5"/></svg>`,
  /** AI sparkle */
  ai: `<svg ${SVG_ATTR}><path d="M8 1v3M8 12v3M1 8h3M12 8h3"/><path d="M3.5 3.5l2 2M10.5 10.5l2 2M10.5 3.5l-2 2M3.5 10.5l2-2"/><circle cx="8" cy="8" r="2" fill="currentColor" stroke="none"/></svg>`,
  /** 📱 viewers / connected devices */
  viewers: `<svg ${SVG_ATTR}><rect x="4.5" y="1.5" width="7" height="13" rx="1.2"/><path d="M7 12h2"/></svg>`,
  /** 👁 eye / watching indicator */
  eye: `<svg ${SVG_ATTR}><path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z"/><circle cx="8" cy="8" r="2.2" fill="currentColor" stroke="none"/></svg>`,
  /** 🔒 lock / private session */
  lock: `<svg ${SVG_ATTR}><rect x="3" y="7" width="10" height="7" rx="1.5" fill="none"/><path d="M5 7V5a3 3 0 0 1 6 0v2" fill="none"/><circle cx="8" cy="10.5" r="1" fill="currentColor" stroke="none"/></svg>`,
} as const;

// ─── StatusBar Class ─────────────────────────────────────────────

class StatusBarClass {
  private container: HTMLDivElement | null = null;
  private leftZone: HTMLDivElement | null = null;
  private rightZone: HTMLDivElement | null = null;

  // Capsule DOM elements (null means not yet created or removed)
  private connectionCapsule: HTMLDivElement | null = null;
  private lockCapsule: HTMLDivElement | null = null;
  private latencyCapsule: HTMLDivElement | null = null;
  private sessionsCapsule: HTMLDivElement | null = null;
  private viewersCapsule: HTMLDivElement | null = null;
  private transferCapsule: HTMLDivElement | null = null;
  private aiCapsule: HTMLDivElement | null = null;

  // Active transfer tracking
  private activeTransfers = new Map<string, { type: 'upload' | 'download'; progress: number; status: string }>();

  // OSC 9;4 progress layer
  private progressLayer: HTMLDivElement | null = null;
  private progressFill: HTMLDivElement | null = null;

  // Timers
  private transferHideTimer: ReturnType<typeof setTimeout> | null = null;
  private aiExitTimer: ReturnType<typeof setTimeout> | null = null;

  // Saved event listener references for cleanup
  private initialized = false;
  private transferListener: EventListener | null = null;
  private aiListener: EventListener | null = null;
  private pongListener: EventListener | null = null;
  private viewerPopup: HTMLDivElement | null = null;
  private viewerPopupCloseHandler: ((e: Event) => void) | null = null;

  private paneCapsule: HTMLDivElement | null = null;

  private state: CapsuleState = {
    connectionStatus: 'disconnected',
    connectionLabel: 'Disconnected',
    latencyMs: null,
    sessionCount: 0,
    viewerCount: 0,
    transfer: null,
    aiActive: false,
    paneNumber: null,
    paneTotal: 0,
  };

  // ── Initialization ──────────────────────────────────────────

  init(container: HTMLDivElement): void {
    // Guard against duplicate initialization — clean up first
    if (this.initialized) {
      this.destroy();
    }

    this.container = container;
    this.container.innerHTML = '';

    this.leftZone = document.createElement('div');
    this.leftZone.className = 'status-left';

    const spacer = document.createElement('div');
    spacer.className = 'status-spacer';

    this.rightZone = document.createElement('div');
    this.rightZone.className = 'status-right';

    this.container.appendChild(this.leftZone);
    this.container.appendChild(spacer);
    this.container.appendChild(this.rightZone);

    // Connection capsule is always visible
    this.renderConnectionCapsule();
    this.listenForTransfers();
    this.listenForAI();
    this.initialized = true;
    this.updateVisibility();
  }

  // ── Public API ──────────────────────────────────────────────

  setConnection(status: SessionStatus | 'error', label?: string): void {
    this.state.connectionStatus = status;
    this.state.connectionLabel = label ?? this.defaultLabel(status);
    this.renderConnectionCapsule();
    this.renderLatencyCapsule();
    this.updateVisibility();
  }

  setLatency(ms: number | null): void {
    this.state.latencyMs = ms;
    this.renderLatencyCapsule();
  }

  /**
   * Phase 2: show the currently-focused pane number for the active
   * tab. Pass (null, 0) to clear. The capsule is automatically
   * hidden when total ≤ 1 (single-pane tabs don't need it).
   */
  setPane(paneNumber: number | null, total: number): void {
    this.state.paneNumber = paneNumber;
    this.state.paneTotal = total;
    this.renderPaneCapsule();
  }

  setSessionCount(count: number): void {
    this.state.sessionCount = count;
    this.renderSessionsCapsule();
  }

  setViewers(count: number): void {
    this.state.viewerCount = count;
    this.renderViewersCapsule();
  }

  setTransfer(info: TransferInfo | null): void {
    // Clear any pending hide timer
    if (this.transferHideTimer !== null) {
      clearTimeout(this.transferHideTimer);
      this.transferHideTimer = null;
    }

    if (info === null || info.progress >= 100) {
      // Transfer complete or cleared — keep visible for 2 seconds, then fade out
      if (info !== null && info.progress >= 100) {
        this.state.transfer = info;
        this.renderTransferCapsule();
      }
      this.transferHideTimer = setTimeout(() => {
        this.transferHideTimer = null;
        this.state.transfer = null;
        this.removeCapsuleAnimated(this.transferCapsule, () => {
          this.transferCapsule = null;
        });
      }, info !== null && info.progress >= 100 ? 2000 : 0);
    } else {
      this.state.transfer = info;
      this.renderTransferCapsule();
    }
  }

  setLocked(locked: boolean): void {
    if (!this.leftZone) return;

    if (!locked) {
      if (this.lockCapsule) {
        this.removeCapsuleAnimated(this.lockCapsule, () => {
          this.lockCapsule = null;
        });
      }
      return;
    }

    if (!this.lockCapsule) {
      this.lockCapsule = document.createElement('div');
      this.lockCapsule.className = 'status-capsule capsule-lock';
      this.addCapsuleAnimated(this.lockCapsule);
      // Insert after connection capsule
      const afterConnection = this.connectionCapsule?.nextSibling ?? null;
      this.leftZone.insertBefore(this.lockCapsule, afterConnection);
    }

    this.lockCapsule.innerHTML =
      `<span>${svgIcons.lock} ${t('sessionPrivate')}</span>`;
  }

  setAIActive(active: boolean): void {
    // Clear any pending exit timer
    if (this.aiExitTimer !== null) {
      clearTimeout(this.aiExitTimer);
      this.aiExitTimer = null;
    }

    if (active) {
      this.state.aiActive = true;
      this.renderAICapsule();
    } else {
      // Delayed exit — wait 300ms before removing
      this.aiExitTimer = setTimeout(() => {
        this.aiExitTimer = null;
        this.state.aiActive = false;
        this.removeCapsuleAnimated(this.aiCapsule, () => {
          this.aiCapsule = null;
        });
      }, 300);
    }
  }

  setProgress(progress: { state: number; percent: number } | null): void {
    if (!this.container) return;

    if (!progress || progress.state === 0) {
      if (this.progressLayer) {
        this.progressLayer.remove();
        this.progressLayer = null;
        this.progressFill = null;
      }
      return;
    }

    if (!this.progressLayer) {
      this.progressLayer = document.createElement('div');
      this.progressLayer.className = 'osc-progress-layer';
      this.progressFill = document.createElement('div');
      this.progressFill.className = 'osc-progress-fill';
      this.progressLayer.appendChild(this.progressFill);
      this.container.insertBefore(this.progressLayer, this.container.firstChild);
    }

    const fill = this.progressFill!;
    fill.classList.remove('normal', 'error', 'indeterminate');
    if (progress.state === 1) {
      fill.classList.add('normal');
      fill.style.width = `${progress.percent}%`;
    } else if (progress.state === 2) {
      fill.classList.add('error');
      fill.style.width = `${progress.percent}%`;
    } else if (progress.state === 3) {
      fill.classList.add('indeterminate');
      fill.style.width = '100%';
    }
  }

  setError(message: string): void {
    this.setConnection('error', message);
  }

  // ── Tooltip ─────────────────────────────────────────────────

  getConnectionTooltip(): string {
    const parts: string[] = [];
    parts.push(`Status: ${this.state.connectionLabel}`);
    if (this.state.latencyMs !== null) {
      parts.push(`Latency: ${this.state.latencyMs}ms`);
    }
    if (this.state.sessionCount > 1) {
      parts.push(`Sessions: ${this.state.sessionCount}`);
    }
    return parts.join('\n');
  }

  // ── Rendering ───────────────────────────────────────────────

  private renderConnectionCapsule(): void {
    if (!this.leftZone) return;

    if (!this.connectionCapsule) {
      this.connectionCapsule = document.createElement('div');
      this.connectionCapsule.className = 'status-capsule capsule-connection';
      this.connectionCapsule.addEventListener('click', () => {
        document.dispatchEvent(new CustomEvent('status-bar-reconnect'));
      });
      this.leftZone.insertBefore(
        this.connectionCapsule,
        this.leftZone.firstChild
      );
    }

    const status = this.state.connectionStatus;
    // Map 'notfound' to 'disconnected' for CSS class since they share the same styling
    const dotClass = status === 'notfound' ? 'disconnected' : status;
    const label = escapeHtml(this.state.connectionLabel);
    this.connectionCapsule.innerHTML =
      `<span class="status-dot ${dotClass}"></span>` +
      `<span>${label}</span>`;
    this.connectionCapsule.title = this.getConnectionTooltip();
  }

  private renderPaneCapsule(): void {
    if (!this.leftZone) return;
    const { paneNumber, paneTotal } = this.state;
    // Hide when there's no multi-pane situation to describe.
    if (!paneNumber || paneTotal < 2) {
      if (this.paneCapsule) {
        this.removeCapsuleAnimated(this.paneCapsule, () => {
          this.paneCapsule = null;
        });
      }
      return;
    }
    if (!this.paneCapsule) {
      this.paneCapsule = document.createElement('div');
      this.paneCapsule.className = 'status-capsule capsule-pane';
      this.addCapsuleAnimated(this.paneCapsule);
      // Insert after connection + lock capsules, before latency.
      const anchor = (this.lockCapsule ?? this.connectionCapsule)?.nextSibling ?? null;
      this.leftZone.insertBefore(this.paneCapsule, anchor);
    }
    // Use circled numbers ①..⑳ when possible, else Pane N.
    const glyph = paneNumber >= 1 && paneNumber <= 20
      ? String.fromCodePoint(0x245F + paneNumber)
      : String(paneNumber);
    this.paneCapsule.innerHTML = `<span class="pane-glyph">${glyph}</span><span>Pane · ${paneTotal}</span>`;
    this.paneCapsule.title = `Pane ${paneNumber} of ${paneTotal}`;
  }

  private renderLatencyCapsule(): void {
    if (!this.leftZone) return;

    const isConnected =
      this.state.connectionStatus === 'connected';

    if (!isConnected || this.state.latencyMs === null) {
      if (this.latencyCapsule) {
        this.removeCapsuleAnimated(this.latencyCapsule, () => {
          this.latencyCapsule = null;
        });
      }
      return;
    }

    const ms = this.state.latencyMs;
    const qualityClass = ms <= 30 ? 'good' : ms <= 100 ? 'medium' : 'bad';

    if (!this.latencyCapsule) {
      this.latencyCapsule = document.createElement('div');
      this.latencyCapsule.className = 'status-capsule capsule-latency';
      this.addCapsuleAnimated(this.latencyCapsule);

      // Insert after connection capsule
      const afterConnection = this.connectionCapsule?.nextSibling ?? null;
      this.leftZone.insertBefore(this.latencyCapsule, afterConnection);
    }

    this.latencyCapsule.innerHTML =
      `<span class="latency-value ${qualityClass}">${svgIcons.bolt} ${ms}ms</span>`;
  }

  private renderSessionsCapsule(): void {
    if (!this.leftZone) return;

    if (this.state.sessionCount <= 1) {
      if (this.sessionsCapsule) {
        this.removeCapsuleAnimated(this.sessionsCapsule, () => {
          this.sessionsCapsule = null;
        });
      }
      return;
    }

    if (!this.sessionsCapsule) {
      this.sessionsCapsule = document.createElement('div');
      this.sessionsCapsule.className = 'status-capsule capsule-sessions';
      this.addCapsuleAnimated(this.sessionsCapsule);
      this.leftZone.appendChild(this.sessionsCapsule);
    }

    this.sessionsCapsule.innerHTML =
      `<span>${svgIcons.sessions} ${this.state.sessionCount}</span>`;
  }

  private renderViewersCapsule(): void {
    if (!this.rightZone) return;

    if (this.state.viewerCount <= 0) {
      if (this.viewersCapsule) {
        this.removeCapsuleAnimated(this.viewersCapsule, () => {
          this.viewersCapsule = null;
        });
      }
      return;
    }

    if (!this.viewersCapsule) {
      this.viewersCapsule = document.createElement('div');
      this.viewersCapsule.className = 'status-capsule capsule-viewers';
      this.addCapsuleAnimated(this.viewersCapsule);
      // Insert at the beginning of right zone (before transfer/AI capsules)
      this.rightZone.insertBefore(this.viewersCapsule, this.rightZone.firstChild);
    }

    this.viewersCapsule.innerHTML =
      `<span class="viewer-eye-icon">${svgIcons.eye}</span>` +
      `<span>${this.state.viewerCount}</span>`;
    this.viewersCapsule.title = `${this.state.viewerCount} device${this.state.viewerCount !== 1 ? 's' : ''} watching`;

    // Click to dispatch event for viewer popup
    this.viewersCapsule.style.cursor = 'pointer';
    this.viewersCapsule.onclick = (e) => {
      e.stopPropagation();
      document.dispatchEvent(new CustomEvent('status-bar-viewers-clicked', {
        detail: { capsuleEl: this.viewersCapsule },
      }));
    };
  }

  private renderTransferCapsule(): void {
    if (!this.rightZone || !this.state.transfer) return;

    const t = this.state.transfer;
    const arrow =
      t.direction === 'upload' ? svgIcons.upload :
      t.direction === 'download' ? svgIcons.download : svgIcons.transfer;
    if (!this.transferCapsule) {
      this.transferCapsule = document.createElement('div');
      this.transferCapsule.className = 'status-capsule capsule-transfer';
      this.addCapsuleAnimated(this.transferCapsule);
      this.rightZone.insertBefore(
        this.transferCapsule,
        this.rightZone.firstChild
      );
    }

    const pct = Math.round(t.progress);

    // In-place update: 保持 DOM 元素不重建，CSS transition 处理动画
    const existingFill = this.transferCapsule.querySelector('.transfer-progress-fill') as HTMLElement | null;
    const existingText = this.transferCapsule.querySelector('span') as HTMLElement | null;
    if (existingFill && existingText) {
      existingText.innerHTML = `${arrow} ${t.fileCount} file${t.fileCount !== 1 ? 's' : ''} ${pct}%`;
      existingFill.style.width = `${t.progress}%`;
    } else {
      this.transferCapsule.innerHTML =
        `<span>${arrow} ${t.fileCount} file${t.fileCount !== 1 ? 's' : ''} ${pct}%</span>` +
        `<div class="transfer-progress-bar"><div class="transfer-progress-fill" style="width:${t.progress}%"></div></div>`;
    }
    this.updateVisibility();
  }

  private renderAICapsule(): void {
    if (!this.rightZone) return;

    if (!this.state.aiActive) return;

    if (!this.aiCapsule) {
      this.aiCapsule = document.createElement('div');
      this.aiCapsule.className = 'status-capsule capsule-ai';
      this.addCapsuleAnimated(this.aiCapsule);
      this.rightZone.appendChild(this.aiCapsule);
    }

    this.aiCapsule.innerHTML =
      `<span class="ai-dot"></span>${svgIcons.ai}<span>AI</span>`;
    this.updateVisibility();
  }

  // ── Capsule Lifecycle Animations ────────────────────────────

  private addCapsuleAnimated(el: HTMLDivElement): void {
    el.classList.add('capsule-entering');
    const onEnd = () => {
      el.classList.remove('capsule-entering');
      el.removeEventListener('animationend', onEnd);
    };
    el.addEventListener('animationend', onEnd);
  }

  private removeCapsuleAnimated(
    el: HTMLDivElement | null,
    cleanup: () => void
  ): void {
    if (!el) {
      cleanup();
      return;
    }
    el.classList.add('capsule-exiting');
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      el.removeEventListener('animationend', onEnd);
      el.remove();
      cleanup();
      this.updateVisibility();
    };
    const onEnd = () => finish();
    el.addEventListener('animationend', onEnd);
    // Safety net: clean up if animationend never fires (e.g. element not in DOM)
    setTimeout(finish, 300);
  }

  /**
   * Auto-hide the status bar when idle, show it only when something notable is
   * happening: connecting / reconnecting / error, a file transfer, or AI running.
   * (A steady connected/idle session shows nothing → the bar collapses to 0.)
   */
  private updateVisibility(): void {
    if (!this.container) return;
    const s = this.state;
    const show =
      s.connectionStatus === 'connecting' ||
      s.connectionStatus === 'reconnecting' ||
      s.connectionStatus === 'error' ||
      s.transfer != null ||
      s.aiActive ||
      this.activeTransfers.size > 0;
    this.container.classList.toggle('status-collapsed', !show);
    // Also collapse the #app grid row so the reserved 24px space is reclaimed.
    document.getElementById('app')?.classList.toggle('app-status-collapsed', !show);
  }

  // ── Latency Monitor ────────────────────────────────────────

  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private latencyHistory: number[] = [];
  private getActiveSessionId: (() => string | null) | null = null;
  private sendPingFn: ((sessionId: string) => void) | null = null;

  startLatencyMonitor(
    getActiveSessionId: () => string | null,
    sendPing: (sessionId: string) => void,
  ): void {
    this.getActiveSessionId = getActiveSessionId;
    this.sendPingFn = sendPing;

    // Remove previous pong listener if any
    if (this.pongListener) {
      document.removeEventListener('status-bar-pong', this.pongListener);
    }

    this.pongListener = ((e: CustomEvent<{ sessionId: string; rtt: number }>) => {
      this.latencyHistory.push(e.detail.rtt);
      if (this.latencyHistory.length > 5) this.latencyHistory.shift();
      const avg = Math.round(this.latencyHistory.reduce((a, b) => a + b, 0) / this.latencyHistory.length);
      this.setLatency(avg);
    }) as EventListener;
    document.addEventListener('status-bar-pong', this.pongListener);

    this.pingTimer = setInterval(() => {
      this.doPing();
    }, 5000);

    // First ping after short delay
    setTimeout(() => this.doPing(), 500);
  }

  private doPing(): void {
    if (!this.getActiveSessionId || !this.sendPingFn) return;
    const sessionId = this.getActiveSessionId();
    if (sessionId) {
      this.sendPingFn(sessionId);
    }
  }

  stopLatencyMonitor(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.pongListener) {
      document.removeEventListener('status-bar-pong', this.pongListener);
      this.pongListener = null;
    }
    this.latencyHistory = [];
    this.setLatency(null);
  }

  // ── Viewer Monitor ────────────────────────────────────────

  private viewerTimer: ReturnType<typeof setInterval> | null = null;
  private viewerFetchFn: ((sessionId: string) => Promise<number>) | null = null;
  private getViewerSessionId: (() => string | null) | null = null;

  startViewerMonitor(
    getActiveSessionId: () => string | null,
    fetchViewerCount: (sessionId: string) => Promise<number>,
  ): void {
    this.getViewerSessionId = getActiveSessionId;
    this.viewerFetchFn = fetchViewerCount;

    this.viewerTimer = setInterval(() => {
      this.doViewerFetch();
    }, 5000);

    // First fetch after short delay
    setTimeout(() => this.doViewerFetch(), 800);
  }

  private async doViewerFetch(): Promise<void> {
    if (!this.getViewerSessionId || !this.viewerFetchFn) return;
    const sessionId = this.getViewerSessionId();
    if (!sessionId) {
      this.setViewers(0);
      return;
    }
    try {
      const count = await this.viewerFetchFn(sessionId);
      this.setViewers(count);
    } catch {
      // Silently ignore fetch errors
    }
  }

  stopViewerMonitor(): void {
    if (this.viewerTimer) {
      clearInterval(this.viewerTimer);
      this.viewerTimer = null;
    }
    this.setViewers(0);
  }

  // ── Transfer Event Listener ────────────────────────────────

  private listenForTransfers(): void {
    this.transferListener = ((e: CustomEvent<{
      sessionId: string; id: string; type: 'upload' | 'download'; progress: number; status: string;
    }>) => {
      const { id, type, progress, status } = e.detail;
      const isTerminal = status === 'completed' || status === 'failed' || status === 'cancelled';
      if (isTerminal) {
        this.activeTransfers.delete(id);
      } else {
        this.activeTransfers.set(id, { type, progress, status });
      }

      if (this.activeTransfers.size === 0) {
        if (status === 'cancelled' || status === 'failed') {
          // Cancelled/failed: remove capsule immediately, no "100%" flash
          this.setTransfer(null);
        } else {
          // Completed: show 100% for 2s then fade out
          this.setTransfer({ direction: type, fileCount: 0, progress: 100 });
        }
      } else {
        let uploads = 0, downloads = 0, totalProgress = 0;
        this.activeTransfers.forEach((t) => {
          if (t.type === 'upload') uploads++;
          else downloads++;
          totalProgress += t.progress;
        });
        const direction: 'upload' | 'download' | 'mixed' = uploads > 0 && downloads > 0 ? 'mixed' : uploads > 0 ? 'upload' : 'download';
        const avgProgress = totalProgress / this.activeTransfers.size;
        this.setTransfer({ direction, fileCount: this.activeTransfers.size, progress: avgProgress });
      }
    }) as EventListener;
    document.addEventListener('status-bar-transfer', this.transferListener);
  }

  // ── AI Event Listener ──────────────────────────────────────

  private listenForAI(): void {
    this.aiListener = ((e: CustomEvent<{ active: boolean }>) => {
      this.setAIActive(e.detail.active);
    }) as EventListener;
    document.addEventListener('status-bar-ai', this.aiListener);
  }

  // ── Viewer Popup ──────────────────────────────────────────

  showViewerPopup(clients: Array<{ id: string; session_id: string; role: string; remote_addr: string; connected: boolean }>): void {
    this.hideViewerPopup();
    if (!this.viewersCapsule) return;

    const popup = document.createElement('div');
    popup.className = 'viewer-popup';

    if (clients.length === 0) {
      popup.innerHTML = `<div class="viewer-popup-empty">${escapeHtml(t('noConnectedDevices'))}</div>`;
    } else {
      const rows = clients.map(c => {
        const idShort = c.id.substring(0, 8);
        const roleBadge = c.role === 'master'
          ? '<span class="viewer-popup-badge badge-master">M</span>'
          : c.role === 'readonly'
            ? '<span class="viewer-popup-badge badge-readonly">R</span>'
            : '<span class="viewer-popup-badge badge-viewer">V</span>';
        return `<div class="viewer-popup-row" data-session-id="${escapeHtml(c.session_id)}" data-client-id="${escapeHtml(c.id)}">
          <span class="viewer-popup-id">${escapeHtml(idShort)}</span>
          ${roleBadge}
          <span class="viewer-popup-ip">${escapeHtml(c.remote_addr || '?')}</span>
          <button class="viewer-popup-kick" title="${escapeHtml(t('kickAndBan'))}">${escapeHtml(t('kickClient'))}</button>
        </div>`;
      }).join('');
      popup.innerHTML = `<div class="viewer-popup-header">${escapeHtml(t('connectedDevices'))}</div>${rows}`;
    }

    // Position below the capsule (status bar is near the top)
    const rect = this.viewersCapsule.getBoundingClientRect();
    popup.style.position = 'fixed';
    popup.style.visibility = 'hidden';
    document.body.appendChild(popup);
    this.viewerPopup = popup;

    const popupRect = popup.getBoundingClientRect();
    const gap = 4;

    // Vertical: prefer below, fallback above if overflow
    const spaceBelow = window.innerHeight - rect.bottom - gap;
    if (spaceBelow >= popupRect.height) {
      popup.style.top = `${rect.bottom + gap}px`;
    } else {
      popup.style.bottom = `${window.innerHeight - rect.top + gap}px`;
    }

    // Horizontal: align right edge with capsule, clamp to viewport
    let right = window.innerWidth - rect.right;
    if (right + popupRect.width > window.innerWidth) {
      right = Math.max(4, window.innerWidth - popupRect.width - 4);
    }
    popup.style.right = `${Math.max(4, right)}px`;
    popup.style.visibility = '';

    // Kick button handlers
    popup.querySelectorAll('.viewer-popup-kick').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const row = (e.target as HTMLElement).closest('.viewer-popup-row') as HTMLElement;
        if (row) {
          document.dispatchEvent(new CustomEvent('status-bar-kick-client', {
            detail: {
              sessionId: row.dataset.sessionId,
              clientId: row.dataset.clientId,
            },
          }));
          row.remove();
        }
      });
    });

    // Close on click outside / ESC
    this.viewerPopupCloseHandler = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key === 'Escape') {
        this.hideViewerPopup();
      } else if (e instanceof MouseEvent && this.viewerPopup && !this.viewerPopup.contains(e.target as Node) && !this.viewersCapsule?.contains(e.target as Node)) {
        this.hideViewerPopup();
      }
    };
    setTimeout(() => {
      document.addEventListener('click', this.viewerPopupCloseHandler!);
      document.addEventListener('keydown', this.viewerPopupCloseHandler!);
    }, 0);
  }

  hideViewerPopup(): void {
    if (this.viewerPopup) {
      this.viewerPopup.remove();
      this.viewerPopup = null;
    }
    if (this.viewerPopupCloseHandler) {
      document.removeEventListener('click', this.viewerPopupCloseHandler);
      document.removeEventListener('keydown', this.viewerPopupCloseHandler);
      this.viewerPopupCloseHandler = null;
    }
  }

  // ── Teardown ────────────────────────────────────────────────

  destroy(): void {
    this.stopLatencyMonitor();
    this.stopViewerMonitor();
    this.hideViewerPopup();

    if (this.transferListener) {
      document.removeEventListener('status-bar-transfer', this.transferListener);
      this.transferListener = null;
    }
    if (this.aiListener) {
      document.removeEventListener('status-bar-ai', this.aiListener);
      this.aiListener = null;
    }

    if (this.transferHideTimer !== null) {
      clearTimeout(this.transferHideTimer);
      this.transferHideTimer = null;
    }
    if (this.aiExitTimer !== null) {
      clearTimeout(this.aiExitTimer);
      this.aiExitTimer = null;
    }

    if (this.progressLayer) {
      this.progressLayer.remove();
      this.progressLayer = null;
      this.progressFill = null;
    }

    this.activeTransfers.clear();
    this.connectionCapsule = null;
    this.lockCapsule = null;
    this.latencyCapsule = null;
    this.sessionsCapsule = null;
    this.viewersCapsule = null;
    this.transferCapsule = null;
    this.aiCapsule = null;
    this.leftZone = null;
    this.rightZone = null;

    if (this.container) {
      this.container.innerHTML = '';
      this.container = null;
    }
    this.initialized = false;
  }

  // ── Utilities ───────────────────────────────────────────────

  private defaultLabel(status: SessionStatus | 'error'): string {
    switch (status) {
      case 'connecting':
        return 'Connecting';
      case 'connected':
        return 'Connected';
      case 'reconnecting':
        return 'Reconnecting';
      case 'ended':
        return 'Ended';
      case 'notfound':
        return 'Not Found';
      case 'disconnected':
        return 'Disconnected';
      case 'error':
        return 'Error';
    }
  }
}

// ─── Singleton Export ────────────────────────────────────────────

export const StatusBar = new StatusBarClass();
