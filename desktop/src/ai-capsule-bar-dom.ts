// ─── AI Capsule: AI Bar DOM Builder ─────────────────────────
// Builds the AI Bar element (model selector, input, buttons) and
// manages its placeholder overlay SVG icons. Extracted from
// ai-capsule.ts to slim the manager class.

import { t } from './i18n';
import { loadSettings } from './themes';
import { updateModelLabel, buildModelDropdown } from './ai-capsule-model-ui';
import type { AICapsuleInstance } from './ai-capsule-types';
import {
  PopupResizeState,
  adjustPopupMaxHeight,
  observePopupResize,
  unobservePopupResize,
} from './ai-capsule-popup-resize';

export interface BarDomCallbacks {
  createTrustSwitcher: () => HTMLDivElement;
  hideBar: () => void;
}

// ─── SVG icons ─────────────────────────────────────────────

/**
 * Paperclip icon for the "attach image" button.
 * Sized to fill the 16×16 viewBox so it visually matches the other
 * AI bar buttons (terminal / LLM / history / chat-history).
 */
export const ATTACH_ICON_SVG = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 7.2L7.4 13.3a3.5 3.5 0 0 1-5-5L8.6 2.2a2.3 2.3 0 0 1 3.3 3.3L5.7 11.7a1.2 1.2 0 0 1-1.7-1.7l5.5-5.5"/></svg>`;

// ─── SVG key icon fragments (shared) ───────────────────────

const ENTER_KEY_SVG = `<svg class="key-icon" viewBox="0 0 14 14" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 3v4.5a1.5 1.5 0 01-1.5 1.5H4"/><polyline points="6 6 3.5 9 6 12"/></svg>`;
const CMD_ICON_SVG = `<svg class="key-icon" viewBox="0 0 14 14" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="2 3 6 7 2 11"/><line x1="7" y1="11" x2="12" y2="11"/></svg>`;
const BOT_ICON_SVG = `<svg class="key-icon" viewBox="0 0 14 14" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="10" height="7" rx="2"/><line x1="5" y1="11" x2="5" y2="13"/><line x1="9" y1="11" x2="9" y2="13"/><circle cx="5.5" cy="7.5" r="1" fill="currentColor" stroke="none"/><circle cx="8.5" cy="7.5" r="1" fill="currentColor" stroke="none"/><line x1="7" y1="1" x2="7" y2="4"/><circle cx="7" cy="1" r="1" fill="currentColor" stroke="none"/></svg>`;

function modKeySvg(): string {
  const isMac = navigator.userAgent.includes('Mac');
  return isMac
    ? `<svg class="key-icon" viewBox="0 0 14 14" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><text x="7" y="11" text-anchor="middle" font-size="12" font-family="system-ui, -apple-system, sans-serif" fill="currentColor" stroke="none">⌘</text></svg>`
    : `<svg class="key-icon key-icon-wide" viewBox="0 0 24 14" width="24" height="14"><text x="12" y="11" text-anchor="middle" font-size="10" font-family="system-ui, -apple-system, sans-serif" fill="currentColor">Ctrl</text></svg>`;
}

// ─── Create Bar Element ─────────────────────────────────────

