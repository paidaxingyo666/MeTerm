export type IconName = 'home' | 'settings' | 'plus' | 'terminal' | 'gallery' | 'ssh' | 'server' | 'chevronLeft' | 'chevronRight' | 'mobile' | 'share' | 'remote' | 'remoteList' | 'jumpserver' | 'pin';

const icons: Record<IconName, string> = {
  home: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 11.5L12 4l9 7.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M6.5 10.5V20h11V10.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  settings: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8.4a3.6 3.6 0 1 0 0 7.2 3.6 3.6 0 0 0 0-7.2Z" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M19.4 13.1a7.8 7.8 0 0 0 0-2.2l2-1.5-2-3.4-2.4.8a8.2 8.2 0 0 0-1.9-1.1L14.7 3h-5.4l-.4 2.7a8.2 8.2 0 0 0-1.9 1.1l-2.4-.8-2 3.4 2 1.5a7.8 7.8 0 0 0 0 2.2l-2 1.5 2 3.4 2.4-.8a8.2 8.2 0 0 0 1.9 1.1l.4 2.7h5.4l.4-2.7a8.2 8.2 0 0 0 1.9-1.1l2.4.8 2-3.4-2-1.5Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>',
  plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>',
  terminal: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2.2" ry="2.2" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M7 10l3 2.5L7 15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="M12.5 15H17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  gallery: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="7.5" height="7.5" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M5.5 6.5l1.5 1.3L5.5 9" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M16 6.5l1.5 1.3L16 9" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M5.5 17l1.5 1.3-1.5 1.2" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M16 17l1.5 1.3-1.5 1.2" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  ssh: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.35 10.04A7.49 7.49 0 0 0 12 4C9.11 4 6.6 5.64 5.35 8.04A5.994 5.994 0 0 0 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96z" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 11l2.5 2L8 15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M13 15h3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  server: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="7" rx="1.8" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="3" y="14" width="18" height="7" rx="1.8" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="7" cy="6.5" r="1" fill="currentColor"/><circle cx="7" cy="17.5" r="1" fill="currentColor"/><path d="M11 6.5h6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M11 17.5h6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M12 10v4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  chevronLeft: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  chevronRight: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18l6-6-6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  mobile: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="2" width="10" height="20" rx="2" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M11 18h2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  share: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="18" cy="5" r="2.5" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="6" cy="12" r="2.5" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="18" cy="19" r="2.5" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M8.3 10.8l7.4-4.6M8.3 13.2l7.4 4.6" fill="none" stroke="currentColor" stroke-width="1.7"/></svg>',
  remote: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.7"/><ellipse cx="12" cy="12" rx="4" ry="9" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M3.5 9h17M3.5 15h17" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>',
  remoteList: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" stroke-width="1.5"/><ellipse cx="10" cy="10" rx="3.2" ry="7.5" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M3 7.5h14M3 12.5h14" fill="none" stroke="currentColor" stroke-width="1.1"/><path d="M16 17h5M16 19.5h5M16 22h5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  jumpserver: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2L3 7v10l9 5 9-5V7l-9-5Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M12 12L3 7M12 12l9-5M12 12v10" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><circle cx="12" cy="9" r="2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M10 14h4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  pin: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2v8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M5 10h14l-2 6H7l-2-6Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M12 16v6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
};

export function icon(name: IconName): string {
  return icons[name];
}

/** Generate a file icon SVG: colored document with transparent cutout extension text */
function fileExtIcon(ext: string, color: string = '#6b7280'): string {
  const label = ext.toUpperCase().slice(0, 4);
  const fontSize = label.length > 3 ? 5.5 : label.length > 2 ? 6.5 : 7.5;
  const maskId = `m${ext.replace(/[^a-z0-9]/gi, '')}`;
  return `<svg viewBox="0 0 16 16" width="16" height="16" xmlns="http://www.w3.org/2000/svg">`
    + `<defs><mask id="${maskId}"><rect width="16" height="16" fill="#fff"/>`
    + `<text x="7.5" y="14.2" text-anchor="middle" font-size="${fontSize}" font-family="ui-monospace,'SF Mono',monospace" font-weight="800" fill="#000">${label}</text>`
    + `</mask></defs>`
    + `<path d="M1 .5h9L14 4.5V15.5H1z" fill="${color}" stroke="${color}" stroke-width=".3" mask="url(#${maskId})"/>`
    + `<path d="M10 .5v4H14" fill="${color}" opacity=".5"/>`
    + `</svg>`;
}

