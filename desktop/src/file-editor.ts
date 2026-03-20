/**
 * file-editor.ts — Tabbed editor window content.
 * Each tab has its own EditorView + wrapper div. Switching tabs shows/hides wrappers.
 */
import { getCurrentWindow } from '@tauri-apps/api/window';
import { revealAfterPaint } from './window-utils';
import { confirm } from '@tauri-apps/plugin-dialog';
import { loadSettings, resolveIsDark } from './themes';
import { t } from './i18n';
import { EditorView, basicSetup } from 'codemirror';
import { EditorState, type Extension } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { oneDark } from '@codemirror/theme-one-dark';
import { createOverlayScrollbar } from './overlay-scrollbar';

const LS_PREFIX = 'meterm-editor-';

interface TabInfo {
  tabId: string;
  sessionId: string;
  filePath: string;
  fileName: string;
  host: string;
  editorView: EditorView | null;
  wrapperEl: HTMLDivElement;
  isDirty: boolean;
  isSaving: boolean;
  content: string;
  loaded: boolean;
  forcedLang: string; // user-selected language override (empty = auto-detect)
}

function resolveThemeAttr(colorScheme: string): string {
  if (colorScheme === 'darker') return 'darker';
  if (colorScheme === 'navy') return 'navy';
  if (colorScheme === 'light') return 'light';
  if (colorScheme === 'auto') return resolveIsDark('auto') ? 'dark' : 'light';
  return 'dark';
}

const tabs: Map<string, TabInfo> = new Map();
let activeTabId: string | null = null;
let isDark = true;

let tabBarEl: HTMLElement = null!;
let contentEl: HTMLElement = null!;
let statusBarEl: HTMLElement = null!;

/** Get language hint from filename. Returns extension or special identifier. */
function getExtFromName(name: string): string {
  const base = name.split('/').pop() || name;
  const nameMap: Record<string, string> = {
    'Dockerfile': 'dockerfile', 'Containerfile': 'dockerfile',
    'Makefile': 'sh', 'makefile': 'sh',
    '.bashrc': 'sh', '.zshrc': 'sh', '.profile': 'sh', '.bash_profile': 'sh',
    '.gitignore': 'properties', '.dockerignore': 'properties', '.editorconfig': 'properties',
    '.env': 'env', '.env.local': 'env', '.env.production': 'env',
  };
  if (nameMap[base]) return nameMap[base];
  const dot = base.lastIndexOf('.');
  if (dot > 0) {
    const ext = base.substring(dot + 1).toLowerCase();
    // Extensions that are always unambiguous
    if (ext !== 'txt' && ext !== 'log' && ext !== 'dat' && ext !== 'bak') return ext;
  }
  return '';
}

