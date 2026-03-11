import { loadSettings, AppSettings, resolveIsDark, getEffectiveTheme, saveSettings } from './themes';
import { createSettingsPanel } from './settings';
import { initLanguage, setLanguage, t } from './i18n';
import { emit, listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { readText as clipboardReadText } from '@tauri-apps/plugin-clipboard-manager';

const ua = navigator.userAgent.toLowerCase();
const isWindowsPlatform = ua.includes('windows');

function resolveThemeAttr(colorScheme: string): string {
  if (colorScheme === 'darker') return 'darker';
  if (colorScheme === 'navy') return 'navy';
  if (colorScheme === 'light') return 'light';
  if (colorScheme === 'auto') return resolveIsDark('auto') ? 'dark' : 'light';
  return 'dark';
}

function applyTheme(settings: AppSettings): void {
  document.documentElement.dataset.theme = resolveThemeAttr(settings.colorScheme);
}

function createCustomTitleBar(): HTMLElement {
  const titleBar = document.createElement('div');
  titleBar.className = 'settings-titlebar';

  // Drag region
  const dragRegion = document.createElement('div');
  dragRegion.className = 'settings-titlebar-drag';
  dragRegion.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    void getCurrentWindow().startDragging();
  });

  // Title text
  const title = document.createElement('span');
  title.className = 'settings-titlebar-title';
  title.textContent = t('settings');

  dragRegion.appendChild(title);
  titleBar.appendChild(dragRegion);

  // Close button
  const closeBtn = document.createElement('button');
  closeBtn.className = 'settings-titlebar-close';
  closeBtn.type = 'button';
  closeBtn.innerHTML = '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M1 1 9 9M9 1 1 9" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';
  closeBtn.onclick = () => { void getCurrentWindow().close(); };
  titleBar.appendChild(closeBtn);

  return titleBar;
}

export function initSettingsWindow(): void {
  initLanguage();
  let settings = loadSettings();
  setLanguage(settings.language);
  applyTheme(settings);

  // Settings window is opaque
  document.documentElement.style.setProperty('--app-window-opacity', '1');

  // Platform class for CSS
  document.documentElement.classList.toggle('platform-windows', isWindowsPlatform);

  // Hide main app UI
  const app = document.getElementById('app');
  if (app) app.style.display = 'none';

  // Create settings container
  document.body.classList.add('settings-window-mode');

  // On Windows: add custom title bar (no native decorations)
  // On macOS: add drag region for overlay title bar
  if (isWindowsPlatform) {
    document.body.appendChild(createCustomTitleBar());
  } else {
    const dragRegion = document.createElement('div');
    dragRegion.className = 'overlay-drag-region';
    dragRegion.setAttribute('data-tauri-drag-region', '');
    document.body.appendChild(dragRegion);
  }

  const container = document.createElement('div');
  container.id = 'settings-window-container';
  document.body.appendChild(container);

  const urlTab = new URLSearchParams(window.location.search).get('tab') || undefined;

  function renderPanel(): void {
    container.innerHTML = '';
    const panel = createSettingsPanel({
      settings,
      isWindow: true,
      initialTab: urlTab,
      onSettingsChange: (newSettings) => {
        settings = newSettings;
        applyTheme(settings);

        const effectiveTheme = getEffectiveTheme(settings);
        if (effectiveTheme !== settings.theme) {
          settings.theme = effectiveTheme;
          saveSettings(settings);
        }

        // Update native window title bar theme
        const nativeTheme = resolveThemeAttr(settings.colorScheme) === 'light' ? 'light' as const : 'dark' as const;
        void getCurrentWindow().setTheme(nativeTheme);

        void emit('settings-changed');
      },
      onLanguageChange: () => {
        void emit('settings-changed');
        renderPanel();
      },
      onClose: () => {
        void getCurrentWindow().close();
      },
    });
    container.appendChild(panel);
  }

  renderPanel();

  // Show window after first paint (created with visible: false to prevent flash)
  requestAnimationFrame(() => {
    void getCurrentWindow().show().then(() => getCurrentWindow().setFocus());
  });

  // macOS native menu accelerators emit Tauri events instead of performing
  // native actions. Wire them to document.execCommand so Cmd+C/V/X/A work
  // in the settings window's standard input fields.
  const windowLabel = getCurrentWindow().label;
  const isForThis = (p: { target_window: string }) => p.target_window === windowLabel;
  void listen<{ target_window: string }>('menu-undo', (e) => { if (isForThis(e.payload)) document.execCommand('undo'); });
  void listen<{ target_window: string }>('menu-redo', (e) => { if (isForThis(e.payload)) document.execCommand('redo'); });
  void listen<{ target_window: string }>('menu-cut', (e) => { if (isForThis(e.payload)) document.execCommand('cut'); });
  void listen<{ target_window: string }>('menu-copy', (e) => { if (isForThis(e.payload)) document.execCommand('copy'); });
  void listen<{ target_window: string }>('menu-paste', (e) => {
    if (!isForThis(e.payload)) return;
    // document.execCommand('paste') is blocked in WKWebView — use clipboard API +
    // insertText so the change goes through the browser's undo stack.
    void clipboardReadText().then((text) => {
      if (!text) return;
      const el = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
        el.focus();
        // insertText goes through the undo stack (unlike setting .value directly)
        if (!document.execCommand('insertText', false, text)) {
          // Fallback if insertText is unsupported
          const s = el.selectionStart ?? el.value.length;
          const end = el.selectionEnd ?? el.value.length;
          el.value = el.value.slice(0, s) + text + el.value.slice(end);
          el.selectionStart = el.selectionEnd = s + text.length;
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }
    });
  });
  void listen<{ target_window: string }>('menu-select-all', (e) => {
    if (!isForThis(e.payload)) return;
    const el = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
      el.select();
    } else {
      document.execCommand('selectAll');
    }
  });
}
