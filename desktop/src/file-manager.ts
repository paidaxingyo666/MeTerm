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
import { encodeMessage, validateFileName, formatSize } from './file-utils';
import { PathAutocomplete } from './file-autocomplete';
import { TransferHistoryManager } from './file-transfer-history';
import {
  type DownloadState,
  type DownloadQueueItem,
  createDownloadState,
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
  handleDownloadChunk as _handleDownloadChunk,
  adaptPipeline as _adaptPipeline,
  sendUploadChunk as _sendUploadChunk,
  resumeUpload as _resumeUpload,
  resumeDownload as _resumeDownload,
  triggerUpload as _triggerUpload,
  uploadFile as _uploadFile,
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
  private _showHiddenFiles: boolean = true;

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
  private listElement: HTMLElement;
  private pathInput: HTMLInputElement;
  private _dlState: DownloadState = createDownloadState();
  private downloadQueue: DownloadQueueItem[] = [];
  private _isProcessingDownload: boolean = false;
  private pendingUpload: { path: string; content: Uint8Array; offset: number } | null = null;
  private inFlightChunks: number = 0;
  private pipelineSize: number = 2;
  private pipelineAckCount: number = 0;
  private uploadQueue: Array<{ path: string; content: Uint8Array; filename: string; size: number; transferId: string }> = [];
  private isUploadPaused: boolean = false;
  private pendingPartCleanup: boolean = false;
  private isLoadingDirectory: boolean = false;
  private loadingTimeout: ReturnType<typeof setTimeout> | null = null;
  private lastClickTime: number = 0;
  private lastClickPath: string = '';
  private loadRetryCount: number = 0;
  private loadRetryPath: string = '';
  private pendingRequestId: string | null = null;
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
  private currentUploadId: string | null = null;

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

  private _transferCtx(): TransferContext {
    return {
      isConnected: this._isConnected,
      send: (data) => this._send(data),
      currentPath: this.currentPath,
      files: this.files,
      pendingUpload: this.pendingUpload,
      setPendingUpload: (v) => { this.pendingUpload = v; },
      inFlightChunks: this.inFlightChunks,
      setInFlightChunks: (v) => { this.inFlightChunks = v; },
      pipelineSize: this.pipelineSize,
      setPipelineSize: (v) => { this.pipelineSize = v; },
      pipelineAckCount: this.pipelineAckCount,
      setPipelineAckCount: (v) => { this.pipelineAckCount = v; },
      isUploadPaused: this.isUploadPaused,
      setIsUploadPaused: (v) => { this.isUploadPaused = v; },
      currentUploadId: this.currentUploadId,
      setCurrentUploadId: (v) => { this.currentUploadId = v; },
      uploadQueue: this.uploadQueue,
      dlState: this._dlState,
      setDlState: (v) => { this._dlState = v; },
      downloadQueue: this.downloadQueue,
      isProcessingDownload: this._isProcessingDownload,
      setIsProcessingDownload: (v) => { this._isProcessingDownload = v; },
      pendingPartCleanup: this.pendingPartCleanup,
      setPendingPartCleanup: (v) => { this.pendingPartCleanup = v; },
      pendingStatCallback: this.pendingStatCallback,
      setPendingStatCallback: (v) => { this.pendingStatCallback = v; },
      pendingMkdirResolve: this.pendingMkdirResolve,
      setPendingMkdirResolve: (v) => { this.pendingMkdirResolve = v; },
      batchFileAction: this._batchFileAction,
      setBatchFileAction: (v) => { this._batchFileAction = v; },
      batchDirAction: this._batchDirAction,
      setBatchDirAction: (v) => { this._batchDirAction = v; },
      batchUploadCount: this._batchUploadCount,
      setBatchUploadCount: (v) => { this._batchUploadCount = v; },
      addTransferRecord: (type, filename, path, size, savePath) => this.addTransferRecord(type, filename, path, size, savePath),
      updateTransferProgress: (id, progress, status, error) => this.updateTransferProgress(id, progress, status, error),
      findRecord: (id) => this._transferHistory!.findRecord(id) ?? undefined,
      resetSpeedTracker: (id, currentBytes) => this._transferHistory!.resetSpeedTracker(id, currentBytes),
      speedLimit: this._speedLimit,
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
    if (this.pendingUpload) {
      _resumeUpload(this._transferCtx());
    } else if (this.uploadQueue.length > 0) {
      _processNextUpload(this._transferCtx());
    }
    if (this._dlState.pendingDownload) {
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
      _handleDownloadChunk(payload, this._dlState, _dlCallbacks(this._transferCtx()));
    } else if (msgType === MsgFileUploadChunk) {
      if (this.pendingUpload) {
        if (payload.length === 8) {
          const resumeView = new DataView(payload.buffer, payload.byteOffset, 8);
          this.pendingUpload.offset = Number(resumeView.getBigUint64(0));
          this.inFlightChunks = 0;
          this.pipelineSize = 2;
          this.pipelineAckCount = 0;
          console.log(`Upload resume ACK: continuing from offset ${this.pendingUpload.offset}`);
        } else {
          this.inFlightChunks = Math.max(0, this.inFlightChunks - 1);
          _adaptPipeline(this._transferCtx());
        }
        // 限速时延迟发送下一个 chunk
        if (this._speedLimit > 0) {
          const delayMs = Math.max(1, Math.round(1024 * 1024 / this._speedLimit * 1000));
          setTimeout(() => _sendUploadChunk(this._transferCtx()), delayMs);
        } else {
          _sendUploadChunk(this._transferCtx());
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

  async loadDirectory(path: string): Promise<void> {
    if (!this._isConnected) {
      console.error('FileManager: not connected');
      alert('文件管理器未连接到服务器\n请关闭并重新打开抽屉，或刷新页面');
      return;
    }

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
      const request = JSON.stringify({ path, request_id: requestId, show_hidden: this._showHiddenFiles });
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
      console.log('📥 收到文件列表响应:', response.path, '→', resolvedPath, '文件数:', response.files.length);
      this.dirCachePut(resolvedPath, response.files);
      this.files = response.files;
      this.currentPath = resolvedPath;
      this.pathInput.value = resolvedPath;
      this.onPathChanged?.(resolvedPath);
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
    try {
      const error: ErrorResponse = JSON.parse(new TextDecoder().decode(payload));
      console.error('🚨 服务器返回错误:', error.code, '-', error.message);

      if (error.code === 'NO_PARTIAL_UPLOAD' && this.pendingUpload) {
        console.log('Upload resume failed (no partial file), restarting full upload');
        this.pendingUpload.offset = 0;
        const request = JSON.stringify({ path: this.pendingUpload.path, size: this.pendingUpload.content.length });
        const message = this.encodeMessage(MsgFileUploadStart, new TextEncoder().encode(request));
        if (this._isConnected) {
          this._send(message);
        }
        return;
      }

      // SFTP 未就绪时自动重试（SSH 后台初始化 SFTP 需要时间，最多重试 5 次）
      if (error.code === 'SFTP_NOT_AVAILABLE' && this.isLoadingDirectory && this.loadRetryCount < 5) {
        this.hideLoading();
        this.isLoadingDirectory = false;
        if (this.loadingTimeout) { clearTimeout(this.loadingTimeout); this.loadingTimeout = null; }
        const retryPath = this.loadRetryPath || this.currentPath;
        this.loadRetryCount++;
        console.log(`⏳ SFTP 未就绪，1秒后重试 (${this.loadRetryCount}/5):`, retryPath);
        setTimeout(() => this.loadDirectory(retryPath), 1000);
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

      this.hideLoading();
      this.isLoadingDirectory = false;
      if (this.loadingTimeout) {
        clearTimeout(this.loadingTimeout);
        this.loadingTimeout = null;
      }

      _failAllTransfers(this._transferCtx(), error.message);

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
      const { readFile } = await import('@tauri-apps/plugin-fs');
      this._batchUploadCount = filePaths.length;
      for (const fp of filePaths) {
        try {
          const content = await readFile(fp);
          await _uploadFile(this._transferCtx(), fp.replace(/\\/g, '/').split('/').pop() || 'file', content, targetDir);
        } catch (err) { console.error(`Failed to read file ${fp}:`, err); }
      }
      _resetBatchConflictState(this._transferCtx());
    } catch (err) { console.error('Upload failed:', err); }
  }

  async uploadFile(filename: string, content: Uint8Array, targetDir?: string): Promise<void> {
    await _uploadFile(this._transferCtx(), filename, content, targetDir);
  }

  private async downloadFile(filename: string, isDir: boolean = false): Promise<void> {
    await _downloadFile(this._transferCtx(), filename, isDir);
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
          if (this.currentUploadId) {
            this.updateTransferProgress(this.currentUploadId, 100, 'completed');
            this.currentUploadId = null;
          }
          this.pendingUpload = null;
          _processNextUpload(this._transferCtx());
        } else {
          if (this.pendingFileOp) this.hideFileOpLoading();
          this.loadDirectory(this.currentPath);
        }
      } else {
        const errorMsg = response.message || response.error || 'Unknown error';
        console.error(`Operation failed: ${errorMsg}`);

        if (!response.operation && this.currentUploadId) {
          this.updateTransferProgress(this.currentUploadId, 0, 'failed', errorMsg);
          this.currentUploadId = null;
          this.pendingUpload = null;
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

      if (this.currentUploadId) {
        this.updateTransferProgress(this.currentUploadId, 0, 'failed', '服务器响应解析错误');
        this.currentUploadId = null;
      }

      this.pendingUpload = null;
      _processNextUpload(this._transferCtx());
    }
  }

  private sendFileOp(req: FileOperationRequest, loading?: string): void {
    if (!this._isConnected) { console.error('WebSocket not ready'); return; }
    if (loading) this.showFileOpLoading(loading);
    this._send(this.encodeMessage(MsgFileOperation, new TextEncoder().encode(JSON.stringify(req))));
  }

  async deleteFile(path: string): Promise<void> {
    this.sendFileOp({ operation: 'delete', path: this.getFullPath(path) }, '删除中...');
  }

  async renameFile(oldPath: string, newName: string): Promise<void> {
    if (!validateFileName(newName)) { alert('Invalid filename'); return; }
    this.sendFileOp({ operation: 'rename', path: this.getFullPath(oldPath), new_path: this.getFullPath(newName) }, '重命名中...');
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

  getFullPath(name: string): string {
    return this.currentPath === '/' ? `/${name}` : `${this.currentPath}/${name}`;
  }

  async createFile(name: string): Promise<void> {
    if (!validateFileName(name)) { alert('Invalid filename'); return; }
    this.sendFileOp({ operation: 'touch', path: this.getFullPath(name) });
  }

  async chmodFile(path: string, mode: number): Promise<void> {
    this.sendFileOp({ operation: 'chmod', path: this.getFullPath(path), mode }, '修改权限...');
  }

  async copyFile(name: string, destPath: string): Promise<void> {
    this.sendFileOp({ operation: 'copy', path: this.getFullPath(name), new_path: destPath }, '复制中...');
  }

  async moveFile(name: string, destPath: string): Promise<void> {
    this.sendFileOp({ operation: 'rename', path: this.getFullPath(name), new_path: destPath }, '移动中...');
  }

  async createSymlink(target: string, linkName: string): Promise<void> {
    this.sendFileOp({ operation: 'symlink', path: target, new_path: this.getFullPath(linkName) }, '创建链接...');
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
      console.log('🎯 Drag-drop listener already registered globally, skipping.');
      return;
    }
    _dragDropListenerRegistered = true;
    console.log('🎯 Registering global Tauri v2 drag-drop listener...');

    const appWindow = getCurrentWebviewWindow();
    appWindow.onDragDropEvent(async (event) => {
      const target = _activeDragDropInstance;
      if (!target) return;
      await _handleDragEvent(target._transferCtx(), event.payload as { type: string; paths?: string[] }, target.listElement);
    }).then(() => console.log('✅ Tauri v2 drag-drop listener registered'));
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
