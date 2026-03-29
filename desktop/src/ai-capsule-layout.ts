/**
 * ai-capsule-layout.ts — AI chat panel layout mode management
 *
 * Handles switching between bottom panel mode and side panel mode.
 * In side mode, the chat panel moves to a right-side panel in #main-content.
 * The AI Bar stays in #terminal-panel (agent buttons hidden via CSS class),
 * and the side panel has its own independent input area for LLM chat.
 */

import { TerminalRegistry } from './terminal';
import { t } from './i18n';
import { LLM_SEND_SVG } from './ai-capsule-chat-ui';
import { stopIcon } from './ai-icons';
import type { AICapsuleInstance, AIChatLayoutMode } from './ai-capsule-types';

// ── Constants ──

const LS_LAYOUT_KEY = 'meterm-ai-layout-mode';
const LS_SIDE_WIDTH_KEY = 'meterm-ai-side-width';
const DEFAULT_SIDE_WIDTH = 360;
const SIDE_MIN_WIDTH = 280;
const SIDE_MAX_WIDTH = 600;
const SIDE_MIN_RATIO = 0.20;
const SIDE_MAX_RATIO = 0.45;

// ── SVG icons ──

export const SVG_LAYOUT_SIDE = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="2" width="14" height="12" rx="2"/><line x1="10" y1="2" x2="10" y2="14"/></svg>`;
export const SVG_LAYOUT_BOTTOM = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="2" width="14" height="12" rx="2"/><line x1="1" y1="10" x2="15" y2="10"/></svg>`;

// ── Persistence ──

export function getSavedLayoutMode(): AIChatLayoutMode {
  const saved = localStorage.getItem(LS_LAYOUT_KEY);
  return saved === 'side' ? 'side' : 'bottom';
}

export function saveLayoutMode(mode: AIChatLayoutMode): void {
  localStorage.setItem(LS_LAYOUT_KEY, mode);
}

export function getSavedSideWidth(): number {
  const saved = localStorage.getItem(LS_SIDE_WIDTH_KEY);
  if (saved) {
    const w = parseInt(saved);
    if (!isNaN(w) && w > 0) return w;
  }
  return DEFAULT_SIDE_WIDTH;
}

export function saveSideWidth(width: number): void {
  localStorage.setItem(LS_SIDE_WIDTH_KEY, String(Math.round(width)));
}

// ── Panel bounds ──

export function getSidePanelBounds(): { min: number; max: number } {
  const mainContent = document.getElementById('main-content');
  if (!mainContent) return { min: SIDE_MIN_WIDTH, max: SIDE_MAX_WIDTH };

  const totalW = mainContent.offsetWidth;
  const jsPanel = document.getElementById('jumpserver-panel');
  const jsWidth = jsPanel && jsPanel.style.display !== 'none' ? jsPanel.offsetWidth : 0;
  const jsHandle = mainContent.querySelector('.js-panel-resize-handle') as HTMLElement | null;
  const jsHandleW = jsHandle && jsHandle.style.display !== 'none' ? jsHandle.offsetWidth : 0;

  const available = totalW - jsWidth - jsHandleW;
  return {
    min: Math.max(SIDE_MIN_WIDTH, Math.round(available * SIDE_MIN_RATIO)),
    max: Math.min(SIDE_MAX_WIDTH, Math.round(available * SIDE_MAX_RATIO)),
  };
}

// ── Side panel creation ──

function createSidePanel(): { panel: HTMLDivElement; handle: HTMLDivElement } {
  const panel = document.createElement('div');
  panel.className = 'ai-side-panel';

  const handle = document.createElement('div');
  handle.className = 'ai-side-resize-handle';

  return { panel, handle };
}

// ── Resize handle ──

let sideWidth = getSavedSideWidth();

