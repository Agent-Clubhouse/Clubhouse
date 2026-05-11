/**
 * useZoneManager — zone drag, zone resize, and zone delete confirmation.
 *
 * Extracted from CanvasWorkspace to keep zone interaction state out of the
 * top-level component, enabling independent re-renders for zone operations.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import type { ZoneCanvasView, CanvasView, Viewport, Position, Size } from './canvas-types';
import { MIN_VIEW_WIDTH, MIN_VIEW_HEIGHT } from './canvas-types';
import type { ResizeDirection } from './CanvasView';
import { snapPosition, snapSize } from './canvas-operations';

export interface ZoneDragState {
  zoneId: string;
  containedViewIds: string[];
}

export interface ZoneResizeState {
  zoneId: string;
  size: Size;
  position: Position;
}

export interface ZoneDeleteDialogState {
  zoneId: string;
  zoneName: string;
  containedCount: number;
}

export interface ZoneManagerOptions {
  zones: ZoneCanvasView[];
  views: CanvasView[];
  viewport: Viewport;
  onRemoveZone: (zoneId: string, removeContents: boolean) => void;
  onMoveViews: (positions: Map<string, Position>) => void;
  onMoveView: (viewId: string, position: Position) => void;
  onResizeView: (viewId: string, size: Size) => void;
  onSingleDragPosChange: (positions: Map<string, Position>) => void;
}

export interface ZoneManagerResult {
  zoneDrag: ZoneDragState | null;
  zoneDragDelta: { dx: number; dy: number };
  zoneResize: ZoneResizeState | null;
  zoneDeleteDialog: ZoneDeleteDialogState | null;
  handleZoneDragStart: (zoneId: string, e: React.MouseEvent) => void;
  handleZoneResizeStart: (zoneId: string, direction: ResizeDirection, e: React.MouseEvent) => void;
  handleZoneDelete: (zoneId: string) => void;
  handleZoneDeleteConfirm: (removeContents: boolean) => void;
  handleZoneDeleteCancel: () => void;
}

export function useZoneManager({
  zones,
  views,
  viewport,
  onRemoveZone,
  onMoveViews,
  onMoveView,
  onResizeView,
  onSingleDragPosChange,
}: ZoneManagerOptions): ZoneManagerResult {
  const [zoneDrag, setZoneDrag] = useState<ZoneDragState | null>(null);
  const [zoneDragDelta, setZoneDragDelta] = useState<{ dx: number; dy: number }>({ dx: 0, dy: 0 });
  const [zoneResize, setZoneResize] = useState<ZoneResizeState | null>(null);
  const [zoneDeleteDialog, setZoneDeleteDialog] = useState<ZoneDeleteDialogState | null>(null);
  const zoneDragCleanupRef = useRef<(() => void) | null>(null);

  const handleZoneDragStart = useCallback((zoneId: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const zone = zones.find((z) => z.id === zoneId);
    if (!zone) return;

    zoneDragCleanupRef.current?.();

    setZoneDrag({ zoneId, containedViewIds: [...zone.containedViewIds] });
    setZoneDragDelta({ dx: 0, dy: 0 });

    const startMouseX = e.clientX;
    const startMouseY = e.clientY;
    const startPositions = new Map<string, Position>();
    startPositions.set(zone.id, zone.position);
    for (const viewId of zone.containedViewIds) {
      const view = views.find((v) => v.id === viewId);
      if (view) startPositions.set(viewId, view.position);
    }

    const cleanup = () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
      window.removeEventListener('blur', handleBlur);
      zoneDragCleanupRef.current = null;
    };

    const handleMove = (ev: MouseEvent) => {
      const dx = (ev.clientX - startMouseX) / viewport.zoom;
      const dy = (ev.clientY - startMouseY) / viewport.zoom;
      setZoneDragDelta({ dx, dy });
      const dragPositions = new Map<string, Position>();
      for (const [id, pos] of startPositions) {
        dragPositions.set(id, { x: pos.x + dx, y: pos.y + dy });
      }
      onSingleDragPosChange(dragPositions);
    };

    const handleUp = (ev: MouseEvent) => {
      const dx = (ev.clientX - startMouseX) / viewport.zoom;
      const dy = (ev.clientY - startMouseY) / viewport.zoom;
      const positions = new Map<string, Position>();
      for (const [id, pos] of startPositions) {
        positions.set(id, snapPosition({ x: pos.x + dx, y: pos.y + dy }));
      }
      onMoveViews(positions);
      onSingleDragPosChange(new Map());
      setZoneDrag(null);
      setZoneDragDelta({ dx: 0, dy: 0 });
      cleanup();
    };

    const handleBlur = () => {
      onSingleDragPosChange(new Map());
      setZoneDrag(null);
      setZoneDragDelta({ dx: 0, dy: 0 });
      cleanup();
    };

    zoneDragCleanupRef.current = cleanup;
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    window.addEventListener('blur', handleBlur);
  }, [zones, views, viewport.zoom, onMoveViews, onSingleDragPosChange]);

  // Clean up zone drag listeners on unmount
  useEffect(() => {
    return () => { zoneDragCleanupRef.current?.(); };
  }, []);

  const handleZoneResizeStart = useCallback((zoneId: string, direction: ResizeDirection, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const zone = zones.find((z) => z.id === zoneId);
    if (!zone) return;

    const startMouseX = e.clientX;
    const startMouseY = e.clientY;
    const startW = zone.size.width;
    const startH = zone.size.height;
    const startX = zone.position.x;
    const startY = zone.position.y;

    const handleMove = (ev: MouseEvent) => {
      const dx = (ev.clientX - startMouseX) / viewport.zoom;
      const dy = (ev.clientY - startMouseY) / viewport.zoom;

      let newW = startW;
      let newH = startH;
      let newX = startX;
      let newY = startY;

      if (direction === 'e' || direction === 'se' || direction === 'ne') newW = startW + dx;
      if (direction === 'w' || direction === 'sw' || direction === 'nw') { newW = startW - dx; newX = startX + dx; }
      if (direction === 's' || direction === 'se' || direction === 'sw') newH = startH + dy;
      if (direction === 'n' || direction === 'ne' || direction === 'nw') { newH = startH - dy; newY = startY + dy; }

      if (newW < MIN_VIEW_WIDTH) {
        if (direction === 'w' || direction === 'sw' || direction === 'nw') newX = startX + startW - MIN_VIEW_WIDTH;
        newW = MIN_VIEW_WIDTH;
      }
      if (newH < MIN_VIEW_HEIGHT) {
        if (direction === 'n' || direction === 'ne' || direction === 'nw') newY = startY + startH - MIN_VIEW_HEIGHT;
        newH = MIN_VIEW_HEIGHT;
      }

      setZoneResize({ zoneId, size: { width: newW, height: newH }, position: { x: newX, y: newY } });
    };

    const handleUp = () => {
      setZoneResize((current) => {
        if (current) {
          onResizeView(zoneId, snapSize(current.size));
          onMoveView(zoneId, snapPosition(current.position));
        }
        return null;
      });
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
  }, [zones, viewport.zoom, onResizeView, onMoveView]);

  const handleZoneDelete = useCallback((zoneId: string) => {
    const zone = zones.find((z) => z.id === zoneId);
    if (!zone) return;
    if (zone.containedViewIds.length === 0) {
      onRemoveZone(zoneId, false);
    } else {
      setZoneDeleteDialog({ zoneId, zoneName: zone.displayName, containedCount: zone.containedViewIds.length });
    }
  }, [zones, onRemoveZone]);

  const handleZoneDeleteConfirm = useCallback((removeContents: boolean) => {
    if (zoneDeleteDialog) {
      onRemoveZone(zoneDeleteDialog.zoneId, removeContents);
      setZoneDeleteDialog(null);
    }
  }, [zoneDeleteDialog, onRemoveZone]);

  const handleZoneDeleteCancel = useCallback(() => {
    setZoneDeleteDialog(null);
  }, []);

  return {
    zoneDrag,
    zoneDragDelta,
    zoneResize,
    zoneDeleteDialog,
    handleZoneDragStart,
    handleZoneResizeStart,
    handleZoneDelete,
    handleZoneDeleteConfirm,
    handleZoneDeleteCancel,
  };
}
