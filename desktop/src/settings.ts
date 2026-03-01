import { THEMES, AppSettings, saveSettings, ColorScheme } from './themes';
import { escapeHtml } from './status-bar';
import { getAvailableLanguages, t, getLanguage, setLanguage, Translations } from './i18n';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { FONT_REGISTRY, getFontDef } from './fonts';
import { open, save, confirm } from '@tauri-apps/plugin-dialog';
import { writeTextFile, readTextFile } from '@tauri-apps/plugin-fs';
import { exportConnectionsToJSON, importConnectionsFromJSON } from './ssh';
import { PROVIDER_PRESETS, fetchModels, type ProviderType, type AIProviderEntry } from './ai-provider';
import { getPairingInfo } from './pairing';
import QRCode from 'qrcode';

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

  // ========== General Tab (merged: Appearance + Terminal + General) ==========
  const tabGeneral = tabContents['general'];

  // --- Language + Color Scheme (same row) ---
  const langColorRow = document.createElement('div');
  langColorRow.className = 'settings-row';

  const langSection = document.createElement('div');
  langSection.className = 'settings-section';
  langSection.innerHTML = `
    <label>${t('language')}</label>
    <select class="settings-select" id="lang-select">
      ${getAvailableLanguages().map((lang) =>
        `<option value="${lang.value}" ${lang.value === current.language ? 'selected' : ''}>${lang.label}</option>`
      ).join('')}
    </select>
  `;
  const langSelect = langSection.querySelector('#lang-select') as HTMLSelectElement;
  langSelect.onchange = () => {
    const language = langSelect.value as 'en' | 'zh';
    setLanguage(language);
    update({ language });
    onLanguageChange();
  };
  langColorRow.appendChild(langSection);

  const colorSchemeSection = document.createElement('div');
  colorSchemeSection.className = 'settings-section';
  colorSchemeSection.innerHTML = `
    <label>${t('colorScheme')}</label>
    <select class="settings-select" id="color-scheme-select">
      <option value="auto" ${current.colorScheme === 'auto' ? 'selected' : ''}>${t('colorSchemeAuto')}</option>
      <option value="dark" ${current.colorScheme === 'dark' ? 'selected' : ''}>${t('colorSchemeDark')}</option>
      <option value="darker" ${current.colorScheme === 'darker' ? 'selected' : ''}>${t('colorSchemeDarker')}</option>
      <option value="navy" ${current.colorScheme === 'navy' ? 'selected' : ''}>${t('colorSchemeNavy')}</option>
      <option value="light" ${current.colorScheme === 'light' ? 'selected' : ''}>${t('colorSchemeLight')}</option>
    </select>
  `;
  const colorSchemeSelect = colorSchemeSection.querySelector('#color-scheme-select') as HTMLSelectElement;
  colorSchemeSelect.onchange = () => {
    update({ colorScheme: colorSchemeSelect.value as ColorScheme });
  };
  langColorRow.appendChild(colorSchemeSection);
  tabGeneral.appendChild(langColorRow);

  // --- Terminal Theme ---
  const themeSection = document.createElement('div');
  themeSection.className = 'settings-section';
  themeSection.innerHTML = `
    <label>${t('theme')}</label>
    <select class="settings-select" id="theme-select">
      ${Object.entries(THEMES).map(([key, theme]) =>
        `<option value="${key}" ${key === current.theme ? 'selected' : ''}>${theme.name}</option>`
      ).join('')}
    </select>
  `;
  const themeSelect = themeSection.querySelector('#theme-select') as HTMLSelectElement;
  themeSelect.onchange = () => {
    update({ theme: themeSelect.value });
  };
  tabGeneral.appendChild(themeSection);

  // --- Background Image ---
  const bgImageSection = document.createElement('div');
  bgImageSection.className = 'settings-section';
  const bgFileName = current.backgroundImage ? current.backgroundImage.split(/[/\\]/).pop() || '' : '';
  bgImageSection.innerHTML = `
    <label>${t('backgroundImage')}</label>
    <div style="display:flex;gap:6px;align-items:center">
      <button class="settings-select" id="bg-image-select" style="flex:1;min-width:0;text-align:left;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${bgFileName || t('backgroundImageSelect')}</button>
      <button class="settings-select" id="bg-image-clear" style="width:auto;cursor:pointer">${t('backgroundImageClear')}</button>
    </div>
  `;
  const bgSelectBtn = bgImageSection.querySelector('#bg-image-select') as HTMLButtonElement;
  const bgClearBtn = bgImageSection.querySelector('#bg-image-clear') as HTMLButtonElement;
  bgSelectBtn.onclick = async () => {
    const file = await open({
      multiple: false,
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }],
    });
    if (file) {
      const sourcePath = typeof file === 'string' ? file : file;
      try {
        // Copy image to app internal directory, delete old one if exists
        const internalPath: string = await invoke('copy_background_image', {
          sourcePath: sourcePath as string,
          oldPath: current.backgroundImage || null,
        });
        bgSelectBtn.textContent = (sourcePath as string).split(/[/\\]/).pop() || t('backgroundImageSelect');
        current.backgroundImage = internalPath;
        update({ backgroundImage: internalPath });
      } catch (e) {
        console.error('Failed to copy background image:', e);
      }
    }
  };
  bgClearBtn.onclick = async () => {
    // Delete the stored background image file
    if (current.backgroundImage) {
      try {
        await invoke('delete_background_image', { path: current.backgroundImage });
      } catch (e) {
        console.error('Failed to delete background image:', e);
      }
    }
    bgSelectBtn.textContent = t('backgroundImageSelect');
    current.backgroundImage = '';
    update({ backgroundImage: '' });
  };
  tabGeneral.appendChild(bgImageSection);

  // --- Opacity ---
  const opacitySection = document.createElement('div');
  opacitySection.className = 'settings-section settings-inline';
  opacitySection.innerHTML = `
    <label>${t('opacity')}: <span id="opacity-value">${current.opacity}%</span></label>
    <input type="range" class="settings-slider" id="opacity-slider" min="20" max="100" value="${current.opacity}">
  `;
  const opacitySlider = opacitySection.querySelector('#opacity-slider') as HTMLInputElement;
  const opacityValue = opacitySection.querySelector('#opacity-value') as HTMLSpanElement;
  opacitySlider.oninput = () => {
    const opacity = parseInt(opacitySlider.value, 10);
    opacityValue.textContent = `${opacity}%`;
    update({ opacity });
  };
  tabGeneral.appendChild(opacitySection);

  // --- AI Bar Opacity ---
  const aiBarOpacitySection = document.createElement('div');
  aiBarOpacitySection.className = 'settings-section settings-inline';
  aiBarOpacitySection.innerHTML = `
    <label>${t('aiBarOpacity')}: <span id="ai-bar-opacity-value">${current.aiBarOpacity}%</span></label>
    <input type="range" class="settings-slider" id="ai-bar-opacity-slider" min="20" max="100" value="${current.aiBarOpacity}">
  `;
  const aiBarOpacitySlider = aiBarOpacitySection.querySelector('#ai-bar-opacity-slider') as HTMLInputElement;
  const aiBarOpacityValue = aiBarOpacitySection.querySelector('#ai-bar-opacity-value') as HTMLSpanElement;
  aiBarOpacitySlider.oninput = () => {
    const val = parseInt(aiBarOpacitySlider.value, 10);
    aiBarOpacityValue.textContent = `${val}%`;
    update({ aiBarOpacity: val });
  };
  tabGeneral.appendChild(aiBarOpacitySection);

  // --- Divider: Appearance ↔ Terminal ---
  const divider1 = document.createElement('hr');
  divider1.className = 'settings-divider';
  tabGeneral.appendChild(divider1);

  // --- Font Size ---
  const fontSection = document.createElement('div');
  fontSection.className = 'settings-section settings-inline';
  fontSection.innerHTML = `
    <label>${t('fontSize')}: <span id="font-value">${current.fontSize}px</span></label>
    <input type="range" class="settings-slider" id="font-slider" min="10" max="24" value="${current.fontSize}">
  `;
  const fontSlider = fontSection.querySelector('#font-slider') as HTMLInputElement;
  const fontValue = fontSection.querySelector('#font-value') as HTMLSpanElement;
  fontSlider.oninput = () => {
    const fontSize = parseInt(fontSlider.value, 10);
    fontValue.textContent = `${fontSize}px`;
    update({ fontSize });
  };
  tabGeneral.appendChild(fontSection);

  // --- Font Family ---
  const fontFamilySection = document.createElement('div');
  fontFamilySection.className = 'settings-section';
  fontFamilySection.innerHTML = `
    <label>${t('fontFamily')}</label>
    <select class="settings-select" id="font-family-select">
      ${FONT_REGISTRY.map((f) =>
        `<option value="${f.key}" ${f.key === current.fontFamily ? 'selected' : ''}>${f.displayName}</option>`
      ).join('')}
    </select>
  `;
  const fontFamilySelect = fontFamilySection.querySelector('#font-family-select') as HTMLSelectElement;
  fontFamilySelect.onchange = () => {
    current.fontFamily = fontFamilySelect.value;
    updateFontToggles();
    update({ fontFamily: fontFamilySelect.value });
  };
  tabGeneral.appendChild(fontFamilySection);

  // --- Font Options (Bold / Nerd Font / Ligatures) ---
  const fontOptsSection = document.createElement('div');
  fontOptsSection.className = 'settings-section';
  const fontOptsGroup = document.createElement('div');
  fontOptsGroup.className = 'settings-checkbox-group';
  fontOptsGroup.innerHTML = `
    <label><input type="checkbox" id="bold-font-toggle" ${current.enableBoldFont ? 'checked' : ''}> ${t('enableBoldFont')}</label>
    <label><input type="checkbox" id="nerd-font-toggle" ${current.enableNerdFont ? 'checked' : ''}> ${t('enableNerdFont')}</label>
    <label><input type="checkbox" id="ligatures-toggle" ${current.enableLigatures ? 'checked' : ''}> ${t('enableLigatures')}</label>
  `;
  fontOptsSection.appendChild(fontOptsGroup);
  const boldToggle = fontOptsGroup.querySelector('#bold-font-toggle') as HTMLInputElement;
  const nerdToggle = fontOptsGroup.querySelector('#nerd-font-toggle') as HTMLInputElement;
  const ligToggle = fontOptsGroup.querySelector('#ligatures-toggle') as HTMLInputElement;
  boldToggle.onchange = () => { update({ enableBoldFont: boldToggle.checked }); };
  nerdToggle.onchange = () => { update({ enableNerdFont: nerdToggle.checked }); };
  ligToggle.onchange = () => { update({ enableLigatures: ligToggle.checked }); };
  tabGeneral.appendChild(fontOptsSection);

  // --- Encoding ---
  const encodingSection = document.createElement('div');
  encodingSection.className = 'settings-section';
  encodingSection.innerHTML = `
    <label>${t('encoding')}</label>
    <select class="settings-select" id="encoding-select">
      <option value="utf-8" ${current.encoding === 'utf-8' ? 'selected' : ''}>UTF-8</option>
      <option value="gbk" ${current.encoding === 'gbk' ? 'selected' : ''}>GBK</option>
      <option value="gb18030" ${current.encoding === 'gb18030' ? 'selected' : ''}>GB18030</option>
      <option value="big5" ${current.encoding === 'big5' ? 'selected' : ''}>Big5</option>
      <option value="euc-jp" ${current.encoding === 'euc-jp' ? 'selected' : ''}>EUC-JP</option>
      <option value="euc-kr" ${current.encoding === 'euc-kr' ? 'selected' : ''}>EUC-KR</option>
      <option value="iso-8859-1" ${current.encoding === 'iso-8859-1' ? 'selected' : ''}>ISO-8859-1</option>
    </select>
  `;
  const encodingSelect = encodingSection.querySelector('#encoding-select') as HTMLSelectElement;
  encodingSelect.onchange = () => {
    update({ encoding: encodingSelect.value });
  };
  tabGeneral.appendChild(encodingSection);

  function updateFontToggles(): void {
    const def = getFontDef(current.fontFamily);
    nerdToggle.disabled = !def?.hasNerdFont;
    ligToggle.disabled = !def?.supportsLigatures;
    if (!def?.hasNerdFont && nerdToggle.checked) {
      nerdToggle.checked = false;
      update({ enableNerdFont: false });
    }
    if (!def?.supportsLigatures && ligToggle.checked) {
      ligToggle.checked = false;
      update({ enableLigatures: false });
    }
  }
  updateFontToggles();

  // --- Divider: Terminal ↔ Other ---
  const divider2 = document.createElement('hr');
  divider2.className = 'settings-divider';
  tabGeneral.appendChild(divider2);

  // --- File Manager Font Size ---
  const fileManagerFontSection = document.createElement('div');
  fileManagerFontSection.className = 'settings-section settings-inline';
  fileManagerFontSection.innerHTML = `
    <label>${t('fileManagerFontSize')}: <span id="fm-font-value">${current.fileManagerFontSize}px</span></label>
    <input type="range" class="settings-slider" id="fm-font-slider" min="10" max="18" value="${current.fileManagerFontSize}">
  `;
  const fmFontSlider = fileManagerFontSection.querySelector('#fm-font-slider') as HTMLInputElement;
  const fmFontValue = fileManagerFontSection.querySelector('#fm-font-value') as HTMLSpanElement;
  fmFontSlider.oninput = () => {
    const fileManagerFontSize = parseInt(fmFontSlider.value, 10);
    fmFontValue.textContent = `${fileManagerFontSize}px`;
    update({ fileManagerFontSize });
  };
  tabGeneral.appendChild(fileManagerFontSection);

  // --- Preview Refresh Rate ---
  const rateSection = document.createElement('div');
  rateSection.className = 'settings-section';
  rateSection.innerHTML = `
    <label>${t('previewRefreshRate')}</label>
    <select class="settings-select" id="rate-select">
      <option value="100" ${current.previewRefreshRate === 100 ? 'selected' : ''}>${getRateLabel(100, current.language)}</option>
      <option value="500" ${current.previewRefreshRate === 500 ? 'selected' : ''}>${getRateLabel(500, current.language)}</option>
      <option value="1000" ${current.previewRefreshRate === 1000 ? 'selected' : ''}>${getRateLabel(1000, current.language)}</option>
      <option value="2000" ${current.previewRefreshRate === 2000 ? 'selected' : ''}>${getRateLabel(2000, current.language)}</option>
      <option value="5000" ${current.previewRefreshRate === 5000 ? 'selected' : ''}>${getRateLabel(5000, current.language)}</option>
    </select>
  `;
  const rateSelect = rateSection.querySelector('#rate-select') as HTMLSelectElement;
  rateSelect.onchange = () => {
    const previewRefreshRate = parseInt(rateSelect.value, 10);
    update({ previewRefreshRate });
  };
  tabGeneral.appendChild(rateSection);

  // --- Remember Options ---
  const rememberSection = document.createElement('div');
  rememberSection.className = 'settings-section';
  const rememberGroup = document.createElement('div');
  rememberGroup.className = 'settings-checkbox-group';
  rememberGroup.innerHTML = `
    <label><input type="checkbox" id="remember-window-size" ${current.rememberWindowSize ? 'checked' : ''}> ${t('rememberWindowSize')}</label>
    <label><input type="checkbox" id="remember-drawer-layout" ${current.rememberDrawerLayout ? 'checked' : ''}> ${t('rememberDrawerLayout')}</label>
    <label><input type="checkbox" id="terminal-notifications-toggle" ${current.enableTerminalNotifications ? 'checked' : ''}> ${t('enableTerminalNotifications')}</label>
  `;
  rememberSection.appendChild(rememberGroup);
  const windowSizeCheckbox = rememberGroup.querySelector('#remember-window-size') as HTMLInputElement;
  const drawerLayoutCheckbox = rememberGroup.querySelector('#remember-drawer-layout') as HTMLInputElement;
  const termNotifToggle = rememberGroup.querySelector('#terminal-notifications-toggle') as HTMLInputElement;
  windowSizeCheckbox.onchange = () => { update({ rememberWindowSize: windowSizeCheckbox.checked }); };
  drawerLayoutCheckbox.onchange = () => { update({ rememberDrawerLayout: drawerLayoutCheckbox.checked }); };
  termNotifToggle.onchange = () => { update({ enableTerminalNotifications: termNotifToggle.checked }); };
  tabGeneral.appendChild(rememberSection);

  // SSH Connections import/export
  const sshIoSection = document.createElement('div');
  sshIoSection.className = 'settings-section';
  sshIoSection.innerHTML = `<label>${t('sshSavedConnections')}</label>`;

  const sshIoStatus = document.createElement('div');
  sshIoStatus.className = 'settings-ssh-io-status';

  const sshIoBtnRow = document.createElement('div');
  sshIoBtnRow.style.cssText = 'display:flex;gap:8px;margin-top:6px';

  const exportBtn = document.createElement('button');
  exportBtn.className = 'settings-select';
  exportBtn.style.cssText = 'cursor:pointer;flex:1';
  exportBtn.textContent = t('sshExportConnections');
  exportBtn.onclick = async () => {
    const result = await exportConnectionsToJSON();
    if (!result) {
      sshIoStatus.textContent = t('sshNoConnectionsToExport');
      sshIoStatus.className = 'settings-ssh-io-status ssh-status-error';
      return;
    }
    const filePath = await save({
      filters: [{ name: 'JSON', extensions: ['json'] }],
      defaultPath: 'meterm-connections.json',
    });
    if (filePath) {
      try {
        await writeTextFile(filePath, result.json);
        sshIoStatus.textContent = `${result.count} ${t('sshExportCount')}`;
        sshIoStatus.className = 'settings-ssh-io-status ssh-status-success';
      } catch (err) {
        sshIoStatus.textContent = String(err);
        sshIoStatus.className = 'settings-ssh-io-status ssh-status-error';
      }
    }
  };

  const importBtn = document.createElement('button');
  importBtn.className = 'settings-select';
  importBtn.style.cssText = 'cursor:pointer;flex:1';
  importBtn.textContent = t('sshImportConnections');
  importBtn.onclick = async () => {
    const filePath = await open({
      multiple: false,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (filePath) {
      try {
        const content = await readTextFile(filePath as string);
        const result = importConnectionsFromJSON(content);
        sshIoStatus.textContent = `${result.count} ${t('sshImportCount')}`;
        sshIoStatus.className = 'settings-ssh-io-status ssh-status-success';
        document.dispatchEvent(new CustomEvent('ssh-connections-changed'));
      } catch {
        sshIoStatus.textContent = t('sshImportInvalidFormat');
        sshIoStatus.className = 'settings-ssh-io-status ssh-status-error';
      }
    }
  };

  sshIoBtnRow.appendChild(exportBtn);
  sshIoBtnRow.appendChild(importBtn);
  sshIoSection.appendChild(sshIoBtnRow);
  sshIoSection.appendChild(sshIoStatus);
  tabGeneral.appendChild(sshIoSection);

  // ========== Tab 4: AI (Multi-Provider) ==========
  const tabAI = tabContents['ai'];

  // Provider cards container
  const providerList = document.createElement('div');
  providerList.className = 'ai-provider-list';
  tabAI.appendChild(providerList);

  function syncProviderInput(el: HTMLInputElement | HTMLSelectElement): void {
    el.addEventListener('keydown', (e) => e.stopPropagation());
    el.addEventListener('keyup', (e) => e.stopPropagation());
    el.addEventListener('keypress', (e) => e.stopPropagation());
  }

  function renderProviderCards(): void {
    providerList.innerHTML = '';
    const providers = current.aiProviders;

    for (let idx = 0; idx < providers.length; idx++) {
      const entry = providers[idx];
      const card = document.createElement('div');
      card.className = 'ai-provider-card';

      // Card header
      const header = document.createElement('div');
      header.className = 'ai-provider-card-header';

      const labelInput = document.createElement('input');
      labelInput.type = 'text';
      labelInput.className = 'ai-provider-label-input';
      labelInput.value = entry.label;
      syncProviderInput(labelInput);
      labelInput.onchange = () => {
        entry.label = labelInput.value.trim() || entry.label;
        update({ aiProviders: [...providers] });
      };

      const typeBadge = document.createElement('span');
      typeBadge.className = 'ai-provider-type-badge';
      typeBadge.textContent = entry.type === 'openai' ? 'OpenAI' : entry.type === 'anthropic' ? 'Anthropic' : 'Gemini';

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'ai-provider-delete-btn';
      deleteBtn.textContent = t('aiDeleteProvider');
      deleteBtn.onclick = () => {
        providers.splice(idx, 1);
        update({ aiProviders: [...providers] });
        renderProviderCards();
      };

      header.appendChild(labelInput);
      header.appendChild(typeBadge);
      if (providers.length > 1) header.appendChild(deleteBtn);

      // Card body
      const body = document.createElement('div');
      body.className = 'ai-provider-card-body';

      // Protocol selector
      const protoRow = document.createElement('div');
      protoRow.className = 'ai-provider-row';
      protoRow.innerHTML = `<label>${t('aiProviderProtocol')}</label>`;
      const protoSelect = document.createElement('select');
      protoSelect.className = 'settings-select';
      protoSelect.innerHTML = `
        <option value="openai" ${entry.type === 'openai' ? 'selected' : ''}>OpenAI Compatible</option>
        <option value="anthropic" ${entry.type === 'anthropic' ? 'selected' : ''}>Anthropic</option>
        <option value="gemini" ${entry.type === 'gemini' ? 'selected' : ''}>Google Gemini</option>
      `;
      protoSelect.onchange = () => {
        entry.type = protoSelect.value as ProviderType;
        entry.models = [];
        entry.enabledModels = [];
        update({ aiProviders: [...providers] });
        renderProviderCards();
      };
      protoRow.appendChild(protoSelect);
      body.appendChild(protoRow);

      // Base URL
      const urlRow = document.createElement('div');
      urlRow.className = 'ai-provider-row';
      urlRow.innerHTML = `<label>${t('aiBaseUrl')}</label>`;
      const urlInput = document.createElement('input');
      urlInput.type = 'text';
      urlInput.className = 'settings-input';
      urlInput.value = entry.baseUrl;
      urlInput.placeholder = 'https://api.openai.com';
      syncProviderInput(urlInput);
      urlInput.onchange = () => {
        entry.baseUrl = urlInput.value.trim();
        update({ aiProviders: [...providers] });
      };
      urlRow.appendChild(urlInput);
      body.appendChild(urlRow);

      // API Key
      const keyRow = document.createElement('div');
      keyRow.className = 'ai-provider-row';
      keyRow.innerHTML = `<label>${t('aiApiKey')}</label>`;
      const keyGroup = document.createElement('div');
      keyGroup.className = 'settings-input-group';
      const keyInput = document.createElement('input');
      keyInput.type = 'password';
      keyInput.className = 'settings-input';
      keyInput.style.flex = '1';
      keyInput.value = entry.apiKey;
      keyInput.placeholder = 'sk-...';
      syncProviderInput(keyInput);
      keyInput.onchange = () => {
        entry.apiKey = keyInput.value.trim();
        update({ aiProviders: [...providers] });
      };
      const keyToggle = document.createElement('button');
      keyToggle.className = 'settings-toggle-btn';
      keyToggle.title = 'Show/Hide';
      keyToggle.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z"/><circle cx="8" cy="8" r="2.5"/></svg>`;
      keyToggle.onclick = () => { keyInput.type = keyInput.type === 'password' ? 'text' : 'password'; };
      keyGroup.appendChild(keyInput);
      keyGroup.appendChild(keyToggle);
      keyRow.appendChild(keyGroup);
      body.appendChild(keyRow);

      // Fetch models button + status
      const fetchRow = document.createElement('div');
      fetchRow.className = 'ai-provider-row ai-provider-fetch-row';
      const fetchBtn = document.createElement('button');
      fetchBtn.className = 'settings-select settings-test-btn';
      fetchBtn.textContent = t('aiFetchModels');
      const fetchStatus = document.createElement('span');
      fetchStatus.className = 'settings-test-result';
      if (entry.models.length > 0) {
        fetchStatus.textContent = `${entry.models.length} ${t('aiModelsCount')}`;
        fetchStatus.className = 'settings-test-result test-success';
      }
      fetchBtn.onclick = async () => {
        // Sync input values before fetching
        entry.apiKey = keyInput.value.trim();
        entry.baseUrl = urlInput.value.trim();

        fetchBtn.disabled = true;
        fetchStatus.textContent = t('aiFetching');
        fetchStatus.className = 'settings-test-result';
        try {
          const models = await fetchModels(entry);
          entry.models = models;
          // Auto-enable previously enabled models that still exist
          entry.enabledModels = entry.enabledModels.filter((m) => models.includes(m));
          update({ aiProviders: [...providers] });
          fetchStatus.textContent = `${models.length} ${t('aiFetchSuccess')}`;
          fetchStatus.className = 'settings-test-result test-success';
          // Re-render to show model checkboxes
          renderModelCheckboxes();
        } catch (e) {
          fetchStatus.textContent = `${t('aiFetchFailed')}: ${(e as Error).message}`;
          fetchStatus.className = 'settings-test-result test-failed';
        }
        fetchBtn.disabled = false;
      };
      fetchRow.appendChild(fetchBtn);
      fetchRow.appendChild(fetchStatus);
      body.appendChild(fetchRow);

      // Model checkboxes
      const modelArea = document.createElement('div');
      modelArea.className = 'ai-provider-models';

      function renderModelCheckboxes(): void {
        modelArea.innerHTML = '';
        if (entry.models.length === 0) {
          const hint = document.createElement('div');
          hint.className = 'ai-provider-models-hint';
          hint.textContent = t('aiNoModels');
          modelArea.appendChild(hint);
          return;
        }

        const modelsLabel = document.createElement('label');
        modelsLabel.className = 'ai-provider-models-label';
        modelsLabel.textContent = t('aiSelectModels');
        modelArea.appendChild(modelsLabel);

        const grid = document.createElement('div');
        grid.className = 'ai-provider-models-grid';
        for (const model of entry.models) {
          const label = document.createElement('label');
          label.className = 'ai-model-checkbox';
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = entry.enabledModels.includes(model);
          cb.onchange = () => {
            if (cb.checked) {
              if (!entry.enabledModels.includes(model)) entry.enabledModels.push(model);
            } else {
              entry.enabledModels = entry.enabledModels.filter((m) => m !== model);
            }
            update({ aiProviders: [...providers] });
          };
          const span = document.createElement('span');
          span.textContent = model;
          span.title = model;
          label.appendChild(cb);
          label.appendChild(span);
          grid.appendChild(label);
        }
        modelArea.appendChild(grid);
      }
      renderModelCheckboxes();
      body.appendChild(modelArea);

      card.appendChild(header);
      card.appendChild(body);
      providerList.appendChild(card);
    }
  }

  renderProviderCards();

  // Add provider button
  const addProviderSection = document.createElement('div');
  addProviderSection.className = 'settings-section ai-add-provider-section';
  const addBtnContainer = document.createElement('div');
  addBtnContainer.className = 'settings-preset-buttons';

  // Presets for adding (only show ones not already added by default id)
  const addPresets = [...PROVIDER_PRESETS, { id: 'custom', label: t('aiCustomProvider'), type: 'openai' as ProviderType, baseUrl: '', model: '' }];
  for (const preset of addPresets) {
    const btn = document.createElement('button');
    btn.className = 'settings-preset-btn';
    btn.textContent = `+ ${preset.label}`;
    btn.addEventListener('click', () => {
      const newId = `${preset.id}-${Date.now().toString(36)}`;
      const newEntry: AIProviderEntry = {
        id: newId,
        type: preset.type,
        label: preset.label,
        apiKey: '',
        baseUrl: preset.baseUrl,
        models: [],
        enabledModels: [],
      };
      current.aiProviders.push(newEntry);
      update({ aiProviders: [...current.aiProviders] });
      renderProviderCards();
    });
    addBtnContainer.appendChild(btn);
  }
  addProviderSection.innerHTML = `<label>${t('aiAddProvider')}</label>`;
  addProviderSection.appendChild(addBtnContainer);
  tabAI.appendChild(addProviderSection);

  // ─── Common AI Settings (Temperature / MaxTokens / Context) ───
  // Temperature slider
  const tempSection = document.createElement('div');
  tempSection.className = 'settings-section';
  tempSection.innerHTML = `
    <label>${t('aiTemperature')}: <span id="ai-temp-value">${current.aiTemperature.toFixed(1)}</span></label>
    <input type="range" class="settings-slider" id="ai-temp-slider" min="0" max="20" value="${Math.round(current.aiTemperature * 10)}">
  `;
  tabAI.appendChild(tempSection);

  const aiTempSlider = tempSection.querySelector('#ai-temp-slider') as HTMLInputElement;
  const aiTempValue = tempSection.querySelector('#ai-temp-value') as HTMLSpanElement;
  aiTempSlider.oninput = () => {
    const val = parseInt(aiTempSlider.value, 10) / 10;
    aiTempValue.textContent = val.toFixed(1);
    update({ aiTemperature: val });
  };

  // Max Tokens slider
  const maxTokensSection = document.createElement('div');
  maxTokensSection.className = 'settings-section';
  maxTokensSection.innerHTML = `
    <label>${t('aiMaxTokens')}: <span id="ai-tokens-value">${current.aiMaxTokens}</span></label>
    <input type="range" class="settings-slider" id="ai-tokens-slider" min="256" max="16384" step="256" value="${current.aiMaxTokens}">
  `;
  tabAI.appendChild(maxTokensSection);

  const aiTokensSlider = maxTokensSection.querySelector('#ai-tokens-slider') as HTMLInputElement;
  const aiTokensValue = maxTokensSection.querySelector('#ai-tokens-value') as HTMLSpanElement;
  aiTokensSlider.oninput = () => {
    const val = parseInt(aiTokensSlider.value, 10);
    aiTokensValue.textContent = `${val}`;
    update({ aiMaxTokens: val });
  };

  // Context Lines slider
  const contextSection = document.createElement('div');
  contextSection.className = 'settings-section';
  contextSection.innerHTML = `
    <label>${t('aiContextLines')}: <span id="ai-context-value">${current.aiContextLines}</span></label>
    <input type="range" class="settings-slider" id="ai-context-slider" min="10" max="200" step="10" value="${current.aiContextLines}">
  `;
  tabAI.appendChild(contextSection);

  const aiContextSlider = contextSection.querySelector('#ai-context-slider') as HTMLInputElement;
  const aiContextValue = contextSection.querySelector('#ai-context-value') as HTMLSpanElement;
  aiContextSlider.oninput = () => {
    const val = parseInt(aiContextSlider.value, 10);
    aiContextValue.textContent = `${val}`;
    update({ aiContextLines: val });
  };

  // ========== Tab 5: Sharing ==========
  const tabSharing = tabContents['sharing'];

  const sharingSection = document.createElement('div');
  sharingSection.className = 'settings-section sharing-section';
  sharingSection.innerHTML = `
    <div class="sharing-loading">${t('connecting')}...</div>
  `;
  tabSharing.appendChild(sharingSection);

  // Load pairing data asynchronously
  getPairingInfo().then((data) => {
    sharingSection.innerHTML = '';

    // QR code
    const qrRow = document.createElement('div');
    qrRow.className = 'sharing-qr-row';
    const canvas = document.createElement('canvas');
    canvas.className = 'sharing-qr-canvas';
    QRCode.toCanvas(canvas, JSON.stringify(data), {
      width: 160,
      margin: 2,
      color: { dark: '#000000', light: '#ffffff' },
    }).catch(() => {});
    qrRow.appendChild(canvas);

    const infoCol = document.createElement('div');
    infoCol.className = 'sharing-info-col';
    infoCol.innerHTML = `
      <div class="sharing-info-item"><span class="sharing-label">${t('pairingDeviceName')}</span><span class="sharing-value">${escapeHtml(data.name)}</span></div>
      <div class="sharing-info-item"><span class="sharing-label">${t('pairingAddress')}</span><span class="sharing-value">${escapeHtml(data.addrs.join(', '))}</span></div>
    `;
    qrRow.appendChild(infoCol);
    sharingSection.appendChild(qrRow);

    // Buttons
    const btns = document.createElement('div');
    btns.className = 'sharing-buttons';

    const shareLinkBtn = document.createElement('button');
    shareLinkBtn.className = 'settings-btn settings-btn-primary';
    shareLinkBtn.textContent = t('shareLink');
    shareLinkBtn.onclick = async () => {
      const addr = data.addrs[0] || 'localhost';
      const port = addr.includes(':') ? addr.split(':')[1] : '8080';
      const host = addr.includes(':') ? addr.split(':')[0] : addr;
      const shareUrl = `http://${host}:${port}/`;
      try {
        await navigator.clipboard.writeText(shareUrl);
      } catch {
        const ta = document.createElement('textarea');
        ta.value = shareUrl;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      shareLinkBtn.textContent = t('shareLinkCopied');
      setTimeout(() => { shareLinkBtn.textContent = t('shareLink'); }, 2000);
    };
    btns.appendChild(shareLinkBtn);

    const copyDataBtn = document.createElement('button');
    copyDataBtn.className = 'settings-btn';
    copyDataBtn.textContent = t('pairingCopyData');
    copyDataBtn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(JSON.stringify(data));
      } catch {
        const ta = document.createElement('textarea');
        ta.value = JSON.stringify(data);
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      copyDataBtn.textContent = t('pairingCopied');
      setTimeout(() => { copyDataBtn.textContent = t('pairingCopyData'); }, 2000);
    };
    btns.appendChild(copyDataBtn);

    // Toggle button for data preview
    const svgDown = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const svgUp = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4 10l4-4 4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const toggleDataBtn = document.createElement('button');
    toggleDataBtn.className = 'settings-btn sharing-toggle-data-btn';
    toggleDataBtn.innerHTML = svgDown;
    toggleDataBtn.title = t('pairingCopyData');
    btns.appendChild(toggleDataBtn);
    sharingSection.appendChild(btns);

    // Data preview (collapsed by default)
    const dataPreview = document.createElement('div');
    dataPreview.className = 'sharing-data-preview';
    dataPreview.style.display = 'none';
    const code = document.createElement('code');
    code.textContent = JSON.stringify(data, null, 2);
    dataPreview.appendChild(code);
    sharingSection.appendChild(dataPreview);

    toggleDataBtn.onclick = () => {
      const visible = dataPreview.style.display !== 'none';
      dataPreview.style.display = visible ? 'none' : '';
      toggleDataBtn.innerHTML = visible ? svgDown : svgUp;
    };
  }).catch(() => {
    sharingSection.innerHTML = `<div class="sharing-error">${t('sshFailed')}</div>`;
  });

  // Discoverable toggle (mDNS)
  const discoverSection = document.createElement('div');
  discoverSection.className = 'settings-section settings-section-checkbox';
  const discoverLabel = document.createElement('label');
  const discoverToggle = document.createElement('input');
  discoverToggle.type = 'checkbox';
  discoverToggle.id = 'discoverable-toggle';
  // Restore from localStorage
  discoverToggle.checked = localStorage.getItem('meterm-discoverable') === '1';
  discoverLabel.appendChild(discoverToggle);
  discoverLabel.appendChild(document.createTextNode(` ${t('settingsDiscoverable')}`));
  discoverSection.appendChild(discoverLabel);
  tabSharing.appendChild(discoverSection);

  discoverToggle.onchange = async () => {
    const enabled = discoverToggle.checked;
    localStorage.setItem('meterm-discoverable', enabled ? '1' : '0');
    try {
      await invoke('toggle_lan_sharing', { enabled });
      // Sync tray menu checked state
      await invoke('set_discoverable_state', { checked: enabled });
    } catch (e) {
      console.error('toggle_lan_sharing failed:', e);
    }
  };

  // Listen for tray menu toggle to sync checkbox state
  void listen<{ enabled: boolean }>('menu-toggle-lan-discover', (event) => {
    discoverToggle.checked = event.payload.enabled;
  });

  // ── Token Management ─────────────────────────────────────
  const tokenSection = document.createElement('div');
  tokenSection.className = 'settings-section';
  tokenSection.innerHTML = `<div class="settings-section-title">${t('tokenManagement')}</div>`;

  // Current token display
  const tokenRow = document.createElement('div');
  tokenRow.className = 'sharing-token-row';
  const tokenLabel = document.createElement('span');
  tokenLabel.className = 'sharing-label';
  tokenLabel.textContent = t('currentToken');
  const tokenValue = document.createElement('span');
  tokenValue.className = 'sharing-token-value';
  let tokenRevealed = false;
  const maskedToken = '\u25CF\u25CF\u25CF\u25CF\u25CF\u25CF\u25CF\u25CF';
  tokenValue.textContent = maskedToken;
  const svgEyeOpen = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="8" cy="8" r="2" stroke="currentColor" stroke-width="1.5"/></svg>';
  const svgEyeClosed = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="8" cy="8" r="2" stroke="currentColor" stroke-width="1.5"/><line x1="2" y1="14" x2="14" y2="2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
  const tokenToggle = document.createElement('button');
  tokenToggle.className = 'settings-btn settings-btn-icon';
  tokenToggle.innerHTML = svgEyeClosed;
  tokenToggle.title = 'Show/Hide';
  tokenToggle.onclick = async () => {
    if (tokenRevealed) {
      tokenValue.textContent = maskedToken;
      tokenRevealed = false;
      tokenToggle.innerHTML = svgEyeClosed;
    } else {
      try {
        const info = await invoke<{ port: number; token: string }>('get_meterm_connection_info');
        tokenValue.textContent = info.token;
        tokenRevealed = true;
        tokenToggle.innerHTML = svgEyeOpen;
      } catch { /* ignore */ }
    }
  };

  // Refresh token button (inline after eye toggle)
  const refreshBtn = document.createElement('button');
  refreshBtn.className = 'settings-btn settings-btn-small';
  refreshBtn.textContent = t('refreshToken');
  refreshBtn.onclick = async () => {
    try {
      const raw = await invoke<string>('refresh_token');
      const data = JSON.parse(raw);
      if (data.token && tokenRevealed) {
        tokenValue.textContent = data.token;
      }
      refreshBtn.textContent = t('tokenRefreshed');
      setTimeout(() => { refreshBtn.textContent = t('refreshToken'); }, 2000);
    } catch (e) {
      console.error('refresh_token failed:', e);
    }
  };

  tokenRow.appendChild(tokenLabel);
  tokenRow.appendChild(tokenValue);
  tokenRow.appendChild(tokenToggle);
  tokenRow.appendChild(refreshBtn);
  tokenSection.appendChild(tokenRow);

  // Custom token input
  const customRow = document.createElement('div');
  customRow.className = 'sharing-custom-token-row';
  const customInput = document.createElement('input');
  customInput.type = 'text';
  customInput.className = 'settings-input';
  customInput.placeholder = t('customTokenPlaceholder');
  const customBtn = document.createElement('button');
  customBtn.className = 'settings-btn';
  customBtn.textContent = t('setToken');
  customBtn.onclick = async () => {
    const val = customInput.value.trim();
    if (val.length < 8) {
      customInput.style.borderColor = 'var(--danger)';
      customInput.placeholder = t('customTokenTooShort');
      setTimeout(() => {
        customInput.style.borderColor = '';
        customInput.placeholder = t('customTokenPlaceholder');
      }, 2000);
      return;
    }
    try {
      await invoke('set_custom_token', { token: val });
      customInput.value = '';
      if (tokenRevealed) tokenValue.textContent = val;
      const origText = customBtn.textContent;
      customBtn.textContent = t('tokenSetSuccess');
      setTimeout(() => { customBtn.textContent = origText; }, 2000);
    } catch (e) {
      console.error('set_custom_token failed:', e);
    }
  };
  customRow.appendChild(customInput);
  customRow.appendChild(customBtn);
  tokenSection.appendChild(customRow);

  tabSharing.appendChild(tokenSection);

  // ── Connected Devices ────────────────────────────────────
  const devicesSection = document.createElement('div');
  devicesSection.className = 'settings-section';

  // Header row: title + refresh button + revoke all button
  const devicesTitleRow = document.createElement('div');
  devicesTitleRow.className = 'devices-title-row';

  const devicesTitleEl = document.createElement('span');
  devicesTitleEl.className = 'settings-section-title';
  devicesTitleEl.style.marginBottom = '0';
  devicesTitleEl.textContent = t('connectedDevices');

  const refreshDevicesBtn = document.createElement('button');
  refreshDevicesBtn.className = 'devices-refresh-btn';
  refreshDevicesBtn.type = 'button';
  refreshDevicesBtn.title = t('remoteSessionRefresh');
  refreshDevicesBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/></svg>';
  refreshDevicesBtn.onclick = () => { void loadDevices(); };

  const revokeBtn = document.createElement('button');
  revokeBtn.className = 'devices-revoke-btn';
  revokeBtn.textContent = t('revokeAllClients');
  revokeBtn.style.display = 'none';
  revokeBtn.onclick = async () => {
    const confirmed = await confirm(t('confirmRevokeAll'), {
      title: t('revokeAllClients'),
      kind: 'warning',
      okLabel: t('revokeAllClients'),
      cancelLabel: t('hideToTrayTipCancel'),
    });
    if (!confirmed) return;
    try {
      const raw = await invoke<string>('revoke_all_clients');
      const data = JSON.parse(raw);
      revokeBtn.textContent = `${t('revokeSuccess')} (${data.disconnected || 0})`;
      if (data.new_token && tokenRevealed) {
        tokenValue.textContent = data.new_token;
      }
      setTimeout(() => { loadDevices(); loadBans(); }, 800);
    } catch (e) {
      console.error('revoke_all_clients failed:', e);
    }
  };

  devicesTitleRow.appendChild(devicesTitleEl);
  devicesTitleRow.appendChild(refreshDevicesBtn);
  devicesTitleRow.appendChild(revokeBtn);
  devicesSection.appendChild(devicesTitleRow);

  const devicesTable = document.createElement('div');
  devicesTable.className = 'sharing-devices-table';
  devicesTable.innerHTML = `<div class="sharing-empty">${t('noConnectedDevices')}</div>`;
  devicesSection.appendChild(devicesTable);
  tabSharing.appendChild(devicesSection);

  // Load connected devices (IP-aggregated cards)
  const loadDevices = async () => {
    try {
      const raw = await invoke<string>('list_devices');
      const { devices } = JSON.parse(raw);
      if (!devices || devices.length === 0) {
        devicesTable.innerHTML = `<div class="sharing-empty">${t('noConnectedDevices')}</div>`;
        revokeBtn.style.display = 'none';
      } else {
        devicesTable.innerHTML = '';
        revokeBtn.style.display = '';
        for (const device of devices) {
          const card = document.createElement('div');
          card.className = 'device-card';

          const header = document.createElement('div');
          header.className = 'device-card-header';

          const infoArea = document.createElement('div');
          infoArea.className = 'device-card-info';

          const ipEl = document.createElement('span');
          ipEl.className = 'device-card-ip';
          ipEl.textContent = device.name ? `${device.name} (${device.ip})` : device.ip;

          const countEl = document.createElement('span');
          countEl.className = 'device-card-count';
          countEl.textContent = device.count > 0
            ? `${device.count} ${t('deviceCardSessions')}`
            : t('devicePairedIdle');

          infoArea.appendChild(ipEl);
          infoArea.appendChild(countEl);

          const actionsArea = document.createElement('div');
          actionsArea.className = 'device-card-actions';

          if (device.count > 0) {
            const toggleBtn = document.createElement('button');
            toggleBtn.className = 'device-card-toggle';
            toggleBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';
            toggleBtn.title = 'Expand/Collapse';
            actionsArea.appendChild(toggleBtn);

            const body = document.createElement('div');
            body.className = 'device-card-body collapsed';
            for (const session of (device.sessions || [])) {
              const sessionTitle = session.session_title || session.session_id.substring(0, 8);
              const row = document.createElement('div');
              row.className = 'device-session-row';
              row.innerHTML = `
                <span class="device-session-title" title="${escapeHtml(sessionTitle)}">${escapeHtml(sessionTitle)}</span>
                <span class="device-session-role">${escapeHtml(session.role)}</span>
                <button class="device-session-kick" data-sid="${escapeHtml(session.session_id)}" data-cid="${escapeHtml(session.id)}">&times;</button>
              `;
              body.appendChild(row);
            }

            toggleBtn.onclick = (e) => {
              e.stopPropagation();
              body.classList.toggle('collapsed');
              toggleBtn.classList.toggle('expanded');
            };

            card.appendChild(header);
            card.appendChild(body);

            // Bind kick buttons for individual sessions
            body.querySelectorAll('.device-session-kick').forEach(btn => {
              btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const confirmed = await confirm(t('confirmKickClient'), {
                  title: t('kickClient'),
                  kind: 'warning',
                  okLabel: t('kickClient'),
                  cancelLabel: t('hideToTrayTipCancel'),
                });
                if (!confirmed) return;
                const sid = (btn as HTMLElement).dataset.sid!;
                const cid = (btn as HTMLElement).dataset.cid!;
                try {
                  await invoke('kick_client', { sessionId: sid, clientId: cid });
                  const shouldLock = await confirm(t('confirmLockAfterKick'), {
                    title: t('tabMenuLockSession'),
                    kind: 'info',
                    okLabel: t('tabMenuLockSession'),
                    cancelLabel: t('banIpSkip'),
                  });
                  if (shouldLock) {
                    try {
                      await invoke('set_session_private', { sessionId: sid, private: true });
                    } catch (e2) {
                      console.error('set_session_private failed:', e2);
                    }
                  }
                  setTimeout(() => { loadDevices(); loadBans(); }, 800);
                } catch (err) {
                  console.error('kick_client failed:', err);
                }
              });
            });
          } else {
            card.appendChild(header);
          }

          const kickDevBtn = document.createElement('button');
          kickDevBtn.className = 'device-card-kick-btn';
          kickDevBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18"/><path d="M6 6l12 12"/></svg>';
          kickDevBtn.title = t('banDevice');
          kickDevBtn.onclick = async (e) => {
            e.stopPropagation();
            const confirmed = await confirm(t('banDeviceConfirm'), {
              title: t('banDevice'),
              kind: 'warning',
              okLabel: t('banDevice'),
              cancelLabel: t('hideToTrayTipCancel'),
            });
            if (!confirmed) return;
            try {
              await invoke('kick_device', { ip: device.ip, ban: true });
              setTimeout(() => { loadDevices(); loadBans(); }, 500);
            } catch (err) {
              console.error('kick_device failed:', err);
            }
          };
          actionsArea.appendChild(kickDevBtn);

          header.appendChild(infoArea);
          header.appendChild(actionsArea);

          devicesTable.appendChild(card);
        }
      }
    } catch { /* ignore */ }
  };

  // ── IP Ban List ──────────────────────────────────────────
  const banSection = document.createElement('div');
  banSection.className = 'settings-section';
  banSection.innerHTML = `<div class="settings-section-title">${t('ipBanList')}</div>`;
  const banTable = document.createElement('div');
  banTable.className = 'sharing-ban-table';
  banTable.innerHTML = `<div class="sharing-empty">${t('noBannedIps')}</div>`;
  banSection.appendChild(banTable);
  tabSharing.appendChild(banSection);

  const loadBans = async () => {
    try {
      const raw = await invoke<string>('list_banned_ips');
      const { banned_ips } = JSON.parse(raw);
      if (!banned_ips || banned_ips.length === 0) {
        banTable.innerHTML = `<div class="sharing-empty">${t('noBannedIps')}</div>`;
      } else {
        banTable.innerHTML = banned_ips.map((b: any) => `
          <div class="sharing-ban-row">
            <span class="sharing-ban-ip">${escapeHtml(b.ip)}</span>
            <span class="sharing-ban-time">${escapeHtml(new Date(b.banned_at).toLocaleString())}</span>
            <button class="settings-btn settings-btn-small" data-ip="${escapeHtml(b.ip)}">${t('unbanIp')}</button>
          </div>
        `).join('');
        banTable.querySelectorAll('button[data-ip]').forEach(btn => {
          btn.addEventListener('click', async () => {
            const ip = (btn as HTMLElement).dataset.ip!;
            try {
              await invoke('unban_ip', { ip });
              loadBans();
            } catch (e) {
              console.error('unban_ip failed:', e);
            }
          });
        });
      }
    } catch { /* ignore */ }
  };

  // Auto-refresh when entering sharing tab
  tabSharing.addEventListener('tab-activated', () => {
    loadDevices();
    loadBans();
  });
  // Initial load (will run after panel visible)
  setTimeout(() => { loadDevices(); loadBans(); }, 500);

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
