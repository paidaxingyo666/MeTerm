/**
 * Home Dashboard — Search overlay.
 * Floating panel below search bar with tabbed results (connections | web | tldr).
 * Both connections and web results use client-side pagination.
 * SearXNG results are fetched incrementally (pageno) and accumulated into a flat array.
 */
import { t } from './i18n';
import { icon } from './icons';
import { loadSettings } from './themes';
import { createOverlayScrollbar } from './overlay-scrollbar';
import { collectAllConnections, filterConnections, handleConnectionClick, escapeHtml, type ConnectionItem } from './home-dashboard-left';
import { searchSearXNG, searchTldr, type SearXNGResult } from './home-dashboard-search';
import { createTldrCard } from './tldr-card';

let currentRequestId = 0;
let activeTab: 'connections' | 'web' | 'tldr' = 'connections';

// Cache
let cachedQuery = '';
let cachedConnResults: ConnectionItem[] = [];
let cachedTldrCards: HTMLElement[] | null = null;
let cachedSearXNGLoaded = false;
let cachedTldrLoaded = false;

// SearXNG — accumulated results + server pagination state
let searxngAllResults: SearXNGResult[] = [];
let searxngServerPage = 1;       // next SearXNG pageno to fetch
let searxngServerHasMore = true;  // server has more pages
let searxngFetching = false;      // currently fetching a server page

// Client-side pagination (shared for connections & web)
let webCurrentPage = 1;
let webPerPage = 10;
let connCurrentPage = 1;
let connPerPage = 10;

// ─── Public API ───

export function renderSearchOverlay(overlay: HTMLElement, query: string): void {
  if (!query) {
    resetCache();
    hideSearchOverlay(overlay);
    return;
  }

  if (query !== cachedQuery) {
    resetCache();
    cachedQuery = query;
    startSearch(query, overlay);
  }

  overlay.style.display = '';
  const searchRow = overlay.parentElement;
  if (searchRow) {
    const rect = searchRow.getBoundingClientRect();
    overlay.style.top = `${rect.bottom + 4}px`;
    overlay.style.left = `${rect.left}px`;
    overlay.style.right = `${window.innerWidth - rect.right}px`;
    overlay.style.bottom = `${rect.left}px`;
  }
  renderTabbedView(overlay);
}

export function hideSearchOverlay(overlay: HTMLElement): void {
  overlay.style.display = 'none';
  overlay.innerHTML = '';
}

// ─── Internal ───

function resetCache(): void {
  cachedQuery = '';
  cachedConnResults = [];
  cachedTldrCards = null;
  cachedSearXNGLoaded = false;
  cachedTldrLoaded = false;
  searxngAllResults = [];
  searxngServerPage = 1;
  searxngServerHasMore = true;
  searxngFetching = false;
  webCurrentPage = 1;
  connCurrentPage = 1;
}

function startSearch(query: string, overlay: HTMLElement): void {
  const settings = loadSettings();
  const reqId = ++currentRequestId;

  // 1. Connections (synchronous)
  cachedConnResults = filterConnections(collectAllConnections(), query);
  connCurrentPage = 1;

  // 2. SearXNG (async, fetch first server page)
  if (settings.searxngEnabled && settings.searxngUrl) {
    cachedSearXNGLoaded = false;
    searxngAllResults = [];
    searxngServerPage = 1;
    searxngServerHasMore = true;
    webCurrentPage = 1;
    fetchNextSearXNGBatch(query, reqId, overlay);
  } else {
    cachedSearXNGLoaded = true;
  }

  // 3. tldr (async)
  if (settings.tldrEnabled) {
    cachedTldrCards = null;
    cachedTldrLoaded = false;
    searchTldr(query).then(results => {
      if (reqId !== currentRequestId) return;
      cachedTldrCards = [];
      for (const r of results) {
        if (r.result.page) {
          cachedTldrCards.push(createTldrCard(r.result.page, { compact: true }));
        }
      }
      cachedTldrLoaded = true;
      if (activeTab === 'tldr') refreshOverlay(overlay);
    });
  } else {
    cachedTldrCards = [];
    cachedTldrLoaded = true;
  }

  // Auto-select tab
  if (cachedConnResults.length > 0) {
    activeTab = 'connections';
  } else if (settings.searxngEnabled && settings.searxngUrl) {
    activeTab = 'web';
  } else if (settings.tldrEnabled) {
    activeTab = 'tldr';
  } else {
    activeTab = 'connections';
  }
}

/** Fetch one SearXNG server page and append to accumulated results. */
function fetchNextSearXNGBatch(query: string, reqId: number, overlay: HTMLElement): void {
  if (searxngFetching || !searxngServerHasMore) return;
  searxngFetching = true;
  const page = searxngServerPage;

  searchSearXNG(query, page).then(paged => {
    searxngFetching = false;
    if (reqId !== currentRequestId) return;

    if (paged.results.length > 0) {
      searxngAllResults = searxngAllResults.concat(paged.results);
      searxngServerPage = page + 1;
    }
    searxngServerHasMore = paged.hasMore && paged.results.length > 0;
    cachedSearXNGLoaded = true;
    if (activeTab === 'web') refreshOverlay(overlay);
  });
}

