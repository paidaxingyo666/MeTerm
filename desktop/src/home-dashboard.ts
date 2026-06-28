/**
 * Empty state shown when there is no active session (the old full-page home is
 * gone — the connection manager is now the docked left sidebar in
 * connection-sidebar.ts). This is just a minimal "no session" placeholder with
 * the "new connection" buttons.
 */
import { settings } from './app-state';
import { makeNewButtons, ConnectionSidebar } from './connection-sidebar';

// Re-export names kept for ssh.ts / view-manager backwards compat.
export { createDashboardHomeView as createSSHHomeView, updateDashboardHomeView as updateSSHHomeView };

const L = (zh: string, en: string): string => (settings?.language === 'zh' ? zh : en);

export function createDashboardHomeView(): HTMLDivElement {
  const container = document.createElement('div');
  container.className = 'home-view home-empty-view';
  container.id = 'home-view';

  const card = document.createElement('div');
  card.className = 'home-empty-card';
  card.innerHTML = `<div class="home-empty-title">${L('暂无会话', 'No active session')}</div>`
    + `<div class="home-empty-sub">${L('新建一个终端，或点标题栏的侧边栏按钮选择连接。', 'Open a terminal, or use the sidebar button in the toolbar to pick a connection.')}</div>`;
  card.appendChild(makeNewButtons());
  container.appendChild(card);

  return container;
}

export function updateDashboardHomeView(): void {
  // Refresh the docked connection sidebar's list (if open).
  ConnectionSidebar.refresh();
}
