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
  if (img && img.complete && img.naturalWidth > 0) {
    const rect = img.getBoundingClientRect();
    // Keyboard context menus may report (0,0); target the focused image itself.
    const keyboard = event.clientX === 0 && event.clientY === 0;
    const x = keyboard ? Math.max(0, rect.left + rect.width / 2) : event.clientX;
    const y = keyboard ? Math.max(0, rect.top + rect.height / 2) : event.clientY;
    const src = img.currentSrc || img.src;
    image = { x, y, ...(/^https?:\/\//i.test(src) ? { address: src } : {}) };
  }
  if (!link && !path && !image && !selection && !editable) return null;
  return { ...(link ? { link } : {}), ...(path ? { path } : {}), ...(image ? { image } : {}), ...(selection ? { selection } : {}), editable };
}

