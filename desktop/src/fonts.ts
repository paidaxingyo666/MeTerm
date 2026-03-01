// Font imports (Vite ?url returns resolved asset URL)
import jetbrainsMonoRegular from './fonts/jetbrains-mono-regular.woff2?url';
import jetbrainsMonoBold from './fonts/jetbrains-mono-bold.woff2?url';
import jetbrainsMonoNfRegular from './fonts/jetbrains-mono-nf-regular.woff2?url';
import jetbrainsMonoNfBold from './fonts/jetbrains-mono-nf-bold.woff2?url';

import firaCodeRegular from './fonts/fira-code-regular.woff2?url';
import firaCodeBold from './fonts/fira-code-bold.woff2?url';
import firaCodeNfRegular from './fonts/fira-code-nf-regular.woff2?url';
import firaCodeNfBold from './fonts/fira-code-nf-bold.woff2?url';

import cascadiaCodeRegular from './fonts/cascadia-code-regular.woff2?url';
import cascadiaCodeBold from './fonts/cascadia-code-bold.woff2?url';
import cascadiaCodeNfRegular from './fonts/cascadia-code-nf-regular.woff2?url';
import cascadiaCodeNfBold from './fonts/cascadia-code-nf-bold.woff2?url';

import sourceCodeProRegular from './fonts/source-code-pro-regular.woff2?url';
import sourceCodeProBold from './fonts/source-code-pro-bold.woff2?url';
import sourceCodeProNfRegular from './fonts/source-code-pro-nf-regular.woff2?url';
import sourceCodeProNfBold from './fonts/source-code-pro-nf-bold.woff2?url';

import hackRegular from './fonts/hack-regular.woff2?url';
import hackBold from './fonts/hack-bold.woff2?url';
import hackNfRegular from './fonts/hack-nf-regular.woff2?url';
import hackNfBold from './fonts/hack-nf-bold.woff2?url';

import iosevkaRegular from './fonts/iosevka-regular.woff2?url';
import iosevkaBold from './fonts/iosevka-bold.woff2?url';
import iosevkaNfRegular from './fonts/iosevka-nf-regular.woff2?url';
import iosevkaNfBold from './fonts/iosevka-nf-bold.woff2?url';

export interface FontDefinition {
  key: string;
  displayName: string;
  supportsLigatures: boolean;
  hasNerdFont: boolean;
  isSystem: boolean;
  cssFamily: string;
  nerdCssFamily: string;
  files: {
    regular: string;
    bold: string;
    nerdRegular: string;
    nerdBold: string;
  };
}

export const FONT_REGISTRY: FontDefinition[] = [
  {
    key: 'system-menlo',
    displayName: 'Menlo (System)',
    supportsLigatures: false,
    hasNerdFont: false,
    isSystem: true,
    cssFamily: 'Menlo, Monaco, "Courier New", monospace',
    nerdCssFamily: '',
    files: { regular: '', bold: '', nerdRegular: '', nerdBold: '' },
  },
  {
    key: 'jetbrains-mono',
    displayName: 'JetBrains Mono',
    supportsLigatures: true,
    hasNerdFont: true,
    isSystem: false,
    cssFamily: '"JetBrains Mono", monospace',
    nerdCssFamily: '"JetBrains Mono NF", monospace',
    files: {
      regular: jetbrainsMonoRegular,
      bold: jetbrainsMonoBold,
      nerdRegular: jetbrainsMonoNfRegular,
      nerdBold: jetbrainsMonoNfBold,
    },
  },
  {
    key: 'fira-code',
    displayName: 'Fira Code',
    supportsLigatures: true,
    hasNerdFont: true,
    isSystem: false,
    cssFamily: '"Fira Code", monospace',
    nerdCssFamily: '"Fira Code NF", monospace',
    files: {
      regular: firaCodeRegular,
      bold: firaCodeBold,
      nerdRegular: firaCodeNfRegular,
      nerdBold: firaCodeNfBold,
    },
  },
  {
    key: 'cascadia-code',
    displayName: 'Cascadia Code',
    supportsLigatures: true,
    hasNerdFont: true,
    isSystem: false,
    cssFamily: '"Cascadia Code", monospace',
    nerdCssFamily: '"Cascadia Code NF", monospace',
    files: {
      regular: cascadiaCodeRegular,
      bold: cascadiaCodeBold,
      nerdRegular: cascadiaCodeNfRegular,
      nerdBold: cascadiaCodeNfBold,
    },
  },
  {
    key: 'source-code-pro',
    displayName: 'Source Code Pro',
    supportsLigatures: false,
    hasNerdFont: true,
    isSystem: false,
    cssFamily: '"Source Code Pro", monospace',
    nerdCssFamily: '"Source Code Pro NF", monospace',
    files: {
      regular: sourceCodeProRegular,
      bold: sourceCodeProBold,
      nerdRegular: sourceCodeProNfRegular,
      nerdBold: sourceCodeProNfBold,
    },
  },
  {
    key: 'hack',
    displayName: 'Hack',
    supportsLigatures: false,
    hasNerdFont: true,
    isSystem: false,
    cssFamily: '"Hack", monospace',
    nerdCssFamily: '"Hack NF", monospace',
    files: {
      regular: hackRegular,
      bold: hackBold,
      nerdRegular: hackNfRegular,
      nerdBold: hackNfBold,
    },
  },
  {
    key: 'iosevka',
    displayName: 'Iosevka',
    supportsLigatures: true,
    hasNerdFont: true,
    isSystem: false,
    cssFamily: '"Iosevka", monospace',
    nerdCssFamily: '"Iosevka NF", monospace',
    files: {
      regular: iosevkaRegular,
      bold: iosevkaBold,
      nerdRegular: iosevkaNfRegular,
      nerdBold: iosevkaNfBold,
    },
  },
];

const loadedFonts = new Set<string>();

export async function loadFont(key: string, nerd: boolean): Promise<void> {
  const def = FONT_REGISTRY.find((f) => f.key === key);
  if (!def || def.isSystem) return;

  const familyName = nerd && def.hasNerdFont
    ? def.nerdCssFamily.split(',')[0].replace(/"/g, '').trim()
    : def.cssFamily.split(',')[0].replace(/"/g, '').trim();

  const regularUrl = nerd && def.hasNerdFont ? def.files.nerdRegular : def.files.regular;
  const boldUrl = nerd && def.hasNerdFont ? def.files.nerdBold : def.files.bold;

  const regularKey = `${familyName}-400`;
  const boldKey = `${familyName}-700`;

  const promises: Promise<FontFace>[] = [];

  if (!loadedFonts.has(regularKey)) {
    const face = new FontFace(familyName, `url(${regularUrl})`, { weight: '400' });
    promises.push(face.load());
    loadedFonts.add(regularKey);
  }

  if (!loadedFonts.has(boldKey)) {
    const face = new FontFace(familyName, `url(${boldUrl})`, { weight: '700' });
    promises.push(face.load());
    loadedFonts.add(boldKey);
  }

  const faces = await Promise.all(promises);
  faces.forEach((face) => document.fonts.add(face));
}

export function getFontFamily(key: string, nerd: boolean): string {
  const def = FONT_REGISTRY.find((f) => f.key === key);
  if (!def) return 'Menlo, Monaco, "Courier New", monospace';
  if (nerd && def.hasNerdFont) return def.nerdCssFamily;
  return def.cssFamily;
}

export function getFontDef(key: string): FontDefinition | undefined {
  return FONT_REGISTRY.find((f) => f.key === key);
}
