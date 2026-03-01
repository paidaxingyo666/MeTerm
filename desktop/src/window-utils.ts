import { invoke } from '@tauri-apps/api/core';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';

const isWindows = navigator.userAgent.toLowerCase().includes('windows');

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
      focus: true,
    });

    void win.once('tauri://created', () => {
      void win.show();
      void win.setFocus();
      resolve();
    });
    void win.once('tauri://error', (event) => {
      reject(new Error(`Failed to create window: ${String(event)}`));
    });
  });

  return label;
}
