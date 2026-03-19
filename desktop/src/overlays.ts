/**
 * overlays.ts — Full-screen overlay UIs (reconnect, kicked, viewer, reclaim, master approval).
 * Extracted from main.ts. Uses callback injection for main-loop functions to avoid circular deps.
 */
import { t } from './i18n';
import { escapeHtml, StatusBar } from './status-bar';
import { TabManager } from './tabs';
import { TerminalRegistry } from './terminal';
import { DrawerManager } from './drawer';
import { AICapsuleManager } from './ai-capsule';
import { getAllLeaves } from './split-pane';
import { createSSHSession, type SSHConnectionConfig } from './ssh';
import { createConnectionToken } from './jumpserver-api';
import { notifyUser } from './notify';
import {
  port, authToken,
  isHomeView, isGalleryView,
  sshConfigMap, remoteInfoMap, remoteTabNumbers,
  sessionProgressMap, jumpServerConfigMap,
} from './app-state';

// ── Callback injection (set from main.ts init) ──
let _activateTab: (tabId: string) => Promise<void> = async () => {};
let _renderTabs: () => void = () => {};
let _showHomeView: () => void = () => {};
let _terminalPanelEl: HTMLElement = document.body; // placeholder until init

export function setOverlayCallbacks(opts: {
  activateTab: (tabId: string) => Promise<void>;
  renderTabs: () => void;
  showHomeView: () => void;
  terminalPanelEl: HTMLElement;
}): void {
  _activateTab = opts.activateTab;
  _renderTabs = opts.renderTabs;
  _showHomeView = opts.showHomeView;
  _terminalPanelEl = opts.terminalPanelEl;
}

// ── SSH Connecting Placeholder ──

export function showSSHConnectingPlaceholder(config: SSHConnectionConfig): void {
  removeSSHConnectingPlaceholder();
  const placeholder = document.createElement('div');
  placeholder.id = 'ssh-connecting-placeholder';
  placeholder.className = 'ssh-connecting-placeholder';
  placeholder.innerHTML =
    `<div class="ssh-connecting-spinner"></div>` +
    `<div class="ssh-connecting-label">${escapeHtml(t('connecting'))} ${escapeHtml(config.username)}@${escapeHtml(config.host)}:${config.port}...</div>`;
  _terminalPanelEl.appendChild(placeholder);
}

export function removeSSHConnectingPlaceholder(): void {
  document.getElementById('ssh-connecting-placeholder')?.remove();
}

// ── Reconnect Overlay ──

export function removeReconnectOverlay(sessionId: string): void {
  document.querySelector(`.ssh-reconnect-overlay[data-session-id="${sessionId}"]`)?.remove();
}

export function removeAllReconnectOverlays(): void {
  document.querySelectorAll('.ssh-reconnect-overlay').forEach((el) => el.remove());
}

