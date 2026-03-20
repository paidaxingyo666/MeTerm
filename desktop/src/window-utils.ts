import { invoke } from '@tauri-apps/api/core';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';

const isWindows = navigator.userAgent.toLowerCase().includes('windows');

/**
 * Reveal a window that was created with alphaValue=0 (macOS anti-flash).
 * Uses a CSS animation probe to detect first paint, then waits one extra
 * frame (setTimeout 0) to ensure the GPU compositor has committed the
 * WKWebView content before setting alpha=1.
 */
export function revealAfterPaint(label: string): Promise<void> {
  return new Promise<void>((resolve) => {
    let revealed = false;
    const doReveal = () => {
      if (revealed) return;
      revealed = true;
      probe.remove();
      style.remove();
      // Wait for next event loop tick so GPU compositor commits the frame
      setTimeout(() => {
        void invoke('reveal_window', { label }).then(() => resolve());
      }, 50);
    };
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;top:-1px;left:-1px;width:1px;height:1px;pointer-events:none;animation:_probe 1ms linear 1';
    const style = document.createElement('style');
    style.textContent = '@keyframes _probe{from{opacity:0.999}to{opacity:1}}';
    document.head.appendChild(style);
    probe.addEventListener('animationstart', doReveal, { once: true });
    document.body.appendChild(probe);
    // Fallback
    setTimeout(() => doReveal(), 500);
  });
}

export interface UtilityWindowOptions {
  label: string;
  url: string;
  title: string;
  width: number;
  height: number;
  resizable: boolean;
}

/**
 * Create a utility window (settings, updater, about, etc.).
 *
 * On macOS/Linux: uses the Rust `create_transparent_window` command so the
 * native `.transparent(true)` builder flag is propagated correctly by WKWebView.
 *
 * On Windows: uses the frontend WebviewWindow API to avoid blocking the Win32
 * message loop during WebView2 initialization. The Rust command's synchronous
 * `builder.build()` dispatches to the main thread and blocks it, freezing ALL
 * existing WebView2 instances until the new window's WebView2 runtime is ready
 * (can take 1–5 s on cold start). The frontend API creates the window
 * asynchronously, keeping the main window responsive.
 */
export async function createUtilityWindow(opts: UtilityWindowOptions): Promise<void> {
  if (!isWindows) {
    await invoke('create_transparent_window', { ...opts });
    return;
  }

  // Windows path: asynchronous WebView2 creation via frontend API
  await new Promise<void>((resolve, reject) => {
    const win = new WebviewWindow(opts.label, {
      url: opts.url,
      title: opts.title,
      width: opts.width,
      height: opts.height,
      center: true,
      resizable: opts.resizable,
      decorations: false,
      transparent: true,
      visible: false,
    });

    const timeout = setTimeout(() => {
      reject(new Error(`Utility window "${opts.label}" creation timed out`));
    }, 10_000);

    void win.once('tauri://created', () => {
      clearTimeout(timeout);
      // Register grace period on Rust side
      void invoke('track_window_created_ts', { windowLabel: opts.label });
      resolve();
    });
    void win.once('tauri://error', (event) => {
      clearTimeout(timeout);
      reject(new Error(`Failed to create window "${opts.label}": ${String(event)}`));
    });
  });
}

/**
 * Create a new app window at the specified screen coordinates.
 *
 * On Windows: uses the frontend WebviewWindow API because Rust's
 * WebviewWindowBuilder does not reliably load the app page in WebView2
 * dev mode (the new window ends up at about:blank).
 *
 * On macOS/Linux: delegates to the Rust create_window_at_position command.
 *
 * Returns the new window's label.
 */
export async function createWindowAtPosition(x: number, y: number): Promise<string> {
  if (!isWindows) {
    return invoke<string>('create_window_at_position', { x, y });
  }

  const label = `window-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const url = `${window.location.origin}${window.location.pathname}`;
  const width = 1000;
  const height = 700;

  await new Promise<void>((resolve, reject) => {
    const win = new WebviewWindow(label, {
      url,
      title: 'MeTerm',
      width,
      height,
      x: Math.max(0, x - width / 2),
      y: Math.max(0, y - 30),
      resizable: true,
      decorations: false,
      transparent: true,
      visible: false,
    });

    const timeout = setTimeout(() => {
      reject(new Error('Window creation timed out'));
    }, 10_000);

    void win.once('tauri://created', () => {
      clearTimeout(timeout);
      // Register grace period on Rust side so the window isn't auto-closed
      // before JS initializes (Windows frontend API path doesn't go through Rust commands).
      void invoke('track_window_created_ts', { windowLabel: label });
      // Delay show to allow WebView2 to initialize, preventing blank flash
      setTimeout(() => {
        void win.show().then(() => win.setFocus());
      }, 150);
      resolve();
    });
    void win.once('tauri://error', (event) => {
      clearTimeout(timeout);
      reject(new Error(`Failed to create window: ${String(event)}`));
    });
  });

  return label;
}
