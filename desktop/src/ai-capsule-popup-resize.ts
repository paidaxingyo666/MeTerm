// ─── AI Capsule: Popup Max-Height & Resize Handle ───────────
// Handles the "popup" panels that float above the AI Bar (model
// dropdown, history panel, chat history panel) — adaptive max
// height based on terminal size, plus a drag-to-resize handle.

/** State held per-manager for an active popup's resize observation. */
export class PopupResizeState {
  resizeObserver: ResizeObserver | null = null;
  resizeHandler: (() => void) | null = null;
  activePopup: { panel: HTMLElement; aiBar: HTMLElement } | null = null;
  manualHeight = false; // 手动调整后锁定，不再自适应
}

/** 计算弹窗可用最大高度：保留至少 4 行终端内容，不超过终端面积 30% */
export function calcPopupMaxHeight(aiBar: HTMLElement): number {
  // In side mode, use the side panel as container; otherwise use terminal-panel
  const container = aiBar.closest('.ai-side-panel')
    || aiBar.closest('#terminal-panel')
    || aiBar.parentElement;
  if (!container) return 0;
  const containerRect = container.getBoundingClientRect();
  const barRect = aiBar.getBoundingClientRect();

  // In side mode there are no xterm rows in the side panel, use a simpler calculation
  if (aiBar.closest('.ai-side-panel')) {
    const available = barRect.top - containerRect.top - 8;
    const maxByPercent = containerRect.height * 0.5;
    return Math.max(Math.min(available, maxByPercent), 0);
  }

  const row = container.querySelector('.xterm-rows > div');
  const lineHeight = row ? row.getBoundingClientRect().height : 18;
  const reserved = lineHeight * 4 + 8;
  const available = barRect.top - containerRect.top - reserved;
  const maxByPercent = containerRect.height * 0.3;
  return Math.max(Math.min(available, maxByPercent), 0);
}

/** 设置弹窗 max-height（自适应模式） */
export function adjustPopupMaxHeight(
  state: PopupResizeState,
  panel: HTMLElement,
  aiBar: HTMLElement,
): void {
  if (state.manualHeight) return; // 手动锁定后不再自动调整
  panel.style.maxHeight = calcPopupMaxHeight(aiBar) + 'px';
}

/** 绑定响应式监听：ResizeObserver + window resize */
export function observePopupResize(
  state: PopupResizeState,
  panel: HTMLElement,
  aiBar: HTMLElement,
): void {
  unobservePopupResize(state);
  state.activePopup = { panel, aiBar };

  const onResize = () => {
    if (state.activePopup && !state.manualHeight) {
      adjustPopupMaxHeight(state, state.activePopup.panel, state.activePopup.aiBar);
    }
  };

  // ResizeObserver 监听容器
  const container = aiBar.closest('.ai-side-panel') || aiBar.closest('#terminal-panel') || aiBar.parentElement;
  if (container) {
    state.resizeObserver = new ResizeObserver(onResize);
    state.resizeObserver.observe(container);
  }

  // window resize 兜底
  state.resizeHandler = onResize;
  window.addEventListener('resize', onResize);

  // 添加拖拽 handle
  ensurePopupResizeHandle(state, panel, aiBar);
}

/** 解绑弹窗 resize 监听 */
export function unobservePopupResize(state: PopupResizeState): void {
  if (state.resizeObserver) {
    state.resizeObserver.disconnect();
    state.resizeObserver = null;
  }
  if (state.resizeHandler) {
    window.removeEventListener('resize', state.resizeHandler);
    state.resizeHandler = null;
  }
  state.activePopup = null;
}

/** 为弹窗添加顶部拖拽 handle，手动调整高度后锁定自适应 */
export function ensurePopupResizeHandle(
  state: PopupResizeState,
  panel: HTMLElement,
  aiBar: HTMLElement,
): void {
  // render 会清空 innerHTML，每次需要重建
  let handle = panel.querySelector('.ai-popup-resize-handle') as HTMLElement | null;
  if (handle) return; // 已存在（未被清空）
  handle = document.createElement('div');
  handle.className = 'ai-popup-resize-handle';
  panel.insertBefore(handle, panel.firstChild);

  let startY = 0;
  let startH = 0;

  const onMove = (e: MouseEvent) => {
    const delta = startY - e.clientY;
    // 手动拖拽允许超过 30% 但保留至少 2 行终端内容
    const container = aiBar.closest('#terminal-panel') || aiBar.parentElement;
    let maxH = 0;
    if (container) {
      const containerRect = container.getBoundingClientRect();
      const barRect = aiBar.getBoundingClientRect();
      const row = container.querySelector('.xterm-rows > div');
      const lineHeight = row ? row.getBoundingClientRect().height : 18;
      const reserved = lineHeight * 2 + 8;
      maxH = barRect.top - containerRect.top - reserved;
    }
    const newH = Math.max(Math.min(startH + delta, maxH), 40);
    panel.style.maxHeight = newH + 'px';
  };

  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.body.style.userSelect = '';
    handle!.classList.remove('dragging');
  };

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    state.manualHeight = true; // 锁定自适应
    startY = e.clientY;
    startH = panel.getBoundingClientRect().height;
    document.body.style.userSelect = 'none';
    handle!.classList.add('dragging');
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}