/** Detect language from file content (shebang, patterns). Used when extension is ambiguous. */
function detectLangFromContent(content: string): string {
  const first500 = content.substring(0, 500);
  const firstLine = first500.split('\n')[0].trim();

  // Shebang detection
  if (firstLine.startsWith('#!')) {
    if (/python/.test(firstLine)) return 'py';
    if (/\b(bash|sh|zsh)\b/.test(firstLine)) return 'sh';
    if (/\bnode\b/.test(firstLine)) return 'js';
    if (/\bruby\b/.test(firstLine)) return 'rb';
    if (/\bperl\b/.test(firstLine)) return 'pl';
    if (/\blua\b/.test(firstLine)) return 'lua';
  }

  // JSON detection
  if (/^\s*[\[{]/.test(firstLine) && /[}\]]\s*$/.test(content.trimEnd())) return 'json';

  // YAML detection
  if (/^---\s*$/.test(firstLine) || /^\w[\w-]*:\s/.test(firstLine)) return 'yaml';

  // XML/HTML detection
  if (/^\s*<\?xml/.test(firstLine) || /^\s*<!DOCTYPE\s+html/i.test(firstLine)) return firstLine.includes('html') ? 'html' : 'xml';
  if (/^\s*<[a-zA-Z]/.test(firstLine)) return 'html';

  // SQL detection
  if (/^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|WITH)\b/i.test(firstLine)) return 'sql';

  // JavaScript / TypeScript patterns
  if (/^\s*(import\s+|export\s+|const\s+|let\s+|var\s+|function\s+|class\s+|async\s+)/.test(first500)) {
    if (/:\s*(string|number|boolean|any|void)\b/.test(first500) || /interface\s+\w+/.test(first500)) return 'ts';
    return 'js';
  }

  // Python patterns
  if (/^\s*(def\s+|class\s+|import\s+|from\s+\w+\s+import|if\s+__name__)/.test(first500)) return 'py';

  // Shell patterns
  if (/^\s*(export\s+\w+=|if\s+\[|for\s+\w+\s+in\b|echo\s+)/.test(first500)) return 'sh';

  // Go patterns
  if (/^\s*package\s+\w+/.test(firstLine)) return 'go';

  // Rust patterns
  if (/^\s*(fn\s+|use\s+|mod\s+|pub\s+|impl\s+|struct\s+|enum\s+)/.test(first500)) return 'rs';

  // Java patterns
  if (/^\s*(public\s+class|package\s+\w|import\s+java\.)/.test(first500)) return 'java';

  // PHP
  if (/^\s*<\?php/.test(firstLine)) return 'php';

  // C/C++
  if (/^\s*#include\s+[<"]/.test(first500)) return 'cpp';

  // Markdown
  if (/^#\s+/.test(firstLine) && /\n##?\s+/.test(first500)) return 'md';

  return '';
}

/** Get language for a tab — try filename first, then content detection. */
function getLang(fileName: string, content: string): string {
  return getExtFromName(fileName) || detectLangFromContent(content);
}

async function getLangExt(ext: string): Promise<Extension> {
  switch (ext) {
    // JavaScript / TypeScript
    case 'js': case 'mjs': case 'cjs': return (await import('@codemirror/lang-javascript')).javascript();
    case 'jsx': return (await import('@codemirror/lang-javascript')).javascript({ jsx: true });
    case 'ts': case 'mts': case 'cts': return (await import('@codemirror/lang-javascript')).javascript({ typescript: true });
    case 'tsx': return (await import('@codemirror/lang-javascript')).javascript({ jsx: true, typescript: true });
    // Python
    case 'py': case 'pyw': return (await import('@codemirror/lang-python')).python();
    // JSON
    case 'json': case 'jsonc': return (await import('@codemirror/lang-json')).json();
    // HTML / XML / SVG
    case 'html': case 'htm': return (await import('@codemirror/lang-html')).html();
    case 'xml': case 'svg': case 'xsl': case 'xslt': return (await import('@codemirror/lang-xml')).xml();
    // CSS / SASS
    case 'css': return (await import('@codemirror/lang-css')).css();
    case 'scss': case 'sass': return (await import('@codemirror/lang-sass')).sass();
    case 'less': return (await import('@codemirror/lang-css')).css();
    // Markdown
    case 'md': case 'markdown': case 'mdx': return (await import('@codemirror/lang-markdown')).markdown();
    // YAML
    case 'yaml': case 'yml': return (await import('@codemirror/lang-yaml')).yaml();
    // SQL
    case 'sql': return (await import('@codemirror/lang-sql')).sql();
    // Java / Kotlin
    case 'java': return (await import('@codemirror/lang-java')).java();
    case 'kt': case 'kts': return (await import('@codemirror/lang-java')).java();
    // C / C++
    case 'c': case 'h': return (await import('@codemirror/lang-cpp')).cpp();
    case 'cpp': case 'cc': case 'cxx': case 'hpp': case 'hxx': return (await import('@codemirror/lang-cpp')).cpp();
    // PHP
    case 'php': return (await import('@codemirror/lang-php')).php();
    // Go
    case 'go': return (await import('@codemirror/lang-go')).go();
    // Rust
    case 'rs': return (await import('@codemirror/lang-rust')).rust();
    // Shell (use legacy mode via StreamLanguage)
    case 'sh': case 'bash': case 'zsh': case 'fish': {
      const { StreamLanguage } = await import('@codemirror/language');
      const { shell } = await import('@codemirror/legacy-modes/mode/shell');
      return StreamLanguage.define(shell);
    }
    // Dockerfile
    case 'dockerfile': {
      const { StreamLanguage } = await import('@codemirror/language');
      const { dockerFile } = await import('@codemirror/legacy-modes/mode/dockerfile');
      return StreamLanguage.define(dockerFile);
    }
    // TOML
    case 'toml': {
      const { StreamLanguage } = await import('@codemirror/language');
      const { toml } = await import('@codemirror/legacy-modes/mode/toml');
      return StreamLanguage.define(toml);
    }
    // Nginx
    case 'nginx': case 'conf': {
      const { StreamLanguage } = await import('@codemirror/language');
      const { nginx } = await import('@codemirror/legacy-modes/mode/nginx');
      return StreamLanguage.define(nginx);
    }
    // Properties / INI
    case 'properties': case 'ini': case 'cfg': case 'env': {
      const { StreamLanguage } = await import('@codemirror/language');
      const { properties } = await import('@codemirror/legacy-modes/mode/properties');
      return StreamLanguage.define(properties);
    }
    // Lua
    case 'lua': {
      const { StreamLanguage } = await import('@codemirror/language');
      const { lua } = await import('@codemirror/legacy-modes/mode/lua');
      return StreamLanguage.define(lua);
    }
    // Ruby
    case 'rb': case 'ruby': {
      const { StreamLanguage } = await import('@codemirror/language');
      const { ruby } = await import('@codemirror/legacy-modes/mode/ruby');
      return StreamLanguage.define(ruby);
    }
    // Perl
    case 'pl': case 'pm': {
      const { StreamLanguage } = await import('@codemirror/language');
      const { perl } = await import('@codemirror/legacy-modes/mode/perl');
      return StreamLanguage.define(perl);
    }
    // R
    case 'r': {
      const { StreamLanguage } = await import('@codemirror/language');
      const { r } = await import('@codemirror/legacy-modes/mode/r');
      return StreamLanguage.define(r);
    }
    // Swift
    case 'swift': {
      const { StreamLanguage } = await import('@codemirror/language');
      const { swift } = await import('@codemirror/legacy-modes/mode/swift');
      return StreamLanguage.define(swift);
    }
    // PowerShell
    case 'ps1': case 'psm1': {
      const { StreamLanguage } = await import('@codemirror/language');
      const { powerShell } = await import('@codemirror/legacy-modes/mode/powershell');
      return StreamLanguage.define(powerShell);
    }
    default: return [];
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildExtensions(tab: TabInfo): Extension[] {
  return [
    basicSetup,
    keymap.of([{ key: 'Mod-s', run: () => { saveTab(tab.tabId); return true; } }]),
    EditorView.updateListener.of((update) => {
      if (update.docChanged && !tab.isDirty) { tab.isDirty = true; renderTabs(); updateWindowTitle(); }
      if (update.selectionSet || update.docChanged) updateStatusBar();
    }),
    ...(isDark ? [oneDark] : []),
  ];
}

async function activateTab(tabId: string): Promise<void> {
  const tab = tabs.get(tabId);
  if (!tab) return;
  activeTabId = tabId;

  // Show/hide wrappers
  for (const [id, t] of tabs) {
    t.wrapperEl.style.display = id === tabId ? '' : 'none';
  }

  // If not loaded yet, show loading in wrapper
  if (!tab.loaded) {
    if (!tab.editorView) {
      tab.wrapperEl.innerHTML = `<div class="editor-loading">${escapeHtml(t('editorLoading'))}</div>`;
    }
    renderTabs();
    updateWindowTitle();
    return;
  }

  // Create editor if not yet created
  if (!tab.editorView) {
    tab.wrapperEl.innerHTML = '';
    const lang = tab.forcedLang || getLang(tab.fileName, tab.content);
    const langExt = await getLangExt(lang);
    const exts = buildExtensions(tab);
    if (langExt) exts.push(langExt);
    const state = EditorState.create({ doc: tab.content, extensions: exts });
    tab.editorView = new EditorView({ state, parent: tab.wrapperEl });

    // Apply saved font size
    const cmEl = tab.wrapperEl.querySelector('.cm-editor') as HTMLElement;
    if (cmEl) cmEl.style.fontSize = `${getEditorFontSize()}px`;

    // Vertical: overlay JS (4px → 10px on hover)
    // Horizontal: native CSS 4px
    const scroller = tab.wrapperEl.querySelector('.cm-scroller') as HTMLElement | null;
    if (scroller) {
      createOverlayScrollbar({ viewport: scroller, container: scroller, horizontal: true });
      // overlay-sb-viewport hides ALL native scrollbars — that's what we want now
      // since both vertical and horizontal are handled by overlay JS.
    }
  }

  tab.editorView.requestMeasure();
  renderTabs();
  updateWindowTitle();
  updateStatusBar();
}

async function closeTab(tabId: string): Promise<void> {
  const tab = tabs.get(tabId);
  if (!tab) return;
  if (tab.isDirty) {
    const ok = await confirm(t('editorUnsavedChanges'), { title: tab.fileName, kind: 'warning' });
    if (!ok) return;
  }
  if (tab.editorView) tab.editorView.destroy();
  tab.wrapperEl.remove();
  tabs.delete(tabId);
  for (const k of ['content', 'save', 'savereq']) localStorage.removeItem(`${LS_PREFIX}${k}-${tabId}`);
  if (tabs.size === 0) {
    localStorage.setItem(`${LS_PREFIX}closed`, '1');
    void getCurrentWindow().close();
    return;
  }
  if (activeTabId === tabId) void activateTab(tabs.keys().next().value!);
  else renderTabs();
}

function saveTab(tabId: string): void {
  const tab = tabs.get(tabId);
  if (!tab || !tab.filePath || !tab.editorView) return;
  tab.isSaving = true;
  setSaveBtnState('saving');
  localStorage.setItem(`${LS_PREFIX}savereq-${tabId}`, JSON.stringify({
    tabId, sessionId: tab.sessionId, filePath: tab.filePath,
    content: tab.editorView.state.doc.toString(),
  }));

  // Safety timeout
  setTimeout(() => {
    if (tab.isSaving) {
      tab.isSaving = false;
      setSaveBtnState('timeout');
    }
  }, 15_000);
}

/** Update the save button state text, auto-reset after 3s */
function setSaveBtnState(state: 'saving' | 'saved' | 'failed' | 'timeout'): void {
  const btn = document.getElementById('editor-save-btn');
  if (!btn) return;
  const labels: Record<string, string> = {
    saving: t('editorSaving'),
    saved: t('editorSaved'),
    failed: t('editorSaveFailed'),
    timeout: t('editorSaveFailed'),
  };
  btn.textContent = labels[state] || state;
  btn.classList.toggle('saving', state === 'saving');
  btn.classList.toggle('success', state === 'saved');
  btn.classList.toggle('error', state === 'failed' || state === 'timeout');
  if (state !== 'saving') {
    setTimeout(() => {
      if (btn.textContent !== t('editorSaving')) {
        btn.textContent = navigator.userAgent.includes('Windows') ? 'Ctrl+S' : '⌘S';
        btn.classList.remove('success', 'error');
      }
    }, 3000);
  }
}

function renderTabs(): void {
  tabBarEl.innerHTML = '';
  for (const [id, tab] of tabs) {
    const isActive = id === activeTabId;
    const btn = document.createElement('button');
    btn.className = `title-tab${isActive ? ' active' : ''}`;
    btn.title = `${tab.host}:${tab.filePath}`;
    btn.addEventListener('click', () => void activateTab(id));
    const trackOuter = document.createElement('span');
    trackOuter.className = 'title-tab-track';
    const trackInner = document.createElement('span');
    trackInner.className = 'title-tab-track-inner';
    const textSpan = document.createElement('span');
    textSpan.className = 'title-tab-text';
    const shortPath = tab.filePath.split('/').slice(-2).join('/');
    textSpan.textContent = `${tab.isDirty ? '● ' : ''}${tab.host}:${shortPath}`;
    trackInner.appendChild(textSpan);
    trackOuter.appendChild(trackInner);
    btn.appendChild(trackOuter);
    const closeBtn = document.createElement('span');
    closeBtn.className = 'tab-close';
    closeBtn.innerHTML = '<svg width="8" height="8" viewBox="0 0 8 8"><path d="M1 1l6 6M7 1l-6 6" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';
    closeBtn.addEventListener('click', (e) => { e.stopPropagation(); void closeTab(id); });
    btn.appendChild(closeBtn);
    tabBarEl.appendChild(btn);
  }
}

function updateWindowTitle(): void {
  const tab = activeTabId ? tabs.get(activeTabId) : null;
  if (!tab) { void getCurrentWindow().setTitle('MeTerm Editor'); return; }
  void getCurrentWindow().setTitle(`${tab.isDirty ? '● ' : ''}${tab.fileName} — MeTerm`);
}

const LANG_OPTIONS = [
  { id: '', label: 'Plain Text' },
  { id: 'js', label: 'JavaScript' }, { id: 'ts', label: 'TypeScript' },
  { id: 'json', label: 'JSON' }, { id: 'py', label: 'Python' },
  { id: 'yaml', label: 'YAML' }, { id: 'sql', label: 'SQL' },
  { id: 'html', label: 'HTML' }, { id: 'css', label: 'CSS' },
  { id: 'md', label: 'Markdown' }, { id: 'sh', label: 'Shell' },
  { id: 'xml', label: 'XML' }, { id: 'java', label: 'Java' },
  { id: 'go', label: 'Go' }, { id: 'rs', label: 'Rust' },
  { id: 'cpp', label: 'C/C++' }, { id: 'php', label: 'PHP' },
  { id: 'rb', label: 'Ruby' }, { id: 'lua', label: 'Lua' },
  { id: 'toml', label: 'TOML' }, { id: 'dockerfile', label: 'Dockerfile' },
  { id: 'properties', label: 'Properties' },
];

async function switchLanguage(tab: TabInfo, langId: string): Promise<void> {
  tab.forcedLang = langId;
  if (!tab.editorView) return;
  // Recreate editor with new language
  const content = tab.editorView.state.doc.toString();
  tab.editorView.destroy();
  tab.wrapperEl.innerHTML = '';
  const lang = langId || getLang(tab.fileName, content);
  const langExt = await getLangExt(lang);
  const exts = buildExtensions(tab);
  if (langExt) exts.push(langExt);
  tab.editorView = new EditorView({
    state: EditorState.create({ doc: content, extensions: exts }),
    parent: tab.wrapperEl,
  });
  const scroller = tab.wrapperEl.querySelector('.cm-scroller') as HTMLElement | null;
  if (scroller) scroller.classList.add('editor-cm-scroller');
  updateStatusBar();
}

function updateStatusBar(): void {
  const tab = activeTabId ? tabs.get(activeTabId) : null;
  if (!tab?.editorView) { statusBarEl.textContent = ''; return; }
  const state = tab.editorView.state;
  const cursor = state.selection.main.head;
  const line = state.doc.lineAt(cursor);
  const col = cursor - line.from + 1;
  const lang = tab.forcedLang || getLang(tab.fileName, tab.editorView.state.doc.toString());
  const langLabel = LANG_OPTIONS.find(l => l.id === lang)?.label || lang.toUpperCase() || 'Plain Text';

  // Update or create elements (avoid full innerHTML rebuild to preserve button state)
  let infoSpan = statusBarEl.querySelector('.editor-info') as HTMLElement | null;
  if (!infoSpan) {
    statusBarEl.innerHTML = '';
    infoSpan = document.createElement('span');
    infoSpan.className = 'editor-info';
    statusBarEl.appendChild(infoSpan);

    // Spacer
    const spacer = document.createElement('span');
    spacer.className = 'editor-status';
    statusBarEl.appendChild(spacer);

    // Font size button
    const fontBtn = document.createElement('button');
    fontBtn.className = 'editor-font-btn';
    fontBtn.textContent = `${getEditorFontSize()}px`;
    fontBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      showFontSizePicker(fontBtn);
    });
    statusBarEl.appendChild(fontBtn);

    // Language selector
    const langBtn = document.createElement('button');
    langBtn.className = 'editor-lang-btn';
    langBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const currentTab = activeTabId ? tabs.get(activeTabId) : null;
      if (currentTab) showLangPicker(langBtn, currentTab);
    });
    statusBarEl.appendChild(langBtn);

    // Save button
    const saveBtn = document.createElement('button');
    saveBtn.id = 'editor-save-btn';
    saveBtn.className = 'editor-save-btn';
    saveBtn.textContent = navigator.userAgent.includes('Windows') ? 'Ctrl+S' : '⌘S';
    saveBtn.addEventListener('click', () => {
      if (activeTabId) saveTab(activeTabId);
    });
    statusBarEl.appendChild(saveBtn);
  }

  infoSpan.textContent = `Ln ${line.number}, Col ${col}  ·  ${state.doc.lines} lines  ·  UTF-8`;

  // Update language label
  const langBtn = statusBarEl.querySelector('.editor-lang-btn');
  if (langBtn) langBtn.textContent = langLabel;

  // Update font size label
  const fontBtn = statusBarEl.querySelector('.editor-font-btn');
  if (fontBtn) fontBtn.textContent = `${getEditorFontSize()}px`;
}

