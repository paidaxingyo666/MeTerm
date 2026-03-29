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
  startDownloadFromQueue as _startDownloadFromQueue,
  handleDownloadChunk as _handleDownloadChunk,
  cleanupDownloadState as _cleanupDownloadState,
  resumeDownload as _resumeDownload,
} from './file-download';
import { readFile, stat as fsStat } from '@tauri-apps/plugin-fs';

export { _handleDownloadChunk as handleDownloadChunk };

export interface TransferContext {
  isConnected: boolean;
  send: (data: Uint8Array) => void;
  currentPath: string;
  files: import('./protocol').FileInfo[];

  pendingUpload: { path: string; content: Uint8Array; offset: number } | null;
  setPendingUpload: (v: { path: string; content: Uint8Array; offset: number } | null) => void;
  inFlightChunks: number;
  setInFlightChunks: (v: number) => void;
  pipelineSize: number;
  setPipelineSize: (v: number) => void;
  pipelineAckCount: number;
  setPipelineAckCount: (v: number) => void;
  isUploadPaused: boolean;
  setIsUploadPaused: (v: boolean) => void;
  currentUploadId: string | null;
  setCurrentUploadId: (v: string | null) => void;
  uploadQueue: Array<{ path: string; content: Uint8Array; filename: string; size: number; transferId: string }>;

  dlState: DownloadState;
  setDlState: (v: DownloadState) => void;
  downloadQueue: DownloadQueueItem[];
  isProcessingDownload: boolean;
  setIsProcessingDownload: (v: boolean) => void;

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
  findRecord: (id: string) => { type: 'upload' | 'download'; status: string; progress: number; path: string; size: number } | undefined;
  resetSpeedTracker: (id: string, currentBytes: number) => void;

  speedLimit: number; // 0 = unlimited, bytes/s
  getModalContainer: () => HTMLElement;
  loadDirectory: (path: string) => Promise<void>;
}

export function adaptPipeline(ctx: TransferContext): void {
  const result = _adaptPipeline({
    inFlightChunks: ctx.inFlightChunks,
    pipelineSize: ctx.pipelineSize,
    pipelineAckCount: ctx.pipelineAckCount,
  });
  ctx.setPipelineSize(result.pipelineSize);
  ctx.setPipelineAckCount(result.pipelineAckCount);
}

export function sendUploadChunk(ctx: TransferContext): void {
  const CHUNK_SIZE = 1 * 1024 * 1024;

  if (ctx.isUploadPaused) return;

  // 限速模式：每次只发一个 chunk，然后 delay
  const effectivePipeline = ctx.speedLimit > 0 ? 1 : ctx.pipelineSize;

  while (
    ctx.pendingUpload &&
    ctx.isConnected &&
    ctx.inFlightChunks < effectivePipeline &&
    !ctx.isUploadPaused
  ) {
    const totalSize = ctx.pendingUpload.content.length;
    const offset = ctx.pendingUpload.offset;

    if (offset >= totalSize) break;

    const end = Math.min(offset + CHUNK_SIZE, totalSize);
    const chunkData = ctx.pendingUpload.content.slice(offset, end);

    const payload = new Uint8Array(16 + chunkData.length);
    const view = new DataView(payload.buffer);
    view.setBigUint64(0, BigInt(totalSize));
    view.setBigUint64(8, BigInt(offset));
    payload.set(chunkData, 16);

    ctx.send(encodeMessage(MsgFileUploadChunk, payload));

    ctx.pendingUpload.offset = end;
    ctx.setInFlightChunks(ctx.inFlightChunks + 1);

    const progress = totalSize > 0 ? Math.min(Math.round((end / totalSize) * 100), 99) : 99;
    if (ctx.currentUploadId) {
      ctx.updateTransferProgress(ctx.currentUploadId, progress, 'inprogress');
    }

    console.log(`Sent chunk ${offset}-${end}/${totalSize} (in-flight: ${ctx.inFlightChunks}/${effectivePipeline})`);

    // 限速时只发一个 chunk 后退出循环，等 ACK 回来时再 delay 发送
    if (ctx.speedLimit > 0) break;
  }
}

export function resumeUpload(ctx: TransferContext): void {
  if (!ctx.pendingUpload || !ctx.isConnected) {
    if (ctx.pendingUpload) {
      ctx.setPendingUpload(null);
      if (ctx.currentUploadId) {
        ctx.updateTransferProgress(ctx.currentUploadId, 0, 'failed', '连接已断开');
        ctx.setCurrentUploadId(null);
      }
    }
    return;
  }

  console.log(`Attempting upload resume for ${ctx.pendingUpload.path}`);
  const request = JSON.stringify({ path: ctx.pendingUpload.path, size: ctx.pendingUpload.content.length });
  const message = encodeMessage(MsgFileUploadResume, new TextEncoder().encode(request));
  ctx.send(message);
}

