/**
 * viewer-mirror — 被接管(观看)会话的镜像渲染。
 *
 * 手机接管后 PTY 按手机尺寸排版,桌面 xterm 仍是全尺寸 → 输出按手机宽度换行,
 * 显示错乱。这里把桌面 xterm resize 到主控的实际 cols/rows,再用 CSS transform
 * 等比缩放并在容器内居中(letterbox)——与手机端 viewer 的 _layoutSyncedTerminal
 * 同一策略,也与桌面 PiP 模式"冻结 PTY + CSS 缩放"先例一致。
 *
 * 触发链:
 *  - master-lost           → enterMirror(标记;尺寸等服务端下行 0x03)
 *  - 服务端下行 MsgResize   → applyMirror(cols, rows)(主控每次 resize 都会广播)
 *  - master-gained         → exitMirror:清 transform + fit 回自身尺寸 +
 *                            sendResize + MsgNudge(强制 TUI 按新尺寸重绘)
 *  - 窗口/分屏变化          → relayoutMirror(doResizeInternal 对镜像会话只重排缩放)
 */

import type { ManagedTerminal } from './terminal-types';
import { sendToTerminal } from './terminal-transport';
import { encodeMessage, encodeResize, MsgNudge } from './protocol';

/** 处于镜像(被远端主控)状态的会话 → 主控 PTY 尺寸 */
const mirrors = new Map<string, { cols: number; rows: number }>();

export function isMirrored(sessionId: string): boolean {
  return mirrors.has(sessionId);
}

/** 标记进入镜像状态(master-lost 时尺寸未知,等下行 0x03 再应用缩放)。 */
export function enterMirror(sessionId: string): void {
  if (!mirrors.has(sessionId)) {
    mirrors.set(sessionId, { cols: 0, rows: 0 });
  }
}

/** 主控尺寸到达/变化:resize xterm 并重排缩放。 */
export function applyMirror(mt: ManagedTerminal, cols: number, rows: number): void {
  if (cols <= 0 || rows <= 0) return;
  mirrors.set(mt.id, { cols, rows });
  if (mt.terminal.cols !== cols || mt.terminal.rows !== rows) {
    mt.terminal.resize(cols, rows);
  }
  layoutMirror(mt);
  // renderer 维度在 resize 后一帧才最终落定,rAF 再排一次兜底
  requestAnimationFrame(() => layoutMirror(mt));
}

/** 按主控尺寸等比缩放 + 容器内居中。
 *  画布尺寸取 renderService.dimensions.css.canvas(渲染器权威值,resize 后同步
 *  更新;.xterm-screen clientWidth 在 resize 后一帧内可能是旧值——手机端
 *  _layoutSyncedTerminal 的同款经验)。 */
export function layoutMirror(mt: ManagedTerminal): void {
  const dim = mirrors.get(mt.id);
  if (!dim || dim.cols <= 0) return;
  const el = mt.terminal.element as HTMLElement | null;
  if (!el) return;
  let canvasW = 0;
  let canvasH = 0;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dims = (mt.terminal as any)._core._renderService.dimensions;
    canvasW = dims?.css?.canvas?.width ?? 0;
    canvasH = dims?.css?.canvas?.height ?? 0;
  } catch { /* 私有 API 不可用时走 screen 兜底 */ }
  if (canvasW < 1 || canvasH < 1) {
    const screen = mt.container.querySelector('.xterm-screen') as HTMLElement | null;
    canvasW = screen?.clientWidth ?? 0;
    canvasH = screen?.clientHeight ?? 0;
  }
  const rect = mt.container.getBoundingClientRect();
  if (canvasW < 1 || canvasH < 1 || rect.width < 10 || rect.height < 10) return;
  const scale = Math.min(rect.width / canvasW, rect.height / canvasH);
  if (!isFinite(scale) || scale <= 0) return;
  // 容器必须是定位上下文,否则 absolute 相对更上层参照,left/top 全错
  if (getComputedStyle(mt.container).position === 'static') {
    mt.container.style.position = 'relative';
  }
  el.style.position = 'absolute';
  el.style.transformOrigin = 'top left';
  el.style.transform = `scale(${scale})`;
  el.style.width = `${canvasW}px`;
  el.style.height = `${canvasH}px`;
  // 镜像内容细描边(与手机端 _layoutSyncedTerminal 同款):outline 不占布局,
  // 宽度按 scale 反补视觉恒 1px。不用圆角(用户拍板)。
  el.style.outline = `${1 / scale}px solid rgba(128, 128, 128, 0.5)`;
  el.style.left = `${Math.max(0, Math.floor((rect.width - canvasW * scale) / 2))}px`;
  el.style.top = `${Math.max(0, Math.floor((rect.height - canvasH * scale) / 2))}px`;
}

/** 窗口/分屏变化时,镜像会话只重排缩放(不 fit、不发 resize)。 */
export function relayoutMirror(mt: ManagedTerminal): void {
  if (mirrors.has(mt.id)) layoutMirror(mt);
}

/**
 * 拿回主控:清除镜像,按自身容器 fit 并通知服务端。
 * PTY 此刻仍是远端尺寸;若 fit 结果恰好同尺寸,resize 会被内核 memcmp 短路,
 * 所以补发 MsgNudge(SIGWINCH)强制 TUI 重绘——与手机端接管路径对称。
 */
export function exitMirror(mt: ManagedTerminal): void {
  if (!mirrors.delete(mt.id)) return;
  const el = mt.terminal.element as HTMLElement | null;
  if (el) {
    el.style.transform = '';
    el.style.left = '';
    el.style.top = '';
    el.style.position = '';
    el.style.width = '';
    el.style.height = '';
    el.style.outline = '';
  }
  // 标签不在前台时容器不可见,fit 量不到尺寸(终端会停留在镜像[手机]尺寸,
  // PTY 也跟着错——手机停止接管后镜像到的还是手机比例,真机反馈)。
  // 回退用 lastSentCols/Rows:镜像期间桌面从不发 resize,该值冻结在接管前
  // 最后一次发送的桌面尺寸,正是"标签可见时该有的尺寸"。
  const rect = mt.container.getBoundingClientRect();
  const visible = rect.width >= 10 && rect.height >= 10;
  let cols = 0;
  let rows = 0;
  if (visible) {
    try {
      mt.fitAddon.fit();
    } catch { /* fit 失败走 lastSent 回退 */ }
    cols = mt.terminal.cols;
    rows = mt.terminal.rows;
  }
  if ((!visible || cols <= 1 || rows <= 1) && mt.lastSentCols > 0 && mt.lastSentRows > 0) {
    cols = mt.lastSentCols;
    rows = mt.lastSentRows;
    // 本地 xterm 一并回到桌面尺寸,标签切回前台时显示即正确(resizeAll 再校正)
    if (mt.terminal.cols !== cols || mt.terminal.rows !== rows) {
      mt.terminal.resize(cols, rows);
    }
  }
  // 不引 terminal-resize.sendResize(会与其 isMirrored 检查形成循环依赖),
  // 等价实现:直发 + 维护 lastSent 记录
  if (cols > 0 && rows > 0) {
    sendToTerminal(mt, encodeResize(cols, rows));
    mt.lastSentCols = cols;
    mt.lastSentRows = rows;
  }
  sendToTerminal(mt, encodeMessage(MsgNudge, new Uint8Array(0)));
}

/** 会话结束/关闭时清理状态。 */
export function clearMirror(sessionId: string): void {
  mirrors.delete(sessionId);
}
