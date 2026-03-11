export type IconName = 'home' | 'settings' | 'plus' | 'terminal' | 'gallery' | 'ssh' | 'server' | 'chevronLeft' | 'chevronRight' | 'mobile' | 'share' | 'remote' | 'remoteList' | 'jumpserver';

const icons: Record<IconName, string> = {
  home: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 11.5L12 4l9 7.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M6.5 10.5V20h11V10.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  settings: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8.4a3.6 3.6 0 1 0 0 7.2 3.6 3.6 0 0 0 0-7.2Z" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M19.4 13.1a7.8 7.8 0 0 0 0-2.2l2-1.5-2-3.4-2.4.8a8.2 8.2 0 0 0-1.9-1.1L14.7 3h-5.4l-.4 2.7a8.2 8.2 0 0 0-1.9 1.1l-2.4-.8-2 3.4 2 1.5a7.8 7.8 0 0 0 0 2.2l-2 1.5 2 3.4 2.4-.8a8.2 8.2 0 0 0 1.9 1.1l.4 2.7h5.4l.4-2.7a8.2 8.2 0 0 0 1.9-1.1l2.4.8 2-3.4-2-1.5Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>',
  plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>',
  terminal: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2.2" ry="2.2" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M7 10l3 2.5L7 15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="M12.5 15H17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  gallery: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="7.5" height="7.5" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M5.5 6.5l1.5 1.3L5.5 9" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M16 6.5l1.5 1.3L16 9" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M5.5 17l1.5 1.3-1.5 1.2" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M16 17l1.5 1.3-1.5 1.2" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  ssh: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Z" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M6.5 11l1.5 1.2-1.5 1.3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M10.5 13.5h3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="18" cy="12" r="1" fill="currentColor"/></svg>',
  server: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="7" rx="1.8" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="3" y="14" width="18" height="7" rx="1.8" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="7" cy="6.5" r="1" fill="currentColor"/><circle cx="7" cy="17.5" r="1" fill="currentColor"/><path d="M11 6.5h6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M11 17.5h6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M12 10v4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  chevronLeft: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  chevronRight: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18l6-6-6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  mobile: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="2" width="10" height="20" rx="2" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M11 18h2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  share: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="18" cy="5" r="2.5" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="6" cy="12" r="2.5" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="18" cy="19" r="2.5" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M8.3 10.8l7.4-4.6M8.3 13.2l7.4 4.6" fill="none" stroke="currentColor" stroke-width="1.7"/></svg>',
  remote: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.7"/><ellipse cx="12" cy="12" rx="4" ry="9" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M3.5 9h17M3.5 15h17" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>',
  remoteList: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" stroke-width="1.5"/><ellipse cx="10" cy="10" rx="3.2" ry="7.5" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M3 7.5h14M3 12.5h14" fill="none" stroke="currentColor" stroke-width="1.1"/><path d="M16 17h5M16 19.5h5M16 22h5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  jumpserver: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2L3 7v10l9 5 9-5V7l-9-5Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M12 12L3 7M12 12l9-5M12 12v10" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><circle cx="12" cy="9" r="2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M10 14h4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
};

export function icon(name: IconName): string {
  return icons[name];
}

// File type SVG icons for file manager (14x14 viewBox, stroke style)
const S = 'stroke="currentColor" fill="none" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"';

