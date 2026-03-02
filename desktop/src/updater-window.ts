import './style.css';
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { loadSettings, resolveIsDark } from './themes';
import { initLanguage, setLanguage, t } from './i18n';

const ua = navigator.userAgent.toLowerCase();
const isWindowsPlatform = ua.includes('windows');

function resolveThemeAttr(colorScheme: string): string {
  if (colorScheme === 'light') return 'light';
  if (colorScheme === 'darker') return 'darker';
  if (colorScheme === 'navy') return 'navy';
  if (colorScheme === 'auto') return resolveIsDark('auto') ? 'dark' : 'light';
  return 'dark';
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function createCustomTitleBar(title: string, onClose?: () => void): HTMLElement {
  const titleBar = document.createElement('div');
  titleBar.className = 'settings-titlebar';

  const dragRegion = document.createElement('div');
  dragRegion.className = 'settings-titlebar-drag';
  dragRegion.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    void getCurrentWindow().startDragging();
  });

  const titleEl = document.createElement('span');
  titleEl.className = 'settings-titlebar-title';
  titleEl.textContent = title;
  dragRegion.appendChild(titleEl);
  titleBar.appendChild(dragRegion);

  const closeBtn = document.createElement('button');
  closeBtn.className = 'settings-titlebar-close';
  closeBtn.type = 'button';
  closeBtn.innerHTML = '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M1 1 9 9M9 1 1 9" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';
  closeBtn.onclick = () => { onClose?.(); void getCurrentWindow().close(); };
  titleBar.appendChild(closeBtn);

  return titleBar;
}

export function initUpdaterWindow(): void {
  initLanguage();
  const settings = loadSettings();
  setLanguage(settings.language);
  document.documentElement.dataset.theme = resolveThemeAttr(settings.colorScheme);
  document.documentElement.style.setProperty('--app-window-opacity', '1');
  document.documentElement.classList.toggle('platform-windows', isWindowsPlatform);

  // Hide main app UI
  const app = document.getElementById('app');
  if (app) app.style.display = 'none';

  document.body.classList.add('updater-window-mode');

  // Render the updater panel first so we get safeClose back,
  // then wire it into the custom title bar (Windows only).
  // safeClose sets isClosing=true before closing the window, ensuring any
  // in-flight async work (check / downloadAndInstall) won't touch the DOM.
  const container = document.createElement('div');
  container.id = 'updater-window-container';
  document.body.appendChild(container);

  const safeClose = renderUpdaterWindow(container);

  if (isWindowsPlatform) {
    document.body.insertBefore(createCustomTitleBar(t('checkUpdates'), safeClose), container);
  }
}

// ── States ─────────────────────────────────────────────────────────────────────
// loading → ready → downloading → done / error

type State = 'loading' | 'ready' | 'no-update' | 'downloading' | 'error';

