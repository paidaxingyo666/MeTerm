/**
 * Terminal File Link Provider
 *
 * 交互方式：
 * - Hover 下划线高亮，1s 后显示操作提示
 * - Ctrl/Cmd+Click 直接打开（本地用系统默认程序，SSH 跳转文件管理抽屉）
 * - 右键菜单 → "用本机关联程序打开"
 *
 * 检测策略（双层）：
 * 1. 正则匹配：绝对/相对路径、带扩展名文件（支持 Unicode/中文）
 * 2. CWD 目录缓存：将终端行中的 token 与当前目录文件列表比对
 */

import type { Terminal, ILink, ILinkProvider } from '@xterm/xterm';
import { invoke } from '@tauri-apps/api/core';
import { t } from './i18n';
import { loadSettings, saveSettings } from './themes';

// ── 类型 ────────────────────────────────────────────────────

export interface FileLinkContext {
  getCwd: () => string;
  isSSH: () => boolean;
  onSSHNavigate: (absolutePath: string) => void;
  /** SSH 会话：从 FileManager 获取远程目录条目（path + 文件名列表） */
  getRemoteDirEntries?: () => { cwd: string; names: Map<string, boolean> } | null;
}

// ── 路径正则（第一层：结构性匹配，支持 Unicode） ────────────