const fileIcons: Record<string, string> = {
  folder:       `<svg viewBox="0 0 16 16" width="14" height="14" fill="var(--accent)" stroke="none"><path d="M1.5 2h4.3l1.4 1.5H14.5a1 1 0 0 1 1 1V13a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z"/></svg>`,
  'file-code':  fileExtIcon('{ }', '#e06c75'),
  'file-config': fileExtIcon('cfg', '#98c379'),
  'file-image': fileExtIcon('img', '#d19a66'),
  'file-archive': fileExtIcon('zip', '#e5c07b'),
  'file-doc':   fileExtIcon('doc', '#61afef'),
  'file-text':  fileExtIcon('txt', '#9ca3af'),
  'file-shell': fileExtIcon('sh', '#98c379'),
  'file-video': fileExtIcon('vid', '#c678dd'),
  'file-audio': fileExtIcon('mp3', '#c678dd'),
  'file-lock':  fileExtIcon('🔒', '#e5c07b'),
  'file-binary': fileExtIcon('bin', '#6b7280'),
  'file-symlink': `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><path d="M3 1.5h6l3.5 3.5v10H3z"/><path d="M9 1.5v3.5h3.5"/><path d="M5.5 10.5h3a1.5 1.5 0 0 0 0-3H7.5"/><path d="M7 9l-2 1.5L7 12"/></svg>`,
  'file-default': `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><path d="M3 1.5h6l3.5 3.5v10H3z"/><path d="M9 1.5v3.5h3.5"/></svg>`,
};

// Extension to icon type mapping
const extMap: Record<string, string> = {
  // Code
  js: 'file-code', ts: 'file-code', jsx: 'file-code', tsx: 'file-code',
  py: 'file-code', go: 'file-code', rs: 'file-code', rb: 'file-code',
  c: 'file-code', cpp: 'file-code', h: 'file-code', hpp: 'file-code',
  java: 'file-code', kt: 'file-code', swift: 'file-code', cs: 'file-code',
  php: 'file-code', vue: 'file-code', svelte: 'file-code',
  css: 'file-code', scss: 'file-code', less: 'file-code',
  html: 'file-code', htm: 'file-code',
  sql: 'file-code', r: 'file-code', lua: 'file-code', zig: 'file-code',
  // Config
  json: 'file-config', yaml: 'file-config', yml: 'file-config',
  toml: 'file-config', xml: 'file-config', ini: 'file-config',
  env: 'file-config', conf: 'file-config', cfg: 'file-config',
  properties: 'file-config',
  // Image
  png: 'file-image', jpg: 'file-image', jpeg: 'file-image',
  gif: 'file-image', svg: 'file-image', webp: 'file-image',
  ico: 'file-image', bmp: 'file-image', tiff: 'file-image',
  // Archive
  zip: 'file-archive', tar: 'file-archive', gz: 'file-archive',
  rar: 'file-archive', '7z': 'file-archive', bz2: 'file-archive',
  xz: 'file-archive', zst: 'file-archive', tgz: 'file-archive',
  // Document
  pdf: 'file-doc', doc: 'file-doc', docx: 'file-doc',
  xls: 'file-doc', xlsx: 'file-doc', ppt: 'file-doc', pptx: 'file-doc',
  odt: 'file-doc', ods: 'file-doc', odp: 'file-doc', csv: 'file-doc',
  // Text
  txt: 'file-text', md: 'file-text', rst: 'file-text', log: 'file-text',
  // Shell
  sh: 'file-shell', bash: 'file-shell', zsh: 'file-shell',
  fish: 'file-shell', bat: 'file-shell', cmd: 'file-shell', ps1: 'file-shell',
  // Video
  mp4: 'file-video', mkv: 'file-video', avi: 'file-video',
  mov: 'file-video', webm: 'file-video', flv: 'file-video',
  // Audio
  mp3: 'file-audio', wav: 'file-audio', flac: 'file-audio',
  ogg: 'file-audio', aac: 'file-audio', m4a: 'file-audio', wma: 'file-audio',
  // Lock
  lock: 'file-lock',
  // Binary
  exe: 'file-binary', bin: 'file-binary', so: 'file-binary',
  dylib: 'file-binary', dll: 'file-binary', o: 'file-binary', a: 'file-binary',
};

