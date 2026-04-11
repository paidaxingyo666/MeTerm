/**
 * about-window.ts — Standalone About window renderer.
 * Loaded when URL contains ?window=about.
 */
import { openUrl } from '@tauri-apps/plugin-opener';
import { revealAfterPaint } from './window-utils';
import { getVersion } from '@tauri-apps/api/app';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import { loadSettings, resolveIsDark } from './themes';
import { initLanguage, setLanguage, t } from './i18n';
import { applyVibrancy } from './appearance';
import { applyNbPalette } from './nb-palette';

const GITHUB_URL = 'https://github.com/paidaxingyo666/MeTerm';
const GITEE_URL = 'https://gitee.com/paidaxingy666/me-term';

function resolveThemeAttr(colorScheme: string): string {
  if (colorScheme === 'light') return 'light';
  if (colorScheme === 'darker') return 'darker';
  if (colorScheme === 'navy') return 'navy';
  if (colorScheme === 'neo-brutalism') return 'neo-brutalism';
  if (colorScheme === 'neo-brutalism-rounded') return 'neo-brutalism-rounded';
  if (colorScheme === 'auto') return resolveIsDark('auto') ? 'dark' : 'light';
  return 'dark';
}

export function initAboutWindow(): void {
  initLanguage();
  const settings = loadSettings();
  setLanguage(settings.language);
  document.documentElement.setAttribute('data-theme', resolveThemeAttr(settings.colorScheme));
  applyNbPalette(settings.colorScheme);

  void applyVibrancy(settings.enableVibrancy);

  // Hide main app UI
  const app = document.getElementById('app');
  if (app) app.style.display = 'none';

  // Render immediately (version filled async)
  const container = document.createElement('div');
  container.className = 'about-container';
  container.setAttribute('data-tauri-drag-region', '');
  container.innerHTML = `
    <div class="about-title">MeTerm</div>
    <div class="about-version"></div>
    <div class="about-body">${t('aboutDialogBody')}</div>
    <div class="about-links">
      <a class="about-link" href="#" data-url="${GITHUB_URL}">GitHub</a>
      <span class="about-link-sep">·</span>
      <a class="about-link" href="#" data-url="${GITEE_URL}">Gitee</a>
      <span class="about-link-sep">·</span>
      <a class="about-link" href="#" data-url="${GITHUB_URL}/blob/main/THIRD_PARTY_LICENSES.md">${t('aboutLicenses')}</a>
    </div>
  `;
  document.body.appendChild(container);

  container.querySelectorAll('.about-link').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const url = (link as HTMLElement).dataset.url;
      if (url) void openUrl(url);
    });
  });

  getVersion().then((version) => {
    const versionEl = container.querySelector('.about-version');
    if (versionEl) versionEl.textContent = `v${version}`;
  }).catch(() => {});

  // Listen for theme changes from main window
  void listen('settings-changed', () => {
    const s = loadSettings();
    document.documentElement.setAttribute('data-theme', resolveThemeAttr(s.colorScheme));
    applyNbPalette(s.colorScheme);
    const nativeTheme = resolveThemeAttr(s.colorScheme) === 'light' ? 'light' as const : 'dark' as const;
    void getCurrentWindow().setTheme(nativeTheme);
    void applyVibrancy(s.enableVibrancy);
  });

  void revealAfterPaint(getCurrentWindow().label);
}
