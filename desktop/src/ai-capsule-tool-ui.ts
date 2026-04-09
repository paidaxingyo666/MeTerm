import { escapeHtml } from './status-bar';
import { toolIcon, statusIcon, spinnerIcon, approveIcon, rejectIcon, editIcon, TOOL_COLORS } from './ai-icons';
import type { AICapsuleInstance, ConvEntry } from './ai-capsule-types';
import { notifyAgentWaiting } from './ai-notifications';
import { attachLightboxClick } from './ai-image-lightbox';
import { TabManager } from './tabs';
import { createOverlayScrollbar } from './overlay-scrollbar';
import type { TodoItem } from './ai-tools-todo';

/**
 * 给工具结果区域附加全局 overlay 滚动条(替换原生 scrollbar)。
 * 使用 inline 模式:bar 会被插入到 resultEl 的父节点(.ai-tool-card)。
 * 必须在 resultEl 已经位于 DOM 中之后调用,inline 模式才能正确把
 * 父节点设置成 position: relative。
 *
 * 通过 dataset 标记保证幂等。
 */
function attachToolResultScrollbar(resultEl: HTMLElement): void {
  if (resultEl.dataset.overlaySbAttached === '1') return;
  if (!resultEl.isConnected) return;
  resultEl.dataset.overlaySbAttached = '1';
  createOverlayScrollbar({ viewport: resultEl, container: resultEl });
}

/** Build inline args HTML for a tool card header. */
export function toolArgsInline(toolName: string, args: Record<string, unknown>): string {
  if (toolName === 'run_command' && args.command) {
    return `<span class="ai-tool-args-inline"><code>$ ${escapeHtml(String(args.command))}</code></span>`;
  } else if ((toolName === 'read_file' || toolName === 'write_file') && args.path) {
    return `<span class="ai-tool-args-inline"><code>${escapeHtml(String(args.path))}</code></span>`;
  } else if (toolName === 'read_terminal') {
    return `<span class="ai-tool-args-inline"><code>${args.lines ?? 50} lines</code></span>`;
  } else if (toolName === 'command_help' && args.command) {
    return `<span class="ai-tool-args-inline"><code>${escapeHtml(String(args.command))}</code></span>`;
  } else if (toolName === 'todo_write') {
    const todos = Array.isArray(args.todos) ? args.todos as unknown[] : [];
    return `<span class="ai-tool-args-inline"><code>${todos.length} task${todos.length === 1 ? '' : 's'}</code></span>`;
  } else if (toolName === 'upload_file') {
    const lp = String(args.local_path ?? '');
    const rp = String(args.remote_path ?? '');
    return `<span class="ai-tool-args-inline"><code>${escapeHtml(lp)} → ${escapeHtml(rp)}</code></span>`;
  } else if (toolName === 'download_file') {
    const lp = String(args.local_path ?? '');
    const rp = String(args.remote_path ?? '');
    return `<span class="ai-tool-args-inline"><code>${escapeHtml(rp)} → ${escapeHtml(lp)}</code></span>`;
  } else if (toolName === 'list_directory' && args.path) {
    return `<span class="ai-tool-args-inline"><code>${escapeHtml(String(args.path))}</code></span>`;
  } else if (toolName === 'glob_search' && args.pattern) {
    return `<span class="ai-tool-args-inline"><code>${escapeHtml(String(args.pattern))}</code></span>`;
  } else if (toolName === 'grep_search' && args.pattern) {
    return `<span class="ai-tool-args-inline"><code>/${escapeHtml(String(args.pattern))}/</code></span>`;
  }
  return '';
}

/** Build a completed tool card element (for history rendering).
 *  For `todo_write` we return an empty placeholder element: the
 *  plan is instead replayed through renderTodoBoard by the caller
 *  (chat-ops conversation loader), so showing an inline card here
 *  would double up the UI. */