// --- Editor font size ---
const FONT_SIZE_KEY = 'meterm-editor-font-size';
const DEFAULT_FONT_SIZE = 13;
const MIN_FONT_SIZE = 10;
const MAX_FONT_SIZE = 24;

function getEditorFontSize(): number {
  const saved = localStorage.getItem(FONT_SIZE_KEY);
  return saved ? Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, parseInt(saved, 10) || DEFAULT_FONT_SIZE)) : DEFAULT_FONT_SIZE;
}

function setEditorFontSize(size: number): void {
  size = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, size));
  localStorage.setItem(FONT_SIZE_KEY, String(size));
  // Apply to all open editors
  for (const tab of tabs.values()) {
    if (tab.wrapperEl) {
      const cm = tab.wrapperEl.querySelector('.cm-editor') as HTMLElement;
      if (cm) cm.style.fontSize = `${size}px`;
    }
  }
  updateStatusBar();
}

function showFontSizePicker(anchor: HTMLElement): void {
  // Remove existing picker
  document.querySelector('.editor-font-picker')?.remove();

  const picker = document.createElement('div');
  picker.className = 'editor-font-picker';

  const currentSize = getEditorFontSize();

  const minusBtn = document.createElement('button');
  minusBtn.textContent = '−';
  minusBtn.className = 'font-picker-btn';
  minusBtn.onclick = (e) => { e.stopPropagation(); setEditorFontSize(getEditorFontSize() - 1); sizeLabel.textContent = `${getEditorFontSize()}px`; };

  const sizeLabel = document.createElement('span');
  sizeLabel.className = 'font-picker-label';
  sizeLabel.textContent = `${currentSize}px`;

  const plusBtn = document.createElement('button');
  plusBtn.textContent = '+';
  plusBtn.className = 'font-picker-btn';
  plusBtn.onclick = (e) => { e.stopPropagation(); setEditorFontSize(getEditorFontSize() + 1); sizeLabel.textContent = `${getEditorFontSize()}px`; };

  picker.appendChild(minusBtn);
  picker.appendChild(sizeLabel);
  picker.appendChild(plusBtn);

  // Position above anchor
  const rect = anchor.getBoundingClientRect();
  picker.style.position = 'fixed';
  picker.style.bottom = `${window.innerHeight - rect.top + 4}px`;
  picker.style.left = `${rect.left}px`;

  document.body.appendChild(picker);

  // Close on outside click
  const close = (e: MouseEvent) => {
    if (!picker.contains(e.target as Node) && e.target !== anchor) {
      picker.remove();
      document.removeEventListener('mousedown', close);
    }
  };
  setTimeout(() => document.addEventListener('mousedown', close), 0);
}

