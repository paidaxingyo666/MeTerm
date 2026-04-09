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

/**
 * Block-level markdown renderer using a line-based state machine.
 *
 * Why a state machine and not split-on-blank-lines?  LLMs frequently
 * emit a markdown table flush against the surrounding paragraph
 * (no blank line above the table) — the previous implementation
 * required `\n\n` to start a fresh block, which meant the whole
 * paragraph + table got bundled into one block where lines[0] was
 * a sentence, not a table header, so the table heuristic missed.
 *
 * Now we walk the input line-by-line and recognize:
 *   • headings (#, ##, ###)
 *   • horizontal rules (---, ***, ___)
 *   • unordered lists (-, *, +)
 *   • GitHub-flavored markdown tables (pipes + separator row)
 *   • blank lines (close any open paragraph or list)
 *   • everything else accumulated into a paragraph
 *
 * Tables are detected by looking ahead one line: if the current
 * line contains a pipe AND the next line is a valid separator
 * (`---`/`:---:` segments joined by pipes), we enter table mode.
 */
export function renderInlineMarkdown(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];

  let inList = false;
  let paraBuf: string[] = [];

  const flushPara = () => {
    if (paraBuf.length === 0) return;
    out.push(`<p>${paraBuf.join('<br>')}</p>`);
    paraBuf = [];
  };
  const closeList = () => {
    if (!inList) return;
    out.push('</ul>');
    inList = false;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const lt = line.trim();

    // ── Blank line: end paragraph + list ──
    if (!lt) {
      flushPara();
      closeList();
      i++;
      continue;
    }

    // ── Table: current line has pipes AND next line is a separator ──
    if (
      i + 1 < lines.length &&
      lt.includes('|') &&
      isTableSeparator(lines[i + 1])
    ) {
      flushPara();
      closeList();
      const tableLines: string[] = [lines[i], lines[i + 1]];
      let j = i + 2;
      while (j < lines.length) {
        const lj = lines[j].trim();
        if (!lj || !lj.includes('|')) break;
        tableLines.push(lines[j]);
        j++;
      }
      out.push(renderTable(tableLines));
      i = j;
      continue;
    }

    // ── Horizontal rule (must NOT also be a hijacked table separator) ──
    if (/^---+$/.test(lt) || /^\*\*\*+$/.test(lt) || /^___+$/.test(lt)) {
      flushPara();
      closeList();
      out.push('<hr class="ai-md-hr">');
      i++;
      continue;
    }

    // ── Headings ──
    if (lt.startsWith('### ')) {
      flushPara();
      closeList();
      out.push(`<h4 class="ai-md-h3">${renderInline(escapeHtml(lt.slice(4)))}</h4>`);
      i++;
      continue;
    }
    if (lt.startsWith('## ')) {
      flushPara();
      closeList();
      out.push(`<h3 class="ai-md-h2">${renderInline(escapeHtml(lt.slice(3)))}</h3>`);
      i++;
      continue;
    }
    if (lt.startsWith('# ')) {
      flushPara();
      closeList();
      out.push(`<h2 class="ai-md-h1">${renderInline(escapeHtml(lt.slice(2)))}</h2>`);
      i++;
      continue;
    }

    // ── Unordered list ──
    if (/^[-*+] /.test(lt)) {
      flushPara();
      if (!inList) {
        out.push('<ul class="ai-md-list">');
        inList = true;
      }
      out.push(`<li>${renderInline(escapeHtml(lt.slice(2)))}</li>`);
      i++;
      continue;
    }

    // ── Regular text → buffer for paragraph ──
    closeList();
    paraBuf.push(renderInline(escapeHtml(lt)));
    i++;
  }
  flushPara();
  closeList();
  return out.join('');
}

/**
 * Does a line look like a GFM table separator row?
 * Examples that should match:
 *   |---|---|         (canonical)
 *   |:--|:-:|--:|     (left / center / right alignment)
 *   ---|---|---       (no outer pipes)
 *   | -- | -- |       (only 2 dashes — common LLM output)
 *
 * Examples that should NOT match:
 *   ---               (horizontal rule)
 *   text---more       (in-paragraph dashes)
 */
function isTableSeparator(line: string): boolean {
  let t = line.trim();
  if (!t) return false;
  // Must contain a pipe somewhere — otherwise it's a horizontal rule.
  if (!t.includes('|')) return false;
  // Strip optional outer pipes.
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) t = t.slice(0, -1);
  const segments = t.split('|').map((s) => s.trim());
  if (segments.length === 0) return false;
  // Each segment: optional leading colon, two-or-more dashes, optional trailing colon.
  return segments.every((s) => /^:?-{2,}:?$/.test(s));
}

/** Parse a markdown table row, tolerating optional outer pipes. */
function parseRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

/**
 * Parse the alignment row (`|:---|---:|:---:|`) into per-column hints.
 * Returns one of 'left' | 'right' | 'center' | undefined for each column.
 */
function parseAlignments(line: string): Array<'left' | 'right' | 'center' | undefined> {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) t = t.slice(0, -1);
  return t.split('|').map((seg) => {
    const s = seg.trim();
    const startsColon = s.startsWith(':');
    const endsColon = s.endsWith(':');
    if (startsColon && endsColon) return 'center';
    if (endsColon) return 'right';
    if (startsColon) return 'left';
    return undefined;
  });
}

/** Render a markdown table from its raw line array. */
function renderTable(lines: string[]): string {
  const headers = parseRow(lines[0]);
  const aligns = parseAlignments(lines[1]);
  const rows = lines.slice(2).filter((l) => l.trim().includes('|')).map(parseRow);

  const styleFor = (i: number): string => {
    const a = aligns[i];
    return a ? ` style="text-align:${a}"` : '';
  };

  let html = '<table class="ai-md-table"><thead><tr>';
  for (let i = 0; i < headers.length; i++) {
    html += `<th${styleFor(i)}>${renderInline(escapeHtml(headers[i]))}</th>`;
  }
  html += '</tr></thead><tbody>';
  for (const row of rows) {
    html += '<tr>';
    for (let i = 0; i < headers.length; i++) {
      html += `<td${styleFor(i)}>${renderInline(escapeHtml(row[i] ?? ''))}</td>`;
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
