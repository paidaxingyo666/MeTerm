import { escapeHtml } from './status-bar';
import { toolIcon, statusIcon, spinnerIcon, approveIcon, rejectIcon, editIcon, TOOL_COLORS } from './ai-icons';
import type { AICapsuleInstance, ConvEntry } from './ai-capsule-types';
import { notifyAgentWaiting } from './ai-notifications';
import { attachLightboxClick } from './ai-image-lightbox';
import { TabManager } from './tabs';
import { createOverlayScrollbar } from './overlay-scrollbar';
import type { TodoItem } from './ai-tools-todo';
import {
  toolDisplayName,
  todoStatusLabel,
  planTitle,
  planCollapseLabel,
  planExpandLabel,
  planMoreItemsLabel,
  waitPausedLabel,
  waitReceivedLabel,
  waitHintLabel,
  waitCancelBtnLabel,
  waitCancellingBtnLabel,
  waitResolvedLabel,
} from './ai-tool-i18n';

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
    // Invisible zero-cost placeholder — the plan is rendered by the
    // persistent TodoBoard, not as an inline tool card.
    const d = document.createElement('div');
    d.hidden = true;
    return d;
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
    <span class="ai-tool-name" title="${escapeHtml(msg.toolName)}">${escapeHtml(toolDisplayName(msg.toolName))}</span>
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
    // Adoption path: if run_command already mounted a pre-emptive card
    // for this session (data-pre-wait="1"), don't render a duplicate.
    // Re-use it as the tool's card: drop the marker, refresh reason,
    // record the tool_call in history, and bail out.
    const existingPreWait = container.querySelector<HTMLDivElement>(
      ':scope > .ai-tool-card[data-tool="wait_for_user_input"][data-pre-wait="1"]',
    );
    if (existingPreWait) {
      existingPreWait.removeAttribute('data-pre-wait');
      // The reason in `args` is the LLM-supplied one, richer than the
      // auto-detected placeholder. Fire reason-updated so the existing
      // card swaps the text in place.
      if (existingPreWait.dataset.waitCardId) {
        document.dispatchEvent(new CustomEvent('ai-wait-for-user-input-reason-updated', {
          detail: {
            cardId: existingPreWait.dataset.waitCardId,
            reason: typeof args.reason === 'string' ? args.reason : undefined,
            timeoutSec: typeof args.timeout === 'number' ? args.timeout : undefined,
          },
        }));
      }
      // Skip notifyAgentWaiting — already fired when the pre-wait was
      // mounted; firing again would spam the user.
      sinkAgentPulse(instance);
      instance.messages.push({
        type: 'tool_call', toolName, args, result: null, isError: false,
        timestamp: Date.now(),
        paneNumber: paneNumber ?? undefined,
      });
      return;
    }
    renderWaitForUserInputCard(card, args);
    // Fire a waiting notification (throttled + focus-aware inside).
    notifyAgentWaiting('Agent paused — your input needed', String(args.reason ?? ''));
  } else {
    // Header row: icon + tool name + inline args + spinner
    const header = document.createElement('div');
    header.className = 'ai-tool-card-header';
    header.innerHTML = `
      <span class="ai-tool-icon">${toolIcon(toolName, 14)}</span>
      <span class="ai-tool-name" title="${escapeHtml(toolName)}">${escapeHtml(toolDisplayName(toolName))}</span>
      ${badgeHtml}
      ${toolArgsInline(toolName, args)}
      <span class="ai-tool-status">${spinnerIcon(color, 12)}</span>
    `;
    card.appendChild(header);

    // ── Transfer progress + controls for upload_file / download_file ──
    if (toolName === 'upload_file' || toolName === 'download_file') {
      const progressWrap = document.createElement('div');
      progressWrap.className = 'ai-tool-transfer-progress';
      progressWrap.innerHTML = `
        <div class="ai-tool-transfer-bar"><div class="ai-tool-transfer-fill"></div></div>
        <span class="ai-tool-transfer-label">waiting…</span>
        <div class="ai-tool-transfer-controls">
          <button class="ai-transfer-btn ai-transfer-cancel" type="button" title="Cancel transfer">&times;</button>
        </div>
      `;
      card.appendChild(progressWrap);

      const fill = progressWrap.querySelector('.ai-tool-transfer-fill') as HTMLElement;
      const label = progressWrap.querySelector('.ai-tool-transfer-label') as HTMLElement;
      const cancelBtn = progressWrap.querySelector('.ai-transfer-cancel') as HTMLButtonElement;

      // Track the most recently seen sessionId + transferId from progress events.
      let lastSessionId = '';
      let lastTransferId = 0;

      const fmtB = (n: number) => {
        if (!Number.isFinite(n) || n < 0) return '0 B';
        if (n < 1024) return `${n} B`;
        if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
        if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
        return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
      };

      const onProgress = (e: Event) => {
        const ev = e as CustomEvent<{
          toolName: string; written: number; total: number; pct: number;
          sessionId: string; transferId: number;
        }>;
        if (ev.detail?.toolName !== toolName) return;
        const allCards = container!.querySelectorAll<HTMLDivElement>(`.ai-tool-card[data-tool="${toolName}"]`);
        if (allCards.length > 0 && allCards[allCards.length - 1] !== card) return;

        const { written, total, pct, sessionId: sid, transferId: tid } = ev.detail;
        lastSessionId = sid;
        lastTransferId = tid;
        fill.style.width = `${pct}%`;
        label.textContent = `${fmtB(written)} / ${fmtB(total)}  (${pct.toFixed(1)}%)`;
      };
      document.addEventListener('ai-transfer-progress', onProgress);

      // Cancel button: send control signal to Rust backend.
      cancelBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!lastSessionId || !lastTransferId) return;
        cancelBtn.disabled = true;
        cancelBtn.textContent = '…';
        try {
          const signal = toolName === 'upload_file'
            ? 'control_session_file_upload'
            : 'control_session_file_download';
          const { invoke: inv } = await import('@tauri-apps/api/core');
          await inv(signal, {
            sessionId: lastSessionId,
            transferId: lastTransferId,
            signal: 'cancel',
          });
        } catch { /* best effort */ }
      });

      card.dataset.progressListener = 'active';
      (card as any)._cleanupProgress = () => {
        document.removeEventListener('ai-transfer-progress', onProgress);
      };
    }
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
 * Mount a wait-for-user-input card RIGHT NOW, before the LLM has
 * called the tool. Used by run_command's pre-emptive password
 * detection (see startPreWait in ai-tools-command.ts).
 *
 * Differences vs. the appendToolCallCard path:
 *   • Triggered by a DOM CustomEvent (`ai-pre-wait-mount`) instead of
 *     the agent's onToolCall callback, so it can fire before LLM
 *     round-trip completes.
 *   • cardId is bound to `card.dataset.waitCardId` IMMEDIATELY — the
 *     normal flow relies on an `ai-wait-for-user-input-start` event
 *     firing AFTER the card is mounted, which is the wrong order here
 *     (the start event would have already fired before the listener
 *     existed).
 *   • Tagged with `data-pre-wait="1"` so when the LLM later calls
 *     wait_for_user_input, appendToolCallCard detects the existing
 *     pre-emptive card and adopts it instead of rendering a duplicate.
 *
 * Idempotent per session via the data-pre-wait="1" check: a second
 * pre-wait dispatch for the same session is a no-op (the original
 * card stays).
 */