export function showReconnectOverlay(sessionId: string, tabId: string): void {
  const config = sshConfigMap.get(sessionId);
  if (!config) return;

  // Find the terminal container to overlay on — MUST be scoped to this tab only.
  const mt = TerminalRegistry.get(sessionId);
  // Attach overlay directly to the terminal container (not parentElement).
  // This ensures the overlay is scoped to exactly this terminal, not the whole panel.
  const parent = mt?.container ?? _terminalPanelEl;
  if (parent !== _terminalPanelEl) {
    parent.style.position = 'relative'; // ensure absolute overlay is scoped here
  }

  // Don't duplicate
  if (parent.querySelector(`.ssh-reconnect-overlay[data-session-id="${sessionId}"]`)) return;

  const overlay = document.createElement('div');
  overlay.className = 'ssh-reconnect-overlay';
  overlay.dataset.sessionId = sessionId;

  const iconEl = document.createElement('div');
  iconEl.className = 'ssh-reconnect-icon';
  iconEl.innerHTML = '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/></svg>';

  const msgEl = document.createElement('div');
  msgEl.className = 'ssh-reconnect-msg';
  msgEl.textContent = `${config.username}@${config.host} ${t('disconnected')}`;

  const btn = document.createElement('button');
  btn.className = 'ssh-reconnect-btn';
  btn.type = 'button';
  btn.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2 8a6 6 0 0 1 10-4.5L14 5.5"/><path d="M14 2v3.5h-3.5"/><path d="M14 8a6 6 0 0 1-10 4.5L2 10.5"/><path d="M2 14v-3.5h3.5"/></svg>' +
    `<span>${t('reconnect') || 'Reconnect'}</span>`;

  const errorEl = document.createElement('div');
  errorEl.className = 'ssh-reconnect-error';

  overlay.appendChild(iconEl);
  overlay.appendChild(msgEl);
  overlay.appendChild(btn);
  overlay.appendChild(errorEl);
  parent.appendChild(overlay);

  // 通知文件管理抽屉显示断连遮罩
  DrawerManager.notifyDisconnect(sessionId);

  btn.onclick = async () => {
    btn.classList.add('is-reconnecting');
    btn.querySelector('span')!.textContent = t('connecting') || 'Connecting...';
    overlay.classList.add('reconnecting');
    errorEl.textContent = '';
    StatusBar.setConnection('connecting', `${config.username}@${config.host}`);

    try {
      // For JumpServer sessions, re-create connection token before reconnecting
      const jsConfig = jumpServerConfigMap.get(sessionId);
      let reconnectConfig = config;
      if (jsConfig) {
        const tokenResult = await createConnectionToken(
          jsConfig.config.baseUrl, jsConfig.asset.id, jsConfig.account.name, jsConfig.account.username, jsConfig.account.alias || '', jsConfig.account.id, 'ssh',
        );
        if (!tokenResult.ok || !tokenResult.token) {
          throw new Error(tokenResult.error || 'Failed to create connection token');
        }
        const jmsToken = tokenResult.id || tokenResult.token;
        reconnectConfig = {
          ...config,
          username: `JMS-${jmsToken}`,
          password: tokenResult.secret || tokenResult.token || '',
          skipShellHook: true,
        };
      }

      const newSessionId = await createSSHSession(reconnectConfig);
      sshConfigMap.set(newSessionId, reconnectConfig);
      sshConfigMap.delete(sessionId);
      // Migrate JumpServer config to new session if present
      if (jsConfig) {
        jumpServerConfigMap.set(newSessionId, jsConfig);
        jumpServerConfigMap.delete(sessionId);
      }
      sessionProgressMap.delete(sessionId);

      // Find the tab and update split root
      const tab = TabManager.tabs.find((t) => t.id === tabId);
      if (!tab) {
        overlay.remove();
        return;
      }

      // Update leaf session ID
      const leaves = getAllLeaves(tab.splitRoot);
      const oldLeaf = leaves.find((l) => l.sessionId === sessionId);
      if (oldLeaf) {
        oldLeaf.sessionId = newSessionId;
      }

      // Serialize old terminal content before destroying
      const historyBuffer = TerminalRegistry.serializeBuffer(sessionId);

      // Destroy old terminal
      DrawerManager.destroy(sessionId);
      AICapsuleManager.destroy(sessionId);
      TerminalRegistry.destroy(sessionId);

      // Create new terminal
      const newMt = TerminalRegistry.create(
        newSessionId,
        port,
        authToken,
        (status) => {
          const t = TabManager.tabs.find((t) => t.id === tabId);
          if (t) {
            t.status = status;
            TabManager.notify();
          }
          // Show reconnect again if this new session also disconnects
          if ((status === 'ended' || status === 'disconnected' || status === 'notfound') && sshConfigMap.has(newSessionId)) {
            showReconnectOverlay(newSessionId, tabId);
          }
        },
        (title) => {
          // JumpServer sessions: keep asset name as tab title, ignore terminal title updates
          if (jumpServerConfigMap.has(newSessionId)) return;
          const t = TabManager.tabs.find((t) => t.id === tabId);
          if (t) {
            t.title = title || t.title;
            TabManager.notify();
          }
        },
      );

      // Restore old terminal content into the new terminal
      if (historyBuffer) {
        newMt.terminal.write(historyBuffer);
      }

      DrawerManager.create(newSessionId, 'ssh');
      DrawerManager.updateServerInfo(newSessionId, {
        host: config.host,
        username: config.username,
        port: config.port,
      });

      // Fade out overlay and activate tab
      overlay.classList.remove('reconnecting');
      overlay.classList.add('fade-out');
      overlay.addEventListener('animationend', () => overlay.remove());
      setTimeout(() => overlay.remove(), 500); // safety net

      await _activateTab(tabId);
      StatusBar.setConnection('connected', `${config.username}@${config.host}`);
      TabManager.notify();
      _renderTabs();
    } catch (err) {
      btn.classList.remove('is-reconnecting');
      btn.querySelector('span')!.textContent = t('reconnect') || 'Reconnect';
      overlay.classList.remove('reconnecting');
      errorEl.textContent = String(err);
      StatusBar.setError(`${t('sshFailed')}: ${String(err)}`);
    }
  };
}