export function buildToolCard(msg: Extract<ConvEntry, { type: 'tool_call' }>): HTMLDivElement {
  if (msg.toolName === 'todo_write') {
    // Zero-height spacer — keeps the message stream indices aligned
    // with the historical entry order without rendering anything.
    const spacer = document.createElement('div');
    spacer.className = 'ai-tool-card-placeholder';
    spacer.style.display = 'none';
    return spacer;
  }
  const card = document.createElement('div');
  card.className = 'ai-tool-card completed';
  card.dataset.tool = msg.toolName;
  const status = msg.result !== null
    ? (msg.isError ? statusIcon('error', 12) : statusIcon('success', 12))
    : statusIcon('error', 12);
  const header = document.createElement('div');
  header.className = 'ai-tool-card-header clickable';
  // Phase 2 pane badge (restore path) — use the stored paneNumber so
  // the card renders the same way it did at live run time.
  const badgeHtml = msg.paneNumber && msg.paneNumber > 0
    ? `<span class="ai-tool-pane-badge" title="Pane ${msg.paneNumber}">Pane ${msg.paneNumber}</span>`
    : '';
  header.innerHTML = `
    <span class="ai-tool-icon">${toolIcon(msg.toolName, 14)}</span>
    <span class="ai-tool-name">${escapeHtml(msg.toolName)}</span>
    ${badgeHtml}
    ${toolArgsInline(msg.toolName, msg.args)}
    <span class="ai-tool-status">${status}</span>`;
  const resultEl = document.createElement('div');
  resultEl.className = `ai-tool-result${msg.isError ? ' ai-tool-result-error' : ''}`;
  resultEl.style.display = 'none';
  const raw = msg.result ?? '';
  const truncated = raw.length > 500 ? raw.slice(0, 500) + '...' : raw;
  resultEl.innerHTML = `<pre>${escapeHtml(truncated)}</pre>`;
  header.addEventListener('click', () => {
    const willShow = resultEl.style.display === 'none';
    resultEl.style.display = willShow ? '' : 'none';
    if (willShow) attachToolResultScrollbar(resultEl);
  });
  card.appendChild(header);
  card.appendChild(resultEl);
  // Re-render any attached screenshots (e.g. from a prior read_screen call)
  if (msg.images && msg.images.length > 0) {
    card.appendChild(buildImageThumbStrip(msg.images));
  }
  return card;
}

/**
 * Build a horizontal strip of clickable thumbnails for the given images.
 * Each thumbnail is constrained to a fixed visual size and opens the
 * full image in a lightbox on click.
 */
function buildImageThumbStrip(
  images: Array<{ mediaType: string; data: string; label?: string }>,
): HTMLDivElement {
  const wrap = document.createElement('div');
  wrap.className = 'ai-tool-images';
  for (const img of images) {
    const thumb = document.createElement('div');
    thumb.className = 'ai-tool-image-thumb';
    if (img.label) thumb.title = img.label;

    const el = document.createElement('img');
    el.className = 'ai-tool-image';
    el.src = `data:${img.mediaType};base64,${img.data}`;
    if (img.label) el.alt = img.label;
    el.loading = 'lazy';
    el.decoding = 'async';
    attachLightboxClick(el);
    thumb.appendChild(el);

    wrap.appendChild(thumb);
  }
  return wrap;
}

/**
 * Decide which pane number to display in the tool card badge. Only
 * returns a number when there's >1 pane AND the tool is one that
 * actually targets a pane (terminal tools). Otherwise returns null
 * so the badge is suppressed to avoid visual noise in single-pane
 * tabs or for non-pane tools like web_search.
 */
function decidePaneBadge(
  instance: AICapsuleInstance,
  toolName: string,
  args: Record<string, unknown>,
): number | null {
  const PANE_AWARE_TOOLS = new Set([
    'run_command', 'read_terminal', 'read_screen',
    'watch_terminal', 'type_text', 'press_keys',
  ]);
  if (!PANE_AWARE_TOOLS.has(toolName)) return null;
  const explicit = typeof args.pane === 'number' ? args.pane : null;
  const locked = instance.state.activeRunTargetPaneNumber;
  const chosen = explicit ?? locked ?? null;
  if (chosen === null) return null;
  // Suppress the badge on single-pane tabs — the "Pane 1" label is
  // visual noise when there's only one pane. Badges reappear as soon
  // as the user splits the tab.
  const tab = TabManager.tabs.find((t) => t.id === instance.tabId);
  if (!tab || tab.paneNumbers.size < 2) return null;
  return chosen;
}

