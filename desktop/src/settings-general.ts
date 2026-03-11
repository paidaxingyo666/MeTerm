import { THEMES, AppSettings, ColorScheme } from './themes';
import { getAvailableLanguages, t, setLanguage } from './i18n';
import { invoke } from '@tauri-apps/api/core';
import { FONT_REGISTRY, getFontDef } from './fonts';
import { open, save } from '@tauri-apps/plugin-dialog';
import { writeTextFile, readTextFile } from '@tauri-apps/plugin-fs';
import { exportConnectionsToJSON, importConnectionsFromJSON } from './ssh';

export function createGeneralTab(
  current: AppSettings,
  update: (patch: Partial<AppSettings>) => void,
  onLanguageChange: () => void,
  getRateLabel: (rate: number, lang: 'en' | 'zh') => string,
): HTMLDivElement {
  const tabGeneral = document.createElement('div');

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

  // --- Divider: Appearance / Terminal ---
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

  // --- Default Shell ---
  const shellSection = document.createElement('div');
  shellSection.className = 'settings-section';
  shellSection.innerHTML = `
    <label>${t('defaultShellSetting')}</label>
    <select class="settings-select" id="default-shell-select">
      <option value="">${t('systemDefault')}</option>
    </select>
  `;
  const shellSelect = shellSection.querySelector('#default-shell-select') as HTMLSelectElement;
  tabGeneral.appendChild(shellSection);

  // Populate shell list asynchronously
  void invoke<{ path: string; name: string; is_default: boolean }[]>('list_available_shells').then((shells) => {
    for (const shell of shells) {
      const opt = document.createElement('option');
      opt.value = shell.path;
      opt.textContent = shell.is_default ? `${shell.name} (${t('defaultShell')})` : shell.name;
      if (current.defaultShell === shell.path) opt.selected = true;
      shellSelect.appendChild(opt);
    }
    // If current defaultShell doesn't match any option, keep "System Default" selected
    if (current.defaultShell && !shells.some((s) => s.path === current.defaultShell)) {
      shellSelect.value = '';
    }
  }).catch(() => { /* shells unavailable */ });

  shellSelect.onchange = () => {
    update({ defaultShell: shellSelect.value });
  };

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

  // --- Divider: Terminal / Other ---
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
    <label><input type="checkbox" id="file-link-confirm-toggle" ${!current.fileLinkSkipConfirm ? 'checked' : ''}> ${t('fileLinkSkipConfirmSetting')}</label>
  `;
  rememberSection.appendChild(rememberGroup);
  const windowSizeCheckbox = rememberGroup.querySelector('#remember-window-size') as HTMLInputElement;
  const drawerLayoutCheckbox = rememberGroup.querySelector('#remember-drawer-layout') as HTMLInputElement;
  const termNotifToggle = rememberGroup.querySelector('#terminal-notifications-toggle') as HTMLInputElement;
  const fileLinkConfirmToggle = rememberGroup.querySelector('#file-link-confirm-toggle') as HTMLInputElement;
  windowSizeCheckbox.onchange = () => { update({ rememberWindowSize: windowSizeCheckbox.checked }); };
  drawerLayoutCheckbox.onchange = () => { update({ rememberDrawerLayout: drawerLayoutCheckbox.checked }); };
  termNotifToggle.onchange = () => { update({ enableTerminalNotifications: termNotifToggle.checked }); };
  fileLinkConfirmToggle.onchange = () => { update({ fileLinkSkipConfirm: !fileLinkConfirmToggle.checked }); };
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

  return tabGeneral;
}