// ── Kicked Overlay ──

export function showKickedOverlay(sessionId: string, msg?: string): void {
  const mt = TerminalRegistry.get(sessionId);
  const parent = mt?.container?.parentElement ?? _terminalPanelEl;
  if (parent.querySelector(`.kicked-overlay[data-session-id="${sessionId}"]`)) return;

  const overlay = document.createElement('div');
  overlay.className = 'kicked-overlay';
  overlay.dataset.sessionId = sessionId;

  const iconEl = document.createElement('div');
  iconEl.className = 'kicked-overlay-icon';
  iconEl.innerHTML = '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6M9 9l6 6"/></svg>';

  const msgEl = document.createElement('div');
  msgEl.className = 'kicked-overlay-msg';
  msgEl.textContent = msg || t('kickedOverlayMsg');

  const closeBtn = document.createElement('button');
  closeBtn.className = 'kicked-overlay-close-btn';
  closeBtn.type = 'button';
  closeBtn.textContent = t('closeTab');
  closeBtn.onclick = async () => {
    const tab = TabManager.tabs.find((tb) => {
      const leaves = getAllLeaves(tb.splitRoot);
      return leaves.some((l) => l.sessionId === sessionId);
    });
    if (!tab) return;
    const closingLeaves = getAllLeaves(tab.splitRoot);
    for (const leaf of closingLeaves) {
      DrawerManager.destroy(leaf.sessionId);
      AICapsuleManager.destroy(leaf.sessionId);
      sshConfigMap.delete(leaf.sessionId);
      jumpServerConfigMap.delete(leaf.sessionId);
      remoteInfoMap.delete(leaf.sessionId);
      remoteTabNumbers.delete(leaf.sessionId);
      viewerModeSessionIds.delete(leaf.sessionId);
      reclaimSessionIds.delete(leaf.sessionId);
      { const pr = pendingMasterRequests.get(leaf.sessionId); if (pr) { clearTimeout(pr.timerId); pendingMasterRequests.delete(leaf.sessionId); } }
      privateSessionIds.delete(leaf.sessionId);
      sessionProgressMap.delete(leaf.sessionId);
    }
    removeKickedOverlay(sessionId);
    removeReconnectOverlay(sessionId);
    await TabManager.closeTab(tab.id);
    if (TabManager.activeTabId) {
      await _activateTab(TabManager.activeTabId);
    } else {
      _showHomeView();
    }
    _renderTabs();
  };

  overlay.appendChild(iconEl);
  overlay.appendChild(msgEl);
  overlay.appendChild(closeBtn);
  parent.appendChild(overlay);
}

export function removeKickedOverlay(sessionId: string): void {
  document.querySelector(`.kicked-overlay[data-session-id="${sessionId}"]`)?.remove();
}

// ── Master Request Approval ──

