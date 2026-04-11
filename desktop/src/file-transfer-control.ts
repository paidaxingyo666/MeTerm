import { Channel, invoke } from '@tauri-apps/api/core';
import {
  MsgFileUploadStart,
  MsgFileUploadChunk,
  MsgFileUploadResume,
  MsgFileOperation,
  MsgFileDownloadPause,
  MsgFileDownloadContinue,
  MsgFileDownloadCancel,
  type FileOperationRequest,
} from './protocol';
import { encodeMessage, validateFileName } from './file-utils';
import { showUploadConflictDialog as _showUploadConflictDialog, showDirConflictDialog as _showDirConflictDialog, type UploadConflictResult, type DirConflictResult } from './file-conflict-dialog';
import {
  adaptPipeline as _adaptPipeline,
  sendMkdirRequest, collectLocalFiles as _collectLocalFiles,
} from './file-upload';
import {
  type DownloadState,
  type DownloadQueueItem,
  createDownloadState,
  startDownloadFromQueue as _startDownloadFromQueue,
  handleDownloadChunk as _handleDownloadChunk,
  cleanupDownloadState as _cleanupDownloadState,
  resumeDownload as _resumeDownload,
} from './file-download';
import { readFile, stat as fsStat, open as fsOpen, SeekMode } from '@tauri-apps/plugin-fs';
import type { FileHandle } from '@tauri-apps/plugin-fs';

export { _handleDownloadChunk as handleDownloadChunk };

const MAX_CONCURRENT_UPLOADS = 3;
const MAX_CONCURRENT_DOWNLOADS = 3;
let _nextNumTransferId = 1;
export function nextNumTransferId(): number { return _nextNumTransferId++; }

export interface ActiveUpload {
  numTransferId: number;
  path: string;
  content?: Uint8Array;
  localFilePath?: string;
  fileHandle?: FileHandle;
  reading?: boolean;
  offset: number;
  totalSize: number;
  inFlightChunks: number;
  pipelineSize: number;
  pipelineAckCount: number;
  isPaused: boolean;
  recordId: string | null;
  backendManaged?: boolean;
  backendHandle?: Channel<BackendUploadEvent> | null;
}

export interface TransferContext {
  sessionId: string;
  isConnected: boolean;
  send: (data: Uint8Array) => void;
  currentPath: string;
  files: import('./protocol').FileInfo[];
  useBackendDownload: boolean;
  useBackendUpload: boolean;

  activeUploads: Map<number, ActiveUpload>;
  uploadQueue: Array<{ path: string; content?: Uint8Array; localFilePath?: string; filename: string; size: number; transferId: string; numTransferId: number }>;

  activeDownloads: Map<number, DownloadState>;
  downloadQueue: DownloadQueueItem[];

  pendingPartCleanup: boolean;
  setPendingPartCleanup: (v: boolean) => void;
  pendingStatCallback: ((response: any) => void) | null;
  setPendingStatCallback: (v: ((response: any) => void) | null) => void;
  pendingMkdirResolve: (() => void) | null;
  setPendingMkdirResolve: (v: (() => void) | null) => void;

  batchFileAction: 'overwrite' | 'skip' | null;
  setBatchFileAction: (v: 'overwrite' | 'skip' | null) => void;
  batchDirAction: 'merge' | 'skip' | null;
  setBatchDirAction: (v: 'merge' | 'skip' | null) => void;
  batchUploadCount: number;
  setBatchUploadCount: (v: number) => void;

  addTransferRecord: (type: 'upload' | 'download', filename: string, path: string, size: number, savePath?: string) => string;
  updateTransferProgress: (id: string, progress: number, status: 'pending' | 'inprogress' | 'completed' | 'failed' | 'paused' | 'cancelled', error?: string) => void;
  updateTransferSize: (id: string, size: number) => void;
  findRecord: (id: string) => { type: 'upload' | 'download'; status: string; progress: number; path: string; size: number } | undefined;
  resetSpeedTracker: (id: string, currentBytes: number) => void;

  speedLimit: number; // 0 = unlimited, bytes/s
  getModalContainer: () => HTMLElement;
  loadDirectory: (path: string) => Promise<void>;
}

interface BackendDownloadEvent {
  kind: 'started' | 'progress' | 'completed' | 'failed' | 'cancelled';
  transfer_id: number;
  total_size?: number;
  written?: number;
  save_path?: string;
  message?: string;
}

interface BackendUploadEvent {
  kind: 'started' | 'progress' | 'completed' | 'failed' | 'cancelled';
  transfer_id: number;
  total_size?: number;
  written?: number;
  remote_path?: string;
  message?: string;
}

/** Files larger than 50 MB use streaming read to avoid loading entire content into memory */
const STREAM_THRESHOLD = 50 * 1024 * 1024;

/** Close file handle if present and remove active upload */
async function cleanupActiveUpload(ctx: TransferContext, numTransferId: number): Promise<void> {
  const au = ctx.activeUploads.get(numTransferId);
  if (au?.fileHandle) {
    try { await au.fileHandle.close(); } catch { /* ignore */ }
  }
  ctx.activeUploads.delete(numTransferId);
}

