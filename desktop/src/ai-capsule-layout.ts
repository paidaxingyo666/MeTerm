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
import { ATTACH_ICON_SVG } from './ai-capsule-bar-dom';
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
  // Chat is sidebar-only now — the bottom-panel mode has been retired, so the
  // chat always opens as the right-side panel regardless of any saved value.
  return 'side';
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
  createThinkingToggle: () => HTMLDivElement;
  toggleSideChatHistory: (instance: AICapsuleInstance) => void;
  toggleLayout: (instance: AICapsuleInstance) => void;
  /**
   * Resolve the instance that should own the *current* action
   * (send / abort / chat history / layout toggle). Used by side
   * panel callbacks because the side panel is tab-scoped: it lives
   * longer than any single pane and must operate on whichever
   * pane has the live focus right now — not the pane that created
   * the side panel.
   */
  resolveCurrentInstance: (fallback: AICapsuleInstance) => AICapsuleInstance;
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

  // Thinking-mode toggle — per-request flag, safe to flip mid-conversation.
  const thinkingToggle = callbacks.createThinkingToggle();

  // Chat history button
  const chatHistBtn = document.createElement('button');
  chatHistBtn.className = 'ai-side-btn ai-side-btn-chat-history';
  chatHistBtn.title = t('aiChatHistory');
  chatHistBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h12v8a1 1 0 01-1 1H5l-3 2.5V4a1 1 0 011-1z"/><line x1="5" y1="6.5" x2="11" y2="6.5"/><line x1="5" y1="9" x2="9" y2="9"/></svg>`;
  chatHistBtn.addEventListener('click', () => {
    callbacks.toggleSideChatHistory(callbacks.resolveCurrentInstance(instance));
  });

  // Layout toggle button (switch back to bottom mode)
  const layoutBtn = document.createElement('button');
  layoutBtn.className = 'ai-side-btn ai-side-btn-layout';
  layoutBtn.title = t('aiLayoutBottom');
  layoutBtn.innerHTML = SVG_LAYOUT_BOTTOM;
  layoutBtn.addEventListener('click', () => {
    callbacks.toggleLayout(callbacks.resolveCurrentInstance(instance));
  });

  // Attach image button — same UX as the bottom-mode AI Bar attach
  // button: left click opens a file picker (after first trying the
  // clipboard fallback for the system pasteboard); right click only
  // tries the clipboard.
  const attachBtn = document.createElement('button');
  attachBtn.className = 'ai-side-btn ai-side-btn-attach';
  attachBtn.title = 'Attach image (left click: pick file · right click: paste from clipboard)';
  // Reuse the same SVG used by the bottom-mode AI bar so the visual
  // weight matches.  Imported lazily to avoid a circular dep at the
  // module-loading layer.
  attachBtn.innerHTML = ATTACH_ICON_SVG;
  attachBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const m = await import('./ai-capsule-image-attach');
    const target = callbacks.resolveCurrentInstance(instance);
    const fromClipboard = await m.triggerClipboardImagePaste(target);
    if (fromClipboard) return;
    await m.pickImageFiles(target);
  });
  attachBtn.addEventListener('contextmenu', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const m = await import('./ai-capsule-image-attach');
    await m.triggerClipboardImagePaste(callbacks.resolveCurrentInstance(instance));
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

  // Wire up send — resolve the *current* instance each invocation
  // so the side panel (which lives at tab scope) always targets the
  // pane the user has focused at the moment they hit send, not the
  // pane that happened to create the side panel DOM.
  const doSend = () => {
    const text = textarea.value.trim();
    if (!text) return;
    const target = callbacks.resolveCurrentInstance(instance);
    callbacks.sendToLLM(target, text);
    textarea.value = '';
    textarea.style.height = ''; // reset auto-height
  };

  // Abort is handled by the agent's onAborted callback which calls
  // updateButtonHighlight → updateSideSendButton. We fire the
  // AbortController from run() plus the legacy agent.abort() for safety.
  sendBtn.addEventListener('click', () => {
    const target = callbacks.resolveCurrentInstance(instance);
    if (target.isStreaming) {
      target.agentAbort?.();
      target.agent.abort();
    } else {
      doSend();
    }
  });

  // ── IME composition tracking ──
  // Same logic as ai-capsule-input-setup.ts: track composition state
  // ourselves and add a small grace window after compositionend so a
  // trailing Enter (Chinese candidate confirmation) never submits.
  let imeActive = false;
  let imeJustEndedAt = 0;
  const IME_GRACE_MS = 80;
  textarea.addEventListener('compositionstart', () => { imeActive = true; });
  textarea.addEventListener('compositionupdate', () => { imeActive = true; });
  textarea.addEventListener('compositionend', () => {
    imeActive = false;
    imeJustEndedAt = Date.now();
  });
  const isImeKeydown = (e: KeyboardEvent): boolean => {
    if (imeActive) return true;
    if (e.isComposing) return true;
    if (e.keyCode === 229) return true;
    if (e.key === 'Enter' && (Date.now() - imeJustEndedAt) < IME_GRACE_MS) return true;
    return false;
  };

  // Keyboard: Enter=send, Shift+Enter=newline, Escape=abort
  textarea.addEventListener('keydown', (e) => {
    // IME guard — let the browser deliver the candidate, don't submit.
    if (isImeKeydown(e)) return;

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const target = callbacks.resolveCurrentInstance(instance);
      if (target.isStreaming) {
        const text = textarea.value.trim();
        if (text) {
          callbacks.sendToLLM(target, text);
          textarea.value = '';
          textarea.style.height = '';
        }
      } else {
        doSend();
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      const target = callbacks.resolveCurrentInstance(instance);
      if (target.isStreaming) {
        target.agentAbort?.();
        target.agent.abort();
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
  toolbar.appendChild(thinkingToggle);
  toolbar.appendChild(chatHistBtn);
  toolbar.appendChild(layoutBtn);
  toolbar.appendChild(attachBtn);
  const toolbarSpacer = document.createElement('div');
  toolbarSpacer.style.flex = '1';
  toolbar.appendChild(toolbarSpacer);
  toolbar.appendChild(sendBtn);

  area.appendChild(toolbar);

  // Store references
  instance.sideInputArea = area;
  instance.sideInput = textarea;

  // Register this side input area as paste-eligible so the
  // document-level paste listener can route image clipboard data
  // to this instance.
  void import('./ai-capsule-image-attach').then(({ registerSidePanelForPaste }) => {
    registerSidePanelForPaste(instance, area);
  });

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

  // Re-render any pending images so they move from the AI bar
  // chip strip into the side panel thumbnail strip (or vice
  // versa). renderPendingStrip's container picker is layoutMode-
  // aware, so calling it after the mode flips is enough.
  void import('./ai-capsule-image-attach').then(({ renderPendingStrip }) => {
    renderPendingStrip(instance);
  });

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

  // Re-render pending images into the AI bar chip strip.
  void import('./ai-capsule-image-attach').then(({ renderPendingStrip }) => {
    renderPendingStrip(instance);
  });

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
