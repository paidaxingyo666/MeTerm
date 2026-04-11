import { FileManager } from './file-manager';
import { type SysInfoResponse, type ServerInfoResponse, type NetIfaceInfo } from './protocol';
import type { TerminalTransport } from './terminal-transport';
import { loadSettings } from './themes';
import { t } from './i18n';
import { escapeHtml } from './status-bar';
import { jumpServerConfigMap } from './app-state';
import { setupContextMenu } from './drawer-context-menu';
import { showBookmarkPopup, addBookmark } from './file-bookmarks';
import { createOverlayScrollbar } from './overlay-scrollbar';
import {
  type NetRatePoint,
  handleServerInfoResponse,
  renderSysInfo,
} from './drawer-system-info';
import {
  setupResizeHandle,
  setupSplitHandle,
  saveDrawerLayout,
  updateHeight,
} from './drawer-layout';
import {
  setupBreadcrumb,
  setupKeyboardNav,
  setupFileSearch,
  showSpeedLimitPicker,
} from './drawer-file-features';

export type DrawerExecutorType = 'ssh' | 'local' | 'jumpserver';

export interface DrawerInstance {
  sessionId: string;
  executorType: DrawerExecutorType;
  element: HTMLDivElement;
  isOpen: boolean;
  height: number;
  fileManager: FileManager | null;
  sysInfoTimer: ReturnType<typeof setInterval> | null;
  processTimer: ReturnType<typeof setInterval> | null;
  activeTab: 'files' | 'processes';
  sysInfo: SysInfoResponse | null;
  prevNetIfaces: NetIfaceInfo[] | null;
  prevNetTimestamp: number;
  netHistory: Map<string, NetRatePoint[]>;
  selectedNic: string;
  serverConnectionInfo: { host: string; username: string; port: number } | null;
  isHistoryView: boolean;
}

class DrawerManagerClass {
  private drawers = new Map<string, DrawerInstance>();
  private readonly MIN_HEIGHT = 200;
  private readonly MAX_HEIGHT_RATIO = 0.5;
  /** Queued transports for sessions whose drawer hasn't been created yet */
  private pendingTransports = new Map<string, TerminalTransport>();
  /** Queued WebSockets for sessions whose drawer hasn't been created yet */
  private pendingWebSockets = new Map<string, WebSocket>();

  private readonly layoutConfig = { minHeight: this.MIN_HEIGHT, maxHeightRatio: this.MAX_HEIGHT_RATIO };
  private readonly layoutCallbacks = {
    updateHeight: (inst: DrawerInstance) => this.updateHeight(inst),
    saveDrawerLayout: (inst: DrawerInstance) => this.saveDrawerLayout(inst),
  };

  constructor() {
    window.addEventListener('resize', () => this.onWindowResize());
  }

  private onWindowResize(): void {
    const maxHeight = window.innerHeight * this.MAX_HEIGHT_RATIO;
    this.drawers.forEach((instance) => {
      if (!instance.isOpen) return;
      if (instance.height > maxHeight) {
        instance.height = maxHeight;
        this.updateHeight(instance);
        this.saveDrawerLayout(instance);
      }
    });
  }

  create(sessionId: string, executorType: string): DrawerInstance {
    if (this.drawers.has(sessionId)) {
      return this.drawers.get(sessionId)!;
    }

    const drawer = this.createDrawerElement(sessionId);
    const listElement = drawer.querySelector(`#file-list-${sessionId}`) as HTMLElement;
    const pathInput = drawer.querySelector('.path-input') as HTMLInputElement;
    const loadingOverlay = drawer.querySelector(`#file-loading-${sessionId}`) as HTMLElement;
    const loadingProgressBar = drawer.querySelector(`#loading-progress-${sessionId}`) as HTMLElement;
    const fileManager = new FileManager(sessionId, listElement, pathInput, loadingOverlay, loadingProgressBar);

    const settings = loadSettings();
    const savedHeight = settings.rememberDrawerLayout && settings.drawerHeight > 0
      ? settings.drawerHeight
      : 0.4 * window.innerHeight;

    const resolvedType: DrawerExecutorType =
      jumpServerConfigMap.has(sessionId) ? 'jumpserver' :
      (executorType === 'ssh' ? 'ssh' : 'local');

    const instance: DrawerInstance = {
      sessionId,
      executorType: resolvedType,
      element: drawer,
      isOpen: false,
      height: savedHeight,
      fileManager,
      sysInfoTimer: null,
      processTimer: null,
      activeTab: 'files',
      sysInfo: null,
      prevNetIfaces: null,
      prevNetTimestamp: 0,
      netHistory: new Map(),
      selectedNic: '',
      serverConnectionInfo: null,
      isHistoryView: false,
    };

    // 恢复 sidebar 宽度
    if (settings.rememberDrawerLayout && settings.drawerSidebarWidth > 0) {
      const sidebar = drawer.querySelector('.drawer-sidebar') as HTMLDivElement;
      if (sidebar) {
        sidebar.style.width = `${settings.drawerSidebarWidth}px`;
      }
    }

    // Set up server info callback
    fileManager.onServerInfo = (data: ServerInfoResponse) => {
      this.handleServerInfoResponse(instance, data);
    };

    this.drawers.set(sessionId, instance);
    this.setupResizeHandle(instance);
    this.setupSplitHandle(instance);
    this.setupToggleButton(instance);
    this.setupFileManagerEvents(instance);
    this.setupMainTabs(instance);
    this.setupSmoothScroll(instance);
    this.setupSidebarResize(instance);

    // Attach overlay scrollbar (inline mode: scrollbar inside each scroll area)
    // Skip sidebar — compact mode hides scrollbar via CSS
    for (const sel of ['.file-list', '.process-list', '.transfer-history']) {
      const el = drawer.querySelector(sel) as HTMLElement | null;
      if (!el) continue;
      // .file-list / .process-list 内部有 sticky thead,scrollbar 需要从 thead 下方开始
      // 否则 thumb 会叠在表头上
      const tableEl = el.querySelector('table') as HTMLElement | null;
      const topOffset = tableEl
        ? () => (tableEl.querySelector('thead') as HTMLElement | null)?.offsetHeight || 0
        : undefined;
      createOverlayScrollbar({ viewport: el, container: el, topOffset });
    }

    // JumpServer：Koko 代理不支持 exec session，隐藏系统信息侧栏和进程 tab
    if (resolvedType === 'jumpserver') {
      const sidebar = drawer.querySelector('.drawer-sidebar') as HTMLElement;
      const splitHandle = drawer.querySelector('.drawer-split-handle') as HTMLElement;
      const processTab = drawer.querySelector('[data-tab="processes"]') as HTMLElement;
      if (sidebar) sidebar.style.display = 'none';
      if (splitHandle) splitHandle.style.display = 'none';
      if (processTab) processTab.style.display = 'none';
    }

    // 本地会话：隐藏系统信息侧栏和进程 tab（本地不支持 exec/sysinfo）
    if (resolvedType === 'local') {
      const sidebar = drawer.querySelector('.drawer-sidebar') as HTMLElement;
      const splitHandle = drawer.querySelector('.drawer-split-handle') as HTMLElement;
      const sidebarToggle = drawer.querySelector('.btn-toggle-sidebar') as HTMLElement;
      const processTab = drawer.querySelector('[data-tab="processes"]') as HTMLElement;
      if (sidebar) sidebar.style.display = 'none';
      if (splitHandle) splitHandle.style.display = 'none';
      if (sidebarToggle) sidebarToggle.style.display = 'none';
      if (processTab) processTab.style.display = 'none';
    }

    // 消费 pending transport/websocket（解决创建顺序问题）
    const pendingTransport = this.pendingTransports.get(sessionId);
    if (pendingTransport) {
      this.pendingTransports.delete(sessionId);
      fileManager.setTransport(pendingTransport);
      this._afterConnect(sessionId, instance);
    }
    const pendingWs = this.pendingWebSockets.get(sessionId);
    if (pendingWs) {
      this.pendingWebSockets.delete(sessionId);
      fileManager.setWebSocket(pendingWs);
      this._afterConnect(sessionId, instance);
    }

    return instance;
  }

