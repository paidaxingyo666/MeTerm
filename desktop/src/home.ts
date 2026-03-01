import { TerminalRegistry } from './terminal';
import { AppSettings } from './themes';
import { t } from './i18n';
import { icon } from './icons';

let refreshInterval: ReturnType<typeof setInterval> | null = null;
let currentSettings: AppSettings | null = null;
const lastThumbnailBySession = new Map<string, string>();
const thumbLayerIndexBySession = new Map<string, number>();
const THUMB_LAYER_A_CLASS = 'session-preview-layer-a';
const THUMB_LAYER_B_CLASS = 'session-preview-layer-b';

function ensurePreviewLayers(preview: HTMLDivElement): { front: HTMLDivElement; back: HTMLDivElement } {
  let layerA = preview.querySelector(`.${THUMB_LAYER_A_CLASS}`) as HTMLDivElement | null;
  let layerB = preview.querySelector(`.${THUMB_LAYER_B_CLASS}`) as HTMLDivElement | null;

  if (!layerA) {
    layerA = document.createElement('div');
    layerA.className = `session-preview-layer ${THUMB_LAYER_A_CLASS}`;
    preview.appendChild(layerA);
  }

  if (!layerB) {
    layerB = document.createElement('div');
    layerB.className = `session-preview-layer ${THUMB_LAYER_B_CLASS}`;
    preview.appendChild(layerB);
  }

  return { front: layerA, back: layerB };
}

function applyInitialThumbnail(preview: HTMLDivElement, sessionId: string, thumbnail: string): void {
  const { front, back } = ensurePreviewLayers(preview);
  front.style.zIndex = '2';
  back.style.zIndex = '1';
  front.style.backgroundImage = `url(${thumbnail})`;
  front.classList.add('visible');
  back.classList.remove('visible');
  back.style.backgroundImage = '';
  thumbLayerIndexBySession.set(sessionId, 0);
  preview.classList.add('has-thumbnail');
  preview.innerHTML = '';
  preview.appendChild(front);
  preview.appendChild(back);
}

function crossFadeThumbnail(preview: HTMLDivElement, sessionId: string, thumbnail: string): void {
  const { front: layerA, back: layerB } = ensurePreviewLayers(preview);
  const activeIndex = thumbLayerIndexBySession.get(sessionId) || 0;
  const activeLayer = activeIndex === 0 ? layerA : layerB;
  const nextLayer = activeIndex === 0 ? layerB : layerA;

  nextLayer.style.zIndex = '2';
  activeLayer.style.zIndex = '1';
  nextLayer.style.backgroundImage = `url(${thumbnail})`;
  nextLayer.classList.add('visible');
  activeLayer.classList.remove('visible');
  thumbLayerIndexBySession.set(sessionId, activeIndex === 0 ? 1 : 0);
  preview.classList.add('has-thumbnail');
}

function setPlaceholder(preview: HTMLDivElement, sessionId: string): void {
  preview.classList.remove('has-thumbnail');
  preview.innerHTML = '<div class="session-preview-placeholder">…</div>';
  thumbLayerIndexBySession.delete(sessionId);
}

function sessionStatusLabel(status: string): string {
  if (status === 'connecting') return t('connecting');
  if (status === 'connected') return t('connected');
  if (status === 'reconnecting') return t('reconnecting');
  if (status === 'ended') return t('ended');
  if (status === 'notfound') return t('sessionNotFound');
  return t('disconnected');
}

function syncHomeTitleMarquee(): void {
  const wraps = Array.from(document.querySelectorAll('.session-title-wrap')) as HTMLDivElement[];
  wraps.forEach((wrap) => {
    const track = wrap.querySelector('.session-title-track') as HTMLSpanElement | null;
    const primary = wrap.querySelector('.session-title-text.primary') as HTMLSpanElement | null;
    if (!track || !primary) return;

    const shouldScroll = primary.scrollWidth > wrap.clientWidth + 2;
    if (shouldScroll) {
      const gap = 20;
      wrap.style.setProperty('--session-title-shift', `${primary.scrollWidth + gap}px`);
      wrap.classList.add('is-overflowing');
    } else {
      wrap.style.removeProperty('--session-title-shift');
      wrap.classList.remove('is-overflowing');
      track.style.transform = 'translateX(0)';
    }
  });
}

export function setHomeViewSettings(settings: AppSettings): void {
  currentSettings = settings;
  restartThumbnailRefresh();
}

