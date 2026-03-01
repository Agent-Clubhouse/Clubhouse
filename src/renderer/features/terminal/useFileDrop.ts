import { useState, useCallback } from 'react';

function isFileDrop(e: React.DragEvent): boolean {
  return Array.from(e.dataTransfer.types).includes('Files');
}

function formatDroppedPaths(files: FileList): string {
  return Array.from(files)
    .map((file) => {
      const path = window.clubhouse.getPathForFile(file);
      return path.includes(' ') ? `'${path}'` : path;
    })
    .join(' ');
}

/**
 * Provides drag-and-drop file support for terminal components.
 * When files are dropped, their absolute paths are passed to writeToPty.
 *
 * @param writeToPty - Called with formatted path string on drop
 * @returns isDragOver state and three React drag event handlers
 */
export function useFileDrop(writeToPty: (data: string) => void) {
  const [isDragOver, setIsDragOver] = useState(false);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!isFileDrop(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    // Only clear when leaving the outermost wrapper (not on child elements)
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsDragOver(false);
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    if (!e.dataTransfer.files.length) return;
    writeToPty(formatDroppedPaths(e.dataTransfer.files));
  }, [writeToPty]);

  return { isDragOver, handleDragOver, handleDragLeave, handleDrop };
}