export async function resumeDownload(ctx: TransferContext): Promise<void> {
  await _resumeDownload(ctx.isConnected ? (data: Uint8Array) => ctx.send(data) : null, ctx.dlState, dlCallbacks(ctx));
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
    const { readFile } = await import('@tauri-apps/plugin-fs');

    ctx.setBatchUploadCount(filePaths.length);

    for (const filePath of filePaths) {
      try {
        const content = await readFile(filePath);
        const filename = filePath.replace(/\\/g, '/').split('/').pop() || 'file';
        await uploadFile(ctx, filename, content);
      } catch (err) {
        console.error(`Failed to read file ${filePath}:`, err);
      }
    }

    resetBatchConflictState(ctx);
  } catch (err) {
    console.error('Upload failed:', err);
  }
}

export async function uploadFile(ctx: TransferContext, filename: string, content: Uint8Array, targetDir?: string): Promise<void> {
  const dir = targetDir || ctx.currentPath;
  let actualFilename = filename;
  let targetPath = dir === '/'
    ? `/${filename}`
    : `${dir}/${filename}`;

  if (!ctx.isConnected) {
    console.error('WebSocket not ready');
    return;
  }

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

  const transferId = ctx.addTransferRecord('upload', actualFilename, targetPath, content.length);
  ctx.uploadQueue.push({ path: targetPath, content, filename: actualFilename, size: content.length, transferId });

  if (!ctx.pendingUpload) {
    processNextUpload(ctx);
  }
}