export const pendingMasterRequests = new Map<string, { requesterId: string; timerId: ReturnType<typeof setTimeout> }>();
let masterApprovalOverlayEl: HTMLDivElement | null = null;
let masterApprovalSessionId: string | null = null;

function createMasterApprovalOverlayEl(sessionId: string, requesterId: string): HTMLDivElement {
  const overlay = document.createElement('div');
  overlay.className = 'master-approval-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'master-approval-dialog';

  const shortId = requesterId.length > 12 ? requesterId.slice(0, 8) + '...' : requesterId;
  dialog.innerHTML = `
    <div class="master-approval-icon">
      <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
        <circle cx="8.5" cy="7" r="4"/>
        <path d="M20 8v6"/>
        <path d="M23 11h-6"/>
      </svg>
    </div>
    <h3>${t('masterRequestTitle') || 'Control Request'}</h3>
    <p>${t('masterRequestMessage') || 'A remote viewer wants to take control of the terminal.'}</p>
    <p class="master-approval-requester">${escapeHtml(shortId)}</p>
  `;

  const buttons = document.createElement('div');
  buttons.className = 'master-approval-buttons';

  const denyBtn = document.createElement('button');
  denyBtn.className = 'master-approval-btn deny';
  denyBtn.textContent = t('masterRequestDeny') || 'Deny';
  denyBtn.onclick = () => respondMasterRequest(sessionId, false);

  const approveBtn = document.createElement('button');
  approveBtn.className = 'master-approval-btn approve';
  approveBtn.textContent = t('masterRequestApprove') || 'Approve';
  approveBtn.onclick = () => respondMasterRequest(sessionId, true);

  buttons.appendChild(denyBtn);
  buttons.appendChild(approveBtn);
  dialog.appendChild(buttons);
  overlay.appendChild(dialog);
  return overlay;
}

export function respondMasterRequest(sessionId: string, approved: boolean): void {
  const pending = pendingMasterRequests.get(sessionId);
  if (!pending) return;
  clearTimeout(pending.timerId);
  TerminalRegistry.sendMasterApproval(sessionId, approved, pending.requesterId);
  pendingMasterRequests.delete(sessionId);
  hideMasterApprovalOverlay();
  _renderTabs(); // remove breathing animation
}

export function showMasterApprovalOverlay(sessionId: string): void {
  hideMasterApprovalOverlay();
  const pending = pendingMasterRequests.get(sessionId);
  if (!pending) return;
  masterApprovalSessionId = sessionId;
  const overlay = createMasterApprovalOverlayEl(sessionId, pending.requesterId);
  _terminalPanelEl.appendChild(overlay);
  masterApprovalOverlayEl = overlay;
}

export function hideMasterApprovalOverlay(): void {
  if (masterApprovalOverlayEl) {
    masterApprovalOverlayEl.remove();
    masterApprovalOverlayEl = null;
  }
  masterApprovalSessionId = null;
}

/** Sync master approval overlay visibility when switching tabs */
export function syncMasterApprovalForActiveTab(): void {
  // Never show overlay on top of home/gallery view — tab breathing animation alerts the user.
  if (isHomeView || isGalleryView) { hideMasterApprovalOverlay(); return; }
  const activeTab = TabManager.getActiveTab();
  if (!activeTab) { hideMasterApprovalOverlay(); return; }

  const leaves = getAllLeaves(activeTab.splitRoot);
  const pendingLeaf = leaves.find((l) => pendingMasterRequests.has(l.sessionId));

  if (pendingLeaf) {
    if (masterApprovalSessionId !== pendingLeaf.sessionId) {
      showMasterApprovalOverlay(pendingLeaf.sessionId);
    }
  } else {
    hideMasterApprovalOverlay();
  }
}

