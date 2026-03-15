// 文件下载模块：纯函数和可参数化的下载辅助逻辑

import { writeFile as fsWriteFile, remove as fsRemove, exists as fsExists, stat as fsStat } from '@tauri-apps/plugin-fs';
import { encodeMessage, formatSize, getDiskErrorMessage } from './file-utils';
import {
  MsgFileDownloadStart,
  MsgFileDownloadResume,
  type FileInfo,
} from './protocol';

/** 下载缓冲写入批次大小 */
export const WRITE_BATCH_SIZE = 8 * 1024 * 1024; // 8MB per disk write

/** pending 下载状态 */
export interface PendingDownload {
  filename: string;
  savePath: string;
  remotePath: string;
  totalSize: number;
  receivedSize: number;
}

/** 下载状态集合——由 FileManager 持有，传递给下载函数 */
export interface DownloadState {
  pendingDownload: PendingDownload | null;
  downloadBuffer: Uint8Array[];
  downloadBufferSize: number;
  writeQueue: Uint8Array[];
  isWriting: boolean;
  writeError: string | null;
  isDownloadPaused: boolean;
  currentDownloadId: string | null;
  lastDownloadProgressUpdate: number;
}

/** 下载队列项 */
export interface DownloadQueueItem {
  filename: string;
  remotePath: string;
  savePath: string;
  fileSize: number;
  transferId: string;
  isDir: boolean;
}

/** 创建初始下载状态 */
export function createDownloadState(): DownloadState {
  return {
    pendingDownload: null,
    downloadBuffer: [],
    downloadBufferSize: 0,
    writeQueue: [],
    isWriting: false,
    writeError: null,
    isDownloadPaused: false,
    currentDownloadId: null,
    lastDownloadProgressUpdate: 0,
  };
}

/**
 * 从队列项启动下载（不弹保存对话框，savePath 已确定）
 */
export async function startDownloadFromQueue(
  item: DownloadQueueItem,
  ws: WebSocket | null,
  state: DownloadState,
  callbacks: DownloadCallbacks,
): Promise<DownloadState> {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    callbacks.updateTransferProgress(item.transferId, 0, 'failed', '连接已断开');
    callbacks.onDownloadFinished?.();
    return state;
  }

  const newState = { ...state };

  try {
    // 复用入队时已创建的 pending 传输记录，切换为 inprogress
    newState.currentDownloadId = item.transferId;
    callbacks.updateTransferProgress(newState.currentDownloadId, 0, 'inprogress');

    // 创建空文件（后续以 append 模式追加写入）
    await fsWriteFile(item.savePath, new Uint8Array(0));
    newState.writeQueue = [];
    newState.isWriting = false;
    newState.writeError = null;

    newState.pendingDownload = {
      filename: item.filename,
      savePath: item.savePath,
      remotePath: item.remotePath,
      totalSize: 0,
      receivedSize: 0,
    };

    const request = JSON.stringify({ path: item.remotePath });
    const message = encodeMessage(MsgFileDownloadStart, new TextEncoder().encode(request));
    try {
      ws.send(message);
    } catch (sendErr) {
      console.error('Failed to send download request:', sendErr);
      newState.pendingDownload = null;
      await cleanupDownloadState(newState);
      callbacks.updateTransferProgress(newState.currentDownloadId, 0, 'failed', '发送请求失败');
      newState.currentDownloadId = null;
      callbacks.onDownloadFinished?.();
      return newState;
    }

    console.log(`Downloading ${item.remotePath} to ${item.savePath}`);
  } catch (err) {
    console.error('Download failed:', err);
    await cleanupDownloadState(newState);
    if (newState.currentDownloadId) {
      callbacks.updateTransferProgress(newState.currentDownloadId, 0, 'failed', err instanceof Error ? err.message : String(err));
      newState.currentDownloadId = null;
    }
    callbacks.onDownloadFinished?.();
  }

  return newState;
}

/** FileManager 回调接口——下载函数需要调用的 FileManager 方法 */
export interface DownloadCallbacks {
  updateTransferProgress(id: string, progress: number, status: 'pending' | 'inprogress' | 'completed' | 'failed' | 'paused' | 'cancelled', error?: string): void;
  addTransferRecord(type: 'upload' | 'download', filename: string, path: string, size: number, savePath?: string): string;
  /** 当前下载完成或失败后调用，触发队列中下一个下载 */
  onDownloadFinished?(): void;
}

/**
 * 发起文件下载：弹出保存对话框 + 发送下载请求
 * 返回更新后的 DownloadState
 */
