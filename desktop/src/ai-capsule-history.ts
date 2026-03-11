import { writeText as clipboardWriteText } from '@tauri-apps/plugin-clipboard-manager';
import { t } from './i18n';
import { DrawerManager } from './drawer';
import { MAX_HISTORY, HISTORY_STORAGE_KEY } from './ai-capsule-types';
import type { HistoryEntry, AICapsuleInstance } from './ai-capsule-types';

export function getHistoryKey(sessionId: string): string {
  const info = DrawerManager.getServerInfo(sessionId);
  if (info) return `${info.username}@${info.host}:${info.port}`;
  return 'local';
}

export function storageKey(historyKey: string): string {
  return `${HISTORY_STORAGE_KEY}:${historyKey}`;
}

export function loadHistory(historyKey: string): HistoryEntry[] {
  try {
    const stored = localStorage.getItem(storageKey(historyKey));
    if (stored) return JSON.parse(stored) as HistoryEntry[];
  } catch { /* ignore */ }
  return [];
}

export function saveHistory(historyKey: string, history: HistoryEntry[]): void {
  try {
    localStorage.setItem(storageKey(historyKey), JSON.stringify(history));
  } catch { /* ignore */ }
}

export function addHistory(
  instance: AICapsuleInstance,
  command: string,
  source: 'manual' | 'ai',
  capsules: Map<string, AICapsuleInstance>,
  renderHistoryPanel: (inst: AICapsuleInstance) => void,
): void {
  instance.history = instance.history.filter((h) => h.command !== command);
  instance.history.unshift({ command, timestamp: Date.now(), source });
  if (instance.history.length > MAX_HISTORY) instance.history.length = MAX_HISTORY;
  saveHistory(instance.historyKey, instance.history);
  capsules.forEach((other) => {
    if (other !== instance && other.historyKey === instance.historyKey) {
      other.history = instance.history;
    }
  });
  if (instance.historyOpen) renderHistoryPanel(instance);
}

// 模糊匹配：query 中的每个空格分隔的关键词都须在 text 中出现（不区分大小写）
export function fuzzyMatch(text: string, query: string): boolean {
  const lower = text.toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every(kw => lower.includes(kw));
}

// 切换输入框到搜索模式
export function enterSearchMode(
  instance: AICapsuleInstance,
  placeholder: string,
  onInput: () => void,
  savedPlaceholder: Map<string, string>,
  savedInputValue: Map<string, string>,
  filterListener: Map<string, () => void>,
): void {
  const input = instance.element.querySelector('.ai-bar-input') as HTMLInputElement;
  if (!input) return;
  const sid = instance.sessionId;
  savedPlaceholder.set(sid, input.placeholder);
  savedInputValue.set(sid, input.value);
  input.value = '';
  input.placeholder = placeholder;
  input.classList.add('searching');
  input.addEventListener('input', onInput);
  filterListener.set(sid, onInput);
}

// 退出搜索模式，恢复输入框
export function exitSearchMode(
  instance: AICapsuleInstance,
  savedPlaceholder: Map<string, string>,
  savedInputValue: Map<string, string>,
  filterListener: Map<string, () => void>,
): void {
  const input = instance.element.querySelector('.ai-bar-input') as HTMLInputElement;
  if (!input) return;
  const sid = instance.sessionId;
  const listener = filterListener.get(sid);
  if (listener) {
    input.removeEventListener('input', listener);
    filterListener.delete(sid);
  }
  input.value = savedInputValue.get(sid) ?? '';
  input.placeholder = savedPlaceholder.get(sid) ?? ' ';
  input.classList.remove('searching');
  savedPlaceholder.delete(sid);
  savedInputValue.delete(sid);
}

export function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 5) return t('aiTimeJustNow');
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  return `${months}mo`;
}

export function renderHistoryPanel(
  instance: AICapsuleInstance,
  deps: {
    ensurePopupResizeHandle: (panel: HTMLElement, aiBar: HTMLElement) => void;
    handleDeleteHistoryEntry: (inst: AICapsuleInstance, entry: HistoryEntry) => void;
    savedInputValue: Map<string, string>;
    closeHistory: (inst: AICapsuleInstance) => void;
  },
  filter?: string,
): void {
  const panel = instance.element.querySelector('.ai-bar-history-panel') as HTMLDivElement;
  if (!panel) return;

  panel.innerHTML = '';
  deps.ensurePopupResizeHandle(panel, instance.element);

  const filtered = filter
    ? instance.history.filter(e => fuzzyMatch(e.command, filter))
    : instance.history;

  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'ai-history-empty';
    empty.textContent = filter ? t('aiHistoryEmpty') : t('aiHistoryEmpty');
    panel.appendChild(empty);
    return;
  }

  filtered.forEach((entry) => {
    const row = document.createElement('div');
    row.className = 'ai-history-row';
    row.title = entry.command;

    const cmdSpan = document.createElement('span');
    cmdSpan.className = 'ai-history-cmd';
    cmdSpan.textContent = entry.command;

    const meta = document.createElement('span');
    meta.className = 'ai-history-meta';
    const relTime = formatRelativeTime(entry.timestamp);
    const sourceLabel = entry.source === 'ai' ? 'AI' : t('aiSourceManual');
    meta.textContent = `${relTime} \u00B7 ${sourceLabel}`;

    const copyBtn = document.createElement('button');
    copyBtn.className = 'ai-history-copy';
    copyBtn.title = t('aiCopyCommand');
    copyBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="5" width="9" height="9" rx="1.5"/><path d="M5 11H3.5A1.5 1.5 0 012 9.5v-7A1.5 1.5 0 013.5 1h7A1.5 1.5 0 0112 2.5V5"/></svg>`;
    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      void clipboardWriteText(entry.command);
      copyBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 8.5 6.5 12 13 4"/></svg>`;
      copyBtn.classList.add('copied');
      setTimeout(() => {
        copyBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="5" width="9" height="9" rx="1.5"/><path d="M5 11H3.5A1.5 1.5 0 012 9.5v-7A1.5 1.5 0 013.5 1h7A1.5 1.5 0 0112 2.5V5"/></svg>`;
        copyBtn.classList.remove('copied');
      }, 1200);
    });

    const delBtn = document.createElement('button');
    delBtn.className = 'ai-history-delete';
    delBtn.title = t('aiChatDeleteConfirmOk');
    delBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/></svg>`;
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      deps.handleDeleteHistoryEntry(instance, entry);
    });

    row.appendChild(cmdSpan);
    row.appendChild(meta);
    row.appendChild(copyBtn);
    row.appendChild(delBtn);

    row.addEventListener('click', () => {
      // 将选中的命令设为"恢复值"，关闭弹窗时会写入输入框
      deps.savedInputValue.set(instance.sessionId, entry.command);
      deps.closeHistory(instance);
      const input = instance.element.querySelector('.ai-bar-input') as HTMLInputElement;
      if (input) input.focus();
    });

    panel.appendChild(row);
  });
}

export function removeHistoryEntry(
  instance: AICapsuleInstance,
  entry: HistoryEntry,
  capsules: Map<string, AICapsuleInstance>,
  renderPanel: (inst: AICapsuleInstance) => void,
): void {
  instance.history = instance.history.filter((h) => h !== entry);
  saveHistory(instance.historyKey, instance.history);
  // Sync to other instances with same historyKey
  capsules.forEach((other) => {
    if (other !== instance && other.historyKey === instance.historyKey) {
      other.history = instance.history;
    }
  });
  if (instance.historyOpen) renderPanel(instance);
}
