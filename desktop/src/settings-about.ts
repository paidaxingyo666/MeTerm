import { t } from './i18n';
import { getVersion } from '@tauri-apps/api/app';
import { openUrl } from '@tauri-apps/plugin-opener';
import { checkUpdateNow } from './updater';

const GITHUB_URL = 'https://github.com/paidaxingyo666/MeTerm';

export function createAboutTab(): HTMLDivElement {
  const tab = document.createElement('div');
  tab.className = 'about-tab';

  // ── Hero section: logo + name + version ──
  const hero = document.createElement('div');
  hero.className = 'about-hero';

  const logoWrap = document.createElement('div');
  logoWrap.className = 'about-logo-wrap';
  logoWrap.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="64" height="64">
    <defs>
      <linearGradient id="about-bg" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" style="stop-color:#1a1a2e"/>
        <stop offset="100%" style="stop-color:#16213e"/>
      </linearGradient>
      <linearGradient id="about-accent" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" style="stop-color:#0f3460"/>
        <stop offset="100%" style="stop-color:#533483"/>
      </linearGradient>
      <linearGradient id="about-mGrad" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" style="stop-color:#58a6ff"/>
        <stop offset="50%" style="stop-color:#d2a8ff"/>
        <stop offset="100%" style="stop-color:#f78166"/>
      </linearGradient>
    </defs>
    <rect x="64" y="64" width="896" height="896" rx="180" ry="180" fill="url(#about-bg)"/>
    <rect x="128" y="180" width="768" height="560" rx="24" ry="24" fill="#0d1117" stroke="#30363d" stroke-width="8"/>
    <rect x="128" y="180" width="768" height="72" rx="24" ry="24" fill="#161b22"/>
    <rect x="128" y="228" width="768" height="24" fill="#161b22"/>
    <circle cx="200" cy="216" r="20" fill="#ff5f56"/>
    <circle cx="272" cy="216" r="20" fill="#ffbd2e"/>
    <circle cx="344" cy="216" r="20" fill="#27c93f"/>
    <path d="M240,690 L240,290 L512,575 L784,290 L784,690 L714,690 L714,395 L512,635 L310,395 L310,690 Z" fill="url(#about-mGrad)" opacity="0.9"/>
    <rect x="192" y="740" width="640" height="60" rx="12" fill="url(#about-accent)" opacity="0.6"/>
    <rect x="256" y="800" width="512" height="60" rx="12" fill="url(#about-accent)" opacity="0.4"/>
  </svg>`;
  hero.appendChild(logoWrap);

  const nameEl = document.createElement('div');
  nameEl.className = 'about-app-name';
  nameEl.textContent = 'MeTerm';
  hero.appendChild(nameEl);

  const versionEl = document.createElement('div');
  versionEl.className = 'about-app-version';
  versionEl.textContent = '...';
  hero.appendChild(versionEl);

  getVersion().then((v) => {
    versionEl.textContent = `v${v}`;
  }).catch(() => {});

  const descEl = document.createElement('div');
  descEl.className = 'about-app-desc';
  descEl.textContent = t('aboutDescription');
  hero.appendChild(descEl);

  tab.appendChild(hero);

  // ── Info list ──
  const infoList = document.createElement('div');
  infoList.className = 'about-info-list';

  const items: Array<{ label: string; value: string; action?: () => void }> = [
    {
      label: t('aboutGitHub'),
      value: 'paidaxingyo666/MeTerm',
      action: () => void openUrl(GITHUB_URL),
    },
    { label: t('aboutLicense'), value: 'MIT' },
    { label: t('aboutCopyright'), value: `© ${new Date().getFullYear()} MeTerm` },
  ];

  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'about-info-row';

    const label = document.createElement('span');
    label.className = 'about-info-label';
    label.textContent = item.label;

    const value = document.createElement('span');
    value.className = item.action ? 'about-info-value about-info-link' : 'about-info-value';
    value.textContent = item.value;
    if (item.action) {
      value.addEventListener('click', item.action);
    }

    row.appendChild(label);
    row.appendChild(value);
    infoList.appendChild(row);
  }

  tab.appendChild(infoList);

  // ── Check for updates button ──
  const updateBtn = document.createElement('button');
  updateBtn.className = 'about-update-btn';
  updateBtn.textContent = t('aboutCheckUpdate');
  updateBtn.addEventListener('click', () => {
    checkUpdateNow();
  });
  tab.appendChild(updateBtn);

  return tab;
}