const fileIcons: Record<string, string> = {
  folder:       `<svg viewBox="0 0 14 14" ${S}><path d="M1.5 3h4l1 1.5h6v7h-11z"/></svg>`,
  'file-code':  `<svg viewBox="0 0 14 14" ${S}><path d="M3 1h5l3 3v9H3z"/><path d="M8 1v3h3"/><path d="M5.5 7L4 8.5 5.5 10"/><path d="M8.5 7L10 8.5 8.5 10"/></svg>`,
  'file-config':`<svg viewBox="0 0 14 14" ${S}><path d="M3 1h5l3 3v9H3z"/><path d="M8 1v3h3"/><circle cx="7" cy="8.5" r="1.2"/><path d="M7 6v1.3M7 9.7V11M5.2 7.6l1.1.6M7.7 8.9l1.1.6M5.2 9.4l1.1-.6M7.7 8.1l1.1-.6"/></svg>`,
  'file-image': `<svg viewBox="0 0 14 14" ${S}><path d="M3 1h5l3 3v9H3z"/><path d="M8 1v3h3"/><circle cx="6" cy="7" r="1"/><path d="M3 11.5l2.5-3 1.5 1.5 2-2.5L11 11.5"/></svg>`,
  'file-archive':`<svg viewBox="0 0 14 14" ${S}><path d="M3 1h5l3 3v9H3z"/><path d="M8 1v3h3"/><path d="M6 5h2M6 7h2M6 9h2"/><rect x="5.5" y="10" width="3" height="2" rx=".5"/></svg>`,
  'file-doc':   `<svg viewBox="0 0 14 14" ${S}><path d="M3 1h5l3 3v9H3z"/><path d="M8 1v3h3"/><path d="M5 7h4M5 9h3M5 11h2"/></svg>`,
  'file-text':  `<svg viewBox="0 0 14 14" ${S}><path d="M3 1h5l3 3v9H3z"/><path d="M8 1v3h3"/><path d="M5 7h4M5 9h4M5 11h2"/></svg>`,
  'file-shell': `<svg viewBox="0 0 14 14" ${S}><path d="M3 1h5l3 3v9H3z"/><path d="M8 1v3h3"/><path d="M5 8l1.5 1.2L5 10.5"/><path d="M7.5 10.5H10"/></svg>`,
  'file-video': `<svg viewBox="0 0 14 14" ${S}><path d="M3 1h5l3 3v9H3z"/><path d="M8 1v3h3"/><path d="M5.5 7v4l3.5-2z"/></svg>`,
  'file-audio': `<svg viewBox="0 0 14 14" ${S}><path d="M3 1h5l3 3v9H3z"/><path d="M8 1v3h3"/><path d="M6 7v4"/><path d="M8 8v2"/><path d="M10 7.5v3"/><path d="M4 8.5v1"/></svg>`,
  'file-lock':  `<svg viewBox="0 0 14 14" ${S}><path d="M3 1h5l3 3v9H3z"/><path d="M8 1v3h3"/><rect x="5" y="8" width="4" height="3" rx=".8"/><path d="M6 8V6.8a1 1 0 0 1 2 0V8"/></svg>`,
  'file-binary':`<svg viewBox="0 0 14 14" ${S}><path d="M3 1h5l3 3v9H3z"/><path d="M8 1v3h3"/><text x="4.5" y="10" font-size="4" fill="currentColor" stroke="none" font-family="monospace">01</text></svg>`,
  'file-symlink':`<svg viewBox="0 0 14 14" ${S}><path d="M3 1h5l3 3v9H3z"/><path d="M8 1v3h3"/><path d="M5 9.5h2.5a1.5 1.5 0 0 0 0-3H7"/><path d="M6 8l-1.5 1.5L6 11"/></svg>`,
  'file-default':`<svg viewBox="0 0 14 14" ${S}><path d="M3 1h5l3 3v9H3z"/><path d="M8 1v3h3"/></svg>`,
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

export function getFileIcon(name: string, isDir: boolean, isLink?: boolean): string {
  if (isDir) return fileIcons['folder'];
  if (isLink) return fileIcons['file-symlink'];

  // Check special filenames
  const baseName = name.split('/').pop() || name;
  if (nameMap[baseName]) return fileIcons[nameMap[baseName]];

  // Check extension
  const dotIdx = baseName.lastIndexOf('.');
  if (dotIdx > 0) {
    const ext = baseName.substring(dotIdx + 1).toLowerCase();
    if (extMap[ext]) return fileIcons[extMap[ext]];
  }

  return fileIcons['file-default'];
}
