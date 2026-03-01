import './style.css';
import { loadSettings, AppSettings, resolveIsDark, getEffectiveTheme, saveSettings } from './themes';
import { createSettingsPanel } from './settings';
import { initLanguage, setLanguage, t } from './i18n';
import { emit } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';

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

  // Hide main app UI elements
  const app = document.getElementById('app');
  if (app) app.style.display = 'none';

  // Create settings container
  document.body.classList.add('settings-window-mode');

  // On Windows: add custom title bar (no native decorations)
  if (isWindowsPlatform) {
    document.body.appendChild(createCustomTitleBar());
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
}
