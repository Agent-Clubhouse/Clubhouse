import { useEffect, type RefObject } from 'react';

/** True when the drag carries files from outside the app (Finder, Explorer). */
function carriesFiles(e: DragEvent): boolean {
  const types = e.dataTransfer?.types;
  return !!types && Array.from(types).includes('Files');
}

/**
 * Stop a file dropped on the canvas from opening in the window. Without a
 * handler, Chromium's default drop navigates the main window to the file's
 * `file://` URL. The canvas has no file drop target since blueprint import
 * was removed, so a dragged file is refused (no-drop cursor) and its drop is
 * swallowed. Drags that carry no files (cards, wires) are left alone.
 */
export function useFileDropGuard(containerRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onDragOver = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
    };
    const onDrop = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
    };
    el.addEventListener('dragover', onDragOver);
    el.addEventListener('drop', onDrop);
    return () => {
      el.removeEventListener('dragover', onDragOver);
      el.removeEventListener('drop', onDrop);
    };
  }, [containerRef]);
}
