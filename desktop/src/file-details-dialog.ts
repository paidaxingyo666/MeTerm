/**
 * file-details-dialog.ts — 文件/文件夹"详情"模态弹窗
 *
 * 使用与 drawer-modal 一致的样式(rgba 背景 + blur),挂到当前抽屉容器内。
 * 支持普通文件、文件夹、符号链接(显示目标路径与解引用后的类型)。
 */

import type { DrawerInstance } from './drawer';
import type { FileInfo } from './protocol';
import { escapeHtml } from './status-bar';
import { formatSize } from './file-utils';
import { createOverlayScrollbar, type OverlayScrollbarHandle } from './overlay-scrollbar';

/** 把数字模式(如 "0644")转成 rwxrwxrwx 字符串 */
function formatPermBits(mode: string): string {
  // mode 可能是 "0644" / "644" / "100644" 之类。取末 3 位八进制。
  const cleaned = mode.replace(/^0+/, '') || '0';
  const last3 = cleaned.length > 3 ? cleaned.slice(-3) : cleaned.padStart(3, '0');
  const map = ['---', '--x', '-w-', '-wx', 'r--', 'r-x', 'rw-', 'rwx'];
  let out = '';
  for (const ch of last3) {
    const n = parseInt(ch, 8);
    out += map[n] || '---';
  }
  return out;
}

/** 取文件扩展名(无扩展名返回空串) */
function getExtension(name: string): string {
  if (name.startsWith('.') && name.indexOf('.', 1) === -1) return ''; // .bashrc 等
  const idx = name.lastIndexOf('.');
  if (idx <= 0 || idx === name.length - 1) return '';
  return name.slice(idx + 1).toLowerCase();
}

/** 创建一行 label/value,value 区域可包含复制按钮 */
function rowHtml(label: string, valueHtml: string, mono = false): string {
  return `
    <div class="file-details-row">
      <div class="file-details-label">${escapeHtml(label)}</div>
      <div class="file-details-value${mono ? ' mono' : ''}">${valueHtml}</div>
    </div>
  `;
}

/** 创建带复制按钮的可复制值 */
function copyableValue(text: string): string {
  return `
    <span class="file-details-copyable" data-copy="${escapeHtml(text)}">
      <span class="file-details-text">${escapeHtml(text)}</span>
      <button class="file-details-copy-btn" type="button" title="复制">复制</button>
    </span>
  `;
}

/**
 * 显示文件详情弹窗。
 * @param instance Drawer 实例(用于挂载位置)
 * @param info     文件元信息
 * @param fullPath 完整绝对路径
 */
