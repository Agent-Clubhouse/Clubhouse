/**
 * App-wide guard against dropping files on the window.
 *
 * Chromium's default action for a file dropped where no handler cancels the
 * drag is to navigate the window to that file. In the app window that would
 * replace the UI with a local page that still has the privileged preload.
 *
 * Listens on the document in the capture phase, so it runs before any surface
 * handler, and only calls preventDefault: it never stops propagation, so chat
 * attachments, the canvas, file chips, FirstRun and the rest still get the
 * event and decide what a drop does. Drags without files (text, internal
 * reorders) are left alone.
 */
function carriesFiles(event: DragEvent): boolean {
  const types = event.dataTransfer?.types;
  if (!types) return false;
  return Array.prototype.includes.call(types, 'Files') as boolean;
}

export function installFileDropGuard(doc: Document): () => void {
  const listener = (event: DragEvent) => {
    if (carriesFiles(event)) event.preventDefault();
  };
  doc.addEventListener('dragover', listener, true);
  doc.addEventListener('drop', listener, true);
  return () => {
    doc.removeEventListener('dragover', listener, true);
    doc.removeEventListener('drop', listener, true);
  };
}