  private createDrawerElement(sessionId: string): HTMLDivElement {
    const drawer = document.createElement('div');
    drawer.className = 'file-drawer';
    drawer.dataset.sessionId = sessionId;

    drawer.innerHTML = `
      <div class="drawer-resize-handle"></div>
      <div class="drawer-content">
        <div class="drawer-sidebar">
          <div class="server-info" id="server-info-${sessionId}">
            <div class="server-info-loading">${t('serverInfoLoading')}</div>
          </div>
        </div>
        <div class="drawer-split-handle"></div>
        <div class="drawer-main">
          <div class="file-loading-overlay" id="file-loading-${sessionId}" style="display: none;">
            <div class="loading-content">
              <div class="loading-spinner"></div>
              <div class="loading-text">加载中...</div>
              <div class="loading-progress-container">
                <div class="loading-progress-bar" id="loading-progress-${sessionId}"></div>
              </div>
            </div>
          </div>
          <div class="file-disconnect-overlay" id="file-disconnect-${sessionId}" style="display: none;">
            <div class="loading-content">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.5;margin-bottom:8px">
                <line x1="1" y1="1" x2="23" y2="23"/><path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"/><path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"/><path d="M10.71 5.05A16 16 0 0 1 22.56 9"/><path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/>
              </svg>
              <div class="loading-text">连接已断开</div>
              <div style="font-size:12px;opacity:0.6;margin-top:4px">正在重连...</div>
            </div>
          </div>
          <div class="file-toolbar">
            <div class="drawer-main-tabs">
              <button class="drawer-tab btn-toggle-sidebar" title="${t('serverInfoToggle')}">
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="2" width="14" height="12" rx="2"/><line x1="6" y1="2" x2="6" y2="14"/><circle cx="3.5" cy="6" r="0.5" fill="currentColor" stroke="none"/><circle cx="3.5" cy="8" r="0.5" fill="currentColor" stroke="none"/><circle cx="3.5" cy="10" r="0.5" fill="currentColor" stroke="none"/></svg>
              </button>
              <button class="drawer-tab btn-switch-mode active" data-tab="files" title="Switch view">
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="2" width="14" height="12" rx="2"/><line x1="5.5" y1="2" x2="5.5" y2="14"/></svg>
              </button>
              <button class="drawer-tab" data-tab="processes" title="${t('drawerTabProcesses')}">
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="12" height="12" rx="2"/><line x1="5" y1="6" x2="11" y2="6"/><line x1="5" y1="8.5" x2="9" y2="8.5"/><line x1="5" y1="11" x2="7" y2="11"/></svg>
              </button>
            </div>
            <div class="file-toolbar-actions" data-tab-content="files">
              <button class="btn-back" title="返回上一层">
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M10 13l-5-5 5-5"/>
                </svg>
              </button>
              <div class="path-input-wrapper">
                <div class="breadcrumb"></div>
                <input class="path-input" value="/" placeholder="路径" />
                <div class="path-autocomplete"></div>
              </div>
              <button class="btn-go" title="进入目录">
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M6 13l5-5-5-5"/>
                </svg>
              </button>
              <button class="btn-refresh" title="刷新">
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M14 8a6 6 0 1 1-1.76-4.24M14 2v4h-4"/>
                </svg>
              </button>
              <button class="btn-upload" title="上传">
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M8 13V3M4 7l4-4 4 4"/>
                </svg>
              </button>
              <button class="btn-bookmark" title="书签">
                <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M3 1h10a1 1 0 0 1 1 1v13l-6-3-6 3V2a1 1 0 0 1 1-1z"/>
                </svg>
              </button>
              <button class="btn-history" title="上传下载历史" style="margin-left: auto;">
                <svg class="history-icon-horizontal" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2">
                  <line x1="2" y1="4" x2="14" y2="4"/>
                  <line x1="2" y1="8" x2="14" y2="8"/>
                  <line x1="2" y1="12" x2="14" y2="12"/>
                </svg>
                <svg class="history-icon-vertical" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" style="display: none;">
                  <line x1="4" y1="2" x2="4" y2="14"/>
                  <line x1="8" y1="2" x2="8" y2="14"/>
                  <line x1="12" y1="2" x2="12" y2="14"/>
                </svg>
              </button>
            </div>
            <div class="file-toolbar-actions" data-tab-content="processes" style="display:none;">
              <button class="btn-refresh-processes" title="刷新进程列表">
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M14 8a6 6 0 1 1-1.76-4.24M14 2v4h-4"/>
                </svg>
              </button>
            </div>
          </div>
          <div class="file-list" data-tab-content="files">
            <div class="file-search-bar" style="display:none;">
              <svg class="file-search-icon" width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M11.5 7a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0zm-.82 4.74a6 6 0 1 1 1.06-1.06l3.04 3.04-1.06 1.06-3.04-3.04z" fill="currentColor"/></svg>
              <input class="file-search-input" type="text" placeholder="搜索文件..." spellcheck="false" />
            </div>
            <table id="file-table-${sessionId}">
              <thead>
                <tr>
                  <th data-column="name" class="sortable" style="width:40%">
                    <span>名称</span>
                    <span class="sort-arrows">
                      <svg class="sort-arrow sort-asc" width="10" height="6" viewBox="0 0 10 6" fill="currentColor">
                        <path d="M5 0L0 6h10z"/>
                      </svg>
                      <svg class="sort-arrow sort-desc" width="10" height="6" viewBox="0 0 10 6" fill="currentColor">
                        <path d="M5 6L10 0H0z"/>
                      </svg>
                    </span>
                    <div class="column-resizer"></div>
                  </th>
                  <th data-column="size" class="sortable" style="width:12%">
                    <span>大小</span>
                    <span class="sort-arrows">
                      <svg class="sort-arrow sort-asc" width="10" height="6" viewBox="0 0 10 6" fill="currentColor">
                        <path d="M5 0L0 6h10z"/>
                      </svg>
                      <svg class="sort-arrow sort-desc" width="10" height="6" viewBox="0 0 10 6" fill="currentColor">
                        <path d="M5 6L10 0H0z"/>
                      </svg>
                    </span>
                    <div class="column-resizer"></div>
                  </th>
                  <th data-column="mtime" class="sortable" style="width:22%">
                    <span>修改时间</span>
                    <span class="sort-arrows">
                      <svg class="sort-arrow sort-asc" width="10" height="6" viewBox="0 0 10 6" fill="currentColor">
                        <path d="M5 0L0 6h10z"/>
                      </svg>
                      <svg class="sort-arrow sort-desc" width="10" height="6" viewBox="0 0 10 6" fill="currentColor">
                        <path d="M5 6L10 0H0z"/>
                      </svg>
                    </span>
                    <div class="column-resizer"></div>
                  </th>
                  <th data-column="owner" class="sortable" style="width:14%">
                    <span>用户/组</span>
                    <span class="sort-arrows">
                      <svg class="sort-arrow sort-asc" width="10" height="6" viewBox="0 0 10 6" fill="currentColor">
                        <path d="M5 0L0 6h10z"/>
                      </svg>
                      <svg class="sort-arrow sort-desc" width="10" height="6" viewBox="0 0 10 6" fill="currentColor">
                        <path d="M5 6L10 0H0z"/>
                      </svg>
                    </span>
                    <div class="column-resizer"></div>
                  </th>
                  <th data-column="mode" style="width:12%"><span>权限</span></th>
                </tr>
              </thead>
              <tbody id="file-list-${sessionId}">
              </tbody>
            </table>
          </div>
          <div class="file-status-bar" id="file-status-bar-${sessionId}"></div>
          <div class="process-list" data-tab-content="processes" style="display: none;">
            <table class="process-table" id="process-table-${sessionId}">
              <thead>
                <tr>
                  <th style="width:10%">${t('processColPID')}</th>
                  <th style="width:36%">${t('processColName')}</th>
                  <th style="width:14%">${t('processColUser')}</th>
                  <th style="width:12%">${t('processColCPU')}</th>
                  <th style="width:12%">${t('processColMem')}</th>
                  <th style="width:16%">${t('processColTime')}</th>
                </tr>
              </thead>
              <tbody id="process-list-${sessionId}">
              </tbody>
            </table>
          </div>
          <div class="transfer-history" id="transfer-history-${sessionId}" style="display: none;">
            <div class="history-toolbar">
              <div class="history-search-wrapper">
                <svg class="history-search-icon" width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M11.5 7a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0zm-.82 4.74a6 6 0 1 1 1.06-1.06l3.04 3.04-1.06 1.06-3.04-3.04z" fill="currentColor"/></svg>
                <input class="history-search-input" type="text" placeholder="搜索..." />
              </div>
              <div class="history-filter-group" data-group="type">
                <button class="btn-filter" data-filter="upload" title="仅上传">↑</button>
                <button class="btn-filter" data-filter="download" title="仅下载">↓</button>
              </div>
              <div class="history-filter-group" data-group="status">
                <button class="btn-filter" data-filter="active" title="进行中">进行中</button>
                <button class="btn-filter" data-filter="completed" title="已完成">完成</button>
                <button class="btn-filter" data-filter="failed" title="失败">失败</button>
              </div>
              <button class="btn-speed-limit" title="限速控制">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="6.5"/><path d="M8 4v4l3 2"/></svg>
              </button>
              <button class="btn-clear-history" title="清空历史记录">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M5 2V1h6v1h4v1H1V2h4zm1 3v8h1V5H6zm3 0v8h1V5H9zM2 4l1 11h10l1-11H2z" fill="currentColor"/></svg>
              </button>
            </div>
            <div class="history-list" id="history-list-${sessionId}">
              <!-- 历史记录将在这里动态插入 -->
            </div>
          </div>
        </div>
      </div>
      <button class="drawer-toggle">
        <svg width="16" height="16" viewBox="0 0 16 16">
          <path d="M8 4l-4 4h8z" fill="currentColor"/>
        </svg>
      </button>
    `;

    return drawer;
  }

