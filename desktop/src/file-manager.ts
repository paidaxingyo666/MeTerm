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
import { formatSize, formatSpeed, formatElapsed, encodeMessage, getDiskErrorMessage, validateFileName } from './file-utils';
import { showUploadConflictDialog as _showUploadConflictDialog, showDirConflictDialog as _showDirConflictDialog } from './file-conflict-dialog';
import { PathAutocomplete } from './file-autocomplete';
import { TransferHistoryManager } from './file-transfer-history';
import {
  adaptPipeline as _adaptPipeline,
  sendMkdirRequest, collectLocalFiles as _collectLocalFiles,
} from './file-upload';
import {
  type DownloadState,
  createDownloadState,
  downloadFile as _downloadFile,
  handleDownloadChunk as _handleDownloadChunk,
  cleanupDownloadState as _cleanupDownloadState,
  resumeDownload as _resumeDownload,
} from './file-download';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { readFile, stat as fsStat, readDir } from '@tauri-apps/plugin-fs';

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
  // 下载状态（委托到 file-download 模块）
  private _dlState: DownloadState = createDownloadState();
  private pendingUpload: { path: string; content: Uint8Array; offset: number } | null = null;
  // Number of upload chunks sent to server but not yet ACKed.
  private inFlightChunks: number = 0;
  // Dynamic pipeline depth: starts at 2 and grows via TCP-style slow-start / linear increase.
  // Adapts automatically — low on high-latency links at first, then expands to saturate bandwidth.
  private pipelineSize: number = 2;
  // ACK count since last pipeline increase (used for linear phase).
  private pipelineAckCount: number = 0;
  private uploadQueue: Array<{ path: string; content: Uint8Array; filename: string; size: number }> = [];
  private isUploadPaused: boolean = false;
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
  // 传输历史管理（委托到 TransferHistoryManager）
  private _transferHistory: TransferHistoryManager | null = null;
  private pendingStatCallback: ((response: any) => void) | null = null;
  private pendingMkdirResolve: (() => void) | null = null;
  onServerInfo: ((data: ServerInfoResponse) => void) | null = null;
  // 首次目录加载完成后的一次性回调（用于 JumpServer 自动进入子目录）
  onFirstLoad: ((files: FileInfo[], path: string) => void) | null = null;
  // JumpServer 模式：LIST_FAILED 静默处理不弹 alert（Koko SFTP 初始化延迟）
  suppressListErrors = false;

  // 路径自动补全（委托到 PathAutocomplete 模块）
  private _autocomplete: PathAutocomplete | null = null;

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

    // 初始化传输历史管理器
    this._transferHistory = new TransferHistoryManager(sessionId);
    this._transferHistory.setDelegate({
      pauseUpload: (id) => this.pauseTransfer(id),
      resumeUpload: (id) => this.resumeTransfer(id),
      cancelUpload: (id) => this.cancelTransfer(id),
      pauseDownload: (id) => this.pauseTransfer(id),
      resumeDownload: (id) => this.resumeTransfer(id),
      cancelDownload: (id) => this.cancelTransfer(id),
      revealInFileManager: (savePath) => this.revealInFileManager(savePath),
    });

    // 初始化路径自动补全
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    this._autocomplete = new PathAutocomplete(pathInput, {
      get ws() { return self.ws; },
      get currentPath() { return self.currentPath; },
      get files() { return self.files; },
      get isLoadingDirectory() { return self.isLoadingDirectory; },
      loadDirectory: (path: string) => self.loadDirectory(path),
    });

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
    if (this._dlState.pendingDownload) {
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
          _handleDownloadChunk(payload, this._dlState, this._dlCallbacks());
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
      if (this._autocomplete?.autocompleteResolve && !this.isLoadingDirectory) {
        isAutocompleteResponse = true;
        const resolve = this._autocomplete.autocompleteResolve;
        this._autocomplete.autocompleteResolve = null;
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

        // 触发一次性首次加载回调（用于 JumpServer 自动进入资产子目录）
        // 必须在 isLoadingDirectory 重置后触发，否则后续 loadDirectory 会被防抖拦截
        if (this.onFirstLoad) {
          const cb = this.onFirstLoad;
          this.onFirstLoad = null;
          cb(this.files, this.currentPath);
        }
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
      if (this._dlState.pendingDownload) {
        if (this._dlState.currentDownloadId) {
          this.updateTransferProgress(this._dlState.currentDownloadId, 0, 'failed', error.message);
          this._dlState.currentDownloadId = null;
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
        if (this.suppressListErrors) {
          console.warn('⏭️ JumpServer SFTP 不可用，已静默:', error.message);
          return;
        }
        userMessage = 'SSH 文件系统未就绪\n请确保已成功连接到 SSH 服务器';
      } else if (error.code === 'LIST_FAILED') {
        if (this.suppressListErrors) {
          console.warn('⏭️ JumpServer SFTP 列目录错误已静默:', error.message);
          return;
        }
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
    return formatSize(bytes);
  }

  private encodeMessage(type: number, payload: Uint8Array): Uint8Array {
    return encodeMessage(type, payload);
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

  // ===================== 路径自动补全（委托到 PathAutocomplete） =====================

  private dirCachePut(path: string, files: FileInfo[]): void {
    this._autocomplete?.dirCachePut(path, files);
  }

  setupPathAutocomplete(): void {
    this._autocomplete?.setup();
  }

  isAutocompleteOpen(): boolean {
    return this._autocomplete?.isOpen() ?? false;
  }

  hideAutocomplete(): void {
    this._autocomplete?.hide();
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
    return validateFileName(name);
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

  private collectLocalFiles(basePath: string, relativePath: string): Promise<Array<{ localPath: string; relativePath: string }>> {
    return _collectLocalFiles(basePath, relativePath);
  }

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

      sendMkdirRequest(this.ws, remotePath);
    });
  }

  private adaptPipeline(): void {
    const result = _adaptPipeline({
      inFlightChunks: this.inFlightChunks,
      pipelineSize: this.pipelineSize,
      pipelineAckCount: this.pipelineAckCount,
    });
    this.pipelineSize = result.pipelineSize;
    this.pipelineAckCount = result.pipelineAckCount;
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
    await _resumeDownload(this.ws, this._dlState, this._dlCallbacks());
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

  private currentUploadId: string | null = null;

  private async downloadFile(filename: string, isDir: boolean = false): Promise<void> {
    this._dlState = await _downloadFile(filename, this.currentPath, this.files, this.ws, this._dlState, this._dlCallbacks(), isDir);
  }

  private async cleanupDownload(): Promise<void> {
    await _cleanupDownloadState(this._dlState);
  }

  /** 构造下载回调对象——桥接 file-download 模块与 FileManager 实例 */
  private _dlCallbacks() {
    return {
      updateTransferProgress: (id: string, progress: number, status: 'pending' | 'inprogress' | 'completed' | 'failed' | 'paused' | 'cancelled', error?: string) => {
        this.updateTransferProgress(id, progress, status, error);
      },
      addTransferRecord: (type: 'upload' | 'download', filename: string, path: string, size: number, savePath?: string) => {
        return this.addTransferRecord(type, filename, path, size, savePath);
      },
    };
  }

  private formatSpeed(bytesPerSec: number): string {
    return formatSpeed(bytesPerSec);
  }

  private formatElapsed(ms: number): string {
    return formatElapsed(ms);
  }

  private getDiskErrorMessage(err: unknown): string {
    return getDiskErrorMessage(err);
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

  private showUploadConflictDialog(filename: string): Promise<{ action: 'overwrite' | 'rename' | 'skip'; newName?: string }> {
    return _showUploadConflictDialog(filename, this.getModalContainer());
  }

  private showDirConflictDialog(dirName: string): Promise<{ action: 'merge' | 'rename' | 'skip'; newName?: string }> {
    return _showDirConflictDialog(dirName, this.getModalContainer());
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

  // ===================== 传输历史（委托到 TransferHistoryManager） =====================

  private addTransferRecord(type: 'upload' | 'download', filename: string, path: string, size: number, savePath?: string): string {
    return this._transferHistory!.addTransferRecord(type, filename, path, size, savePath);
  }

  private updateTransferProgress(id: string, progress: number, status: 'pending' | 'inprogress' | 'completed' | 'failed' | 'paused' | 'cancelled', error?: string): void {
    this._transferHistory!.updateTransferProgress(id, progress, status, error);
  }

  clearTransferHistory(): void {
    this._transferHistory!.clearTransferHistory();
  }

  renderTransferHistory(): void {
    this._transferHistory!.renderTransferHistory();
  }

  // 暂停当前传输
  pauseTransfer(id: string): void {
    const record = this._transferHistory!.findRecord(id);
    if (!record || record.status !== 'inprogress') return;

    if (record.type === 'upload' && this.currentUploadId === id) {
      this.isUploadPaused = true;
      this.updateTransferProgress(id, record.progress, 'paused');
    } else if (record.type === 'download' && this._dlState.currentDownloadId === id) {
      this._dlState.isDownloadPaused = true;
      this.sendDownloadCtrl(MsgFileDownloadPause);
      this.updateTransferProgress(id, record.progress, 'paused');
    }
  }

  // 继续已暂停的传输
  resumeTransfer(id: string): void {
    const record = this._transferHistory!.findRecord(id);
    if (!record || record.status !== 'paused') return;

    if (record.type === 'upload' && this.currentUploadId === id) {
      this.isUploadPaused = false;
      this.updateTransferProgress(id, record.progress, 'inprogress');
      this.sendUploadChunk();
    } else if (record.type === 'download' && this._dlState.currentDownloadId === id) {
      this._dlState.isDownloadPaused = false;
      this.sendDownloadCtrl(MsgFileDownloadContinue);

      const dl = this._dlState.pendingDownload;
      if (dl && dl.totalSize > 0) {
        const actualProgress = Math.min(Math.round((dl.receivedSize / dl.totalSize) * 100), 99);
        const currentBytes = Math.round(record.size * actualProgress / 100);
        this._transferHistory!.resetSpeedTracker(id, currentBytes);
        this.updateTransferProgress(id, actualProgress, 'inprogress');
      } else {
        this.updateTransferProgress(id, record.progress, 'inprogress');
      }
    }
  }

  // 取消传输
  cancelTransfer(id: string): void {
    const record = this._transferHistory!.findRecord(id);
    if (!record || (record.status !== 'inprogress' && record.status !== 'paused' && record.status !== 'pending')) return;

    if (record.type === 'upload') {
      if (this.currentUploadId === id) {
        this.isUploadPaused = false;
        this.pendingUpload = null;
        this.inFlightChunks = 0;
        this.currentUploadId = null;
        this.updateTransferProgress(id, record.progress, 'cancelled', '用户取消');
        this.deleteRemotePartFile(record.path);
        this.processNextUpload();
      } else {
        const queueIdx = this.uploadQueue.findIndex(item => item.path === record.path);
        if (queueIdx !== -1) {
          this.uploadQueue.splice(queueIdx, 1);
        }
        this.updateTransferProgress(id, 0, 'cancelled', '用户取消');
      }
    } else if (record.type === 'download' && this._dlState.currentDownloadId === id) {
      this._dlState.isDownloadPaused = false;
      this.sendDownloadCtrl(MsgFileDownloadCancel);
      this._dlState.currentDownloadId = null;
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
}
