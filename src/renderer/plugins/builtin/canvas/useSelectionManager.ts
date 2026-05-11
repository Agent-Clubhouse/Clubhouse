/**
 * useSelectionManager — lasso selection rect, multi-drag, and single-drag tracking.
 *
 * Extracted from CanvasWorkspace so selection state changes don't force a
 * full re-render of the viewport or zone layers.
 */

import { useState, useCallback, useEffect } from 'react';
import type { CanvasView, Viewport, Position } from './canvas-types';
import { screenToCanvas, isViewFullyInRect, snapPosition } from './canvas-operations';

export interface SelectionRect {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
}

export interface MultiDragState {
  dragViewId: string;
  startMouseX: number;
  startMouseY: number;
}

export interface SelectionManagerOptions {
  views: CanvasView[];
  viewport: Viewport;
  selectedViewIds: string[];
  containerRef: React.RefObject<HTMLDivElement | null>;
  onSetSelectedViewIds: (ids: string[]) => void;
  onMoveViews: (positions: Map<string, Position>) => void;
  onClearSelection: () => void;
}

export interface SelectionManagerResult {
  selectionRect: SelectionRect | null;
  multiDrag: MultiDragState | null;
  multiDragDelta: { dx: number; dy: number };
  singleDragPos: Map<string, Position>;
  handleViewMultiDragStart: (viewId: string, mouseX: number, mouseY: number) => void;
  handleViewDragMove: (viewId: string, position: Position) => void;
  handleViewDragEnd: (viewId: string, position: Position, onMoveView: (id: string, pos: Position) => void) => void;
  startSelectionRect: (canvasX: number, canvasY: number) => void;
  clearSingleDragPos: (viewId: string) => void;
  setSingleDragPos: React.Dispatch<React.SetStateAction<Map<string, Position>>>;
}

export function useSelectionManager({
  views,
  viewport,
  selectedViewIds,
  containerRef,
  onSetSelectedViewIds,
  onMoveViews,
  onClearSelection,
}: SelectionManagerOptions): SelectionManagerResult {
  const [selectionRect, setSelectionRect] = useState<SelectionRect | null>(null);
  const [multiDrag, setMultiDrag] = useState<MultiDragState | null>(null);
  const [multiDragDelta, setMultiDragDelta] = useState<{ dx: number; dy: number }>({ dx: 0, dy: 0 });
  const [singleDragPos, setSingleDragPos] = useState<Map<string, Position>>(new Map());

  const startSelectionRect = useCallback((canvasX: number, canvasY: number) => {
    setSelectionRect({ startX: canvasX, startY: canvasY, currentX: canvasX, currentY: canvasY });
  }, []);

  // Lasso selection tracking
  useEffect(() => {
    if (!selectionRect) return;

    const handleMouseMove = (e: MouseEvent) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const canvasPos = screenToCanvas(e.clientX, e.clientY, rect, viewport);
      setSelectionRect((prev) => prev ? { ...prev, currentX: canvasPos.x, currentY: canvasPos.y } : null);
    };

    const handleMouseUp = () => {
      if (selectionRect) {
        const rectObj = {
          x: Math.min(selectionRect.startX, selectionRect.currentX),
          y: Math.min(selectionRect.startY, selectionRect.currentY),
          width: Math.abs(selectionRect.currentX - selectionRect.startX),
          height: Math.abs(selectionRect.currentY - selectionRect.startY),
        };
        const contained = views.filter((v) => isViewFullyInRect(v, rectObj)).map((v) => v.id);
        if (contained.length > 0) {
          onSetSelectedViewIds(contained);
        }
      }
      setSelectionRect(null);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [selectionRect, viewport, views, onSetSelectedViewIds, containerRef]);

  // Multi-drag tracking
  const handleViewMultiDragStart = useCallback((viewId: string, mouseX: number, mouseY: number) => {
    if (selectedViewIds.length > 1 && selectedViewIds.includes(viewId)) {
      setMultiDrag({ dragViewId: viewId, startMouseX: mouseX, startMouseY: mouseY });
      setMultiDragDelta({ dx: 0, dy: 0 });
    }
  }, [selectedViewIds]);

  useEffect(() => {
    if (!multiDrag) return;

    const handleMouseMove = (e: MouseEvent) => {
      const dx = (e.clientX - multiDrag.startMouseX) / viewport.zoom;
      const dy = (e.clientY - multiDrag.startMouseY) / viewport.zoom;
      setMultiDragDelta({ dx, dy });
    };

    const handleMouseUp = (e: MouseEvent) => {
      const dx = (e.clientX - multiDrag.startMouseX) / viewport.zoom;
      const dy = (e.clientY - multiDrag.startMouseY) / viewport.zoom;
      const positions = new Map<string, Position>();
      for (const v of views) {
        if (selectedViewIds.includes(v.id)) {
          positions.set(v.id, snapPosition({ x: v.position.x + dx, y: v.position.y + dy }));
        }
      }
      if (positions.size > 0) {
        onMoveViews(positions);
      }
      setMultiDrag(null);
      setMultiDragDelta({ dx: 0, dy: 0 });
      onClearSelection();
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [multiDrag, viewport.zoom, views, selectedViewIds, onMoveViews, onClearSelection]);

  const handleViewDragMove = useCallback((viewId: string, position: Position) => {
    setSingleDragPos((prev) => {
      const next = new Map(prev);
      next.set(viewId, position);
      return next;
    });
  }, []);

  const handleViewDragEnd = useCallback((viewId: string, position: Position, onMoveView: (id: string, pos: Position) => void) => {
    setSingleDragPos((prev) => {
      const next = new Map(prev);
      next.delete(viewId);
      return next;
    });
    if (multiDrag && multiDrag.dragViewId === viewId) return;
    onMoveView(viewId, snapPosition(position));
  }, [multiDrag]);

  const clearSingleDragPos = useCallback((viewId: string) => {
    setSingleDragPos((prev) => {
      const next = new Map(prev);
      next.delete(viewId);
      return next;
    });
  }, []);

  return {
    selectionRect,
    multiDrag,
    multiDragDelta,
    singleDragPos,
    handleViewMultiDragStart,
    handleViewDragMove,
    handleViewDragEnd,
    startSelectionRect,
    clearSingleDragPos,
    setSingleDragPos,
  };
}