  private setupMainTabs(instance: DrawerInstance): void {
    const tabBtns = instance.element.querySelectorAll('.drawer-tab[data-tab]');
    tabBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const tab = (btn as HTMLElement).dataset.tab as 'files' | 'processes';
        this.switchTab(instance, tab);
      });
    });

    // Toggle system info sidebar visibility
    // Default: sidebar hidden
    const defaultSidebar = instance.element.querySelector('.drawer-sidebar') as HTMLElement;
    const defaultSplitHandle = instance.element.querySelector('.drawer-split-handle') as HTMLElement;
    if (defaultSidebar) defaultSidebar.style.display = 'none';
    if (defaultSplitHandle) defaultSplitHandle.style.display = 'none';

    const toggleSidebarBtn = instance.element.querySelector('.btn-toggle-sidebar') as HTMLButtonElement;
    if (toggleSidebarBtn) {
      toggleSidebarBtn.addEventListener('click', () => {
        const sidebar = instance.element.querySelector('.drawer-sidebar') as HTMLElement;
        const splitHandle = instance.element.querySelector('.drawer-split-handle') as HTMLElement;
        if (!sidebar) return;
        const hidden = sidebar.style.display === 'none';
        sidebar.style.display = hidden ? '' : 'none';
        if (splitHandle) splitHandle.style.display = hidden ? '' : 'none';
        toggleSidebarBtn.classList.toggle('active', hidden);
      });
    }

    // Refresh processes button
    const refreshProcessBtn = instance.element.querySelector('.btn-refresh-processes');
    if (refreshProcessBtn) {
      refreshProcessBtn.addEventListener('click', () => {
        instance.fileManager?.requestServerInfo('processes');
      });
    }
  }

  private setupSmoothScroll(instance: DrawerInstance): void {
    const selectors = ['.file-list', '.process-list', '.transfer-history'];
    const factor = 0.35; // reduce scroll speed to ~35%

    const applySmooth = (container: HTMLElement) => {
      container.addEventListener('wheel', (e: WheelEvent) => {
        e.preventDefault();
        container.scrollTop += e.deltaY * factor;
      }, { passive: false });
    };

    // Apply to already-existing containers
    for (const sel of selectors) {
      const el = instance.element.querySelector(sel) as HTMLElement | null;
      if (el) applySmooth(el);
    }

    // Observe for dynamically added containers
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          for (const sel of selectors) {
            const cls = sel.slice(1); // remove leading '.'
            if (node.classList.contains(cls)) {
              applySmooth(node);
            }
            node.querySelectorAll<HTMLElement>(sel).forEach(applySmooth);
          }
        }
      }
    });
    observer.observe(instance.element, { childList: true, subtree: true });
  }

  /** Watch sidebar width changes to toggle compact/expanded server info */
  private setupSidebarResize(instance: DrawerInstance): void {
    const sidebar = instance.element.querySelector('.drawer-sidebar') as HTMLElement;
    if (!sidebar) return;
    let lastCompact: boolean | null = null;
    const ro = new ResizeObserver(() => {
      const isCompact = sidebar.offsetWidth < 104;
      sidebar.classList.toggle('sidebar-compact', isCompact);
      if (isCompact !== lastCompact && instance.sysInfo) {
        lastCompact = isCompact;
        renderSysInfo(instance);
      }
    });
    ro.observe(sidebar);
  }

  private switchTab(instance: DrawerInstance, tab: 'files' | 'processes'): void {
    instance.activeTab = tab;

    // Update tab button states
    const tabBtns = instance.element.querySelectorAll('.drawer-tab');
    tabBtns.forEach(btn => {
      const btnTab = (btn as HTMLElement).dataset.tab;
      btn.classList.toggle('active', btnTab === tab);
    });

    // Show/hide tab content
    const allContents = instance.element.querySelectorAll('[data-tab-content]');
    allContents.forEach(el => {
      const contentTab = (el as HTMLElement).dataset.tabContent;
      (el as HTMLElement).style.display = contentTab === tab ? '' : 'none';
    });

    // Also hide transfer history, file status bar, and reset history button state when switching tabs
    instance.isHistoryView = false;
    const historyContainer = instance.element.querySelector('.transfer-history') as HTMLElement;
    if (historyContainer) historyContainer.style.display = 'none';
    const fileListContainer = instance.element.querySelector('.file-list') as HTMLElement;
    if (fileListContainer && tab === 'files') fileListContainer.style.display = 'block';
    const fileStatusBar = instance.element.querySelector('.file-status-bar') as HTMLElement;
    if (fileStatusBar) fileStatusBar.style.display = tab === 'files' ? '' : 'none';
    const historyBtn = instance.element.querySelector('.btn-history') as HTMLElement;
    if (historyBtn) {
      historyBtn.classList.remove('active');
      const horizontalIcon = historyBtn.querySelector('.history-icon-horizontal') as SVGElement;
      const verticalIcon = historyBtn.querySelector('.history-icon-vertical') as SVGElement;
      if (horizontalIcon && verticalIcon) {
        horizontalIcon.style.display = 'inline';
        verticalIcon.style.display = 'none';
      }
    }

    // Start/stop process refresh
    if (tab === 'processes') {
      instance.fileManager?.requestServerInfo('processes');
      this.startProcessRefresh(instance);
    } else {
      this.stopProcessRefresh(instance);
    }
  }

  private startSysInfoRefresh(instance: DrawerInstance): void {
    if (instance.sysInfoTimer) return;
    instance.fileManager?.requestServerInfo('sysinfo');
    instance.sysInfoTimer = setInterval(() => {
      instance.fileManager?.requestServerInfo('sysinfo');
    }, 5000);
  }

  private stopSysInfoRefresh(instance: DrawerInstance): void {
    if (instance.sysInfoTimer) {
      clearInterval(instance.sysInfoTimer);
      instance.sysInfoTimer = null;
    }
  }

  private startProcessRefresh(instance: DrawerInstance): void {
    if (instance.processTimer) return;
    instance.processTimer = setInterval(() => {
      instance.fileManager?.requestServerInfo('processes');
    }, 5000);
  }

  private stopProcessRefresh(instance: DrawerInstance): void {
    if (instance.processTimer) {
      clearInterval(instance.processTimer);
      instance.processTimer = null;
    }
  }

  private handleServerInfoResponse(instance: DrawerInstance, data: ServerInfoResponse): void {
    handleServerInfoResponse(instance, data);
  }

  private setupToggleButton(instance: DrawerInstance): void {
    const toggleBtn = instance.element.querySelector('.drawer-toggle') as HTMLButtonElement;
    toggleBtn.onclick = () => this.toggle(instance.sessionId);
  }

  private setupFileManagerEvents(instance: DrawerInstance): void {
    if (!instance.fileManager) return;

    // Switch mode button (drawer ↔ sidebar)
    const switchModeBtn = instance.element.querySelector('.btn-switch-mode') as HTMLButtonElement;
    if (switchModeBtn) {
      switchModeBtn.addEventListener('click', () => {
        import('./file-manager-toggle').then(({ switchFileManagerMode }) => {
          switchFileManagerMode(instance.sessionId);
        });
      });
    }

    const pathInput = instance.element.querySelector('.path-input') as HTMLInputElement;
    const backBtn = instance.element.querySelector('.btn-back') as HTMLButtonElement;
    const goBtn = instance.element.querySelector('.btn-go') as HTMLButtonElement;
    const refreshBtn = instance.element.querySelector('.btn-refresh') as HTMLButtonElement;
    const uploadBtn = instance.element.querySelector('.btn-upload') as HTMLButtonElement;
    const historyBtn = instance.element.querySelector('.btn-history') as HTMLButtonElement;
    const listElement = instance.element.querySelector(`#file-list-${instance.sessionId}`) as HTMLElement;
    const fileListContainer = instance.element.querySelector('.file-list') as HTMLElement;
    const historyContainer = instance.element.querySelector('.transfer-history') as HTMLElement;

    // 本地会话隐藏传输历史按钮
    if (instance.executorType === 'local') {
      historyBtn.style.display = 'none';
    }

    // 历史视图状态和切换函数（提前声明，供其他按钮使用）
    const horizontalIcon = historyBtn.querySelector('.history-icon-horizontal') as SVGElement;
    const verticalIcon = historyBtn.querySelector('.history-icon-vertical') as SVGElement;

    const statusBar = instance.element.querySelector('.file-status-bar') as HTMLElement;

    const showFileList = () => {
      instance.isHistoryView = false;
      fileListContainer.style.display = 'block';
      historyContainer.style.display = 'none';
      if (statusBar) statusBar.style.display = '';
      historyBtn.classList.remove('active');
      if (horizontalIcon && verticalIcon) {
        horizontalIcon.style.display = 'inline';
        verticalIcon.style.display = 'none';
      }
      // 切回文件列表时刷新目录（上传/下载可能已改变文件）
      if (instance.fileManager) {
        instance.fileManager.loadDirectory(instance.fileManager.getCurrentPath()).catch(() => {});
      }
    };

    const showHistory = () => {
      instance.isHistoryView = true;
      fileListContainer.style.display = 'none';
      historyContainer.style.display = 'block';
      if (statusBar) statusBar.style.display = 'none';
      historyBtn.classList.add('active');
      if (horizontalIcon && verticalIcon) {
        horizontalIcon.style.display = 'none';
        verticalIcon.style.display = 'inline';
      }
      if (instance.fileManager) {
        instance.fileManager.renderTransferHistory();
      }
    };

    // 筛选按钮组 — 类型筛选（toggle：再次点击取消）
    const typeFilterGroup = instance.element.querySelector('.history-filter-group[data-group="type"]');
    if (typeFilterGroup) {
      typeFilterGroup.addEventListener('click', (e) => {
        const btn = (e.target as HTMLElement).closest('.btn-filter') as HTMLElement | null;
        if (!btn || !instance.fileManager) return;
        const isActive = btn.classList.contains('active');
        typeFilterGroup.querySelectorAll('.btn-filter').forEach(b => b.classList.remove('active'));
        if (isActive) {
          instance.fileManager.setTransferFilter(null);
        } else {
          btn.classList.add('active');
          instance.fileManager.setTransferFilter(btn.dataset.filter as 'upload' | 'download');
        }
      });
    }

    // 筛选按钮组 — 状态筛选（toggle：再次点击取消）
    const statusFilterGroup = instance.element.querySelector('.history-filter-group[data-group="status"]');
    if (statusFilterGroup) {
      statusFilterGroup.addEventListener('click', (e) => {
        const btn = (e.target as HTMLElement).closest('.btn-filter') as HTMLElement | null;
        if (!btn || !instance.fileManager) return;
        const isActive = btn.classList.contains('active');
        statusFilterGroup.querySelectorAll('.btn-filter').forEach(b => b.classList.remove('active'));
        if (isActive) {
          instance.fileManager.setTransferStatusFilter(null);
        } else {
          btn.classList.add('active');
          instance.fileManager.setTransferStatusFilter(btn.dataset.filter as 'active' | 'completed' | 'failed');
        }
      });
    }

    // 搜索框
    const searchInput = instance.element.querySelector('.history-search-input') as HTMLInputElement | null;
    if (searchInput) {
      let searchTimer: ReturnType<typeof setTimeout> | null = null;
      searchInput.addEventListener('input', () => {
        if (searchTimer) clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
          if (instance.fileManager) {
            instance.fileManager.setTransferSearchQuery(searchInput.value.trim());
          }
        }, 200);
      });
    }

    // 限速按钮
    const speedLimitBtn = instance.element.querySelector('.btn-speed-limit') as HTMLButtonElement;
    if (speedLimitBtn) {
      speedLimitBtn.addEventListener('click', () => {
        showSpeedLimitPicker(speedLimitBtn, instance);
      });
    }

    // 清空历史按钮
    const clearHistoryBtn = instance.element.querySelector('.btn-clear-history') as HTMLButtonElement;
    if (clearHistoryBtn) {
      clearHistoryBtn.addEventListener('click', () => {
        if (instance.fileManager) {
          instance.fileManager.clearTransferHistory();
        }
      });
    }

    // 返回上一层按钮
    backBtn.addEventListener('click', async () => {
      if (instance.isHistoryView) { showFileList(); return; }
      if (!instance.fileManager) return;
      try {
        const currentPath = instance.fileManager.getCurrentPath();
        if (!currentPath || currentPath === '/') return;
        const cleanPath = currentPath.replace(/\/$/, '');
        const lastSlashIndex = cleanPath.lastIndexOf('/');
        const parentPath = lastSlashIndex > 0
          ? cleanPath.substring(0, lastSlashIndex)
          : '/';
        await instance.fileManager.loadDirectory(parentPath);
      } catch (err) {
        console.error('返回上一层失败:', err);
      }
    });

    // 进入目录按钮
    goBtn.addEventListener('click', async () => {
      if (instance.isHistoryView) { showFileList(); return; }
      if (!instance.fileManager) return;
      try {
        const targetPath = pathInput.value.trim();
        if (targetPath) {
          await instance.fileManager.loadDirectory(targetPath);
        }
      } catch (err) {
        console.error('进入目录失败:', err);
      }
    });

    // 初始化路径自动补全
    if (instance.fileManager) {
      instance.fileManager.setupPathAutocomplete();
    }

    // 路径输入框回车
    pathInput.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter') {
        // 自动补全选中项时由补全处理，不跳转
        if (instance.fileManager?.isAutocompleteOpen()) return;
        if (instance.isHistoryView) { showFileList(); return; }
        if (!instance.fileManager) return;
        try {
          const targetPath = pathInput.value.trim();
          if (targetPath) {
            instance.fileManager.hideAutocomplete();
            await instance.fileManager.loadDirectory(targetPath);
          }
        } catch (err) {
          console.error('进入目录失败:', err);
        }
      }
    });

    // 刷新按钮
    refreshBtn.addEventListener('click', async () => {
      if (instance.isHistoryView) { showFileList(); return; }
      if (!instance.fileManager) return;
      try {
        await instance.fileManager.loadDirectory(instance.fileManager.getCurrentPath());
      } catch (err) {
        console.error('刷新失败:', err);
      }
    });

    // 上传按钮（本地会话不可用）
    if (instance.executorType === 'local') {
      uploadBtn.disabled = true;
      uploadBtn.title = '本地会话不支持上传';
    } else {
      uploadBtn.addEventListener('click', () => {
        if (instance.isHistoryView) { showFileList(); return; }
        if (instance.fileManager) {
          instance.fileManager.triggerUpload();
        }
      });
    }

    // 书签按钮
    const bookmarkBtn = instance.element.querySelector('.btn-bookmark') as HTMLButtonElement;
    if (bookmarkBtn) {
      bookmarkBtn.addEventListener('click', () => {
        if (instance.isHistoryView) { showFileList(); return; }
        const info = instance.serverConnectionInfo || { host: 'local', port: 0 };
        showBookmarkPopup(bookmarkBtn, info.host, info.port, (path) => {
          instance.fileManager?.loadDirectory(path);
        });
      });
    }

    // 历史按钮
    historyBtn.addEventListener('click', () => {
      if (instance.isHistoryView) {
        showFileList();
      } else {
        showHistory();
      }
    });

    // 右键菜单
    setupContextMenu(instance, listElement);

    // 设置拖拽上传
    const fileList = instance.element.querySelector('.file-list') as HTMLElement;
    if (fileList) {
      this.setupDragAndDrop(instance, fileList);
    }

    // 面包屑导航
    setupBreadcrumb(instance, pathInput);

    // 文件搜索/过滤
    const toggleSearchBar = setupFileSearch(instance, listElement);

    // 键盘导航
    setupKeyboardNav(instance, listElement, fileListContainer, backBtn, toggleSearchBar);

    // 点击文件列表区域时 focus 表格，使键盘导航生效
    const fileTable = instance.element.querySelector(`#file-table-${instance.sessionId}`) as HTMLElement;
    if (fileTable) {
      fileListContainer.addEventListener('click', () => fileTable.focus());
    }
  }

  private setupDragAndDrop(instance: DrawerInstance, dropZone: HTMLElement): void {
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
      dropZone.addEventListener(eventName, (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
    });

    ['dragenter', 'dragover'].forEach(eventName => {
      dropZone.addEventListener(eventName, () => {
        dropZone.classList.add('drag-over');
      });
    });

    ['dragleave', 'drop'].forEach(eventName => {
      dropZone.addEventListener(eventName, () => {
        dropZone.classList.remove('drag-over');
      });
    });

    dropZone.addEventListener('drop', (e: DragEvent) => {
      const files = e.dataTransfer?.files;
      if (!files || files.length === 0 || !instance.fileManager) {
        return;
      }

      const fileList = Array.from(files);
      const fm = instance.fileManager;
      void (async () => {
        const { readFile } = await import('@tauri-apps/plugin-fs');
        for (const file of fileList) {
          try {
            const localPath = (file as any).path as string | undefined;
            let content: Uint8Array;
            if (localPath) {
              content = await readFile(localPath);
            } else {
              content = new Uint8Array(await file.arrayBuffer());
            }
            await fm.uploadFile(file.name, content, undefined, true);
          } catch (err) {
            console.error(`上传 ${file.name} 失败:`, err);
          }
        }
      })();
    });
  }

  private setupResizeHandle(instance: DrawerInstance): void {
    setupResizeHandle(instance, this.layoutConfig, this.layoutCallbacks);
  }

  private setupSplitHandle(instance: DrawerInstance): void {
    setupSplitHandle(instance, this.layoutCallbacks);
  }

  private saveDrawerLayout(instance: DrawerInstance): void {
    saveDrawerLayout(instance);
  }

  toggle(sessionId: string): void {
    const instance = this.drawers.get(sessionId);
    if (!instance) return;

    instance.isOpen = !instance.isOpen;
    if (instance.isOpen) {
      instance.element.style.display = '';
      instance.element.classList.add('open');
      this.updateHeight(instance);
      this.startSysInfoRefresh(instance);
      // 通知 FileManager 全局监听器：当前活跃的 drag-drop 目标为此 drawer 的 fileManager
      FileManager.setActiveDragDropTarget(instance.fileManager ?? null);
      // 首次打开抽屉时加载文件列表（SSH 的 SFTP 后台初始化需要时间，延迟到打开时加载）
      if (instance.fileManager && instance.fileManager.getCurrentPath() === '/') {
        // SSH: '.' 解析为 SFTP home; local: '~' 由后端展开为 home 目录
        const initialPath = instance.executorType === 'local' ? '~' : '.';
        instance.fileManager.loadDirectory(initialPath);
      }
    } else {
      instance.element.classList.remove('open');
      instance.element.style.display = 'none';
      instance.element.style.setProperty('--drawer-height', '0px');
      // Flex layout handles terminal resizing — no manual padding needed
      import('./ai-capsule').then(({ AICapsuleManager }) => {
        AICapsuleManager.setDrawerOffset(sessionId, 0);
      });
      this.stopSysInfoRefresh(instance);
      this.stopProcessRefresh(instance);
      // 关闭 drawer 时清空 drag-drop 活跃目标
      FileManager.setActiveDragDropTarget(null);
    }
  }

  private updateHeight(instance: DrawerInstance): void {
    updateHeight(instance);
  }

  mountTo(sessionId: string, container: HTMLElement): void {
    const instance = this.drawers.get(sessionId);
    if (!instance) return;
    if (instance.element.parentElement !== container) {
      container.appendChild(instance.element);
    }
  }

  hideAll(): void {
    this.drawers.forEach((instance) => {
      instance.element.style.display = 'none';
    });
  }

  show(sessionId: string): void {
    const instance = this.drawers.get(sessionId);
    if (instance) {
      instance.element.style.display = '';
    }
  }

  has(sessionId: string): boolean {
    return this.drawers.has(sessionId);
  }

  isOpen(sessionId: string): boolean {
    return this.drawers.get(sessionId)?.isOpen ?? false;
  }

  /** Internal: expose DrawerInstance for SidebarManager */
  _getInstanceForSidebar(sessionId: string): DrawerInstance | null {
    return this.drawers.get(sessionId) ?? null;
  }

  /** Return session IDs of all currently open drawers. */
  getOpenSessionIds(): string[] {
    const ids: string[] = [];
    this.drawers.forEach((instance, sessionId) => {
      if (instance.isOpen) ids.push(sessionId);
    });
    return ids;
  }

  getDrawerHeight(sessionId: string): number {
    const instance = this.drawers.get(sessionId);
    if (!instance || !instance.isOpen) return 0;
    return instance.height;
  }

  notifyDisconnect(sessionId: string): void {
    const instance = this.drawers.get(sessionId);
    if (instance?.fileManager) {
      instance.fileManager.showDisconnected();
    }
  }

  destroy(sessionId: string): void {
    const instance = this.drawers.get(sessionId);
    if (!instance) return;
    this.stopSysInfoRefresh(instance);
    this.stopProcessRefresh(instance);
    instance.element.remove();
    this.drawers.delete(sessionId);
    this.pendingTransports.delete(sessionId);
    this.pendingWebSockets.delete(sessionId);
    // Notify sidebar to also destroy
    window.dispatchEvent(new CustomEvent('meterm-drawer-destroyed', { detail: { sessionId } }));
  }

  setWebSocket(sessionId: string, ws: WebSocket): void {
    const instance = this.drawers.get(sessionId);
    if (instance?.fileManager) {
      instance.fileManager.setWebSocket(ws);
      this._afterConnect(sessionId, instance);
    } else {
      // Drawer 尚未创建，存入 pending 队列
      this.pendingWebSockets.set(sessionId, ws);
    }
  }

  setTransport(sessionId: string, transport: TerminalTransport): void {
    const instance = this.drawers.get(sessionId);
    if (instance?.fileManager) {
      instance.fileManager.setTransport(transport);
      this._afterConnect(sessionId, instance);
    } else {
      // Drawer 尚未创建，存入 pending 队列
      this.pendingTransports.set(sessionId, transport);
    }
  }

  private _afterConnect(sessionId: string, instance: DrawerInstance): void {
    if (!instance.fileManager) return;
    // JumpServer 连接：自动进入唯一的资产子目录
    if (jumpServerConfigMap.has(sessionId)) {
      instance.fileManager.suppressListErrors = true;
      instance.fileManager.onFirstLoad = (files, _path) => {
        if (instance.fileManager) instance.fileManager.suppressListErrors = false;
        const dirs = files.filter(f => f.is_dir);
        if (dirs.length === 1) {
          instance.fileManager?.loadDirectory(dirs[0].name);
        }
      };
    }
    // 加载初始目录：底部抽屉打开时需要显示，侧边栏模式也需要（通过 onPathChanged 通知）
    if (instance.fileManager.getCurrentPath() === '/') {
      const initialPath = instance.executorType === 'local' ? '~' : '.';
      instance.fileManager.loadDirectory(initialPath);
    }
    // Notify sidebar that FileManager is connected
    window.dispatchEvent(new CustomEvent('meterm-fm-connected', { detail: { sessionId } }));
  }

  getServerInfo(sessionId: string): { host: string; username: string; port: number } | null {
    const instance = this.drawers.get(sessionId);
    return instance?.serverConnectionInfo || null;
  }

  /** Get the FileManager instance for a session (used by the AI agent
   *  to register upload/download transfers in the transfer list). */
  getFileManager(sessionId: string): import('./file-manager').FileManager | null {
    return this.drawers.get(sessionId)?.fileManager ?? null;
  }

  /** 获取 SSH 会话的文件管理器当前路径和文件名列表（供终端文件链接使用） */
  getRemoteDirEntries(sessionId: string): { cwd: string; names: Map<string, boolean> } | null {
    const instance = this.drawers.get(sessionId);
    if (!instance?.fileManager) return null;
    const cwd = instance.fileManager.getCurrentPath();
    const names = instance.fileManager.getFileNames();
    if (names.size === 0) return null;
    return { cwd, names };
  }

  updateServerInfo(sessionId: string, info: { host: string; username: string; port?: number }): void {
    const instance = this.drawers.get(sessionId);
    if (!instance) return;
    instance.serverConnectionInfo = { host: info.host, username: info.username, port: info.port || 22 };

    // Sync server label to transfer history for display/search
    if (instance.fileManager) {
      const port = info.port || 22;
      const label = port === 22 ? `${info.username}@${info.host}` : `${info.username}@${info.host}:${port}`;
      instance.fileManager.setServerLabel(label);
    }

    const serverInfoEl = instance.element.querySelector(`#server-info-${sessionId}`) as HTMLElement;
    if (serverInfoEl) {
      serverInfoEl.innerHTML = `
        <div class="server-info-conn">
          <div class="server-info-item">
            <div class="server-info-label">${t('serverInfoHost')}</div>
            <div class="server-info-value">${escapeHtml(info.host)}${info.port && info.port !== 22 ? ':' + info.port : ''}</div>
          </div>
          <div class="server-info-item">
            <div class="server-info-label">${t('serverInfoUser')}</div>
            <div class="server-info-value">${escapeHtml(info.username)}</div>
          </div>
        </div>
        <div class="server-info-loading">${t('serverInfoLoading')}</div>
      `;
    }
  }

  /**
   * 导航到指定路径（用于终端文件链接点击）。
   * 如果抽屉已打开，直接跳转；如果未打开，弹窗询问用户是否打开。
   */
  async navigateToPath(sessionId: string, dirPath: string): Promise<void> {
    const instance = this.drawers.get(sessionId);
    if (!instance) return;

    // Check if sidebar mode is active
    const { loadSettings } = await import('./themes');
    const mode = loadSettings().fileManagerMode;
    if (mode === 'sidebar') {
      // Delegate to SidebarManager
      const { SidebarManager } = await import('./file-sidebar');
      if (!SidebarManager.has(sessionId)) {
        SidebarManager.create(sessionId);
        const mainContent = document.getElementById('main-content');
        if (mainContent) SidebarManager.mountTo(sessionId, mainContent);
      }
      if (!SidebarManager.isOpen(sessionId)) {
        SidebarManager.toggle(sessionId);
      }
      // Navigate sidebar tree
      const { changeTreeRootPublic } = await import('./file-sidebar');
      changeTreeRootPublic(sessionId, dirPath);
      return;
    }

    // Drawer mode
    if (instance.isOpen) {
      instance.fileManager?.loadDirectory(dirPath);
    } else {
      this.toggle(sessionId);
      const filesTab = instance.element.querySelector('[data-tab="files"]') as HTMLElement;
      if (filesTab) filesTab.click();
      setTimeout(() => {
        instance.fileManager?.loadDirectory(dirPath);
      }, 200);
    }
  }

}

export const DrawerManager = new DrawerManagerClass();
