// 传输历史管理模块（存储/加载/渲染/虚拟滚动/暂停继续取消）

import { escapeHtml } from './status-bar';
import { formatSize, formatSpeed, formatElapsed } from './file-utils';

/** 传输记录类型 */
export interface TransferRecord {
  id: string;
  type: 'upload' | 'download';
  filename: string;
  path: string;
  size: number;
  progress: number;
  status: 'pending' | 'inprogress' | 'completed' | 'failed' | 'paused' | 'cancelled';
  timestamp: number;
  error?: string;
  savePath?: string;
  startTime?: number;
  endTime?: number;
}

/** 传输控制委托：由 FileManager 实现 */
export interface TransferControlDelegate {
  pauseUpload(id: string): void;
  resumeUpload(id: string): void;
  cancelUpload(id: string): void;
  pauseDownload(id: string): void;
  resumeDownload(id: string): void;
  cancelDownload(id: string): void;
  revealInFileManager(savePath: string): Promise<void>;
}

const STORAGE_KEY = 'meterm-transfer-history';

export class TransferHistoryManager {
  private sessionId: string;
  private transferHistory: TransferRecord[] = [];
  private maxHistoryLength = 200;
  private speedTracker: Map<string, { lastBytes: number; lastTime: number; speed: number }> = new Map();
  private delegate: TransferControlDelegate | null = null;

  // 虚拟滚动
  private static readonly ITEM_HEIGHT = 95;
  private static readonly VIRTUAL_BUFFER = 5;
  private virtualScrollBound = false;
  private lastVirtualRange: { start: number; end: number } | null = null;
  private transferDelegationBound = new WeakSet<HTMLElement>();

  constructor(sessionId: string) {
    this.sessionId = sessionId;
    this.loadTransferHistory();
  }

  setDelegate(delegate: TransferControlDelegate): void {
    this.delegate = delegate;
  }

  // 从 localStorage 恢复传输历史
  private loadTransferHistory(): void {
    try {
      const data = localStorage.getItem(STORAGE_KEY);
      if (data) {
        this.transferHistory = JSON.parse(data);
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

  private saveTransferHistory(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.transferHistory));
    } catch (err) {
      console.error('Failed to save transfer history:', err);
    }
  }

  clearTransferHistory(): void {
    this.transferHistory = this.transferHistory.filter(
      r => r.status === 'inprogress' || r.status === 'paused' || r.status === 'pending'
    );
    this.saveTransferHistory();
    this.lastVirtualRange = null;
    this.renderTransferHistory();
  }