/** Ensure we have enough results to fill the requested client page. */
function ensureSearXNGResults(clientPage: number, overlay: HTMLElement): void {
  const needed = clientPage * webPerPage;
  if (searxngAllResults.length < needed && searxngServerHasMore && !searxngFetching) {
    fetchNextSearXNGBatch(cachedQuery, currentRequestId, overlay);
  }
}

function refreshOverlay(overlay: HTMLElement): void {
  if (overlay.style.display === 'none') return;
  renderTabbedView(overlay);
}

// ─── Tabbed view ───

function renderTabbedView(overlay: HTMLElement): void {
  overlay.innerHTML = '';
  overlay.style.display = 'flex';
  overlay.style.flexDirection = 'column';
  const settings = loadSettings();

  // Tab bar (top)
  const tabBar = document.createElement('div');
  tabBar.className = 'home-search-overlay-tabs';

  const tabs: { key: 'connections' | 'web' | 'tldr'; label: string; visible: boolean }[] = [
    { key: 'connections', label: t('homeSearchConnections'), visible: true },
    { key: 'web', label: t('homeSearchWeb'), visible: !!(settings.searxngEnabled && settings.searxngUrl) },
    { key: 'tldr', label: t('homeSearchTldr'), visible: !!settings.tldrEnabled },
  ];

  for (const tab of tabs) {
    if (!tab.visible) continue;
    const btn = document.createElement('button');
    btn.className = 'home-search-overlay-tab' + (activeTab === tab.key ? ' active' : '');
    btn.textContent = tab.label;

    const count = getTabCount(tab.key);
    if (count !== null) {
      const badge = document.createElement('span');
      badge.className = 'home-search-overlay-count';
      badge.textContent = searxngServerHasMore && tab.key === 'web' ? `${count}+` : String(count);
      btn.appendChild(badge);
    }

    btn.onclick = () => {
      activeTab = tab.key;
      renderTabbedView(overlay);
    };
    tabBar.appendChild(btn);
  }
  overlay.appendChild(tabBar);

  // Content (middle, scrollable)
  const content = document.createElement('div');
  content.className = 'home-search-overlay-content';
  renderActiveTabContent(content, overlay);
  overlay.appendChild(content);
  // Must be after appendChild — inline mode needs parentElement to exist
  createOverlayScrollbar({ viewport: content, container: content });

  // Pagination bar (bottom)
  if (shouldShowPagination()) {
    overlay.appendChild(createPaginationBar(overlay));
  }
}

function getTabCount(key: 'connections' | 'web' | 'tldr'): number | null {
  if (key === 'connections') return cachedConnResults.length;
  if (key === 'web') return cachedSearXNGLoaded ? searxngAllResults.length : null;
  if (key === 'tldr') return cachedTldrLoaded ? (cachedTldrCards?.length ?? 0) : null;
  return null;
}

function shouldShowPagination(): boolean {
  if (activeTab === 'connections') {
    return cachedConnResults.length > connPerPage;
  }
  if (activeTab === 'web') {
    if (!cachedSearXNGLoaded) return false;
    return searxngAllResults.length > webPerPage || searxngServerHasMore;
  }
  return false;
}

function renderActiveTabContent(content: HTMLElement, overlay: HTMLElement): void {
  content.innerHTML = '';

  if (activeTab === 'connections') {
    if (cachedConnResults.length === 0) {
      content.appendChild(createEmptyState(t('homeNoResults')));
    } else {
      const start = (connCurrentPage - 1) * connPerPage;
      const pageItems = cachedConnResults.slice(start, start + connPerPage);
      for (const item of pageItems) {
        content.appendChild(createConnectionResultRow(item));
      }
    }
  } else if (activeTab === 'web') {
    if (!cachedSearXNGLoaded && searxngFetching) {
      content.appendChild(createLoadingState());
    } else if (searxngAllResults.length === 0) {
      content.appendChild(createEmptyState(t('homeNoResults')));
    } else {
      const start = (webCurrentPage - 1) * webPerPage;
      const pageItems = searxngAllResults.slice(start, start + webPerPage);
      if (pageItems.length === 0 && searxngFetching) {
        // Waiting for next batch to arrive
        content.appendChild(createLoadingState());
      } else {
        for (const r of pageItems) {
          content.appendChild(createSearXNGResultCard(r));
        }
      }
      // Prefetch if near the end of loaded results
      ensureSearXNGResults(webCurrentPage + 1, overlay);
    }
  } else if (activeTab === 'tldr') {
    if (!cachedTldrLoaded) {
      content.appendChild(createLoadingState());
    } else if (!cachedTldrCards || cachedTldrCards.length === 0) {
      content.appendChild(createEmptyState(t('homeNoResults')));
    } else {
      for (const card of cachedTldrCards) {
        content.appendChild(card.cloneNode(true));
      }
    }
  }
}

// ─── Pagination bar ───