function setupSideResize(handle: HTMLDivElement, panel: HTMLDivElement): void {
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startWidth = sideWidth;
    const mainContent = document.getElementById('main-content');
    if (mainContent) mainContent.classList.add('ai-side-resizing');

    const onMove = (ev: PointerEvent) => {
      const delta = startX - ev.clientX;
      const { min, max } = getSidePanelBounds();
      sideWidth = Math.max(min, Math.min(max, startWidth + delta));
      panel.style.width = `${sideWidth}px`;
    };
    const onUp = () => {
      if (mainContent) mainContent.classList.remove('ai-side-resizing');
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      saveSideWidth(sideWidth);
      TerminalRegistry.resizeAll();
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
  });
}

// ── Side input area ──

export interface SideInputCallbacks {
  sendToLLM: (instance: AICapsuleInstance, text: string) => void;
  buildModelDropdown: (dropdown: HTMLDivElement, label: HTMLSpanElement) => void;
  updateModelLabel: (label: HTMLSpanElement) => void;
  createTrustSwitcher: () => HTMLDivElement;
  toggleSideChatHistory: (instance: AICapsuleInstance) => void;
  toggleLayout: (instance: AICapsuleInstance) => void;
}

/**
 * Create the side panel input area with model selector, trust switcher,
 * chat history button, textarea, and send button.
 */
export function createSideInputArea(
  instance: AICapsuleInstance,
  callbacks: SideInputCallbacks,
): HTMLDivElement {
  const area = document.createElement('div');
  area.className = 'ai-side-input-area';

  // ── Top toolbar row: model selector + trust + chat history ──
  const toolbar = document.createElement('div');
  toolbar.className = 'ai-side-input-toolbar';

  // Model selector
  const modelSelect = document.createElement('div');
  modelSelect.className = 'ai-side-model-select';

  const modelLabel = document.createElement('span');
  modelLabel.className = 'ai-side-model-label';
  callbacks.updateModelLabel(modelLabel);

  const modelArrow = document.createElement('span');
  modelArrow.className = 'ai-side-model-arrow';
  modelArrow.innerHTML = `<svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><polyline points="2 3 4 5 6 3"/></svg>`;

  const modelDropdown = document.createElement('div');
  modelDropdown.className = 'ai-side-model-dropdown styled-scrollbar';
  modelDropdown.style.display = 'none';
  callbacks.buildModelDropdown(modelDropdown, modelLabel);

  modelSelect.appendChild(modelLabel);
  modelSelect.appendChild(modelArrow);
  modelSelect.appendChild(modelDropdown);

  modelSelect.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = modelDropdown.style.display !== 'none';
    if (isOpen) {
      modelDropdown.style.display = 'none';
      modelSelect.classList.remove('open');
    } else {
      callbacks.buildModelDropdown(modelDropdown, modelLabel);
      modelDropdown.style.display = '';
      modelSelect.classList.add('open');
    }
  });
  document.addEventListener('click', () => {
    modelDropdown.style.display = 'none';
    modelSelect.classList.remove('open');
  });

  // Trust switcher
  const trustSwitcher = callbacks.createTrustSwitcher();

  // Chat history button
  const chatHistBtn = document.createElement('button');
  chatHistBtn.className = 'ai-side-btn ai-side-btn-chat-history';
  chatHistBtn.title = t('aiChatHistory');
  chatHistBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h12v8a1 1 0 01-1 1H5l-3 2.5V4a1 1 0 011-1z"/><line x1="5" y1="6.5" x2="11" y2="6.5"/><line x1="5" y1="9" x2="9" y2="9"/></svg>`;
  chatHistBtn.addEventListener('click', () => {
    callbacks.toggleSideChatHistory(instance);
  });

  // Layout toggle button (switch back to bottom mode)
  const layoutBtn = document.createElement('button');
  layoutBtn.className = 'ai-side-btn ai-side-btn-layout';
  layoutBtn.title = t('aiLayoutBottom');
  layoutBtn.innerHTML = SVG_LAYOUT_BOTTOM;
  layoutBtn.addEventListener('click', () => {
    callbacks.toggleLayout(instance);
  });

  const textarea = document.createElement('textarea');
  textarea.className = 'ai-side-input';
  textarea.placeholder = t('aiPlaceholderAgent');
  textarea.rows = 2;
  textarea.autocapitalize = 'off';
  textarea.setAttribute('autocorrect', 'off');
  textarea.spellcheck = false;

  const sendBtn = document.createElement('button');
  sendBtn.className = 'ai-side-btn ai-side-btn-send';
  sendBtn.title = `${t('aiSendPrompt')} (Enter)`;
  sendBtn.innerHTML = LLM_SEND_SVG;

  // Wire up send
  const doSend = () => {
    const text = textarea.value.trim();
    if (!text) return;
    callbacks.sendToLLM(instance, text);
    textarea.value = '';
    textarea.style.height = ''; // reset auto-height
  };

  // Abort is handled by the agent's onAborted callback which calls
  // updateButtonHighlight → updateSideSendButton. We just call agent.abort().
  sendBtn.addEventListener('click', () => {
    if (instance.isStreaming) {
      instance.agent.abort();
    } else {
      doSend();
    }
  });

  // Keyboard: Enter=send, Shift+Enter=newline, Escape=abort
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (instance.isStreaming) {
        const text = textarea.value.trim();
        if (text) {
          callbacks.sendToLLM(instance, text);
          textarea.value = '';
          textarea.style.height = '';
        }
      } else {
        doSend();
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (instance.isStreaming) {
        instance.agent.abort();
      }
    }
  });

  // Auto-resize textarea
  textarea.addEventListener('input', () => {
    textarea.style.height = '';
    textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
  });

  // Layout: textarea on top, toolbar + send button on bottom
  area.appendChild(textarea);

  // Bottom bar: tools on left, send on right
  toolbar.appendChild(modelSelect);
  toolbar.appendChild(trustSwitcher);
  toolbar.appendChild(chatHistBtn);
  toolbar.appendChild(layoutBtn);
  const toolbarSpacer = document.createElement('div');
  toolbarSpacer.style.flex = '1';
  toolbar.appendChild(toolbarSpacer);
  toolbar.appendChild(sendBtn);

  area.appendChild(toolbar);

  // Store references
  instance.sideInputArea = area;
  instance.sideInput = textarea;

  return area;
}

