/**
 * file-editor-init.ts — Synchronous editor window shell setup.
 * Creates tab bar with drag layer (matching main window toolbar pattern).
 * MUST be statically imported for drag region to register during initial page load.
 */
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import { revealAfterPaint } from './window-utils';
import { readText as clipboardReadText } from '@tauri-apps/plugin-clipboard-manager';
import { loadSettings, resolveIsDark } from './themes';
import { initLanguage, setLanguage } from './i18n';
import { applyVibrancy } from './appearance';
import appIconUrl from '../src-tauri/icons/icon.svg';

const ua = navigator.userAgent.toLowerCase();
const isWindowsPlatform = ua.includes('windows');

function resolveThemeAttr(colorScheme: string): string {
  if (colorScheme === 'darker') return 'darker';
  if (colorScheme === 'navy') return 'navy';
  if (colorScheme === 'light') return 'light';
  if (colorScheme === 'auto') return resolveIsDark('auto') ? 'dark' : 'light';
  return 'dark';
}

// Windows icon SVGs (same as main window toolbar)
const WIN_ICON_MINIMIZE = '<svg width="10" height="1" viewBox="0 0 10 1"><path d="M0 0h10" stroke="currentColor" stroke-width="1"/></svg>';
const WIN_ICON_MAXIMIZE = '<svg width="10" height="10" viewBox="0 0 10 10"><rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1"/></svg>';
const WIN_ICON_CLOSE = '<svg width="10" height="10" viewBox="0 0 10 10"><path d="M1 1l8 8M9 1l-8 8" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';

export function initEditorWindowShell(): void {
  initLanguage();
  const settings = loadSettings();
  setLanguage(settings.language);
  document.documentElement.dataset.theme = resolveThemeAttr(settings.colorScheme);
  void applyVibrancy(settings.enableVibrancy);
  document.documentElement.classList.toggle('platform-windows', isWindowsPlatform);

  // Hide main app UI
  const app = document.getElementById('app');
  if (app) app.style.display = 'none';

  document.body.classList.add('editor-window-mode');

  // Tab bar — same pattern as #window-toolbar in index.html
  const tabBar = document.createElement('div');
  tabBar.id = 'editor-tab-bar';
  tabBar.className = 'editor-tab-bar';

  // Drag layer — uses .editor-tab-bar-drag from toolbar.css (statically loaded)
  const dragLayer = document.createElement('div');
  dragLayer.className = 'editor-tab-bar-drag';
  dragLayer.setAttribute('data-tauri-drag-region', '');
  tabBar.appendChild(dragLayer);

  // Windows: also add pointerdown → startDragging() on drag layer
  if (isWindowsPlatform) {
    dragLayer.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      void getCurrentWindow().startDragging();
    });
  }

  // Windows: app icon (left side, before tabs)
  if (isWindowsPlatform) {
    const appIconBtn = document.createElement('button');
    appIconBtn.className = 'toolbar-app-icon-btn';
    appIconBtn.type = 'button';
    appIconBtn.innerHTML = `<img class="toolbar-app-icon-img" src="${appIconUrl}" alt="MeTerm" />`;
    tabBar.appendChild(appIconBtn);
  }

  // Tabs container (populated async by file-editor.ts)
  const tabsArea = document.createElement('div');
  tabsArea.id = 'editor-tabs-area';
  tabsArea.className = 'editor-tabs-area';
  tabBar.appendChild(tabsArea);

  // Windows: add window control buttons (minimize, maximize, close)
  if (isWindowsPlatform) {
    const controlsArea = document.createElement('div');
    controlsArea.className = 'editor-win-controls';

    const minBtn = document.createElement('button');
    minBtn.className = 'win-control-btn win-minimize-btn';
    minBtn.type = 'button';
    minBtn.innerHTML = WIN_ICON_MINIMIZE;
    minBtn.onclick = () => { void getCurrentWindow().minimize(); };
    controlsArea.appendChild(minBtn);

    const maxBtn = document.createElement('button');
    maxBtn.className = 'win-control-btn win-maximize-btn';
    maxBtn.type = 'button';
    maxBtn.innerHTML = WIN_ICON_MAXIMIZE;
    maxBtn.onclick = async () => {
      const isMax = await getCurrentWindow().isMaximized();
      if (isMax) void getCurrentWindow().unmaximize();
      else void getCurrentWindow().maximize();
    };
    controlsArea.appendChild(maxBtn);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'win-control-btn win-close-btn';
    closeBtn.type = 'button';
    closeBtn.innerHTML = WIN_ICON_CLOSE;
    closeBtn.onclick = () => { void getCurrentWindow().close(); };
    controlsArea.appendChild(closeBtn);

    tabBar.appendChild(controlsArea);
  }

  document.body.appendChild(tabBar);

  // macOS native menu accelerators (Cmd+C/V/X/A) — copied from settings-window.ts
  const win = getCurrentWindow();
  const windowLabel = win.label;
  const isForThis = (p: { target_window: string }) => p.target_window === windowLabel;
  void listen<{ target_window: string }>('menu-undo', (e) => { if (isForThis(e.payload)) document.execCommand('undo'); });
  void listen<{ target_window: string }>('menu-redo', (e) => { if (isForThis(e.payload)) document.execCommand('redo'); });
  void listen<{ target_window: string }>('menu-cut', (e) => { if (isForThis(e.payload)) document.execCommand('cut'); });
  void listen<{ target_window: string }>('menu-copy', (e) => { if (isForThis(e.payload)) document.execCommand('copy'); });
  void listen<{ target_window: string }>('menu-paste', (e) => {
    if (!isForThis(e.payload)) return;
    void clipboardReadText().then((text) => {
      if (!text) return;
      // For CodeMirror: dispatch keyboard paste event so CM handles it natively
      const focused = document.activeElement;
      if (focused) {
        const dt = new DataTransfer();
        dt.setData('text/plain', text);
        focused.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      }
    });
  });
  void listen<{ target_window: string }>('menu-select-all', (e) => {
    if (!isForThis(e.payload)) return;
    document.execCommand('selectAll');
  });

  // Persist window size on resize (debounced, logical pixels)
  let resizeTimer: ReturnType<typeof setTimeout>;
  void win.onResized(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      void win.innerSize().then(physSize => {
        return win.scaleFactor().then(scale => {
          localStorage.setItem('meterm-editor-window-size', JSON.stringify({
            width: Math.round(physSize.width / scale),
            height: Math.round(physSize.height / scale),
          }));
        });
      });
    }, 500);
  });

  void revealAfterPaint(win.label);
}