function showLangPicker(anchor: HTMLElement, tab: TabInfo): void {
  // Remove existing picker
  document.querySelector('.editor-lang-picker')?.remove();

  const picker = document.createElement('div');
  picker.className = 'editor-lang-picker';

  for (const opt of LANG_OPTIONS) {
    const item = document.createElement('div');
    item.className = `editor-lang-item${opt.id === (tab.forcedLang || '') ? ' active' : ''}`;
    item.textContent = opt.label;
    item.addEventListener('click', () => {
      picker.remove();
      void switchLanguage(tab, opt.id);
    });
    picker.appendChild(item);
  }

  // Position above the anchor
  const rect = anchor.getBoundingClientRect();
  picker.style.bottom = `${window.innerHeight - rect.top + 4}px`;
  picker.style.right = `${window.innerWidth - rect.right}px`;
  document.body.appendChild(picker);

  // Close on click outside
  const close = (e: MouseEvent) => {
    if (!picker.contains(e.target as Node)) {
      picker.remove();
      document.removeEventListener('click', close);
    }
  };
  setTimeout(() => document.addEventListener('click', close), 0);
}

function pollPendingFiles(): void {
  const raw = localStorage.getItem(`${LS_PREFIX}pending`);
  if (raw) {
    localStorage.removeItem(`${LS_PREFIX}pending`);
    try {
      for (const item of JSON.parse(raw) as Array<{ tabId: string; sessionId: string; filePath: string; fileName: string; host: string }>) {
        if (!tabs.has(item.tabId)) {
          const wrapper = document.createElement('div');
          wrapper.className = 'editor-tab-content';
          wrapper.style.display = 'none';
          contentEl.appendChild(wrapper);
          tabs.set(item.tabId, {
            ...item, editorView: null, wrapperEl: wrapper,
            isDirty: false, isSaving: false, content: '', loaded: false, forcedLang: '',
          });
        }
        void activateTab(item.tabId);
      }
    } catch (e) { console.error('Failed to parse pending:', e); }
  }
  setTimeout(pollPendingFiles, 300);
}