export async function downloadFile(
  filename: string,
  currentPath: string,
  files: FileInfo[],
  ws: WebSocket | null,
  state: DownloadState,
  callbacks: DownloadCallbacks,
  isDir: boolean = false,
): Promise<DownloadState> {
  const filePath = currentPath === '/'
    ? `/${filename}`
    : `${currentPath}/${filename}`;

  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.error('WebSocket not ready');
    return state;
  }

  // 复制 state 以进行更新
  const newState = { ...state };

  try {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const defaultName = isDir ? `${filename}.zip` : filename;
    const savePath = await save({
      defaultPath: defaultName,
      filters: isDir
        ? [{ name: 'ZIP 压缩文件', extensions: ['zip'] }]
        : []
    });

    if (!savePath) return newState;

    // 保存对话框期间 WebSocket 可能已断开，重新检查
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.error('WebSocket disconnected during save dialog');
      alert('连接已断开，请稍后重试');
      return newState;
    }

    // 获取文件大小（从当前文件列表中查找）
    const fileInfo = files.find(f => f.name === filename);
    const fileSize = fileInfo ? fileInfo.size : 0;

    // 添加到传输历史（包含本地保存路径）
    newState.currentDownloadId = callbacks.addTransferRecord('download', filename, filePath, fileSize, savePath);
    callbacks.updateTransferProgress(newState.currentDownloadId, 0, 'inprogress');

    // 创建空文件（后续以 append 模式追加写入）
    await fsWriteFile(savePath, new Uint8Array(0));
    newState.writeQueue = [];
    newState.isWriting = false;
    newState.writeError = null;

    newState.pendingDownload = { filename, savePath, remotePath: filePath, totalSize: 0, receivedSize: 0 };

    // Send download request
    const request = JSON.stringify({ path: filePath });
    const message = encodeMessage(MsgFileDownloadStart, new TextEncoder().encode(request));
    try {
      ws.send(message);
    } catch (sendErr) {
      console.error('Failed to send download request:', sendErr);
      newState.pendingDownload = null;
      await cleanupDownloadState(newState);
      if (newState.currentDownloadId) {
        callbacks.updateTransferProgress(newState.currentDownloadId, 0, 'failed', '发送请求失败');
        newState.currentDownloadId = null;
      }
      return newState;
    }

    console.log(`Downloading ${filePath} to ${savePath}`);
  } catch (err) {
    console.error('Download failed:', err);
    alert(`下载失败: ${err instanceof Error ? err.message : String(err)}`);
    await cleanupDownloadState(newState);
    if (newState.currentDownloadId) {
      callbacks.updateTransferProgress(newState.currentDownloadId, 0, 'failed', err instanceof Error ? err.message : String(err));
      newState.currentDownloadId = null;
    }
  }

  return newState;
}

/**
 * 完全同步的数据块处理——缓冲小 chunk，批量推入写入队列
 */