export function processNextUpload(ctx: TransferContext): void {
  if (ctx.uploadQueue.length === 0) {
    ctx.loadDirectory(ctx.currentPath);
    return;
  }
  if (ctx.pendingUpload) return;
  if (!ctx.isConnected) {
    for (const item of ctx.uploadQueue) {
      ctx.updateTransferProgress(item.transferId, 0, 'failed', '连接已断开');
    }
    ctx.uploadQueue.length = 0;
    return;
  }

  const item = ctx.uploadQueue.shift()!;

  ctx.setCurrentUploadId(item.transferId);
  ctx.updateTransferProgress(ctx.currentUploadId!, 0, 'inprogress');

  ctx.setPendingUpload({ path: item.path, content: item.content, offset: 0 });
  ctx.setInFlightChunks(0);
  ctx.setPipelineSize(2);
  ctx.setPipelineAckCount(0);

  const request = JSON.stringify({ path: item.path, size: item.size });
  const message = encodeMessage(MsgFileUploadStart, new TextEncoder().encode(request));
  ctx.send(message);
  console.log(`Starting upload of ${item.filename} to ${item.path}`);
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
      const content = await readFile(f.localPath);
      const targetDir = ctx.currentPath === '/'
        ? `/${dirName}/${f.relativePath}`.replace(/\/[^/]+$/, '') || '/'
        : `${ctx.currentPath}/${dirName}/${f.relativePath}`.replace(/\/[^/]+$/, '');
      const filename = f.localPath.replace(/\\/g, '/').split('/').pop() || 'unknown';
      await uploadFile(ctx, filename, content, targetDir);
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
  const filePath = ctx.currentPath === '/'
    ? `/${filename}`
    : `${ctx.currentPath}/${filename}`;

  if (!ctx.isConnected) {
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

    if (!ctx.isConnected) {
      alert('连接已断开，请稍后重试');
      return;
    }

    const fileInfo = ctx.files.find(f => f.name === filename);
    const fileSize = fileInfo ? fileInfo.size : 0;

    const transferId = ctx.addTransferRecord('download', filename, filePath, fileSize, savePath);
    const queueItem: DownloadQueueItem = { filename, remotePath: filePath, savePath, fileSize, transferId, isDir };
    ctx.downloadQueue.push(queueItem);

    if (!ctx.dlState.pendingDownload && !ctx.isProcessingDownload) {
      await processNextDownload(ctx);
    }
  } catch (err) {
    console.error('Download failed:', err);
    alert(`下载失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function processNextDownload(ctx: TransferContext): Promise<void> {
  if (ctx.downloadQueue.length === 0) return;
  if (ctx.dlState.pendingDownload || ctx.isProcessingDownload) return;
  if (!ctx.isConnected) {
    for (const item of ctx.downloadQueue) {
      ctx.updateTransferProgress(item.transferId, 0, 'failed', '连接已断开');
    }
    ctx.downloadQueue.length = 0;
    return;
  }

  ctx.setIsProcessingDownload(true);
  const item = ctx.downloadQueue.shift()!;
  ctx.setDlState(await _startDownloadFromQueue(item, ctx.isConnected ? (data: Uint8Array) => ctx.send(data) : null, ctx.dlState, dlCallbacks(ctx)));
  ctx.setIsProcessingDownload(false);
}

export async function cleanupDownload(ctx: TransferContext): Promise<void> {
  await _cleanupDownloadState(ctx.dlState);
}

export function dlCallbacks(ctx: TransferContext) {
  return {
    updateTransferProgress: (id: string, progress: number, status: 'pending' | 'inprogress' | 'completed' | 'failed' | 'paused' | 'cancelled', error?: string) => {
      ctx.updateTransferProgress(id, progress, status, error);
    },
    addTransferRecord: (type: 'upload' | 'download', filename: string, path: string, size: number, savePath?: string) => {
      return ctx.addTransferRecord(type, filename, path, size, savePath);
    },
    onDownloadFinished: () => {
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

export function pauseTransfer(ctx: TransferContext, id: string): void {
  const record = ctx.findRecord(id);
  if (!record || record.status !== 'inprogress') return;

  if (record.type === 'upload' && ctx.currentUploadId === id) {
    ctx.setIsUploadPaused(true);
    ctx.updateTransferProgress(id, record.progress, 'paused');
  } else if (record.type === 'download' && ctx.dlState.currentDownloadId === id) {
    ctx.dlState.isDownloadPaused = true;
    sendDownloadCtrl(ctx, MsgFileDownloadPause);
    ctx.updateTransferProgress(id, record.progress, 'paused');
  }
}

export function resumeTransfer(ctx: TransferContext, id: string): void {
  const record = ctx.findRecord(id);
  if (!record || record.status !== 'paused') return;

  if (record.type === 'upload' && ctx.currentUploadId === id) {
    ctx.setIsUploadPaused(false);
    ctx.updateTransferProgress(id, record.progress, 'inprogress');
    sendUploadChunk(ctx);
  } else if (record.type === 'download' && ctx.dlState.currentDownloadId === id) {
    ctx.dlState.isDownloadPaused = false;
    sendDownloadCtrl(ctx, MsgFileDownloadContinue);

    const dl = ctx.dlState.pendingDownload;
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

export async function cancelTransfer(ctx: TransferContext, id: string): Promise<void> {
  const record = ctx.findRecord(id);
  if (!record || (record.status !== 'inprogress' && record.status !== 'paused' && record.status !== 'pending')) return;

  if (record.type === 'upload') {
    if (ctx.currentUploadId === id) {
      ctx.setIsUploadPaused(false);
      ctx.setPendingUpload(null);
      ctx.setInFlightChunks(0);
      ctx.setCurrentUploadId(null);
      ctx.updateTransferProgress(id, record.progress, 'cancelled', '用户取消');
      deleteRemotePartFile(ctx, record.path);
      processNextUpload(ctx);
    } else {
      const queueIdx = ctx.uploadQueue.findIndex(item => item.transferId === id);
      if (queueIdx !== -1) {
        ctx.uploadQueue.splice(queueIdx, 1);
      }
      ctx.updateTransferProgress(id, 0, 'cancelled', '用户取消');
    }
  } else if (record.type === 'download') {
    if (ctx.dlState.currentDownloadId === id) {
      ctx.dlState.isDownloadPaused = false;
      sendDownloadCtrl(ctx, MsgFileDownloadCancel);
      ctx.dlState.currentDownloadId = null;
      ctx.updateTransferProgress(id, record.progress, 'cancelled', '用户取消');
      await cleanupDownload(ctx);
      processNextDownload(ctx);
    } else {
      const queueIdx = ctx.downloadQueue.findIndex(item => item.transferId === id);
      if (queueIdx !== -1) {
        ctx.downloadQueue.splice(queueIdx, 1);
      }
      ctx.updateTransferProgress(id, 0, 'cancelled', '用户取消');
    }
  }
}

export function sendDownloadCtrl(ctx: TransferContext, msgType: number): void {
  if (!ctx.isConnected) return;
  try {
    ctx.send(encodeMessage(msgType, new Uint8Array(0)));
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
          const content = await readFile(filePath);
          await uploadFile(ctx, fileName, content);
        }
      } catch (err) {
        console.error(`Failed to upload file ${filePath}:`, err);
      }
    }

    resetBatchConflictState(ctx);
  }
}

export function failAllTransfers(ctx: TransferContext, errorMessage: string): void {
  if (ctx.dlState.pendingDownload) {
    if (ctx.dlState.currentDownloadId) {
      ctx.updateTransferProgress(ctx.dlState.currentDownloadId, 0, 'failed', errorMessage);
      ctx.dlState.currentDownloadId = null;
    }
    cleanupDownload(ctx);
  }
  for (const item of ctx.downloadQueue) {
    ctx.updateTransferProgress(item.transferId, 0, 'failed', errorMessage);
  }
  ctx.downloadQueue.length = 0;

  if (ctx.pendingUpload) {
    ctx.setPendingUpload(null);
    if (ctx.currentUploadId) {
      ctx.updateTransferProgress(ctx.currentUploadId, 0, 'failed', errorMessage);
      ctx.setCurrentUploadId(null);
    }
  }
  for (const item of ctx.uploadQueue) {
    ctx.updateTransferProgress(item.transferId, 0, 'failed', errorMessage);
  }
  ctx.uploadQueue.length = 0;
}