export function createBarElement(
  sessionId: string,
  _isSSH: boolean,
  popupState: PopupResizeState,
  cb: BarDomCallbacks,
): HTMLDivElement {
  const bar = document.createElement('div');
  bar.className = 'ai-bar';
  bar.dataset.sessionId = sessionId;

  // Model selector (clickable dropdown)
  const modelSelect = document.createElement('div');
  modelSelect.className = 'ai-bar-model-select';

  const modelLabel = document.createElement('span');
  modelLabel.className = 'ai-bar-model-label';
  updateModelLabel(modelLabel);

  const modelArrow = document.createElement('span');
  modelArrow.className = 'ai-bar-model-arrow';
  modelArrow.innerHTML = `<svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><polyline points="2 3 4 5 6 3"/></svg>`;

  const modelDropdown = document.createElement('div');
  modelDropdown.className = 'ai-bar-model-dropdown styled-scrollbar';
  modelDropdown.style.display = 'none';
  buildModelDropdown(modelDropdown, modelLabel);

  modelSelect.appendChild(modelLabel);
  modelSelect.appendChild(modelArrow);
  modelSelect.appendChild(modelDropdown);

  // Toggle dropdown on click
  modelSelect.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = modelDropdown.style.display !== 'none';
    if (isOpen) {
      modelDropdown.style.display = 'none';
      modelSelect.classList.remove('open');
      unobservePopupResize(popupState);
      popupState.manualHeight = false;
    } else {
      buildModelDropdown(modelDropdown, modelLabel);
      modelDropdown.style.display = '';
      modelSelect.classList.add('open');
      const aiBar = modelSelect.closest('.ai-bar') as HTMLElement;
      if (aiBar) {
        adjustPopupMaxHeight(popupState, modelDropdown, aiBar);
        observePopupResize(popupState, modelDropdown, aiBar);
      }
    }
  });

  // Close dropdown on outside click
  document.addEventListener('click', () => {
    modelDropdown.style.display = 'none';
    modelSelect.classList.remove('open');
    unobservePopupResize(popupState);
    popupState.manualHeight = false;
  });

  // Input wrapper (for custom placeholder overlay)
  const inputWrap = document.createElement('div');
  inputWrap.className = 'ai-bar-input-wrap';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'ai-bar-input';
  input.placeholder = ' '; // non-empty so :placeholder-shown works
  input.autocapitalize = 'off';
  input.setAttribute('autocorrect', 'off');
  input.spellcheck = false;

  // Custom placeholder with SVG key icons
  const phOverlay = document.createElement('div');
  phOverlay.className = 'ai-bar-placeholder';
  const modKey = modKeySvg();
  // Default placeholder (will be synced properly after create via syncBarPlaceholder)
  phOverlay.innerHTML = `<span class="ai-ph-seg">${CMD_ICON_SVG}${ENTER_KEY_SVG}</span><span class="ai-ph-sep">/</span><span class="ai-ph-seg">${BOT_ICON_SVG}${modKey}<span class="ai-ph-plus">+</span>${ENTER_KEY_SVG}</span>`;

  inputWrap.appendChild(input);
  inputWrap.appendChild(phOverlay);

  // Send to terminal button (Enter)
  const termBtn = document.createElement('button');
  termBtn.className = 'ai-bar-btn ai-bar-btn-term';
  termBtn.title = `${t('aiSendCommand')} (Enter)`;
  termBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="4 6 8 2 12 6"/><line x1="8" y1="2" x2="8" y2="14"/></svg>`;

  // Send to LLM button (Ctrl+Enter)
  const llmBtn = document.createElement('button');
  llmBtn.className = 'ai-bar-btn ai-bar-btn-llm';
  llmBtn.title = `${t('aiSendPrompt')} (Ctrl+Enter)`;
  llmBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 8L7 3.5 13.5 2.5 12.5 9 8 13.5z"/><path d="M2.5 8L6.5 6.5 9.5 9.5 8 13.5"/><circle cx="9.5" cy="6.5" r="1" fill="currentColor" stroke="none"/></svg>`;

  // LLM chat history button
  const chatHistBtn = document.createElement('button');
  chatHistBtn.className = 'ai-bar-btn ai-bar-btn-chat-history';
  chatHistBtn.title = t('aiChatHistory');
  chatHistBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h12v8a1 1 0 01-1 1H5l-3 2.5V4a1 1 0 011-1z"/><line x1="5" y1="6.5" x2="11" y2="6.5"/><line x1="5" y1="9" x2="9" y2="9"/></svg>`;

  // LLM chat history panel (hidden by default)
  const chatHistPanel = document.createElement('div');
  chatHistPanel.className = 'ai-bar-chat-history-panel';
  chatHistPanel.style.display = 'none';

  // History button
  const histBtn = document.createElement('button');
  histBtn.className = 'ai-bar-btn ai-bar-btn-history';
  histBtn.title = t('aiHistory');
  histBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="8" cy="8" r="6"/><polyline points="8 4.5 8 8 10.5 9.5"/></svg>`;

  // History panel (hidden by default)
  const histPanel = document.createElement('div');
  histPanel.className = 'ai-bar-history-panel';
  histPanel.style.display = 'none';

  // Attach image button — opens file picker; right-click pastes
  // from clipboard via the Rust fallback. The actual event wiring
  // happens in wireImageAttachmentHandlers (image-attach.ts).
  // The SVG fills the full 16×16 viewBox so it visually matches
  // the other AI bar buttons.
  const attachBtn = document.createElement('button');
  attachBtn.className = 'ai-bar-btn ai-bar-btn-attach';
  attachBtn.title = 'Attach image (left click: pick file · right click: paste from clipboard)';
  attachBtn.innerHTML = ATTACH_ICON_SVG;

  bar.appendChild(modelSelect);
  bar.appendChild(inputWrap);
  bar.appendChild(termBtn);
  bar.appendChild(llmBtn);
  bar.appendChild(attachBtn);
  bar.appendChild(chatHistBtn);
  bar.appendChild(chatHistPanel);
  bar.appendChild(histBtn);
  bar.appendChild(histPanel);

  // Trust level switcher
  const trustSwitcher = cb.createTrustSwitcher();
  bar.appendChild(trustSwitcher);

  // Hide AI bar button (always last)
  const hideBtn = document.createElement('button');
  hideBtn.className = 'ai-bar-btn ai-bar-btn-hide';
  hideBtn.title = 'Hide';
  hideBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;
  hideBtn.addEventListener('click', () => cb.hideBar());
  bar.appendChild(hideBtn);

  return bar;
}

// ─── Sync Placeholder ────────────────────────────────────────

/**
 * Sync AI Bar placeholder based on current state:
 * - Side mode active: command-only (Enter → terminal)
 * - Agent mode: swapped (Enter → Agent, Ctrl+Enter → terminal)
 * - Default: Enter → terminal, Ctrl+Enter → Agent
 */
export function syncBarPlaceholder(instance: AICapsuleInstance): void {
  const ph = instance.element.querySelector('.ai-bar-placeholder') as HTMLDivElement;
  if (!ph) return;

  const modKey = modKeySvg();
  const sideActive = instance.element.classList.contains('ai-bar--side-active');
  const agentMode = loadSettings().aiEnterSendsToAgent;
  const chatActive = instance.chatOpen || instance.chatMinimized;

  if (sideActive) {
    // Side mode: AI Bar is command-only
    ph.innerHTML = `<span class="ai-ph-seg">${CMD_ICON_SVG}${t('aiPlaceholderCmd')}${ENTER_KEY_SVG}</span>`;
  } else if (chatActive) {
    // Chat open/minimized: Enter → Agent
    ph.innerHTML = `<span class="ai-ph-seg">${BOT_ICON_SVG}${t('aiPlaceholderAgentMode')}${ENTER_KEY_SVG}</span>`;
  } else if (agentMode) {
    // Agent mode: Enter → Agent, Ctrl+Enter → Terminal
    ph.innerHTML = `<span class="ai-ph-seg">${BOT_ICON_SVG}${ENTER_KEY_SVG}</span><span class="ai-ph-sep">/</span><span class="ai-ph-seg">${CMD_ICON_SVG}${modKey}<span class="ai-ph-plus">+</span>${ENTER_KEY_SVG}</span>`;
  } else {
    // Default: Enter → Terminal, Ctrl+Enter → Agent
    ph.innerHTML = `<span class="ai-ph-seg">${CMD_ICON_SVG}${ENTER_KEY_SVG}</span><span class="ai-ph-sep">/</span><span class="ai-ph-seg">${BOT_ICON_SVG}${modKey}<span class="ai-ph-plus">+</span>${ENTER_KEY_SVG}</span>`;
  }
}