export function showMasterApprovalDialog(sessionId: string, requesterId: string): void {
  // Remove any previous request for this session
  const prev = pendingMasterRequests.get(sessionId);
  if (prev) clearTimeout(prev.timerId);

  // Auto-deny after 30 seconds
  const timerId = setTimeout(() => {
    if (pendingMasterRequests.has(sessionId)) {
      respondMasterRequest(sessionId, false);
    }
  }, 30000);

  pendingMasterRequests.set(sessionId, { requesterId, timerId });

  // System notification (dock bounce / taskbar flash)
  void notifyUser({
    id: `master-${requesterId}`,
    type: 'master-request',
    title: t('masterRequestTitle') || 'Control Request',
    body: t('masterRequestMessage') || 'A remote viewer wants to take control.',
  });

  // Show overlay if the session is on the active tab and not in home/gallery view.
  // syncMasterApprovalForActiveTab contains the home/gallery guard.
  syncMasterApprovalForActiveTab();
  _renderTabs(); // trigger breathing animation on the target tab
}

// ── Reclaim Overlay ──

let reclaimOverlayEl: HTMLDivElement | null = null;
let reclaimKeyHandler: ((e: KeyboardEvent) => void) | null = null;
// Track which sessions are being remotely controlled (need reclaim overlay)
export const reclaimSessionIds = new Set<string>();

export function showReclaimButton(sessionId: string): void {
  hideReclaimButton();

  const overlay = document.createElement('div');
  overlay.className = 'reclaim-overlay';
  overlay.innerHTML = `
    <div class="reclaim-overlay-content">
      <div class="reclaim-overlay-text">${t('reclaimClickHint') || '点击取消远控'}</div>
      <div class="reclaim-overlay-subtext">${t('reclaimSpaceHint') || '(空格取消远控)'}</div>
    </div>
  `;

  const doReclaim = () => {
    reclaimSessionIds.delete(sessionId);
    TerminalRegistry.sendMasterReclaim(sessionId);
    hideReclaimButton();

    // Safety net: if we don't regain master within 3s, the reclaim was
    // likely silently ignored (e.g. client ID mismatch after reconnect race).
    // Force-close the WebSocket so the reconnect logic kicks in.
    const reclaimTimeout = setTimeout(() => {
      document.removeEventListener('master-gained', onGained);
      const mt = TerminalRegistry.get(sessionId);
      if (mt && !mt.ended && mt.ws) {
        console.warn(`[overlays] reclaim timeout for ${sessionId}, forcing reconnect`);
        mt.ws.close();
      }
    }, 3000);

    const onGained = ((e: CustomEvent) => {
      if (e.detail.sessionId === sessionId) {
        clearTimeout(reclaimTimeout);
        document.removeEventListener('master-gained', onGained);
      }
    }) as EventListener;
    document.addEventListener('master-gained', onGained);
  };

  overlay.onclick = doReclaim;

  reclaimKeyHandler = (e: KeyboardEvent) => {
    if (e.code === 'Space' || e.key === ' ') {
      e.preventDefault();
      doReclaim();
    }
  };
  document.addEventListener('keydown', reclaimKeyHandler);

  _terminalPanelEl.appendChild(overlay);
  reclaimOverlayEl = overlay;
}

export function hideReclaimButton(): void {
  if (reclaimOverlayEl) {
    reclaimOverlayEl.remove();
    reclaimOverlayEl = null;
  }
  if (reclaimKeyHandler) {
    document.removeEventListener('keydown', reclaimKeyHandler);
    reclaimKeyHandler = null;
  }
}

/** Show or hide reclaim overlay based on whether the active tab has a reclaim session */
export function syncReclaimOverlayForActiveTab(): void {
  // Never show overlay on top of home/gallery view.
  if (isHomeView || isGalleryView) { hideReclaimButton(); return; }
  const activeTab = TabManager.getActiveTab();
  if (!activeTab) { hideReclaimButton(); return; }

  const leaves = getAllLeaves(activeTab.splitRoot);
  const reclaimLeaf = leaves.find((l) => reclaimSessionIds.has(l.sessionId));

  if (reclaimLeaf) {
    // Active tab has a session being remotely controlled — show reclaim overlay
    if (!reclaimOverlayEl) {
      showReclaimButton(reclaimLeaf.sessionId);
    }
  } else {
    hideReclaimButton();
  }
}

