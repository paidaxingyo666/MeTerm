import { AppSettings, saveSettings } from './themes';
import { t } from './i18n';
import { createGeneralTab } from './settings-general';
import { createAITab } from './settings-ai';
import { createSharingTab } from './settings-sharing';
import { createAboutTab } from './settings-about';

export interface SettingsPanelOptions {
  settings: AppSettings;
  isWindow?: boolean;
  initialTab?: string;
  onSettingsChange: (settings: AppSettings) => void;
  onLanguageChange: () => void;
  onClose: () => void;
}

function getRateLabel(rate: number, lang: 'en' | 'zh'): string {
  const labels: Record<string, Record<number, string>> = {
    en: {
      100: '100ms (Fastest)',
      500: '500ms (Fast)',
      1000: '1s (Normal)',
      2000: '2s (Slow)',
      5000: '5s (Slowest)',
    },
    zh: {
      100: '100毫秒 (最快)',
      500: '500毫秒 (快)',
      1000: '1秒 (正常)',
      2000: '2秒 (慢)',
      5000: '5秒 (最慢)',
    },
  };
  return labels[lang][rate] || labels[lang][1000];
}

export function createSettingsPanel(options: SettingsPanelOptions): HTMLDivElement {
  const { isWindow, onSettingsChange, onLanguageChange, onClose } = options;
  let current = { ...options.settings };

  function update(patch: Partial<AppSettings>): void {
    current = { ...current, ...patch };
    saveSettings(current);
    onSettingsChange(current);
  }

  const panel = document.createElement('div');
  panel.className = isWindow ? 'settings-panel settings-panel-window' : 'settings-panel';

  if (!isWindow) {
    const header = document.createElement('div');
    header.className = 'settings-header';
    header.innerHTML = `
      <h3>${t('settings')}</h3>
      <button class="settings-close">&times;</button>
    `;
    header.querySelector<HTMLButtonElement>('.settings-close')!.onclick = onClose;
    panel.appendChild(header);
  }

  // --- Tab navigation ---
  const tabDefs = [
    { key: 'general', label: t('settingsTabGeneral') },
    { key: 'ai', label: t('settingsTabAI') },
    { key: 'sharing', label: t('settingsTabSharing') },
    { key: 'about', label: t('settingsTabAbout') },
  ];

  const tabBar = document.createElement('div');
  tabBar.className = 'settings-tabs';

  const tabContents: Record<string, HTMLDivElement> = {};
  const tabButtons: HTMLButtonElement[] = [];

  for (const def of tabDefs) {
    const btn = document.createElement('button');
    btn.className = 'settings-tab';
    btn.textContent = def.label;
    btn.dataset.tab = def.key;
    tabBar.appendChild(btn);
    tabButtons.push(btn);

    const content = document.createElement('div');
    content.className = 'settings-tab-content';
    content.dataset.tab = def.key;
    tabContents[def.key] = content;
  }

  function activateTab(key: string): void {
    tabButtons.forEach((b) => b.classList.toggle('active', b.dataset.tab === key));
    Object.entries(tabContents).forEach(([k, el]) => {
      el.classList.toggle('active', k === key);
      if (k === key) el.dispatchEvent(new Event('tab-activated'));
    });
  }

  tabBar.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('.settings-tab') as HTMLButtonElement | null;
    if (btn?.dataset.tab) activateTab(btn.dataset.tab);
  });

  panel.appendChild(tabBar);

  // Wrapper for all tab contents
  const contentWrapper = document.createElement('div');
  contentWrapper.className = 'settings-content';

  // ========== General Tab ==========
  const generalContent = createGeneralTab(current, update, onLanguageChange, getRateLabel);
  const tabGeneral = tabContents['general'];
  tabGeneral.appendChild(generalContent);

  // ========== AI Tab ==========
  const aiContent = createAITab(current, update);
  const tabAI = tabContents['ai'];
  tabAI.appendChild(aiContent);

  // ========== Sharing Tab ==========
  const sharingContent = createSharingTab();
  const tabSharing = tabContents['sharing'];
  tabSharing.appendChild(sharingContent);

  // ========== About Tab ==========
  const aboutContent = createAboutTab();
  const tabAbout = tabContents['about'];
  tabAbout.appendChild(aboutContent);

  // Assemble: tab contents into wrapper
  for (const def of tabDefs) {
    contentWrapper.appendChild(tabContents[def.key]);
  }
  panel.appendChild(contentWrapper);

  // Activate initial tab
  const startTab = options.initialTab && tabContents[options.initialTab] ? options.initialTab : 'general';
  activateTab(startTab);

  return panel;
}