/** Update the side panel send button to show send/stop icon */
export function updateSideSendButton(btn: HTMLButtonElement | null, isStreaming: boolean): void {
  if (!btn) return;
  if (isStreaming) {
    btn.innerHTML = stopIcon(16);
    btn.classList.add('streaming-active');
    btn.title = t('aiStopGenerating');
  } else {
    btn.innerHTML = LLM_SEND_SVG;
    btn.classList.remove('streaming-active');
    btn.title = `${t('aiSendPrompt')} (Enter)`;
  }
}

/** Get the side send button from instance */
export function getSideSendButton(instance: AICapsuleInstance): HTMLButtonElement | null {
  return instance.sideInputArea?.querySelector('.ai-side-btn-send') as HTMLButtonElement | null;
}

// ── Mode switching ──

/**
 * Switch to side panel mode.
 * Moves chatPanel into the side panel, adds ai-bar--side-active to AI Bar.
 * AI Bar stays in #terminal-panel.
 */
export function switchToSideMode(instance: AICapsuleInstance, callbacks: SideInputCallbacks): void {
  const mainContent = document.getElementById('main-content');
  if (!mainContent) return;

  // Create side panel elements if needed
  if (!instance.sidePanel || !instance.sideResizeHandle) {
    const { panel, handle } = createSidePanel();
    instance.sidePanel = panel;
    instance.sideResizeHandle = handle;
    setupSideResize(handle, panel);
  }

  // Restore saved width
  sideWidth = getSavedSideWidth();
  const { min, max } = getSidePanelBounds();
  sideWidth = Math.max(min, Math.min(max, sideWidth));
  instance.sidePanel.style.width = `${sideWidth}px`;

  // Create side input area if needed (before inserting chatPanel to control order)
  if (!instance.sideInputArea) {
    createSideInputArea(instance, callbacks);
  }

  // Ensure correct DOM order: chatPanel first, then sideInputArea
  // Always re-append to guarantee order even after mode switches
  if (instance.chatPanel) {
    instance.chatPanel.classList.add('ai-chat-panel--side');
    instance.sidePanel.appendChild(instance.chatPanel);
  }
  if (instance.sideInputArea) {
    instance.sidePanel.appendChild(instance.sideInputArea);
  }

  // Add class to AI Bar to hide agent buttons (bar stays in terminal-panel)
  instance.element.classList.add('ai-bar--side-active');

  // Insert into #main-content (before JumpServer panel if exists)
  const jsHandle = mainContent.querySelector('.js-panel-resize-handle');
  if (jsHandle) {
    if (instance.sideResizeHandle.parentElement !== mainContent) {
      mainContent.insertBefore(instance.sideResizeHandle, jsHandle);
    }
    if (instance.sidePanel.parentElement !== mainContent) {
      mainContent.insertBefore(instance.sidePanel, jsHandle);
    }
  } else {
    if (instance.sideResizeHandle.parentElement !== mainContent) {
      mainContent.appendChild(instance.sideResizeHandle);
    }
    if (instance.sidePanel.parentElement !== mainContent) {
      mainContent.appendChild(instance.sidePanel);
    }
  }

  instance.sideResizeHandle.style.display = '';
  instance.sidePanel.style.display = '';
  instance.layoutMode = 'side';
  saveLayoutMode('side');

  TerminalRegistry.resizeAll();
}