function isBackendUpload(au: ActiveUpload): boolean {
  return au.backendManaged === true;
}

function isBackendDownload(ds: DownloadState): boolean {
  return ds.backendManaged;
}

function setBackendDownloadState(state: DownloadState, item: DownloadQueueItem): void {
  state.backendManaged = true;
  state.backendHandle = null;
  state.currentDownloadId = item.transferId;
  state.pendingDownload = {
    filename: item.filename,
    savePath: item.savePath,
    remotePath: item.remotePath,
    totalSize: item.fileSize,
    receivedSize: 0,
  };
  state.downloadBuffer = [];
  state.downloadBufferSize = 0;
  state.writeQueue = [];
  state.isWriting = false;
  state.writeError = null;
  state.isDownloadPaused = false;
  state.lastDownloadProgressUpdate = 0;
}

function finalizeBackendDownload(ctx: TransferContext, numTid: number, status: 'completed' | 'failed' | 'cancelled', error?: string): void {
  const ds = ctx.activeDownloads.get(numTid);
  if (!ds) return;
  const recordId = ds.currentDownloadId;
  ctx.activeDownloads.delete(numTid);
  if (recordId) {
    if (status === 'completed') {
      ctx.updateTransferProgress(recordId, 100, 'completed');
    } else {
      const progress = ds.pendingDownload && ds.pendingDownload.totalSize > 0
        ? Math.min((ds.pendingDownload.receivedSize / ds.pendingDownload.totalSize) * 100, 99.9)
        : 0;
      ctx.updateTransferProgress(recordId, progress, status, error);
    }
  }
  void processNextDownload(ctx);
}

function handleBackendDownloadEvent(ctx: TransferContext, numTid: number, event: BackendDownloadEvent): void {
  const ds = ctx.activeDownloads.get(numTid);
  if (!ds || !ds.pendingDownload) return;
  const recordId = ds.currentDownloadId;

  switch (event.kind) {
    case 'started': {
      const totalSize = event.total_size ?? ds.pendingDownload.totalSize;
      ds.pendingDownload.totalSize = totalSize;
      if (recordId && totalSize > 0) {
        ctx.updateTransferSize(recordId, totalSize);
      }
      break;
    }
    case 'progress': {
      const totalSize = event.total_size ?? ds.pendingDownload.totalSize;
      const written = event.written ?? ds.pendingDownload.receivedSize;
      ds.pendingDownload.totalSize = totalSize;
      ds.pendingDownload.receivedSize = written;
      if (recordId && !ds.isDownloadPaused && totalSize > 0) {
        const progress = Math.min((written / totalSize) * 100, 99.9);
        ctx.updateTransferProgress(recordId, progress, 'inprogress');
      }
      break;
    }
    case 'completed': {
      const totalSize = event.total_size ?? ds.pendingDownload.totalSize;
      ds.pendingDownload.totalSize = totalSize;
      ds.pendingDownload.receivedSize = totalSize;
      finalizeBackendDownload(ctx, numTid, 'completed');
      break;
    }
    case 'cancelled': {
      finalizeBackendDownload(ctx, numTid, 'cancelled', '用户取消');
      break;
    }
    case 'failed': {
      finalizeBackendDownload(ctx, numTid, 'failed', event.message || '下载失败');
      break;
    }
  }
}

async function sendBackendDownloadControl(ctx: TransferContext, numTid: number, signal: 'pause' | 'continue' | 'cancel'): Promise<void> {
  await invoke('control_session_file_download', {
    sessionId: ctx.sessionId,
    transferId: numTid,
    signal,
  });
}

async function sendBackendUploadControl(ctx: TransferContext, numTid: number, signal: 'pause' | 'continue' | 'cancel'): Promise<void> {
  await invoke('control_session_file_upload', {
    sessionId: ctx.sessionId,
    transferId: numTid,
    signal,
  });
}

function finalizeBackendUpload(ctx: TransferContext, numTid: number, status: 'completed' | 'failed' | 'cancelled', error?: string): void {
  const au = ctx.activeUploads.get(numTid);
  if (!au) return;
  const recordId = au.recordId;
  ctx.activeUploads.delete(numTid);
  if (recordId) {
    if (status === 'completed') {
      ctx.updateTransferProgress(recordId, 100, 'completed');
      window.dispatchEvent(new CustomEvent('meterm-file-op-done', { detail: { sessionId: ctx.sessionId } }));
    } else {
      const progress = au.totalSize > 0
        ? Math.min((au.offset / au.totalSize) * 100, 99.9)
        : 0;
      ctx.updateTransferProgress(recordId, progress, status, error);
    }
  }
  void processNextUpload(ctx);
}

