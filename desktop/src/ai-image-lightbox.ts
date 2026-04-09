// ─── AI Capsule: Image Lightbox ────────────────────────────
// A tiny modal that shows a single image at large size with a
// dim backdrop. Used by the chat UI for both:
//   • Thumbnails attached to a tool card (e.g. read_screen output)
//   • Thumbnails attached to a user message (paste / drop upload)
//
// Behavior:
//   • Click thumbnail → opens lightbox
//   • Click backdrop OR top-right × → closes
//   • Esc → closes
//   • Image is sized to fit the viewport (max 92vw × 92vh) and
//     keeps its aspect ratio, never upscaled past natural size.
//   • Wheel zoom is intentionally NOT implemented to keep the
//     interaction simple — open / inspect / close is enough for
//     terminal screenshots.

let activeBackdrop: HTMLDivElement | null = null;
let activeKeyHandler: ((e: KeyboardEvent) => void) | null = null;

/**
 * Open the lightbox showing the given data URL or `data:` string.
 * If a lightbox is already open, the existing one is closed first.
 */
export function openImageLightbox(src: string, alt = ''): void {
  closeImageLightbox();

  const backdrop = document.createElement('div');
  backdrop.className = 'ai-img-lightbox-backdrop';

  const stage = document.createElement('div');
  stage.className = 'ai-img-lightbox-stage';

  const img = document.createElement('img');
  img.className = 'ai-img-lightbox-img';
  img.src = src;
  img.alt = alt;
  img.draggable = false;

  const closeBtn = document.createElement('button');
  closeBtn.className = 'ai-img-lightbox-close';
  closeBtn.type = 'button';
  closeBtn.title = 'Close (Esc)';
  closeBtn.innerHTML = `
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
      <line x1="4" y1="4" x2="14" y2="14"/>
      <line x1="14" y1="4" x2="4" y2="14"/>
    </svg>`;

  stage.appendChild(img);
  stage.appendChild(closeBtn);
  backdrop.appendChild(stage);
  document.body.appendChild(backdrop);

  // Click backdrop (but not the image / button) to dismiss.
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closeImageLightbox();
  });
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeImageLightbox();
  });
  // Stop clicks inside the stage from bubbling to the backdrop
  // dismisser. The close button has its own handler above.
  stage.addEventListener('click', (e) => {
    if (e.target !== backdrop) e.stopPropagation();
  });

  // Esc to close, capture phase to beat any focused inputs.
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeImageLightbox();
    }
  };
  document.addEventListener('keydown', onKey, true);

  activeBackdrop = backdrop;
  activeKeyHandler = onKey;
}

/** Close any currently-open lightbox. Idempotent. */
export function closeImageLightbox(): void {
  if (activeKeyHandler) {
    document.removeEventListener('keydown', activeKeyHandler, true);
    activeKeyHandler = null;
  }
  if (activeBackdrop) {
    activeBackdrop.remove();
    activeBackdrop = null;
  }
}

/**
 * Wire an existing <img> element so clicking it opens the lightbox.
 * Adds a `cursor: zoom-in` hint via class.
 */
export function attachLightboxClick(img: HTMLImageElement): void {
  img.classList.add('ai-img-zoomable');
  img.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openImageLightbox(img.src, img.alt);
  });
}