  addTransferRecord(type: 'upload' | 'download', filename: string, path: string, size: number, savePath?: string): string {
    const id = `${type}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const record: TransferRecord = {
      id,
      type,
      filename,
      path,
      size,
      progress: 0,
      status: 'pending',
      timestamp: Date.now(),
      savePath,
    };

    this.transferHistory.unshift(record);
    if (this.transferHistory.length > this.maxHistoryLength) {
      this.transferHistory = this.transferHistory.slice(0, this.maxHistoryLength);
    }

    this.saveTransferHistory();
    document.dispatchEvent(new CustomEvent('status-bar-transfer', {
      detail: { sessionId: this.sessionId, id, type, progress: 0, status: 'pending' }
    }));
    return id;
  }

  updateTransferProgress(id: string, progress: number, status: TransferRecord['status'], error?: string): void {
    const record = this.transferHistory.find(r => r.id === id);
    if (record) {
      const statusChanged = record.status !== status;
      record.progress = progress;
      record.status = status;
      if (error) {
        record.error = error;
      }

      if (statusChanged) {
        if (status === 'inprogress' && !record.startTime) {
          record.startTime = Date.now();
        }
        if (status === 'completed' || status === 'failed' || status === 'cancelled') {
          record.endTime = Date.now();
          this.speedTracker.delete(id);
        }
        if (status === 'paused') {
          this.speedTracker.delete(id);
        }
      }

      if (status === 'inprogress' && record.size > 0) {
        const now = Date.now();
        const currentBytes = Math.round(record.size * progress / 100);
        const tracker = this.speedTracker.get(id);
        if (tracker) {
          const dt = (now - tracker.lastTime) / 1000;
          if (dt >= 0.5) {
            const db = currentBytes - tracker.lastBytes;
            tracker.speed = db > 0 ? db / dt : 0;
            tracker.lastBytes = currentBytes;
            tracker.lastTime = now;
          }
        } else {
          this.speedTracker.set(id, { lastBytes: currentBytes, lastTime: now, speed: 0 });
        }
      }

      if (statusChanged) {
        this.saveTransferHistory();
      }
      const historyContainer = document.getElementById(`transfer-history-${this.sessionId}`);
      if (historyContainer && historyContainer.style.display !== 'none') {
        if (statusChanged) {
          this.renderTransferHistory();
        } else {
          this.updateProgressInPlace(id, progress);
        }
      }
      document.dispatchEvent(new CustomEvent('status-bar-transfer', {
        detail: { sessionId: this.sessionId, id, type: record.type, progress, status }
      }));
    }
  }

  /** 重新初始化速度追踪器（恢复下载后调用） */
  resetSpeedTracker(id: string, currentBytes: number): void {
    this.speedTracker.set(id, { lastBytes: currentBytes, lastTime: Date.now(), speed: 0 });
  }

  deleteSpeedTracker(id: string): void {
    this.speedTracker.delete(id);
  }

  findRecord(id: string): TransferRecord | undefined {
    return this.transferHistory.find(r => r.id === id);
  }

  private updateProgressInPlace(id: string, progress: number): void {
    const historyList = document.getElementById(`history-list-${this.sessionId}`);
    if (!historyList) return;
    const item = historyList.querySelector(`[data-transfer-id="${id}"]`);
    if (!item) return;
    const fill = item.querySelector('.progress-fill') as HTMLElement | null;
    if (fill) fill.style.width = `${progress}%`;
    const text = item.querySelector('.progress-text');
    if (text) text.textContent = `${progress}%`;

    const tracker = this.speedTracker.get(id);
    let speedEl = item.querySelector('.transfer-speed') as HTMLElement | null;
    const speedStr = tracker ? formatSpeed(tracker.speed) : '';
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
      if (elapsedEl) elapsedEl.textContent = formatElapsed(Date.now() - record.startTime);
    }
  }

  private renderTransferItem(record: TransferRecord): string {
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
      const speedStr = tracker ? formatSpeed(tracker.speed) : '';
      if (speedStr) speedHtml = `<span class="transfer-speed">${speedStr}</span>`;
      if (record.startTime) {
        elapsedHtml = `<span class="transfer-elapsed">${formatElapsed(Date.now() - record.startTime)}</span>`;
      }
    } else if (record.status === 'paused' && record.startTime) {
      elapsedHtml = `<span class="transfer-elapsed">${formatElapsed(Date.now() - record.startTime)}</span>`;
    } else if ((record.status === 'completed' || record.status === 'failed' || record.status === 'cancelled') && record.startTime) {
      const end = record.endTime || Date.now();
      elapsedHtml = `<span class="transfer-elapsed">${formatElapsed(end - record.startTime)}</span>`;
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
          <span class="file-size">${formatSize(record.size)}</span>
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

    const scrollContainer = historyList.parentElement as HTMLElement;
    if (!scrollContainer) return;

    if (!this.virtualScrollBound) {
      this.virtualScrollBound = true;
      scrollContainer.addEventListener('scroll', () => this.updateVirtualSlice());
      this.ensureTransferDelegation(historyList);
    }

    this.lastVirtualRange = null;
    this.updateVirtualSlice();
  }

  private updateVirtualSlice(): void {
    const historyList = document.getElementById(`history-list-${this.sessionId}`);
    if (!historyList) return;
    const scrollContainer = historyList.parentElement as HTMLElement;
    if (!scrollContainer) return;

    const total = this.transferHistory.length;
    const itemH = TransferHistoryManager.ITEM_HEIGHT;
    const buffer = TransferHistoryManager.VIRTUAL_BUFFER;

    const scrollTop = scrollContainer.scrollTop;
    const viewHeight = scrollContainer.clientHeight;

    const startIdx = Math.max(0, Math.floor(scrollTop / itemH) - buffer);
    const endIdx = Math.min(total, Math.ceil((scrollTop + viewHeight) / itemH) + buffer);

    if (this.lastVirtualRange && this.lastVirtualRange.start === startIdx && this.lastVirtualRange.end === endIdx) {
      return;
    }
    this.lastVirtualRange = { start: startIdx, end: endIdx };

    const totalHeight = total * itemH;
    const topPad = startIdx * itemH;

    historyList.style.height = `${totalHeight}px`;
    historyList.style.paddingTop = `${topPad}px`;
    historyList.style.boxSizing = 'border-box';

    const slice = this.transferHistory.slice(startIdx, endIdx);
    historyList.innerHTML = slice.map(r => this.renderTransferItem(r)).join('');
  }

  private ensureTransferDelegation(container: HTMLElement): void {
    if (this.transferDelegationBound.has(container)) return;
    this.transferDelegationBound.add(container);

    container.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;

      const pauseBtn = target.closest('.pause-btn') as HTMLElement | null;
      if (pauseBtn?.dataset.id) {
        e.stopPropagation();
        this.handlePause(pauseBtn.dataset.id);
        return;
      }

      const resumeBtn = target.closest('.resume-btn') as HTMLElement | null;
      if (resumeBtn?.dataset.id) {
        e.stopPropagation();
        this.handleResume(resumeBtn.dataset.id);
        return;
      }

      const cancelBtn = target.closest('.cancel-btn') as HTMLElement | null;
      if (cancelBtn?.dataset.id) {
        e.stopPropagation();
        this.handleCancel(cancelBtn.dataset.id);
        return;
      }

      const savePath = target.closest('.save-path.clickable') as HTMLElement | null;
      if (savePath?.dataset.savePath) {
        e.stopPropagation();
        this.delegate?.revealInFileManager(savePath.dataset.savePath);
        return;
      }
    });
  }

  private handlePause(id: string): void {
    const record = this.transferHistory.find(r => r.id === id);
    if (!record || record.status !== 'inprogress') return;
    if (record.type === 'upload') {
      this.delegate?.pauseUpload(id);
    } else {
      this.delegate?.pauseDownload(id);
    }
  }

  private handleResume(id: string): void {
    const record = this.transferHistory.find(r => r.id === id);
    if (!record || record.status !== 'paused') return;
    if (record.type === 'upload') {
      this.delegate?.resumeUpload(id);
    } else {
      this.delegate?.resumeDownload(id);
    }
  }

  private handleCancel(id: string): void {
    const record = this.transferHistory.find(r => r.id === id);
    if (!record || (record.status !== 'inprogress' && record.status !== 'paused' && record.status !== 'pending')) return;
    if (record.type === 'upload') {
      this.delegate?.cancelUpload(id);
    } else {
      this.delegate?.cancelDownload(id);
    }
  }
}
