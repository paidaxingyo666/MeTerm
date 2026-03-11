// 文件管理器工具函数（纯函数，无状态依赖）

/** 格式化文件大小为人类可读字符串 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** 格式化传输速度为人类可读字符串 */
export function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec <= 0) return '';
  if (bytesPerSec < 1024) return `${bytesPerSec.toFixed(0)} B/s`;
  if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
  if (bytesPerSec < 1024 * 1024 * 1024) return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
  return `${(bytesPerSec / (1024 * 1024 * 1024)).toFixed(2)} GB/s`;
}

/** 格式化耗时为人类可读字符串 */
export function formatElapsed(ms: number): string {
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

/** 编码二进制消息：[1B type][payload] */
export function encodeMessage(type: number, payload: Uint8Array): Uint8Array {
  const message = new Uint8Array(1 + payload.length);
  message[0] = type;
  message.set(payload, 1);
  return message;
}

/** 将磁盘写入错误转换为用户友好的中文提示 */
export function getDiskErrorMessage(err: unknown): string {
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

/** 验证文件名合法性 */
export function validateFileName(name: string): boolean {
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