function pollContent(): void {
  for (const [tabId, tab] of tabs) {
    if (tab.loaded) continue;
    const raw = localStorage.getItem(`${LS_PREFIX}content-${tabId}`);
    if (raw) {
      localStorage.removeItem(`${LS_PREFIX}content-${tabId}`);
      const data = JSON.parse(raw) as { content?: string; filePath?: string; error?: string };
      tab.loaded = true;
      if (data.error) {
        tab.content = '';
        tab.wrapperEl.innerHTML = `<div class="editor-error">${escapeHtml(data.error)}</div>`;
      } else {
        tab.content = data.content || '';
        if (tabId === activeTabId) void activateTab(tabId);
      }
    }
  }
  setTimeout(pollContent, 200);
}

function pollSaveResults(): void {
  for (const [tabId, tab] of tabs) {
    if (!tab.isSaving) continue;
    const raw = localStorage.getItem(`${LS_PREFIX}save-${tabId}`);
    if (raw) {
      localStorage.removeItem(`${LS_PREFIX}save-${tabId}`);
      tab.isSaving = false;
      const result = JSON.parse(raw) as { success: boolean; error?: string };
      if (result.success) { tab.isDirty = false; renderTabs(); updateWindowTitle(); }
      setSaveBtnState(result.success ? 'saved' : 'failed');
    }
  }
  setTimeout(pollSaveResults, 200);
}

