/**
 * drawer-layout.ts
 * 布局管理相关：高度调整、拖拽调节、分屏处理、resize handle
 * 从 drawer.ts 中提取，供 DrawerManagerClass 委托调用。
 */

import { loadSettings, saveSettings } from './themes';

/** DrawerInstance 中布局相关的字段子集 */
export interface LayoutFields {
  sessionId: string;
  element: HTMLDivElement;
  height: number;
}

export interface LayoutConfig {
  minHeight: number;
  maxHeightRatio: number;
}

export interface LayoutCallbacks<T extends LayoutFields = LayoutFields> {
  updateHeight: (instance: T) => void;
  saveDrawerLayout: (instance: T) => void;
}

export function setupResizeHandle<T extends LayoutFields>(
  instance: T,
  config: LayoutConfig,
  callbacks: LayoutCallbacks<T>,
): void {
  const handle = instance.element.querySelector('.drawer-resize-handle') as HTMLDivElement;
  let startY = 0;
  let startHeight = 0;

  handle.addEventListener('mousedown', (e) => {
    startY = e.clientY;
    startHeight = instance.height;
    instance.element.classList.add('resizing');
    document.body.classList.add('drawer-resizing');
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });

  const onMouseMove = (e: MouseEvent) => {
    e.preventDefault();
    const deltaY = startY - e.clientY;
    const newHeight = Math.max(
      config.minHeight,
      Math.min(startHeight + deltaY, window.innerHeight * config.maxHeightRatio)
    );
    instance.height = newHeight;
    instance.element.style.setProperty('--drawer-height', `${newHeight}px`);
    // Flex layout handles terminal resizing — no manual bottom offset needed
    import('./ai-capsule').then(({ AICapsuleManager }) => {
      AICapsuleManager.setDrawerOffset(instance.sessionId, newHeight);
    });
  };

  const onMouseUp = () => {
    document.body.classList.remove('drawer-resizing');
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    instance.element.classList.remove('resizing');
    callbacks.updateHeight(instance);
    callbacks.saveDrawerLayout(instance);
  };

  handle.addEventListener('dblclick', () => {
    const presets = [0.3, 0.4, 0.5];
    const currentRatio = instance.height / window.innerHeight;
    let nextPreset = presets.find((p) => p > currentRatio + 0.05);
    if (!nextPreset) nextPreset = presets[0];
    instance.height = window.innerHeight * nextPreset;
    callbacks.updateHeight(instance);
    callbacks.saveDrawerLayout(instance);
  });
}

export function setupSplitHandle<T extends LayoutFields>(
  instance: T,
  callbacks: Pick<LayoutCallbacks<T>, 'saveDrawerLayout'>,
): void {
  const splitHandle = instance.element.querySelector('.drawer-split-handle') as HTMLDivElement;
  const sidebar = instance.element.querySelector('.drawer-sidebar') as HTMLDivElement;
  const content = instance.element.querySelector('.drawer-content') as HTMLDivElement;
  if (!splitHandle || !sidebar || !content) return;

  let startX = 0;
  let startWidth = 0;

  splitHandle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    startX = e.clientX;
    startWidth = sidebar.getBoundingClientRect().width;
    document.body.classList.add('drawer-splitting');
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });

  const onMouseMove = (e: MouseEvent) => {
    e.preventDefault();
    const deltaX = e.clientX - startX;
    const contentWidth = content.getBoundingClientRect().width;
    const maxWidth = contentWidth * 0.5;
    const newWidth = Math.max(100, Math.min(startWidth + deltaX, maxWidth));
    sidebar.style.width = `${newWidth}px`;
  };

  const onMouseUp = () => {
    document.body.classList.remove('drawer-splitting');
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    callbacks.saveDrawerLayout(instance);
  };
}

export function saveDrawerLayout(instance: LayoutFields): void {
  const settings = loadSettings();
  if (!settings.rememberDrawerLayout) return;

  const sidebar = instance.element.querySelector('.drawer-sidebar') as HTMLDivElement;
  const sidebarWidth = sidebar ? sidebar.getBoundingClientRect().width : 0;

  saveSettings({
    ...settings,
    drawerHeight: instance.height,
    drawerSidebarWidth: sidebarWidth,
  });
}

export function updateHeight(instance: LayoutFields): void {
  instance.element.style.setProperty('--drawer-height', `${instance.height}px`);
  // updateTerminalPadding is a no-op (flex layout handles it)
  import('./ai-capsule').then(({ AICapsuleManager }) => {
    AICapsuleManager.setDrawerOffset(instance.sessionId, instance.height);
  });
}
