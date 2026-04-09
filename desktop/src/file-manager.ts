import {
  MsgFileList,
  MsgFileListResp,
  MsgFileUploadStart,
  MsgFileUploadChunk,
  MsgFileDownloadChunk,
  MsgFileOperationResp,
  MsgFileOperation,
  MsgServerInfo,
  MsgError,
  MsgFileListProgress,
  MsgFileReadResponse,
  type FileInfo,
  type FileListResponse,
  type FileOperationRequest,
  type ErrorResponse,
  type FileListProgressResponse,
  type ServerInfoResponse,
} from './protocol';
import { handleFileReadResponse, handleSaveResponse } from './file-editor-bridge';
import { isMacPlatform } from './app-state';
import { encodeMessage, validateFileName, formatSize } from './file-utils';
import { PathAutocomplete } from './file-autocomplete';
import { TransferHistoryManager } from './file-transfer-history';
import {
  type DownloadState,
  type DownloadQueueItem,
} from './file-download';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import {
  renderFileList as _renderFileList,
  initializeColumnResize as _initializeColumnResize,
  initializeSorting as _initializeSorting,
  updateSortArrows as _updateSortArrows,
} from './file-list-ui';
import {
  type TransferContext,
  type ActiveUpload,
  handleDownloadChunk as _handleDownloadChunk,
  adaptPipeline as _adaptPipelineForUpload,
  sendUploadChunk as _sendUploadChunk,
  resumeUpload as _resumeUpload,
  resumeDownload as _resumeDownload,
  triggerUpload as _triggerUpload,
  uploadFile as _uploadFile,
  uploadLocalFile as _uploadLocalFile,
  processNextUpload as _processNextUpload,
  uploadDirectory as _uploadDirectory,
  downloadFile as _downloadFile,
  processNextDownload as _processNextDownload,
  dlCallbacks as _dlCallbacks,
  checkFileExists as _checkFileExists,
  resetBatchConflictState as _resetBatchConflictState,
  pauseTransfer as _pauseTransfer,
  resumeTransfer as _resumeTransfer,
  cancelTransfer as _cancelTransfer,
  sendDownloadCtrl as _sendDownloadCtrl,
  deleteRemotePartFile as _deleteRemotePartFile,
  revealInFileManager as _revealInFileManager,
  handleDragEvent as _handleDragEvent,
  failAllTransfers as _failAllTransfers,
} from './file-transfer-control';

let _dragDropListenerRegistered = false;
let _activeDragDropInstance: FileManager | null = null;

export class FileManager {
  private sessionId: string;
  private ws: WebSocket | null = null;
  private transport: import('./terminal-transport').TerminalTransport | null = null;
  private currentPath: string = '/';
  private _showHiddenFiles: boolean = false;

  private get _isConnected(): boolean {
    return !!(this.transport?.connected) || (this.ws?.readyState === WebSocket.OPEN);
  }