function handleBackendUploadEvent(ctx: TransferContext, numTid: number, event: BackendUploadEvent): void {
  const au = ctx.activeUploads.get(numTid);
  if (!au) return;
  const recordId = au.recordId;

  switch (event.kind) {
    case 'started': {
      const totalSize = event.total_size ?? au.totalSize;
      au.totalSize = totalSize;
      if (recordId && totalSize > 0) {
        ctx.updateTransferSize(recordId, totalSize);
      }
      break;
    }
    case 'progress': {
      const totalSize = event.total_size ?? au.totalSize;
      const written = event.written ?? au.offset;
      au.totalSize = totalSize;
      au.offset = written;
      if (recordId && !au.isPaused && totalSize > 0) {
        const progress = Math.min((written / totalSize) * 100, 99.9);
        ctx.updateTransferProgress(recordId, progress, 'inprogress');
      }
      break;
    }
    case 'completed': {
      const totalSize = event.total_size ?? au.totalSize;
      au.totalSize = totalSize;
      au.offset = totalSize;
      finalizeBackendUpload(ctx, numTid, 'completed');
      break;
    }
    case 'cancelled': {
      finalizeBackendUpload(ctx, numTid, 'cancelled', '用户取消');
      break;
    }
    case 'failed': {
      finalizeBackendUpload(ctx, numTid, 'failed', event.message || '上传失败');
      break;
    }
  }
}

export function adaptPipeline(au: ActiveUpload): void {
  const result = _adaptPipeline({
    inFlightChunks: au.inFlightChunks,
    pipelineSize: au.pipelineSize,
    pipelineAckCount: au.pipelineAckCount,
  });
  au.pipelineSize = result.pipelineSize;
  au.pipelineAckCount = result.pipelineAckCount;
}

export function sendUploadChunk(ctx: TransferContext, numTransferId: number): void {
  const CHUNK_SIZE = 1 * 1024 * 1024;
  const au = ctx.activeUploads.get(numTransferId);
  if (!au || au.isPaused || !ctx.isConnected) return;

  const effectivePipeline = ctx.speedLimit > 0 ? 1 : au.pipelineSize;

  if (au.fileHandle) {
    // Streaming mode: async read from file handle
    sendStreamChunks(ctx, au, CHUNK_SIZE, effectivePipeline).catch(err => {
      console.error('Stream upload error:', err);
    });
  } else if (au.content) {
    // In-memory mode: sync
    sendBufferChunks(ctx, au, CHUNK_SIZE, effectivePipeline);
  }
}

/** Send chunks from Uint8Array content (synchronous, no await needed) */
function sendBufferChunks(ctx: TransferContext, au: ActiveUpload, chunkSize: number, maxInFlight: number): void {
  while (
    ctx.activeUploads.has(au.numTransferId) &&
    ctx.isConnected &&
    au.inFlightChunks < maxInFlight &&
    !au.isPaused
  ) {
    const { totalSize, offset, content } = au;
    if (!content || offset >= totalSize) break;

    const end = Math.min(offset + chunkSize, totalSize);
    const chunkData = content.subarray(offset, end);

    sendChunkPayload(ctx, au, chunkData);
    au.offset = end;

    if (ctx.speedLimit > 0) break;
  }
}

/** Send chunks by streaming from a file handle (async, prevents concurrent reads via reading flag) */
async function sendStreamChunks(ctx: TransferContext, au: ActiveUpload, chunkSize: number, maxInFlight: number): Promise<void> {
  if (!au.fileHandle || au.reading) return;
  au.reading = true;

  try {
    while (
      ctx.activeUploads.has(au.numTransferId) &&
      ctx.isConnected &&
      au.inFlightChunks < maxInFlight &&
      !au.isPaused
    ) {
      const { totalSize, offset } = au;
      if (offset >= totalSize) break;

      const readSize = Math.min(chunkSize, totalSize - offset);
      const buf = new Uint8Array(readSize);
      const bytesRead = await au.fileHandle!.read(buf);

      // Re-check state after await — upload may have been cancelled/failed
      if (!ctx.activeUploads.has(au.numTransferId) || !ctx.isConnected || au.isPaused) break;
      if (bytesRead === null || bytesRead === 0) break;

      const chunkData = bytesRead < readSize ? buf.subarray(0, bytesRead) : buf;
      sendChunkPayload(ctx, au, chunkData);
      au.offset = offset + chunkData.length;

      if (ctx.speedLimit > 0) break;
    }
  } finally {
    if (ctx.activeUploads.has(au.numTransferId)) {
      au.reading = false;
    }
  }
}

/** Build and send a chunk payload */
function sendChunkPayload(ctx: TransferContext, au: ActiveUpload, chunkData: Uint8Array): void {
  const { totalSize, offset, numTransferId } = au;
  const payload = new Uint8Array(4 + 16 + chunkData.length);
  const view = new DataView(payload.buffer);
  view.setUint32(0, numTransferId);
  view.setBigUint64(4, BigInt(totalSize));
  view.setBigUint64(12, BigInt(offset));
  payload.set(chunkData, 20);

  ctx.send(encodeMessage(MsgFileUploadChunk, payload));
  au.inFlightChunks++;

  const progress = totalSize > 0 ? Math.min((offset + chunkData.length) / totalSize * 100, 99.9) : 99;
  if (au.recordId) {
    ctx.updateTransferProgress(au.recordId, progress, 'inprogress');
  }
}

