import { writeTextFile, readTextFile, mkdir, exists, readDir, remove, BaseDirectory } from '@tauri-apps/plugin-fs';
import { t } from './i18n';
import { thinkingIcon } from './ai-icons';
import { renderMarkdown } from './ai-capsule-markdown';
import { fuzzyMatch, formatRelativeTime } from './ai-capsule-history';
import { buildToolCard } from './ai-capsule-tool-ui';
import type { AICapsuleInstance, ConvEntry, ChatConversation } from './ai-capsule-types';

const CHAT_DIR = 'chat-history';
const FS_OPTS = { baseDir: BaseDirectory.AppData };

let _chatHistoryDirReady = false;

export async function ensureChatDir(): Promise<void> {
  if (_chatHistoryDirReady) return;
  if (!(await exists(CHAT_DIR, FS_OPTS))) {
    await mkdir(CHAT_DIR, { recursive: true, ...FS_OPTS });
  }
  _chatHistoryDirReady = true;
}

export async function saveConversation(
  instance: AICapsuleInstance,
  snapshot?: { id: string; messages: ConvEntry[] },
): Promise<void> {
  const id = snapshot?.id ?? instance.currentConversationId;
  const msgs = snapshot?.messages ?? instance.messages;
  if (msgs.length === 0) return;
  try {
    await ensureChatDir();
    const firstUser = msgs.find(m => m.type === 'user');
    const conv: ChatConversation = {
      id,
      title: firstUser ? firstUser.content.slice(0, 80) : 'Untitled',
      messages: msgs,
      createdAt: msgs[0]?.timestamp || Date.now(),
      updatedAt: Date.now(),
    };
    const safeId = conv.id.replace(/[^a-zA-Z0-9_-]/g, '');
    if (!safeId) return;
    const filePath = `${CHAT_DIR}/${safeId}.json`;
    await writeTextFile(filePath, JSON.stringify(conv), FS_OPTS);
  } catch (e) {
    console.error('[chat-history] save failed:', e);
  }
}

export async function loadConversations(): Promise<ChatConversation[]> {
  try {
    await ensureChatDir();
    const entries = await readDir(CHAT_DIR, FS_OPTS);
    const convs: ChatConversation[] = [];
    for (const entry of entries) {
      if (!entry.name?.endsWith('.json')) continue;
      if (/[/\\]/.test(entry.name)) continue;
      try {
        const content = await readTextFile(`${CHAT_DIR}/${entry.name}`, FS_OPTS);
        const raw = JSON.parse(content) as ChatConversation;
        // Migrate old format: { role, content } → { type, content }
        if (raw.messages?.length && 'role' in raw.messages[0]) {
          raw.messages = (raw.messages as unknown as { role: string; content: string; timestamp: number }[])
            .map(m => ({ type: (m.role === 'user' ? 'user' : 'assistant') as 'user' | 'assistant', content: m.content, timestamp: m.timestamp }));
        }
        convs.push(raw);
      } catch (e) { console.error('[chat-history] read failed:', entry.name, e); }
    }
    convs.sort((a, b) => b.updatedAt - a.updatedAt);
    return convs;
  } catch (e) { console.error('[chat-history] load failed:', e); return []; }
}

export async function deleteConversation(id: string): Promise<void> {
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safe) return;
  try {
    await ensureChatDir();
    await remove(`${CHAT_DIR}/${safe}.json`, FS_OPTS);
  } catch { /* ignore */ }
}

export function confirmDeleteConversation(
  setDeleteSkipUntil: (ts: number) => void,
): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'ai-danger-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'ai-danger-dialog';

    const title = document.createElement('div');
    title.className = 'ai-danger-title';
    title.textContent = t('aiChatDeleteConfirmTitle');

    const msg = document.createElement('div');
    msg.className = 'ai-danger-msg';
    msg.textContent = t('aiChatDeleteConfirmMsg');

    const checkboxRow = document.createElement('label');
    checkboxRow.className = 'ai-delete-checkbox-row';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'ai-delete-checkbox';
    const checkLabel = document.createElement('span');
    checkLabel.textContent = t('aiChatDeleteNoAskMinutes');
    checkboxRow.appendChild(checkbox);
    checkboxRow.appendChild(checkLabel);

    const actions = document.createElement('div');
    actions.className = 'ai-danger-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'ai-danger-btn ai-danger-btn-cancel';
    cancelBtn.textContent = t('aiChatDeleteConfirmCancel');

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'ai-danger-btn ai-danger-btn-run';
    deleteBtn.textContent = t('aiChatDeleteConfirmOk');

    const close = (result: boolean) => {
      if (result && checkbox.checked) {
        setDeleteSkipUntil(Date.now() + 5 * 60 * 1000);
      }
      overlay.remove();
      resolve(result);
    };

    cancelBtn.addEventListener('click', () => close(false));
    deleteBtn.addEventListener('click', () => close(true));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });

    actions.appendChild(cancelBtn);
    actions.appendChild(deleteBtn);
    dialog.appendChild(title);
    dialog.appendChild(msg);
    dialog.appendChild(checkboxRow);
    dialog.appendChild(actions);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    cancelBtn.focus();
  });
}