export function handleDownloadChunk(
  content: Uint8Array,
  state: DownloadState,
  callbacks: DownloadCallbacks,
): void {
  if (!state.pendingDownload) {
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
  if (state.pendingDownload.totalSize === 0 && totalSize > 0) {
    state.pendingDownload.totalSize = totalSize;
  }

  // 缓冲小 chunk，累积到 8MB 再推入写入队列
  if (chunkData.length > 0) {
    state.downloadBuffer.push(chunkData);
    state.downloadBufferSize += chunkData.length;
    state.pendingDownload.receivedSize = offset + chunkData.length;

    if (state.downloadBufferSize >= WRITE_BATCH_SIZE) {
      flushDownloadBuffer(state);
    }
  }

  // Throttled progress UI update (~200ms interval)
  const isComplete = totalSize > 0 && state.pendingDownload.receivedSize >= totalSize;
  const now = Date.now();
  if (state.currentDownloadId && !state.isDownloadPaused && (now - state.lastDownloadProgressUpdate >= 200 || isComplete)) {
    state.lastDownloadProgressUpdate = now;
    const progress = totalSize > 0
      ? Math.round((state.pendingDownload.receivedSize / totalSize) * 100)
      : 0;
    callbacks.updateTransferProgress(state.currentDownloadId, isComplete ? 100 : Math.min(progress, 99), 'inprogress');
  }

  // Download complete: flush remaining buffer（暂停时不 finalize，等恢复后处理）
  if (isComplete && !state.isDownloadPaused) {
    flushDownloadBuffer(state);
    finalizeDownload(state, callbacks);
  }
}

/** 将缓冲区合并为一个批次，推入写入队列 */
export function flushDownloadBuffer(state: DownloadState): void {
  if (state.downloadBuffer.length === 0 || !state.pendingDownload) return;
  const merged = new Uint8Array(state.downloadBufferSize);
  let pos = 0;
  for (const chunk of state.downloadBuffer) {
    merged.set(chunk, pos);
    pos += chunk.length;
  }
  state.downloadBuffer = [];
  state.downloadBufferSize = 0;
  state.writeQueue.push(merged);
  processWriteQueue(state);
}

/** 异步写入队列处理——独立于消息循环，逐批写入磁盘 */
export async function processWriteQueue(state: DownloadState): Promise<void> {
  if (state.isWriting || !state.pendingDownload) return;
  state.isWriting = true;
  try {
    while (state.writeQueue.length > 0 && state.pendingDownload) {
      const batch = state.writeQueue.shift()!;
      await fsWriteFile(state.pendingDownload.savePath, batch, { append: true });
    }
  } catch (err) {
    console.error('Write queue failed:', err);
    state.writeError = getDiskErrorMessage(err);
  }
  state.isWriting = false;
}

/** 完成下载：等待写入队列排空 */
export async function finalizeDownload(
  state: DownloadState,
  callbacks: DownloadCallbacks,
): Promise<void> {
  if (!state.pendingDownload) return;
  try {
    // 等待写入队列排空（通常已经几乎空了，因为写入与接收并行）
    while (state.writeQueue.length > 0 || state.isWriting) {
      await new Promise(r => setTimeout(r, 50));
    }
    if (!state.pendingDownload) return;

    // 检查写入过程中是否出错
    if (state.writeError) {
      throw new Error(state.writeError);
    }

    console.log(`File saved to ${state.pendingDownload.savePath} (${formatSize(state.pendingDownload.receivedSize)})`);
    if (state.currentDownloadId) {
      callbacks.updateTransferProgress(state.currentDownloadId, 100, 'completed');
      state.currentDownloadId = null;
    }
    state.pendingDownload = null;
    callbacks.onDownloadFinished?.();
  } catch (err) {
    console.error('Failed to finalize download:', err);
    const errMsg = getDiskErrorMessage(err);
    if (state.currentDownloadId) {
      callbacks.updateTransferProgress(state.currentDownloadId, 0, 'failed', errMsg);
      state.currentDownloadId = null;
    }
    await cleanupDownloadState(state);
    callbacks.onDownloadFinished?.();
  }
}

/** 清理下载状态：清空队列、删除不完整文件 */
export async function cleanupDownloadState(state: DownloadState): Promise<void> {
  if (!state.pendingDownload) return;
  const savePath = state.pendingDownload.savePath;
  // 清空缓冲和写入队列
  state.downloadBuffer = [];
  state.downloadBufferSize = 0;
  state.writeQueue = [];
  state.writeError = null;
  // 等待正在进行的写入完成
  while (state.isWriting) {
    await new Promise(r => setTimeout(r, 50));
  }
  try {
    if (await fsExists(savePath)) {
      await fsRemove(savePath);
    }
  } catch { /* ignore cleanup errors */ }
  state.pendingDownload = null;
}

/** 断点续传：检查已写入磁盘的大小，从断点继续下载 */
export async function resumeDownload(
  ws: WebSocket | null,
  state: DownloadState,
  callbacks: DownloadCallbacks,
): Promise<void> {
  if (!state.pendingDownload || !ws || ws.readyState !== WebSocket.OPEN) {
    // Cannot resume, mark as failed
    if (state.pendingDownload) {
      if (state.currentDownloadId) {
        callbacks.updateTransferProgress(state.currentDownloadId, 0, 'failed', '连接已断开');
        state.currentDownloadId = null;
      }
      await cleanupDownloadState(state);
    }
    return;
  }

  try {
    // 等待之前的写入完成
    while (state.isWriting) {
      await new Promise(r => setTimeout(r, 50));
    }
    state.writeQueue = [];
    state.writeError = null;

    // 检查磁盘上实际已写入的大小
    let resumeOffset = 0;
    if (await fsExists(state.pendingDownload.savePath)) {
      const fileStat = await fsStat(state.pendingDownload.savePath);
      resumeOffset = fileStat.size;
    }
    state.pendingDownload.receivedSize = resumeOffset;
  } catch (err) {
    console.error('Failed to setup resume:', err);
    if (state.currentDownloadId) {
      callbacks.updateTransferProgress(state.currentDownloadId, 0, 'failed', '恢复下载失败');
      state.currentDownloadId = null;
    }
    await cleanupDownloadState(state);
    return;
  }

  console.log(`Attempting download resume for ${state.pendingDownload.remotePath} from offset ${state.pendingDownload.receivedSize}`);
  const request = JSON.stringify({ path: state.pendingDownload.remotePath, offset: state.pendingDownload.receivedSize });
  const message = encodeMessage(MsgFileDownloadResume, new TextEncoder().encode(request));
  ws.send(message);
}
