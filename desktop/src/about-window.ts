/**
 * about-window.ts — Standalone About window renderer.
 * Loaded when URL contains ?window=about.
 */
import { openUrl } from '@tauri-apps/plugin-opener';
import { getVersion } from '@tauri-apps/api/app';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { loadSettings, resolveIsDark } from './themes';
import { initLanguage, setLanguage, t } from './i18n';

const GITHUB_URL = 'https://github.com/paidaxingyo666/MeTerm';

function resolveThemeAttr(colorScheme: string): string {
  if (colorScheme === 'light') return 'light';
  if (colorScheme === 'darker') return 'darker';
  if (colorScheme === 'navy') return 'navy';
  if (colorScheme === 'auto') return resolveIsDark('auto') ? 'dark' : 'light';
  return 'dark';
}

export function initAboutWindow(): void {
  initLanguage();
  const settings = loadSettings();
  setLanguage(settings.language);
  document.documentElement.setAttribute('data-theme', resolveThemeAttr(settings.colorScheme));

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
    <a class="about-link" href="#">GitHub</a>
  `;
  document.body.appendChild(container);

  container.querySelector('.about-link')!.addEventListener('click', (e) => {
    e.preventDefault();
    void openUrl(GITHUB_URL);
  });

  getVersion().then((version) => {
    const versionEl = container.querySelector('.about-version');
    if (versionEl) versionEl.textContent = `v${version}`;
  }).catch(() => {});

  // Show window after first paint (created with visible: false to prevent flash)
  requestAnimationFrame(() => {
    void getCurrentWindow().show().then(() => getCurrentWindow().setFocus());
  });
}
