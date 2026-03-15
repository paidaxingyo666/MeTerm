/**
 * overlay-scrollbar.ts — Reusable overlay scrollbar component
 *
 * Attaches a floating scrollbar (narrow by default, widens on hover)
 * to any scrollable element. Hides native scrollbar via CSS.
 */

export interface OverlayScrollbarOptions {
  /** The scrollable element (must have overflow-y: auto/scroll) */
  viewport: HTMLElement;
  /**
   * Parent element to append the scrollbar to.
   * Must be a non-scrolling ancestor with position: relative.
   * If same as viewport, uses inline mode (no DOM wrapping).
   */
  container: HTMLElement;
}

export interface OverlayScrollbarHandle {
  /** Force sync scrollbar position/size */
  sync(): void;
  /** Remove scrollbar and cleanup all listeners */
  destroy(): void;
}

export function createOverlayScrollbar(opts: OverlayScrollbarOptions): OverlayScrollbarHandle {
  let { viewport, container } = opts;

  // Inline mode: container === viewport. We can't put the scrollbar INSIDE the
  // scrollable element (WebKit scrolls absolute children with content, and they
  // extend scrollHeight). Instead, append bar to viewport's PARENT and use
  // getBoundingClientRect() to position it at the viewport's right edge.
  const inline = container === viewport;
  if (inline) {
    const parent = viewport.parentElement;
    if (parent) {
      const pp = getComputedStyle(parent).position;
      if (!pp || pp === 'static') parent.style.position = 'relative';
      container = parent;
    }
  }

  // Hide native scrollbar
  viewport.classList.add('overlay-sb-viewport');

  // Build overlay structure
  const bar = document.createElement('div');
  bar.className = 'overlay-sb';
  const track = document.createElement('div');
  track.className = 'overlay-sb-track';
  const thumb = document.createElement('div');
  thumb.className = 'overlay-sb-thumb';
  track.appendChild(thumb);
  bar.appendChild(track);
  container.appendChild(bar);

  // --- sync thumb position / size ---
  function sync(): void {
    const sh = viewport.scrollHeight;
    const ch = viewport.clientHeight;
    if (sh <= ch) {
      bar.style.display = 'none';
      return;
    }
    bar.style.display = '';

    // In inline mode, bar is in viewport's parent (positioned ancestor).
    // Use offset* for precise positioning relative to the parent.
    if (inline) {
      bar.style.top = `${viewport.offsetTop}px`;
      bar.style.bottom = 'auto';
      bar.style.left = `${viewport.offsetLeft + viewport.offsetWidth - 14}px`;
      bar.style.right = 'auto';
      bar.style.height = `${ch}px`;
    }

    const ratio = ch / sh;
    const thumbH = Math.max(20, ratio * ch);
    const maxScroll = sh - ch;
    const pct = maxScroll > 0 ? viewport.scrollTop / maxScroll : 0;
    const thumbTop = pct * (ch - thumbH);
    thumb.style.height = `${thumbH}px`;
    thumb.style.transform = `translateY(${thumbTop}px)`;
  }

  viewport.addEventListener('scroll', sync, { passive: true });
  const ro = new ResizeObserver(sync);
  ro.observe(viewport);
  const mo = new MutationObserver(sync);
  mo.observe(viewport, { childList: true, subtree: true, characterData: true });
  sync();

  // --- drag support ---
  let dragging = false;
  let dragStartY = 0;
  let dragStartScroll = 0;

  thumb.addEventListener('mousedown', (e: MouseEvent) => {
    dragging = true;
    dragStartY = e.clientY;
    dragStartScroll = viewport.scrollTop;
    bar.classList.add('dragging');
    e.preventDefault();
    e.stopPropagation();
  });

  const ac = new AbortController();

  document.addEventListener('mousemove', (e: MouseEvent) => {
    if (!dragging) return;
    const ch = viewport.clientHeight;
    const sh = viewport.scrollHeight;
    const ratio = ch / sh;
    const thumbH = Math.max(20, ratio * ch);
    const trackH = ch - thumbH;
    const maxScroll = sh - ch;
    const dy = e.clientY - dragStartY;
    viewport.scrollTop = dragStartScroll + (dy / trackH) * maxScroll;
  }, { signal: ac.signal });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    bar.classList.remove('dragging');
  }, { signal: ac.signal });

  // --- click-on-track to jump ---
  track.addEventListener('mousedown', (e: MouseEvent) => {
    if (e.target === thumb) return;
    const rect = track.getBoundingClientRect();
    const clickY = e.clientY - rect.top;
    const ch = viewport.clientHeight;
    const sh = viewport.scrollHeight;
    const maxScroll = sh - ch;
    viewport.scrollTop = (clickY / ch) * maxScroll;
    e.preventDefault();
  });

  // Cleanup on container removal
  const cleanupObs = new MutationObserver(() => {
    if (!container.isConnected) {
      destroy();
    }
  });
  if (container.parentNode) {
    cleanupObs.observe(container.parentNode, { childList: true });
  }

  function destroy(): void {
    ac.abort();
    ro.disconnect();
    mo.disconnect();
    cleanupObs.disconnect();
    bar.remove();
    viewport.classList.remove('overlay-sb-viewport');
  }

  return { sync, destroy };
}

