import type { ContentContextMenu } from './content-context-menu';

const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'tel', 'email', 'number']);

function selectionTouches(doc: Document, target: Element): boolean {
  const sel = doc.getSelection();
  if (!sel || sel.isCollapsed || !sel.toString()) return false;
  for (let i = 0; i < sel.rangeCount; i++) {
    if (sel.getRangeAt(i).intersectsNode(target)) return true;
  }
  return false;
}

/**
 * Read only rendered content. Copying never resolves or reads a named file.
 *
 * `verifyPoint: false` skips the image hit test, for callers whose event
 * coordinates are not real viewport coordinates (the canvas rescales them at
 * zoom). Such a result only says there is content to copy; never send it.
 */
export function contentContext(event: MouseEvent, doc: Document, verifyPoint = true): ContentContextMenu | null {
  const target = event.target;
  if (!(target instanceof Element)) return null;
  // Do not replace terminal, Monaco, or other menus that already own the event.
  const field = target.closest('input, textarea') as HTMLInputElement | HTMLTextAreaElement | null;
  if (field instanceof HTMLInputElement && field.type === 'password') return null;
  // Checkboxes, buttons, sliders and the like are not text, so they get no editing menu.
  const input = field instanceof HTMLInputElement && !TEXT_INPUT_TYPES.has(field.type) ? null : field;
  const editing = target.closest('[contenteditable]')?.getAttribute('contenteditable');
  const editable = !!(input && !input.disabled && !input.readOnly) || editing === '' || editing === 'true' || editing === 'plaintext-only';
  // Only a selection under the click counts, not one left in another panel.
  const selection = input
    ? input.selectionStart !== null && input.selectionEnd !== null && input.selectionStart !== input.selectionEnd
    : selectionTouches(doc, target);
  const anchor = target.closest('a');
  const local = anchor?.getAttribute('data-clubhouse-local-file');
  const href = anchor?.getAttribute('href');
  // Copy the destination as written, not resolved against the app's own URL.
  // App-owned inert local markers must never be copied as destinations.
  const link = local || (href && !href.startsWith('#clubhouse-local-file-') ? href : undefined);
  const path = !anchor ? target.closest('[data-chat-file]')?.getAttribute('data-chat-path') || undefined : undefined;
  const img = target.closest('img');
  let image: ContentContextMenu['image'];
  if (img) {
    const src = img.currentSrc || img.src;
    const address = /^https?:\/\//i.test(src) ? src : undefined;
    const loaded = img.complete && img.naturalWidth > 0;
    let point: { x: number; y: number } | undefined;
    if (loaded && verifyPoint && doc.defaultView) {
      const rect = img.getBoundingClientRect();
      const left = Math.max(0, rect.left), top = Math.max(0, rect.top);
      const right = Math.min(doc.defaultView.innerWidth, rect.right);
      const bottom = Math.min(doc.defaultView.innerHeight, rect.bottom);
      const keyboard = event.clientX === 0 && event.clientY === 0;
      const x = Math.round(keyboard ? (left + right) / 2 : event.clientX);
      const y = Math.round(keyboard ? (top + bottom) / 2 : event.clientY);
      // Verify the CSS point before main converts it to Electron's DIP units. Clipping, overlays,
      // zero size and offscreen images must not copy some other image's pixels.
      if (rect.width > 0 && rect.height > 0 && x >= left && x < right && y >= top && y < bottom
        && doc.elementFromPoint(x, y) === img) point = { x, y };
    }
    if (point || address) image = { ...(point ? { point } : {}), ...(address ? { address } : {}) };
    else if (loaded && !verifyPoint) image = {};
  }
  if (!link && !path && !image && !selection && !editable) return null;
  return { ...(link ? { link } : {}), ...(path ? { path } : {}), ...(image ? { image } : {}), ...(selection ? { selection } : {}), editable };
}
