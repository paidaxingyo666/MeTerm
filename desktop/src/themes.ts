import type { AIProviderEntry } from './ai-provider';

export type ThemeType = 'dark' | 'light';

export interface TerminalTheme {
  name: string;
  type: ThemeType;
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export type ColorScheme = 'auto' | 'dark' | 'darker' | 'navy' | 'light';

export const THEMES: Record<string, TerminalTheme> = {
  midnight: {
    name: 'Midnight',
    type: 'dark',
    background: '#000000',
    foreground: '#c8c8c8',
    cursor: '#ffffff',
    cursorAccent: '#000000',
    selectionBackground: '#1a3a5c',
    black: '#000000',
    red: '#ff5c57',
    green: '#5af78e',
    yellow: '#f3f99d',
    blue: '#57c7ff',
    magenta: '#ff6ac1',
    cyan: '#9aedfe',
    white: '#f1f1f0',
    brightBlack: '#555555',
    brightRed: '#ff5c57',
    brightGreen: '#5af78e',
    brightYellow: '#f3f99d',
    brightBlue: '#57c7ff',
    brightMagenta: '#ff6ac1',
    brightCyan: '#9aedfe',
    brightWhite: '#f1f1f0',
  },
  default: {
    name: 'Default Dark',
    type: 'dark',
    background: '#1e1e1e',
    foreground: '#d4d4d4',
    cursor: '#ffffff',
    cursorAccent: '#000000',
    selectionBackground: '#264f78',
    black: '#000000',
    red: '#cd3131',
    green: '#0dbc79',
    yellow: '#e5e510',
    blue: '#2472c8',
    magenta: '#bc3fbc',
    cyan: '#11a8cd',
    white: '#e5e5e5',
    brightBlack: '#666666',
    brightRed: '#f14c4c',
    brightGreen: '#23d18b',
    brightYellow: '#f5f543',
    brightBlue: '#3b8eea',
    brightMagenta: '#d670d6',
    brightCyan: '#29b8db',
    brightWhite: '#ffffff',
  },
  defaultLight: {
    name: 'Default Light',
    type: 'light',
    background: '#ffffff',
    foreground: '#383a42',
    cursor: '#000000',
    cursorAccent: '#ffffff',
    selectionBackground: '#add6ff',
    black: '#000000',
    red: '#cd3131',
    green: '#00bc7c',
    yellow: '#949800',
    blue: '#0451a5',
    magenta: '#bc05bc',
    cyan: '#0598bc',
    white: '#555555',
    brightBlack: '#666666',
    brightRed: '#cd3131',
    brightGreen: '#14ce14',
    brightYellow: '#b5ba00',
    brightBlue: '#0451a5',
    brightMagenta: '#bc05bc',
    brightCyan: '#0598bc',
    brightWhite: '#a5a5a5',
  },
  solarized: {
    name: 'Solarized Dark',
    type: 'dark',
    background: '#002b36',
    foreground: '#839496',
    cursor: '#839496',
    cursorAccent: '#002b36',
    selectionBackground: '#073642',
    black: '#073642',
    red: '#dc322f',
    green: '#859900',
    yellow: '#b58900',
    blue: '#268bd2',
    magenta: '#d33682',
    cyan: '#2aa198',
    white: '#eee8d5',
    brightBlack: '#002b36',
    brightRed: '#cb4b16',
    brightGreen: '#586e75',
    brightYellow: '#657b83',
    brightBlue: '#839496',
    brightMagenta: '#6c71c4',
    brightCyan: '#93a1a1',
    brightWhite: '#fdf6e3',
  },
  solarizedLight: {
    name: 'Solarized Light',
    type: 'light',
    background: '#fdf6e3',
    foreground: '#657b83',
    cursor: '#657b83',
    cursorAccent: '#fdf6e3',
    selectionBackground: '#eee8d5',
    black: '#073642',
    red: '#dc322f',
    green: '#859900',
    yellow: '#b58900',
    blue: '#268bd2',
    magenta: '#d33682',
    cyan: '#2aa198',
    white: '#eee8d5',
    brightBlack: '#002b36',
    brightRed: '#cb4b16',
    brightGreen: '#586e75',
    brightYellow: '#657b83',
    brightBlue: '#839496',
    brightMagenta: '#6c71c4',
    brightCyan: '#93a1a1',
    brightWhite: '#fdf6e3',
  },
  oneDark: {
    name: 'One Dark',
    type: 'dark',
    background: '#282c34',
    foreground: '#abb2bf',
    cursor: '#528bff',
    cursorAccent: '#282c34',
    selectionBackground: '#3e4451',
    black: '#282c34',
    red: '#e06c75',
    green: '#98c379',
    yellow: '#e5c07b',
    blue: '#61afef',
    magenta: '#c678dd',
    cyan: '#56b6c2',
    white: '#abb2bf',
    brightBlack: '#5c6370',
    brightRed: '#e06c75',
    brightGreen: '#98c379',
    brightYellow: '#e5c07b',
    brightBlue: '#61afef',
    brightMagenta: '#c678dd',
    brightCyan: '#56b6c2',
    brightWhite: '#ffffff',
  },
  dracula: {
    name: 'Dracula',
    type: 'dark',
    background: '#282a36',
    foreground: '#f8f8f2',
    cursor: '#f8f8f2',
    cursorAccent: '#282a36',
    selectionBackground: '#44475a',
    black: '#21222c',
    red: '#ff5555',
    green: '#50fa7b',
    yellow: '#f1fa8c',
    blue: '#bd93f9',
    magenta: '#ff79c6',
    cyan: '#8be9fd',
    white: '#f8f8f2',
    brightBlack: '#6272a4',
    brightRed: '#ff6e6e',
    brightGreen: '#69ff94',
    brightYellow: '#ffffa5',
    brightBlue: '#d6acff',
    brightMagenta: '#ff92df',
    brightCyan: '#a4ffff',
    brightWhite: '#ffffff',
  },
  nord: {
    name: 'Nord',
    type: 'dark',
    background: '#2e3440',
    foreground: '#d8dee9',
    cursor: '#d8dee9',
    cursorAccent: '#2e3440',
    selectionBackground: '#434c5e',
    black: '#3b4252',
    red: '#bf616a',
    green: '#a3be8c',
    yellow: '#ebcb8b',
    blue: '#81a1c1',
    magenta: '#b48ead',
    cyan: '#88c0d0',
    white: '#e5e9f0',
    brightBlack: '#4c566a',
    brightRed: '#bf616a',
    brightGreen: '#a3be8c',
    brightYellow: '#ebcb8b',
    brightBlue: '#81a1c1',
    brightMagenta: '#b48ead',
    brightCyan: '#8fbcbb',
    brightWhite: '#eceff4',
  },
};

// Mapping from dark theme to its light counterpart
const DARK_LIGHT_PAIRS: Record<string, string> = {
  default: 'defaultLight',
  defaultLight: 'default',
  solarized: 'solarizedLight',
  solarizedLight: 'solarized',
};

export interface AppSettings {
  theme: string;
  colorScheme: ColorScheme;
  opacity: number;
  fontSize: number;
  fontFamily: string;
  enableNerdFont: boolean;
  enableLigatures: boolean;
  enableBoldFont: boolean;
  encoding: string;
  previewRefreshRate: number;
  language: 'en' | 'zh';
  rememberWindowSize: boolean;
  windowWidth: number;
  windowHeight: number;
  fileManagerFontSize: number;
  rememberDrawerLayout: boolean;
  drawerHeight: number;
  drawerSidebarWidth: number;
  backgroundImage: string;
  backgroundImageOpacity: number;
  enableTerminalNotifications: boolean;
  // AI configuration (multi-provider)
  aiProviders: AIProviderEntry[];
  aiActiveModel: string;  // 'auto' | 'providerId:modelName'
  aiBarOpacity: number;
  aiMaxTokens: number;
  aiTemperature: number;
  aiContextLines: number;
}

const SETTINGS_KEY = 'meterm-settings';

const DEFAULT_SETTINGS: AppSettings = {
  theme: 'default',
  colorScheme: 'auto',
  opacity: 92,
  fontSize: 14,
  fontFamily: 'jetbrains-mono',
  enableNerdFont: false,
  enableLigatures: false,
  enableBoldFont: false,
  encoding: 'utf-8',
  previewRefreshRate: 1000,
  language: 'en',
  rememberWindowSize: true,
  windowWidth: 1000,
  windowHeight: 700,
  fileManagerFontSize: 12,
  rememberDrawerLayout: true,
  drawerHeight: 0,
  drawerSidebarWidth: 0,
  backgroundImage: '',
  backgroundImageOpacity: 30,
  enableTerminalNotifications: true,
  aiProviders: [
    { id: 'openai',    type: 'openai',    label: 'OpenAI',    apiKey: '', baseUrl: 'https://api.openai.com',                    models: [], enabledModels: [] },
    { id: 'anthropic', type: 'anthropic', label: 'Anthropic', apiKey: '', baseUrl: 'https://api.anthropic.com',                 models: [], enabledModels: [] },
    { id: 'gemini',    type: 'gemini',    label: 'Gemini',    apiKey: '', baseUrl: 'https://generativelanguage.googleapis.com', models: [], enabledModels: [] },
  ],
  aiActiveModel: 'auto',
  aiBarOpacity: 80,
  aiMaxTokens: 4096,
  aiTemperature: 0.3,
  aiContextLines: 50,
};

export function loadSettings(): AppSettings {
  try {
    const stored = localStorage.getItem(SETTINGS_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      let settings = { ...DEFAULT_SETTINGS, ...parsed };

      // Migration: old single-provider format → new multi-provider format
      if (!parsed.aiProviders && parsed.aiProviderType) {
        const oldType = parsed.aiProviderType as string;
        const oldKey = (parsed.aiApiKey as string) || '';
        const oldUrl = (parsed.aiBaseUrl as string) || '';
        const oldModel = (parsed.aiModel as string) || '';

        settings.aiProviders = DEFAULT_SETTINGS.aiProviders.map((p) => {
          if (p.type === oldType) {
            return { ...p, apiKey: oldKey, baseUrl: oldUrl || p.baseUrl, enabledModels: oldModel && oldModel !== 'auto' ? [oldModel] : [] };
          }
          return { ...p };
        });
        settings.aiActiveModel = oldModel === 'auto' || !oldModel
          ? 'auto'
          : `${settings.aiProviders.find((p: AIProviderEntry) => p.type === oldType)?.id || 'openai'}:${oldModel}`;

        // Clean up old fields and save migrated settings
        delete (settings as Record<string, unknown>).aiProviderType;
        delete (settings as Record<string, unknown>).aiApiKey;
        delete (settings as Record<string, unknown>).aiBaseUrl;
        delete (settings as Record<string, unknown>).aiModel;
        saveSettings(settings);
      }

      return settings;
    }
  } catch {
    return DEFAULT_SETTINGS;
  }
  return DEFAULT_SETTINGS;
}

export function saveSettings(settings: AppSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

export function getTheme(name: string): TerminalTheme {
  return THEMES[name] || THEMES.default;
}

export function getSystemIsDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function resolveIsDark(colorScheme: ColorScheme): boolean {
  if (colorScheme === 'auto') return getSystemIsDark();
  return colorScheme === 'dark' || colorScheme === 'darker' || colorScheme === 'navy';
}

export function getEffectiveTheme(settings: AppSettings): string {
  const isDark = resolveIsDark(settings.colorScheme);
  const currentTheme = THEMES[settings.theme];

  if (!currentTheme) return isDark ? 'default' : 'defaultLight';

  // If current theme matches the scheme, use it
  if ((isDark && currentTheme.type === 'dark') || (!isDark && currentTheme.type === 'light')) {
    return settings.theme;
  }

  // Try to find the paired theme
  const paired = DARK_LIGHT_PAIRS[settings.theme];
  if (paired && THEMES[paired]) return paired;

  // Fallback to default for the scheme
  return isDark ? 'default' : 'defaultLight';
}

export function getThemesForType(type: ThemeType): [string, TerminalTheme][] {
  return Object.entries(THEMES).filter(([, theme]) => theme.type === type);
}

export function applyTheme(terminal: { options: { theme: TerminalTheme } }, themeName: string): void {
  const theme = getTheme(themeName);
  terminal.options.theme = theme;
}

export function getColorSchemeBg(colorScheme: ColorScheme): string {
  const resolved = colorScheme === 'auto'
    ? (getSystemIsDark() ? 'dark' : 'light')
    : colorScheme;
  switch (resolved) {
    case 'darker': return '#000000';
    case 'navy': return '#010309';
    case 'light': return '#f8f8f8';
    default: return '#1e1e1e';
  }
}

/**
 * Convert a hex color (#RRGGBB) to the XParseColor format used by OSC 10/11
 * responses: "rgb:RRRR/GGGG/BBBB" (16-bit per channel).
 */
export function hexToOscRgb(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  // Scale 8-bit to 16-bit: 0xFF -> 0xFFFF
  const r16 = ((r << 8) | r).toString(16).padStart(4, '0');
  const g16 = ((g << 8) | g).toString(16).padStart(4, '0');
  const b16 = ((b << 8) | b).toString(16).padStart(4, '0');
  return `rgb:${r16}/${g16}/${b16}`;
}

export function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