const PATH_PATTERNS = [
  // ~/path（含中文）
  /(?:^|(?<=[\s'"(,;|`]))~\/[\p{L}\p{N}_.\-/]+/gu,
  // Unix 绝对路径 (至少两级，含中文)
  /(?:^|(?<=[\s'"(,;|`]))\/[\p{L}\p{N}_.\-]+(?:\/[\p{L}\p{N}_.\-]+)+\/?/gu,
  // Windows 绝对路径
  /(?:^|(?<=[\s'"(,;|`]))[A-Za-z]:\\[\p{L}\p{N}_.\-\\]+/gu,
  // 相对路径含 /
  /(?:^|(?<=[\s'"(,;|`]))\.{0,2}\/[\p{L}\p{N}_.\-]+(?:\/[\p{L}\p{N}_.\-]+)*\/?/gu,
  // 带扩展名文件名（支持 .dotfile.ext 格式）
  /(?:^|(?<=[\s'"(,;|`]))\.?[\p{L}\p{N}_][\p{L}\p{N}_.\-]*\.(?:ts|js|tsx|jsx|py|rs|go|java|c|cpp|h|hpp|rb|php|sh|bash|zsh|yml|yaml|toml|json|xml|html|css|scss|less|md|txt|log|conf|cfg|ini|env|sql|graphql|proto|lock|csv|svg|png|jpg|jpeg|gif|ico|pdf|doc|docx|xls|xlsx|zip|tar|gz|dmg|mp3|mp4)(?=[\s'")\],;|`]|$)/giu,
];

// 单词匹配（第二层，支持 Unicode 和 .dotfile）
// \.? 允许匹配 .bashrc .config 等，但 . 和 .. 不会匹配（需要后跟字母/数字/下划线）
const WORD_PATTERN = /(?:^|(?<=\s))\.?[\p{L}\p{N}_][\p{L}\p{N}_.\-]*(?=\s|$)/gu;
const SHELL_KEYWORDS = new Set([
  'if', 'fi', 'do', 'in', 'for', 'then', 'else', 'elif', 'done', 'case', 'esac',
  'while', 'until', 'function', 'return', 'exit', 'export', 'unset', 'local',
  'echo', 'printf', 'cd', 'ls', 'rm', 'mv', 'cp', 'cat', 'grep', 'find',
  'mkdir', 'rmdir', 'chmod', 'chown', 'sudo', 'apt', 'brew', 'npm', 'git',
  'true', 'false', 'null', 'total',
]);

// ── CWD 目录缓存 ───────────────────────────────────────────

interface DirCacheEntry {
  names: Map<string, boolean>;
  ts: number;
}

const dirCacheMap = new Map<string, DirCacheEntry>();
const DIR_CACHE_TTL = 10_000;

export function prefetchDirCache(cwd: string): void {
  if (!cwd) return;
  const cached = dirCacheMap.get(cwd);
  if (cached && Date.now() - cached.ts < DIR_CACHE_TTL) return;
  fetchDirEntries(cwd);
}

async function fetchDirEntries(cwd: string): Promise<Map<string, boolean> | null> {
  try {
    const entries: [string, boolean][] = await invoke('list_dir_names', { path: cwd });
    const names = new Map<string, boolean>();
    for (const [name, isDir] of entries) names.set(name, isDir);
    dirCacheMap.set(cwd, { names, ts: Date.now() });
    if (dirCacheMap.size > 8) {
      const oldest = dirCacheMap.keys().next().value;
      if (oldest) dirCacheMap.delete(oldest);
    }
    return names;
  } catch { return null; }
}

function getCachedDirEntries(cwd: string): Map<string, boolean> | null {
  if (!cwd) return null;
  const cached = dirCacheMap.get(cwd);
  if (!cached || Date.now() - cached.ts > DIR_CACHE_TTL) return null;
  return cached.names;
}

// ── SSH 远程目录探测缓存 ─────────────────────────────────────

interface SSHDirProbe {
  cwd: string;
  names: Map<string, boolean>;
  ts: number;
}

const sshDirProbeMap = new Map<string, SSHDirProbe>();
const SSH_PROBE_TTL = 300_000; // 5 分钟，较长因为不像本地目录会频繁变化

/** 更新 SSH 会话的远程目录探测缓存（由 terminal.ts 调用） */
export function setSSHDirProbe(sessionId: string, cwd: string, files: { name: string; is_dir: boolean }[]): void {
  const names = new Map<string, boolean>();
  for (const f of files) names.set(f.name, f.is_dir);
  sshDirProbeMap.set(sessionId, { cwd, names, ts: Date.now() });
}

/** 获取 SSH 会话的远程目录探测缓存 */
export function getSSHDirProbe(sessionId: string): { cwd: string; names: Map<string, boolean> } | null {
  const probe = sshDirProbeMap.get(sessionId);
  if (!probe || Date.now() - probe.ts > SSH_PROBE_TTL) return null;
  return { cwd: probe.cwd, names: probe.names };
}

/** 清理 SSH 会话的远程目录探测缓存 */
export function clearSSHDirProbe(sessionId: string): void {
  sshDirProbeMap.delete(sessionId);
}

// ── Tooltip & Context Menu ──────────────────────────────────

const isMac = typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac');
const modLabel = isMac ? '⌘' : 'Ctrl';

let tooltipEl: HTMLDivElement | null = null;
let tooltipTimer: ReturnType<typeof setTimeout> | null = null;
let contextMenuEl: HTMLDivElement | null = null;
let activeHoverLink: { text: string; ctx: FileLinkContext } | null = null;

function ensureTooltip(): HTMLDivElement {
  if (!tooltipEl) {
    tooltipEl = document.createElement('div');
    tooltipEl.className = 'file-link-tooltip';
    document.body.appendChild(tooltipEl);
  }
  return tooltipEl;
}

function showTooltip(x: number, y: number, linkText: string): void {
  const el = ensureTooltip();
  const hint = t('fileLinkHint')
    .replace('{mod}', modLabel)
    .replace('{name}', linkText.length > 30 ? linkText.slice(0, 27) + '...' : linkText);
  el.textContent = hint;
  el.style.left = `${x}px`;
  el.style.top = `${y - 28}px`;
  el.style.display = 'block';
}

function hideTooltip(): void {
  if (tooltipTimer) { clearTimeout(tooltipTimer); tooltipTimer = null; }
  if (tooltipEl) tooltipEl.style.display = 'none';
  activeHoverLink = null;
}

function showContextMenu(x: number, y: number, linkText: string, ctx: FileLinkContext): void {
  removeContextMenu();
  const menu = document.createElement('div');
  menu.className = 'file-link-context-menu';

  const item = document.createElement('div');
  item.className = 'file-link-context-menu-item';
  item.textContent = ctx.isSSH()
    ? (t('fileLinkOpenInDrawer') || 'Open in File Manager')
    : (t('fileLinkOpenLocal') || 'Open with Default App');
  item.addEventListener('click', () => {
    removeContextMenu();
    openFileLink(linkText, ctx);
  });
  menu.appendChild(item);

  // 调整位置，避免溢出
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  document.body.appendChild(menu);
  contextMenuEl = menu;

  // 点击外部关闭
  const onClickOutside = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node)) {
      removeContextMenu();
      document.removeEventListener('click', onClickOutside, true);
      document.removeEventListener('contextmenu', onClickOutside, true);
    }
  };
  setTimeout(() => {
    document.addEventListener('click', onClickOutside, true);
    document.addEventListener('contextmenu', onClickOutside, true);
  }, 0);
}

function removeContextMenu(): void {
  if (contextMenuEl) { contextMenuEl.remove(); contextMenuEl = null; }
}

// ── 打开文件逻辑 ────────────────────────────────────────────

async function openFileLink(rawPath: string, ctx: FileLinkContext): Promise<void> {
  let cwd = ctx.getCwd();

  // SSH 会话：shellState.cwd 可能为空，尝试从 FileManager 获取远程 CWD
  if (ctx.isSSH() && !cwd && ctx.getRemoteDirEntries) {
    const remote = ctx.getRemoteDirEntries();
    if (remote) cwd = remote.cwd;
  }

  const resolved = resolvePath(rawPath, cwd);

  // 确认弹窗（除非用户选择了"不再提示"）
  const settings = loadSettings();
  if (!settings.fileLinkSkipConfirm) {
    const confirmed = await showOpenConfirm(rawPath, ctx.isSSH());
    if (!confirmed) return;
  }

  if (ctx.isSSH()) {
    const targetDir = looksLikeDirectory(rawPath) ? resolved : parentDir(resolved);
    ctx.onSSHNavigate(targetDir);
  } else {
    try {
      const pathType: string = await invoke('stat_path', { path: resolved });
      if (pathType === 'none') return;
      await invoke('open_path', { path: resolved });
    } catch { /* ignore */ }
  }
}

function showOpenConfirm(path: string, isSSH: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    const displayPath = path.length > 60 ? path.slice(0, 57) + '...' : path;
    const title = isSSH ? t('openFileManager') : t('fileLinkOpenLocal');
    const msg = isSSH
      ? t('navigateConfirmMsg').replace('{path}', displayPath)
      : t('fileLinkLocalConfirmMsg').replace('{path}', displayPath);

    const overlay = document.createElement('div');
    overlay.className = 'navigate-confirm-overlay';
    overlay.innerHTML = `
      <div class="navigate-confirm-dialog">
        <div class="navigate-confirm-title">${title}</div>
        <div class="navigate-confirm-msg">${msg}</div>
        <label class="navigate-confirm-checkbox">
          <input type="checkbox" id="filelink-dont-ask">
          ${t('fileLinkDontAskAgain')}
        </label>
        <div class="navigate-confirm-actions">
          <button class="navigate-confirm-cancel">${t('navigateCancel')}</button>
          <button class="navigate-confirm-ok">${t('fileLinkConfirmOpen')}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const dontAskCheckbox = overlay.querySelector('#filelink-dont-ask') as HTMLInputElement;

    const cleanup = (result: boolean) => {
      if (result && dontAskCheckbox.checked) {
        const s = loadSettings();
        s.fileLinkSkipConfirm = true;
        saveSettings(s);
      }
      overlay.remove();
      resolve(result);
    };

    overlay.querySelector('.navigate-confirm-cancel')!.addEventListener('click', () => cleanup(false));
    overlay.querySelector('.navigate-confirm-ok')!.addEventListener('click', () => cleanup(true));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) cleanup(false);
    });
  });
}

// ── 宽字符列映射 ────────────────────────────────────────────

/** 构建字符串索引→终端单元格列的映射，处理 CJK 宽字符（占2列） */
interface CellMapping {
  /** charIndex → 1-based start column */
  startCols: number[];
  /** charIndex → 1-based end column (inclusive, wide char = start+1) */
  endCols: number[];
}

function buildCellMapping(line: { length: number; getCell(x: number): any }): CellMapping {
  const startCols: number[] = [];
  const endCols: number[] = [];
  for (let col = 0; col < line.length; col++) {
    const cell = line.getCell(col);
    if (!cell) break;
    const width: number = cell.getWidth();
    if (width === 0) continue; // 宽字符的第二列，跳过
    const chars: string = cell.getChars();
    const colStart = col + 1; // 1-based
    const colEnd = col + width; // 1-based inclusive
    if (chars) {
      for (let i = 0; i < chars.length; i++) {
        startCols.push(colStart);
        endCols.push(colEnd);
      }
    } else {
      // 空单元格（空格）
      startCols.push(colStart);
      endCols.push(colEnd);
    }
  }
  return { startCols, endCols };
}

// ── Link Provider ───────────────────────────────────────────

class FileLinkProvider implements ILinkProvider {
  constructor(private ctx: FileLinkContext) {}

  provideLinks(
    lineNumber: number,
    callback: (links: ILink[] | undefined) => void,
  ): void {
    const terminal = this._terminal;
    if (!terminal) { callback(undefined); return; }

    const line = terminal.buffer.active.getLine(lineNumber - 1);
    if (!line) { callback(undefined); return; }

    const text = line.translateToString(true);
    if (!text.trim()) { callback(undefined); return; }

    // 构建字符索引→单元格列映射（处理 CJK 宽字符）
    const cellMap = buildCellMapping(line);

    const cwd = this.ctx.getCwd();
    const links: ILink[] = [];
    const coveredRanges: [number, number][] = [];

    // 第一层：正则
    for (const pattern of PATH_PATTERNS) {
      pattern.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = pattern.exec(text)) !== null) {
        const charStart = m.index;
        const charEnd = charStart + m[0].length - 1;
        if (charEnd >= cellMap.startCols.length) continue;
        const startCol = cellMap.startCols[charStart];
        const endCol = cellMap.endCols[charEnd];
        if (isRangeOverlap(coveredRanges, startCol, endCol)) continue;
        coveredRanges.push([startCol, endCol]);
        links.push(this.makeLink(lineNumber, startCol, endCol, m[0]));
      }
    }

    // 第二层：CWD 目录文件名比对
    // SSH 会话：从 FileManager 获取远程目录条目
    // 本地会话：从本地目录缓存获取
    let dirNames: Map<string, boolean> | null = null;
    let effectiveCwd = cwd;
    if (this.ctx.isSSH() && this.ctx.getRemoteDirEntries) {
      const remote = this.ctx.getRemoteDirEntries();
      if (remote) {
        dirNames = remote.names;
        effectiveCwd = remote.cwd;
      }
    } else if (cwd) {
      dirNames = getCachedDirEntries(cwd);
      if (!dirNames) prefetchDirCache(cwd);
    }

    if (dirNames) {
      WORD_PATTERN.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = WORD_PATTERN.exec(text)) !== null) {
        const word = m[0];
        if (word.length < 2) continue;
        if (SHELL_KEYWORDS.has(word.toLowerCase())) continue;
        if (/^\d+$/.test(word) || /^[rwx-]{9,}/.test(word)) continue;
        const charStart = m.index;
        const charEnd = charStart + word.length - 1;
        if (charEnd >= cellMap.startCols.length) continue;
        const startCol = cellMap.startCols[charStart];
        const endCol = cellMap.endCols[charEnd];
        if (isRangeOverlap(coveredRanges, startCol, endCol)) continue;
        if (!dirNames.has(word)) continue;
        coveredRanges.push([startCol, endCol]);
        links.push(this.makeLink(lineNumber, startCol, endCol, word));
      }
    }

    callback(links.length > 0 ? links : undefined);
  }

  _terminal: Terminal | null = null;

  private makeLink(lineNumber: number, startCol: number, endCol: number, text: string): ILink {
    const ctx = this.ctx;
    return {
      range: {
        start: { x: startCol, y: lineNumber },
        end: { x: endCol, y: lineNumber },
      },
      text,
      decorations: { pointerCursor: true, underline: true },
      activate: (event: MouseEvent, linkText: string) => {
        // 仅 Ctrl/Cmd+Click 触发
        const mod = isMac ? event.metaKey : event.ctrlKey;
        if (!mod) return;
        openFileLink(linkText, ctx);
      },
      hover: (event: MouseEvent, linkText: string) => {
        hideTooltip();
        activeHoverLink = { text: linkText, ctx };
        tooltipTimer = setTimeout(() => {
          showTooltip(event.clientX, event.clientY, linkText);
        }, 1000);
      },
      leave: () => {
        hideTooltip();
      },
    };
  }
}

// ── 辅助函数 ────────────────────────────────────────────────

function isRangeOverlap(ranges: [number, number][], start: number, end: number): boolean {
  return ranges.some(([s, e]) => start <= e && end >= s);
}

function resolvePath(raw: string, cwd: string): string {
  if (raw.startsWith('~') || raw.startsWith('/') || /^[A-Za-z]:[/\\]/.test(raw)) return raw;
  if (!cwd) return raw;
  const sep = cwd.includes('\\') ? '\\' : '/';
  const base = cwd.endsWith(sep) ? cwd : cwd + sep;
  return base + raw;
}

function looksLikeDirectory(path: string): boolean {
  if (path.endsWith('/') || path.endsWith('\\')) return true;
  const basename = path.split('/').pop() || path.split('\\').pop() || path;
  return !basename.includes('.');
}

function parentDir(path: string): string {
  const clean = path.replace(/[/\\]+$/, '');
  const sep = clean.includes('\\') ? '\\' : '/';
  const lastSep = clean.lastIndexOf(sep);
  if (lastSep <= 0) return '/';
  return clean.slice(0, lastSep);
}

// ── 公开 API ────────────────────────────────────────────────

export function registerFileLinkProvider(
  terminal: Terminal,
  ctx: FileLinkContext,
): { dispose: () => void } {
  const provider = new FileLinkProvider(ctx);
  provider._terminal = terminal;

  const linkDisposable = terminal.registerLinkProvider(provider);

  // 右键菜单监听
  const containerEl = terminal.element;
  const onContextMenu = (e: MouseEvent) => {
    if (activeHoverLink) {
      e.preventDefault();
      e.stopPropagation();
      hideTooltip();
      showContextMenu(e.clientX, e.clientY, activeHoverLink.text, activeHoverLink.ctx);
    }
  };
  containerEl?.addEventListener('contextmenu', onContextMenu, true);

  return {
    dispose: () => {
      linkDisposable.dispose();
      containerEl?.removeEventListener('contextmenu', onContextMenu, true);
      hideTooltip();
      removeContextMenu();
    },
  };
}
