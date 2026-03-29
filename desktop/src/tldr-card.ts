import { t } from './i18n';
import { createOverlayScrollbar } from './overlay-scrollbar';
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
  _anchorEl: HTMLElement,
  options?: { onExampleClick?: (command: string) => void },
): void {
  dismissTldrPopup();

  // Overlay backdrop
  const overlay = document.createElement('div');
  overlay.className = 'tldr-popup-overlay';

  const popup = document.createElement('div');
  popup.className = 'tldr-popup';

  // Scrollable content container
  const scrollWrap = document.createElement('div');
  scrollWrap.className = 'tldr-popup-scroll';

  const card = createTldrCard(page, {
    onExampleClick: (cmd) => {
      if (options?.onExampleClick) options.onExampleClick(cmd);
    },
  });
  scrollWrap.appendChild(card);
  popup.appendChild(scrollWrap);

  // Overlay scrollbar (vertical + horizontal)
  createOverlayScrollbar({ viewport: scrollWrap, container: popup, horizontal: true });

  // Close button
  const closeBtn = document.createElement('button');
  closeBtn.className = 'tldr-popup-close';
  closeBtn.innerHTML = '&times;';
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation(); // Don't propagate to document click handlers
    dismissTldrPopup();
  });
  popup.appendChild(closeBtn);

  overlay.appendChild(popup);
  document.body.appendChild(overlay);

  activePopup = overlay;

  // Stop all clicks inside overlay from propagating to document
  // (prevents closing the history panel underneath)
  overlay.addEventListener('click', (e) => {
    e.stopPropagation();
    if (e.target === overlay) dismissTldrPopup();
  });

  // Dismiss on Escape (capture phase, stop propagation)
  const onEscape = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
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
