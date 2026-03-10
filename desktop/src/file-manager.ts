import {
  MsgFileList,
  MsgFileListResp,
  MsgFileDownloadStart,
  MsgFileDownloadChunk,
  MsgFileUploadStart,
  MsgFileUploadChunk,
  MsgFileUploadResume,
  MsgFileDownloadResume,
  MsgFileOperation,
  MsgFileOperationResp,
  MsgServerInfo,
  MsgError,
  MsgFileListProgress,
  MsgFileDownloadPause,
  MsgFileDownloadContinue,
  MsgFileDownloadCancel,
  type FileInfo,
  type FileListResponse,
  type FileOperationRequest,
  type ErrorResponse,
  type FileListProgressResponse,
  type ServerInfoResponse,
} from './protocol';
import { getFileIcon } from './icons';
import { escapeHtml } from './status-bar';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { readFile, stat as fsStat, readDir, writeFile as fsWriteFile, remove as fsRemove, exists as fsExists } from '@tauri-apps/plugin-fs';

// 模块级变量：全局只注册一次 drag-drop 监听器，避免分屏时多实例重复上传同一文件
let _dragDropListenerRegistered = false;
let _activeDragDropInstance: FileManager | null = null;

export class FileManager {
  private sessionId: string;
  private ws: WebSocket | null = null;
  private currentPath: string = '/';
  private files: FileInfo[] = [];
  private listElement: HTMLElement;
  private pathInput: HTMLInputElement;
  private pendingDownload: {
    filename: string; savePath: string; remotePath: string;
    totalSize: number; receivedSize: number;
  } | null = null;
  private lastDownloadProgressUpdate: number = 0;
  // 下载缓冲：累积小 chunk 后批量写入磁盘
  private downloadBuffer: Uint8Array[] = [];
  private downloadBufferSize: number = 0;
  private static readonly WRITE_BATCH_SIZE = 8 * 1024 * 1024; // 8MB per disk write
  // 异步写入队列：独立于消息处理循环，逐批写入磁盘
  private writeQueue: Uint8Array[] = [];
  private isWriting: boolean = false;
  private writeError: string | null = null;
  private pendingUpload: { path: string; content: Uint8Array; offset: number } | null = null;
  // Number of upload chunks sent to server but not yet ACKed.
  private inFlightChunks: number = 0;
  // Dynamic pipeline depth: starts at 2 and grows via TCP-style slow-start / linear increase.
  // Adapts automatically — low on high-latency links at first, then expands to saturate bandwidth.
  private pipelineSize: number = 2;
  // ACK count since last pipeline increase (used for linear phase).
  private pipelineAckCount: number = 0;
  private static readonly PIPELINE_MAX = 32;
  private static readonly SLOW_START_THRESHOLD = 16;
  private uploadQueue: Array<{ path: string; content: Uint8Array; filename: string; size: number }> = [];
  private isUploadPaused: boolean = false;
  private isDownloadPaused: boolean = false;
  private pendingPartCleanup: boolean = false;
  private isLoadingDirectory: boolean = false;
  private loadingTimeout: ReturnType<typeof setTimeout> | null = null;
  private lastClickTime: number = 0;
  private lastClickPath: string = '';
  private loadingOverlay: HTMLElement | null = null;
  private loadingProgressBar: HTMLElement | null = null;
  private progressInterval: ReturnType<typeof setInterval> | null = null;
  private currentProgress: number = 0;
  private useRealProgress: boolean = false;  // 是否使用真实进度
  private totalFiles: number = 0;  // 大目录模式下的总文件数
  private sortColumn: string | null = null;  // 当前排序列
  private sortDirection: 'asc' | 'desc' | null = null;  // 排序方向
  private transferHistory: Array<{
    id: string;
    type: 'upload' | 'download';
    filename: string;
    path: string;
    size: number;
    progress: number;
    status: 'pending' | 'inprogress' | 'completed' | 'failed' | 'paused' | 'cancelled';
    timestamp: number;
    error?: string;
    savePath?: string;  // 下载文件的本地保存路径
    startTime?: number;   // 传输开始时间（首次 inprogress）
    endTime?: number;     // 传输结束时间（completed/failed/cancelled）
  }> = [];
  private maxHistoryLength = 200;
  // 非持久化的速度跟踪数据（用于计算实时传输速率）
  private speedTracker: Map<string, { lastBytes: number; lastTime: number; speed: number }> = new Map();
  private static readonly STORAGE_KEY = 'meterm-transfer-history';
  private pendingStatCallback: ((response: any) => void) | null = null;
  private pendingMkdirResolve: (() => void) | null = null;
  onServerInfo: ((data: ServerInfoResponse) => void) | null = null;

  // 路径自动补全
  private autocompleteDropdown: HTMLDivElement | null = null;
  private autocompleteItems: FileInfo[] = [];
  private autocompleteParentDir: string = '/';
  private autocompleteSelectedIndex: number = -1;
  private autocompleteDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private autocompleteResolve: ((files: FileInfo[]) => void) | null = null;
  private dirCache: Map<string, { files: FileInfo[]; ts: number }> = new Map();
  private static readonly DIR_CACHE_SIZE = 20;
  private static readonly DIR_CACHE_TTL = 30000; // 30s

  constructor(
    sessionId: string,
    listElement: HTMLElement,
    pathInput: HTMLInputElement,
    loadingOverlay: HTMLElement,
    loadingProgressBar: HTMLElement
  ) {
    this.sessionId = sessionId;
    this.listElement = listElement;
    this.pathInput = pathInput;
    this.loadingOverlay = loadingOverlay;
    this.loadingProgressBar = loadingProgressBar;

    // 从 localStorage 恢复传输历史
    this.loadTransferHistory();

    // 初始化列宽调整功能
    this.initializeColumnResize();
    // 初始化排序功能
    this.initializeSorting();
    // 初始化拖拽上传功能
    this.initializeDragAndDrop();
  }

  setWebSocket(ws: WebSocket): void {
    this.ws = ws;
    this.setupMessageHandler();

    // Attempt to resume interrupted transfers instead of discarding them
    if (this.pendingUpload) {
      this.resumeUpload();
    } else if (this.uploadQueue.length > 0) {
      // Reconnected between uploads — kick the queue
      this.processNextUpload();
    }
    if (this.pendingDownload) {
      this.resumeDownload();
    }
  }

  private setupMessageHandler(): void {
    if (!this.ws) return;

    const originalOnMessage = this.ws.onmessage;
    const ws = this.ws;
    this.ws.onmessage = (event) => {
      let handled = false;

      if (event.data instanceof ArrayBuffer) {
        const view = new DataView(event.data);
        const msgType = view.getUint8(0);
        // File manager message types (0x0a-0x16): don't forward to terminal handler
        handled = msgType >= 0x0a && msgType <= 0x16;

        if (msgType === MsgError) {
          const payload = new Uint8Array(event.data, 1);
          this.handleError(payload);
        } else if (msgType === MsgFileListProgress) {
          const payload = new Uint8Array(event.data, 1);
          this.handleFileListProgress(payload);
        } else if (msgType === MsgFileListResp) {
          const payload = new Uint8Array(event.data, 1);
          this.handleFileListResponse(payload);
        } else if (msgType === MsgFileDownloadChunk) {
          const payload = new Uint8Array(event.data, 1);
          this.handleDownloadChunk(payload);
        } else if (msgType === MsgFileUploadChunk) {
          // Server acknowledges upload chunk (or resume ACK)
          if (this.pendingUpload) {
            const chunkPayload = new Uint8Array(event.data, 1);
            if (chunkPayload.length === 8) {
              // Resume ACK: 8-byte offset tells us where to continue from.
              // Reset all pipeline state (no chunks were pipelined before resume).
              const resumeView = new DataView(chunkPayload.buffer, chunkPayload.byteOffset, 8);
              this.pendingUpload.offset = Number(resumeView.getBigUint64(0));
              this.inFlightChunks = 0;
              this.pipelineSize = 2;     // restart slow-start after reconnect
              this.pipelineAckCount = 0;
              console.log(`Upload resume ACK: continuing from offset ${this.pendingUpload.offset}`);
            } else {
              // Regular chunk ACK: one in-flight chunk was confirmed.
              this.inFlightChunks = Math.max(0, this.inFlightChunks - 1);
              // Grow the pipeline window (slow start → linear).
              this.adaptPipeline();
            }
            // Fill the pipeline — sends more chunks if pipeline has room.
            this.sendUploadChunk();
          }
        } else if (msgType === MsgFileOperationResp) {
          // Upload completed or file operation response
          const payload = new Uint8Array(event.data, 1);
          this.handleOperationResponse(payload);
        } else if (msgType === MsgServerInfo) {
          const payload = new Uint8Array(event.data, 1);
          const text = new TextDecoder().decode(payload);
          try {
            const data = JSON.parse(text) as ServerInfoResponse;
            if (this.onServerInfo) this.onServerInfo(data);
          } catch (e) {
            console.error('Failed to parse server info:', e);
          }
        }
      }

      // Only forward non-file-manager messages to the terminal handler
      if (!handled && originalOnMessage) {
        originalOnMessage.call(ws, event);
      }
    };
  }