export async function resumeUpload(ctx: TransferContext): Promise<void> {
  for (const [numTid, au] of ctx.activeUploads) {
    if (isBackendUpload(au)) {
      continue;
    }
    if (!ctx.isConnected) {
      if (au.recordId) ctx.updateTransferProgress(au.recordId, 0, 'failed', '连接已断开');
      ctx.activeUploads.delete(numTid);
      continue;
    }
    console.log(`Attempting upload resume for ${au.path} (tid=${numTid})`);
    const request = JSON.stringify({ path: au.path, size: au.totalSize, transferId: numTid });
    ctx.send(encodeMessage(MsgFileUploadResume, new TextEncoder().encode(request)));
  }
}

export async function resumeDownload(ctx: TransferContext): Promise<void> {
  for (const [numTid, state] of ctx.activeDownloads) {
    if (isBackendDownload(state)) {
      continue;
    }
    await _resumeDownload(ctx.isConnected ? (data: Uint8Array) => ctx.send(data) : null, state, dlCallbacks(ctx, numTid), numTid);
  }
}

export async function triggerUpload(ctx: TransferContext): Promise<void> {
  try {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const selected = await open({
      multiple: true,
      directory: false
    });

    if (!selected) return;

    const filePaths = Array.isArray(selected) ? selected : [selected];

    ctx.setBatchUploadCount(filePaths.length);

    for (const filePath of filePaths) {
      try {
        await uploadLocalFile(ctx, filePath);
      } catch (err) {
        console.error(`Failed to read file ${filePath}:`, err);
      }
    }

    resetBatchConflictState(ctx);
  } catch (err) {
    console.error('Upload failed:', err);
  }
}

export async function uploadLocalFile(ctx: TransferContext, localFilePath: string, targetDir?: string, skipConflictCheck?: boolean): Promise<void> {
  const filename = localFilePath.replace(/\\/g, '/').split('/').pop() || 'file';
  const info = await fsStat(localFilePath);
  if (ctx.useBackendUpload || info.size > STREAM_THRESHOLD) {
    await uploadFileStreaming(ctx, filename, localFilePath, info.size, targetDir, skipConflictCheck);
    return;
  }

  const content = await readFile(localFilePath);
  await uploadFile(ctx, filename, content, targetDir, skipConflictCheck);
}

export async function uploadFile(ctx: TransferContext, filename: string, content: Uint8Array, targetDir?: string, skipConflictCheck?: boolean): Promise<void> {
  const dir = targetDir || ctx.currentPath;
  let actualFilename = filename;
  let targetPath = dir === '/'
    ? `/${filename}`
    : `${dir}/${filename}`;

  if (!ctx.isConnected) {
    console.error('WebSocket not ready');
    return;
  }

  if (!skipConflictCheck) {
    try {
      const stat = await checkFileExists(ctx, targetPath);
      if (stat.exists) {
        const result = await showUploadConflictDialog(ctx, filename);
        if (result.action === 'skip') return;
        if (result.action === 'rename') {
          actualFilename = result.newName!;
          targetPath = dir === '/'
            ? `/${actualFilename}`
            : `${dir}/${actualFilename}`;
        }
      }
    } catch {
      // Stat check failed — proceed with upload anyway
    }
  }

  const fileSize = content.length;
  const transferId = ctx.addTransferRecord('upload', actualFilename, targetPath, fileSize);
  const numTid = nextNumTransferId();
  ctx.uploadQueue.push({ path: targetPath, content, filename: actualFilename, size: fileSize, transferId, numTransferId: numTid });

  if (ctx.activeUploads.size < MAX_CONCURRENT_UPLOADS) {
    processNextUpload(ctx);
  }
}

/** Enqueue a large file for streaming upload (content read on-demand from disk) */
async function uploadFileStreaming(ctx: TransferContext, filename: string, localFilePath: string, fileSize: number, targetDir?: string, skipConflictCheck?: boolean): Promise<void> {
  const dir = targetDir || ctx.currentPath;
  let actualFilename = filename;
  let targetPath = dir === '/'
    ? `/${filename}`
    : `${dir}/${filename}`;

  if (!ctx.isConnected) {
    console.error('WebSocket not ready');
    return;
  }

  if (!skipConflictCheck) {
    try {
      const stat = await checkFileExists(ctx, targetPath);
      if (stat.exists) {
        const result = await showUploadConflictDialog(ctx, filename);
        if (result.action === 'skip') return;
        if (result.action === 'rename') {
          actualFilename = result.newName!;
          targetPath = dir === '/'
            ? `/${actualFilename}`
            : `${dir}/${actualFilename}`;
        }
      }
    } catch {
      // Stat check failed — proceed with upload anyway
    }
  }

  const transferId = ctx.addTransferRecord('upload', actualFilename, targetPath, fileSize);
  const numTid = nextNumTransferId();
  ctx.uploadQueue.push({ path: targetPath, localFilePath, filename: actualFilename, size: fileSize, transferId, numTransferId: numTid });

  if (ctx.activeUploads.size < MAX_CONCURRENT_UPLOADS) {
    processNextUpload(ctx);
  }
}

