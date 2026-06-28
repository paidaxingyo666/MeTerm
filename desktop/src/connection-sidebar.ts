/**
 * Docked connection sidebar.
 *
 * A LEFT dock panel inside #main-content that pushes the terminal aside (the
 * terminal stays visible and just narrows — it is never covered/overlaid).
 * Toggled from the toolbar; fully independent of the terminal/view lifecycle.
 * Clicking a connection connects directly; the sidebar stays docked.
 */
import { getVersion } from '@tauri-apps/api/app';
import { openUrl } from '@tauri-apps/plugin-opener';
import { t } from './i18n';
import { icon } from './icons';
import { createOverlayScrollbar } from './overlay-scrollbar';
import { showSSHModal } from './ssh';
import { TerminalRegistry } from './terminal';
import { handleConnectionClick } from './home-dashboard-left';
import { renderSidebarList } from './home-side';
import { loadSettings, saveSettings } from './themes';

const GITHUB_URL = 'https://github.com/paidaxingyo666/MeTerm';
const GITEE_URL = 'https://gitee.com/paidaxingyo666/me-term';

// ── Docked sidebar width — SHARED with the file sidebar via settings.sidebarWidth,
//    so resizing either panel resizes the other and a switch keeps the same width. ──
const MIN_WIDTH = 120; // matches .home-side min-width so the CSS floor never fights the clamp
const MAX_WIDTH = 560;
const DEFAULT_WIDTH = 280;
function clampWidth(w: number): number {
  const max = Math.min(MAX_WIDTH, Math.floor(window.innerWidth * 0.5));
  return Math.max(MIN_WIDTH, Math.min(max, Math.round(w)));
}
function loadWidth(): number {
  const w = loadSettings().sidebarWidth;
  return w > 0 ? Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(w))) : DEFAULT_WIDTH;
}
function saveWidth(w: number): void {
  saveSettings({ ...loadSettings(), sidebarWidth: clampWidth(w) });
}

interface NewAction {
  iconName: 'terminal' | 'ssh' | 'remote' | 'jumpserver';
  labelKey: 'homeNewLocalSession' | 'homeNewSSHSession' | 'homeRemoteConnect' | 'homeNewJumpServer';
  cls: string;
  action: () => void;
  ctxMenu?: boolean;
}

const NEW_ACTIONS: NewAction[] = [
  { iconName: 'terminal', labelKey: 'homeNewLocalSession', cls: 'local', ctxMenu: true, action: () => document.dispatchEvent(new CustomEvent('new-local-session')) },
  { iconName: 'ssh', labelKey: 'homeNewSSHSession', cls: 'ssh', action: () => showSSHModal() },
  { iconName: 'remote', labelKey: 'homeRemoteConnect', cls: 'remote', action: () => document.dispatchEvent(new CustomEvent('remote-connect-request')) },
  {
    iconName: 'jumpserver', labelKey: 'homeNewJumpServer', cls: 'jumpserver',
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

/** Build the 2×2 "new connection" button grid (shared with the empty state). */
export function makeNewButtons(): HTMLElement {
  const row = document.createElement('div');
  row.className = 'home-side-new';
  for (const a of NEW_ACTIONS) {
    const btn = document.createElement('button');
    btn.className = `home-new-btn home-new-${a.cls}`;
    btn.type = 'button';
    btn.innerHTML = `<span class="hnb-icon">${icon(a.iconName)}</span><span class="hnb-label">${t(a.labelKey)}</span>`;
    btn.onclick = a.action;
    if (a.ctxMenu) {
      btn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        document.dispatchEvent(new CustomEvent('new-local-session-menu', { detail: { mouseEvent: e, anchor: btn } }));
      });
    }
    row.appendChild(btn);
  }
  return row;
}

class ConnectionSidebarClass {
  private panel: HTMLDivElement | null = null;
  private listEl: HTMLDivElement | null = null;
  private groupHdrEl: HTMLDivElement | null = null;
  private query = '';
  private _open = false;          // docked (pinned) via click
  private flyoutMode = false;     // floating hover preview (menu-style)
  private hideTimer: number | null = null;

  isOpen(): boolean {
    return this._open;
  }

