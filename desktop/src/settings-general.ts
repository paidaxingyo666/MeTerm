import { THEMES, AppSettings, ColorScheme } from './themes';
import { getAvailableLanguages, t, setLanguage } from './i18n';
import { invoke } from '@tauri-apps/api/core';
import { FONT_REGISTRY, getFontDef, getAvailableCJKFonts } from './fonts';
import { isMacPlatform } from './app-state';
import { open, save } from '@tauri-apps/plugin-dialog';
import { writeTextFile, readTextFile } from '@tauri-apps/plugin-fs';
import { exportConnectionsToJSON, importConnectionsFromJSON } from './ssh';
import { createSettingsSelect } from './custom-select';
// emit removed — palette now syncs through update() → saveSettings → settings-changed

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
    { value: 'neo-brutalism', label: t('colorSchemeNeoBrutalism'), selected: current.colorScheme === 'neo-brutalism' },
    { value: 'neo-brutalism-rounded', label: t('colorSchemeNeoBrutalismRounded'), selected: current.colorScheme === 'neo-brutalism-rounded' },
  ]);
  colorSchemeSection.appendChild(colorSchemeSelect.el);
  langColorRow.appendChild(colorSchemeSection);
  tabGeneral.appendChild(langColorRow);

  // --- Neo-Brutalism Palette (visible only when NB theme is active) ---
  const isNB = (s: string) => s === 'neo-brutalism' || s === 'neo-brutalism-rounded';
  const nbSection = document.createElement('div');
  nbSection.className = 'settings-section';
  nbSection.style.display = isNB(current.colorScheme) ? '' : 'none';
  nbSection.innerHTML = `<label>${t('nbPaletteTitle')}</label>`;

  /** Convert hex (#RRGGBB) to "R, G, B" string for rgb() CSS vars */
  const hexToRgbStr = (hex: string): string => {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `${r}, ${g}, ${b}`;
  };

  // Some tokens map to the project's native RGB-triplet CSS variables
  // (--bg-primary, --text-primary, etc.) which use "R, G, B" format.
  // Others map directly to --nb-* hex variables.
  interface NbToken {
    key: string;               // localStorage key
    label: string;
    def: string;               // default hex
    cssVar: string;            // the CSS variable to set
    isRgb?: boolean;           // true = set as "R, G, B"; false = set as hex
    extraVars?: string[];      // additional CSS vars to set with same value
  }

  const NB_TOKENS: NbToken[] = [
    { key: '--nb-bg',      label: t('nbBg'),     def: '#FFFEF0', cssVar: '--bg-primary', isRgb: true,
      extraVars: ['--bg-toolbar', '--bg-status', '--bg-settings', '--bg-card', '--bg-input', '--bg-tab', '--bg-context-menu'] },
    { key: '--nb-text',    label: t('nbText'),    def: '#1A1A2E', cssVar: '--text-primary', isRgb: false,
      extraVars: ['--text-heading', '--text-secondary', '--text-button', '--text-card-title', '--text-muted'] },
    { key: '--nb-border',  label: t('nbBorder'),  def: '#000000', cssVar: '--nb-border', isRgb: false,
      extraVars: ['--border-primary', '--border-subtle', '--border-toolbar'] },
    { key: '--nb-shadow',  label: t('nbShadow'),  def: '#000000', cssVar: '--nb-shadow', isRgb: false },
    { key: '--nb-accent',  label: t('nbAccent'),  def: '#E94560', cssVar: '--nb-accent', isRgb: false,
      extraVars: ['--accent', '--accent-primary'] },
    { key: '--nb-highlight',    label: t('nbHighlight'),  def: '#FFD93D', cssVar: '--nb-highlight', isRgb: false },
    { key: '--nb-success',      label: t('nbSuccess'),    def: '#06D6A0', cssVar: '--nb-success', isRgb: false },
    { key: '--nb-info',         label: t('nbInfo'),       def: '#4ECDC4', cssVar: '--nb-info', isRgb: false },
    { key: '--nb-danger-light', label: t('nbDanger'),     def: '#FFB3B3', cssVar: '--nb-danger-light', isRgb: false },
    { key: '--nb-surface-alt',  label: t('nbSurfaceAlt'), def: '#F0F0E0', cssVar: '--nb-surface-alt', isRgb: false },
  ];

  const applyNbColor = (tk: NbToken, hex: string) => {
    const val = tk.isRgb ? hexToRgbStr(hex) : hex;
    document.documentElement.style.setProperty(tk.cssVar, val);
    if (tk.extraVars) {
      for (const ev of tk.extraVars) {
        document.documentElement.style.setProperty(ev, tk.isRgb ? hexToRgbStr(hex) : hex);
      }
    }
    // --nb-bg drives --nb-card-bg, but cards should be slightly lighter
    // than the main background so they stand out. Use surface-alt if
    // available; otherwise use the bg itself.
    if (tk.key === '--nb-bg') {
      const surfAlt = saved['--nb-surface-alt'];
      document.documentElement.style.setProperty('--nb-card-bg', surfAlt || hex);
    }
    if (tk.key === '--nb-surface-alt') {
      document.documentElement.style.setProperty('--nb-card-bg', hex);
    }
  };

  // Read from AppSettings (shared across windows via saveSettings/loadSettings)
  const saved: Record<string, string> = { ...(current.nbCustomColors || {}) };
  const grid = document.createElement('div');
  grid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:6px 12px;margin-top:6px;';
  for (const tk of NB_TOKENS) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:6px;';
    const inp = document.createElement('input');
    inp.type = 'color';
    inp.value = saved[tk.key] || tk.def;
    inp.style.cssText = 'width:28px;height:22px;padding:0;border:2px solid #000;cursor:pointer;';
    if (isNB(current.colorScheme) && saved[tk.key]) applyNbColor(tk, saved[tk.key]);
    inp.addEventListener('input', () => {
      applyNbColor(tk, inp.value);
      saved[tk.key] = inp.value;
      // Save via the settings system (triggers settings-changed → main window syncs)
      update({ nbCustomColors: { ...saved } });
    });
    const lbl = document.createElement('span');
    lbl.style.fontSize = '11px';
    lbl.textContent = tk.label;
    row.append(inp, lbl);
    grid.appendChild(row);
  }
  const resetBtn = document.createElement('button');
  resetBtn.textContent = t('nbReset');
  resetBtn.style.cssText = 'margin-top:8px;font-size:11px;padding:2px 8px;cursor:pointer;';
  /** Apply a full preset palette: update all inputs + save + emit */
  const applyPreset = (preset: Record<string, string>) => {
    for (const tk of NB_TOKENS) {
      const hex = preset[tk.key] || tk.def;
      applyNbColor(tk, hex);
      saved[tk.key] = hex;
    }
    grid.querySelectorAll('input[type="color"]').forEach((el, i) => {
      (el as HTMLInputElement).value = saved[NB_TOKENS[i].key] || NB_TOKENS[i].def;
    });
    update({ nbCustomColors: { ...saved } });
  };

  resetBtn.addEventListener('click', () => {
    for (const tk of NB_TOKENS) {
      document.documentElement.style.removeProperty(tk.cssVar);
      if (tk.extraVars) tk.extraVars.forEach(v => document.documentElement.style.removeProperty(v));
      delete saved[tk.key];
    }
    document.documentElement.style.removeProperty('--nb-card-bg');
    grid.querySelectorAll('input[type="color"]').forEach((el, i) => {
      (el as HTMLInputElement).value = NB_TOKENS[i].def;
    });
    update({ nbCustomColors: undefined });
  });

  // ── Preset palettes ──
  const PRESETS: Array<{ name: string; colors: Record<string, string> }> = [
    { name: t('nbPresetSunset'),   colors: { '--nb-bg': '#FFF5E6', '--nb-text': '#2D1B00', '--nb-border': '#5C3D1A', '--nb-shadow': '#5C3D1A', '--nb-accent': '#FF6B35', '--nb-highlight': '#FFB347', '--nb-success': '#7CB518', '--nb-info': '#3EAFC0', '--nb-danger-light': '#FFCCCB', '--nb-surface-alt': '#FFE8CC' } },
    { name: t('nbPresetOcean'),    colors: { '--nb-bg': '#F0F8FF', '--nb-text': '#0A1628', '--nb-border': '#1A3A5C', '--nb-shadow': '#1A3A5C', '--nb-accent': '#0077B6', '--nb-highlight': '#90E0EF', '--nb-success': '#06D6A0', '--nb-info': '#00B4D8', '--nb-danger-light': '#FFCCD5', '--nb-surface-alt': '#CAF0F8' } },
    { name: t('nbPresetSakura'),   colors: { '--nb-bg': '#FFF5F5', '--nb-text': '#2D0A1B', '--nb-border': '#8B2252', '--nb-shadow': '#8B2252', '--nb-accent': '#FF69B4', '--nb-highlight': '#FFB7D5', '--nb-success': '#98D8AA', '--nb-info': '#B19CD9', '--nb-danger-light': '#FFD6E0', '--nb-surface-alt': '#FFE4EE' } },
    { name: t('nbPresetForest'),   colors: { '--nb-bg': '#F5FFF5', '--nb-text': '#1A2E1A', '--nb-border': '#2D5A27', '--nb-shadow': '#2D5A27', '--nb-accent': '#4CAF50', '--nb-highlight': '#A5D6A7', '--nb-success': '#66BB6A', '--nb-info': '#81C784', '--nb-danger-light': '#FFCDD2', '--nb-surface-alt': '#E8F5E9' } },
    { name: t('nbPresetMocha'),    colors: { '--nb-bg': '#FAF3E8', '--nb-text': '#3E2723', '--nb-border': '#5D4037', '--nb-shadow': '#5D4037', '--nb-accent': '#D84315', '--nb-highlight': '#FFCC80', '--nb-success': '#81C784', '--nb-info': '#80DEEA', '--nb-danger-light': '#FFCCBC', '--nb-surface-alt': '#EFEBE9' } },
    { name: t('nbPresetLavender'), colors: { '--nb-bg': '#F5F0FF', '--nb-text': '#1A102E', '--nb-border': '#5B3A8C', '--nb-shadow': '#5B3A8C', '--nb-accent': '#7C4DFF', '--nb-highlight': '#CE93D8', '--nb-success': '#81C784', '--nb-info': '#80CBC4', '--nb-danger-light': '#F3D5F7', '--nb-surface-alt': '#EDE7F6' } },
    { name: t('nbPresetMidnight'), colors: { '--nb-bg': '#0A0A0A', '--nb-text': '#F0F0F0', '--nb-border': '#FFD700', '--nb-shadow': '#B8960C', '--nb-accent': '#FFD700', '--nb-highlight': '#3A3A00', '--nb-success': '#2E7D32', '--nb-info': '#0277BD', '--nb-danger-light': '#4A1C1C', '--nb-surface-alt': '#1C1C1C' } },
    { name: t('nbPresetCyber'),    colors: { '--nb-bg': '#0D0221', '--nb-text': '#E0D0FF', '--nb-border': '#FF2E97', '--nb-shadow': '#A01060', '--nb-accent': '#FF2E97', '--nb-highlight': '#2A0A30', '--nb-success': '#0FFF95', '--nb-info': '#00D4FF', '--nb-danger-light': '#3A0020', '--nb-surface-alt': '#1A0A30' } },
    { name: t('nbPresetAbyss'),    colors: { '--nb-bg': '#050A18', '--nb-text': '#D0E8FF', '--nb-border': '#0099FF', '--nb-shadow': '#005599', '--nb-accent': '#0099FF', '--nb-highlight': '#0A1A30', '--nb-success': '#00CC88', '--nb-info': '#00BBEE', '--nb-danger-light': '#1A0A20', '--nb-surface-alt': '#0E1628' } },
    { name: t('nbPresetCandy'),    colors: { '--nb-bg': '#FFF0F5', '--nb-text': '#1A0010', '--nb-border': '#FF1493', '--nb-shadow': '#FF1493', '--nb-accent': '#FF1493', '--nb-highlight': '#FFB6C1', '--nb-success': '#FF69B4', '--nb-info': '#DDA0DD', '--nb-danger-light': '#FFE0EB', '--nb-surface-alt': '#FFE4F0' } },
    { name: t('nbPresetRetro'),    colors: { '--nb-bg': '#FFFFCC', '--nb-text': '#222200', '--nb-border': '#CC6600', '--nb-shadow': '#CC6600', '--nb-accent': '#CC6600', '--nb-highlight': '#FFE680', '--nb-success': '#669900', '--nb-info': '#CC9900', '--nb-danger-light': '#FFDDAA', '--nb-surface-alt': '#FFF5B3' } },
    { name: t('nbPresetNord'),     colors: { '--nb-bg': '#2E3440', '--nb-text': '#ECEFF4', '--nb-border': '#88C0D0', '--nb-shadow': '#5E81AC', '--nb-accent': '#88C0D0', '--nb-highlight': '#3B4252', '--nb-success': '#A3BE8C', '--nb-info': '#81A1C1', '--nb-danger-light': '#3B2A2A', '--nb-surface-alt': '#3B4252' } },
    { name: t('nbPresetDracula'),  colors: { '--nb-bg': '#282A36', '--nb-text': '#F8F8F2', '--nb-border': '#BD93F9', '--nb-shadow': '#6272A4', '--nb-accent': '#BD93F9', '--nb-highlight': '#44475A', '--nb-success': '#50FA7B', '--nb-info': '#8BE9FD', '--nb-danger-light': '#3A1A2A', '--nb-surface-alt': '#44475A' } },
    { name: t('nbPresetSolarized'),colors: { '--nb-bg': '#002B36', '--nb-text': '#FDF6E3', '--nb-border': '#B58900', '--nb-shadow': '#657B83', '--nb-accent': '#B58900', '--nb-highlight': '#073642', '--nb-success': '#859900', '--nb-info': '#268BD2', '--nb-danger-light': '#1A1A10', '--nb-surface-alt': '#073642' } },
    { name: t('nbPresetOnyx'),     colors: { '--nb-bg': '#080808', '--nb-text': '#E8E8E8', '--nb-border': '#E8E8E8', '--nb-shadow': '#555555', '--nb-accent': '#E8E8E8', '--nb-highlight': '#1A1A1A', '--nb-success': '#4A9E4A', '--nb-info': '#5A8ABF', '--nb-danger-light': '#2A1515', '--nb-surface-alt': '#141414' } },
    { name: t('nbPresetEmber'),    colors: { '--nb-bg': '#0C0404', '--nb-text': '#FFD0B0', '--nb-border': '#FF4500', '--nb-shadow': '#8B2500', '--nb-accent': '#FF4500', '--nb-highlight': '#1A0A00', '--nb-success': '#CC6600', '--nb-info': '#FF8C00', '--nb-danger-light': '#2A0A00', '--nb-surface-alt': '#1A0808' } },
    { name: t('nbPresetMatrix'),   colors: { '--nb-bg': '#000800', '--nb-text': '#00FF41', '--nb-border': '#00FF41', '--nb-shadow': '#008020', '--nb-accent': '#00FF41', '--nb-highlight': '#001A00', '--nb-success': '#00CC33', '--nb-info': '#00AA22', '--nb-danger-light': '#0A1A00', '--nb-surface-alt': '#001200' } },
    { name: t('nbPresetStealth'),  colors: { '--nb-bg': '#0A0A0A', '--nb-text': '#909090', '--nb-border': '#404040', '--nb-shadow': '#202020', '--nb-accent': '#606060', '--nb-highlight': '#151515', '--nb-success': '#3A5A3A', '--nb-info': '#3A4A5A', '--nb-danger-light': '#1A1010', '--nb-surface-alt': '#131313' } },
  ];

  const presetRow = document.createElement('div');
  presetRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin-top:8px;';
  for (const p of PRESETS) {
    const btn = document.createElement('button');
    btn.textContent = p.name;
    btn.style.cssText = 'font-size:11px;padding:2px 6px;cursor:pointer;';
    btn.addEventListener('click', () => applyPreset(p.colors));
    presetRow.appendChild(btn);
  }

  nbSection.append(grid, presetRow, resetBtn);
  tabGeneral.appendChild(nbSection);

  colorSchemeSelect.onchange = () => {
    const scheme = colorSchemeSelect.value as ColorScheme;
    update({ colorScheme: scheme });
    nbSection.style.display = isNB(scheme) ? '' : 'none';
  };

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
    FONT_REGISTRY
      .filter((f) => !f.isSystem || isMacPlatform) // system fonts only on macOS
      .map((f) => ({ value: f.key, label: f.displayName, selected: f.key === current.fontFamily })),
  );
  fontFamilySection.appendChild(fontFamilySelect.el);
  fontFamilySelect.onchange = () => {
    current.fontFamily = fontFamilySelect.value;
    updateFontToggles();
    update({ fontFamily: fontFamilySelect.value });
  };
  tabGeneral.appendChild(fontFamilySection);

  // --- CJK Font Family ---
  const cjkFontSection = document.createElement('div');
  cjkFontSection.className = 'settings-section';
  cjkFontSection.innerHTML = `<label>${t('cjkFontFamily')}</label>`;
  const availableCJKFonts = getAvailableCJKFonts();
  const cjkOptions = [
    { value: '', label: t('cjkFontAuto'), selected: !current.cjkFontFamily },
    ...availableCJKFonts.map((f) => ({
      value: f.key,
      label: f.displayName,
      selected: f.key === current.cjkFontFamily,
    })),
  ];
  const cjkFontSelect = createSettingsSelect(cjkOptions);
  cjkFontSection.appendChild(cjkFontSelect.el);
  cjkFontSelect.onchange = () => {
    update({ cjkFontFamily: cjkFontSelect.value });
  };
  tabGeneral.appendChild(cjkFontSection);

  // --- Font Weight ---
  const fontWeightSection = document.createElement('div');
  fontWeightSection.className = 'settings-section';
  fontWeightSection.innerHTML = `<label>${t('fontWeight')}</label>`;
  const curWeight = current.fontWeight || 400;
  const fontWeightSelect = createSettingsSelect([
    { value: '100', label: 'Thin (100)', selected: curWeight === 100 },
    { value: '200', label: 'Extra Light (200)', selected: curWeight === 200 },
    { value: '300', label: 'Light (300)', selected: curWeight === 300 },
    { value: '400', label: 'Normal (400)', selected: curWeight === 400 },
    { value: '500', label: 'Medium (500)', selected: curWeight === 500 },
    { value: '700', label: 'Bold (700)', selected: curWeight === 700 },
  ]);
  fontWeightSection.appendChild(fontWeightSelect.el);
  fontWeightSelect.onchange = () => { update({ fontWeight: Number(fontWeightSelect.value) }); };
  tabGeneral.appendChild(fontWeightSection);

  // --- Font Options (Nerd Font / Ligatures) ---
  const fontOptsSection = document.createElement('div');
  fontOptsSection.className = 'settings-section';
  const fontOptsGroup = document.createElement('div');
  fontOptsGroup.className = 'settings-checkbox-group';
  fontOptsGroup.innerHTML = `
    <label><input type="checkbox" id="nerd-font-toggle" ${current.enableNerdFont ? 'checked' : ''}> ${t('enableNerdFont')}</label>
    <label><input type="checkbox" id="ligatures-toggle" ${current.enableLigatures ? 'checked' : ''}> ${t('enableLigatures')}</label>
    <label><input type="checkbox" id="sharpness-toggle" ${current.fontSharpness ? 'checked' : ''}> ${t('fontSharpness')}</label>
  `;
  fontOptsSection.appendChild(fontOptsGroup);
  const nerdToggle = fontOptsGroup.querySelector('#nerd-font-toggle') as HTMLInputElement;
  const ligToggle = fontOptsGroup.querySelector('#ligatures-toggle') as HTMLInputElement;
  const sharpnessToggle = fontOptsGroup.querySelector('#sharpness-toggle') as HTMLInputElement;
  nerdToggle.onchange = () => { update({ enableNerdFont: nerdToggle.checked }); };
  ligToggle.onchange = () => { update({ enableLigatures: ligToggle.checked }); };
  sharpnessToggle.onchange = () => { update({ fontSharpness: sharpnessToggle.checked }); };
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

  // --- File Manager Mode (drawer / sidebar) ---
  const fmModeSection = document.createElement('div');
  fmModeSection.className = 'settings-section';
  fmModeSection.innerHTML = `<label>${current.language === 'zh' ? '文件管理器位置' : 'File Manager Position'}</label>`;
  const fmModeSelect = createSettingsSelect([
    { value: 'drawer', label: current.language === 'zh' ? '底部抽屉' : 'Bottom Drawer', selected: current.fileManagerMode === 'drawer' },
    { value: 'sidebar', label: current.language === 'zh' ? '左侧边栏 (树形视图)' : 'Left Sidebar (Tree View)', selected: current.fileManagerMode === 'sidebar' },
  ]);
  fmModeSection.appendChild(fmModeSelect.el);
  fmModeSelect.onchange = () => {
    const fileManagerMode = fmModeSelect.value as 'drawer' | 'sidebar';
    update({ fileManagerMode });
  };
  tabGeneral.appendChild(fmModeSection);

  // --- Thumbnail Toggle + Preview Refresh Rate ---
  const thumbSection = document.createElement('div');
  thumbSection.className = 'settings-section';
  const thumbGroup = document.createElement('div');
  thumbGroup.className = 'settings-checkbox-group';
  thumbGroup.innerHTML = `<label><input type="checkbox" id="enable-thumbnail-toggle" ${current.enableThumbnail ? 'checked' : ''}> ${t('enableThumbnail')}</label>`;
  thumbSection.appendChild(thumbGroup);
  const thumbCheckbox = thumbGroup.querySelector('#enable-thumbnail-toggle') as HTMLInputElement;
  tabGeneral.appendChild(thumbSection);

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
  // Show/hide refresh rate based on thumbnail toggle
  const updateRateVisibility = () => { rateSection.style.display = thumbCheckbox.checked ? '' : 'none'; };
  updateRateVisibility();
  thumbCheckbox.addEventListener('change', () => {
    update({ enableThumbnail: thumbCheckbox.checked });
    updateRateVisibility();
  });
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
    <label><input type="checkbox" id="auto-new-session-toggle" ${current.autoNewSession ? 'checked' : ''}> ${t('autoNewSession')}</label>
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
  const autoNewSessionToggle = rememberGroup.querySelector('#auto-new-session-toggle') as HTMLInputElement;
  autoNewSessionToggle.onchange = () => { update({ autoNewSession: autoNewSessionToggle.checked }); };
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

  // --- PiP Scale by Screen ---
  const pipScreenSection = document.createElement('div');
  pipScreenSection.className = 'settings-section settings-inline';
  pipScreenSection.innerHTML = `
    <label>${t('pipScaleByScreen')}</label>
    <input type="checkbox" class="settings-checkbox" id="pip-scale-by-screen" ${current.pipScaleByScreen ? 'checked' : ''}>
  `;
  const pipScreenCheckbox = pipScreenSection.querySelector('#pip-scale-by-screen') as HTMLInputElement;
  pipScreenCheckbox.onchange = () => {
    update({ pipScaleByScreen: pipScreenCheckbox.checked });
  };
  tabGeneral.appendChild(pipScreenSection);

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