export async function processNextUpload(ctx: TransferContext): Promise<void> {
  if (ctx.uploadQueue.length === 0) {
    if (ctx.activeUploads.size === 0) ctx.loadDirectory(ctx.currentPath);
    return;
  }

  // 启动多个并发上传直到达到上限
  while (ctx.activeUploads.size < MAX_CONCURRENT_UPLOADS && ctx.uploadQueue.length > 0) {
    if (!ctx.isConnected) {
      for (const item of ctx.uploadQueue) {
        ctx.updateTransferProgress(item.transferId, 0, 'failed', '连接已断开');
      }
      ctx.uploadQueue.length = 0;
      return;
    }

    const item = ctx.uploadQueue.shift()!;
    const numTid = item.numTransferId;

    const au: ActiveUpload = {
      numTransferId: numTid,
      path: item.path,
      content: item.content,
      localFilePath: item.localFilePath,
      offset: 0,
      totalSize: item.size,
      inFlightChunks: 0,
      pipelineSize: 2,
      pipelineAckCount: 0,
      isPaused: false,
      recordId: item.transferId,
      backendManaged: false,
      backendHandle: null,
    };

    ctx.activeUploads.set(numTid, au);
    ctx.updateTransferProgress(item.transferId, 0, 'inprogress');

    if (ctx.useBackendUpload && item.localFilePath) {
      au.backendManaged = true;
      const channel = new Channel<BackendUploadEvent>();
      channel.onmessage = (event) => {
        handleBackendUploadEvent(ctx, numTid, event);
      };
      au.backendHandle = channel;

      try {
        await invoke('start_session_file_upload', {
          sessionId: ctx.sessionId,
          localPath: item.localFilePath,
          remotePath: item.path,
          transferId: numTid,
          onEvent: channel,
        });
      } catch (err) {
        ctx.activeUploads.delete(numTid);
        ctx.updateTransferProgress(item.transferId, 0, 'failed', err instanceof Error ? err.message : String(err));
      }
      continue;
    }

    // Open file handle for streaming if needed
    if (item.localFilePath && !item.content) {
      try {
        const fileHandle = await fsOpen(item.localFilePath, { read: true });
        au.fileHandle = fileHandle;
      } catch (err) {
        console.error(`Failed to open file: ${item.localFilePath}`, err);
        ctx.updateTransferProgress(item.transferId, 0, 'failed', `无法打开文件: ${err}`);
        ctx.activeUploads.delete(numTid);
        continue; // try next item
      }
    }

    const request = JSON.stringify({ path: item.path, size: item.size, transferId: numTid });
    const message = encodeMessage(MsgFileUploadStart, new TextEncoder().encode(request));
    ctx.send(message);
    console.log(`Starting upload of ${item.filename} to ${item.path} (transferId: ${numTid})`);
  }
}

export async function uploadDirectory(ctx: TransferContext, localDirPath: string, dirName: string): Promise<void> {
  const remoteDirPath = ctx.currentPath === '/' ? `/${dirName}` : `${ctx.currentPath}/${dirName}`;
  const stat = await checkFileExists(ctx, remoteDirPath);
  if (stat.exists && stat.is_dir) {
    const result = await showDirConflictDialog(ctx, dirName);
    if (result.action === 'skip') return;
    if (result.action === 'rename') {
      dirName = result.newName!;
    }
  }

  const files = await _collectLocalFiles(localDirPath, '');
  if (files.length === 0) return;

  const remoteDirs = new Set<string>();
  remoteDirs.add(dirName);
  for (const f of files) {
    const parts = `${dirName}/${f.relativePath}`.split('/');
    for (let i = 1; i < parts.length; i++) {
      remoteDirs.add(parts.slice(0, i).join('/'));
    }
  }
  const sortedDirs = Array.from(remoteDirs).sort();

  for (const dir of sortedDirs) {
    const remotePath = ctx.currentPath === '/' ? `/${dir}` : `${ctx.currentPath}/${dir}`;
    const exists = await checkFileExists(ctx, remotePath);
    if (!exists.exists) {
      await ensureRemoteDir(ctx, remotePath);
    }
  }

  for (const f of files) {
    try {
      const targetDir = ctx.currentPath === '/'
        ? `/${dirName}/${f.relativePath}`.replace(/\/[^/]+$/, '') || '/'
        : `${ctx.currentPath}/${dirName}/${f.relativePath}`.replace(/\/[^/]+$/, '');
      await uploadLocalFile(ctx, f.localPath, targetDir);
    } catch (err) {
      console.error(`Failed to upload ${f.localPath}:`, err);
    }
  }
}

function ensureRemoteDir(ctx: TransferContext, remotePath: string): Promise<void> {
  return new Promise((resolve) => {
    if (!ctx.isConnected) {
      resolve();
      return;
    }

    const timeout = setTimeout(() => {
      ctx.setPendingMkdirResolve(null);
      resolve();
    }, 5000);

    ctx.setPendingMkdirResolve(() => {
      clearTimeout(timeout);
      resolve();
    });

    sendMkdirRequest((data) => ctx.send(data), remotePath);
  });
}