  toggle(): void {
    if (this._open) this.close();
    else this.open();
  }

  /** Pin the sidebar docked (click). Converts a hover flyout into a dock. */
  open(): void {
    const mainContent = document.getElementById('main-content');
    if (!mainContent) return;
    if (!this.panel) this.build();
    const panel = this.panel!;
    // Drop flyout state and its inline floating styles.
    this.flyoutMode = false;
    this.cancelHideTimer();
    panel.classList.remove('conn-sidebar--flyout');
    panel.style.position = '';
    panel.style.left = '';
    panel.style.top = '';
    panel.style.height = '';
    panel.style.width = `${loadWidth()}px`; // shared docked width
    // Dock as the leftmost child of #main-content so the terminal narrows.
    if (panel.parentElement !== mainContent || mainContent.firstChild !== panel) {
      mainContent.insertBefore(panel, mainContent.firstChild);
    }
    panel.style.display = '';
    this._open = true;
    this.refresh();
    TerminalRegistry.resizeAll();
  }

  close(): void {
    this._open = false;
    const panel = this.panel;
    if (panel) { panel.style.display = 'none'; panel.style.width = ''; }
    TerminalRegistry.resizeAll();
  }

  /** Hide (also drops any flyout state). Used by the mutual-exclusivity switch with
   *  the file manager — same as close() now that there's no enter/exit animation. */
  closeImmediate(): void {
    this.flyoutMode = false;
    this.cancelHideTimer();
    this.panel?.classList.remove('conn-sidebar--flyout');
    this.close();
  }

  // ── Hover flyout (menu-style floating preview) ──

  /** Show the sidebar as a floating dropdown MENU anchored to the toolbar
   *  button, on the topmost layer (does NOT push the terminal). No-op if
   *  already docked. Height is content-driven up to a CSS max-height. */
  showFlyout(anchor: HTMLElement): void {
    if (this._open) return;
    if (!this.panel) this.build();
    const panel = this.panel!;
    const r = anchor.getBoundingClientRect();
    this.flyoutMode = true;
    this.cancelHideTimer();
    panel.classList.add('conn-sidebar--flyout');
    panel.style.position = 'fixed';
    panel.style.top = `${Math.round(r.bottom + 6)}px`;
    panel.style.left = '8px'; // hug the window's left edge with a small margin
    panel.style.height = ''; // CSS controls height (auto + max-height)
    panel.style.width = '';  // clear docked width so the flyout's CSS width applies
    const app = document.getElementById('app') || document.body;
    if (panel.parentElement !== app) app.appendChild(panel);
    panel.style.display = '';
    this.refresh();
  }

  /** Close the flyout after a short grace delay (cancelled if re-entered). */
  scheduleHideFlyout(): void {
    if (this._open || !this.flyoutMode) return;
    this.cancelHideTimer();
    this.hideTimer = window.setTimeout(() => this.hideFlyout(), 220);
  }

  private hideFlyout(): void {
    if (this._open) return;
    this.flyoutMode = false;
    this.cancelHideTimer();
    if (this.panel) {
      this.panel.classList.remove('conn-sidebar--flyout');
      this.panel.style.display = 'none';
    }
  }

  private cancelHideTimer(): void {
    if (this.hideTimer !== null) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
  }

  /** Re-render the connection list (after pin/group/connection changes). */
  refresh(): void {
    if (!this.listEl) return;
    renderSidebarList(this.listEl, this.groupHdrEl, this.query, {
      onSelect: (item) => { handleConnectionClick(item); if (this.flyoutMode) this.hideFlyout(); },
      refresh: () => this.refresh(),
      getSelectedKey: () => null,
    });
  }