function createPaginationBar(overlay: HTMLElement): HTMLDivElement {
  const bar = document.createElement('div');
  bar.className = 'home-search-overlay-pagination';

  if (activeTab === 'connections') {
    const totalPages = Math.ceil(cachedConnResults.length / connPerPage);
    bar.appendChild(buildPaginationControls(
      connCurrentPage, totalPages, connPerPage,
      (p) => { connCurrentPage = p; renderTabbedView(overlay); },
      (pp) => { connPerPage = pp; connCurrentPage = 1; renderTabbedView(overlay); },
    ));
  } else if (activeTab === 'web') {
    // Total pages: known loaded + possibly more from server
    const loadedPages = Math.ceil(searxngAllResults.length / webPerPage);
    const totalPages = searxngServerHasMore ? loadedPages + 1 : loadedPages;
    const hasNext = webCurrentPage < loadedPages || searxngServerHasMore;
    bar.appendChild(buildPaginationControls(
      webCurrentPage, totalPages, webPerPage,
      (p) => {
        webCurrentPage = p;
        // If we don't have enough results, trigger a server fetch
        ensureSearXNGResults(p, overlay);
        renderTabbedView(overlay);
      },
      (pp) => { webPerPage = pp; webCurrentPage = 1; renderTabbedView(overlay); },
      webCurrentPage > 1,
      hasNext,
    ));
  }

  return bar;
}

function buildPaginationControls(
  currentPage: number,
  totalPages: number,
  perPage: number,
  onPageChange: (page: number) => void,
  onPerPageChange: (pp: number) => void,
  hasPrev?: boolean,
  hasNext?: boolean,
): HTMLDivElement {
  const wrap = document.createElement('div');
  wrap.className = 'home-search-pagination-controls';

  const prevDisabled = hasPrev !== undefined ? !hasPrev : currentPage <= 1;
  const nextDisabled = hasNext !== undefined ? !hasNext : currentPage >= totalPages;

  // Prev button
  const prevBtn = document.createElement('button');
  prevBtn.className = 'home-search-pagination-btn';
  prevBtn.innerHTML = icon('chevronLeft');
  prevBtn.disabled = prevDisabled;
  prevBtn.onclick = () => { if (!prevDisabled) onPageChange(currentPage - 1); };
  wrap.appendChild(prevBtn);

  // Page indicator
  const pageInfo = document.createElement('span');
  pageInfo.className = 'home-search-pagination-info';
  pageInfo.textContent = `${currentPage}`;
  wrap.appendChild(pageInfo);

  // Next button
  const nextBtn = document.createElement('button');
  nextBtn.className = 'home-search-pagination-btn';
  nextBtn.innerHTML = icon('chevronRight');
  nextBtn.disabled = nextDisabled;
  nextBtn.onclick = () => { if (!nextDisabled) onPageChange(currentPage + 1); };
  wrap.appendChild(nextBtn);

  // Per-page selector
  const perPageWrap = document.createElement('span');
  perPageWrap.className = 'home-search-pagination-perpage';

  const select = document.createElement('select');
  select.className = 'home-search-pagination-select';
  for (const n of [10, 20, 30, 50]) {
    const opt = document.createElement('option');
    opt.value = String(n);
    opt.textContent = `${n}`;
    if (n === perPage) opt.selected = true;
    select.appendChild(opt);
  }
  select.onchange = () => onPerPageChange(parseInt(select.value, 10));

  const label = document.createElement('span');
  label.className = 'home-search-pagination-label';
  label.textContent = t('homeSearchPerPage');
  perPageWrap.appendChild(select);
  perPageWrap.appendChild(label);
  wrap.appendChild(perPageWrap);

  return wrap;
}

// ─── Helper UI components ───

function createLoadingState(): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'home-search-overlay-loading';
  el.textContent = t('homeSearching');
  return el;
}

function createEmptyState(text: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'home-search-overlay-empty';
  el.textContent = text;
  return el;
}

function createConnectionResultRow(item: ConnectionItem): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'home-search-overlay-row';
  const iconName = item.type === 'ssh' ? 'ssh' : item.type === 'remote' ? 'remote' : item.type === 'jumpserver' ? 'jumpserver' : 'terminal';
  row.innerHTML = `<span class="home-search-overlay-row-icon">${icon(iconName)}</span><span class="home-search-overlay-row-name">${escapeHtml(item.name)}</span><span class="home-search-overlay-row-detail">${escapeHtml(item.detail)}</span>`;
  row.onclick = () => handleConnectionClick(item);
  return row;
}

function createSearXNGResultCard(result: SearXNGResult): HTMLDivElement {
  const card = document.createElement('div');
  card.className = 'home-search-overlay-web-card';
  card.innerHTML = `<div class="home-search-overlay-web-title">${escapeHtml(result.title)}</div><div class="home-search-overlay-web-url">${escapeHtml(result.url)}</div>` +
    (result.content ? `<div class="home-search-overlay-web-snippet">${escapeHtml(result.content)}</div>` : '');
  card.onclick = () => {
    import('@tauri-apps/plugin-opener').then(({ openUrl }) => openUrl(result.url)).catch(() => {});
  };
  return card;
}