export function initEditorContent(): void {
  const settings = loadSettings();
  isDark = resolveThemeAttr(settings.colorScheme) !== 'light';

  import('./styles/file-editor.css');

  // Tab bar was created synchronously by file-editor-init.ts
  tabBarEl = document.getElementById('editor-tabs-area')!;

  // Container for editor panels + status bar
  const container = document.createElement('div');
  container.id = 'editor-window-container';
  document.body.appendChild(container);

  // Content wrapper (each tab adds its own child div)
  contentEl = document.createElement('div');
  contentEl.className = 'editor-content';
  container.appendChild(contentEl);

  // Status bar
  statusBarEl = document.createElement('div');
  statusBarEl.className = 'editor-statusbar';
  container.appendChild(statusBarEl);

  pollPendingFiles();
  pollContent();
  pollSaveResults();

  void getCurrentWindow().onCloseRequested(async (event) => {
    const dirty = [...tabs.values()].filter(tab => tab.isDirty);
    if (dirty.length > 0) {
      const ok = await confirm(t('editorUnsavedChanges'), { title: 'MeTerm Editor', kind: 'warning' });
      if (!ok) { event.preventDefault(); return; }
    }
    localStorage.setItem(`${LS_PREFIX}closed`, '1');
  });

  void revealAfterPaint(getCurrentWindow().label);
}