  async loadDirectory(path: string): Promise<void> {
    // 详细的 WebSocket 状态检查
    if (!this.ws) {
      console.error('❌ WebSocket 未初始化 (ws = null)');
      alert('文件管理器未连接到服务器\n请关闭并重新打开抽屉，或刷新页面');
      return;
    }

    const wsStates = ['CONNECTING (0)', 'OPEN (1)', 'CLOSING (2)', 'CLOSED (3)'];
    const wsStateStr = wsStates[this.ws.readyState] || `UNKNOWN (${this.ws.readyState})`;

    if (this.ws.readyState !== WebSocket.OPEN) {
      console.error('❌ WebSocket 未就绪，当前状态:', wsStateStr);
      alert(`WebSocket 连接已断开\n当前状态: ${wsStateStr}\n请关闭并重新打开抽屉，或刷新页面`);
      return;
    }

    console.log('✅ WebSocket 状态正常:', wsStateStr);

    // 防抖：忽略300ms内对同一路径的重复请求
    const now = Date.now();
    if (now - this.lastClickTime < 300 && this.lastClickPath === path) {
      console.warn('⏭️ 防抖：忽略重复的快速点击', path);
      return;
    }
    this.lastClickTime = now;
    this.lastClickPath = path;

    if (this.isLoadingDirectory) {
      console.warn('⏸️ 已有目录加载操作进行中，忽略此次请求');
      return;
    }

    console.log('📂 开始加载目录:', path);
    this.isLoadingDirectory = true;

    // 显示 loading 遮罩
    this.showLoading();

    // 清除旧的超时定时器
    if (this.loadingTimeout) {
      clearTimeout(this.loadingTimeout);
    }

    // 设置60秒超时保护，防止永久锁定
    this.loadingTimeout = setTimeout(() => {
      console.error('⏰ 目录加载超时（60秒未响应），重置状态');
      console.error('   可能原因：服务器响应慢、网络问题、或 WebSocket 消息丢失');
      this.hideLoading();
      this.isLoadingDirectory = false;
      this.loadingTimeout = null;
      alert('加载超时，请稍后重试');
    }, 60000);

    try {
      // 不在这里更新路径，等待服务器响应后再更新
      const request = JSON.stringify({ path });
      const message = this.encodeMessage(MsgFileList, new TextEncoder().encode(request));
      console.log('📤 发送目录请求到服务器，路径:', path, '消息大小:', message.length, 'bytes');
      this.ws.send(message);
      console.log('✅ 请求已发送，等待服务器响应...');
    } catch (err) {
      console.error('❌ 发送目录请求失败:', err);
      this.hideLoading();
      this.isLoadingDirectory = false;
      if (this.loadingTimeout) {
        clearTimeout(this.loadingTimeout);
        this.loadingTimeout = null;
      }
      alert(`发送请求失败: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }

  private handleFileListProgress(payload: Uint8Array): void {
    try {
      const progress: FileListProgressResponse = JSON.parse(new TextDecoder().decode(payload));
      console.log(`📊 收到进度更新: ${progress.loaded}/${progress.total} 文件`);

      // 首次收到进度消息时，切换到真实进度模式
      if (!this.useRealProgress && progress.total > 0) {
        console.log('🔄 切换到真实进度模式');
        this.useRealProgress = true;
        this.totalFiles = progress.total;

        // 清除伪进度动画
        if (this.progressInterval) {
          clearInterval(this.progressInterval);
          this.progressInterval = null;
        }
      }

      // 更新真实进度（包括首次）
      if (this.useRealProgress && this.loadingProgressBar) {
        const percent = progress.total > 0 ? (progress.loaded / progress.total) * 100 : 0;
        this.loadingProgressBar.style.width = `${percent}%`;

        // 更新加载文字
        const loadingText = this.loadingOverlay?.querySelector('.loading-text');
        if (loadingText) {
          loadingText.textContent = `加载中... ${progress.loaded}/${progress.total}`;
        }
      }
    } catch (err) {
      console.error('❌ 解析进度响应失败:', err);
    }
  }

  private handleFileListResponse(payload: Uint8Array): void {
    let isAutocompleteResponse = false;
    try {
      const response: FileListResponse = JSON.parse(new TextDecoder().decode(payload));

      // 自动补全静默查询的响应：不更新 UI
      if (this.autocompleteResolve && !this.isLoadingDirectory) {
        isAutocompleteResponse = true;
        const resolve = this.autocompleteResolve;
        this.autocompleteResolve = null;
        this.dirCachePut(response.path, response.files);
        resolve(response.files);
        return;
      }

      console.log('📥 收到文件列表响应:', response.path, '文件数:', response.files.length);
      this.dirCachePut(response.path, response.files);
      this.files = response.files;
      this.currentPath = response.path;
      this.pathInput.value = response.path;
      this.renderFileList();
    } catch (err) {
      console.error('❌ 解析文件列表响应失败:', err);
    } finally {
      if (!isAutocompleteResponse) {
        this.hideLoading();
        this.isLoadingDirectory = false;
        if (this.loadingTimeout) {
          clearTimeout(this.loadingTimeout);
          this.loadingTimeout = null;
        }
        // 重置真实进度状态
        this.useRealProgress = false;
        this.totalFiles = 0;
        console.log('✅ 目录加载完成，状态已重置');
      }
    }
  }

  private handleError(payload: Uint8Array): void {
    try {
      const error: ErrorResponse = JSON.parse(new TextDecoder().decode(payload));
      console.error('🚨 服务器返回错误:', error.code, '-', error.message);

      // Upload resume failed: no partial file on server, restart full upload
      if (error.code === 'NO_PARTIAL_UPLOAD' && this.pendingUpload) {
        console.log('Upload resume failed (no partial file), restarting full upload');
        // Reset offset and send fresh MsgFileUploadStart
        this.pendingUpload.offset = 0;
        const request = JSON.stringify({ path: this.pendingUpload.path, size: this.pendingUpload.content.length });
        const message = this.encodeMessage(MsgFileUploadStart, new TextEncoder().encode(request));
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(message);
        }
        return;
      }

      // stat 操作的 NOT_FOUND 错误由 pendingStatCallback 处理
      if (error.code === 'NOT_FOUND' && this.pendingStatCallback) {
        const cb = this.pendingStatCallback;
        this.pendingStatCallback = null;
        cb({ exists: false });
        return;
      }

      // mkdir 失败（如目录已存在）由 pendingMkdirResolve 处理
      if (error.code === 'MKDIR_FAILED' && this.pendingMkdirResolve) {
        const cb = this.pendingMkdirResolve;
        this.pendingMkdirResolve = null;
        cb();
        return;
      }

      // 隐藏 loading 遮罩
      this.hideLoading();

      // 重置加载状态
      this.isLoadingDirectory = false;
      if (this.loadingTimeout) {
        clearTimeout(this.loadingTimeout);
        this.loadingTimeout = null;
      }

      // 清理 pending 下载状态（关闭文件句柄并删除 .part 临时文件）
      if (this.pendingDownload) {
        if (this.currentDownloadId) {
          this.updateTransferProgress(this.currentDownloadId, 0, 'failed', error.message);
          this.currentDownloadId = null;
        }
        this.cleanupDownload();
      }

      // 清理 pending 上传状态
      if (this.pendingUpload) {
        this.pendingUpload = null;
        if (this.currentUploadId) {
          this.updateTransferProgress(this.currentUploadId, 0, 'failed', error.message);
          this.currentUploadId = null;
        }
      }

      // 显示用户友好的错误提示
      let userMessage = error.message;
      const msgLower = error.message.toLowerCase();
      if (error.code === 'SFTP_NOT_AVAILABLE') {
        userMessage = 'SSH 文件系统未就绪\n请确保已成功连接到 SSH 服务器';
      } else if (error.code === 'LIST_FAILED') {
        userMessage = '无法列出目录\n' + error.message;
      } else if (error.code === 'READ_FAILED') {
        userMessage = '下载失败\n' + error.message;
      } else if (error.code === 'WRITE_FAILED' || msgLower.includes('no space') || msgLower.includes('disk full') || msgLower.includes('enospc')) {
        userMessage = '服务器磁盘空间不足\n上传失败';
      } else if (msgLower.includes('permission denied') || msgLower.includes('eacces')) {
        userMessage = '服务器权限不足\n' + error.message;
      }

      alert(`操作失败\n\n${userMessage}`);
    } catch (err) {
      console.error('❌ 解析错误响应失败:', err);
    }
  }

  private renderFileList(): void {
    console.log('开始渲染文件列表，当前文件数:', this.files.length);

    let sortedFiles = [...this.files];

    // 如果有排序列，应用排序
    if (this.sortColumn && this.sortDirection) {
      sortedFiles.sort((a, b) => {
        let compareResult = 0;

        switch (this.sortColumn) {
          case 'name':
            compareResult = a.name.localeCompare(b.name);
            break;
          case 'size':
            compareResult = a.size - b.size;
            break;
          case 'mtime':
            compareResult = a.mtime - b.mtime;
            break;
          case 'owner':
            compareResult = (a.owner + ':' + a.group).localeCompare(b.owner + ':' + b.group);
            break;
          default:
            compareResult = 0;
        }

        return this.sortDirection === 'asc' ? compareResult : -compareResult;
      });
    } else {
      // 默认排序：文件夹在前，然后按名称排序
      sortedFiles.sort((a, b) => {
        if (a.is_dir !== b.is_dir) {
          return a.is_dir ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      });
    }

    // 更新排序箭头显示
    this.updateSortArrows();

    this.listElement.innerHTML = sortedFiles.map((file) => {
      const iconSvg = getFileIcon(file.name, file.is_dir, file.is_link);
      const size = file.is_dir ? '-' : this.formatSize(file.size);
      const mtime = new Date(file.mtime * 1000).toLocaleString();
      const ownerGroup = escapeHtml((file.owner || '-') + ':' + (file.group || '-'));
      const escapedName = escapeHtml(file.name);

      return `
        <tr data-path="${escapedName}" data-is-dir="${file.is_dir}">
          <td><span class="file-icon">${iconSvg}</span>${escapedName}</td>
          <td>${size}</td>
          <td>${mtime}</td>
          <td>${ownerGroup}</td>
          <td>${escapeHtml(file.mode)}</td>
        </tr>
      `;
    }).join('');

    // 仅在文本被截断时显示 tooltip
    this.listElement.querySelectorAll('td').forEach((td) => {
      td.addEventListener('mouseenter', () => {
        if (td.scrollWidth > td.clientWidth) {
          td.title = td.textContent || '';
        } else {
          td.removeAttribute('title');
        }
      });
    });

    this.listElement.querySelectorAll('tr').forEach((row) => {
      // 单击：选中行
      row.addEventListener('click', () => {
        // 移除其他行的选中状态
        this.listElement.querySelectorAll('tr').forEach(r => r.classList.remove('selected'));
        // 添加当前行的选中状态
        row.classList.add('selected');
      });

      // 双击：进入文件夹或下载文件
      row.addEventListener('dblclick', async () => {
        console.log('文件行被双击');
        const path = row.dataset.path;
        const isDir = row.dataset.isDir === 'true';
        console.log('双击项:', path, '是否为目录:', isDir);

        if (isDir && path) {
          const newPath = this.currentPath === '/'
            ? `/${path}`
            : `${this.currentPath}/${path}`;
          console.log('准备进入目录:', newPath);
          await this.loadDirectory(newPath);
        } else if (!isDir && path) {
          console.log('准备下载文件:', path);
          await this.downloadFile(path);
        }
      });
    });

    console.log('文件列表渲染完成，已添加', this.listElement.querySelectorAll('tr').length, '个事件监听器');
  }

  private formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }

  private encodeMessage(type: number, payload: Uint8Array): Uint8Array {
    const message = new Uint8Array(1 + payload.length);
    message[0] = type;
    message.set(payload, 1);
    return message;
  }

  getCurrentPath(): string {
    return this.currentPath;
  }

  /** 返回当前目录的文件名→是否为目录映射（供终端文件链接使用） */
  getFileNames(): Map<string, boolean> {
    const names = new Map<string, boolean>();
    for (const f of this.files) names.set(f.name, f.is_dir);
    return names;
  }

  // ===================== 路径自动补全 =====================

  private dirCachePut(path: string, files: FileInfo[]): void {
    if (this.dirCache.size >= FileManager.DIR_CACHE_SIZE) {
      const oldest = this.dirCache.keys().next().value!;
      this.dirCache.delete(oldest);
    }
    this.dirCache.set(path, { files, ts: Date.now() });
  }

  /** 静默查询目录内容（不影响 UI），供自动补全使用 */
  private queryDirectory(path: string): Promise<FileInfo[]> {
    if (path === this.currentPath) return Promise.resolve(this.files);
    const cached = this.dirCache.get(path);
    if (cached && Date.now() - cached.ts < FileManager.DIR_CACHE_TTL) {
      return Promise.resolve(cached.files);
    }
    if (this.isLoadingDirectory || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.resolve([]);
    }
    return new Promise((resolve) => {
      if (this.autocompleteResolve) this.autocompleteResolve([]);
      this.autocompleteResolve = resolve;
      const request = JSON.stringify({ path });
      const message = this.encodeMessage(MsgFileList, new TextEncoder().encode(request));
      this.ws!.send(message);
      setTimeout(() => {
        if (this.autocompleteResolve === resolve) {
          this.autocompleteResolve = null;
          resolve([]);
        }
      }, 3000);
    });
  }

  /** 初始化路径自动补全（由 drawer.ts 调用） */
  setupPathAutocomplete(): void {
    const wrapper = this.pathInput.parentElement;
    if (!wrapper || !wrapper.classList.contains('path-input-wrapper')) return;
    const dropdown = wrapper.querySelector('.path-autocomplete') as HTMLDivElement;
    if (!dropdown) return;
    this.autocompleteDropdown = dropdown;

    this.pathInput.addEventListener('input', () => {
      if (this.autocompleteDebounceTimer) clearTimeout(this.autocompleteDebounceTimer);
      this.autocompleteDebounceTimer = setTimeout(() => this.fetchAutocompleteItems(), 200);
    });

    this.pathInput.addEventListener('keydown', (e) => this.onAutocompleteKeydown(e));

    this.pathInput.addEventListener('blur', () => {
      setTimeout(() => this.hideAutocomplete(), 150);
    });
  }

  isAutocompleteOpen(): boolean {
    return !!this.autocompleteDropdown && this.autocompleteDropdown.style.display === 'block';
  }

  hideAutocomplete(): void {
    if (this.autocompleteDropdown) this.autocompleteDropdown.style.display = 'none';
    this.autocompleteItems = [];
    this.autocompleteSelectedIndex = -1;
  }

  private async fetchAutocompleteItems(): Promise<void> {
    const value = this.pathInput.value;
    if (!value.startsWith('/')) { this.hideAutocomplete(); return; }

    const lastSlash = value.lastIndexOf('/');
    const parentDir = lastSlash === 0 ? '/' : value.substring(0, lastSlash);
    const prefix = value.substring(lastSlash + 1).toLowerCase();

    try {
      const files = await this.queryDirectory(parentDir);
      const matches = files.filter(f =>
        f.is_dir && f.name !== '.' && f.name !== '..' &&
        f.name.toLowerCase().startsWith(prefix)
      );
      if (matches.length === 0 ||
          (matches.length === 1 && matches[0].name.toLowerCase() === prefix)) {
        this.hideAutocomplete();
        return;
      }
      this.showAutocomplete(matches, parentDir);
    } catch {
      this.hideAutocomplete();
    }
  }

  private showAutocomplete(items: FileInfo[], parentDir: string): void {
    if (!this.autocompleteDropdown) return;
    this.autocompleteItems = items;
    this.autocompleteParentDir = parentDir;
    this.autocompleteSelectedIndex = -1;

    const folderIcon = '<svg width="12" height="12" viewBox="0 0 16 16" fill="var(--accent)" stroke="none">'
      + '<path d="M1.5 2h4.3l1.4 1.5H14.5a1 1 0 0 1 1 1V13a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z"/></svg>';

    this.autocompleteDropdown.innerHTML = items.map((item, i) =>
      `<div class="path-ac-item" data-index="${i}">${folderIcon}<span>${escapeHtml(item.name)}</span></div>`
    ).join('');
    this.autocompleteDropdown.style.display = 'block';

    this.autocompleteDropdown.querySelectorAll('.path-ac-item').forEach(el => {
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this.selectAutocompleteItem(parseInt((el as HTMLElement).dataset.index!), true);
      });
    });
  }

  private selectAutocompleteItem(index: number, navigate = false): void {
    const item = this.autocompleteItems[index];
    if (!item) return;
    const dir = this.autocompleteParentDir;
    const newPath = dir === '/' ? `/${item.name}` : `${dir}/${item.name}`;
    this.pathInput.value = navigate ? newPath : newPath + '/';
    this.hideAutocomplete();
    if (navigate) {
      // 鼠标点击：直接进入该目录
      this.loadDirectory(newPath);
    } else {
      // 键盘选择：填充路径并补全下一级
      this.pathInput.focus();
      if (this.autocompleteDebounceTimer) clearTimeout(this.autocompleteDebounceTimer);
      this.autocompleteDebounceTimer = setTimeout(() => this.fetchAutocompleteItems(), 100);
    }
  }

  private onAutocompleteKeydown(e: KeyboardEvent): void {
    if (!this.isAutocompleteOpen()) return;
    const len = this.autocompleteItems.length;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        this.autocompleteSelectedIndex = (this.autocompleteSelectedIndex + 1) % len;
        this.updateAutocompleteSelection();
        break;
      case 'ArrowUp':
        e.preventDefault();
        this.autocompleteSelectedIndex = (this.autocompleteSelectedIndex - 1 + len) % len;
        this.updateAutocompleteSelection();
        break;
      case 'Tab':
        e.preventDefault();
        if (this.autocompleteSelectedIndex >= 0) {
          this.selectAutocompleteItem(this.autocompleteSelectedIndex);
        } else if (len > 0) {
          this.selectAutocompleteItem(0);
        }
        break;
      case 'Enter':
        if (this.autocompleteSelectedIndex >= 0) {
          e.preventDefault();
          e.stopPropagation();
          this.selectAutocompleteItem(this.autocompleteSelectedIndex);
        }
        break;
      case 'Escape':
        e.preventDefault();
        this.hideAutocomplete();
        break;
    }
  }

  private updateAutocompleteSelection(): void {
    if (!this.autocompleteDropdown) return;
    this.autocompleteDropdown.querySelectorAll('.path-ac-item').forEach((el, i) => {
      el.classList.toggle('selected', i === this.autocompleteSelectedIndex);
      if (i === this.autocompleteSelectedIndex) {
        (el as HTMLElement).scrollIntoView({ block: 'nearest' });
      }
    });
  }

  // ===================== 路径自动补全结束 =====================

  private showLoading(): void {
    if (!this.loadingOverlay || !this.loadingProgressBar) return;

    // 重置状态
    this.useRealProgress = false;
    this.totalFiles = 0;

    // 显示遮罩
    this.loadingOverlay.style.display = 'flex';

    // 重置进度条
    this.currentProgress = 0;
    this.loadingProgressBar.style.width = '0%';

    // 重置加载文字
    const loadingText = this.loadingOverlay.querySelector('.loading-text');
    if (loadingText) {
      loadingText.textContent = '加载中...';
    }

    // 清除旧的进度动画
    if (this.progressInterval) {
      clearInterval(this.progressInterval);
    }

    // 启动伪进度条动画：平滑增长到 90%
    // 如果收到真实进度消息，这个动画会被停止
    const startTime = Date.now();
    const duration = 3000; // 3 秒
    const targetProgress = 90; // 目标 90%

    this.progressInterval = setInterval(() => {
      // 如果切换到真实进度模式，停止伪进度动画
      if (this.useRealProgress) {
        if (this.progressInterval) {
          clearInterval(this.progressInterval);
          this.progressInterval = null;
        }
        return;
      }

      const elapsed = Date.now() - startTime;
      const progress = Math.min((elapsed / duration) * targetProgress, targetProgress);
      this.currentProgress = progress;
      if (this.loadingProgressBar) {
        this.loadingProgressBar.style.width = `${progress}%`;
      }

      // 达到 90% 后停止动画，等待服务器响应
      if (progress >= targetProgress) {
        if (this.progressInterval) {
          clearInterval(this.progressInterval);
          this.progressInterval = null;
        }
      }
    }, 50); // 每 50ms 更新一次
  }

  private hideLoading(): void {
    if (!this.loadingOverlay || !this.loadingProgressBar) return;

    // 如果还有进度动画在运行，先跳到 100%
    if (this.progressInterval) {
      clearInterval(this.progressInterval);
      this.progressInterval = null;
    }

    // 快速跳到 100%
    this.loadingProgressBar.style.width = '100%';

    // 等待 200ms 让用户看到 100%，然后隐藏
    setTimeout(() => {
      if (this.loadingOverlay) {
        this.loadingOverlay.style.display = 'none';
      }
    }, 200);
  }

  private validateFileName(name: string): boolean {
    // Check for invalid characters
    const invalidChars = /[<>:"/\\|?*\x00-\x1F]/;
    if (invalidChars.test(name)) {
      console.error('Invalid characters in filename');
      return false;
    }

    // Check for path traversal
    if (name.includes('..') || name.includes('/')) {
      console.error('Path traversal detected');
      return false;
    }

    // Check length
    if (name.length === 0 || name.length > 255) {
      console.error('Invalid filename length');
      return false;
    }

    return true;
  }

  async triggerUpload(targetDir?: string): Promise<void> {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({
        multiple: true,
        directory: false
      });

      if (!selected) return;

      const filePaths = Array.isArray(selected) ? selected : [selected];
      const { readFile } = await import('@tauri-apps/plugin-fs');

      for (const filePath of filePaths) {
        try {
          const content = await readFile(filePath);
          const filename = filePath.replace(/\\/g, '/').split('/').pop() || 'file';
          await this.uploadFile(filename, content, targetDir);
        } catch (err) {
          console.error(`Failed to read file ${filePath}:`, err);
        }
      }
    } catch (err) {
      console.error('Upload failed:', err);
    }
  }

  async uploadFile(filename: string, content: Uint8Array, targetDir?: string): Promise<void> {
    const dir = targetDir || this.currentPath;
    let actualFilename = filename;
    let targetPath = dir === '/'
      ? `/${filename}`
      : `${dir}/${filename}`;

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.error('WebSocket not ready');
      return;
    }

    // 检查远程是否已存在同名文件
    const stat = await this.checkFileExists(targetPath);
    if (stat.exists) {
      const result = await this.showUploadConflictDialog(filename);
      if (result.action === 'skip') return;
      if (result.action === 'rename') {
        actualFilename = result.newName!;
        targetPath = dir === '/'
          ? `/${actualFilename}`
          : `${dir}/${actualFilename}`;
      }
      // action === 'overwrite' 则继续使用原路径
    }

    // 入队
    this.uploadQueue.push({ path: targetPath, content, filename: actualFilename, size: content.length });

    // 如果没有正在进行的上传，立即开始处理队列
    if (!this.pendingUpload) {
      this.processNextUpload();
    }
  }

  private processNextUpload(): void {
    if (this.uploadQueue.length === 0) {
      // 队列处理完毕，刷新目录
      this.loadDirectory(this.currentPath);
      return;
    }
    if (this.pendingUpload) return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const item = this.uploadQueue.shift()!;

    this.currentUploadId = this.addTransferRecord('upload', item.filename, item.path, item.size);
    this.updateTransferProgress(this.currentUploadId, 0, 'inprogress');

    this.pendingUpload = { path: item.path, content: item.content, offset: 0 };
    this.inFlightChunks = 0;   // reset pipeline state for each new upload
    this.pipelineSize = 2;     // restart slow-start from a small window
    this.pipelineAckCount = 0;

    const request = JSON.stringify({ path: item.path, size: item.size });
    const message = this.encodeMessage(MsgFileUploadStart, new TextEncoder().encode(request));
    this.ws.send(message);
    console.log(`Starting upload of ${item.filename} to ${item.path}`);
  }

  // 递归上传本地目录
  private async uploadDirectory(localDirPath: string, dirName: string): Promise<void> {
    // 检查远程是否已存在同名文件夹
    const remoteDirPath = this.currentPath === '/' ? `/${dirName}` : `${this.currentPath}/${dirName}`;
    const stat = await this.checkFileExists(remoteDirPath);
    if (stat.exists && stat.is_dir) {
      const result = await this.showDirConflictDialog(dirName);
      if (result.action === 'skip') return;
      if (result.action === 'rename') {
        dirName = result.newName!;
      }
      // action === 'merge' 则继续使用原名称
    }

    // 收集目录下所有文件（相对路径）
    const files = await this.collectLocalFiles(localDirPath, '');
    if (files.length === 0) return;

    // 收集需要创建的远程目录（去重、排序确保父目录先创建）
    const remoteDirs = new Set<string>();
    remoteDirs.add(dirName);
    for (const f of files) {
      const parts = `${dirName}/${f.relativePath}`.split('/');
      for (let i = 1; i < parts.length; i++) {
        remoteDirs.add(parts.slice(0, i).join('/'));
      }
    }
    const sortedDirs = Array.from(remoteDirs).sort();

    // 逐级创建远程目录
    for (const dir of sortedDirs) {
      const remotePath = this.currentPath === '/' ? `/${dir}` : `${this.currentPath}/${dir}`;
      const exists = await this.checkFileExists(remotePath);
      if (!exists.exists) {
        await this.ensureRemoteDir(remotePath);
      }
    }

    // 上传所有文件
    for (const f of files) {
      try {
        const content = await readFile(f.localPath);
        const targetDir = this.currentPath === '/'
          ? `/${dirName}/${f.relativePath}`.replace(/\/[^/]+$/, '') || '/'
          : `${this.currentPath}/${dirName}/${f.relativePath}`.replace(/\/[^/]+$/, '');
        const filename = f.localPath.replace(/\\/g, '/').split('/').pop() || 'unknown';
        await this.uploadFile(filename, content, targetDir);
      } catch (err) {
        console.error(`Failed to upload ${f.localPath}:`, err);
      }
    }
  }

  // 递归收集本地目录下所有文件
  private async collectLocalFiles(basePath: string, relativePath: string): Promise<Array<{ localPath: string; relativePath: string }>> {
    const results: Array<{ localPath: string; relativePath: string }> = [];
    const entries = await readDir(basePath);

    for (const entry of entries) {
      const fullPath = basePath.endsWith('/') ? `${basePath}${entry.name}` : `${basePath}/${entry.name}`;
      const relPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;

      if (entry.isDirectory) {
        const subFiles = await this.collectLocalFiles(fullPath, relPath);
        results.push(...subFiles);
      } else {
        results.push({ localPath: fullPath, relativePath: relPath });
      }
    }

    return results;
  }

  // 通过 WebSocket 创建远程目录（Promise 包装）
  private ensureRemoteDir(remotePath: string): Promise<void> {
    return new Promise((resolve) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        resolve();
        return;
      }

      const timeout = setTimeout(() => {
        this.pendingMkdirResolve = null;
        resolve();
      }, 5000);

      this.pendingMkdirResolve = () => {
        clearTimeout(timeout);
        resolve();
      };

      const request: FileOperationRequest = { operation: 'mkdir', path: remotePath };
      const message = this.encodeMessage(MsgFileOperation, new TextEncoder().encode(JSON.stringify(request)));
      this.ws.send(message);
    });
  }

  // Adaptive pipeline: TCP-inspired slow start + linear congestion avoidance.
  //
  // Phase 1 — Slow start (pipelineSize < SLOW_START_THRESHOLD):
  //   Increment by 1 on every ACK.  Because we fill the window immediately after
  //   each ACK, this doubles the in-flight data roughly every RTT, letting the
  //   pipeline grow quickly on high-latency or high-bandwidth links.
  //
  // Phase 2 — Linear increase (pipelineSize ≥ SLOW_START_THRESHOLD):
  //   Increment by 1 only after a full window of ACKs, slowing growth to
  //   +1 chunk per RTT.  Caps at PIPELINE_MAX.
  //
  // On upload start / resume the window resets to 2 so we never flood a
  // newly-restored connection.
  private adaptPipeline(): void {
    if (this.pipelineSize < FileManager.SLOW_START_THRESHOLD) {
      // Slow start: +1 per ACK (doubles per RTT)
      this.pipelineSize = Math.min(FileManager.SLOW_START_THRESHOLD, this.pipelineSize + 1);
    } else {
      // Linear: +1 per window-worth of ACKs
      this.pipelineAckCount++;
      if (this.pipelineAckCount >= this.pipelineSize) {
        this.pipelineSize = Math.min(FileManager.PIPELINE_MAX, this.pipelineSize + 1);
        this.pipelineAckCount = 0;
      }
    }
  }

  private sendUploadChunk(): void {
    // 1MB chunks: fewer round-trips, better throughput than 256KB on high-bandwidth links.
    const CHUNK_SIZE = 1 * 1024 * 1024;

    // 暂停时不发送新块
    if (this.isUploadPaused) return;

    // Send as many chunks as the adaptive pipeline window allows.
    while (
      this.pendingUpload &&
      this.ws &&
      this.ws.readyState === WebSocket.OPEN &&
      this.inFlightChunks < this.pipelineSize &&
      !this.isUploadPaused
    ) {
      const totalSize = this.pendingUpload.content.length;
      const offset = this.pendingUpload.offset;

      // All bytes have been dispatched; wait for remaining ACKs.
      if (offset >= totalSize) break;

      const end = Math.min(offset + CHUNK_SIZE, totalSize);
      const chunkData = this.pendingUpload.content.slice(offset, end);

      // Build chunk payload: [8B totalSize BE][8B offset BE][chunk data]
      const payload = new Uint8Array(16 + chunkData.length);
      const view = new DataView(payload.buffer);
      view.setBigUint64(0, BigInt(totalSize));
      view.setBigUint64(8, BigInt(offset));
      payload.set(chunkData, 16);

      this.ws.send(this.encodeMessage(MsgFileUploadChunk, payload));

      this.pendingUpload.offset = end;
      this.inFlightChunks++;

      const progress = totalSize > 0 ? Math.min(Math.round((end / totalSize) * 100), 99) : 99;
      if (this.currentUploadId) {
        this.updateTransferProgress(this.currentUploadId, progress, 'inprogress');
      }

      console.log(`Sent chunk ${offset}-${end}/${totalSize} (in-flight: ${this.inFlightChunks}/${this.pipelineSize})`);
    }
  }

  private resumeUpload(): void {
    if (!this.pendingUpload || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // Cannot resume, mark as failed
      if (this.pendingUpload) {
        this.pendingUpload = null;
        if (this.currentUploadId) {
          this.updateTransferProgress(this.currentUploadId, 0, 'failed', '连接已断开');
          this.currentUploadId = null;
        }
      }
      return;
    }

    console.log(`Attempting upload resume for ${this.pendingUpload.path}`);
    const request = JSON.stringify({ path: this.pendingUpload.path, size: this.pendingUpload.content.length });
    const message = this.encodeMessage(MsgFileUploadResume, new TextEncoder().encode(request));
    this.ws.send(message);
  }

  private async resumeDownload(): Promise<void> {
    if (!this.pendingDownload || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // Cannot resume, mark as failed
      if (this.pendingDownload) {
        if (this.currentDownloadId) {
          this.updateTransferProgress(this.currentDownloadId, 0, 'failed', '连接已断开');
          this.currentDownloadId = null;
        }
        await this.cleanupDownload();
      }
      return;
    }

    try {
      // 等待之前的写入完成
      while (this.isWriting) {
        await new Promise(r => setTimeout(r, 50));
      }
      this.writeQueue = [];
      this.writeError = null;

      // 检查磁盘上实际已写入的大小
      let resumeOffset = 0;
      if (await fsExists(this.pendingDownload.savePath)) {
        const fileStat = await fsStat(this.pendingDownload.savePath);
        resumeOffset = fileStat.size;
      }
      this.pendingDownload.receivedSize = resumeOffset;
    } catch (err) {
      console.error('Failed to setup resume:', err);
      if (this.currentDownloadId) {
        this.updateTransferProgress(this.currentDownloadId, 0, 'failed', '恢复下载失败');
        this.currentDownloadId = null;
      }
      await this.cleanupDownload();
      return;
    }

    console.log(`Attempting download resume for ${this.pendingDownload.remotePath} from offset ${this.pendingDownload.receivedSize}`);
    const request = JSON.stringify({ path: this.pendingDownload.remotePath, offset: this.pendingDownload.receivedSize });
    const message = this.encodeMessage(MsgFileDownloadResume, new TextEncoder().encode(request));
    this.ws.send(message);
  }

  private handleOperationResponse(payload: Uint8Array): void {
    try {
      const response = JSON.parse(new TextDecoder().decode(payload));

      // stat 操作的响应由 pendingStatCallback 处理
      if (response.operation === 'stat' && this.pendingStatCallback) {
        const cb = this.pendingStatCallback;
        this.pendingStatCallback = null;
        cb(response);
        return;
      }

      // mkdir 操作的响应由 pendingMkdirResolve 处理
      if (response.operation === 'mkdir' && this.pendingMkdirResolve) {
        const cb = this.pendingMkdirResolve;
        this.pendingMkdirResolve = null;
        cb();
        return;
      }

      // .meterm.part 清理响应：静默处理，不影响上传/下载状态
      if (this.pendingPartCleanup && response.operation === 'delete') {
        this.pendingPartCleanup = false;
        console.log('Part file cleanup:', response.success ? 'ok' : 'failed');
        return;
      }

      if (response.success) {
        console.log(`Operation ${response.operation || 'file operation'} completed successfully`);

        // 区分上传完成（无 operation 字段）和普通文件操作（有 operation 字段）
        const isUploadComplete = !response.operation;

        if (isUploadComplete) {
          // 上传操作完成，更新历史记录并处理队列中下一个
          if (this.currentUploadId) {
            this.updateTransferProgress(this.currentUploadId, 100, 'completed');
            this.currentUploadId = null;
          }

          this.pendingUpload = null;
          // 继续处理上传队列（队列空时会自动刷新目录）
          this.processNextUpload();
        } else {
          // 普通文件操作（delete/rename/touch），刷新目录
          this.loadDirectory(this.currentPath);
        }
      } else {
        const errorMsg = response.message || response.error || 'Unknown error';
        console.error(`Operation failed: ${errorMsg}`);

        // 如果是上传操作失败（无 operation 字段），更新历史记录
        if (!response.operation && this.currentUploadId) {
          this.updateTransferProgress(this.currentUploadId, 0, 'failed', errorMsg);
          this.currentUploadId = null;
          this.pendingUpload = null;
          this.processNextUpload();
        } else {
          // 普通文件操作失败
          alert(`操作失败: ${errorMsg}`);
        }
      }
    } catch (err) {
      console.error('Failed to parse operation response:', err);
      alert('操作失败: 服务器响应解析错误');

      // 如果是上传操作失败，更新历史记录
      if (this.currentUploadId) {
        this.updateTransferProgress(this.currentUploadId, 0, 'failed', '服务器响应解析错误');
        this.currentUploadId = null;
      }

      this.pendingUpload = null;
      this.processNextUpload();
    }
  }

  private currentDownloadId: string | null = null;
  private currentUploadId: string | null = null;

  private async downloadFile(filename: string, isDir: boolean = false): Promise<void> {
    const filePath = this.currentPath === '/'
      ? `/${filename}`
      : `${this.currentPath}/${filename}`;

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.error('WebSocket not ready');
      return;
    }

    try {
      const { save } = await import('@tauri-apps/plugin-dialog');
      const defaultName = isDir ? `${filename}.zip` : filename;
      const savePath = await save({
        defaultPath: defaultName,
        filters: isDir
          ? [{ name: 'ZIP 压缩文件', extensions: ['zip'] }]
          : []
      });

      if (!savePath) return;

      // 保存对话框期间 WebSocket 可能已断开，重新检查
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        console.error('WebSocket disconnected during save dialog');
        alert('连接已断开，请稍后重试');
        return;
      }

      // 获取文件大小（从当前文件列表中查找）
      const fileInfo = this.files.find(f => f.name === filename);
      const fileSize = fileInfo ? fileInfo.size : 0;

      // 添加到传输历史（包含本地保存路径）
      this.currentDownloadId = this.addTransferRecord('download', filename, filePath, fileSize, savePath);
      this.updateTransferProgress(this.currentDownloadId, 0, 'inprogress');

      // 创建空文件（后续以 append 模式追加写入）
      await fsWriteFile(savePath, new Uint8Array(0));
      this.writeQueue = [];
      this.isWriting = false;
      this.writeError = null;

      this.pendingDownload = { filename, savePath, remotePath: filePath, totalSize: 0, receivedSize: 0 };

      // Send download request
      const request = JSON.stringify({ path: filePath });
      const message = this.encodeMessage(MsgFileDownloadStart, new TextEncoder().encode(request));
      try {
        this.ws.send(message);
      } catch (sendErr) {
        console.error('Failed to send download request:', sendErr);
        await this.cleanupDownload();
        if (this.currentDownloadId) {
          this.updateTransferProgress(this.currentDownloadId, 0, 'failed', '发送请求失败');
          this.currentDownloadId = null;
        }
        return;
      }

      console.log(`Downloading ${filePath} to ${savePath}`);
    } catch (err) {
      console.error('Download failed:', err);
      alert(`下载失败: ${err instanceof Error ? err.message : String(err)}`);
      await this.cleanupDownload();
      if (this.currentDownloadId) {
        this.updateTransferProgress(this.currentDownloadId, 0, 'failed', err instanceof Error ? err.message : String(err));
        this.currentDownloadId = null;
      }
    }
  }

  // 完全同步的数据块处理——缓冲小 chunk，批量推入写入队列
  private handleDownloadChunk(content: Uint8Array): void {
    if (!this.pendingDownload) {
      console.error('No pending download');
      return;
    }

    // Parse chunked protocol: [8B totalSize BE][8B offset BE][chunk_data]
    if (content.length < 16) {
      console.error('Invalid download chunk: too short');
      return;
    }

    const view = new DataView(content.buffer, content.byteOffset, content.byteLength);
    const totalSize = Number(view.getBigUint64(0));
    const offset = Number(view.getBigUint64(8));
    const chunkData = content.slice(16);

    // Update total size on first chunk
    if (this.pendingDownload.totalSize === 0 && totalSize > 0) {
      this.pendingDownload.totalSize = totalSize;
    }

    // 缓冲小 chunk，累积到 8MB 再推入写入队列
    if (chunkData.length > 0) {
      this.downloadBuffer.push(chunkData);
      this.downloadBufferSize += chunkData.length;
      this.pendingDownload.receivedSize = offset + chunkData.length;

      if (this.downloadBufferSize >= FileManager.WRITE_BATCH_SIZE) {
        this.flushDownloadBuffer();
      }
    }

    // Throttled progress UI update (~200ms interval)
    const isComplete = totalSize > 0 && this.pendingDownload.receivedSize >= totalSize;
    const now = Date.now();
    if (this.currentDownloadId && !this.isDownloadPaused && (now - this.lastDownloadProgressUpdate >= 200 || isComplete)) {
      this.lastDownloadProgressUpdate = now;
      const progress = totalSize > 0
        ? Math.round((this.pendingDownload.receivedSize / totalSize) * 100)
        : 0;
      this.updateTransferProgress(this.currentDownloadId, isComplete ? 100 : Math.min(progress, 99), 'inprogress');
    }

    // Download complete: flush remaining buffer（暂停时不 finalize，等恢复后处理）
    if (isComplete && !this.isDownloadPaused) {
      this.flushDownloadBuffer();
      this.finalizeDownload();
    }
  }

  // 将缓冲区合并为一个批次，推入写入队列
  private flushDownloadBuffer(): void {
    if (this.downloadBuffer.length === 0 || !this.pendingDownload) return;
    const merged = new Uint8Array(this.downloadBufferSize);
    let pos = 0;
    for (const chunk of this.downloadBuffer) {
      merged.set(chunk, pos);
      pos += chunk.length;
    }
    this.downloadBuffer = [];
    this.downloadBufferSize = 0;
    this.writeQueue.push(merged);
    this.processWriteQueue();
  }

  // 异步写入队列处理——独立于消息循环，逐批写入磁盘
  private async processWriteQueue(): Promise<void> {
    if (this.isWriting || !this.pendingDownload) return;
    this.isWriting = true;
    try {
      while (this.writeQueue.length > 0 && this.pendingDownload) {
        const batch = this.writeQueue.shift()!;
        await fsWriteFile(this.pendingDownload.savePath, batch, { append: true });
      }
    } catch (err) {
      console.error('Write queue failed:', err);
      this.writeError = this.getDiskErrorMessage(err);
    }
    this.isWriting = false;
  }

  // 完成下载：等待写入队列排空
  private async finalizeDownload(): Promise<void> {
    if (!this.pendingDownload) return;
    try {
      // 等待写入队列排空（通常已经几乎空了，因为写入与接收并行）
      while (this.writeQueue.length > 0 || this.isWriting) {
        await new Promise(r => setTimeout(r, 50));
      }
      if (!this.pendingDownload) return;

      // 检查写入过程中是否出错
      if (this.writeError) {
        throw new Error(this.writeError);
      }

      console.log(`File saved to ${this.pendingDownload.savePath} (${this.formatSize(this.pendingDownload.receivedSize)})`);
      if (this.currentDownloadId) {
        this.updateTransferProgress(this.currentDownloadId, 100, 'completed');
        this.currentDownloadId = null;
      }
      this.pendingDownload = null;
    } catch (err) {
      console.error('Failed to finalize download:', err);
      const errMsg = this.getDiskErrorMessage(err);
      if (this.currentDownloadId) {
        this.updateTransferProgress(this.currentDownloadId, 0, 'failed', errMsg);
        this.currentDownloadId = null;
      }
      await this.cleanupDownload();
    }
  }

  // 清理下载状态：清空队列、删除不完整文件
  private async cleanupDownload(): Promise<void> {
    if (!this.pendingDownload) return;
    const savePath = this.pendingDownload.savePath;
    // 清空缓冲和写入队列
    this.downloadBuffer = [];
    this.downloadBufferSize = 0;
    this.writeQueue = [];
    this.writeError = null;
    // 等待正在进行的写入完成
    while (this.isWriting) {
      await new Promise(r => setTimeout(r, 50));
    }
    try {
      if (await fsExists(savePath)) {
        await fsRemove(savePath);
      }
    } catch { /* ignore cleanup errors */ }
    this.pendingDownload = null;
  }

  // 格式化传输速度为人类可读字符串
  private formatSpeed(bytesPerSec: number): string {
    if (bytesPerSec <= 0) return '';
    if (bytesPerSec < 1024) return `${bytesPerSec.toFixed(0)} B/s`;
    if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
    if (bytesPerSec < 1024 * 1024 * 1024) return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
    return `${(bytesPerSec / (1024 * 1024 * 1024)).toFixed(2)} GB/s`;
  }

  // 格式化耗时为人类可读字符串
  private formatElapsed(ms: number): string {
    if (ms < 0) ms = 0;
    const totalSec = Math.floor(ms / 1000);
    if (totalSec < 60) return `${totalSec}秒`;
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    if (min < 60) return `${min}分${sec > 0 ? sec + '秒' : ''}`;
    const hr = Math.floor(min / 60);
    const remMin = min % 60;
    return `${hr}时${remMin > 0 ? remMin + '分' : ''}`;
  }

  // 将磁盘写入错误转换为用户友好的中文提示
  private getDiskErrorMessage(err: unknown): string {
    const msg = err instanceof Error ? err.message : String(err);
    const lower = msg.toLowerCase();
    if (lower.includes('no space') || lower.includes('enospc') || lower.includes('disk full') || lower.includes('not enough space')) {
      return '磁盘空间不足，下载失败';
    }
    if (lower.includes('permission denied') || lower.includes('eacces')) {
      return '没有写入权限，下载失败';
    }
    if (lower.includes('read-only') || lower.includes('erofs')) {
      return '文件系统为只读，下载失败';
    }
    return msg;
  }

  async deleteFile(path: string): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.error('WebSocket not ready');
      return;
    }

    const fullPath = this.currentPath === '/'
      ? `/${path}`
      : `${this.currentPath}/${path}`;

    const request: FileOperationRequest = {
      operation: 'delete',
      path: fullPath
    };

    const message = this.encodeMessage(MsgFileOperation, new TextEncoder().encode(JSON.stringify(request)));
    this.ws.send(message);
    console.log(`Deleting ${fullPath}`);
  }

  async renameFile(oldPath: string, newName: string): Promise<void> {
    if (!this.validateFileName(newName)) {
      alert('Invalid filename: contains illegal characters or path traversal patterns');
      return;
    }

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.error('WebSocket not ready');
      return;
    }

    const fullOldPath = this.currentPath === '/'
      ? `/${oldPath}`
      : `${this.currentPath}/${oldPath}`;

    const fullNewPath = this.currentPath === '/'
      ? `/${newName}`
      : `${this.currentPath}/${newName}`;

    const request: FileOperationRequest = {
      operation: 'rename',
      path: fullOldPath,
      new_path: fullNewPath
    };

    const message = this.encodeMessage(MsgFileOperation, new TextEncoder().encode(JSON.stringify(request)));
    this.ws.send(message);
    console.log(`Renaming ${fullOldPath} to ${fullNewPath}`);
  }

  getWebSocket(): WebSocket | null {
    return this.ws;
  }

  requestServerInfo(type: 'sysinfo' | 'processes'): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const payload = new TextEncoder().encode(JSON.stringify({ type }));
    const message = new Uint8Array(1 + payload.length);
    message[0] = MsgServerInfo;
    message.set(payload, 1);
    this.ws.send(message);
  }

  getFullPath(name: string): string {
    return this.currentPath === '/' ? `/${name}` : `${this.currentPath}/${name}`;
  }

  async createFile(name: string): Promise<void> {
    if (!this.validateFileName(name)) {
      alert('Invalid filename: contains illegal characters or path traversal patterns');
      return;
    }

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.error('WebSocket not ready');
      return;
    }

    const fullPath = this.getFullPath(name);

    const request: FileOperationRequest = {
      operation: 'touch',
      path: fullPath
    };

    const message = this.encodeMessage(MsgFileOperation, new TextEncoder().encode(JSON.stringify(request)));
    this.ws.send(message);
    console.log(`Creating file ${fullPath}`);
  }

  async createDirectory(name: string): Promise<void> {
    if (!this.validateFileName(name)) {
      alert('Invalid directory name: contains illegal characters or path traversal patterns');
      return;
    }

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.error('WebSocket not ready');
      return;
    }

    const fullPath = this.currentPath === '/'
      ? `/${name}`
      : `${this.currentPath}/${name}`;

    const request: FileOperationRequest = {
      operation: 'mkdir',
      path: fullPath
    };

    const message = this.encodeMessage(MsgFileOperation, new TextEncoder().encode(JSON.stringify(request)));
    this.ws.send(message);
    console.log(`Creating directory ${fullPath}`);
  }

  // 检查远程文件是否存在
  private checkFileExists(path: string): Promise<{ exists: boolean; is_dir?: boolean; size?: number }> {
    return new Promise((resolve) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        resolve({ exists: false });
        return;
      }

      // 设置超时保护
      const timeout = setTimeout(() => {
        this.pendingStatCallback = null;
        resolve({ exists: false });
      }, 5000);

      this.pendingStatCallback = (response: any) => {
        clearTimeout(timeout);
        resolve({
          exists: !!response.exists,
          is_dir: response.is_dir,
          size: response.size
        });
      };

      const request: FileOperationRequest = {
        operation: 'stat',
        path: path
      };
      const message = this.encodeMessage(MsgFileOperation, new TextEncoder().encode(JSON.stringify(request)));
      this.ws.send(message);
    });
  }

  // Get the drawer-content container for modal placement
  private getModalContainer(): HTMLElement {
    return this.listElement.closest('.drawer-content') as HTMLElement || document.body;
  }

  // 显示上传冲突对话框：覆盖 / 重命名 / 跳过
  private showUploadConflictDialog(filename: string): Promise<{ action: 'overwrite' | 'rename' | 'skip'; newName?: string }> {
    return new Promise((resolve) => {
      const container = this.getModalContainer();
      container.querySelector('.drawer-modal-overlay')?.remove();

      const overlay = document.createElement('div');
      overlay.className = 'drawer-modal-overlay';
      overlay.innerHTML = `
        <div class="drawer-modal">
          <div class="drawer-modal-title">文件 "${escapeHtml(filename)}" 已存在</div>
          <div style="margin-bottom:clamp(6px,2%,10px);font-size:clamp(11px,1.4vw,12px);color:var(--text-secondary);">请选择操作：</div>
          <div class="drawer-modal-buttons" style="flex-direction:column;gap:6px;">
            <button class="drawer-modal-btn confirm" data-action="overwrite" style="width:100%">覆盖</button>
            <button class="drawer-modal-btn" data-action="rename" style="width:100%">重命名</button>
            <button class="drawer-modal-btn cancel" data-action="skip" style="width:100%">跳过</button>
          </div>
        </div>
      `;

      container.appendChild(overlay);

      const close = (result: { action: 'overwrite' | 'rename' | 'skip'; newName?: string }) => {
        overlay.remove();
        resolve(result);
      };

      overlay.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const action = target.dataset.action;
        if (action === 'overwrite') {
          close({ action: 'overwrite' });
        } else if (action === 'skip') {
          close({ action: 'skip' });
        } else if (action === 'rename') {
          // 切换到重命名输入模式
          const modal = overlay.querySelector('.drawer-modal') as HTMLElement;
          const ext = filename.includes('.') ? '.' + filename.split('.').pop() : '';
          const base = ext ? filename.slice(0, -ext.length) : filename;
          const suggestName = `${base}_copy${ext}`;
          modal.innerHTML = `
            <div class="drawer-modal-title">重命名上传文件</div>
            <input class="drawer-modal-input" type="text" value="${escapeHtml(suggestName)}" spellcheck="false" />
            <div class="drawer-modal-buttons">
              <button class="drawer-modal-btn cancel">取消</button>
              <button class="drawer-modal-btn confirm">确定</button>
            </div>
          `;
          const input = modal.querySelector('.drawer-modal-input') as HTMLInputElement;
          const confirmBtn = modal.querySelector('.drawer-modal-btn.confirm') as HTMLButtonElement;
          const cancelBtn = modal.querySelector('.drawer-modal-btn.cancel') as HTMLButtonElement;
          input.focus();
          input.select();
          input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && input.value.trim()) close({ action: 'rename', newName: input.value.trim() });
            if (e.key === 'Escape') close({ action: 'skip' });
          });
          confirmBtn.addEventListener('click', () => {
            if (input.value.trim()) close({ action: 'rename', newName: input.value.trim() });
          });
          cancelBtn.addEventListener('click', () => close({ action: 'skip' }));
        }
      });
    });
  }

  // 显示文件夹冲突对话框：合并 / 重命名 / 跳过
  private showDirConflictDialog(dirName: string): Promise<{ action: 'merge' | 'rename' | 'skip'; newName?: string }> {
    return new Promise((resolve) => {
      const container = this.getModalContainer();
      container.querySelector('.drawer-modal-overlay')?.remove();

      const overlay = document.createElement('div');
      overlay.className = 'drawer-modal-overlay';
      overlay.innerHTML = `
        <div class="drawer-modal">
          <div class="drawer-modal-title">文件夹 "${escapeHtml(dirName)}" 已存在</div>
          <div style="margin-bottom:clamp(6px,2%,10px);font-size:clamp(11px,1.4vw,12px);color:var(--text-secondary);">请选择操作：</div>
          <div class="drawer-modal-buttons" style="flex-direction:column;gap:6px;">
            <button class="drawer-modal-btn confirm" data-action="merge" style="width:100%">合并</button>
            <button class="drawer-modal-btn" data-action="rename" style="width:100%">重命名</button>
            <button class="drawer-modal-btn cancel" data-action="skip" style="width:100%">跳过</button>
          </div>
        </div>
      `;

      container.appendChild(overlay);

      const close = (result: { action: 'merge' | 'rename' | 'skip'; newName?: string }) => {
        overlay.remove();
        resolve(result);
      };

      overlay.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const action = target.dataset.action;
        if (action === 'merge') {
          close({ action: 'merge' });
        } else if (action === 'skip') {
          close({ action: 'skip' });
        } else if (action === 'rename') {
          const modal = overlay.querySelector('.drawer-modal') as HTMLElement;
          modal.innerHTML = `
            <div class="drawer-modal-title">重命名上传文件夹</div>
            <input class="drawer-modal-input" type="text" value="${escapeHtml(dirName)}_copy" spellcheck="false" />
            <div class="drawer-modal-buttons">
              <button class="drawer-modal-btn cancel">取消</button>
              <button class="drawer-modal-btn confirm">确定</button>
            </div>
          `;
          const input = modal.querySelector('.drawer-modal-input') as HTMLInputElement;
          const confirmBtn = modal.querySelector('.drawer-modal-btn.confirm') as HTMLButtonElement;
          const cancelBtn = modal.querySelector('.drawer-modal-btn.cancel') as HTMLButtonElement;
          input.focus();
          input.select();
          input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && input.value.trim()) close({ action: 'rename', newName: input.value.trim() });
            if (e.key === 'Escape') close({ action: 'skip' });
          });
          confirmBtn.addEventListener('click', () => {
            if (input.value.trim()) close({ action: 'rename', newName: input.value.trim() });
          });
          cancelBtn.addEventListener('click', () => close({ action: 'skip' }));
        }
      });
    });
  }

  private initializeColumnResize(): void {
    // 获取表格元素
    const table = this.listElement.closest('table');
    if (!table) return;

    const thead = table.querySelector('thead');
    if (!thead) return;

    const ths = thead.querySelectorAll('th');

    ths.forEach((th, index) => {
      const resizer = th.querySelector('.column-resizer');
      if (!resizer) return;

      let startX = 0;
      let startWidth = 0;

      const onMouseDown = (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();

        startX = e.pageX;
        startWidth = th.offsetWidth;

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);

        // 添加拖动状态样式
        document.body.style.cursor = 'col-resize';
        resizer.classList.add('resizing');
      };

      const onMouseMove = (e: MouseEvent) => {
        const diff = e.pageX - startX;
        const newWidth = Math.max(50, startWidth + diff); // 最小宽度50px
        th.style.width = `${newWidth}px`;
      };

      const onMouseUp = () => {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);

        // 移除拖动状态样式
        document.body.style.cursor = '';
        resizer.classList.remove('resizing');
      };

      resizer.addEventListener('mousedown', onMouseDown as EventListener);
    });
  }

  private initializeSorting(): void {
    const table = this.listElement.closest('table');
    if (!table) return;

    const thead = table.querySelector('thead');
    if (!thead) return;

    const sortableHeaders = thead.querySelectorAll('th.sortable');

    sortableHeaders.forEach((th) => {
      th.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        // 如果点击的是 resizer，不触发排序
        if (target.classList.contains('column-resizer') || target.closest('.column-resizer')) {
          return;
        }

        const column = th.getAttribute('data-column');
        if (!column) return;

        // 更新排序状态：null -> asc -> desc -> null
        if (this.sortColumn === column) {
          if (this.sortDirection === 'asc') {
            this.sortDirection = 'desc';
          } else if (this.sortDirection === 'desc') {
            this.sortColumn = null;
            this.sortDirection = null;
          }
        } else {
          this.sortColumn = column;
          this.sortDirection = 'asc';
        }

        // 更新箭头显示
        this.updateSortArrows();

        // 重新渲染列表
        this.renderFileList();
      });
    });
  }

  private updateSortArrows(): void {
    const table = this.listElement.closest('table');
    if (!table) return;

    const thead = table.querySelector('thead');
    if (!thead) return;

    const sortableHeaders = thead.querySelectorAll('th.sortable');

    sortableHeaders.forEach((th) => {
      const column = th.getAttribute('data-column');
      const arrows = th.querySelector('.sort-arrows');
      if (!arrows) return;

      const ascArrow = arrows.querySelector('.sort-asc');
      const descArrow = arrows.querySelector('.sort-desc');

      if (column === this.sortColumn) {
        th.classList.add('sorting');
        if (this.sortDirection === 'asc') {
          ascArrow?.classList.add('active');
          descArrow?.classList.remove('active');
        } else if (this.sortDirection === 'desc') {
          ascArrow?.classList.remove('active');
          descArrow?.classList.add('active');
        }
      } else {
        th.classList.remove('sorting');
        ascArrow?.classList.remove('active');
        descArrow?.classList.remove('active');
      }
    });
  }

  /** 设置当前活跃的 drag-drop 目标实例（由 DrawerManager 在 drawer 打开时调用）。
   *  全局只有一个监听器，事件仅派发到活跃实例，避免分屏时重复上传。
   */
  static setActiveDragDropTarget(fm: FileManager | null): void {
    _activeDragDropInstance = fm;
  }

  private initializeDragAndDrop(): void {
    // 全局只注册一次 onDragDropEvent 监听器，防止多个 FileManager 实例（分屏时）各自
    // 注册导致同一个文件被上传多次。
    if (_dragDropListenerRegistered) {
      console.log('🎯 Drag-drop listener already registered globally, skipping.');
      return;
    }
    _dragDropListenerRegistered = true;
    console.log('🎯 Registering global Tauri v2 drag-drop listener...');

    const appWindow = getCurrentWebviewWindow();
    appWindow.onDragDropEvent(async (event) => {
      // 仅向当前活跃的 FileManager 实例派发事件
      const target = _activeDragDropInstance;
      if (!target) return;
      await target.handleDragEvent(event.payload as { type: string; paths?: string[] });
    }).then(() => console.log('✅ Tauri v2 drag-drop listener registered'));
  }

  /** 处理单次 drag-drop 事件（由全局监听器调用）。 */
  private async handleDragEvent(payload: { type: string; paths?: string[] }): Promise<void> {
    const fileListContainer = this.listElement.closest('.file-list');
    const { type } = payload;

    if (type === 'enter' || type === 'over') {
      if (fileListContainer) {
        fileListContainer.classList.add('drag-over');
      }
      if (type === 'enter') {
        console.log('🔵 File drag enter detected, paths:', payload.paths);
      }
    } else if (type === 'leave') {
      console.log('🟠 File drag leave');
      if (fileListContainer) {
        fileListContainer.classList.remove('drag-over');
      }
    } else if (type === 'drop') {
      console.log('🟢 File drop event received!');
      if (fileListContainer) {
        fileListContainer.classList.remove('drag-over');
      }

      const filePaths = payload.paths ?? [];
      console.log('   Files:', filePaths);

      if (filePaths.length === 0) {
        console.warn('No files dropped');
        return;
      }

      for (const filePath of filePaths) {
        try {
          const info = await fsStat(filePath);
          if (info.isDirectory) {
            // 递归收集目录下所有文件并上传
            const dirName = filePath.replace(/\\/g, '/').split('/').pop() || 'unknown';
            await this.uploadDirectory(filePath, dirName);
          } else {
            const fileName = filePath.replace(/\\/g, '/').split('/').pop() || 'unknown';
            if (!this.validateFileName(fileName)) {
              console.warn(`Skipping invalid filename: ${fileName}`);
              continue;
            }
            const content = await readFile(filePath);
            await this.uploadFile(fileName, content);
          }
        } catch (err) {
          console.error(`Failed to upload file ${filePath}:`, err);
        }
      }
    }
  }

  // 从 localStorage 恢复传输历史
  private loadTransferHistory(): void {
    try {
      const data = localStorage.getItem(FileManager.STORAGE_KEY);
      if (data) {
        this.transferHistory = JSON.parse(data);
        // 将重启前仍在进行中的任务标记为失败
        for (const record of this.transferHistory) {
          if (record.status === 'inprogress' || record.status === 'pending' || record.status === 'paused') {
            record.status = 'failed';
            record.error = '应用重启，传输中断';
          }
        }
        this.saveTransferHistory();
      }
    } catch (err) {
      console.error('Failed to load transfer history:', err);
    }
  }

  // 保存传输历史到 localStorage
  private saveTransferHistory(): void {
    try {
      localStorage.setItem(FileManager.STORAGE_KEY, JSON.stringify(this.transferHistory));
    } catch (err) {
      console.error('Failed to save transfer history:', err);
    }
  }

  // 清空已完成的传输历史（保留进行中/暂停/等待中的记录）
  clearTransferHistory(): void {
    this.transferHistory = this.transferHistory.filter(
      r => r.status === 'inprogress' || r.status === 'paused' || r.status === 'pending'
    );
    this.saveTransferHistory();
    this.lastVirtualRange = null;
    this.renderTransferHistory();
  }

  // 添加传输记录到历史
  private addTransferRecord(type: 'upload' | 'download', filename: string, path: string, size: number, savePath?: string): string {
    const id = `${type}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const record: (typeof this.transferHistory)[number] = {
      id,
      type,
      filename,
      path,
      size,
      progress: 0,
      status: 'pending' as const,
      timestamp: Date.now(),
      savePath,
    };

    this.transferHistory.unshift(record);

    // 限制历史记录数量
    if (this.transferHistory.length > this.maxHistoryLength) {
      this.transferHistory = this.transferHistory.slice(0, this.maxHistoryLength);
    }

    this.saveTransferHistory();
    document.dispatchEvent(new CustomEvent('status-bar-transfer', {
      detail: { sessionId: this.sessionId, id, type, progress: 0, status: 'pending' }
    }));
    return id;
  }

  // 更新传输进度
  private updateTransferProgress(id: string, progress: number, status: 'pending' | 'inprogress' | 'completed' | 'failed' | 'paused' | 'cancelled', error?: string): void {
    const record = this.transferHistory.find(r => r.id === id);
    if (record) {
      const statusChanged = record.status !== status;
      record.progress = progress;
      record.status = status;
      if (error) {
        record.error = error;
      }

      // 记录传输时间节点
      if (statusChanged) {
        if (status === 'inprogress' && !record.startTime) {
          record.startTime = Date.now();
        }
        if (status === 'completed' || status === 'failed' || status === 'cancelled') {
          record.endTime = Date.now();
          this.speedTracker.delete(id);
        }
        if (status === 'paused') {
          // 暂停时冻结速度显示
          this.speedTracker.delete(id);
        }
      }

      // 更新速度跟踪（仅 inprogress 状态）
      if (status === 'inprogress' && record.size > 0) {
        const now = Date.now();
        const currentBytes = Math.round(record.size * progress / 100);
        const tracker = this.speedTracker.get(id);
        if (tracker) {
          const dt = (now - tracker.lastTime) / 1000; // 秒
          if (dt >= 0.5) { // 至少 500ms 才更新速度，避免抖动
            const db = currentBytes - tracker.lastBytes;
            tracker.speed = db > 0 ? db / dt : 0;
            tracker.lastBytes = currentBytes;
            tracker.lastTime = now;
          }
        } else {
          this.speedTracker.set(id, { lastBytes: currentBytes, lastTime: now, speed: 0 });
        }
      }

      // 仅在状态变更时持久化，避免进度更新时高频写入
      if (statusChanged) {
        this.saveTransferHistory();
      }
      // 如果历史视图当前可见，更新 UI
      const historyContainer = document.getElementById(`transfer-history-${this.sessionId}`);
      if (historyContainer && historyContainer.style.display !== 'none') {
        if (statusChanged) {
          // 状态变更：全量重绘（按钮、样式、结构都会变）
          this.renderTransferHistory();
        } else {
          // 仅进度变化：原地更新进度条、百分比、速度和用时
          this.updateProgressInPlace(id, progress);
        }
      }
      document.dispatchEvent(new CustomEvent('status-bar-transfer', {
        detail: { sessionId: this.sessionId, id, type: record.type, progress, status }
      }));
    }
  }

  // 原地更新进度条，不触发全量重绘
  private updateProgressInPlace(id: string, progress: number): void {
    const historyContainer = document.getElementById(`history-list-${this.sessionId}`);
    if (!historyContainer) return;
    const item = historyContainer.querySelector(`[data-transfer-id="${id}"]`);
    if (!item) return;
    const fill = item.querySelector('.progress-fill') as HTMLElement | null;
    if (fill) fill.style.width = `${progress}%`;
    const text = item.querySelector('.progress-text');
    if (text) text.textContent = `${progress}%`;

    // 更新速度显示
    const tracker = this.speedTracker.get(id);
    let speedEl = item.querySelector('.transfer-speed') as HTMLElement | null;
    const speedStr = tracker ? this.formatSpeed(tracker.speed) : '';
    if (speedStr) {
      if (!speedEl) {
        speedEl = document.createElement('span');
        speedEl.className = 'transfer-speed';
        const footer = item.querySelector('.history-footer');
        const statusEl = footer?.querySelector('.status-indicator');
        if (footer && statusEl) footer.insertBefore(speedEl, statusEl.nextSibling);
      }
      if (speedEl) speedEl.textContent = speedStr;
    } else if (speedEl) {
      speedEl.textContent = '';
    }

    // 更新用时显示
    const record = this.transferHistory.find(r => r.id === id);
    if (record?.startTime) {
      let elapsedEl = item.querySelector('.transfer-elapsed') as HTMLElement | null;
      if (!elapsedEl) {
        elapsedEl = document.createElement('span');
        elapsedEl.className = 'transfer-elapsed';
        const footer = item.querySelector('.history-footer');
        const afterEl = speedEl || footer?.querySelector('.status-indicator');
        if (footer && afterEl) footer.insertBefore(elapsedEl, afterEl.nextSibling);
      }
      if (elapsedEl) elapsedEl.textContent = this.formatElapsed(Date.now() - record.startTime);
    }
  }

  // 暂停当前传输
  pauseTransfer(id: string): void {
    const record = this.transferHistory.find(r => r.id === id);
    if (!record || record.status !== 'inprogress') return;

    if (record.type === 'upload' && this.currentUploadId === id) {
      this.isUploadPaused = true;
      this.updateTransferProgress(id, record.progress, 'paused');
    } else if (record.type === 'download' && this.currentDownloadId === id) {
      this.isDownloadPaused = true;
      // 通知服务端暂停推送
      this.sendDownloadCtrl(MsgFileDownloadPause);
      this.updateTransferProgress(id, record.progress, 'paused');
    }
  }

  // 继续已暂停的传输
  resumeTransfer(id: string): void {
    const record = this.transferHistory.find(r => r.id === id);
    if (!record || record.status !== 'paused') return;

    if (record.type === 'upload' && this.currentUploadId === id) {
      this.isUploadPaused = false;
      this.updateTransferProgress(id, record.progress, 'inprogress');
      // 继续发送上传块
      this.sendUploadChunk();
    } else if (record.type === 'download' && this.currentDownloadId === id) {
      this.isDownloadPaused = false;
      // 通知服务端恢复推送
      this.sendDownloadCtrl(MsgFileDownloadContinue);

      // 恢复后用实际进度
      const dl = this.pendingDownload;
      if (dl && dl.totalSize > 0) {
        const actualProgress = Math.min(Math.round((dl.receivedSize / dl.totalSize) * 100), 99);
        // 重新初始化 speedTracker
        const currentBytes = Math.round(record.size * actualProgress / 100);
        this.speedTracker.set(id, { lastBytes: currentBytes, lastTime: Date.now(), speed: 0 });
        this.updateTransferProgress(id, actualProgress, 'inprogress');
      } else {
        this.updateTransferProgress(id, record.progress, 'inprogress');
      }
    }
  }

  // 取消传输
  cancelTransfer(id: string): void {
    const record = this.transferHistory.find(r => r.id === id);
    if (!record || (record.status !== 'inprogress' && record.status !== 'paused' && record.status !== 'pending')) return;

    if (record.type === 'upload') {
      if (this.currentUploadId === id) {
        this.isUploadPaused = false;
        this.pendingUpload = null;
        this.inFlightChunks = 0;
        this.currentUploadId = null;
        this.updateTransferProgress(id, record.progress, 'cancelled', '用户取消');
        // 删除远程 .meterm.part 临时文件
        this.deleteRemotePartFile(record.path);
        // 继续处理上传队列
        this.processNextUpload();
      } else {
        // 还在队列中，通过路径匹配移除
        const queueIdx = this.uploadQueue.findIndex(item => item.path === record.path);
        if (queueIdx !== -1) {
          this.uploadQueue.splice(queueIdx, 1);
        }
        this.updateTransferProgress(id, 0, 'cancelled', '用户取消');
      }
    } else if (record.type === 'download' && this.currentDownloadId === id) {
      this.isDownloadPaused = false;
      // 通知服务端取消
      this.sendDownloadCtrl(MsgFileDownloadCancel);
      this.currentDownloadId = null;
      this.updateTransferProgress(id, record.progress, 'cancelled', '用户取消');
      this.cleanupDownload();
    }
  }

  // 发送下载流控消息给服务端
  private sendDownloadCtrl(msgType: number): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(this.encodeMessage(msgType, new Uint8Array(0)));
    } catch { /* ignore */ }
  }