export async function downloadFile(ctx: TransferContext, filename: string, isDir: boolean = false): Promise<void> {
  // Support absolute paths (e.g. from sidebar multi-select which stores full paths)
  const isAbsolute = filename.startsWith('/');
  const filePath = isAbsolute
    ? filename
    : (ctx.currentPath === '/' ? `/${filename}` : `${ctx.currentPath}/${filename}`);
  const displayName = isAbsolute ? (filename.split('/').pop() || filename) : filename;

  if (!ctx.isConnected) {
    console.error('WebSocket not ready');
    return;
  }

  try {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const defaultName = isDir ? `${displayName}.zip` : displayName;
    const savePath = await save({
      defaultPath: defaultName,
      filters: isDir
        ? [{ name: 'ZIP 压缩文件', extensions: ['zip'] }]
        : []
    });
    if (!savePath) return;

    if (!ctx.isConnected) {
      alert('连接已断开，请稍后重试');
      return;
    }

    const fileInfo = ctx.files.find(f => f.name === displayName);
    const fileSize = fileInfo ? fileInfo.size : 0;

    const transferId = ctx.addTransferRecord('download', displayName, filePath, fileSize, savePath);
    const numTid = nextNumTransferId();
    const queueItem: DownloadQueueItem = { filename: displayName, remotePath: filePath, savePath, fileSize, transferId, isDir, numTransferId: numTid };
    ctx.downloadQueue.push(queueItem);

    if (ctx.activeDownloads.size < MAX_CONCURRENT_DOWNLOADS) {
      await processNextDownload(ctx);
    }
  } catch (err) {
    console.error('Download failed:', err);
    alert(`下载失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function processNextDownload(ctx: TransferContext): Promise<void> {
  while (ctx.activeDownloads.size < MAX_CONCURRENT_DOWNLOADS && ctx.downloadQueue.length > 0) {
    if (!ctx.isConnected) {
      for (const item of ctx.downloadQueue) {
        ctx.updateTransferProgress(item.transferId, 0, 'failed', '连接已断开');
      }
      ctx.downloadQueue.length = 0;
      return;
    }
    const item = ctx.downloadQueue.shift()!;
    const numTid = item.numTransferId;
    const state = createDownloadState();
    ctx.activeDownloads.set(numTid, state);
    if (ctx.useBackendDownload) {
      setBackendDownloadState(state, item);
      ctx.updateTransferProgress(item.transferId, 0, 'inprogress');

      const channel = new Channel<BackendDownloadEvent>();
      channel.onmessage = (event) => {
        handleBackendDownloadEvent(ctx, numTid, event);
      };
      state.backendHandle = channel;

      try {
        await invoke('start_session_file_download', {
          sessionId: ctx.sessionId,
          remotePath: item.remotePath,
          savePath: item.savePath,
          transferId: numTid,
          offset: 0,
          onEvent: channel,
        });
      } catch (err) {
        ctx.activeDownloads.delete(numTid);
        ctx.updateTransferProgress(item.transferId, 0, 'failed', err instanceof Error ? err.message : String(err));
      }
      continue;
    }

    const newState = await _startDownloadFromQueue(item, ctx.isConnected ? (data: Uint8Array) => ctx.send(data) : null, state, dlCallbacks(ctx, numTid), numTid);
    ctx.activeDownloads.set(numTid, newState);
  }
}

export async function cleanupDownload(state: DownloadState): Promise<void> {
  await _cleanupDownloadState(state);
}

export function dlCallbacks(ctx: TransferContext, numTid: number) {
  return {
    updateTransferProgress: (id: string, progress: number, status: 'pending' | 'inprogress' | 'completed' | 'failed' | 'paused' | 'cancelled', error?: string) => {
      ctx.updateTransferProgress(id, progress, status, error);
    },
    addTransferRecord: (type: 'upload' | 'download', filename: string, path: string, size: number, savePath?: string) => {
      return ctx.addTransferRecord(type, filename, path, size, savePath);
    },
    updateTransferSize: (id: string, size: number) => {
      ctx.updateTransferSize(id, size);
    },
    onDownloadFinished: () => {
      ctx.activeDownloads.delete(numTid);
      processNextDownload(ctx);
    },
  };
}

export function checkFileExists(ctx: TransferContext, path: string): Promise<{ exists: boolean; is_dir?: boolean; size?: number }> {
  return new Promise((resolve) => {
    if (!ctx.isConnected) {
      resolve({ exists: false });
      return;
    }

    const timeout = setTimeout(() => {
      ctx.setPendingStatCallback(null);
      resolve({ exists: false });
    }, 5000);

    ctx.setPendingStatCallback((response: any) => {
      clearTimeout(timeout);
      resolve({
        exists: !!response.exists,
        is_dir: response.is_dir,
        size: response.size
      });
    });

    const request: FileOperationRequest = {
      operation: 'stat',
      path: path
    };
    const message = encodeMessage(MsgFileOperation, new TextEncoder().encode(JSON.stringify(request)));
    ctx.send(message);
  });
}

export function showUploadConflictDialog(ctx: TransferContext, filename: string): Promise<UploadConflictResult> {
  if (ctx.batchFileAction) {
    return Promise.resolve({ action: ctx.batchFileAction });
  }
  const showBatch = ctx.batchUploadCount > 1;
  return _showUploadConflictDialog(filename, ctx.getModalContainer(), showBatch).then(result => {
    if (result.applyToAll && (result.action === 'overwrite' || result.action === 'skip')) {
      ctx.setBatchFileAction(result.action);
    }
    return result;
  });
}

export function showDirConflictDialog(ctx: TransferContext, dirName: string): Promise<DirConflictResult> {
  if (ctx.batchDirAction) {
    return Promise.resolve({ action: ctx.batchDirAction });
  }
  const showBatch = ctx.batchUploadCount > 1;
  return _showDirConflictDialog(dirName, ctx.getModalContainer(), showBatch).then(result => {
    if (result.applyToAll && (result.action === 'merge' || result.action === 'skip')) {
      ctx.setBatchDirAction(result.action);
    }
    return result;
  });
}

export function resetBatchConflictState(ctx: TransferContext): void {
  ctx.setBatchFileAction(null);
  ctx.setBatchDirAction(null);
  ctx.setBatchUploadCount(0);
}

function findUploadByRecordId(ctx: TransferContext, id: string): [number, ActiveUpload] | null {
  for (const [numTid, au] of ctx.activeUploads) {
    if (au.recordId === id) return [numTid, au];
  }
  return null;
}

function findDownloadByRecordId(ctx: TransferContext, id: string): [number, DownloadState] | null {
  for (const [numTid, ds] of ctx.activeDownloads) {
    if (ds.currentDownloadId === id) return [numTid, ds];
  }
  return null;
}

export function pauseTransfer(ctx: TransferContext, id: string): void {
  const record = ctx.findRecord(id);
  if (!record || record.status !== 'inprogress') return;

  if (record.type === 'upload') {
    const found = findUploadByRecordId(ctx, id);
    if (found) {
      const [numTid, au] = found;
      au.isPaused = true;
      if (isBackendUpload(au)) {
        void sendBackendUploadControl(ctx, numTid, 'pause').catch(err => {
          console.error('Pause backend upload failed:', err);
        });
      }
      ctx.updateTransferProgress(id, record.progress, 'paused');
    }
  } else if (record.type === 'download') {
    const found = findDownloadByRecordId(ctx, id);
    if (found) {
      const [numTid, ds] = found;
      ds.isDownloadPaused = true;
      if (isBackendDownload(ds)) {
        void sendBackendDownloadControl(ctx, numTid, 'pause').catch(err => {
          console.error('Pause backend download failed:', err);
        });
      } else {
        sendDownloadCtrl(ctx, MsgFileDownloadPause, numTid);
      }
      ctx.updateTransferProgress(id, record.progress, 'paused');
    }
  }
}

export function resumeTransfer(ctx: TransferContext, id: string): void {
  const record = ctx.findRecord(id);
  if (!record || record.status !== 'paused') return;

  if (record.type === 'upload') {
    const found = findUploadByRecordId(ctx, id);
    if (found) {
      const [numTid, au] = found;
      au.isPaused = false;
      ctx.updateTransferProgress(id, record.progress, 'inprogress');
      if (isBackendUpload(au)) {
        void sendBackendUploadControl(ctx, numTid, 'continue').catch(err => {
          console.error('Resume backend upload failed:', err);
        });
      } else {
        sendUploadChunk(ctx, numTid);
      }
    }
  } else if (record.type === 'download') {
    const found = findDownloadByRecordId(ctx, id);
    if (found) {
      const [numTid, ds] = found;
      ds.isDownloadPaused = false;
      if (isBackendDownload(ds)) {
        void sendBackendDownloadControl(ctx, numTid, 'continue').catch(err => {
          console.error('Resume backend download failed:', err);
        });
      } else {
        sendDownloadCtrl(ctx, MsgFileDownloadContinue, numTid);
      }

      const dl = ds.pendingDownload;
      if (dl && dl.totalSize > 0) {
        const actualProgress = Math.min(Math.round((dl.receivedSize / dl.totalSize) * 100), 99);
        const currentBytes = Math.round(record.size * actualProgress / 100);
        ctx.resetSpeedTracker(id, currentBytes);
        ctx.updateTransferProgress(id, actualProgress, 'inprogress');
      } else {
        ctx.updateTransferProgress(id, record.progress, 'inprogress');
      }
    }
  }
}

export async function cancelTransfer(ctx: TransferContext, id: string): Promise<boolean> {
  const record = ctx.findRecord(id);
  if (!record || (record.status !== 'inprogress' && record.status !== 'paused' && record.status !== 'pending')) return false;

  if (record.type === 'upload') {
    const found = findUploadByRecordId(ctx, id);
    if (found) {
      const [numTid, au] = found;
      if (isBackendUpload(au)) {
        try {
          await sendBackendUploadControl(ctx, numTid, 'cancel');
        } catch (err) {
          console.error('Cancel backend upload failed:', err);
        }
      }
      await cleanupActiveUpload(ctx, numTid);
      ctx.updateTransferProgress(id, record.progress, 'cancelled', '用户取消');
      if (!isBackendUpload(au)) {
        deleteRemotePartFile(ctx, record.path);
      }
      processNextUpload(ctx);
    } else {
      const queueIdx = ctx.uploadQueue.findIndex(item => item.transferId === id);
      if (queueIdx !== -1) {
        ctx.uploadQueue.splice(queueIdx, 1);
      }
      ctx.updateTransferProgress(id, 0, 'cancelled', '用户取消');
    }
    return true;
  } else if (record.type === 'download') {
    const found = findDownloadByRecordId(ctx, id);
    if (found) {
      const [numTid, ds] = found;
      ds.isDownloadPaused = false;
      if (isBackendDownload(ds)) {
        try {
          await sendBackendDownloadControl(ctx, numTid, 'cancel');
        } catch (err) {
          console.error('Cancel backend download failed:', err);
        }
      } else {
        sendDownloadCtrl(ctx, MsgFileDownloadCancel, numTid);
      }
      ds.currentDownloadId = null;
      ctx.updateTransferProgress(id, record.progress, 'cancelled', '用户取消');
      if (!isBackendDownload(ds)) {
        await cleanupDownload(ds);
      }
      ctx.activeDownloads.delete(numTid);
      processNextDownload(ctx);
    } else {
      const queueIdx = ctx.downloadQueue.findIndex(item => item.transferId === id);
      if (queueIdx !== -1) {
        ctx.downloadQueue.splice(queueIdx, 1);
      }
      ctx.updateTransferProgress(id, 0, 'cancelled', '用户取消');
    }
    return true;
  }
  return false;
}

export function sendDownloadCtrl(ctx: TransferContext, msgType: number, numTid: number): void {
  if (!ctx.isConnected) return;
  try {
    const payload = JSON.stringify({ transferId: numTid });
    ctx.send(encodeMessage(msgType, new TextEncoder().encode(payload)));
  } catch { /* ignore */ }
}

export function deleteRemotePartFile(ctx: TransferContext, remotePath: string): void {
  if (!ctx.isConnected) return;
  ctx.setPendingPartCleanup(true);
  const partPath = remotePath + '.meterm.part';
  const request: FileOperationRequest = { operation: 'delete', path: partPath };
  const message = encodeMessage(MsgFileOperation, new TextEncoder().encode(JSON.stringify(request)));
  ctx.send(message);
  console.log(`Cleaning up remote temp file: ${partPath}`);
}

export async function revealInFileManager(savePath: string): Promise<void> {
  try {
    const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
    await revealItemInDir(savePath);
  } catch (err) {
    console.error('Failed to reveal in file manager:', err);
  }
}

export async function handleDragEvent(ctx: TransferContext, payload: { type: string; paths?: string[] }, listElement: HTMLElement): Promise<void> {
  const fileListContainer = listElement.closest('.file-list');
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

    ctx.setBatchUploadCount(filePaths.length);

    for (const filePath of filePaths) {
      try {
        const info = await fsStat(filePath);
        if (info.isDirectory) {
          const dirName = filePath.replace(/\\/g, '/').split('/').pop() || 'unknown';
          await uploadDirectory(ctx, filePath, dirName);
        } else {
          const fileName = filePath.replace(/\\/g, '/').split('/').pop() || 'unknown';
          if (!validateFileName(fileName)) {
            console.warn(`Skipping invalid filename: ${fileName}`);
            continue;
          }
          await uploadLocalFile(ctx, filePath);
        }
      } catch (err) {
        console.error(`Failed to upload file ${filePath}:`, err);
      }
    }

    resetBatchConflictState(ctx);
  }
}

export async function failAllTransfers(ctx: TransferContext, errorMessage: string): Promise<void> {
  for (const [numTid, ds] of ctx.activeDownloads) {
    if (isBackendDownload(ds)) {
      continue;
    }
    if (ds.currentDownloadId) {
      ctx.updateTransferProgress(ds.currentDownloadId, 0, 'failed', errorMessage);
    }
    _cleanupDownloadState(ds);
    ctx.activeDownloads.delete(numTid);
  }
  for (const [numTid, ds] of ctx.activeDownloads) {
    if (!isBackendDownload(ds)) {
      ctx.activeDownloads.delete(numTid);
    }
  }
  for (const item of ctx.downloadQueue) {
    ctx.updateTransferProgress(item.transferId, 0, 'failed', errorMessage);
  }
  ctx.downloadQueue.length = 0;

  for (const [, au] of ctx.activeUploads) {
    if (au.fileHandle) { try { await au.fileHandle.close(); } catch { /* ignore */ } }
    if (au.recordId) ctx.updateTransferProgress(au.recordId, 0, 'failed', errorMessage);
  }
  ctx.activeUploads.clear();
  for (const item of ctx.uploadQueue) {
    ctx.updateTransferProgress(item.transferId, 0, 'failed', errorMessage);
  }
  ctx.uploadQueue.length = 0;
}
