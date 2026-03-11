import { escapeHtml } from './status-bar';
import { t } from './i18n';

export function renderMarkdown(text: string, sessionId: string, addHistoryFn: (cmd: string) => void): string {
  // Split into code blocks and text segments
  const segments: string[] = [];
  const codeBlockRegex = /```(\w*)\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = codeBlockRegex.exec(text)) !== null) {
    // Text before code block
    if (match.index > lastIndex) {
      segments.push(renderInlineMarkdown(text.slice(lastIndex, match.index)));
    }

    const lang = match[1] || '';
    const code = match[2].trim();
    const isBash = /^(bash|sh|shell|zsh|fish|cmd|powershell)?$/.test(lang);

    // Single-line: no newlines and short enough to fit on one row
    const isInline = !code.includes('\n') && code.length <= 65;

    // Generate a unique id for command execution binding
    const blockId = `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    segments.push(
      `<div class="ai-cmd-block ${isInline ? 'ai-cmd-inline' : 'ai-cmd-stacked'}" data-block-id="${blockId}">` +
      `<div class="ai-cmd-screen">` +
      (!isInline ? `<div class="ai-cmd-lang">${escapeHtml(lang || 'code')}</div>` : '') +
      `<pre><code>${escapeHtml(code)}</code></pre>` +
      `</div>` +
      `<div class="ai-cmd-actions">` +
      (isBash
        ? `<button class="ai-cmd-run" data-cmd="${escapeHtml(code)}" data-session="${sessionId}">${t('aiRunCommand')}</button>`
        : '') +
      `<button class="ai-cmd-copy" data-code="${escapeHtml(code)}">${t('aiCopyCode')}</button>` +
      `</div></div>`
    );

    lastIndex = match.index + match[0].length;
  }

  // Remaining text after last code block
  if (lastIndex < text.length) {
    segments.push(renderInlineMarkdown(text.slice(lastIndex)));
  }

  return segments.join('');
}

export function renderInlineMarkdown(text: string): string {
  // Escape HTML first
  let html = escapeHtml(text);

  // Bold: **text**
  html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');

  // Inline code: `text`
  html = html.replace(/`([^`]+)`/g, '<code class="ai-inline-code">$1</code>');

  // Paragraphs: double newline
  html = html.split('\n\n').map((p) => `<p>${p.trim()}</p>`).join('');

  // Single newlines within paragraphs -> <br>
  html = html.replace(/\n/g, '<br>');

  return html;
}