  // 删除远程 .meterm.part 临时文件
  private deleteRemotePartFile(remotePath: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.pendingPartCleanup = true;
    const partPath = remotePath + '.meterm.part';
    const request: FileOperationRequest = { operation: 'delete', path: partPath };
    const message = this.encodeMessage(MsgFileOperation, new TextEncoder().encode(JSON.stringify(request)));
    this.ws.send(message);
    console.log(`Cleaning up remote temp file: ${partPath}`);
  }

  // 在系统文件管理器中显示下载文件
  async revealInFileManager(savePath: string): Promise<void> {
    try {
      const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
      await revealItemInDir(savePath);
    } catch (err) {
      console.error('Failed to reveal in file manager:', err);
    }
  }

  // 虚拟滚动相关
  private static readonly ITEM_HEIGHT = 95; // 卡片估算高度(px)，含 margin
  private static readonly VIRTUAL_BUFFER = 5; // 上下缓冲区卡片数
  private virtualScrollBound = false;
  private lastVirtualRange: { start: number; end: number } | null = null;

  // 生成单条传输记录的 HTML
  private renderTransferItem(record: (typeof this.transferHistory)[number]): string {
    const typeIcon = record.type === 'upload' ? '↑' : '↓';
    const statusClass = record.status;
    const statusText: Record<string, string> = {
      'pending': '等待中',
      'inprogress': '进行中',
      'completed': '已完成',
      'failed': '失败',
      'paused': '已暂停',
      'cancelled': '已取消'
    };

    const date = new Date(record.timestamp).toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });

    const progressBar = (record.status === 'inprogress' || record.status === 'paused')
      ? `<div class="progress-bar${record.status === 'paused' ? ' paused' : ''}">
           <div class="progress-fill${record.status === 'paused' ? ' paused' : ''}" style="width: ${record.progress}%"></div>
         </div>
         <span class="progress-text">${record.progress}%</span>`
      : '';

    let actionButtons = '';
    if (record.status === 'inprogress') {
      actionButtons = `<div class="transfer-actions">
        <button class="transfer-btn pause-btn" data-id="${record.id}" title="暂停">⏸</button>
        <button class="transfer-btn cancel-btn" data-id="${record.id}" title="取消">✕</button>
      </div>`;
    } else if (record.status === 'paused') {
      actionButtons = `<div class="transfer-actions">
        <button class="transfer-btn resume-btn" data-id="${record.id}" title="继续">▶</button>
        <button class="transfer-btn cancel-btn" data-id="${record.id}" title="取消">✕</button>
      </div>`;
    } else if (record.status === 'pending') {
      actionButtons = `<div class="transfer-actions">
        <button class="transfer-btn cancel-btn" data-id="${record.id}" title="取消">✕</button>
      </div>`;
    }

    let speedHtml = '';
    let elapsedHtml = '';
    if (record.status === 'inprogress') {
      const tracker = this.speedTracker.get(record.id);
      const speedStr = tracker ? this.formatSpeed(tracker.speed) : '';
      if (speedStr) speedHtml = `<span class="transfer-speed">${speedStr}</span>`;
      if (record.startTime) {
        elapsedHtml = `<span class="transfer-elapsed">${this.formatElapsed(Date.now() - record.startTime)}</span>`;
      }
    } else if (record.status === 'paused' && record.startTime) {
      elapsedHtml = `<span class="transfer-elapsed">${this.formatElapsed(Date.now() - record.startTime)}</span>`;
    } else if ((record.status === 'completed' || record.status === 'failed' || record.status === 'cancelled') && record.startTime) {
      const end = record.endTime || Date.now();
      elapsedHtml = `<span class="transfer-elapsed">${this.formatElapsed(end - record.startTime)}</span>`;
    }

    const localPathHtml = (record.type === 'download' && record.savePath && record.status === 'completed')
      ? `<span class="save-path clickable" data-save-path="${escapeHtml(record.savePath)}" title="在文件管理器中打开: ${escapeHtml(record.savePath)}">📂 ${escapeHtml(record.savePath)}</span>`
      : '';

    const errorMsg = record.error
      ? `<div class="error-message">${escapeHtml(record.error)}</div>`
      : '';

    return `
      <div class="history-item ${statusClass}" data-transfer-id="${record.id}">
        <div class="history-header">
          <span class="type-icon">${typeIcon}</span>
          <span class="filename">${escapeHtml(record.filename)}</span>
          <span class="file-size">${this.formatSize(record.size)}</span>
          ${actionButtons}
        </div>
        <div class="history-details">
          <span class="file-path">${escapeHtml(record.path)}</span>
          <span class="transfer-time">${date}</span>
        </div>
        ${progressBar}
        <div class="history-footer">
          <span class="status-indicator ${statusClass}">${statusText[record.status] || record.status}</span>
          ${speedHtml}${elapsedHtml}
          ${localPathHtml}
        </div>
        ${errorMsg}
      </div>
    `;
  }

  // 渲染传输历史列表（虚拟滚动）
  renderTransferHistory(): void {
    const historyList = document.getElementById(`history-list-${this.sessionId}`);
    if (!historyList) {
      console.warn('History container not found');
      return;
    }

    if (this.transferHistory.length === 0) {
      historyList.innerHTML = `
        <div class="empty-history">
          <p>暂无上传下载记录</p>
        </div>
      `;
      this.lastVirtualRange = null;
      return;
    }

    const scrollContainer = historyList.parentElement as HTMLElement; // .transfer-history
    if (!scrollContainer) return;

    // 绑定滚动事件（只绑定一次）
    if (!this.virtualScrollBound) {
      this.virtualScrollBound = true;
      scrollContainer.addEventListener('scroll', () => this.updateVirtualSlice());
      this.ensureTransferDelegation(historyList);
    }

    // 强制重算可见区域
    this.lastVirtualRange = null;
    this.updateVirtualSlice();
  }

  // 计算并渲染可见范围的卡片
  private updateVirtualSlice(): void {
    const historyList = document.getElementById(`history-list-${this.sessionId}`);
    if (!historyList) return;
    const scrollContainer = historyList.parentElement as HTMLElement;
    if (!scrollContainer) return;

    const total = this.transferHistory.length;
    const itemH = FileManager.ITEM_HEIGHT;
    const buffer = FileManager.VIRTUAL_BUFFER;

    const scrollTop = scrollContainer.scrollTop;
    const viewHeight = scrollContainer.clientHeight;

    const startIdx = Math.max(0, Math.floor(scrollTop / itemH) - buffer);
    const endIdx = Math.min(total, Math.ceil((scrollTop + viewHeight) / itemH) + buffer);

    // 如果可见范围未变化，跳过重绘
    if (this.lastVirtualRange && this.lastVirtualRange.start === startIdx && this.lastVirtualRange.end === endIdx) {
      return;
    }
    this.lastVirtualRange = { start: startIdx, end: endIdx };

    // 总高度撑开滚动区域
    const totalHeight = total * itemH;
    const topPad = startIdx * itemH;

    historyList.style.height = `${totalHeight}px`;
    historyList.style.paddingTop = `${topPad}px`;
    historyList.style.boxSizing = 'border-box';

    // 只渲染可见范围的卡片
    const slice = this.transferHistory.slice(startIdx, endIdx);
    historyList.innerHTML = slice.map(r => this.renderTransferItem(r)).join('');
  }

  // 事件委托：只在容器上绑定一次，通过冒泡匹配目标
  private transferDelegationBound = new WeakSet<HTMLElement>();
  private ensureTransferDelegation(container: HTMLElement): void {
    if (this.transferDelegationBound.has(container)) return;
    this.transferDelegationBound.add(container);

    container.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;

      // 暂停按钮
      const pauseBtn = target.closest('.pause-btn') as HTMLElement | null;
      if (pauseBtn?.dataset.id) {
        e.stopPropagation();
        this.pauseTransfer(pauseBtn.dataset.id);
        return;
      }

      // 继续按钮
      const resumeBtn = target.closest('.resume-btn') as HTMLElement | null;
      if (resumeBtn?.dataset.id) {
        e.stopPropagation();
        this.resumeTransfer(resumeBtn.dataset.id);
        return;
      }

      // 取消按钮
      const cancelBtn = target.closest('.cancel-btn') as HTMLElement | null;
      if (cancelBtn?.dataset.id) {
        e.stopPropagation();
        this.cancelTransfer(cancelBtn.dataset.id);
        return;
      }

      // 可点击的保存路径
      const savePath = target.closest('.save-path.clickable') as HTMLElement | null;
      if (savePath?.dataset.savePath) {
        e.stopPropagation();
        this.revealInFileManager(savePath.dataset.savePath);
        return;
      }
    });
  }
}