function updateThumbnails(): void {
  const homeView = document.getElementById('home-view');
  if (!homeView || homeView.offsetParent === null) return;

  const sessions = TerminalRegistry.getAllSessions();
  const activeSessionIds = new Set(sessions.map((s) => s.id));
  Array.from(lastThumbnailBySession.keys()).forEach((id) => {
    if (!activeSessionIds.has(id)) {
      lastThumbnailBySession.delete(id);
      thumbLayerIndexBySession.delete(id);
    }
  });

  sessions.forEach((session) => {
    const preview = document.getElementById(`preview-${session.id}`) as HTMLDivElement;
    if (preview) {
      const thumbnail = TerminalRegistry.captureThumbnail(session.id, 560, 320);
      const lastThumbnail = lastThumbnailBySession.get(session.id) || null;
      if (thumbnail) {
        if (thumbnail !== lastThumbnail) {
          if (!lastThumbnail) {
            applyInitialThumbnail(preview, session.id, thumbnail);
          } else {
            crossFadeThumbnail(preview, session.id, thumbnail);
          }
          lastThumbnailBySession.set(session.id, thumbnail);
        }
      } else {
        if (!lastThumbnail) {
          setPlaceholder(preview, session.id);
        }
      }
    }
  });
}

export function startThumbnailRefresh(): void {
  if (refreshInterval) return;
  
  const rate = currentSettings?.previewRefreshRate || 1000;
  updateThumbnails();
  refreshInterval = setInterval(updateThumbnails, rate);
}

export function stopThumbnailRefresh(): void {
  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }
}

export function restartThumbnailRefresh(): void {
  stopThumbnailRefresh();
  startThumbnailRefresh();
}

export function createHomeView(): HTMLDivElement {
  const container = document.createElement('div');
  container.className = 'home-view';
  container.id = 'home-view';

  const gridContainer = document.createElement('div');
  gridContainer.className = 'sessions-grid';
  gridContainer.id = 'sessions-grid';

  const emptyState = document.createElement('div');
  emptyState.className = 'empty-state';
  emptyState.innerHTML = `
    <div class="empty-icon">${icon('terminal')}</div>
    <p>${t('noSessions')}</p>
    <p class="empty-hint">${t('newSessionHint')}</p>
  `;
  gridContainer.appendChild(emptyState);
  container.appendChild(gridContainer);

  return container;
}

export function updateHomeView(): void {
  const grid = document.getElementById('sessions-grid');
  if (!grid) return;

  grid.innerHTML = '';

  const sessions = TerminalRegistry.getAllSessions();

  if (sessions.length === 0) {
    const emptyState = document.createElement('div');
    emptyState.className = 'empty-state';
    emptyState.innerHTML = `
      <div class="empty-icon">${icon('terminal')}</div>
      <p>${t('noSessions')}</p>
      <p class="empty-hint">${t('newSessionHint')}</p>
    `;
    grid.appendChild(emptyState);
    return;
  }

  sessions.forEach((session) => {
    const card = document.createElement('div');
    card.className = 'session-card';
    card.dataset.sessionId = session.id;

    const preview = document.createElement('div');
    preview.className = 'session-preview';
    preview.id = `preview-${session.id}`;
    setPlaceholder(preview, session.id);
    const cachedThumbnail = lastThumbnailBySession.get(session.id) || null;
    if (cachedThumbnail) {
      applyInitialThumbnail(preview, session.id, cachedThumbnail);
    }

    const info = document.createElement('div');
    info.className = 'session-info';

    const titleWrap = document.createElement('div');
    titleWrap.className = 'session-title-wrap';
    titleWrap.title = session.title;

    const titleTrack = document.createElement('span');
    titleTrack.className = 'session-title-track';

    const primary = document.createElement('span');
    primary.className = 'session-title-text primary';
    primary.textContent = session.title;

    const duplicate = document.createElement('span');
    duplicate.className = 'session-title-text duplicate';
    duplicate.textContent = session.title;
    duplicate.setAttribute('aria-hidden', 'true');

    titleTrack.appendChild(primary);
    titleTrack.appendChild(duplicate);
    titleWrap.appendChild(titleTrack);

    const status = document.createElement('span');
    status.className = `session-status ${session.status}`;
    status.textContent = sessionStatusLabel(session.status);

    info.appendChild(titleWrap);
    info.appendChild(status);

    card.appendChild(preview);
    card.appendChild(info);
    card.onclick = () => {
      const event = new CustomEvent('session-select', { detail: session.id });
      document.dispatchEvent(event);
    };

    grid.appendChild(card);
  });

  requestAnimationFrame(() => {
    syncHomeTitleMarquee();
    updateThumbnails();
  });
}