export function renderChatHistoryListFromCache(
  instance: AICapsuleInstance,
  convs: ChatConversation[],
  deps: {
    ensurePopupResizeHandle: (panel: HTMLElement, aiBar: HTMLElement) => void;
    restoreConversation: (inst: AICapsuleInstance, conv: ChatConversation) => void;
    handleDeleteConversation: (inst: AICapsuleInstance, convId: string) => void;
  },
  filter?: string,
): void {
  const panel = instance.element.querySelector('.ai-bar-chat-history-panel') as HTMLDivElement;
  if (!panel) return;

  panel.innerHTML = '';
  deps.ensurePopupResizeHandle(panel, instance.element);

  const filtered = filter
    ? convs.filter(c => fuzzyMatch(c.title, filter) ||
        c.messages.some(m => m.type !== 'tool_call' && fuzzyMatch(m.content, filter)))
    : convs;

  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'ai-chat-hist-empty';
    empty.textContent = t('aiChatHistoryEmpty');
    panel.appendChild(empty);
    return;
  }

  const list = document.createElement('div');
  list.className = 'ai-chat-hist-list';

  for (const conv of filtered) {
    const row = document.createElement('div');
    row.className = 'ai-chat-hist-row';

    const info = document.createElement('div');
    info.className = 'ai-chat-hist-info';
    info.addEventListener('click', () => deps.restoreConversation(instance, conv));

    const rowTitle = document.createElement('div');
    rowTitle.className = 'ai-chat-hist-row-title';
    rowTitle.textContent = conv.title;

    const rowMeta = document.createElement('div');
    rowMeta.className = 'ai-chat-hist-row-meta';
    rowMeta.textContent = `${conv.messages.length} msgs · ${formatRelativeTime(conv.updatedAt)}`;

    info.appendChild(rowTitle);
    info.appendChild(rowMeta);

    const delBtn = document.createElement('button');
    delBtn.className = 'ai-chat-hist-delete';
    delBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/></svg>`;
    delBtn.title = t('aiChatDeleteConfirmOk');
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      deps.handleDeleteConversation(instance, conv.id);
    });

    row.appendChild(info);
    row.appendChild(delBtn);
    list.appendChild(row);
  }

  panel.appendChild(list);
}

export function renderChatHistoryDetail(
  instance: AICapsuleInstance,
  conv: ChatConversation,
  deps: {
    ensurePopupResizeHandle: (panel: HTMLElement, aiBar: HTMLElement) => void;
    renderChatHistoryList: (inst: AICapsuleInstance) => void;
    addHistory: (inst: AICapsuleInstance, cmd: string, source: 'manual' | 'ai') => void;
    bindCommandButtons: (inst: AICapsuleInstance, container: Element) => void;
  },
): void {
  const panel = instance.element.querySelector('.ai-bar-chat-history-panel') as HTMLDivElement;
  if (!panel) return;
  panel.innerHTML = '';
  deps.ensurePopupResizeHandle(panel, instance.element);

  const header = document.createElement('div');
  header.className = 'ai-chat-hist-header';

  const backBtn = document.createElement('button');
  backBtn.className = 'ai-chat-hist-back';
  backBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="10 3 5 8 10 13"/></svg>`;
  backBtn.title = t('aiChatHistoryBack');
  backBtn.addEventListener('click', () => deps.renderChatHistoryList(instance));

  const title = document.createElement('span');
  title.className = 'ai-chat-hist-title';
  title.textContent = conv.title;

  header.appendChild(backBtn);
  header.appendChild(title);
  panel.appendChild(header);

  const msgContainer = document.createElement('div');
  msgContainer.className = 'ai-chat-hist-messages';

  for (const msg of conv.messages) {
    const msgEl = document.createElement('div');
    const content = document.createElement('div');
    content.className = 'ai-msg-content';

    if (msg.type === 'tool_call') {
      msgContainer.appendChild(buildToolCard(msg));
      continue;
    } else if (msg.type === 'assistant') {
      msgEl.className = 'ai-msg ai-msg-assistant';
      const addHistoryCb = (cmd: string) => deps.addHistory(instance, cmd, 'ai');
      content.innerHTML = renderMarkdown(msg.content, instance.sessionId, addHistoryCb);
    } else if (msg.type === 'thinking') {
      // Reasoning — standalone block (no bubble)
      if (msg.reasoning) {
        const block = document.createElement('div');
        block.className = 'ai-thinking-block';
        const details = document.createElement('details');
        details.className = 'ai-reasoning';
        const summary = document.createElement('summary');
        summary.innerHTML = `${thinkingIcon(12)} <span>${t('aiThinking')}</span>`;
        const textEl = document.createElement('div');
        textEl.className = 'ai-reasoning-text';
        textEl.textContent = msg.reasoning;
        details.appendChild(summary);
        details.appendChild(textEl);
        block.appendChild(details);
        msgContainer.appendChild(block);
      }
      // Assistant text — render as regular bubble
      if (msg.content) {
        msgEl.className = 'ai-msg ai-msg-assistant';
        const addHistoryCb = (cmd: string) => deps.addHistory(instance, cmd, 'ai');
        content.innerHTML = renderMarkdown(msg.content, instance.sessionId, addHistoryCb);
      } else {
        continue; // No content to render as a bubble
      }
    } else if (msg.type === 'system') {
      msgEl.className = 'ai-msg ai-msg-system';
      content.textContent = msg.content;
    } else {
      // user
      msgEl.className = 'ai-msg ai-msg-user';
      content.textContent = msg.content;
    }

    msgEl.appendChild(content);
    msgContainer.appendChild(msgEl);
  }

  panel.appendChild(msgContainer);

  // Bind command buttons in rendered markdown
  deps.bindCommandButtons(instance, msgContainer);
}
