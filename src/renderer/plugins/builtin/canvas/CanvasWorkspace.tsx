import React, { useCallback, useRef, useState, useEffect } from 'react';
import type { CanvasView, Viewport, Position, Size } from './canvas-types';
import { GRID_SIZE } from './canvas-types';
import { zoomTowardPoint, clampZoom, snapPosition, snapSize } from './canvas-operations';
import { CanvasViewComponent } from './CanvasView';
import { CanvasControls } from './CanvasControls';
import { CanvasContextMenu } from './CanvasContextMenu';
import type { PluginAPI } from '../../../../shared/plugin-types';

interface CanvasWorkspaceProps {
  views: CanvasView[];
  viewport: Viewport;
  api: PluginAPI;
  onViewportChange: (viewport: Viewport) => void;
  onAddView: (type: 'agent' | 'file' | 'browser', position: Position) => void;
  onRemoveView: (viewId: string) => void;
  onMoveView: (viewId: string, position: Position) => void;
  onResizeView: (viewId: string, size: Size) => void;
  onFocusView: (viewId: string) => void;
  onUpdateView: (viewId: string, updates: Partial<CanvasView>) => void;
}

export function CanvasWorkspace({
  views,
  viewport,
  api,
  onViewportChange,
  onAddView,
  onRemoveView,
  onMoveView,
  onResizeView,
  onFocusView,
  onUpdateView,
}: CanvasWorkspaceProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isPanning, setIsPanning] = useState(false);
  const panStartRef = useRef({ x: 0, y: 0, panX: 0, panY: 0 });
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; canvasX: number; canvasY: number } | null>(null);

  // ── Pan via mouse drag on empty space ──────────────────────────

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    // Only start pan on middle-click or left-click on empty space
    if (e.button === 1 || (e.button === 0 && e.target === e.currentTarget)) {
      e.preventDefault();
      setIsPanning(true);
      panStartRef.current = {
        x: e.clientX,
        y: e.clientY,
        panX: viewport.panX,
        panY: viewport.panY,
      };
    }
  }, [viewport.panX, viewport.panY]);

  useEffect(() => {
    if (!isPanning) return;

    const handleMouseMove = (e: MouseEvent) => {
      const dx = (e.clientX - panStartRef.current.x) / viewport.zoom;
      const dy = (e.clientY - panStartRef.current.y) / viewport.zoom;
      onViewportChange({
        panX: panStartRef.current.panX + dx,
        panY: panStartRef.current.panY + dy,
        zoom: viewport.zoom,
      });
    };

    const handleMouseUp = () => {
      setIsPanning(false);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isPanning, viewport.zoom, onViewportChange]);

  // ── Zoom via Ctrl+wheel ────────────────────────────────────────

  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (!containerRef.current) return;

    if (e.ctrlKey || e.metaKey) {
      // Zoom
      e.preventDefault();
      const delta = -e.deltaY * 0.002;
      const newZoom = clampZoom(viewport.zoom * (1 + delta));
      const rect = containerRef.current.getBoundingClientRect();
      onViewportChange(zoomTowardPoint(viewport, newZoom, e.clientX, e.clientY, rect));
    } else {
      // Pan
      onViewportChange({
        panX: viewport.panX - e.deltaX / viewport.zoom,
        panY: viewport.panY - e.deltaY / viewport.zoom,
        zoom: viewport.zoom,
      });
    }
  }, [viewport, onViewportChange]);

  // ── Context menu ───────────────────────────────────────────────

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    if (e.target !== e.currentTarget) return;
    e.preventDefault();
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;

    const canvasX = (e.clientX - rect.left) / viewport.zoom - viewport.panX;
    const canvasY = (e.clientY - rect.top) / viewport.zoom - viewport.panY;

    setContextMenu({ x: e.clientX, y: e.clientY, canvasX, canvasY });
  }, [viewport]);

  const handleContextMenuAction = useCallback((type: 'agent' | 'file' | 'browser') => {
    if (contextMenu) {
      onAddView(type, { x: contextMenu.canvasX, y: contextMenu.canvasY });
    }
    setContextMenu(null);
  }, [contextMenu, onAddView]);

  const handleDismissContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  // ── Zoom controls ──────────────────────────────────────────────

  const handleZoomIn = useCallback(() => {
    onViewportChange({ ...viewport, zoom: clampZoom(viewport.zoom + 0.25) });
  }, [viewport, onViewportChange]);

  const handleZoomOut = useCallback(() => {
    onViewportChange({ ...viewport, zoom: clampZoom(viewport.zoom - 0.25) });
  }, [viewport, onViewportChange]);

  const handleZoomReset = useCallback(() => {
    onViewportChange({ panX: 0, panY: 0, zoom: 1 });
  }, [onViewportChange]);

  // ── Dot grid background ────────────────────────────────────────

  const gridSpacing = GRID_SIZE * viewport.zoom;
  const dotGridStyle: React.CSSProperties = {
    backgroundImage: `radial-gradient(circle, color-mix(in srgb, var(--ctp-overlay0, #6c7086) 25%, transparent) 0.5px, transparent 0.5px)`,
    backgroundSize: `${gridSpacing}px ${gridSpacing}px`,
    backgroundPosition: `${viewport.panX * viewport.zoom}px ${viewport.panY * viewport.zoom}px`,
  };

  // ── View drag handlers ─────────────────────────────────────────

  const handleViewDragEnd = useCallback((viewId: string, position: Position) => {
    const snapped = snapPosition(position);
    onMoveView(viewId, snapped);
  }, [onMoveView]);

  const handleViewResizeEnd = useCallback((viewId: string, size: Size) => {
    const snapped = snapSize(size);
    onResizeView(viewId, snapped);
  }, [onResizeView]);

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full overflow-hidden select-none"
      style={dotGridStyle}
      onMouseDown={handleMouseDown}
      onWheel={handleWheel}
      onContextMenu={handleContextMenu}
      onClick={handleDismissContextMenu}
      data-testid="canvas-workspace"
    >
      {/* Transform container */}
      <div
        style={{
          transform: `scale(${viewport.zoom}) translate(${viewport.panX}px, ${viewport.panY}px)`,
          transformOrigin: '0 0',
          position: 'absolute',
          top: 0,
          left: 0,
        }}
      >
        {views.map((view) => (
          <CanvasViewComponent
            key={view.id}
            view={view}
            api={api}
            zoom={viewport.zoom}
            onClose={() => onRemoveView(view.id)}
            onFocus={() => onFocusView(view.id)}
            onDragEnd={(pos) => handleViewDragEnd(view.id, pos)}
            onResizeEnd={(size) => handleViewResizeEnd(view.id, size)}
            onUpdate={(updates) => onUpdateView(view.id, updates)}
          />
        ))}
      </div>

      {/* Controls overlay */}
      <CanvasControls
        zoom={viewport.zoom}
        onZoomIn={handleZoomIn}
        onZoomOut={handleZoomOut}
        onZoomReset={handleZoomReset}
      />

      {/* Context menu */}
      {contextMenu && (
        <CanvasContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onSelect={handleContextMenuAction}
          onDismiss={handleDismissContextMenu}
        />
      )}
    </div>
  );
}
