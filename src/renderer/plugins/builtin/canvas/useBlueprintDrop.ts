// ── Blueprint Drag-Drop + Clipboard Paste Hook ─────────────────────
//
// Provides drag-drop and Ctrl+V paste support for importing blueprint
// JSON files directly onto the canvas workspace.

import { useState, useCallback, useEffect, useRef } from 'react';
import { importBlueprint, validateBlueprint } from './canvas-blueprint';
import type { CanvasInstance } from './canvas-types';

export interface BlueprintDropState {
  /** Whether a valid file is being dragged over the drop zone */
  isDragOver: boolean;
}

export interface UseBlueprintDropOptions {
  /** Ref to the container element acting as the drop zone */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** Callback when a valid blueprint is imported */
  onImport: (canvas: CanvasInstance) => void;
  /** Callback for user-facing error messages */
  onError: (message: string) => void;
}

/**
 * Check if a drag event contains at least one .json file.
 * Uses DataTransfer.items for type checking during dragover
 * (file contents aren't available until drop).
 */
function hasJsonFile(e: DragEvent): boolean {
  if (!e.dataTransfer) return false;

  // During dragover, items are available but not file contents
  if (e.dataTransfer.items) {
    for (let i = 0; i < e.dataTransfer.items.length; i++) {
      const item = e.dataTransfer.items[i];
      if (item.kind === 'file' && (item.type === 'application/json' || item.type === '')) {
        return true;
      }
    }
  }

  // Fallback: check files (available on drop)
  if (e.dataTransfer.files) {
    for (let i = 0; i < e.dataTransfer.files.length; i++) {
      if (e.dataTransfer.files[i].name.endsWith('.json')) return true;
    }
  }

  return false;
}

/**
 * Extract .json files from a drop event.
 */
function getJsonFiles(e: DragEvent): File[] {
  if (!e.dataTransfer?.files) return [];
  const files: File[] = [];
  for (let i = 0; i < e.dataTransfer.files.length; i++) {
    const file = e.dataTransfer.files[i];
    if (file.name.endsWith('.json')) files.push(file);
  }
  return files;
}

/**
 * Try to parse and import a blueprint from raw JSON text.
 * Returns the imported CanvasInstance or throws with a user-facing message.
 */
function parseAndImportBlueprint(text: string): CanvasInstance {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Not a valid JSON file');
  }

  const error = validateBlueprint(data);
  if (error) throw new Error(error);

  return importBlueprint(data as any);
}

/**
 * Hook that adds blueprint drag-drop and clipboard paste to a canvas container.
 *
 * - Drag a .json file onto the canvas to import it
 * - Press Ctrl/Cmd+V with blueprint JSON in clipboard to import
 * - Shows visual drop overlay while dragging
 * - Ignores non-.json files silently
 * - Shows error toast for invalid blueprint JSON
 */
export function useBlueprintDrop({ containerRef, onImport, onError }: UseBlueprintDropOptions): BlueprintDropState {
  const [isDragOver, setIsDragOver] = useState(false);
  // Track nested dragenter/dragleave events (child elements fire extra events)
  const dragCounterRef = useRef(0);

  // ── Drag handlers ───────────────────────────────────────────────────

  const handleDragEnter = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current++;
    if (hasJsonFile(e)) {
      setIsDragOver(true);
    }
  }, []);

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = hasJsonFile(e) ? 'copy' : 'none';
    }
  }, []);

  const handleDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current--;
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0;
      setIsDragOver(false);
    }
  }, []);

  const handleDrop = useCallback(async (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current = 0;
    setIsDragOver(false);

    const files = getJsonFiles(e);
    if (files.length === 0) return; // Non-.json files: silently ignore

    // Import the first .json file
    try {
      const text = await files[0].text();
      const canvas = parseAndImportBlueprint(text);
      onImport(canvas);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to import blueprint');
    }
  }, [onImport, onError]);

  // ── Clipboard paste handler ─────────────────────────────────────────

  const handlePaste = useCallback(async (e: ClipboardEvent) => {
    const text = e.clipboardData?.getData('text/plain');
    if (!text) return;

    // Quick check: must look like JSON with blueprint fields
    const trimmed = text.trim();
    if (!trimmed.startsWith('{') || !trimmed.includes('"version"') || !trimmed.includes('"views"')) return;

    try {
      const canvas = parseAndImportBlueprint(trimmed);
      e.preventDefault(); // Only prevent default if we successfully parsed
      onImport(canvas);
    } catch {
      // Not a valid blueprint — let the paste event propagate normally
    }
  }, [onImport]);

  // ── Attach event listeners ──────────────────────────────────────────

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    el.addEventListener('dragenter', handleDragEnter);
    el.addEventListener('dragover', handleDragOver);
    el.addEventListener('dragleave', handleDragLeave);
    el.addEventListener('drop', handleDrop);
    el.addEventListener('paste', handlePaste as EventListener);

    return () => {
      el.removeEventListener('dragenter', handleDragEnter);
      el.removeEventListener('dragover', handleDragOver);
      el.removeEventListener('dragleave', handleDragLeave);
      el.removeEventListener('drop', handleDrop);
      el.removeEventListener('paste', handlePaste as EventListener);
    };
  }, [containerRef, handleDragEnter, handleDragOver, handleDragLeave, handleDrop, handlePaste]);

  return { isDragOver };
}
