import { FileManager } from './file-manager';
import { MsgInput, type SysInfoResponse, type ServerInfoResponse, type NetIfaceInfo } from './protocol';
import { loadSettings } from './themes';
import { t } from './i18n';
import { escapeHtml } from './status-bar';
import { jumpServerConfigMap } from './app-state';
import { createOverlayScrollbar } from './overlay-scrollbar';
import {
  type NetRatePoint,
  handleServerInfoResponse,
} from './drawer-system-info';
import {
  setupResizeHandle,
  setupSplitHandle,
  saveDrawerLayout,
  updateHeight,
} from './drawer-layout';

export interface DrawerInstance {
  sessionId: string;
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

    const instance: DrawerInstance = {
      sessionId,
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

    // Attach overlay scrollbar (inline mode: scrollbar inside each scroll area)
    for (const sel of ['.drawer-sidebar', '.file-list', '.process-list', '.transfer-history']) {
      const el = drawer.querySelector(sel) as HTMLElement | null;
      if (el) createOverlayScrollbar({ viewport: el, container: el });
    }

    // JumpServer：Koko 代理不支持 exec session，隐藏系统信息侧栏和进程 tab
    if (jumpServerConfigMap.has(sessionId)) {
      const sidebar = drawer.querySelector('.drawer-sidebar') as HTMLElement;
      const splitHandle = drawer.querySelector('.drawer-split-handle') as HTMLElement;
      const processTab = drawer.querySelector('[data-tab="processes"]') as HTMLElement;
      if (sidebar) sidebar.style.display = 'none';
      if (splitHandle) splitHandle.style.display = 'none';
      if (processTab) processTab.style.display = 'none';
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
              <button class="drawer-tab active" data-tab="files">${t('drawerTabFiles')}</button>
              <button class="drawer-tab" data-tab="processes">${t('drawerTabProcesses')}</button>
            </div>
            <div class="file-toolbar-actions" data-tab-content="files">
              <button class="btn-back" title="返回上一层">
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M10 13l-5-5 5-5"/>
                </svg>
              </button>
              <div class="path-input-wrapper">
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
    const tabBtns = instance.element.querySelectorAll('.drawer-tab');
    tabBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const tab = (btn as HTMLElement).dataset.tab as 'files' | 'processes';
        this.switchTab(instance, tab);
      });
    });

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

    // Also hide transfer history and reset history button state when switching tabs
    instance.isHistoryView = false;
    const historyContainer = instance.element.querySelector('.transfer-history') as HTMLElement;
    if (historyContainer) historyContainer.style.display = 'none';
    const fileListContainer = instance.element.querySelector('.file-list') as HTMLElement;
    if (fileListContainer && tab === 'files') fileListContainer.style.display = 'block';
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

    const pathInput = instance.element.querySelector('.path-input') as HTMLInputElement;
    const backBtn = instance.element.querySelector('.btn-back') as HTMLButtonElement;
    const goBtn = instance.element.querySelector('.btn-go') as HTMLButtonElement;
    const refreshBtn = instance.element.querySelector('.btn-refresh') as HTMLButtonElement;
    const uploadBtn = instance.element.querySelector('.btn-upload') as HTMLButtonElement;
    const historyBtn = instance.element.querySelector('.btn-history') as HTMLButtonElement;
    const listElement = instance.element.querySelector(`#file-list-${instance.sessionId}`) as HTMLElement;
    const fileListContainer = instance.element.querySelector('.file-list') as HTMLElement;
    const historyContainer = instance.element.querySelector('.transfer-history') as HTMLElement;

    // 历史视图状态和切换函数（提前声明，供其他按钮使用）
    const horizontalIcon = historyBtn.querySelector('.history-icon-horizontal') as SVGElement;
    const verticalIcon = historyBtn.querySelector('.history-icon-vertical') as SVGElement;

    const showFileList = () => {
      instance.isHistoryView = false;
      fileListContainer.style.display = 'block';
      historyContainer.style.display = 'none';
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

    // 上传按钮
    uploadBtn.addEventListener('click', () => {
      if (instance.isHistoryView) { showFileList(); return; }
      if (instance.fileManager) {
        instance.fileManager.triggerUpload();
      }
    });

    // 历史按钮
    historyBtn.addEventListener('click', () => {
      if (instance.isHistoryView) {
        showFileList();
      } else {
        showHistory();
      }
    });

    // 右键菜单
    this.setupContextMenu(instance, listElement);

    // 设置拖拽上传
    const fileList = instance.element.querySelector('.file-list') as HTMLElement;
    if (fileList) {
      this.setupDragAndDrop(instance, fileList);
    }
  }

  private sendTerminalCommand(instance: DrawerInstance, command: string): void {
    const ws = instance.fileManager?.getWebSocket();
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    // Send Ctrl+U to clear current line, then the command + Enter
    const payload = new TextEncoder().encode('\x15' + command + '\n');
    const msg = new Uint8Array(1 + payload.length);
    msg[0] = MsgInput;
    msg.set(payload, 1);
    ws.send(msg);
  }

  private setupContextMenu(instance: DrawerInstance, listElement: HTMLElement): void {
    let contextMenu: HTMLDivElement | null = null;

    const closeMenu = () => {
      if (contextMenu) {
        contextMenu.remove();
        contextMenu = null;
      }
    };

    type MenuItem = {
      label: string;
      action?: () => void;
      danger?: boolean;
      separator?: boolean;
      children?: MenuItem[];
    };

    const buildMenu = (items: MenuItem[], parent: HTMLElement) => {
      items.forEach(item => {
        if (item.separator) {
          const sep = document.createElement('div');
          sep.className = 'context-menu-separator';
          parent.appendChild(sep);
          return;
        }

        const menuItem = document.createElement('div');
        menuItem.className = 'context-menu-item';
        if (item.danger) menuItem.classList.add('danger');

        if (item.children) {
          menuItem.classList.add('has-submenu');
          menuItem.innerHTML = `<span>${item.label}</span><span class="submenu-arrow">›</span>`;

          const submenu = document.createElement('div');
          submenu.className = 'context-menu context-submenu';
          buildMenu(item.children, submenu);
          menuItem.appendChild(submenu);

          // 子菜单边界检测
          menuItem.addEventListener('mouseenter', () => {
            const itemRect = menuItem.getBoundingClientRect();
            const subRect = submenu.getBoundingClientRect();
            const viewW = window.innerWidth;
            const viewH = window.innerHeight;

            if (itemRect.right + subRect.width > viewW) {
              submenu.style.left = 'auto';
              submenu.style.right = '100%';
            } else {
              submenu.style.left = '100%';
              submenu.style.right = 'auto';
            }

            if (itemRect.top + subRect.height > viewH) {
              submenu.style.top = 'auto';
              submenu.style.bottom = '0';
            }
          });
        } else {
          menuItem.textContent = item.label;
          menuItem.addEventListener('click', () => {
            item.action?.();
            closeMenu();
          });
        }

        parent.appendChild(menuItem);
      });
    };

    const createContextMenu = (x: number, y: number, fileName: string, isDir: boolean) => {
      closeMenu();

      const fm = instance.fileManager;
      if (!fm) return;

      const fullPath = fm.getFullPath(fileName);
      const escapedPath = fullPath.replace(/([ '"\\$`!#&|;(){}])/g, '\\$1');

      const items: MenuItem[] = [];

      // 下载
      items.push({
        label: isDir ? '下载文件夹' : '下载',
        action: () => (fm as any).downloadFile(fileName, isDir)
      });

      // 上传
      if (isDir) {
        items.push({
          label: '上传',
          children: [
            {
              label: '上传到此文件夹',
              action: () => fm.triggerUpload(fullPath)
            },
            {
              label: '上传到当前路径',
              action: () => fm.triggerUpload()
            }
          ]
        });
      } else {
        items.push({
          label: '上传',
          action: () => fm.triggerUpload()
        });
      }

      items.push({ separator: true, label: '' });

      // 新建
      items.push({
        label: '新建文件',
        action: () => this.showCreateFileDialog(instance)
      });
      items.push({
        label: '新建文件夹',
        action: () => this.showMkdirDialog(instance)
      });

      items.push({ separator: true, label: '' });

      // 复制路径 / 终端命令（子菜单）
      items.push({
        label: '复制路径',
        children: [
          {
            label: '复制绝对路径',
            action: () => navigator.clipboard.writeText(fullPath)
          },
          { separator: true, label: '' },
          {
            label: `cd ${isDir ? '' : '..'}`,
            action: () => {
              const dir = isDir ? escapedPath : escapedPath.substring(0, escapedPath.lastIndexOf('/')) || '/';
              this.sendTerminalCommand(instance, `cd ${dir}`);
            }
          },
          {
            label: isDir ? 'ls' : 'cat',
            action: () => {
              const cmd = isDir ? `ls -la ${escapedPath}` : `cat ${escapedPath}`;
              this.sendTerminalCommand(instance, cmd);
            }
          },
          {
            label: 'cp',
            action: () => {
              const cmd = isDir ? `cp -r ${escapedPath} ` : `cp ${escapedPath} `;
              const ws = instance.fileManager?.getWebSocket();
              if (!ws || ws.readyState !== WebSocket.OPEN) return;
              const payload = new TextEncoder().encode('\x15' + cmd);
              const msg = new Uint8Array(1 + payload.length);
              msg[0] = MsgInput;
              msg.set(payload, 1);
              ws.send(msg);
            }
          },
          {
            label: 'rm',
            action: () => {
              const cmd = isDir ? `rm -r ${escapedPath}` : `rm ${escapedPath}`;
              const ws = instance.fileManager?.getWebSocket();
              if (!ws || ws.readyState !== WebSocket.OPEN) return;
              const payload = new TextEncoder().encode('\x15' + cmd);
              const msg = new Uint8Array(1 + payload.length);
              msg[0] = MsgInput;
              msg.set(payload, 1);
              ws.send(msg);
            },
            danger: true
          }
        ]
      });

      items.push({ separator: true, label: '' });

      // 重命名 / 删除
      items.push({
        label: '重命名',
        action: () => this.showRenameDialog(instance, fileName)
      });
      items.push({
        label: '删除',
        action: () => this.showDeleteConfirm(instance, fileName, isDir),
        danger: true
      });

      contextMenu = document.createElement('div');
      contextMenu.className = 'context-menu';
      contextMenu.style.left = `${x}px`;
      contextMenu.style.top = `${y}px`;

      buildMenu(items, contextMenu);
      document.body.appendChild(contextMenu);

      // 边界检测
      const menuRect = contextMenu.getBoundingClientRect();
      const viewW = window.innerWidth;
      const viewH = window.innerHeight;

      if (x + menuRect.width > viewW) {
        contextMenu.style.left = `${Math.max(0, viewW - menuRect.width - 4)}px`;
      }
      if (y + menuRect.height > viewH) {
        contextMenu.style.top = `${Math.max(0, viewH - menuRect.height - 4)}px`;
      }

      // 点击外部关闭
      const onClickOutside = (e: MouseEvent) => {
        if (contextMenu && !contextMenu.contains(e.target as Node)) {
          closeMenu();
          document.removeEventListener('click', onClickOutside);
        }
      };
      setTimeout(() => document.addEventListener('click', onClickOutside), 0);
    };

    // 监听右键事件
    listElement.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const target = (e.target as HTMLElement).closest('tr') as HTMLTableRowElement;
      if (!target || !target.dataset.path) return;

      const fileName = target.dataset.path;
      const isDir = target.dataset.isDir === 'true';
      createContextMenu(e.clientX, e.clientY, fileName, isDir);
    });
  }

  private async showCreateFileDialog(instance: DrawerInstance): Promise<void> {
    const container = instance.element.querySelector('.drawer-content') as HTMLElement || instance.element;
    const fileName = await this.showModal({
      title: '新建文件',
      input: { placeholder: '文件名称' },
      confirmText: '创建',
      container,
    });
    if (fileName && instance.fileManager) {
      await instance.fileManager.createFile(fileName);
    }
  }

  private showModal(options: {
    title: string;
    input?: { placeholder?: string; value?: string };
    confirmText?: string;
    cancelText?: string;
    danger?: boolean;
    container?: HTMLElement;
  }): Promise<string | null> {
    return new Promise((resolve) => {
      const container = options.container || document.body;
      container.querySelector('.drawer-modal-overlay')?.remove();

      const overlay = document.createElement('div');
      overlay.className = 'drawer-modal-overlay';

      const hasInput = !!options.input;
      overlay.innerHTML = `
        <div class="drawer-modal">
          <div class="drawer-modal-title">${options.title}</div>
          ${hasInput ? `<input class="drawer-modal-input" type="text" value="${(options.input!.value || '').replace(/"/g, '&quot;')}" placeholder="${options.input!.placeholder || ''}" spellcheck="false" />` : ''}
          <div class="drawer-modal-buttons">
            <button class="drawer-modal-btn cancel">${options.cancelText || '取消'}</button>
            <button class="drawer-modal-btn confirm${options.danger ? ' danger' : ''}">${options.confirmText || '确定'}</button>
          </div>
        </div>
      `;

      container.appendChild(overlay);

      const input = overlay.querySelector('.drawer-modal-input') as HTMLInputElement | null;
      const confirmBtn = overlay.querySelector('.drawer-modal-btn.confirm') as HTMLButtonElement;
      const cancelBtn = overlay.querySelector('.drawer-modal-btn.cancel') as HTMLButtonElement;

      const close = (value: string | null) => {
        overlay.remove();
        resolve(value);
      };

      if (input) {
        input.focus();
        input.select();
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') close(input.value);
          if (e.key === 'Escape') close(null);
        });
      }

      confirmBtn.addEventListener('click', () => close(hasInput ? input!.value : ''));
      cancelBtn.addEventListener('click', () => close(null));
    });
  }

  private async showDeleteConfirm(instance: DrawerInstance, fileName: string, isDir: boolean): Promise<void> {
    const type = isDir ? '文件夹' : '文件';
    const container = instance.element.querySelector('.drawer-content') as HTMLElement || instance.element;
    const result = await this.showModal({
      title: `确定要删除${type} "${fileName}" 吗？`,
      confirmText: '删除',
      danger: true,
      container,
    });
    if (result !== null && instance.fileManager) {
      await instance.fileManager.deleteFile(fileName);
    }
  }

  private async showRenameDialog(instance: DrawerInstance, oldName: string): Promise<void> {
    const container = instance.element.querySelector('.drawer-content') as HTMLElement || instance.element;
    const newName = await this.showModal({
      title: '重命名',
      input: { value: oldName },
      confirmText: '重命名',
      container,
    });
    if (newName && newName !== oldName && instance.fileManager) {
      await instance.fileManager.renameFile(oldName, newName);
    }
  }

  private async showMkdirDialog(instance: DrawerInstance): Promise<void> {
    const container = instance.element.querySelector('.drawer-content') as HTMLElement || instance.element;
    const dirName = await this.showModal({
      title: '新建文件夹',
      input: { placeholder: '文件夹名称' },
      confirmText: '创建',
      container,
    });
    if (dirName && instance.fileManager) {
      await instance.fileManager.createDirectory(dirName);
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

    dropZone.addEventListener('drop', async (e: DragEvent) => {
      const files = e.dataTransfer?.files;
      if (!files || files.length === 0 || !instance.fileManager) {
        return;
      }

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        try {
          const arrayBuffer = await file.arrayBuffer();
          const content = new Uint8Array(arrayBuffer);
          await instance.fileManager.uploadFile(file.name, content);
          console.log(`已上传: ${file.name}`);
        } catch (err) {
          console.error(`上传 ${file.name} 失败:`, err);
          alert(`上传文件 "${file.name}" 失败`);
        }
      }

      instance.fileManager.loadDirectory(instance.fileManager.getCurrentPath());
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
      instance.element.classList.add('open');
      this.updateHeight(instance);
      this.startSysInfoRefresh(instance);
      // 通知 FileManager 全局监听器：当前活跃的 drag-drop 目标为此 drawer 的 fileManager
      FileManager.setActiveDragDropTarget(instance.fileManager ?? null);
      // JumpServer 首次打开抽屉时延迟加载文件列表（SFTP 需要连接就绪后才可用）
      if (jumpServerConfigMap.has(sessionId) && instance.fileManager && instance.fileManager.getCurrentPath() === '/') {
        instance.fileManager.loadDirectory('.');
      }
    } else {
      instance.element.classList.remove('open');
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
  }

  setWebSocket(sessionId: string, ws: WebSocket): void {
    const instance = this.drawers.get(sessionId);
    if (instance?.fileManager) {
      instance.fileManager.setWebSocket(ws);
      // JumpServer 连接：SFTP 子系统初始化较慢，跳过自动加载，
      // 在用户首次打开抽屉时再加载，并自动进入唯一的资产子目录
      if (jumpServerConfigMap.has(sessionId)) {
        // JumpServer SFTP 错误静默处理（Koko 网关 SFTP 初始化延迟）
        instance.fileManager.suppressListErrors = true;
        instance.fileManager.onFirstLoad = (files, _path) => {
          // SFTP 成功后关闭静默，后续错误正常提示
          if (instance.fileManager) instance.fileManager.suppressListErrors = false;
          const dirs = files.filter(f => f.is_dir);
          if (dirs.length === 1) {
            instance.fileManager?.loadDirectory(dirs[0].name);
          }
        };
        return;
      }
      // SSH 会话加载 "."（SFTP 主目录），本地会话加载 "/"
      const initialPath = instance.serverConnectionInfo ? '.' : '/';
      instance.fileManager.loadDirectory(initialPath);
    }
  }

  getServerInfo(sessionId: string): { host: string; username: string; port: number } | null {
    const instance = this.drawers.get(sessionId);
    return instance?.serverConnectionInfo || null;
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

    if (instance.isOpen) {
      // 抽屉已打开，直接导航
      instance.fileManager?.loadDirectory(dirPath);
    } else {
      // 确认已在 openFileLink 中完成，此处直接打开抽屉
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
