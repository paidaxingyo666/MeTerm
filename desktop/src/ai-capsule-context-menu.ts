import { writeText as clipboardWriteText } from '@tauri-apps/plugin-clipboard-manager';
import { t } from './i18n';
import type { AICapsuleInstance } from './ai-capsule-types';

type MenuItem = { label: string; action: () => void; disabled?: boolean } | 'divider';

/** Attach context-menu handler to the messages container (event delegation). */
export function bindChatContextMenu(
  instance: AICapsuleInstance,
  container: Element | undefined,
  deps: {
    resolveMessageIndex: (inst: AICapsuleInstance, domNodes: Element[], domPos: number) => number;
    showBubbleContextMenu: (e: MouseEvent, items: MenuItem[]) => void;
    saveConversation: (inst: AICapsuleInstance) => void;
  },
): void {
  const el = container ?? instance.chatPanel?.querySelector('.ai-chat-messages');
  if (!el) return;
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation(); // Prevent global handler from interfering
    const target = e.target as HTMLElement;

    // Find closest message bubble or tool card
    const bubble = target.closest('.ai-msg') as HTMLElement | null;
    const toolCard = target.closest('.ai-tool-card') as HTMLElement | null;
    const thinkingBlock = target.closest('.ai-thinking-block') as HTMLElement | null;

    if (!bubble && !toolCard && !thinkingBlock) return;

    // Determine raw text for copying
    let rawText = '';
    let msgIndex = -1;
    let isUser = false;

    if (bubble) {
      const content = bubble.querySelector('.ai-msg-content');
      rawText = content?.textContent ?? '';
      isUser = bubble.classList.contains('ai-msg-user');
      // Find matching message index
      const allMsgs = Array.from(el.querySelectorAll('.ai-msg, .ai-tool-card, .ai-thinking-block'));
      const pos = allMsgs.indexOf(bubble);
      msgIndex = deps.resolveMessageIndex(instance, allMsgs, pos);
    } else if (toolCard) {
      const resultEl = toolCard.querySelector('.ai-tool-result pre');
      const argsEl = toolCard.querySelector('.ai-tool-args-inline code');
      rawText = resultEl?.textContent ?? argsEl?.textContent ?? '';
      const allMsgs = Array.from(el.querySelectorAll('.ai-msg, .ai-tool-card, .ai-thinking-block'));
      const pos = allMsgs.indexOf(toolCard);
      msgIndex = deps.resolveMessageIndex(instance, allMsgs, pos);
    } else if (thinkingBlock) {
      const textEl = thinkingBlock.querySelector('.ai-reasoning-text');
      rawText = textEl?.textContent ?? '';
      const allMsgs = Array.from(el.querySelectorAll('.ai-msg, .ai-tool-card, .ai-thinking-block'));
      const pos = allMsgs.indexOf(thinkingBlock);
      msgIndex = deps.resolveMessageIndex(instance, allMsgs, pos);
    }

    // Build menu items
    const items: MenuItem[] = [];

    // Copy selected text (if any text is selected within the bubble)
    const selection = window.getSelection();
    const hasSelection = selection && selection.toString().trim().length > 0;

    if (hasSelection) {
      items.push({ label: t('aiCtxCopy'), action: () => void clipboardWriteText(selection!.toString()) });
    } else if (toolCard) {
      // Tool card: copy result if available
      const resultEl = toolCard.querySelector('.ai-tool-result pre');
      if (resultEl?.textContent) {
        items.push({ label: t('aiCtxCopyResult'), action: () => void clipboardWriteText(resultEl.textContent ?? '') });
      }
      const argsEl = toolCard.querySelector('.ai-tool-args-inline code');
      if (argsEl?.textContent) {
        items.push({ label: t('aiCtxCopy'), action: () => void clipboardWriteText(argsEl.textContent ?? '') });
      }
    } else if (rawText) {
      items.push({ label: t('aiCtxCopy'), action: () => void clipboardWriteText(rawText) });
    }

    // Resend (user messages only)
    if (isUser && rawText && !instance.isStreaming) {
      if (items.length > 0) items.push('divider');
      items.push({
        label: t('aiCtxResend'),
        action: () => {
          const input = instance.element.querySelector('.ai-bar-input') as HTMLInputElement | null;
          if (input) {
            input.value = rawText;
            input.focus();
          }
        },
      });
    }

    // Delete message
    if (msgIndex >= 0 && !instance.isStreaming) {
      if (items.length > 0) items.push('divider');
      items.push({
        label: t('aiCtxDelete'),
        action: () => {
          instance.messages.splice(msgIndex, 1);
          // Remove DOM element
          if (bubble) bubble.remove();
          else if (toolCard) toolCard.remove();
          else if (thinkingBlock) thinkingBlock.remove();
          deps.saveConversation(instance);
        },
      });
    }

    if (items.length === 0) return;
    deps.showBubbleContextMenu(e as MouseEvent, items);
  });
}

/** Map a DOM position index to the corresponding messages[] index. */
export function resolveMessageIndex(instance: AICapsuleInstance, domNodes: Element[], domPos: number): number {
  // Walk the messages array, counting rendered elements to match domPos.
  let rendered = 0;
  for (let i = 0; i < instance.messages.length; i++) {
    const msg = instance.messages[i];
    if (msg.type === 'thinking') {
      // A thinking entry can produce 1-2 DOM elements (reasoning block + content bubble)
      if (msg.reasoning) { if (rendered === domPos) return i; rendered++; }
      if (msg.content) { if (rendered === domPos) return i; rendered++; }
      if (!msg.reasoning && !msg.content) { rendered++; }
    } else {
      if (rendered === domPos) return i;
      rendered++;
    }
  }
  return -1;
}

/** Show a context menu at mouse position with given items. */
export function showBubbleContextMenu(e: MouseEvent, items: MenuItem[]): void {
  // Remove any existing menu
  document.querySelector('.ai-bubble-ctx-menu')?.remove();

  const menu = document.createElement('div');
  menu.className = 'custom-context-menu ai-bubble-ctx-menu';

  for (const item of items) {
    if (item === 'divider') {
      const div = document.createElement('div');
      div.className = 'custom-context-menu-divider';
      menu.appendChild(div);
      continue;
    }
    const btn = document.createElement('button');
    btn.className = 'custom-context-menu-item';
    btn.textContent = item.label;
    if (item.disabled) btn.disabled = true;
    btn.addEventListener('click', () => {
      menu.remove();
      item.action();
    });
    menu.appendChild(btn);
  }

  // Position
  menu.style.left = `${e.clientX}px`;
  menu.style.top = `${e.clientY}px`;
  document.body.appendChild(menu);

  // Adjust if menu overflows viewport
  requestAnimationFrame(() => {
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) menu.style.left = `${window.innerWidth - rect.width - 4}px`;
    if (rect.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - rect.height - 4}px`;
  });

  // Close on outside click / Escape
  const close = (ev: Event) => {
    if (ev.type === 'keydown' && (ev as KeyboardEvent).key !== 'Escape') return;
    menu.remove();
    document.removeEventListener('click', close);
    document.removeEventListener('keydown', close);
  };
  // Delay to prevent immediate close from the contextmenu event
  setTimeout(() => {
    document.addEventListener('click', close);
    document.addEventListener('keydown', close);
  }, 0);
}