  private build(): void {
    const panel = document.createElement('div');
    panel.className = 'home-side conn-sidebar';
    // Keep the flyout open while the cursor is inside it; close shortly after leaving.
    panel.addEventListener('mouseenter', () => this.cancelHideTimer());
    panel.addEventListener('mouseleave', () => this.scheduleHideFlyout());

    // Search (filters the list).
    const searchWrap = document.createElement('div');
    searchWrap.className = 'home-side-search';
    searchWrap.innerHTML = `<span class="home-side-search-icon"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/></svg></span>`;
    const searchInput = document.createElement('input');
    searchInput.className = 'home-side-search-input';
    searchInput.type = 'text';
    searchInput.placeholder = t('homeSearchPlaceholder');
    searchInput.id = 'home-search-input';
    searchWrap.appendChild(searchInput);
    panel.appendChild(searchWrap);

    panel.appendChild(makeNewButtons());

    // Crisp, fixed group-header slot (single-group mode) — kept above the feathered
    // list so the group name never fades. Hidden (display:none) when empty.
    const groupHdr = document.createElement('div');
    groupHdr.className = 'home-side-grouphdr';
    panel.appendChild(groupHdr);
    this.groupHdrEl = groupHdr;

    const listScroll = document.createElement('div');
    listScroll.className = 'home-side-list';
    // Scroll-aware feather: no top fade at the very top (first row stays crisp), no
    // bottom fade at the very bottom — the fades appear only where content is hidden.
    listScroll.addEventListener('scroll', () => {
      listScroll.classList.toggle('at-top', listScroll.scrollTop <= 0);
      listScroll.classList.toggle('at-bottom', listScroll.scrollTop + listScroll.clientHeight >= listScroll.scrollHeight - 1);
    }, { passive: true });
    createOverlayScrollbar({ viewport: listScroll, container: listScroll });
    panel.appendChild(listScroll);
    this.listEl = listScroll;

    const footer = document.createElement('div');
    footer.className = 'home-side-footer';
    footer.innerHTML = `<button class="home-side-settings" type="button" title="${t('settings')}"><span>${icon('settings')}</span><span>${t('settings')}</span></button>`
      + `<div class="home-side-links"><span class="conn-side-version">MeTerm</span><span class="home-dash-footer-sep">·</span><a class="home-dash-footer-link conn-side-github">GitHub</a><span class="home-dash-footer-sep">·</span><a class="home-dash-footer-link conn-side-gitee">Gitee</a></div>`;
    panel.appendChild(footer);

    // Wiring
    searchInput.addEventListener('input', () => {
      this.query = searchInput.value.trim();
      this.refresh();
    });
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        searchInput.value = '';
        this.query = '';
        this.refresh();
        searchInput.blur();
      }
    });

    (footer.querySelector('.home-side-settings') as HTMLButtonElement).onclick = () => {
      void import('./view-manager').then((m) => m.openSettings());
    };
    (footer.querySelector('.conn-side-github') as HTMLElement).onclick = (e) => { e.preventDefault(); openUrl(GITHUB_URL); };
    (footer.querySelector('.conn-side-gitee') as HTMLElement).onclick = (e) => { e.preventDefault(); openUrl(GITEE_URL); };
    getVersion().then((v) => {
      const el = footer.querySelector('.conn-side-version');
      if (el) el.textContent = t('homeFooterVersion').replace('{version}', v);
    }).catch(() => {});

    // Right-edge drag handle to resize the docked width (hidden in flyout mode via CSS).
    const resizer = document.createElement('div');
    resizer.className = 'conn-sidebar-resizer';
    resizer.addEventListener('mousedown', (e) => this.startResize(e, panel, resizer));
    panel.appendChild(resizer);

    this.panel = panel;
  }

  /** Drag the right edge to resize the docked sidebar; persists the new width. */
  private startResize(e: MouseEvent, panel: HTMLElement, resizer: HTMLElement): void {
    if (!this._open) return; // only resizable while docked (flyout hides the handle)
    e.preventDefault();
    const startX = e.clientX;
    const startW = panel.getBoundingClientRect().width;
    let latestW = startW;
    let raf = 0;
    resizer.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    const onMove = (ev: MouseEvent) => {
      latestW = clampWidth(startW + (ev.clientX - startX));
      if (!raf) {
        raf = requestAnimationFrame(() => {
          raf = 0;
          panel.style.width = `${latestW}px`;
          TerminalRegistry.resizeAll();
        });
      }
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      resizer.classList.remove('dragging');
      panel.style.width = `${latestW}px`;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      saveWidth(latestW);
      TerminalRegistry.resizeAll();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }
}

export const ConnectionSidebar = new ConnectionSidebarClass();