function paneBadgeSpan(paneNumber: number, isCrossPane: boolean): string {
  const cls = isCrossPane ? 'ai-tool-pane-badge cross' : 'ai-tool-pane-badge';
  return `<span class="${cls}" title="${isCrossPane ? 'Cross-pane call' : 'Default target pane'}">Pane ${paneNumber}</span>`;
}

/** Render an inline tool-call card in the chat panel. */
export function appendToolCallCard(
  instance: AICapsuleInstance,
  toolName: string,
  args: Record<string, unknown>,
  sinkAgentPulse: (inst: AICapsuleInstance) => void,
  addHistory: (inst: AICapsuleInstance, cmd: string, source: 'manual' | 'ai') => void,
): void {
  if (!instance.chatPanel) return;
  const container = instance.chatPanel.querySelector('.ai-chat-messages');
  if (!container) return;

  // Special-case: todo_write is rendered exclusively by the persistent
  // TodoBoard (fired via the agent's onTodoUpdate listener). Skip the
  // regular tool-card path entirely — otherwise the user sees the same
  // plan twice: once as an inline card with spinner → result text, and
  // again in the board below it. We still persist a conversation entry
  // so the tool call shows up in history replay, but with a flag that
  // the buildToolCard restore path uses to skip rendering.
  if (toolName === 'todo_write') {
    sinkAgentPulse(instance);
    instance.messages.push({
      type: 'tool_call', toolName, args, result: null, isError: false,
      timestamp: Date.now(),
    });
    return;
  }

  const card = document.createElement('div');
  card.className = 'ai-tool-card';
  card.dataset.tool = toolName;
  card.dataset.toolId = `tc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

  const color = TOOL_COLORS[toolName] ?? '#6B7280';

  // Compute pane badge once so we can reuse on the card dataset
  // (for conversation restore) and inject into the header HTML.
  const paneNumber = decidePaneBadge(instance, toolName, args);
  const explicitArg = typeof args.pane === 'number' ? args.pane : null;
  const isCrossPane = explicitArg !== null
    && instance.state.activeRunTargetPaneNumber !== null
    && explicitArg !== instance.state.activeRunTargetPaneNumber;
  const badgeHtml = paneNumber !== null ? paneBadgeSpan(paneNumber, isCrossPane) : '';

  // ── Special-case: wait_for_user_input renders as a prominent
  // "paused — type directly in the terminal" card with a cancel
  // button, because it is blocking the whole agent loop waiting
  // for the USER, not a background tool invocation.
  if (toolName === 'wait_for_user_input') {
    renderWaitForUserInputCard(card, args);
    // Fire a waiting notification (throttled + focus-aware inside).
    notifyAgentWaiting('Agent paused — your input needed', String(args.reason ?? ''));
  } else {
    // Header row: icon + tool name + inline args + spinner
    const header = document.createElement('div');
    header.className = 'ai-tool-card-header';
    header.innerHTML = `
      <span class="ai-tool-icon">${toolIcon(toolName, 14)}</span>
      <span class="ai-tool-name">${escapeHtml(toolName)}</span>
      ${badgeHtml}
      ${toolArgsInline(toolName, args)}
      <span class="ai-tool-status">${spinnerIcon(color, 12)}</span>
    `;
    card.appendChild(header);
  }

  container.appendChild(card);
  sinkAgentPulse(instance);
  container.scrollTop = container.scrollHeight;

  // Add run_command commands to history so they appear in the history panel
  if (toolName === 'run_command' && typeof args.command === 'string' && args.command.trim()) {
    addHistory(instance, args.command.trim(), 'ai');
  }

  // Persist tool call (result filled in by updateToolResultCard).
  // Stamp the effective pane number so conversation restore can
  // re-render the badge identically.
  instance.messages.push({
    type: 'tool_call', toolName, args, result: null, isError: false,
    timestamp: Date.now(),
    paneNumber: paneNumber ?? undefined,
  });
}

/**
 * Render the highlighted "agent paused — waiting for user" card.
 * The card includes:
 *   - A prominent title + the agent-supplied reason
 *   - Explicit instructions to type in the terminal
 *   - A "Cancel" button that dispatches ai-wait-for-user-input-cancel
 *     so the tool's execute() promise resolves with 'aborted'.
 *
 * The card's cardId is pulled from the DOM CustomEvent the tool's
 * execute() emits ('ai-wait-for-user-input-start') via a lazy
 * listener — we bind it to the most-recently rendered card.
 */
function renderWaitForUserInputCard(
  card: HTMLDivElement,
  args: Record<string, unknown>,
): void {
  card.classList.add('ai-wait-card');

  const reason = String(args.reason ?? 'User input required');
  const timeoutSec = Number(args.timeout ?? 300);

  const header = document.createElement('div');
  header.className = 'ai-tool-card-header ai-wait-card-header';
  header.innerHTML = `
    <span class="ai-tool-icon">${toolIcon('wait_for_user_input', 16)}</span>
    <span class="ai-tool-name">${escapeHtml('Agent paused — please type in the terminal')}</span>
  `;
  card.appendChild(header);

  const body = document.createElement('div');
  body.className = 'ai-wait-card-body';

  const reasonEl = document.createElement('div');
  reasonEl.className = 'ai-wait-card-reason';
  reasonEl.textContent = reason;
  body.appendChild(reasonEl);

  const hint = document.createElement('div');
  hint.className = 'ai-wait-card-hint';
  hint.textContent = `Type the input directly in the terminal below and press Enter. `
    + `The agent will automatically resume when the command finishes. `
    + `Timeout: ${timeoutSec}s.`;
  body.appendChild(hint);

  const btnRow = document.createElement('div');
  btnRow.className = 'ai-wait-card-buttons';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'ai-confirm-btn ai-confirm-reject';
  cancelBtn.innerHTML = `${rejectIcon(12)} <span>Cancel wait</span>`;
  cancelBtn.addEventListener('click', () => {
    // We don't know the cardId from this closure — broadcast a
    // generic cancel and the execute() listener will match by
    // its own cardId (there's typically only one active wait card).
    const activeCardId = card.dataset.waitCardId;
    if (activeCardId) {
      document.dispatchEvent(new CustomEvent('ai-wait-for-user-input-cancel', {
        detail: { cardId: activeCardId },
      }));
    }
    cancelBtn.disabled = true;
    cancelBtn.innerHTML = '<span>Cancelling…</span>';
  });
  btnRow.appendChild(cancelBtn);
  body.appendChild(btnRow);

  card.appendChild(body);

  // Listen for the tool's start event to capture cardId, and for
  // end event to style the card as resolved. Both listeners are
  // self-removing after the card is settled.
  const onStart = (e: Event) => {
    const ev = e as CustomEvent<{ cardId: string; reason: string }>;
    // Bind the first start event to this card (they come in order).
    if (!card.dataset.waitCardId) {
      card.dataset.waitCardId = ev.detail.cardId;
    }
  };
  document.addEventListener('ai-wait-for-user-input-start', onStart);

  const onEnd = (e: Event) => {
    const ev = e as CustomEvent<{ cardId: string; status: string }>;
    if (ev.detail?.cardId !== card.dataset.waitCardId) return;
    // Collapse the wait card down to a normal tool-card row:
    //   • Strip the .ai-wait-card class so the pulse animation,
    //     thick border, and large padding all disappear.
    //   • Tear down the body (reason text + cancel button) so the
    //     card is just the icon + name + status row, matching the
    //     other completed tool cards in the chat.
    //   • Pick a small status icon based on outcome.
    card.classList.remove('ai-wait-card');
    card.classList.add('completed', `ai-wait-card-resolved-${ev.detail.status}`);
    body.remove();
    header.classList.remove('ai-wait-card-header');
    // Replace the long "Agent paused — please type in the terminal"
    // title with a concise label + status icon, matching other tool cards.
    const status = ev.detail.status;
    const statusKind: 'success' | 'error' | 'warning' =
      status === 'completed' ? 'success'
      : status === 'aborted' ? 'warning'
      : status === 'timeout' ? 'error'
      : 'success';
    const label = status === 'completed' ? 'wait_for_user_input · resumed'
      : status === 'aborted' ? 'wait_for_user_input · cancelled'
      : status === 'timeout' ? 'wait_for_user_input · timed out'
      : `wait_for_user_input · ${status}`;
    header.innerHTML = `
      <span class="ai-tool-icon">${toolIcon('wait_for_user_input', 14)}</span>
      <span class="ai-tool-name">${escapeHtml(label)}</span>
      <span class="ai-tool-status">${statusIcon(statusKind, 12)}</span>
    `;
    document.removeEventListener('ai-wait-for-user-input-end', onEnd);
    document.removeEventListener('ai-wait-for-user-input-start', onStart);
  };
  document.addEventListener('ai-wait-for-user-input-end', onEnd);
}

/** Update the most recent tool card with execution result. */
export function updateToolResultCard(
  instance: AICapsuleInstance,
  toolName: string,
  result: string,
  isError: boolean,
): void {
  if (!instance.chatPanel) return;
  const container = instance.chatPanel.querySelector('.ai-chat-messages');
  if (!container) return;

  // Special-case: todo_write has no inline card — back-fill the result
  // into the pending conversation entry (for history persistence) and
  // return. The live view is driven by the persistent TodoBoard.
  if (toolName === 'todo_write') {
    for (let i = instance.messages.length - 1; i >= 0; i--) {
      const e = instance.messages[i];
      if (e.type === 'tool_call' && e.toolName === toolName && e.result === null) {
        e.result = result;
        e.isError = isError;
        break;
      }
    }
    return;
  }

  // Find the last tool card matching this tool
  const cards = container.querySelectorAll<HTMLDivElement>(`.ai-tool-card[data-tool="${toolName}"]`);
  const card = cards[cards.length - 1];
  if (!card) return;

  // Update status icon
  const statusEl = card.querySelector('.ai-tool-status');
  if (statusEl) {
    statusEl.innerHTML = isError ? statusIcon('error', 12) : statusIcon('success', 12);
  }

  // Add collapsible result
  const resultEl = document.createElement('div');
  resultEl.className = `ai-tool-result ${isError ? 'ai-tool-result-error' : ''}`;
  resultEl.style.display = 'none'; // collapsed by default

  const truncated = result.length > 500 ? result.slice(0, 500) + '...' : result;
  resultEl.innerHTML = `<pre>${escapeHtml(truncated)}</pre>`;
  card.appendChild(resultEl);

  // Make header clickable to toggle result
  const header = card.querySelector('.ai-tool-card-header');
  if (header) {
    header.classList.add('clickable');
    header.addEventListener('click', () => {
      const willShow = resultEl.style.display === 'none';
      resultEl.style.display = willShow ? '' : 'none';
      if (willShow) attachToolResultScrollbar(resultEl);
    });
  }

  card.classList.add('completed');
  container.scrollTop = container.scrollHeight;

  // Back-fill result into the last pending tool_call entry for this tool
  for (let i = instance.messages.length - 1; i >= 0; i--) {
    const e = instance.messages[i];
    if (e.type === 'tool_call' && e.toolName === toolName && e.result === null) {
      e.result = result;
      e.isError = isError;
      break;
    }
  }
}

/**
 * Attach images (e.g. from read_screen) to the most-recent tool card
 * for the given tool. Renders them as inline clickable thumbnails
 * below the collapsible result area, and back-fills the persisted
 * ConvEntry so conversation history survives reload.
 */
export function updateToolResultImages(
  instance: AICapsuleInstance,
  toolName: string,
  images: Array<{ mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; data: string; label?: string }>,
): void {
  if (images.length === 0) return;
  if (!instance.chatPanel) return;
  const container = instance.chatPanel.querySelector('.ai-chat-messages');
  if (!container) return;

  const cards = container.querySelectorAll<HTMLDivElement>(`.ai-tool-card[data-tool="${toolName}"]`);
  const card = cards[cards.length - 1];
  if (!card) return;

  // Don't double-add images if the tool fires multiple update calls.
  if (card.querySelector('.ai-tool-images')) return;

  card.appendChild(buildImageThumbStrip(images));
  container.scrollTop = container.scrollHeight;

  // Back-fill images into the last pending tool_call entry.
  for (let i = instance.messages.length - 1; i >= 0; i--) {
    const e = instance.messages[i];
    if (e.type === 'tool_call' && e.toolName === toolName) {
      e.images = images;
      break;
    }
  }
}

/**
 * Show inline confirmation card and return a Promise.
 * Resolves with: true (approve), false (reject), or string (edited command).
 */
export function showConfirmCard(
  instance: AICapsuleInstance,
  toolName: string,
  args: Record<string, unknown>,
): Promise<boolean | string> {
  return new Promise((resolve) => {
    if (!instance.chatPanel) { resolve(false); return; }
    const container = instance.chatPanel.querySelector('.ai-chat-messages');
    if (!container) { resolve(false); return; }

    const card = document.createElement('div');
    card.className = 'ai-confirm-card';
    card.dataset.tool = toolName;

    const color = TOOL_COLORS[toolName] ?? '#6B7280';

    // Header
    const header = document.createElement('div');
    header.className = 'ai-confirm-header';
    header.innerHTML = `
      <span class="ai-tool-icon">${toolIcon(toolName, 14)}</span>
      <span class="ai-tool-name">${escapeHtml(toolName)}</span>
    `;

    // Command preview
    const preview = document.createElement('div');
    preview.className = 'ai-confirm-preview';
    if (toolName === 'run_command' && args.command) {
      preview.innerHTML = `<code>$ ${escapeHtml(String(args.command))}</code>`;
    } else if (toolName === 'write_file' && args.path) {
      preview.innerHTML = `<code>${escapeHtml(String(args.path))}</code>`;
    } else {
      preview.innerHTML = `<code>${escapeHtml(JSON.stringify(args, null, 2).slice(0, 200))}</code>`;
    }

    // Buttons
    const buttons = document.createElement('div');
    buttons.className = 'ai-confirm-buttons';

    const approveBtn = document.createElement('button');
    approveBtn.className = 'ai-confirm-btn ai-confirm-approve';
    approveBtn.innerHTML = `${approveIcon(12)} <span>Allow</span>`;

    const rejectBtn = document.createElement('button');
    rejectBtn.className = 'ai-confirm-btn ai-confirm-reject';
    rejectBtn.innerHTML = `${rejectIcon(12)} <span>Reject</span>`;

    const editBtn = document.createElement('button');
    editBtn.className = 'ai-confirm-btn ai-confirm-edit';
    editBtn.innerHTML = `${editIcon(12)} <span>Edit</span>`;

    buttons.appendChild(approveBtn);
    buttons.appendChild(rejectBtn);
    if (toolName === 'run_command') {
      buttons.appendChild(editBtn);
    }

    card.appendChild(header);
    card.appendChild(preview);
    card.appendChild(buttons);
    container.appendChild(card);
    container.scrollTop = container.scrollHeight;

    // Background notification: the agent is blocked waiting for the
    // user to click Allow/Reject/Edit. If the window isn't focused,
    // fire a system notification + dock bounce. The throttle inside
    // notifyAgentWaiting prevents spam when multiple tool calls are
    // gated back-to-back.
    let previewText: string;
    if (toolName === 'run_command' && args.command) {
      previewText = `$ ${String(args.command).slice(0, 140)}`;
    } else if (toolName === 'write_file' && args.path) {
      previewText = `write ${String(args.path)}`;
    } else {
      previewText = `${toolName}`;
    }
    notifyAgentWaiting(`${toolName} needs approval`, previewText);

    // Button handlers
    const cleanup = () => {
      card.classList.add('resolved');
      approveBtn.disabled = true;
      rejectBtn.disabled = true;
      editBtn.disabled = true;
    };

    approveBtn.addEventListener('click', () => {
      cleanup();
      card.querySelector('.ai-confirm-header')!.innerHTML += ` <span class="ai-confirm-resolved">${statusIcon('success', 10)} Approved</span>`;
      resolve(true);
    });

    rejectBtn.addEventListener('click', () => {
      cleanup();
      card.querySelector('.ai-confirm-header')!.innerHTML += ` <span class="ai-confirm-resolved">${statusIcon('error', 10)} Rejected</span>`;
      resolve(false);
    });

    editBtn.addEventListener('click', () => {
      // Show inline editor
      const cmd = String(args.command || '');
      const editorDiv = document.createElement('div');
      editorDiv.className = 'ai-confirm-editor';
      const editInput = document.createElement('input');
      editInput.type = 'text';
      editInput.className = 'ai-confirm-edit-input';
      editInput.value = cmd;
      const confirmEditBtn = document.createElement('button');
      confirmEditBtn.className = 'ai-confirm-btn ai-confirm-approve';
      confirmEditBtn.innerHTML = `${approveIcon(12)} <span>Run</span>`;
      editorDiv.appendChild(editInput);
      editorDiv.appendChild(confirmEditBtn);
      preview.replaceWith(editorDiv);
      editInput.focus();

      const runEdited = () => {
        cleanup();
        card.querySelector('.ai-confirm-header')!.innerHTML += ` <span class="ai-confirm-resolved">${statusIcon('success', 10)} Edited</span>`;
        resolve(editInput.value);
      };

      confirmEditBtn.addEventListener('click', runEdited);
      editInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') runEdited();
        e.stopPropagation();
      });
    });
  });
}

// ─── Persistent Task Plan (TodoBoard) ─────────────────────────
//
// Phase 3 — render the agent's `todo_write` task plan as a persistent
// inline card pinned to the bottom of the chat. There is at most ONE
// todo board per chat panel: the first todo_updated event creates it,
// subsequent events mutate it in place. The card is always re-anchored
// to the END of the chat container so it stays visible as new tool
// cards stream in above it.
//
// The board includes:
//   • A header with overall progress (N/M completed) + animated
//     spinner when one item is `in_progress`.
//   • A linear progress bar.
//   • The full ordered task list with status checkboxes (checked /
//     in-progress / pending) and click-to-collapse details.
//
// We do NOT persist the board into instance.messages — the underlying
// `tool_call` entries from todo_write keep the audit trail. The board
// is purely a derived view of the agent's current TodoState.

const TODO_STATUS_LABELS: Record<TodoItem['status'], string> = {
  pending: 'pending',
  in_progress: 'in progress',
  completed: 'completed',
};

function findOrCreateTodoBoard(container: Element): HTMLDivElement {
  let board = container.querySelector<HTMLDivElement>(':scope > .ai-todo-board');
  if (!board) {
    board = document.createElement('div');
    board.className = 'ai-todo-board';
    board.setAttribute('role', 'group');
    board.setAttribute('aria-label', 'Agent task plan');
  }
  // Always (re-)anchor to the end of the container so the board sits
  // below the most recent tool/assistant message.
  if (board.parentElement !== container || container.lastElementChild !== board) {
    container.appendChild(board);
  }
  return board;
}

/**
 * Render or update the persistent task plan board.
 *
 * @param instance  The capsule instance owning the chat panel.
 * @param todos     The full authoritative list (replaces previous).
 */
export function renderTodoBoard(
  instance: AICapsuleInstance,
  todos: TodoItem[],
): void {
  if (!instance.chatPanel) return;
  const container = instance.chatPanel.querySelector('.ai-chat-messages');
  if (!container) return;

  // Empty list → tear the board down (clean slate when agent.clear()).
  if (todos.length === 0) {
    const existing = container.querySelector(':scope > .ai-todo-board');
    if (existing) existing.remove();
    return;
  }

  const board = findOrCreateTodoBoard(container);
  const total = todos.length;
  const done = todos.filter((t) => t.status === 'completed').length;
  const active = todos.find((t) => t.status === 'in_progress') ?? null;
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);

  const color = TOOL_COLORS.todo_write ?? '#0EA5E9';

  // Header: title + counts + optional active row + collapse toggle.
  const headerHtml = `
    <div class="ai-todo-board-header">
      <span class="ai-todo-board-icon">${toolIcon('todo_write', 16)}</span>
      <span class="ai-todo-board-title">Task plan</span>
      <span class="ai-todo-board-counts">${done} / ${total}</span>
      ${active ? `<span class="ai-todo-board-active">${spinnerIcon(color, 12)} <em>${escapeHtml(active.activeForm)}</em></span>` : ''}
      <button class="ai-todo-board-toggle" aria-label="Collapse">${chevron('down')}</button>
    </div>
    <div class="ai-todo-board-progress">
      <div class="ai-todo-board-bar" style="width:${pct}%; background:${color};"></div>
    </div>
  `;

  // Item rows: status box + label.
  const rows = todos.map((it, idx) => {
    const status = it.status;
    const label = status === 'in_progress' ? it.activeForm : it.content;
    const box =
      status === 'completed' ? `<span class="ai-todo-box checked">${checkGlyph()}</span>`
      : status === 'in_progress' ? `<span class="ai-todo-box active">${spinnerIcon(color, 10)}</span>`
      : `<span class="ai-todo-box pending"></span>`;
    return `<div class="ai-todo-row ${status}" data-idx="${idx}">
      ${box}
      <span class="ai-todo-text">${escapeHtml(label)}</span>
      <span class="ai-todo-status">${TODO_STATUS_LABELS[status]}</span>
    </div>`;
  }).join('');

  board.innerHTML = `${headerHtml}<div class="ai-todo-board-list">${rows}</div>`;

  // Collapse toggle: tap header to fold the list, tap again to expand.
  const toggleBtn = board.querySelector<HTMLButtonElement>('.ai-todo-board-toggle');
  const list = board.querySelector<HTMLDivElement>('.ai-todo-board-list');
  if (toggleBtn && list) {
    const collapsed = board.dataset.collapsed === '1';
    if (collapsed) list.style.display = 'none';
    toggleBtn.addEventListener('click', () => {
      const nowCollapsed = list.style.display !== 'none';
      list.style.display = nowCollapsed ? 'none' : '';
      board.dataset.collapsed = nowCollapsed ? '1' : '0';
      toggleBtn.innerHTML = nowCollapsed ? chevron('right') : chevron('down');
    });
  }

  container.scrollTop = container.scrollHeight;
}

/**
 * Walk an instance's conversation history backwards and rehydrate the
 * persistent TodoBoard from the most recent `todo_write` invocation.
 * Called by the conversation-restore path after all messages have been
 * appended, so the board reflects the final plan state of the saved
 * chat.
 *
 * If no todo_write entries are found, the board is torn down (cleared)
 * via renderTodoBoard([]).
 */
export function restoreTodoBoardFromHistory(instance: AICapsuleInstance): void {
  if (!instance.chatPanel) return;
  // Scan from newest to oldest — the first match wins because each
  // todo_write replaces the entire plan.
  for (let i = instance.messages.length - 1; i >= 0; i--) {
    const e = instance.messages[i];
    if (e.type !== 'tool_call' || e.toolName !== 'todo_write') continue;
    const raw = (e.args?.todos as unknown);
    if (!Array.isArray(raw)) { renderTodoBoard(instance, []); return; }
    const todos: TodoItem[] = [];
    for (let idx = 0; idx < raw.length; idx++) {
      const r = raw[idx] as Record<string, unknown> | null;
      if (!r || typeof r !== 'object') continue;
      const content = typeof r.content === 'string' ? r.content : '';
      if (!content) continue;
      const activeForm = typeof r.activeForm === 'string' && r.activeForm ? r.activeForm : content;
      const status = (r.status === 'completed' || r.status === 'in_progress')
        ? r.status
        : 'pending';
      const id = typeof r.id === 'string' && r.id ? r.id : `t_restored_${idx}`;
      todos.push({ id, content, activeForm, status: status as TodoItem['status'] });
    }
    renderTodoBoard(instance, todos);
    // Also rehydrate the agent's persistent TodoState so the NEXT
    // run's system prompt already contains the plan without waiting
    // for the model to re-emit todo_write.
    try { instance.agent.restoreTodos(todos); } catch { /* noop */ }
    return;
  }
  renderTodoBoard(instance, []);
}

function chevron(dir: 'right' | 'down'): string {
  const d = dir === 'right' ? 'M4 2L9 6L4 10' : 'M2 4L6 9L10 4';
  return `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="${d}" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

function checkGlyph(): string {
  return `<svg width="10" height="10" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M2.5 6.5L5 9L9.5 3.5" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}
