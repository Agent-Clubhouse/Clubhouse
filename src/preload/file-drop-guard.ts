/**
 * App-wide guard against dropping files or links on the window.
 *
 * Chromium's default action for a file or link dropped where no handler
 * cancels the drag is to navigate the window to it. For a file, that would
 * replace the UI with a local page that still has the privileged preload. For
 * a link, the main process blocks the navigation and would open the link in
 * the system browser, which is surprising for a stray drop.
 *
 * Listens on the document in the capture phase, so it runs before any surface
 * handler, and only calls preventDefault: it never stops propagation, so chat
 * attachments, the canvas, file chips, FirstRun and the rest still get the
 * event and decide what a drop does. A surface that wants links reads them
 * from the same drop event.
 *
 * - Files: always cancelled.
 * - Links (text/uri-list) without files: cancelled, except over an editable
 *   field, where the browser's own default inserts the link as text.
 * - Other drags (plain text, internal reorders): left alone.
 */
function hasType(event: DragEvent, type: string): boolean {
  const types = event.dataTransfer?.types;
  if (!types) return false;
  return Array.prototype.includes.call(types, type) as boolean;
}

function isEditable(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).closest !== 'function') return false;
  const el = target as HTMLElement;
  if (el.isContentEditable) return true;
  return el.closest('input, textarea, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]') !== null;
}

export function installFileDropGuard(doc: Document): () => void {
  const listener = (event: DragEvent) => {
    if (hasType(event, 'Files')) {
      event.preventDefault();
    } else if (hasType(event, 'text/uri-list') && !isEditable(event.target)) {
      event.preventDefault();
    }
  };
  doc.addEventListener('dragover', listener, true);
  doc.addEventListener('drop', listener, true);
  return () => {
    doc.removeEventListener('dragover', listener, true);
    doc.removeEventListener('drop', listener, true);
  };
}