  private _send(data: Uint8Array): void {
    if (this.transport?.connected) {
      this.transport.send(data);
    } else if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    }
  }
  private files: FileInfo[] = [];
  /** 当前目录是否被 soft_limit 截断 */
  private listTruncated: boolean = false;
  /** 截断前的总文件数 */
  private listTotalCount: number = 0;
  private listElement: HTMLElement;
  private pathInput: HTMLInputElement;
  private activeDownloads: Map<number, DownloadState> = new Map();
  private downloadQueue: DownloadQueueItem[] = [];
  private activeUploads: Map<number, ActiveUpload> = new Map();
  private uploadQueue: Array<{ path: string; content?: Uint8Array; localFilePath?: string; filename: string; size: number; transferId: string; numTransferId: number }> = [];
  private pendingPartCleanup: boolean = false;
  private isLoadingDirectory: boolean = false;
  private loadingTimeout: ReturnType<typeof setTimeout> | null = null;
  private lastClickTime: number = 0;
  private lastClickPath: string = '';
  private loadRetryCount: number = 0;
  private loadRetryPath: string = '';
  private pendingRequestId: string | null = null;
  /** Pending raw directory load callbacks (for tree component, bypasses UI update) */
  private _rawDirCallbacks = new Map<string, { resolve: (result: { files: FileInfo[]; path: string }) => void; reject: (err: Error) => void }>();
  private loadingOverlay: HTMLElement | null = null;
  private loadingProgressBar: HTMLElement | null = null;
  private disconnectOverlay: HTMLElement | null = null;
  private pendingFileOp: boolean = false;
  private fileOpTimeout: ReturnType<typeof setTimeout> | null = null;
  private progressInterval: ReturnType<typeof setInterval> | null = null;
  private currentProgress: number = 0;
  private useRealProgress: boolean = false;
  private totalFiles: number = 0;
  private sortColumn: string | null = null;
  private sortDirection: 'asc' | 'desc' | null = null;
  private _transferHistory: TransferHistoryManager | null = null;
  private pendingStatCallback: ((response: any) => void) | null = null;
  private pendingMkdirResolve: (() => void) | null = null;
  onServerInfo: ((data: ServerInfoResponse) => void) | null = null;
  onFirstLoad: ((files: FileInfo[], path: string) => void) | null = null;
  onPathChanged: ((path: string) => void) | null = null;
  selectedFiles: Set<string> = new Set();
  lastClickedFile: string | null = null;
  suppressListErrors = false;
  private _batchFileAction: 'overwrite' | 'skip' | null = null;
  private _batchDirAction: 'merge' | 'skip' | null = null;
  private _batchUploadCount: number = 0;
  private _speedLimit: number = 0; // 0 = unlimited, bytes/s
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
    this.disconnectOverlay = loadingOverlay?.parentElement?.querySelector(`#file-disconnect-${sessionId}`) || null;

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

    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    this._autocomplete = new PathAutocomplete(pathInput, {
      get ws() { return self.ws; },
      get currentPath() { return self.currentPath; },
      get files() { return self.files; },
      get isLoadingDirectory() { return self.isLoadingDirectory; },
      loadDirectory: (path: string) => self.loadDirectory(path),
    });

    _initializeColumnResize({ listElement: this.listElement });
    _initializeSorting({
      listElement: this.listElement,
      getSortColumn: () => this.sortColumn,
      setSortColumn: (col) => { this.sortColumn = col; },
      getSortDirection: () => this.sortDirection,
      setSortDirection: (dir) => { this.sortDirection = dir; },
      renderFileList: () => this.renderFileList(),
      updateSortArrows: () => this.updateSortArrows(),
    });
    this.initializeDragAndDrop();
  }

  /** @internal — used by drag-drop and sidebar upload logic */
  _transferCtx(): TransferContext {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      sessionId: this.sessionId,
      get isConnected() { return self._isConnected; },
      send: (data) => this._send(data),
      get currentPath() { return self.currentPath; },
      get files() { return self.files; },
      get useBackendDownload() { return true; },
      get useBackendUpload() { return true; },
      get activeUploads() { return self.activeUploads; },
      get uploadQueue() { return self.uploadQueue; },
      get activeDownloads() { return self.activeDownloads; },
      get downloadQueue() { return self.downloadQueue; },
      get pendingPartCleanup() { return self.pendingPartCleanup; },
      setPendingPartCleanup: (v) => { this.pendingPartCleanup = v; },
      get pendingStatCallback() { return self.pendingStatCallback; },
      setPendingStatCallback: (v) => { this.pendingStatCallback = v; },
      get pendingMkdirResolve() { return self.pendingMkdirResolve; },
      setPendingMkdirResolve: (v) => { this.pendingMkdirResolve = v; },
      get batchFileAction() { return self._batchFileAction; },
      setBatchFileAction: (v) => { this._batchFileAction = v; },
      get batchDirAction() { return self._batchDirAction; },
      setBatchDirAction: (v) => { this._batchDirAction = v; },
      get batchUploadCount() { return self._batchUploadCount; },
      setBatchUploadCount: (v) => { this._batchUploadCount = v; },
      addTransferRecord: (type, filename, path, size, savePath) => this.addTransferRecord(type, filename, path, size, savePath),
      updateTransferProgress: (id, progress, status, error) => this.updateTransferProgress(id, progress, status, error),
      updateTransferSize: (id, size) => this._transferHistory!.updateTransferSize(id, size),
      findRecord: (id) => this._transferHistory!.findRecord(id) ?? undefined,
      resetSpeedTracker: (id, currentBytes) => this._transferHistory!.resetSpeedTracker(id, currentBytes),
      get speedLimit() { return self._speedLimit; },
      getModalContainer: () => this.getModalContainer(),
      loadDirectory: (path) => this.loadDirectory(path),
    };
  }

  showDisconnected(): void {
    if (this.disconnectOverlay) this.disconnectOverlay.style.display = '';
  }

  hideDisconnected(): void {
    if (this.disconnectOverlay) this.disconnectOverlay.style.display = 'none';
  }

  setWebSocket(ws: WebSocket): void {
    this.ws = ws;
    this._onConnected();
    this.setupMessageHandler();
    this._resumeTransfers();
  }

  setTransport(transport: import('./terminal-transport').TerminalTransport): void {
    this.transport = transport;
    this._onConnected();
    this.setupTransportMessageHandler();
    this._resumeTransfers();
  }

  private _onConnected(): void {
    this.hideDisconnected();
    if (this.isLoadingDirectory) {
      this.isLoadingDirectory = false;
      this.hideLoading();
    }
    if (this.loadingTimeout) {
      clearTimeout(this.loadingTimeout);
      this.loadingTimeout = null;
    }
    this.useRealProgress = false;
    this.totalFiles = 0;
  }

  private _resumeTransfers(): void {
    if (this.activeUploads.size > 0) {
      _resumeUpload(this._transferCtx());
    } else if (this.uploadQueue.length > 0) {
      _processNextUpload(this._transferCtx());
    }
    if (this.activeDownloads.size > 0) {
      _resumeDownload(this._transferCtx());
    } else if (this.downloadQueue.length > 0) {
      _processNextDownload(this._transferCtx());
    }
  }

  private setupMessageHandler(): void {
    if (!this.ws) return;

    const originalOnMessage = this.ws.onmessage;
    const ws = this.ws;
    this.ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        const view = new Uint8Array(event.data);
        if (view.length > 0) {
          const msgType = view[0];
          if (this.handleFileMessage(msgType, view.slice(1))) return;
        }
      }
      if (originalOnMessage) {
        originalOnMessage.call(ws, event);
      }
    };
  }

  private setupTransportMessageHandler(): void {
    if (!this.transport) return;
    const originalOnMessage = this.transport.onmessage;
    this.transport.onmessage = (data: ArrayBuffer) => {
      const view = new Uint8Array(data);
      if (view.length === 0) { originalOnMessage?.(data); return; }
      const msgType = view[0];
      if (!this.handleFileMessage(msgType, view.slice(1))) {
        originalOnMessage?.(data);
      }
    };
  }

  private handleFileMessage(msgType: number, payload: Uint8Array): boolean {
    const isFileMsg = (msgType >= 0x0a && msgType <= 0x16) || msgType === MsgFileReadResponse;

    if (msgType === MsgError) {
      this.handleError(payload);
    } else if (msgType === MsgFileListProgress) {
      this.handleFileListProgress(payload);
    } else if (msgType === MsgFileListResp) {
      this.handleFileListResponse(payload);
    } else if (msgType === MsgFileDownloadChunk) {
      // New format: [4B transferId][8B totalSize][8B offset][data]
      if (payload.length >= 4) {
        const numTid = new DataView(payload.buffer, payload.byteOffset, 4).getUint32(0);
        const ds = this.activeDownloads.get(numTid);
        if (ds) {
          _handleDownloadChunk(payload, ds, _dlCallbacks(this._transferCtx(), numTid));
        }
      }
    } else if (msgType === MsgFileUploadChunk) {
      // New ACK format: [4B transferId] (regular ACK) or [4B transferId][8B resumeOffset] (resume ACK)
      if (payload.length >= 4) {
        const ackView = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
        const numTid = ackView.getUint32(0);
        const au = this.activeUploads.get(numTid);
        if (au) {
          if (payload.length >= 12) {
            // Resume ACK: [4B tid][8B offset]
            const resumeOffset = Number(ackView.getBigUint64(4));
            au.offset = resumeOffset;
            au.inFlightChunks = 0;
            au.pipelineSize = 2;
            au.pipelineAckCount = 0;
            console.log(`Upload resume ACK (tid=${numTid}): offset ${resumeOffset}`);
            if (au.fileHandle) {
              import('@tauri-apps/plugin-fs').then(({ SeekMode }) => {
                au.fileHandle?.seek(resumeOffset, SeekMode.Start)
                  .then(() => _sendUploadChunk(this._transferCtx(), numTid))
                  .catch(err => console.error('Seek failed:', err));
              });
              return isFileMsg;
            }
          } else {
            // Regular ACK
            au.inFlightChunks = Math.max(0, au.inFlightChunks - 1);
            _adaptPipelineForUpload(au);
          }
          if (this._speedLimit > 0) {
            const delayMs = Math.max(1, Math.round(1024 * 1024 / this._speedLimit * 1000));
            setTimeout(() => _sendUploadChunk(this._transferCtx(), numTid), delayMs);
          } else {
            _sendUploadChunk(this._transferCtx(), numTid);
          }
        }
      }
    } else if (msgType === MsgFileOperationResp) {
      this.handleOperationResponse(payload);
    } else if (msgType === MsgServerInfo) {
      try {
        const data = JSON.parse(new TextDecoder().decode(payload)) as ServerInfoResponse;
        if (this.onServerInfo) this.onServerInfo(data);
      } catch (e) {
        console.error('Failed to parse server info:', e);
      }
    } else if (msgType === MsgFileReadResponse) {
      handleFileReadResponse(payload);
    }

    return isFileMsg;
  }

  async loadDirectory(path: string, options?: { loadAll?: boolean }): Promise<void> {
    if (!this._isConnected) {
      console.error('FileManager: not connected');
      alert('文件管理器未连接到服务器\n请关闭并重新打开抽屉，或刷新页面');
      return;
    }

    const loadAll = options?.loadAll === true;
    const now = Date.now();
    // 防抖跳过普通快速点击,但"加载全部"绕过防抖(否则点了无反应)
    if (!loadAll && now - this.lastClickTime < 300 && this.lastClickPath === path) {
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
    if (this.loadRetryCount === 0) {
      this.loadRetryPath = path;
    }

    this.showLoading();

    if (this.loadingTimeout) {
      clearTimeout(this.loadingTimeout);
    }

    this.loadingTimeout = setTimeout(() => {
      console.error('⏰ 目录加载超时（30秒未响应），重置状态');
      console.error('   可能原因：服务器响应慢、网络问题、或 WebSocket 消息丢失');
      this.hideLoading();
      this.isLoadingDirectory = false;
      this.loadingTimeout = null;

      if (this.loadRetryCount === 0 && this.loadRetryPath === path) {
        this.loadRetryCount = 1;
        console.log('🔄 超时自动重试 (1/1):', path);
        this.loadDirectory(path);
      } else {
        this.loadRetryCount = 0;
        this.loadRetryPath = '';
        alert('加载超时，请稍后重试');
      }
    }, 30000);

    try {
      const requestId = `fl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      this.pendingRequestId = requestId;
      // soft_limit: 默认 5000(后端超过即截断并上报 truncated/total),loadAll=true 时传 0(不限制)
      const softLimit = loadAll ? 0 : 5000;
      const request = JSON.stringify({
        path,
        request_id: requestId,
        show_hidden: this._showHiddenFiles,
        soft_limit: softLimit,
      });
      const message = this.encodeMessage(MsgFileList, new TextEncoder().encode(request));
      console.log('📤 发送目录请求到服务器，路径:', path, 'requestId:', requestId, '消息大小:', message.length, 'bytes');
      this._send(message);
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

  /**
   * Load directory contents without affecting current path/UI state.
   * Used by the file tree component for lazy-loading children.
   */
  loadDirectoryRaw(path: string): Promise<{ files: FileInfo[]; path: string }> {
    return new Promise((resolve, reject) => {
      if (!this._isConnected) {
        reject(new Error('FileManager not connected'));
        return;
      }
      const requestId = `raw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      this._rawDirCallbacks.set(requestId, { resolve, reject });

      // Auto-timeout after 30s
      setTimeout(() => {
        if (this._rawDirCallbacks.has(requestId)) {
          this._rawDirCallbacks.delete(requestId);
          reject(new Error('loadDirectoryRaw timeout'));
        }
      }, 30000);

      const request = JSON.stringify({ path, request_id: requestId, show_hidden: this._showHiddenFiles });
      const message = this.encodeMessage(MsgFileList, new TextEncoder().encode(request));
      this._send(message);
    });
  }

  private handleFileListProgress(payload: Uint8Array): void {
    try {
      const progress: FileListProgressResponse = JSON.parse(new TextDecoder().decode(payload));

      if (progress.request_id && this.pendingRequestId && progress.request_id !== this.pendingRequestId) {
        return;
      }
      console.log(`📊 收到进度更新: ${progress.loaded}/${progress.total} 文件`);

      if (!this.useRealProgress && progress.total > 0) {
        console.log('🔄 切换到真实进度模式');
        this.useRealProgress = true;
        this.totalFiles = progress.total;

        if (this.progressInterval) {
          clearInterval(this.progressInterval);
          this.progressInterval = null;
        }
      }

      if (this.useRealProgress && this.loadingProgressBar) {
        const percent = progress.total > 0 ? (progress.loaded / progress.total) * 100 : 0;
        this.loadingProgressBar.style.width = `${percent}%`;

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

      // Route to raw directory callbacks (used by file tree component)
      if (response.request_id && this._rawDirCallbacks.has(response.request_id)) {
        const cb = this._rawDirCallbacks.get(response.request_id)!;
        this._rawDirCallbacks.delete(response.request_id);
        if (response.error) {
          cb.reject(new Error(response.error));
        } else {
          this.dirCachePut(response.path, response.files);
          cb.resolve({ files: response.files, path: response.path });
        }
        return;
      }

      if (this._autocomplete?.autocompleteResolve && !this.isLoadingDirectory) {
        isAutocompleteResponse = true;
        const resolve = this._autocomplete.autocompleteResolve;
        this._autocomplete.autocompleteResolve = null;
        this.dirCachePut(response.path, response.files);
        resolve(response.files);
        return;
      }

      if (response.request_id && this.pendingRequestId && response.request_id !== this.pendingRequestId) {
        console.warn('⏭️ 忽略过期的文件列表响应, got:', response.request_id, 'want:', this.pendingRequestId);
        isAutocompleteResponse = true;
        this.dirCachePut(response.path, response.files);
        return;
      }

      // 如果服务端返回的是相对路径（如 "."），基于 currentPath 解析为绝对路径
      let resolvedPath = response.path;
      if (resolvedPath && !resolvedPath.startsWith('/')) {
        if (resolvedPath === '.') {
          resolvedPath = this.currentPath;
        } else {
          resolvedPath = this.currentPath === '/'
            ? `/${resolvedPath}`
            : `${this.currentPath}/${resolvedPath}`;
        }
      }
      console.log('📥 收到文件列表响应:', response.path, '→', resolvedPath, '文件数:', response.files.length, response.truncated ? `(已截断/总 ${response.total})` : '');
      this.dirCachePut(resolvedPath, response.files);
      this.files = response.files;
      this.listTruncated = !!response.truncated;
      this.listTotalCount = response.total ?? response.files.length;
      this.currentPath = resolvedPath;
      this.pathInput.value = resolvedPath;
      this.onPathChanged?.(resolvedPath);
      this.renderFileList();
      this.updateTruncationBanner();
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
        this.useRealProgress = false;
        this.totalFiles = 0;
        this.loadRetryCount = 0;
        this.loadRetryPath = '';
        this.pendingRequestId = null;
        console.log('✅ 目录加载完成，状态已重置');

        if (this.onFirstLoad) {
          const cb = this.onFirstLoad;
          this.onFirstLoad = null;
          cb(this.files, this.currentPath);
        }
      }
    }
  }

  private handleError(payload: Uint8Array): void {
    let error: ErrorResponse;
    let errorTransferId: number | undefined;
    try {
      const parsed = JSON.parse(new TextDecoder().decode(payload));
      error = parsed as ErrorResponse;
      errorTransferId = typeof parsed.transferId === 'number' ? parsed.transferId : undefined;
    } catch {
      // Rust encode_error() format: [code: u8][message: UTF-8] (not JSON)
      if (payload.length < 1) { console.error('❌ 收到空错误响应'); return; }
      const code = payload[0];
      const message = new TextDecoder().decode(payload.slice(1));
      const isDownloading = this.activeDownloads.size > 0;
      error = { code: code === 0xFF && isDownloading ? 'READ_FAILED' : 'INTERNAL_ERROR', message };
    }
    try {
      console.error('🚨 服务器返回错误:', error.code, '-', error.message);

      if (error.code === 'NO_PARTIAL_UPLOAD' && this.activeUploads.size > 0) {
        // Restart the first active upload that failed resume
        const [numTid, au] = this.activeUploads.entries().next().value!;
        console.log(`Upload resume failed (no partial file), restarting full upload (tid=${numTid})`);
        au.offset = 0;
        const request = JSON.stringify({ path: au.path, size: au.totalSize, transferId: numTid });
        const message = this.encodeMessage(MsgFileUploadStart, new TextEncoder().encode(request));
        if (this._isConnected) {
          this._send(message);
        }
        return;
      }

      // SFTP 未就绪时：reject pending loadDirectoryRaw 回调，自动重试 loadDirectory
      if (error.code === 'SFTP_NOT_AVAILABLE') {
        // Reject all raw directory callbacks so callers get immediate feedback
        for (const [, cb] of this._rawDirCallbacks) {
          cb.reject(new Error('SFTP_NOT_AVAILABLE'));
        }
        this._rawDirCallbacks.clear();

        if (this.loadRetryCount < 10) {
          if (this.isLoadingDirectory) {
            this.hideLoading();
            this.isLoadingDirectory = false;
            if (this.loadingTimeout) { clearTimeout(this.loadingTimeout); this.loadingTimeout = null; }
          }
          const retryPath = this.loadRetryPath || this.currentPath;
          this.loadRetryCount++;
          const delay = this.loadRetryCount <= 3 ? 1000 : 2000;
          console.log(`⏳ SFTP 未就绪，${delay/1000}秒后重试 (${this.loadRetryCount}/10):`, retryPath);
          setTimeout(() => this.loadDirectory(retryPath), delay);
        }
        return;
      }

      if (error.code === 'WRITE_FAILED' || error.code === 'INVALID_PATH' || error.code === 'INVALID_REQUEST' || error.code === 'SFTP_NOT_AVAILABLE') {
        handleSaveResponse('', false, `${error.code}: ${error.message}`);
      }

      if (error.code === 'NOT_FOUND' && this.pendingStatCallback) {
        const cb = this.pendingStatCallback;
        this.pendingStatCallback = null;
        cb({ exists: false });
        return;
      }

      if (error.code === 'MKDIR_FAILED' && this.pendingMkdirResolve) {
        const cb = this.pendingMkdirResolve;
        this.pendingMkdirResolve = null;
        cb();
        return;
      }

      // NOT_FOUND without pending stat callback — benign (stale or file-read error), don't kill transfers
      if (error.code === 'NOT_FOUND') {
        return;
      }

      this.hideLoading();
      this.isLoadingDirectory = false;
      if (this.loadingTimeout) {
        clearTimeout(this.loadingTimeout);
        this.loadingTimeout = null;
      }

      // Only kill all transfers for fatal errors when no upload is in progress,
      // or for WRITE_FAILED which directly impacts the current upload
      const hasActiveUpload = this.activeUploads.size > 0 || this.uploadQueue.length > 0;
      const isUploadFatalError = error.code === 'WRITE_FAILED';
      if (!hasActiveUpload || isUploadFatalError) {
        _failAllTransfers(this._transferCtx(), error.message);
      }

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
      } else if (error.code === 'TOO_MANY_FILES' || error.code === 'LIST_FAILED') {
        // Non-fatal for uploads — don't show alert during upload
        if (hasActiveUpload) return;
        userMessage = error.message;
      } else if (error.code === 'READ_FAILED') {
        // Clean up the specific download that failed
        if (errorTransferId !== undefined) {
          const ds = this.activeDownloads.get(errorTransferId);
          if (ds?.currentDownloadId) {
            this.updateTransferProgress(ds.currentDownloadId, 0, 'failed', error.message);
            ds.currentDownloadId = null;
          }
          this.activeDownloads.delete(errorTransferId);
          _processNextDownload(this._transferCtx());
          return;
        }
        userMessage = '下载失败\n' + error.message;
      } else if (error.code === 'WRITE_FAILED' || msgLower.includes('no space') || msgLower.includes('disk full') || msgLower.includes('enospc')) {
        userMessage = '服务器磁盘空间不足\n上传失败';
      } else if (msgLower.includes('permission denied') || msgLower.includes('eacces')) {
        userMessage = '服务器权限不足\n' + error.message;
      } else if (hasActiveUpload) {
        // Unknown error during upload — log but don't show alert or kill transfers
        console.warn('⚠️ 上传期间收到非致命错误:', error.code, error.message);
        return;
      }

      alert(`操作失败\n\n${userMessage}`);
    } catch (err) {
      console.error('❌ 处理错误响应失败:', err);
    }
  }

  /**
   * 更新"目录被截断"提示横幅。当后端因 soft_limit 截断了文件列表时,
   * 在 .file-list 滚动容器**外部**(作为兄弟节点)插入一个 banner,
   * 避免与 sticky 表头争抢 top:0 导致互相覆盖。
   */
  private updateTruncationBanner(): void {
    const fileListEl = this.listElement.closest('.file-list') as HTMLElement | null;
    if (!fileListEl || !fileListEl.parentElement) return;
    const parent = fileListEl.parentElement;
    // banner 作为 .file-list 的前置兄弟节点存在,避免被 .file-list 的 overflow 滚走
    let banner = parent.querySelector(':scope > .file-list-trunc-banner') as HTMLElement | null;

    if (!this.listTruncated) {
      banner?.remove();
      return;
    }

    const message = `目录含 ${this.listTotalCount} 项,已显示前 ${this.files.length} 项`;
    if (!banner) {
      banner = document.createElement('div');
      banner.className = 'file-list-trunc-banner';
      banner.innerHTML = `
        <span class="file-list-trunc-msg"></span>
        <button class="file-list-trunc-btn" type="button">全部加载</button>
      `;
      // 插在 .file-list 之前,保证它不受 .file-list 的 overflow 影响
      parent.insertBefore(banner, fileListEl);
      banner.querySelector('.file-list-trunc-btn')!.addEventListener('click', () => {
        this.loadDirectory(this.currentPath, { loadAll: true });
      });
    }
    banner.querySelector('.file-list-trunc-msg')!.textContent = message;
  }

  private renderFileList(): void {
    _renderFileList({
      files: this.files,
      currentPath: this.currentPath,
      sortColumn: this.sortColumn,
      sortDirection: this.sortDirection,
      listElement: this.listElement,
      sessionId: this.sessionId,
      ws: this.ws,
      transport: this.transport,
      isConnected: this._isConnected,
      loadDirectory: (path) => this.loadDirectory(path),
      downloadFile: (filename) => _downloadFile(this._transferCtx(), filename),
      selectedFiles: this.selectedFiles,
      getLastClickedFile: () => this.lastClickedFile,
      setLastClickedFile: (name) => { this.lastClickedFile = name; },
      statusBarElement: document.getElementById(`file-status-bar-${this.sessionId}`) || undefined,
    });
  }

  private updateSortArrows(): void {
    _updateSortArrows({
      listElement: this.listElement,
      sortColumn: this.sortColumn,
      sortDirection: this.sortDirection,
    });
  }

  private encodeMessage(type: number, payload: Uint8Array): Uint8Array {
    return encodeMessage(type, payload);
  }

  getCurrentPath(): string {
    return this.currentPath;
  }

  getShowHiddenFiles(): boolean {
    return this._showHiddenFiles;
  }

  toggleShowHiddenFiles(): void {
    this._showHiddenFiles = !this._showHiddenFiles;
    this.loadDirectory(this.currentPath);
  }

  getSpeedLimit(): number {
    return this._speedLimit;
  }

  setSpeedLimit(bytesPerSec: number): void {
    this._speedLimit = bytesPerSec;
    console.log('Speed limit set to:', bytesPerSec > 0 ? `${(bytesPerSec / 1024 / 1024).toFixed(0)} MB/s` : 'unlimited');
  }

  getFileNames(): Map<string, boolean> {
    const names = new Map<string, boolean>();
    for (const f of this.files) names.set(f.name, f.is_dir);
    return names;
  }

  getSelectedFiles(): string[] {
    return Array.from(this.selectedFiles);
  }

  getFiles(): FileInfo[] {
    return this.files;
  }

  getFileInfo(name: string): FileInfo | undefined {
    return this.files.find(f => f.name === name);
  }

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

  // ===================== Loading UI =====================

  private showLoading(): void {
    if (!this.loadingOverlay || !this.loadingProgressBar) return;
    this.useRealProgress = false;
    this.totalFiles = 0;
    this.currentProgress = 0;
    this.loadingOverlay.style.display = 'flex';
    this.loadingProgressBar.style.width = '0%';
    const loadingText = this.loadingOverlay.querySelector('.loading-text');
    if (loadingText) loadingText.textContent = '加载中...';
    if (this.progressInterval) clearInterval(this.progressInterval);
    const startTime = Date.now();
    this.progressInterval = setInterval(() => {
      if (this.useRealProgress) {
        if (this.progressInterval) { clearInterval(this.progressInterval); this.progressInterval = null; }
        return;
      }
      const progress = Math.min(((Date.now() - startTime) / 3000) * 90, 90);
      this.currentProgress = progress;
      if (this.loadingProgressBar) this.loadingProgressBar.style.width = `${progress}%`;
      if (progress >= 90 && this.progressInterval) { clearInterval(this.progressInterval); this.progressInterval = null; }
    }, 50);
  }

  private hideLoading(): void {
    if (!this.loadingOverlay || !this.loadingProgressBar) return;
    if (this.progressInterval) { clearInterval(this.progressInterval); this.progressInterval = null; }
    this.loadingProgressBar.style.width = '100%';
    setTimeout(() => { if (this.loadingOverlay) this.loadingOverlay.style.display = 'none'; }, 200);
  }

  private showFileOpLoading(label: string): void {
    this.pendingFileOp = true;
    if (!this.loadingOverlay) return;
    const lt = this.loadingOverlay.querySelector('.loading-text');
    if (lt) lt.textContent = label;
    if (this.loadingProgressBar) { this.loadingProgressBar.style.display = ''; this.loadingProgressBar.style.width = '100%'; this.loadingProgressBar.style.animation = 'indeterminate-progress 1.5s ease-in-out infinite'; }
    this.loadingOverlay.style.display = 'flex';
    if (this.fileOpTimeout) clearTimeout(this.fileOpTimeout);
    this.fileOpTimeout = setTimeout(() => { this.hideFileOpLoading(); this.loadDirectory(this.currentPath); }, 600000);
  }

  private hideFileOpLoading(): void {
    this.pendingFileOp = false;
    if (this.fileOpTimeout) { clearTimeout(this.fileOpTimeout); this.fileOpTimeout = null; }
    if (this.loadingOverlay) this.loadingOverlay.style.display = 'none';
    if (this.loadingProgressBar) { this.loadingProgressBar.style.display = ''; this.loadingProgressBar.style.animation = ''; }
  }

  // ===================== 传输操作（委托到 file-transfer-control） =====================

  async triggerUpload(targetDir?: string): Promise<void> {
    if (!targetDir) {
      await _triggerUpload(this._transferCtx());
      return;
    }
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({ multiple: true, directory: false });
      if (!selected) return;
      const filePaths = Array.isArray(selected) ? selected : [selected];
      this._batchUploadCount = filePaths.length;
      for (const fp of filePaths) {
        try {
          await _uploadLocalFile(this._transferCtx(), fp, targetDir);
        } catch (err) { console.error(`Failed to read file ${fp}:`, err); }
      }
      _resetBatchConflictState(this._transferCtx());
    } catch (err) { console.error('Upload failed:', err); }
  }

  async uploadFile(filename: string, content: Uint8Array, targetDir?: string, skipConflictCheck?: boolean): Promise<void> {
    await _uploadFile(this._transferCtx(), filename, content, targetDir, skipConflictCheck);
  }

  private async downloadFile(filename: string, isDir: boolean = false): Promise<void> {
    await _downloadFile(this._transferCtx(), filename, isDir);
  }

  /** Public download entry for sidebar tree */
  async downloadFilePublic(filename: string, isDir: boolean = false): Promise<void> {
    await this.downloadFile(filename, isDir);
  }

  private handleOperationResponse(payload: Uint8Array): void {
    try {
      const response = JSON.parse(new TextDecoder().decode(payload));

      if (response.operation === 'save') {
        handleSaveResponse(response.path || '', response.success, response.message);
        return;
      }

      if (response.operation === 'stat' && this.pendingStatCallback) {
        const cb = this.pendingStatCallback;
        this.pendingStatCallback = null;
        cb(response);
        return;
      }

      if (response.operation === 'mkdir' && this.pendingMkdirResolve) {
        const cb = this.pendingMkdirResolve;
        this.pendingMkdirResolve = null;
        cb();
        return;
      }

      if (this.pendingPartCleanup && response.operation === 'delete') {
        this.pendingPartCleanup = false;
        console.log('Part file cleanup:', response.success ? 'ok' : 'failed');
        return;
      }

      if (response.success) {
        console.log(`Operation ${response.operation || 'file operation'} completed successfully`);

        const isUploadComplete = !response.operation;

        if (isUploadComplete) {
          // Find the active upload by path (or transferId if server returns it)
          const completedPath = response.path || '';
          let completedTid: number | null = null;
          for (const [numTid, au] of this.activeUploads) {
            if (au.path === completedPath || (response.transferId != null && response.transferId === numTid)) {
              completedTid = numTid;
              break;
            }
          }
          if (completedTid !== null) {
            const au = this.activeUploads.get(completedTid)!;
            if (au.recordId) {
              this.updateTransferProgress(au.recordId, 100, 'completed');
            }
            if (au.fileHandle) {
              au.fileHandle.close().catch(() => { /* ignore */ });
            }
            this.activeUploads.delete(completedTid);
          }
          _processNextUpload(this._transferCtx());
        } else {
          if (this.pendingFileOp) this.hideFileOpLoading();
          this.loadDirectory(this.currentPath);
        }
        // Notify sidebar tree to refresh
        window.dispatchEvent(new CustomEvent('meterm-file-op-done', { detail: { sessionId: this.sessionId } }));
      } else {
        const errorMsg = response.message || response.error || 'Unknown error';
        console.error(`Operation failed: ${errorMsg}`);

        if (!response.operation && this.activeUploads.size > 0) {
          // Find the active upload by path (or transferId if server returns it)
          const failedPath = response.path || '';
          let failedTid: number | null = null;
          for (const [numTid, au] of this.activeUploads) {
            if (au.path === failedPath || (response.transferId != null && response.transferId === numTid)) {
              failedTid = numTid;
              break;
            }
          }
          if (failedTid !== null) {
            const au = this.activeUploads.get(failedTid)!;
            if (au.recordId) this.updateTransferProgress(au.recordId, 0, 'failed', errorMsg);
            if (au.fileHandle) au.fileHandle.close().catch(() => { /* ignore */ });
            this.activeUploads.delete(failedTid);
          }
          _processNextUpload(this._transferCtx());
        } else {
          if (this.pendingFileOp) this.hideFileOpLoading();
          alert(`操作失败: ${errorMsg}`);
          this.loadDirectory(this.currentPath);
        }
      }
    } catch (err) {
      console.error('Failed to parse operation response:', err);
      alert('操作失败: 服务器响应解析错误');

      // Close all active upload file handles and mark as failed
      for (const [numTid, au] of this.activeUploads) {
        if (au.recordId) this.updateTransferProgress(au.recordId, 0, 'failed', '服务器响应解析错误');
        if (au.fileHandle) au.fileHandle.close().catch(() => { /* ignore */ });
      }
      this.activeUploads.clear();
      _processNextUpload(this._transferCtx());
    }
  }

  private sendFileOp(req: FileOperationRequest, loading?: string): void {
    if (!this._isConnected) { console.error('WebSocket not ready'); return; }
    if (loading) this.showFileOpLoading(loading);
    this._send(this.encodeMessage(MsgFileOperation, new TextEncoder().encode(JSON.stringify(req))));
  }

  async deleteFile(path: string): Promise<void> {
    // If path is already absolute, use directly; otherwise resolve via getFullPath
    const resolved = path.startsWith('/') ? path : this.getFullPath(path);
    this.sendFileOp({ operation: 'delete', path: resolved }, '删除中...');
  }

  async renameFile(oldPath: string, newName: string): Promise<void> {
    if (!validateFileName(newName)) { alert('Invalid filename'); return; }
    const resolvedOld = oldPath.startsWith('/') ? oldPath : this.getFullPath(oldPath);
    const resolvedNew = newName.startsWith('/') ? newName : this.getFullPath(newName);
    this.sendFileOp({ operation: 'rename', path: resolvedOld, new_path: resolvedNew }, '重命名中...');
  }

  getWebSocket(): WebSocket | null { return this.ws; }

  requestServerInfo(type: 'sysinfo' | 'processes'): void {
    if (!this._isConnected) return;
    const payload = new TextEncoder().encode(JSON.stringify({ type }));
    const message = new Uint8Array(1 + payload.length);
    message[0] = MsgServerInfo;
    message.set(payload, 1);
    this._send(message);
  }

  /** Temporary context path override for sidebar tree right-click operations */
  private _contextPath: string | null = null;

  setCurrentPathForContext(path: string): void {
    this._contextPath = path;
    // Auto-clear after a short delay (context menu action completes quickly)
    setTimeout(() => { this._contextPath = null; }, 5000);
  }

  getFullPath(name: string): string {
    const base = this._contextPath ?? this.currentPath;
    return base === '/' ? `/${name}` : `${base}/${name}`;
  }

  async createFile(name: string): Promise<void> {
    if (!validateFileName(name)) { alert('Invalid filename'); return; }
    this.sendFileOp({ operation: 'touch', path: this.getFullPath(name) });
  }

  async chmodFile(path: string, mode: number): Promise<void> {
    const resolved = path.startsWith('/') ? path : this.getFullPath(path);
    this.sendFileOp({ operation: 'chmod', path: resolved, mode }, '修改权限...');
  }

  async copyFile(name: string, destPath: string): Promise<void> {
    const resolved = name.startsWith('/') ? name : this.getFullPath(name);
    this.sendFileOp({ operation: 'copy', path: resolved, new_path: destPath }, '复制中...');
  }

  async moveFile(name: string, destPath: string): Promise<void> {
    const resolved = name.startsWith('/') ? name : this.getFullPath(name);
    this.sendFileOp({ operation: 'rename', path: resolved, new_path: destPath }, '移动中...');
  }

  /** Move file by full source path (for sidebar tree drag-drop) */
  async moveFileByPath(srcPath: string, destPath: string): Promise<void> {
    this.sendFileOp({ operation: 'rename', path: srcPath, new_path: destPath });
  }

  async createSymlink(target: string, linkName: string): Promise<void> {
    const resolved = linkName.startsWith('/') ? linkName : this.getFullPath(linkName);
    this.sendFileOp({ operation: 'symlink', path: target, new_path: resolved }, '创建链接...');
  }

  async createDirectory(name: string): Promise<void> {
    if (!validateFileName(name)) { alert('Invalid directory name'); return; }
    this.sendFileOp({ operation: 'mkdir', path: this.getFullPath(name) });
  }

  private getModalContainer(): HTMLElement {
    return this.listElement.closest('.drawer-content') as HTMLElement || document.body;
  }

  static setActiveDragDropTarget(fm: FileManager | null): void {
    _activeDragDropInstance = fm;
  }

  private initializeDragAndDrop(): void {
    if (_dragDropListenerRegistered) {
      return;
    }
    _dragDropListenerRegistered = true;

    const appWindow = getCurrentWebviewWindow();
    let _sidebarHighlight: HTMLElement | null = null;

    appWindow.onDragDropEvent(async (event) => {
      const payload = event.payload as { type: string; paths?: string[]; position?: { x: number; y: number } };

      // Tauri v2 drag-drop position coordinate system varies by platform:
      // - macOS (WKWebView): already in logical (CSS) pixels — dividing by dpr would
      //   halve coordinates on Retina and shift elementFromPoint well above the cursor.
      // - Windows (WebView2) / Linux (WebKitGTK): physical pixels — must divide by dpr.
      const dpr = isMacPlatform ? 1 : (window.devicePixelRatio || 1);
      const cssX = payload.position ? payload.position.x / dpr : 0;
      const cssY = payload.position ? payload.position.y / dpr : 0;

      // Check if hovering/dropping over a sidebar
      const elemAtPoint = payload.position ? document.elementFromPoint(cssX, cssY) : null;
      const sidebarEl = elemAtPoint?.closest('.file-sidebar') as HTMLElement | null;

      if (sidebarEl && sidebarEl.style.display !== 'none') {
        const sessionId = sidebarEl.dataset.sessionId;
        if (!sessionId) return;
        const { DrawerManager } = await import('./drawer');
        const drawerInst = DrawerManager._getInstanceForSidebar(sessionId);
        const fm = drawerInst?.fileManager;
        if (!fm) return;

        if (payload.type === 'enter' || payload.type === 'over') {
          // Highlight drop target in sidebar tree
          const nodeEl = elemAtPoint?.closest('.tree-node[data-is-dir="true"]') as HTMLElement | null;
          const treeContainer = sidebarEl.querySelector('.sidebar-tree-container') as HTMLElement;

          // Determine new highlight target first, then clear old one if different
          const newTarget: HTMLElement | null = nodeEl
            ?? ((treeContainer?.contains(elemAtPoint) || elemAtPoint === treeContainer) ? treeContainer : null);

          if (_sidebarHighlight && _sidebarHighlight !== newTarget) {
            _sidebarHighlight.classList.remove('drop-target', 'drag-over');
          }

          if (newTarget === nodeEl && nodeEl) {
            nodeEl.classList.add('drop-target');
            _sidebarHighlight = nodeEl;
          } else if (newTarget === treeContainer) {
            treeContainer.classList.add('drag-over');
            _sidebarHighlight = treeContainer;
          }
        } else if (payload.type === 'leave') {
          if (_sidebarHighlight) {
            _sidebarHighlight.classList.remove('drop-target', 'drag-over');
            _sidebarHighlight = null;
          }
          sidebarEl.querySelectorAll<HTMLElement>('.drop-target, .drag-over').forEach(el => {
            el.classList.remove('drop-target', 'drag-over');
          });
        } else if (payload.type === 'drop') {
          if (_sidebarHighlight) {
            _sidebarHighlight.classList.remove('drop-target', 'drag-over');
            _sidebarHighlight = null;
          }
          // Fallback: clear any lingering highlights across the whole sidebar
          sidebarEl.querySelectorAll<HTMLElement>('.drop-target, .drag-over').forEach(el => {
            el.classList.remove('drop-target', 'drag-over');
          });

          // Determine target directory
          const nodeEl = elemAtPoint?.closest('.tree-node') as HTMLElement | null;
          let targetDir: string | undefined;
          if (nodeEl) {
            const nodePath = nodeEl.dataset.path;
            const isDir = nodeEl.dataset.isDir === 'true';
            if (nodePath) {
              if (isDir) {
                targetDir = nodePath;
              } else {
                // Dropped on a file → use its parent directory
                const lastSlash = nodePath.lastIndexOf('/');
                targetDir = lastSlash > 0 ? nodePath.substring(0, lastSlash) : '/';
              }
            }
          }
          // Fall back to sidebar tree root
          if (!targetDir) {
            const { SidebarManager } = await import('./file-sidebar');
            if (SidebarManager.has(sessionId)) {
              // Access tree root path via the sidebar instance
              const sidebarInst = (SidebarManager as any).sidebars.get(sessionId);
              targetDir = sidebarInst?.tree?.getRootPath() || '/';
            }
          }

          // Perform upload
          const filePaths = payload.paths ?? [];
          if (filePaths.length === 0) return;

          const { stat: fsStat } = await import('@tauri-apps/plugin-fs');
          const { validateFileName } = await import('./file-utils');
          const ctx = fm._transferCtx();
          ctx.setBatchUploadCount(filePaths.length);

          for (const filePath of filePaths) {
            try {
              const info = await fsStat(filePath);
              if (info.isDirectory) {
                const dirName = filePath.replace(/\\/g, '/').split('/').pop() || 'unknown';
                await _uploadDirectory(ctx, filePath, dirName);
              } else {
                const fileName = filePath.replace(/\\/g, '/').split('/').pop() || 'unknown';
                if (!validateFileName(fileName)) continue;
                await _uploadLocalFile(ctx, filePath, targetDir, true);
              }
            } catch (err) {
              console.error(`Sidebar drop upload failed: ${filePath}`, err);
            }
          }
          _resetBatchConflictState(ctx);

          // Refresh sidebar tree
          const { SidebarManager } = await import('./file-sidebar');
          setTimeout(() => SidebarManager.refreshTree(sessionId), 500);
        }
        return; // handled by sidebar
      }

      // Clear sidebar highlight on leave/drop outside sidebar
      if (_sidebarHighlight) {
        _sidebarHighlight.classList.remove('drop-target', 'drag-over');
        _sidebarHighlight = null;
      }

      // Default: bottom drawer drag-drop handler
      const target = _activeDragDropInstance;
      if (!target) return;
      await _handleDragEvent(target._transferCtx(), payload, target.listElement);
    });
  }

  // ===================== 传输历史（委托到 TransferHistoryManager） =====================

  private addTransferRecord(type: 'upload' | 'download', filename: string, path: string, size: number, savePath?: string): string {
    return this._transferHistory!.addTransferRecord(type, filename, path, size, savePath);
  }

  private updateTransferProgress(id: string, progress: number, status: 'pending' | 'inprogress' | 'completed' | 'failed' | 'paused' | 'cancelled', error?: string): void {
    this._transferHistory!.updateTransferProgress(id, progress, status, error);
    if (status === 'completed') {
      const record = this._transferHistory!.findRecord(id);
      if (record && record.size > 10 * 1024 * 1024) {
        const action = record.type === 'upload' ? '上传' : '下载';
        import('@tauri-apps/plugin-notification').then(async ({ isPermissionGranted, requestPermission, sendNotification }) => {
          let ok = await isPermissionGranted();
          if (!ok) ok = (await requestPermission()) === 'granted';
          if (ok) sendNotification({ title: `${action}完成`, body: `${record.filename} (${formatSize(record.size)})` });
        }).catch(() => {});
      }
    }
  }

  clearTransferHistory(): void {
    this._transferHistory!.clearTransferHistory();
  }

  renderTransferHistory(): void {
    this._transferHistory!.renderTransferHistory();
  }

  getTransferRecords(typeFilter?: 'upload' | 'download' | null, statusFilter?: 'active' | 'completed' | 'failed' | null): import('./file-transfer-history').TransferRecord[] {
    return this._transferHistory!.getRecords(typeFilter, statusFilter);
  }

  getTransferSpeed(id: string): number {
    return this._transferHistory!.getSpeed(id);
  }

  deleteTransferRecord(id: string): void {
    this._transferHistory!.deleteRecord(id);
  }

  setTransferFilter(type: 'upload' | 'download' | null): void {
    this._transferHistory!.setFilter(type);
  }

  getTransferFilter(): 'upload' | 'download' | null {
    return this._transferHistory!.getFilter();
  }

  setTransferStatusFilter(status: 'active' | 'completed' | 'failed' | null): void {
    this._transferHistory!.setStatusFilter(status);
  }

  setTransferSearchQuery(query: string): void {
    this._transferHistory!.setSearchQuery(query);
  }

  setServerLabel(label: string): void {
    this._transferHistory!.serverLabel = label;
  }

  pauseTransfer(id: string): void {
    _pauseTransfer(this._transferCtx(), id);
  }

  resumeTransfer(id: string): void {
    _resumeTransfer(this._transferCtx(), id);
  }

  async cancelTransfer(id: string): Promise<void> {
    await _cancelTransfer(this._transferCtx(), id);
  }

  async revealInFileManager(savePath: string): Promise<void> {
    await _revealInFileManager(savePath);
  }
}
