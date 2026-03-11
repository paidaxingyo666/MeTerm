/**
 * remote-list.ts — Remote session list popup.
 * Extracted from main.ts.
 */
import { t } from './i18n';
import { escapeHtml } from './status-bar';
import { TabManager } from './tabs';
import { TerminalRegistry } from './terminal';
import { getAllLeaves } from './split-pane';
import { fetchRemoteSessions, type RemoteServerInfo } from './remote';
import { remoteInfoMap, remoteTabNumbers } from './app-state';
import { message } from '@tauri-apps/plugin-dialog';

// Remote session list popup state
let remoteListAutoRefreshTimer: ReturnType<typeof setInterval> | null = null;

export function hasRemoteTabs(): boolean {
  for (const tab of TabManager.tabs) {
    const leaves = getAllLeaves(tab.splitRoot);
    if (leaves.some((l) => TerminalRegistry.get(l.sessionId)?.isRemote)) return true;
  }
  return false;
}

export function getUniqueRemoteServers(): RemoteServerInfo[] {
  const seen = new Set<string>();
  const servers: RemoteServerInfo[] = [];
  for (const [, info] of remoteInfoMap) {
    const key = `${info.host}:${info.port}`;
    if (!seen.has(key)) {
      seen.add(key);
      servers.push(info);
    }
  }
  return servers;
}

export function showRemoteSessionListPopup(anchor: HTMLElement): void {
  const existing = document.querySelector('.remote-list-popup');
  if (existing) { existing.remove(); cleanupRemoteListPopup(); return; }

  const popup = document.createElement('div');
  popup.className = 'remote-list-popup';

  const header = document.createElement('div');
  header.className = 'remote-list-popup-header';
  header.innerHTML = `<span class="remote-list-popup-title">${t('remoteSessionList')}</span>`;

  const refreshBtn = document.createElement('button');
  refreshBtn.className = 'remote-list-refresh-btn';
  refreshBtn.type = 'button';
  refreshBtn.title = t('remoteSessionRefresh');
  refreshBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/></svg>';
  refreshBtn.onclick = () => { void loadRemoteSessions(); };
  header.appendChild(refreshBtn);
  popup.appendChild(header);

  const content = document.createElement('div');
  content.className = 'remote-list-popup-content';
  popup.appendChild(content);

  async function loadRemoteSessions(): Promise<void> {
    const servers = getUniqueRemoteServers();
    if (servers.length === 0) {
      content.innerHTML = `<div class="remote-list-empty">${t('remoteSessionNoRemote')}</div>`;
      return;
    }
    content.innerHTML = '<div class="remote-list-loading">...</div>';
    // Build set of locally opened session IDs for "opened" indicator
    const openedSessionIds = new Set<string>(remoteInfoMap.keys());
    const fragments: string[] = [];
    // Store server info in a map keyed by index to avoid exposing token in DOM
    const serverInfoMap = new Map<string, RemoteServerInfo>();
    let seqNum = 0;
    for (const info of servers) {
      const serverIdx = String(servers.indexOf(info));
      try {
        const sessions = await fetchRemoteSessions(info);
        const serverLabel = escapeHtml(info.name || `${info.host}:${info.port}`);
        fragments.push(`<div class="remote-list-server-label">${t('remoteSessionServer')}: ${serverLabel}</div>`);
        if (sessions.length === 0) {
          fragments.push(`<div class="remote-list-empty-server">${t('remoteNoSessions')}</div>`);
        } else {
          for (const s of sessions) {
            seqNum++;
            const stateClass = s.state === 'running' ? 'running' : 'other';
            const isOpened = openedSessionIds.has(s.id);
            const tabNum = remoteTabNumbers.get(s.id);
            const openedBadge = isOpened
              ? `<span class="remote-list-opened-badge" title="${t('remoteSessionOpened') || 'Opened'}">#${tabNum ?? '?'}</span>`
              : '';
            serverInfoMap.set(`${serverIdx}:${s.id}`, info);
            const label = s.title || s.id.slice(0, 12);
            const privateCls = s.private ? ' remote-list-item-private' : '';
            const lockIcon = s.private ? `<span class="remote-list-lock"><svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5 7V5a3 3 0 0 1 6 0v2"/></svg></span>` : '';
            fragments.push(`<div class="remote-list-item ${isOpened ? 'opened' : ''}${privateCls}" data-server-idx="${escapeHtml(serverIdx)}" data-sid="${escapeHtml(s.id)}" data-private="${s.private ? '1' : ''}"><span class="remote-list-item-num">${seqNum}</span>${lockIcon}<span class="remote-list-item-id" title="${escapeHtml(label)}">${escapeHtml(label)}</span>${openedBadge}<span class="remote-list-item-meta">${escapeHtml(s.executor_type || 'local')} · <span class="remote-list-state-${stateClass}">${escapeHtml(s.state)}</span></span></div>`);
          }
        }
      } catch (err) {
        const serverLabel = escapeHtml(info.name || `${info.host}:${info.port}`);
        fragments.push(`<div class="remote-list-server-label">${serverLabel}</div><div class="remote-list-error">${escapeHtml(String(err))}</div>`);
      }
    }
    content.innerHTML = fragments.join('');
    // Attach click handlers for session items
    content.querySelectorAll('.remote-list-item').forEach((el) => {
      (el as HTMLElement).onclick = async () => {
        const ds = (el as HTMLElement).dataset;
        if (ds.private === '1') {
          await message(t('sessionPrivateCannotConnect'), { kind: 'warning' });
          return;
        }
        const sessionId = ds.sid!;
        const serverIdx = ds.serverIdx!;
        const info = serverInfoMap.get(`${serverIdx}:${sessionId}`);
        if (!info) return;
        document.dispatchEvent(new CustomEvent('remote-session-selected', { detail: { info, sessionId } }));
        popup.remove();
        cleanupRemoteListPopup();
      };
    });
  }

  // Position popup below anchor
  const rect = anchor.getBoundingClientRect();
  popup.style.top = `${rect.bottom + 4}px`;
  popup.style.right = `${window.innerWidth - rect.right}px`;
  document.body.appendChild(popup);

  // Initial load
  void loadRemoteSessions();

  // Auto refresh every 5s
  remoteListAutoRefreshTimer = setInterval(() => {
    if (document.querySelector('.remote-list-popup')) {
      void loadRemoteSessions();
    } else {
      cleanupRemoteListPopup();
    }
  }, 5000);

  // Close on outside click
  const onPointerDown = (e: MouseEvent): void => {
    const target = e.target as Node;
    if (!popup.contains(target) && !anchor.contains(target)) {
      popup.remove();
      cleanupRemoteListPopup();
      document.removeEventListener('mousedown', onPointerDown, true);
    }
  };
  requestAnimationFrame(() => {
    document.addEventListener('mousedown', onPointerDown, true);
  });
}

export function cleanupRemoteListPopup(): void {
  if (remoteListAutoRefreshTimer) {
    clearInterval(remoteListAutoRefreshTimer);
    remoteListAutoRefreshTimer = null;
  }
}