/**
 * Switch back to bottom mode.
 * Moves chatPanel back to #terminal-panel, removes ai-bar--side-active.
 */
export function switchToBottomMode(instance: AICapsuleInstance): void {
  const terminalPanel = document.getElementById('terminal-panel');
  if (!terminalPanel) return;

  // Move chat panel back to terminal-panel (before AI bar)
  if (instance.chatPanel) {
    instance.chatPanel.classList.remove('ai-chat-panel--side');
    terminalPanel.insertBefore(instance.chatPanel, instance.element);
    instance.chatPanel.style.height = '';
    instance.chatPanel.style.flex = '';
  }

  // Remove side-active class from AI Bar (restore all buttons)
  instance.element.classList.remove('ai-bar--side-active');

  // Hide side panel and resize handle
  if (instance.sidePanel) instance.sidePanel.style.display = 'none';
  if (instance.sideResizeHandle) instance.sideResizeHandle.style.display = 'none';

  instance.layoutMode = 'bottom';
  saveLayoutMode('bottom');

  TerminalRegistry.resizeAll();
}

/** Hide the side panel (chat closed/minimized). AI Bar not affected. */
export function hideSidePanel(instance: AICapsuleInstance): void {
  if (instance.sidePanel) instance.sidePanel.style.display = 'none';
  if (instance.sideResizeHandle) instance.sideResizeHandle.style.display = 'none';
  TerminalRegistry.resizeAll();
}

/** Show the side panel (chat opened). AI Bar not affected. */
export function showSidePanel(instance: AICapsuleInstance): void {
  if (instance.sidePanel) {
    sideWidth = getSavedSideWidth();
    const { min, max } = getSidePanelBounds();
    sideWidth = Math.max(min, Math.min(max, sideWidth));
    instance.sidePanel.style.width = `${sideWidth}px`;
    instance.sidePanel.style.display = '';
  }
  if (instance.sideResizeHandle) instance.sideResizeHandle.style.display = '';
  TerminalRegistry.resizeAll();
}