export function showFileDetailsDialog(
  instance: DrawerInstance,
  info: FileInfo,
  fullPath: string,
): void {
  const drawerContent = instance.element.querySelector('.drawer-content') as HTMLElement | null;
  const container = (drawerContent && drawerContent.offsetParent !== null) ? drawerContent : document.body;

  // 复用同一时间只允许一个详情弹窗
  container.querySelector('.drawer-modal-overlay[data-file-details]')?.remove();

  const overlay = document.createElement('div');
  overlay.className = 'drawer-modal-overlay';
  overlay.dataset.fileDetails = '';
  if (container === document.body) {
    overlay.style.position = 'fixed';
    overlay.style.zIndex = '10000';
  }

  // ── 组装类型描述 ──
  let typeText: string;
  if (info.is_link) {
    typeText = info.is_dir ? '符号链接 → 文件夹' : '符号链接 → 文件';
  } else if (info.is_dir) {
    typeText = '文件夹';
  } else {
    typeText = '文件';
  }

  // ── 大小展示 ──
  const sizeText = info.is_dir
    ? '—'
    : `${formatSize(info.size)}  (${info.size.toLocaleString()} 字节)`;

  // ── 时间展示 ──
  const mtimeText = info.mtime > 0
    ? new Date(info.mtime * 1000).toLocaleString()
    : '—';

  // ── 权限展示 ──
  const permBits = formatPermBits(info.mode);
  // 取最后 3 位作为八进制显示
  const cleanedMode = info.mode.replace(/^0+/, '') || '0';
  const octal = cleanedMode.length > 3 ? cleanedMode.slice(-3) : cleanedMode.padStart(3, '0');
  const modeText = `${permBits}  (${octal})`;

  // ── 所有者 ──
  const ownerText = `${info.owner || '-'}:${info.group || '-'}`;

  // ── 扩展名(仅文件) ──
  const ext = !info.is_dir ? getExtension(info.name) : '';

  // ── 父目录 ──
  const parentDir = fullPath.lastIndexOf('/') > 0
    ? fullPath.substring(0, fullPath.lastIndexOf('/'))
    : '/';

  let rowsHtml = '';
  rowsHtml += rowHtml('名称', escapeHtml(info.name), true);
  rowsHtml += rowHtml('类型', escapeHtml(typeText));
  rowsHtml += rowHtml('完整路径', copyableValue(fullPath), true);
  rowsHtml += rowHtml('父目录', copyableValue(parentDir), true);
  if (info.is_link && info.link_target) {
    rowsHtml += rowHtml('链接目标', copyableValue(info.link_target), true);
  }
  rowsHtml += rowHtml('大小', escapeHtml(sizeText));
  rowsHtml += rowHtml('修改时间', escapeHtml(mtimeText));
  rowsHtml += rowHtml('权限', escapeHtml(modeText), true);
  rowsHtml += rowHtml('所有者', escapeHtml(ownerText), true);
  if (ext) {
    rowsHtml += rowHtml('扩展名', escapeHtml(ext));
  }

  // 结构:modal 不滚动(overflow:hidden 由 CSS 控制),
  // 只有底部 .file-details-scroll 区域可滚动 — overlay-scrollbar 以 modal 为容器,
  // bar 贴在 modal 右侧内边,不会溢出 modal。
  // 关闭按钮做成右上角的小 X,不再占据底部一整行。
  overlay.innerHTML = `
    <div class="drawer-modal file-details-modal">
      <button class="file-details-close" type="button" aria-label="关闭">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3 3l10 10M13 3L3 13"/></svg>
      </button>
      <div class="drawer-modal-title file-details-title">${escapeHtml(info.name)} — 详情</div>
      <div class="file-details-scroll">
        <div class="file-details-rows">${rowsHtml}</div>
      </div>
    </div>
  `;

  container.appendChild(overlay);

  // ── 自定义滚动条 ──
  // 使用 inline 模式(viewport === container):bar 会被挂到 scrollEl 的 parent(modal),
  // 并通过 offsetTop / offsetHeight 精确贴到 scrollEl 的位置。
  // 之所以不用 `container: modalEl` 非 inline 模式:那样 bar 会铺满整个 modal 高度,
  // 而 thumb 位置按 scrollEl.clientHeight 算,两者尺寸不匹配会出现 thumb 位置偏移。
  const scrollEl = overlay.querySelector('.file-details-scroll') as HTMLElement;
  let scrollbarHandle: OverlayScrollbarHandle | null = null;
  if (scrollEl) {
    scrollbarHandle = createOverlayScrollbar({ viewport: scrollEl, container: scrollEl });
  }

  // ── 事件绑定 ──
  const close = () => {
    scrollbarHandle?.destroy();
    overlay.remove();
  };

  overlay.querySelector('.file-details-close')!.addEventListener('click', close);
  // 不再支持"点遮罩关闭":拖动抽屉/分屏 split handle 时,mouseup 落在 overlay 上
  // 会被当成 click 触发关闭,体验很差。用户可用右上角 X 或 Esc 关闭。

  // 复制按钮
  overlay.querySelectorAll<HTMLButtonElement>('.file-details-copy-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const wrapper = btn.closest('.file-details-copyable') as HTMLElement | null;
      const text = wrapper?.dataset.copy || '';
      if (!text) return;
      navigator.clipboard.writeText(text).then(() => {
        const orig = btn.textContent;
        btn.textContent = '已复制';
        setTimeout(() => { btn.textContent = orig || '复制'; }, 1200);
      }).catch(() => {});
    });
  });

  // Esc 关闭
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); }
  };
  document.addEventListener('keydown', onKey);
}