function renderUpdaterWindow(container: HTMLElement): () => void {
  container.innerHTML = '';
  let isClosing = false;
  const safeClose = () => {
    isClosing = true;
    void getCurrentWindow().close();
  };

  const root = document.createElement('div');
  root.className = 'updater-panel';

  // ── Header ──
  const header = document.createElement('div');
  header.className = 'updater-header';

  const iconEl = document.createElement('div');
  iconEl.className = 'updater-icon';
  iconEl.innerHTML = `<svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M12 2v10m0 0 3.5-3.5M12 12l-3.5-3.5"/>
    <path d="M4.93 15A8 8 0 1 0 12 4"/>
  </svg>`;

  const headerText = document.createElement('div');
  headerText.className = 'updater-header-text';

  const titleEl = document.createElement('h2');
  titleEl.className = 'updater-title';
  titleEl.textContent = t('checkUpdates');

  const subtitleEl = document.createElement('p');
  subtitleEl.className = 'updater-subtitle';
  subtitleEl.textContent = t('checkUpdatesChecking');

  headerText.appendChild(titleEl);
  headerText.appendChild(subtitleEl);
  header.appendChild(iconEl);
  header.appendChild(headerText);
  root.appendChild(header);

  // ── Notes area ──
  const notesWrap = document.createElement('div');
  notesWrap.className = 'updater-notes-wrap';
  notesWrap.style.display = 'none';
  root.appendChild(notesWrap);

  // ── Progress ──
  const progressWrap = document.createElement('div');
  progressWrap.className = 'updater-progress-wrap';
  progressWrap.style.display = 'none';

  const progressTrack = document.createElement('div');
  progressTrack.className = 'updater-progress-track';

  const progressFill = document.createElement('div');
  progressFill.className = 'updater-progress-fill';

  progressTrack.appendChild(progressFill);

  const progressLabel = document.createElement('span');
  progressLabel.className = 'updater-progress-label';

  progressWrap.appendChild(progressTrack);
  progressWrap.appendChild(progressLabel);
  root.appendChild(progressWrap);

  // ── Hint ──
  const hintEl = document.createElement('p');
  hintEl.className = 'updater-hint';
  hintEl.textContent = t('updateHint');
  hintEl.style.display = 'none';
  root.appendChild(hintEl);

  // ── Footer ──
  const footer = document.createElement('div');
  footer.className = 'updater-footer';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'updater-btn secondary';
  cancelBtn.textContent = t('updateLater');
  cancelBtn.onclick = safeClose;

  const updateBtn = document.createElement('button');
  updateBtn.className = 'updater-btn primary';
  updateBtn.textContent = t('updateNow');
  updateBtn.disabled = true;

  footer.appendChild(cancelBtn);
  footer.appendChild(updateBtn);
  root.appendChild(footer);

  container.appendChild(root);

  // ── State helpers ──
  function setState(state: State, extra?: string): void {
    switch (state) {
      case 'loading':
        subtitleEl.textContent = t('checkUpdatesChecking');
        iconEl.classList.remove('updater-icon-done');
        notesWrap.style.display = 'none';
        progressWrap.style.display = 'none';
        hintEl.style.display = 'none';
        updateBtn.disabled = true;
        cancelBtn.textContent = t('updateLater');
        footer.style.display = '';
        break;

      case 'no-update':
        titleEl.textContent = t('checkUpdatesUpToDate').split('.')[0] ?? t('checkUpdates');
        subtitleEl.textContent = '';
        iconEl.classList.add('updater-icon-done');
        notesWrap.style.display = 'none';
        progressWrap.style.display = 'none';
        hintEl.style.display = 'none';
        updateBtn.style.display = 'none';
        cancelBtn.textContent = t('updateModalClose');
        break;

      case 'ready':
        // extra = formatted version string
        subtitleEl.textContent = extra ?? '';
        hintEl.style.display = '';
        updateBtn.disabled = false;
        break;

      case 'downloading':
        updateBtn.style.display = 'none';
        cancelBtn.style.display = 'none';
        progressWrap.style.display = '';
        hintEl.style.display = '';
        break;

      case 'error':
        titleEl.textContent = t('updateFailed');
        titleEl.style.color = '#e05252';
        subtitleEl.textContent = extra ?? '';
        subtitleEl.style.color = '#e05252';
        notesWrap.style.display = 'none';
        progressWrap.style.display = 'none';
        hintEl.style.display = 'none';
        updateBtn.style.display = 'none';
        cancelBtn.textContent = t('updateModalClose');
        break;
    }
  }

  function setProgress(pct: number, label: string): void {
    progressFill.style.width = `${pct}%`;
    progressLabel.textContent = label;
  }

  // ── Check for update ──
  void (async () => {
    setState('loading');
    try {
      const update = await check();

      if (isClosing) return;
      if (!update) {
        setState('no-update');
        return;
      }

      // Render release notes
      const hasNotes = update.body && update.body.trim().length > 0;
      if (hasNotes) {
        const notesLabel = document.createElement('p');
        notesLabel.className = 'updater-notes-label';
        notesLabel.textContent = t('updateReleaseNotes');
        const notesBody = document.createElement('pre');
        notesBody.className = 'updater-notes-body';
        notesBody.textContent = update.body ?? '';
        notesWrap.appendChild(notesLabel);
        notesWrap.appendChild(notesBody);
        notesWrap.style.display = '';
      }

      setState('ready', t('updateModalTitle').replace('{version}', update.version));

      // ── Update Now button ──
      updateBtn.onclick = async () => {
        setState('downloading');
        setProgress(0, t('updateDownloading').replace('{pct}', '0'));

        let downloaded = 0;
        let total = 0;

        try {
          await update.downloadAndInstall((event) => {
            if (isClosing) return;
            if (event.event === 'Started') {
              total = (event.data as { contentLength?: number }).contentLength ?? 0;
            } else if (event.event === 'Progress') {
              downloaded += (event.data as { chunkLength: number }).chunkLength;
              const pct = total > 0 ? Math.min(99, Math.round((downloaded / total) * 100)) : 0;
              setProgress(pct, t('updateDownloading').replace('{pct}', String(pct)));
            } else if (event.event === 'Finished') {
              setProgress(100, t('updateFinishing'));
            }
          });

          if (isClosing) return;
          setProgress(100, t('updateRestarting'));
          await new Promise((r) => setTimeout(r, 800));
          await relaunch();
        } catch (err) {
          if (!isClosing) setState('error', String(err));
        }
      };
    } catch (err) {
      if (!isClosing) setState('error', String(err));
    }
  })();

  return safeClose;
}
