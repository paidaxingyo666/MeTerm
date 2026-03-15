import { THEMES, AppSettings, ColorScheme } from './themes';
import { getAvailableLanguages, t, setLanguage } from './i18n';
import { invoke } from '@tauri-apps/api/core';
import { FONT_REGISTRY, getFontDef } from './fonts';
import { open, save } from '@tauri-apps/plugin-dialog';
import { writeTextFile, readTextFile } from '@tauri-apps/plugin-fs';
import { exportConnectionsToJSON, importConnectionsFromJSON } from './ssh';
import { createSettingsSelect } from './custom-select';

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
  langSection.innerHTML = `<label>${t('language')}</label>`;
  const langSelect = createSettingsSelect(
    getAvailableLanguages().map((lang) => ({ value: lang.value, label: lang.label, selected: lang.value === current.language })),
  );
  langSection.appendChild(langSelect.el);
  langSelect.onchange = () => {
    const language = langSelect.value as 'en' | 'zh';
    setLanguage(language);
    update({ language });
    onLanguageChange();
  };
  langColorRow.appendChild(langSection);

  const colorSchemeSection = document.createElement('div');
  colorSchemeSection.className = 'settings-section';
  colorSchemeSection.innerHTML = `<label>${t('colorScheme')}</label>`;
  const colorSchemeSelect = createSettingsSelect([
    { value: 'auto', label: t('colorSchemeAuto'), selected: current.colorScheme === 'auto' },
    { value: 'dark', label: t('colorSchemeDark'), selected: current.colorScheme === 'dark' },
    { value: 'darker', label: t('colorSchemeDarker'), selected: current.colorScheme === 'darker' },
    { value: 'navy', label: t('colorSchemeNavy'), selected: current.colorScheme === 'navy' },
    { value: 'light', label: t('colorSchemeLight'), selected: current.colorScheme === 'light' },
  ]);
  colorSchemeSection.appendChild(colorSchemeSelect.el);
  colorSchemeSelect.onchange = () => {
    update({ colorScheme: colorSchemeSelect.value as ColorScheme });
  };
  langColorRow.appendChild(colorSchemeSection);
  tabGeneral.appendChild(langColorRow);

  // --- Terminal Theme ---
  const themeSection = document.createElement('div');
  themeSection.className = 'settings-section';
  themeSection.innerHTML = `<label>${t('theme')}</label>`;
  const themeSelect = createSettingsSelect(
    Object.entries(THEMES).map(([key, theme]) => ({ value: key, label: theme.name, selected: key === current.theme })),
  );
  themeSection.appendChild(themeSelect.el);
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
    <div class="settings-btn-row">
      <button class="settings-select" id="bg-image-select" style="text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${bgFileName || t('backgroundImageSelect')}</button>
      <button class="settings-select" id="bg-image-clear" style="width:auto;flex:none">${t('backgroundImageClear')}</button>
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

  // --- Vibrancy (Background Blur) Toggle ---
  const vibrancySection = document.createElement('div');
  vibrancySection.className = 'settings-section settings-inline';
  vibrancySection.innerHTML = `
    <label>${t('enableVibrancy')}</label>
    <label class="settings-toggle">
      <input type="checkbox" id="vibrancy-toggle" ${current.enableVibrancy ? 'checked' : ''}>
      <span class="settings-toggle-slider"></span>
    </label>
  `;
  const vibrancyToggle = vibrancySection.querySelector('#vibrancy-toggle') as HTMLInputElement;
  vibrancyToggle.onchange = () => {
    update({ enableVibrancy: vibrancyToggle.checked });
  };
  tabGeneral.appendChild(vibrancySection);

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
  fontFamilySection.innerHTML = `<label>${t('fontFamily')}</label>`;
  const fontFamilySelect = createSettingsSelect(
    FONT_REGISTRY.map((f) => ({ value: f.key, label: f.displayName, selected: f.key === current.fontFamily })),
  );
  fontFamilySection.appendChild(fontFamilySelect.el);
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
  encodingSection.innerHTML = `<label>${t('encoding')}</label>`;
  const encodingSelect = createSettingsSelect([
    { value: 'utf-8', label: 'UTF-8', selected: current.encoding === 'utf-8' },
    { value: 'gbk', label: 'GBK', selected: current.encoding === 'gbk' },
    { value: 'gb18030', label: 'GB18030', selected: current.encoding === 'gb18030' },
    { value: 'big5', label: 'Big5', selected: current.encoding === 'big5' },
    { value: 'euc-jp', label: 'EUC-JP', selected: current.encoding === 'euc-jp' },
    { value: 'euc-kr', label: 'EUC-KR', selected: current.encoding === 'euc-kr' },
    { value: 'iso-8859-1', label: 'ISO-8859-1', selected: current.encoding === 'iso-8859-1' },
  ]);
  encodingSection.appendChild(encodingSelect.el);
  encodingSelect.onchange = () => {
    update({ encoding: encodingSelect.value });
  };
  tabGeneral.appendChild(encodingSection);

  // --- Default Shell ---
  const shellSection = document.createElement('div');
  shellSection.className = 'settings-section';
  shellSection.innerHTML = `<label>${t('defaultShellSetting')}</label>`;
  const shellSelect = createSettingsSelect([
    { value: '', label: t('systemDefault'), selected: !current.defaultShell },
  ]);
  shellSection.appendChild(shellSelect.el);
  tabGeneral.appendChild(shellSection);

  // Populate shell list asynchronously
  void invoke<{ path: string; name: string; is_default: boolean }[]>('list_available_shells').then((shells) => {
    for (const shell of shells) {
      const label = shell.is_default ? `${shell.name} (${t('defaultShell')})` : shell.name;
      shellSelect.addOption(shell.path, label, current.defaultShell === shell.path);
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

  // --- Context Menu Integration ---
  const ctxMenuSection = document.createElement('div');
  ctxMenuSection.className = 'settings-section settings-inline';
  ctxMenuSection.innerHTML = `
    <label>${t('contextMenuIntegration')}</label>
    <label class="settings-toggle">
      <input type="checkbox" id="context-menu-toggle">
      <span class="settings-toggle-slider"></span>
    </label>
  `;
  const ctxMenuToggle = ctxMenuSection.querySelector('#context-menu-toggle') as HTMLInputElement;

  // Check initial state
  invoke<boolean>('is_context_menu_registered').then((registered) => {
    ctxMenuToggle.checked = registered;
  }).catch(() => { /* ignore */ });

  ctxMenuToggle.onchange = async () => {
    try {
      if (ctxMenuToggle.checked) {
        await invoke('register_context_menu');
      } else {
        await invoke('unregister_context_menu');
      }
    } catch (err) {
      console.error('Context menu toggle failed:', err);
      ctxMenuToggle.checked = !ctxMenuToggle.checked; // revert on failure
    }
  };
  tabGeneral.appendChild(ctxMenuSection);

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
  rateSection.innerHTML = `<label>${t('previewRefreshRate')}</label>`;
  const rateSelect = createSettingsSelect([
    { value: '100', label: getRateLabel(100, current.language), selected: current.previewRefreshRate === 100 },
    { value: '500', label: getRateLabel(500, current.language), selected: current.previewRefreshRate === 500 },
    { value: '1000', label: getRateLabel(1000, current.language), selected: current.previewRefreshRate === 1000 },
    { value: '2000', label: getRateLabel(2000, current.language), selected: current.previewRefreshRate === 2000 },
    { value: '5000', label: getRateLabel(5000, current.language), selected: current.previewRefreshRate === 5000 },
  ]);
  rateSection.appendChild(rateSelect.el);
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

  // --- PiP Scale ---
  const pipScaleSection = document.createElement('div');
  pipScaleSection.className = 'settings-section settings-inline';
  pipScaleSection.innerHTML = `
    <label>${t('pipScale')}: <span id="pip-scale-value">${current.pipScale}%</span></label>
    <input type="range" class="settings-slider" id="pip-scale-slider" min="10" max="50" value="${current.pipScale}">
  `;
  const pipScaleSlider = pipScaleSection.querySelector('#pip-scale-slider') as HTMLInputElement;
  const pipScaleValue = pipScaleSection.querySelector('#pip-scale-value') as HTMLSpanElement;
  pipScaleSlider.oninput = () => {
    const val = parseInt(pipScaleSlider.value, 10);
    pipScaleValue.textContent = `${val}%`;
    update({ pipScale: val });
  };
  tabGeneral.appendChild(pipScaleSection);

  // SSH Connections import/export
  const sshIoSection = document.createElement('div');
  sshIoSection.className = 'settings-section';
  sshIoSection.innerHTML = `<label>${t('sshSavedConnections')}</label>`;

  const sshIoStatus = document.createElement('div');
  sshIoStatus.className = 'settings-ssh-io-status';

  const sshIoBtnRow = document.createElement('div');
  sshIoBtnRow.className = 'settings-btn-row';

  const exportBtn = document.createElement('button');
  exportBtn.className = 'settings-select';
  exportBtn.style.cursor = 'pointer';
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
  importBtn.style.cursor = 'pointer';
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
