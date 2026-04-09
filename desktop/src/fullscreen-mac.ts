/**
 * fullscreen-mac.ts — macOS 原生全屏优化
 *
 * 仅在 macOS 下生效，方案极简：
 *   1. 进入全屏 → 给 <html> 加 `fs-mac` class
 *      - CSS 移除红绿灯 84px 预留
 *      - CSS 强制覆盖毛玻璃相关元素为不透明背景（视觉上"禁用"毛玻璃）
 *   2. 退出全屏 → 移除 class，CSS 覆盖自动失效，毛玻璃立刻恢复
 *
 * 关键点：不调用原生 `set_window_vibrancy(false)` ——
 * 一旦在全屏态拆掉 NSVisualEffectView，退出全屏后 Tauri 的 set_effects
 * 重新挂载时机不可控，常常挂不回去导致需要重启。改成纯 CSS 覆盖后，
 * 原生 NSVisualEffectView 始终存在，退出全屏时 CSS 类移除即恢复。
 */
import { getCurrentWindow } from '@tauri-apps/api/window';
import { isMacPlatform } from './app-state';

let installed = false;
let currentFs = false;

async function syncFullscreenState(): Promise<void> {
  let fs = false;
  try {
    fs = await getCurrentWindow().isFullscreen();
  } catch {
    return;
  }
  if (fs === currentFs) return;
  currentFs = fs;
  document.documentElement.classList.toggle('fs-mac', fs);
}

export function initMacFullscreen(): void {
  if (!isMacPlatform || installed) return;
  installed = true;

  // 初始状态同步（例如窗口以全屏状态启动）
  void syncFullscreenState();

  // onResized 在进入/退出全屏时都会触发
  void getCurrentWindow().onResized(() => { void syncFullscreenState(); });
}