// Special filename mappings
const nameMap: Record<string, string> = {
  'Makefile': 'file-code', 'Dockerfile': 'file-config',
  'Containerfile': 'file-config', '.gitignore': 'file-config',
  '.dockerignore': 'file-config', '.editorconfig': 'file-config',
  '.eslintrc': 'file-config', '.prettierrc': 'file-config',
  'LICENSE': 'file-doc', 'README': 'file-text',
};

// Non-editable icon types (binary, media, documents that need special readers)
const nonEditableTypes = new Set([
  'file-image', 'file-archive', 'file-binary', 'file-video', 'file-audio', 'file-lock',
]);

// File extensions that are text despite being classified under non-editable icon types
const editableExceptions = new Set(['csv', 'svg']);

/**
 * Check if a file can be opened in the text editor.
 * Returns true for code, config, text, shell, and unknown (no extension) files.
 */
export function isEditableFile(name: string): boolean {
  const baseName = name.split('/').pop() || name;

  // Check special filenames first
  if (nameMap[baseName]) {
    return !nonEditableTypes.has(nameMap[baseName]);
  }

  // Check extension
  const dotIdx = baseName.lastIndexOf('.');
  if (dotIdx > 0) {
    const ext = baseName.substring(dotIdx + 1).toLowerCase();
    if (editableExceptions.has(ext)) return true;
    if (extMap[ext]) return !nonEditableTypes.has(extMap[ext]);
  }

  // No extension / unknown → treat as editable (common on Linux)
  return true;
}

// Extension → color for ext-label icons
const extColorMap: Record<string, string> = {
  // Code (red-ish)
  js: '#e06c75', ts: '#3178c6', jsx: '#e06c75', tsx: '#3178c6',
  py: '#3572a5', go: '#00add8', rs: '#dea584', rb: '#cc342d',
  c: '#555', cpp: '#f34b7d', h: '#555', hpp: '#f34b7d',
  java: '#b07219', kt: '#a97bff', swift: '#f05138', cs: '#178600',
  php: '#4f5d95', vue: '#42b883', svelte: '#ff3e00',
  html: '#e34c26', css: '#563d7c', scss: '#c6538c', less: '#1d365d',
  // Config (green)
  json: '#98c379', yaml: '#98c379', yml: '#98c379', toml: '#98c379',
  xml: '#98c379', ini: '#98c379', env: '#98c379',
  // Shell (green)
  sh: '#4eaa25', bash: '#4eaa25', zsh: '#4eaa25', ps1: '#012456',
  // Doc (blue)
  md: '#61afef', pdf: '#e5252a', doc: '#2b579a', xls: '#217346', ppt: '#d24726',
  // Media
  png: '#d19a66', jpg: '#d19a66', svg: '#ffb13b', mp4: '#c678dd', mp3: '#c678dd',
  // Archive
  zip: '#e5c07b', tar: '#e5c07b', gz: '#e5c07b',
};

export function getFileIcon(name: string, isDir: boolean, isLink?: boolean): string {
  if (isDir) return fileIcons['folder'];
  if (isLink) return fileIcons['file-symlink'];

  const baseName = name.split('/').pop() || name;

  // Special filenames (Makefile, Dockerfile, .gitignore, etc.)
  if (nameMap[baseName]) {
    // Use a recognizable label for special files
    const labelMap: Record<string, [string, string]> = {
      'Makefile': ['MAKE', '#e06c75'], 'Dockerfile': ['DOCK', '#2496ed'],
      'LICENSE': ['LIC', '#e5c07b'], 'README': ['READ', '#61afef'],
    };
    if (labelMap[baseName]) return fileExtIcon(labelMap[baseName][0], labelMap[baseName][1]);
    return fileExtIcon('CFG', '#98c379'); // .gitignore, .editorconfig, etc.
  }

  // Dotfiles without extension (.bashrc, .zshrc, .profile, etc.) → config
  if (baseName.startsWith('.') && !baseName.includes('.', 1)) {
    return fileExtIcon('CFG', '#98c379');
  }

  // Extract extension
  const dotIdx = baseName.lastIndexOf('.');
  if (dotIdx > 0) {
    const ext = baseName.substring(dotIdx + 1).toLowerCase();

    // Only show ext icon for KNOWN extensions
    if (extMap[ext] || extColorMap[ext]) {
      const color = extColorMap[ext] || '#9ca3af';
      return fileExtIcon(ext, color);
    }

    // Unknown extension → show "?" with gray
    return fileExtIcon('?', '#6b7280');
  }

  // No extension at all → "?"
  return fileExtIcon('?', '#6b7280');
}
