import { t } from './i18n';
import type { TldrPage } from './tldr-help';

/**
 * Create a tldr help card element for a given page.
 */
export function createTldrCard(page: TldrPage, options?: {
  onExampleClick?: (command: string) => void;
  compact?: boolean;
}): HTMLDivElement {
  const card = document.createElement('div');
  card.className = 'tldr-card' + (options?.compact ? ' tldr-card-compact' : '');

  // Header: command name + platform badge
  const header = document.createElement('div');
  header.className = 'tldr-card-header';
  const nameEl = document.createElement('span');
  nameEl.className = 'tldr-card-name';
  nameEl.textContent = page.name;
  header.appendChild(nameEl);
  if (page.platform && page.platform !== 'common') {
    const badge = document.createElement('span');
    badge.className = 'tldr-card-badge';
    badge.textContent = page.platform;
    header.appendChild(badge);
  }
  card.appendChild(header);

  // Description
  const desc = document.createElement('div');
  desc.className = 'tldr-card-desc';
  desc.textContent = page.description;
  card.appendChild(desc);

  // Examples
  if (page.examples.length > 0) {
    const exSection = document.createElement('div');
    exSection.className = 'tldr-card-examples';
    const exTitle = document.createElement('div');
    exTitle.className = 'tldr-card-examples-title';
    exTitle.textContent = t('tldrExamples');
    exSection.appendChild(exTitle);

    for (const ex of page.examples) {
      const exItem = document.createElement('div');
      exItem.className = 'tldr-card-example';

      const exDesc = document.createElement('div');
      exDesc.className = 'tldr-card-example-desc';
      exDesc.textContent = ex.description;
      exItem.appendChild(exDesc);

      const exCmd = document.createElement('code');
      exCmd.className = 'tldr-card-example-cmd';
      exCmd.textContent = ex.command;
      if (options?.onExampleClick) {
        exCmd.classList.add('clickable');
        exCmd.title = 'Click to insert';
        const handler = options.onExampleClick;
        exCmd.addEventListener('click', () => handler(ex.command));
      }
      exItem.appendChild(exCmd);
      exSection.appendChild(exItem);
    }
    card.appendChild(exSection);
  }

  // Attribution (CC BY 4.0)
  const attr = document.createElement('div');
  attr.className = 'tldr-card-attribution';
  attr.innerHTML = 'via <a href="https://github.com/tldr-pages/tldr" target="_blank" rel="noopener">tldr-pages</a> · CC BY 4.0';
  card.appendChild(attr);

  return card;
}

// ─── Popup (floating tldr help) ──────────────────────────────────

let activePopup: HTMLDivElement | null = null;

export function showTldrPopup(
  page: TldrPage,
  anchorEl: HTMLElement,
  options?: { onExampleClick?: (command: string) => void },
): void {
  dismissTldrPopup();

  const popup = document.createElement('div');
  popup.className = 'tldr-popup';

  const card = createTldrCard(page, {
    onExampleClick: options?.onExampleClick,
  });
  popup.appendChild(card);

  // Close button
  const closeBtn = document.createElement('button');
  closeBtn.className = 'tldr-popup-close';
  closeBtn.innerHTML = '&times;';
  closeBtn.addEventListener('click', dismissTldrPopup);
  popup.appendChild(closeBtn);

  document.body.appendChild(popup);

  // Position above the anchor element
  const rect = anchorEl.getBoundingClientRect();
  popup.style.left = `${rect.left}px`;
  popup.style.bottom = `${window.innerHeight - rect.top + 8}px`;

  // Ensure popup stays within viewport
  requestAnimationFrame(() => {
    const popupRect = popup.getBoundingClientRect();
    if (popupRect.right > window.innerWidth - 8) {
      popup.style.left = `${window.innerWidth - popupRect.width - 8}px`;
    }
    if (popupRect.left < 8) {
      popup.style.left = '8px';
    }
  });

  activePopup = popup;

  // Dismiss on outside click
  const onClickOutside = (e: MouseEvent) => {
    if (!popup.contains(e.target as Node)) {
      dismissTldrPopup();
      document.removeEventListener('click', onClickOutside, true);
    }
  };
  setTimeout(() => document.addEventListener('click', onClickOutside, true), 0);

  // Dismiss on Escape
  const onEscape = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      dismissTldrPopup();
      document.removeEventListener('keydown', onEscape, true);
    }
  };
  document.addEventListener('keydown', onEscape, true);
}

export function dismissTldrPopup(): void {
  if (activePopup) {
    activePopup.remove();
    activePopup = null;
  }
}

// ─── Quick help (Ctrl+Shift+H handler) ──────────────────────────

import { queryTldr, extractCommand } from './tldr-help';
import { TerminalRegistry } from './terminal';
import { TabManager } from './tabs';

/**
 * Show tldr help for the command currently under the cursor.
 * Called by Ctrl+Shift+H keyboard shortcut.
 */
export async function showQuickHelp(): Promise<void> {
  const sessionId = TabManager.getActiveSessionId();
  if (!sessionId) return;

  const mt = TerminalRegistry.get(sessionId);
  if (!mt) return;

  // Read current line from terminal buffer
  const buf = mt.terminal.buffer.active;
  const line = buf.getLine(buf.cursorY);
  if (!line) return;

  const lineText = line.translateToString(true).trim();
  if (!lineText) return;

  const cmd = extractCommand(lineText);
  if (!cmd) return;

  const result = await queryTldr(cmd);
  if (!result.found || !result.page) return;

  // Find anchor element (terminal container)
  const container = mt.terminal.element;
  if (!container) return;

  showTldrPopup(result.page, container, {
    onExampleClick: (command) => {
      mt.terminal.paste(command);
      dismissTldrPopup();
    },
  });
}