// ── Viewer Overlay ──

export const viewerModeSessionIds = new Set<string>();
export const privateSessionIds = new Set<string>();
let viewerOverlayEl: HTMLDivElement | null = null;
let viewerOverlaySessionId: string | null = null;

function createViewerOverlayEl(sessionId: string): HTMLDivElement {
  const overlay = document.createElement('div');
  overlay.className = 'viewer-overlay';

  const content = document.createElement('div');
  content.className = 'viewer-overlay-content';

  const badge = document.createElement('div');
  badge.className = 'viewer-overlay-badge';
  badge.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3.5 9h17M3.5 15h17"/></svg><span>${t('viewerObserving')}</span>`;

  const requestBtn = document.createElement('button');
  requestBtn.className = 'viewer-request-btn';
  requestBtn.type = 'button';
  requestBtn.textContent = t('viewerRequestControl');
  requestBtn.onclick = () => {
    TerminalRegistry.sendMasterRequest(sessionId);
    requestBtn.textContent = t('viewerRequesting');
    requestBtn.disabled = true;
    requestBtn.classList.add('requesting');
    setTimeout(() => {
      if (requestBtn.disabled && document.body.contains(requestBtn)) {
        requestBtn.textContent = t('viewerRequestControl');
        requestBtn.disabled = false;
        requestBtn.classList.remove('requesting');
      }
    }, 10000);
  };

  content.appendChild(badge);
  content.appendChild(requestBtn);
  overlay.appendChild(content);
  return overlay;
}

export function showViewerOverlay(sessionId: string): void {
  hideViewerOverlayDom();
  viewerOverlaySessionId = sessionId;
  const overlay = createViewerOverlayEl(sessionId);
  _terminalPanelEl.appendChild(overlay);
  viewerOverlayEl = overlay;
}

export function hideViewerOverlayDom(): void {
  if (viewerOverlayEl) {
    viewerOverlayEl.remove();
    viewerOverlayEl = null;
  }
  viewerOverlaySessionId = null;
}

/** Mark session as viewer mode and show overlay if it's the active tab */
export function enterViewerMode(sessionId: string): void {
  viewerModeSessionIds.add(sessionId);
  syncViewerOverlayForActiveTab();
}

/** Remove session from viewer mode and hide overlay if needed */
export function exitViewerMode(sessionId: string): void {
  viewerModeSessionIds.delete(sessionId);
  syncViewerOverlayForActiveTab();
}

/** Show or hide viewer overlay based on whether the active tab has a viewer session */
export function syncViewerOverlayForActiveTab(): void {
  if (isHomeView || isGalleryView) { hideViewerOverlayDom(); return; }
  const activeTab = TabManager.getActiveTab();
  if (!activeTab) { hideViewerOverlayDom(); return; }

  const leaves = getAllLeaves(activeTab.splitRoot);
  const viewerLeaf = leaves.find((l) => viewerModeSessionIds.has(l.sessionId));

  if (viewerLeaf) {
    // Active tab has a viewer session — show overlay if not already for this session
    if (viewerOverlaySessionId !== viewerLeaf.sessionId) {
      showViewerOverlay(viewerLeaf.sessionId);
    }
  } else {
    hideViewerOverlayDom();
  }
}

export function showViewerRequestDenied(): void {
  if (!viewerOverlayEl) return;
  const btn = viewerOverlayEl.querySelector('.viewer-request-btn') as HTMLButtonElement | null;
  if (btn) {
    btn.textContent = t('viewerRequestDenied');
    btn.classList.remove('requesting');
    btn.classList.add('denied');
    setTimeout(() => {
      if (document.body.contains(btn)) {
        btn.textContent = t('viewerRequestControl');
        btn.disabled = false;
        btn.classList.remove('denied');
      }
    }, 3000);
  }
}
