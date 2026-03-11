import { escapeHtml } from './status-bar';
import { toolIcon, statusIcon, spinnerIcon, approveIcon, rejectIcon, editIcon, TOOL_COLORS } from './ai-icons';
import type { AICapsuleInstance, ConvEntry } from './ai-capsule-types';

/** Build inline args HTML for a tool card header. */
export function toolArgsInline(toolName: string, args: Record<string, unknown>): string {
  if (toolName === 'run_command' && args.command) {
    return `<span class="ai-tool-args-inline"><code>$ ${escapeHtml(String(args.command))}</code></span>`;
  } else if ((toolName === 'read_file' || toolName === 'write_file') && args.path) {
    return `<span class="ai-tool-args-inline"><code>${escapeHtml(String(args.path))}</code></span>`;
  } else if (toolName === 'read_terminal') {
    return `<span class="ai-tool-args-inline"><code>${args.lines ?? 50} lines</code></span>`;
  }
  return '';
}

/** Build a completed tool card element (for history rendering). */
export function buildToolCard(msg: Extract<ConvEntry, { type: 'tool_call' }>): HTMLDivElement {
  const card = document.createElement('div');
  card.className = 'ai-tool-card completed';
  card.dataset.tool = msg.toolName;
  const status = msg.result !== null
    ? (msg.isError ? statusIcon('error', 12) : statusIcon('success', 12))
    : statusIcon('error', 12);
  const header = document.createElement('div');
  header.className = 'ai-tool-card-header clickable';
  header.innerHTML = `
    <span class="ai-tool-icon">${toolIcon(msg.toolName, 14)}</span>
    <span class="ai-tool-name">${escapeHtml(msg.toolName)}</span>
    ${toolArgsInline(msg.toolName, msg.args)}
    <span class="ai-tool-status">${status}</span>`;
  const resultEl = document.createElement('div');
  resultEl.className = `ai-tool-result${msg.isError ? ' ai-tool-result-error' : ''}`;
  resultEl.style.display = 'none';
  const raw = msg.result ?? '';
  const truncated = raw.length > 500 ? raw.slice(0, 500) + '...' : raw;
  resultEl.innerHTML = `<pre>${escapeHtml(truncated)}</pre>`;
  header.addEventListener('click', () => {
    resultEl.style.display = resultEl.style.display === 'none' ? '' : 'none';
  });
  card.appendChild(header);
  card.appendChild(resultEl);
  return card;
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

  const card = document.createElement('div');
  card.className = 'ai-tool-card';
  card.dataset.tool = toolName;
  card.dataset.toolId = `tc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

  const color = TOOL_COLORS[toolName] ?? '#6B7280';

  // Header row: icon + tool name + inline args + spinner
  const header = document.createElement('div');
  header.className = 'ai-tool-card-header';
  header.innerHTML = `
    <span class="ai-tool-icon">${toolIcon(toolName, 14)}</span>
    <span class="ai-tool-name">${escapeHtml(toolName)}</span>
    ${toolArgsInline(toolName, args)}
    <span class="ai-tool-status">${spinnerIcon(color, 12)}</span>
  `;

  card.appendChild(header);
  container.appendChild(card);
  sinkAgentPulse(instance);
  container.scrollTop = container.scrollHeight;

  // Add run_command commands to history so they appear in the history panel
  if (toolName === 'run_command' && typeof args.command === 'string' && args.command.trim()) {
    addHistory(instance, args.command.trim(), 'ai');
  }

  // Persist tool call (result filled in by updateToolResultCard)
  instance.messages.push({ type: 'tool_call', toolName, args, result: null, isError: false, timestamp: Date.now() });
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
      resultEl.style.display = resultEl.style.display === 'none' ? '' : 'none';
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