function mountPreWaitCard(
  sessionId: string,
  cardId: string,
  reason: string,
  timeoutSec: number,
): void {
  // Find the chat panel via DOM query — avoids a circular import on
  // ai-capsule (which already imports this module). The session id
  // tag was set in createChatPanel.
  const panel = document.querySelector<HTMLElement>(
    `.ai-chat-panel[data-session-id="${CSS.escape(sessionId)}"]`,
  );
  if (!panel) return;
  const container = panel.querySelector('.ai-chat-messages');
  if (!container) return;
  // Idempotent: if a pre-wait already exists, leave it alone.
  if (container.querySelector(':scope > .ai-tool-card[data-pre-wait="1"]')) {
    return;
  }

  const card = document.createElement('div');
  card.className = 'ai-tool-card';
  card.dataset.tool = 'wait_for_user_input';
  card.dataset.toolId = `tc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  card.dataset.preWait = '1';
  // Bind cardId directly — bypasses the onStart event the normal path uses.
  card.dataset.waitCardId = cardId;

  renderWaitForUserInputCard(card, { reason, timeout: timeoutSec });
  container.appendChild(card);
  container.scrollTop = container.scrollHeight;

  notifyAgentWaiting('Agent paused — your input needed', reason);
}

// Module-load listener for pre-wait mount requests. ai-tools-command's
// startPreWait dispatches this event the moment run_command sees a
// password prompt, so the card appears before the LLM round-trip
// returns.
document.addEventListener('ai-pre-wait-mount', (e: Event) => {
  const ev = e as CustomEvent<{
    sessionId: string;
    cardId: string;
    reason: string;
    timeoutSec: number;
  }>;
  if (!ev.detail) return;
  mountPreWaitCard(ev.detail.sessionId, ev.detail.cardId, ev.detail.reason, ev.detail.timeoutSec);
});

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
    <span class="ai-tool-name">${escapeHtml(waitPausedLabel())}</span>
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
  hint.textContent = waitHintLabel(timeoutSec);
  body.appendChild(hint);

  const btnRow = document.createElement('div');
  btnRow.className = 'ai-wait-card-buttons';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'ai-confirm-btn ai-confirm-reject';
  cancelBtn.innerHTML = `${rejectIcon(12)} <span>${escapeHtml(waitCancelBtnLabel())}</span>`;
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
    cancelBtn.innerHTML = `<span>${escapeHtml(waitCancellingBtnLabel())}</span>`;
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

  // Intermediate signal: user has typed in the terminal. Flip the
  // card from "waiting for you" to "received, command still running"
  // so the user gets instant confirmation that the agent saw the
  // input. The card still doesn't resolve here — it waits for the
  // shell-idle signal before the agent continues.
  const onReceived = (e: Event) => {
    const ev = e as CustomEvent<{ cardId: string }>;
    if (ev.detail?.cardId !== card.dataset.waitCardId) return;
    if (card.dataset.waitReceived === '1') return;
    card.dataset.waitReceived = '1';
    card.classList.add('ai-wait-card-received');
    hint.textContent = waitReceivedLabel();
  };
  document.addEventListener('ai-wait-for-user-input-received', onReceived);

  // Upgrade signal: dispatched when the LLM's wait_for_user_input
  // tool adopts a pre-emptive card. Replaces the placeholder reason
  // (e.g. "Auto-detected password prompt") with the LLM's richer
  // description (e.g. "sudo password for apt install foo") and
  // refreshes the timeout-bearing hint if the LLM picked a different
  // timeout. Skip the hint refresh once we're already in the
  // "received" state — that text is the priority and shouldn't be
  // clobbered back to "type the input".
  const onReasonUpdated = (e: Event) => {
    const ev = e as CustomEvent<{ cardId: string; reason?: string; timeoutSec?: number }>;
    if (ev.detail?.cardId !== card.dataset.waitCardId) return;
    if (typeof ev.detail.reason === 'string' && ev.detail.reason.trim()) {
      reasonEl.textContent = ev.detail.reason;
    }
    if (
      typeof ev.detail.timeoutSec === 'number'
      && card.dataset.waitReceived !== '1'
    ) {
      hint.textContent = waitHintLabel(ev.detail.timeoutSec);
    }
  };
  document.addEventListener('ai-wait-for-user-input-reason-updated', onReasonUpdated);

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
    const label = waitResolvedLabel(status);
    header.innerHTML = `
      <span class="ai-tool-icon">${toolIcon('wait_for_user_input', 14)}</span>
      <span class="ai-tool-name" title="wait_for_user_input">${escapeHtml(label)}</span>
      <span class="ai-tool-status">${statusIcon(statusKind, 12)}</span>
    `;
    document.removeEventListener('ai-wait-for-user-input-end', onEnd);
    document.removeEventListener('ai-wait-for-user-input-start', onStart);
    document.removeEventListener('ai-wait-for-user-input-received', onReceived);
    document.removeEventListener('ai-wait-for-user-input-reason-updated', onReasonUpdated);
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

  // Find the FIRST tool card matching this tool that is still pending
  // (not yet marked .completed). This fixes the bug where multiple
  // run_command cards exist but updateToolResultCard always updates
  // the LAST one — leaving earlier cards stuck with a spinner forever.
  const cards = container.querySelectorAll<HTMLDivElement>(`.ai-tool-card[data-tool="${toolName}"]`);
  let card: HTMLDivElement | null = null;
  for (let i = 0; i < cards.length; i++) {
    if (!cards[i].classList.contains('completed')) {
      card = cards[i];
      break;
    }
  }
  // Fallback to last card if all are already completed (shouldn't happen)
  if (!card) card = cards[cards.length - 1] ?? null;
  if (!card) return;

  // Detect soft-errors: the tool returned a non-error result string
  // (isError=false) but the content indicates a problem the user
  // should notice — CONFLICT (upload file already exists), cancelled,
  // stalled, etc. We show a warning icon instead of green success.
  const isConflictOrWarning = !isError && (
    result.startsWith('CONFLICT:') ||
    result.includes('cancelled by user')
  );

  // Cleanup transfer progress listener if this was an upload/download card.
  if ((card as any)._cleanupProgress) {
    (card as any)._cleanupProgress();
    delete (card as any)._cleanupProgress;
  }
  // Replace the live progress bar with a final state.
  const progressWrap = card.querySelector('.ai-tool-transfer-progress');
  if (progressWrap) {
    if (isError || isConflictOrWarning) {
      progressWrap.remove();
    } else {
      const fill = progressWrap.querySelector('.ai-tool-transfer-fill') as HTMLElement;
      const label = progressWrap.querySelector('.ai-tool-transfer-label') as HTMLElement;
      if (fill) fill.style.width = '100%';
      if (label) label.textContent = 'completed';
    }
  }

  // Update status icon
  const statusEl = card.querySelector('.ai-tool-status');
  if (statusEl) {
    if (isError) {
      statusEl.innerHTML = statusIcon('error', 12);
    } else if (isConflictOrWarning) {
      statusEl.innerHTML = statusIcon('warning', 12);
    } else {
      statusEl.innerHTML = statusIcon('success', 12);
    }
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

  // Find the first non-completed card (same fix as updateToolResultCard)
  const cards = container.querySelectorAll<HTMLDivElement>(`.ai-tool-card[data-tool="${toolName}"]`);
  let card: HTMLDivElement | null = null;
  for (let i = 0; i < cards.length; i++) {
    if (!cards[i].classList.contains('completed')) { card = cards[i]; break; }
  }
  if (!card) card = cards[cards.length - 1] ?? null;
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
      <span class="ai-tool-name" title="${escapeHtml(toolName)}">${escapeHtml(toolDisplayName(toolName))}</span>
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
    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      clearTimeout(autoRejectTimer);
      card.classList.add('resolved');
      approveBtn.disabled = true;
      rejectBtn.disabled = true;
      editBtn.disabled = true;
    };

    // Auto-reject after 5 minutes of no response — prevents the agent
    // from being permanently stuck when the user's window is in the
    // background and they missed the notification.
    const autoRejectTimer = setTimeout(() => {
      if (settled) return;
      cleanup();
      card.querySelector('.ai-confirm-header')!.innerHTML += ` <span class="ai-confirm-resolved">${statusIcon('warning', 10)} Timed out</span>`;
      resolve(false);
    }, 5 * 60 * 1000);

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

/**
 * Find or create the persistent plan board. Mounted as a direct child
 * of `.ai-chat-panel` AFTER `.ai-chat-messages`, so it floats above
 * the input bar instead of getting buried in the scrolling message
 * stream. Trigger the slide-up animation by toggling `.entered` on
 * the next animation frame (so the initial translateY(100%) is
 * actually rendered first).
 *
 * `panel` here is the chat panel element (parent of .ai-chat-messages).
 */
function findOrCreateTodoBoard(panel: Element): HTMLDivElement {
  let board = panel.querySelector<HTMLDivElement>(':scope > .ai-todo-board');
  if (!board) {
    board = document.createElement('div');
    board.className = 'ai-todo-board';
    board.setAttribute('role', 'group');
    board.setAttribute('aria-label', planTitle());
    panel.appendChild(board);
    // Next frame: toggle `.entered` to play the slide-in animation.
    // Double-rAF to ensure layout has the start state painted.
    const el = board;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => el.classList.add('entered'));
    });
  } else if (!board.classList.contains('entered')) {
    board.classList.add('entered');
  }
  return board;
}

/**
 * Slide the board out, then remove from DOM. Used by the
 * all-completed celebration path and by the empty-list teardown.
 * Safe to call repeatedly — only the first call schedules removal.
 */
function dismissTodoBoard(board: HTMLDivElement): void {
  if (board.dataset.dismissing === '1') return;
  board.dataset.dismissing = '1';
  board.classList.remove('entered');
  board.classList.add('exiting');
  const remove = () => board.parentElement?.removeChild(board);
  // Match the longest transition (transform 0.42s). Fall back to a
  // timeout in case `transitionend` doesn't fire (e.g. element hidden).
  let fired = false;
  const onEnd = () => { if (fired) return; fired = true; remove(); };
  board.addEventListener('transitionend', onEnd, { once: true });
  setTimeout(onEnd, 600);
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
  // Anchor the board to the chat panel itself (not to .ai-chat-messages)
  // so it floats above the input bar — see findOrCreateTodoBoard for
  // the rationale. The empty-list teardown still finds the existing
  // element through the same panel selector.
  const panel = instance.chatPanel;

  const existing = panel.querySelector<HTMLDivElement>(':scope > .ai-todo-board');

  // Empty list → tear the board down with the exit animation
  // (clean slate when agent.clear()).
  if (todos.length === 0) {
    if (existing) dismissTodoBoard(existing);
    return;
  }

  const board = findOrCreateTodoBoard(panel);
  const total = todos.length;
  const done = todos.filter((t) => t.status === 'completed').length;
  const active = todos.find((t) => t.status === 'in_progress') ?? null;
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  const allDone = total > 0 && done === total;

  // Cancel any previous celebration timer — a fresh update means the
  // plan changed before we got to dismiss it (e.g. agent added more
  // todos to a "completed" list, or user injected a follow-up).
  const prevTimer = Number(board.dataset.celebrateTimer || '0');
  if (prevTimer) {
    window.clearTimeout(prevTimer);
    board.dataset.celebrateTimer = '';
  }
  if (!allDone) board.classList.remove('completed');

  const color = TOOL_COLORS.todo_write ?? '#0EA5E9';

  // Header: title + counts + optional active row + collapse toggle.
  const headerHtml = `
    <div class="ai-todo-board-header">
      <span class="ai-todo-board-icon">${toolIcon('todo_write', 14)}</span>
      <span class="ai-todo-board-title">${escapeHtml(planTitle())}</span>
      <span class="ai-todo-board-counts">${done} / ${total}</span>
      ${active ? `<span class="ai-todo-board-active">${spinnerIcon(color, 11)} <em>${escapeHtml(active.activeForm)}</em></span>` : ''}
      <button class="ai-todo-board-toggle" aria-label="${escapeHtml(planCollapseLabel())}">${chevron('down')}</button>
    </div>
    <div class="ai-todo-board-progress">
      <div class="ai-todo-board-bar" style="width:${pct}%; background:${color};"></div>
    </div>
  `;

  // Item rows: status box + label. Cap to 20 visible to avoid DOM bloat.
  const MAX_VISIBLE_TODOS = 20;
  const displayed = todos.length > MAX_VISIBLE_TODOS ? todos.slice(0, MAX_VISIBLE_TODOS) : todos;
  const rows = displayed.map((it, idx) => {
    const status = it.status;
    const label = status === 'in_progress' ? it.activeForm : it.content;
    const box =
      status === 'completed' ? `<span class="ai-todo-box checked">${checkGlyph()}</span>`
      : status === 'in_progress' ? `<span class="ai-todo-box active">${spinnerIcon(color, 10)}</span>`
      : `<span class="ai-todo-box pending"></span>`;
    return `<div class="ai-todo-row ${status}" data-idx="${idx}">
      ${box}
      <span class="ai-todo-text">${escapeHtml(label)}</span>
      <span class="ai-todo-status">${escapeHtml(todoStatusLabel(status))}</span>
    </div>`;
  }).join('');
  const moreNote = todos.length > MAX_VISIBLE_TODOS
    ? `<div class="ai-todo-row" style="opacity:0.6;justify-content:center;font-size:11px">… ${escapeHtml(planMoreItemsLabel(todos.length - MAX_VISIBLE_TODOS))}</div>`
    : '';

  board.innerHTML = `${headerHtml}<div class="ai-todo-board-list">${rows}${moreNote}</div>`;

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
      toggleBtn.setAttribute('aria-label', nowCollapsed ? planExpandLabel() : planCollapseLabel());
    });
  }

  // Celebrate only on the TRANSITION into "all completed" — i.e. the
  // previously-rendered state had at least one incomplete item.
  // Otherwise, restoring a conversation that already ended in success
  // would briefly flash the board and then auto-dismiss, hiding the
  // final state the user wanted to review.
  const prevDoneRaw = board.dataset.prevDone;
  const prevTotalRaw = board.dataset.prevTotal;
  const isFreshRender = prevDoneRaw === undefined || prevDoneRaw === '';
  const wasIncomplete =
    !isFreshRender &&
    (Number(prevDoneRaw) < Number(prevTotalRaw || '0') || Number(prevTotalRaw) === 0);
  board.dataset.prevDone = String(done);
  board.dataset.prevTotal = String(total);

  if (allDone && wasIncomplete) {
    board.classList.add('completed');
    const timer = window.setTimeout(() => {
      board.dataset.celebrateTimer = '';
      dismissTodoBoard(board);
    }, 3000);
    board.dataset.celebrateTimer = String(timer);
  }
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
