// Tab tear-off drag preview overlay — rendered as a small "mini window" with a
// titlebar (dragged tab's title) and a release hint. All content/theme is read
// from shared localStorage (same origin as the main app window); the source
// window writes it just before creating this overlay, so it's ready on load.
(function () {
  var DARK = {
    bg: '#1c1c1e', titlebar: '#2a2a2d', fg: '#e8e8e8',
    dim: '#9a9a9a', border: 'rgba(255,255,255,0.10)',
  };
  var LIGHT = {
    bg: '#fbfbfd', titlebar: '#ececef', fg: '#1a1a1a',
    dim: '#6a6a6a', border: 'rgba(0,0,0,0.12)',
  };

  function apply() {
    var data = {};
    try { data = JSON.parse(localStorage.getItem('meterm-drag-preview') || '{}'); } catch (e) { /* defaults */ }

    var pal = data.mode === 'light' ? LIGHT : DARK;
    var s = document.documentElement.style;
    s.setProperty('--pv-bg', pal.bg);
    s.setProperty('--pv-titlebar', pal.titlebar);
    s.setProperty('--pv-fg', pal.fg);
    s.setProperty('--pv-fg-dim', pal.dim);
    s.setProperty('--pv-border', pal.border);
    if (data.accent) s.setProperty('--pv-accent', data.accent);

    var titleEl = document.getElementById('title');
    if (titleEl) titleEl.textContent = data.title || 'Terminal';
    var hintEl = document.getElementById('hint');
    if (hintEl) hintEl.textContent = data.hint || 'Release to open in new window';
  }

  apply();
  // If the overlay window is reused across drags, pick up new title/theme.
  window.addEventListener('storage', apply);
})();
