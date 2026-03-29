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
  // Process block-level elements first, then inline
  const blocks = text.split('\n\n');
  const rendered: string[] = [];

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;

    // Check if this block is a table (lines starting with |)
    const lines = trimmed.split('\n');
    if (lines.length >= 2 && lines[0].includes('|') && lines[1].includes('---')) {
      rendered.push(renderTable(lines));
      continue;
    }

    // Process line by line for headings, hr, lists
    const lineResults: string[] = [];
    let inList = false;
    for (const line of lines) {
      const lt = line.trim();
      // Horizontal rule
      if (/^---+$/.test(lt)) {
        if (inList) { lineResults.push('</ul>'); inList = false; }
        lineResults.push('<hr class="ai-md-hr">');
      }
      // Headings
      else if (lt.startsWith('### ')) {
        if (inList) { lineResults.push('</ul>'); inList = false; }
        lineResults.push(`<h4 class="ai-md-h3">${renderInline(escapeHtml(lt.slice(4)))}</h4>`);
      } else if (lt.startsWith('## ')) {
        if (inList) { lineResults.push('</ul>'); inList = false; }
        lineResults.push(`<h3 class="ai-md-h2">${renderInline(escapeHtml(lt.slice(3)))}</h3>`);
      } else if (lt.startsWith('# ')) {
        if (inList) { lineResults.push('</ul>'); inList = false; }
        lineResults.push(`<h2 class="ai-md-h1">${renderInline(escapeHtml(lt.slice(2)))}</h2>`);
      }
      // Unordered list
      else if (/^[-*] /.test(lt)) {
        if (!inList) { lineResults.push('<ul class="ai-md-list">'); inList = true; }
        lineResults.push(`<li>${renderInline(escapeHtml(lt.slice(2)))}</li>`);
      }
      // Regular text
      else {
        if (inList) { lineResults.push('</ul>'); inList = false; }
        lineResults.push(renderInline(escapeHtml(lt)));
      }
    }
    if (inList) lineResults.push('</ul>');

    // Wrap non-block content in <p>
    const joined = lineResults.join('\n');
    if (!joined.startsWith('<h') && !joined.startsWith('<ul') && !joined.startsWith('<hr') && !joined.startsWith('<table')) {
      rendered.push(`<p>${joined.replace(/\n/g, '<br>')}</p>`);
    } else {
      rendered.push(joined);
    }
  }

  return rendered.join('');
}

/** Render a markdown table from lines */
function renderTable(lines: string[]): string {
  const parseRow = (line: string): string[] =>
    line.split('|').map(c => c.trim()).filter((_, i, arr) => i > 0 && i < arr.length);

  const headers = parseRow(lines[0]);
  // Skip separator line (lines[1])
  const rows = lines.slice(2).filter(l => l.includes('|')).map(parseRow);

  let html = '<table class="ai-md-table"><thead><tr>';
  for (const h of headers) {
    html += `<th>${renderInline(escapeHtml(h))}</th>`;
  }
  html += '</tr></thead><tbody>';
  for (const row of rows) {
    html += '<tr>';
    for (let i = 0; i < headers.length; i++) {
      html += `<td>${renderInline(escapeHtml(row[i] ?? ''))}</td>`;
    }
    html += '</tr>';
  }
  html += '</tbody></table>';
  return html;
}

/** Render inline markdown (bold, code, links) */
function renderInline(html: string): string {
  html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/`([^`]+)`/g, '<code class="ai-inline-code">$1</code>');
  return html;
}
