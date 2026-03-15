/**
 * Home Dashboard — main entry point.
 * Search bar with floating overlay for results (tabs: connections | web | tldr).
 * Below: 2×2 buttons + recent activity + groups + footer (all full width).
 */
import { getVersion } from '@tauri-apps/api/app';
import { openUrl } from '@tauri-apps/plugin-opener';
import { t } from './i18n';
import { createOverlayScrollbar } from './overlay-scrollbar';
import { icon } from './icons';
import { showSSHModal } from './ssh';
import { renderRecentActivity, renderGroupsSection } from './home-dashboard-left';
import { renderSearchOverlay, hideSearchOverlay } from './home-dashboard-right';
import { createUnifiedSearch } from './home-dashboard-search';

// Re-export for ssh.ts backwards compat
export { createDashboardHomeView as createSSHHomeView, updateDashboardHomeView as updateSSHHomeView };

const GITHUB_URL = 'https://github.com/paidaxingyo666/MeTerm';
const GITEE_URL = 'https://gitee.com/paidaxingy666/me-term';

// ─── Create the DOM structure ───

export function createDashboardHomeView(): HTMLDivElement {
  const container = document.createElement('div');
  container.className = 'home-view home-dashboard';
  container.id = 'home-view';

  const scroll = document.createElement('div');
  scroll.className = 'home-dash-scroll';
  createOverlayScrollbar({ viewport: scroll, container: scroll });

  // ── Search bar (full width, with floating overlay anchor) ──
  const searchRow = document.createElement('div');
  searchRow.className = 'home-dash-search-row';

  const searchWrap = document.createElement('div');
  searchWrap.className = 'home-dash-search-wrap';
  const searchIcon = document.createElement('span');
  searchIcon.className = 'home-dash-search-icon';
  searchIcon.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/></svg>';
  const searchInput = document.createElement('input');
  searchInput.className = 'home-dash-search-input';
  searchInput.type = 'text';
  searchInput.placeholder = t('homeSearchPlaceholder');
  searchInput.id = 'home-search-input';
  searchWrap.appendChild(searchIcon);
  searchWrap.appendChild(searchInput);
  searchRow.appendChild(searchWrap);

  // Floating search overlay (anchored below search bar)
  const overlay = document.createElement('div');
  overlay.className = 'home-search-overlay';
  overlay.id = 'home-search-overlay';
  overlay.style.display = 'none';
  searchRow.appendChild(overlay);

  scroll.appendChild(searchRow);

  // ── 2×2 Control Grid (full width) ──
  const controlGrid = document.createElement('div');
  controlGrid.className = 'home-dash-control-grid';
  controlGrid.id = 'home-control-grid';

  const btnData: { cls: string; iconName: 'terminal' | 'ssh' | 'remote' | 'jumpserver'; labelKey: 'homeNewLocalSession' | 'homeNewSSHSession' | 'homeRemoteConnect' | 'homeNewJumpServer'; action: () => void }[] = [
    {
      cls: 'home-dash-ctrl-btn home-btn-local',
      iconName: 'terminal',
      labelKey: 'homeNewLocalSession',
      action: () => document.dispatchEvent(new CustomEvent('new-local-session')),
    },
    {
      cls: 'home-dash-ctrl-btn home-btn-ssh',
      iconName: 'ssh',
      labelKey: 'homeNewSSHSession',
      action: () => showSSHModal(),
    },
    {
      cls: 'home-dash-ctrl-btn home-btn-remote',
      iconName: 'remote',
      labelKey: 'homeRemoteConnect',
      action: () => document.dispatchEvent(new CustomEvent('remote-connect-request')),
    },
    {
      cls: 'home-dash-ctrl-btn home-btn-jumpserver',
      iconName: 'jumpserver',
      labelKey: 'homeNewJumpServer',
      action: async () => {
        const { showJumpServerConfigDialog } = await import('./jumpserver-ui');
        const result = await showJumpServerConfigDialog();
        if (result?.connect) {
          const { handleJumpServerConnect } = await import('./jumpserver-handler');
          handleJumpServerConnect(result.config);
        }
      },
    },
  ];

  for (const bd of btnData) {
    const btn = document.createElement('button');
    btn.className = bd.cls;
    btn.innerHTML = `<span class="home-dash-ctrl-icon">${icon(bd.iconName)}</span><span class="home-dash-ctrl-label">${t(bd.labelKey)}</span>`;
    btn.onclick = bd.action;
    if (bd.iconName === 'terminal') {
      btn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        document.dispatchEvent(new CustomEvent('new-local-session-menu', { detail: { mouseEvent: e, anchor: btn } }));
      });
    }
    controlGrid.appendChild(btn);
  }
  scroll.appendChild(controlGrid);

  // ── Recent Activity (full width) ──
  const recentSection = document.createElement('div');
  recentSection.className = 'home-dash-section';
  recentSection.id = 'home-recent-activity';
  scroll.appendChild(recentSection);

  // ── Connection Groups (full width) ──
  const groupsSection = document.createElement('div');
  groupsSection.className = 'home-dash-section';
  groupsSection.id = 'home-groups-section';
  scroll.appendChild(groupsSection);

  container.appendChild(scroll);

  // ── Footer (fixed at bottom, outside scroll) ──
  const footer = document.createElement('div');
  footer.className = 'home-dash-footer';
  footer.innerHTML = `<span class="home-dash-footer-version" id="home-footer-version">MeTerm</span><span class="home-dash-footer-sep">·</span><a class="home-dash-footer-link" id="home-footer-github">GitHub</a><span class="home-dash-footer-sep">·</span><a class="home-dash-footer-link" id="home-footer-gitee">Gitee</a><span class="home-dash-footer-sep">·</span><a class="home-dash-footer-link" id="home-footer-licenses">${t('aboutLicenses')}</a>`;
  container.appendChild(footer);

  // ── Setup unified search ──
  const search = createUnifiedSearch({
    onLeftUpdate: () => {
      // No longer filter main page cards — search results only in overlay
    },
    onRightUpdate: (query: string) => {
      renderSearchOverlay(overlay, query);
    },
  });
  searchInput.addEventListener('input', () => {
    const query = searchInput.value.trim();
    search.search(query);
  });

  // Close overlay on click outside
  document.addEventListener('mousedown', (e) => {
    if (overlay.style.display !== 'none' && !searchRow.contains(e.target as Node)) {
      hideSearchOverlay(overlay);
    }
  });

  // Close overlay on Escape
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      searchInput.value = '';
      search.search('');
      searchInput.blur();
    }
  });

  // Async load version
  getVersion().then((v) => {
    const el = document.getElementById('home-footer-version');
    if (el) el.textContent = t('homeFooterVersion').replace('{version}', v);
  }).catch(() => {});

  // Footer links
  requestAnimationFrame(() => {
    const ghLink = document.getElementById('home-footer-github');
    if (ghLink) {
      ghLink.onclick = (e) => { e.preventDefault(); openUrl(GITHUB_URL); };
    }
    const giteeLink = document.getElementById('home-footer-gitee');
    if (giteeLink) {
      giteeLink.onclick = (e) => { e.preventDefault(); openUrl(GITEE_URL); };
    }
    const licensesLink = document.getElementById('home-footer-licenses');
    if (licensesLink) {
      licensesLink.onclick = (e) => { e.preventDefault(); openUrl(`${GITHUB_URL}/blob/main/THIRD_PARTY_LICENSES.md`); };
    }
  });

  // Global Cmd+K focus
  const onKeydown = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      const input = document.getElementById('home-search-input') as HTMLInputElement | null;
      if (input && input.offsetParent !== null) {
        e.preventDefault();
        input.focus();
        input.select();
      }
    }
  };
  document.addEventListener('keydown', onKeydown);

  // Clean up when home view is removed
  const observer = new MutationObserver(() => {
    if (!document.getElementById('home-view')) {
      document.removeEventListener('keydown', onKeydown);
      observer.disconnect();
      search.destroy();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  return container;
}

// ─── Update / Render ───

export function updateDashboardHomeView(): void {
  renderRecentActivity('');
  renderGroupsSection('', () => updateDashboardHomeView());
}
