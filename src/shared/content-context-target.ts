import type { ContentContextMenu } from './content-context-menu';

/** Read only rendered content. Copying never resolves or reads a named file. */
export function contentContext(event: MouseEvent, doc: Document): ContentContextMenu | null {
  const target = event.target;
  if (!(target instanceof Element)) return null;
  // Do not replace terminal, Monaco, or other menus that already own the event.
  const input = target.closest('input, textarea') as HTMLInputElement | HTMLTextAreaElement | null;
  if (input instanceof HTMLInputElement && input.type === 'password') return null;
  const editing = target.closest('[contenteditable]')?.getAttribute('contenteditable');
  const editable = !!(input && !input.disabled && !input.readOnly) || editing === '' || editing === 'true' || editing === 'plaintext-only';
  let selection = doc.getSelection()?.toString() || undefined;
  if (input && input.selectionStart !== null && input.selectionEnd !== null) {
    selection = input.value.slice(input.selectionStart, input.selectionEnd) || undefined;
  }
  const anchor = target.closest('a');
  const local = anchor?.getAttribute('data-clubhouse-local-file');
  const href = anchor?.getAttribute('href');
  // App-owned inert local markers must never be copied as destinations.
  const link = local || (href && !href.startsWith('#clubhouse-local-file-') ? anchor?.href : undefined);
  const path = !anchor ? target.closest('[data-chat-file]')?.getAttribute('data-chat-path') || undefined : undefined;
  const img = target.closest('img');
  let image: ContentContextMenu['image'];
  if (img) {
    const src = img.currentSrc || img.src;
    const address = /^https?:\/\//i.test(src) ? src : undefined;
    let point: { x: number; y: number } | undefined;
    if (img.complete && img.naturalWidth > 0 && doc.defaultView) {
      const rect = img.getBoundingClientRect();
      const left = Math.max(0, rect.left), top = Math.max(0, rect.top);
      const right = Math.min(doc.defaultView.innerWidth, rect.right);
      const bottom = Math.min(doc.defaultView.innerHeight, rect.bottom);
      const keyboard = event.clientX === 0 && event.clientY === 0;
      const x = Math.round(keyboard ? (left + right) / 2 : event.clientX);
      const y = Math.round(keyboard ? (top + bottom) / 2 : event.clientY);
      // Hit-test the exact integer point sent to Electron. Clipping, overlays,
      // zero size and offscreen images must not copy some other image's pixels.
      if (rect.width > 0 && rect.height > 0 && x >= left && x < right && y >= top && y < bottom
        && doc.elementFromPoint(x, y) === img) point = { x, y };
    }
    if (point || address) image = { ...(point ? { point } : {}), ...(address ? { address } : {}) };
  }
  if (!link && !path && !image && !selection && !editable) return null;
  return { ...(link ? { link } : {}), ...(path ? { path } : {}), ...(image ? { image } : {}), ...(selection ? { selection } : {}), editable };
}

