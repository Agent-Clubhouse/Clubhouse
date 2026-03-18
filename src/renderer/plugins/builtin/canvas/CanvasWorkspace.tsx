import React, { useCallback, useRef, useState, useEffect } from 'react';
import type { CanvasView, CanvasViewType, Viewport, Position, Size } from './canvas-types';
import { GRID_SIZE } from './canvas-types';
import { zoomTowardPoint, clampZoom, snapPosition, snapSize, viewportToCenterView, viewportToFitViews } from './canvas-operations';
import { CanvasViewComponent } from './CanvasView';
import { AgentCanvasView } from './AgentCanvasView';
import { FileCanvasView } from './FileCanvasView';
import { BrowserCanvasView } from './BrowserCanvasView';
import { GitDiffCanvasView } from './GitDiffCanvasView';
import { CanvasControls } from './CanvasControls';
import { CanvasContextMenu } from './CanvasContextMenu';
import type { PluginAPI } from '../../../../shared/plugin-types';

interface CanvasWorkspaceProps {
  views: CanvasView[];
  viewport: Viewport;
  zoomedViewId: string | null;
  api: PluginAPI;
  onViewportChange: (viewport: Viewport) => void;
  onAddView: (type: CanvasViewType, position: Position) => void;
  onRemoveView: (viewId: string) => void;
  onMoveView: (viewId: string, position: Position) => void;
  onResizeView: (viewId: string, size: Size) => void;
  onFocusView: (viewId: string) => void;
  onUpdateView: (viewId: string, updates: Partial<CanvasView>) => void;
  onZoomView: (viewId: string | null) => void;
}

export function CanvasWorkspace({
  views,
  viewport,
  zoomedViewId,
  api,
  onViewportChange,
  onAddView,
  onRemoveView,
  onMoveView,
  onResizeView,
  onFocusView,
  onUpdateView,
  onZoomView,
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

  const handleContextMenuAction = useCallback((type: CanvasViewType) => {
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

  const handleCenter = useCallback(() => {
    onViewportChange({ panX: 0, panY: 0, zoom: viewport.zoom });
  }, [viewport.zoom, onViewportChange]);

  const handleSizeToFit = useCallback(() => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || views.length === 0) return;
    onViewportChange(viewportToFitViews(views, rect.width, rect.height));
  }, [views, onViewportChange]);

  // ── Per-view actions ───────────────────────────────────────────

  const handleCenterView = useCallback((viewId: string) => {
    const view = views.find((v) => v.id === viewId);
    if (!view) return;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    onViewportChange(viewportToCenterView(view, rect.width, rect.height, viewport.zoom));
  }, [views, viewport.zoom, onViewportChange]);

  const handleToggleZoomView = useCallback((viewId: string) => {
    if (zoomedViewId === viewId) {
      onZoomView(null);
    } else {
      onZoomView(viewId);
      // Also center on the view
      const view = views.find((v) => v.id === viewId);
      if (view) {
        const rect = containerRef.current?.getBoundingClientRect();
        if (rect) {
          onViewportChange(viewportToCenterView(view, rect.width, rect.height, viewport.zoom));
        }
      }
    }
  }, [views, viewport.zoom, zoomedViewId, onZoomView, onViewportChange]);

  // ── Dot grid background ────────────────────────────────────────

  const gridSpacing = GRID_SIZE * viewport.zoom;
  const dotGridStyle: React.CSSProperties = {
    backgroundImage: `radial-gradient(circle, color-mix(in srgb, var(--ctp-overlay0, #6c7086) 45%, transparent) 0.75px, transparent 0.75px)`,
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

  // ── Zoomed view ────────────────────────────────────────────────

  const zoomedView = zoomedViewId ? views.find((v) => v.id === zoomedViewId) : null;

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full overflow-hidden select-none bg-ctp-crust"
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
            isZoomed={zoomedViewId === view.id}
            onClose={() => onRemoveView(view.id)}
            onFocus={() => onFocusView(view.id)}
            onCenterView={() => handleCenterView(view.id)}
            onZoomView={() => handleToggleZoomView(view.id)}
            onDragEnd={(pos) => handleViewDragEnd(view.id, pos)}
            onResizeEnd={(size) => handleViewResizeEnd(view.id, size)}
            onUpdate={(updates) => onUpdateView(view.id, updates)}
          />
        ))}
      </div>

      {/* Zoomed view overlay */}
      {zoomedView && (
        <div
          className="absolute inset-0 z-[9999] flex items-center justify-center bg-ctp-crust/80 backdrop-blur-sm"
          onClick={(e) => { if (e.target === e.currentTarget) onZoomView(null); }}
          data-testid="canvas-zoom-overlay"
        >
          <div
            className="w-[calc(100%-48px)] h-[calc(100%-48px)] flex flex-col bg-ctp-base border border-surface-2 rounded-lg overflow-hidden"
            style={{ boxShadow: '0 8px 48px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(88, 91, 112, 0.2)' }}
          >
            {/* Zoomed title bar */}
            <div className="flex items-center gap-1.5 px-3 py-2 bg-ctp-mantle border-b border-surface-0 flex-shrink-0">
              <span className="text-[10px] text-ctp-overlay0 font-mono uppercase tracking-wider">
                {zoomedView.type}
              </span>
              <span className="text-xs text-ctp-subtext0 truncate flex-1">{zoomedView.title}</span>
              <button
                className="text-[10px] px-2 py-0.5 rounded bg-surface-1 text-ctp-subtext0 hover:bg-surface-2 hover:text-ctp-text transition-colors"
                onClick={() => onZoomView(null)}
                data-testid="canvas-zoom-restore"
              >
                Restore
              </button>
            </div>
            <div className="flex-1 min-h-0 overflow-auto" onWheel={(e) => e.stopPropagation()}>
              {zoomedView.type === 'agent' && <AgentCanvasView view={zoomedView as any} api={api} onUpdate={(u: Partial<CanvasView>) => onUpdateView(zoomedView.id, u)} />}
              {zoomedView.type === 'file' && <FileCanvasView view={zoomedView as any} api={api} onUpdate={(u: Partial<CanvasView>) => onUpdateView(zoomedView.id, u)} />}
              {zoomedView.type === 'browser' && <BrowserCanvasView view={zoomedView as any} onUpdate={(u: Partial<CanvasView>) => onUpdateView(zoomedView.id, u)} />}
              {zoomedView.type === 'git-diff' && <GitDiffCanvasView view={zoomedView as any} api={api} onUpdate={(u: Partial<CanvasView>) => onUpdateView(zoomedView.id, u)} />}
            </div>
          </div>
        </div>
      )}

      {/* Controls overlay */}
      <CanvasControls
        zoom={viewport.zoom}
        onZoomIn={handleZoomIn}
        onZoomOut={handleZoomOut}
        onZoomReset={handleZoomReset}
        onCenter={handleCenter}
        onSizeToFit={handleSizeToFit}
        hasViews={views.length > 0}
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
