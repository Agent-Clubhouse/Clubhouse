import React, { useCallback, useRef, useState, useEffect } from 'react';
import type { CanvasView, CanvasViewType, Viewport, Position, Size } from './canvas-types';
import { GRID_SIZE } from './canvas-types';
import { zoomTowardPoint, clampZoom, snapPosition, snapSize, viewportToCenterView, viewportToFitViews, screenToCanvas, isViewFullyInRect, computeTiledPositions } from './canvas-operations';
import { CanvasViewComponent, formatViewType, buildProjectContext } from './CanvasView';
import { AgentCanvasView } from './AgentCanvasView';
import { FileCanvasView } from './FileCanvasView';
import { BrowserCanvasView } from './BrowserCanvasView';
import { GitDiffCanvasView } from './GitDiffCanvasView';
import { AnchorCanvasView } from './AnchorCanvasView';
import { CanvasControls } from './CanvasControls';
import { CanvasContextMenu, type ContextMenuSelection } from './CanvasContextMenu';
import { CanvasAttentionIndicators } from './CanvasAttentionIndicators';
import { useCanvasAttention, computeOffScreenIndicators } from './canvas-attention';
import type { PluginAPI } from '../../../../shared/plugin-types';

/** Pixels to pan per arrow key press (2 grid units). */
const ARROW_PAN_STEP = 40;

/** Number of ghost cards shown behind the primary in the drag stack. */
const STACK_GHOST_COUNT = 3;
/** Pixel offset between stacked ghost cards. */
const STACK_OFFSET = 4;

interface SelectionRect {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
}

interface MultiDragState {
  /** The view the user grabbed (drives the mouse tracking). */
  dragViewId: string;
  /** Screen-space mouse at drag start. */
  startMouseX: number;
  startMouseY: number;
}

interface CanvasWorkspaceProps {
  views: CanvasView[];
  viewport: Viewport;
  zoomedViewId: string | null;
  selectedViewId: string | null;
  selectedViewIds: string[];
  api: PluginAPI;
  onViewportChange: (viewport: Viewport) => void;
  onAddView: (type: CanvasViewType, position: Position) => void;
  onAddPluginView: (pluginId: string, qualifiedType: string, label: string, position: Position, defaultSize?: { width: number; height: number }) => void;
  onRemoveView: (viewId: string) => void;
  onMoveView: (viewId: string, position: Position) => void;
  onMoveViews: (positions: Map<string, Position>) => void;
  onResizeView: (viewId: string, size: Size) => void;
  onFocusView: (viewId: string) => void;
  onUpdateView: (viewId: string, updates: Partial<CanvasView>) => void;
  onZoomView: (viewId: string | null) => void;
  onSelectView: (viewId: string | null) => void;
  onToggleSelectView: (viewId: string) => void;
  onSetSelectedViewIds: (ids: string[]) => void;
  onClearSelection: () => void;
}

export function CanvasWorkspace({
  views,
  viewport,
  zoomedViewId,
  selectedViewId,
  selectedViewIds,
  api,
  onViewportChange,
  onAddView,
  onAddPluginView,
  onRemoveView,
  onMoveView,
  onMoveViews,
  onResizeView,
  onFocusView,
  onUpdateView,
  onZoomView,
  onSelectView,
  onToggleSelectView,
  onSetSelectedViewIds,
  onClearSelection,
}: CanvasWorkspaceProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isPanning, setIsPanning] = useState(false);
  const panStartRef = useRef({ x: 0, y: 0, panX: 0, panY: 0 });
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; canvasX: number; canvasY: number } | null>(null);
  const [containerSize, setContainerSize] = useState<Size>({ width: 0, height: 0 });

  // ── Selection rectangle (lasso) ──────────────────────────────
  const [selectionRect, setSelectionRect] = useState<SelectionRect | null>(null);

  // ── Multi-drag state ─────────────────────────────────────────
  const [multiDrag, setMultiDrag] = useState<MultiDragState | null>(null);
  const [multiDragDelta, setMultiDragDelta] = useState<{ dx: number; dy: number }>({ dx: 0, dy: 0 });

  // ── Auto-focus container so keyboard events (arrow-key panning) work ──
  useEffect(() => {
    containerRef.current?.focus();
  }, []);

  // When selection is cleared, reclaim focus so arrow keys pan the canvas
  // and no keyboard events leak to previously-selected widgets.
  const prevSelectedRef = useRef(selectedViewId);
  useEffect(() => {
    if (prevSelectedRef.current !== null && selectedViewId === null) {
      containerRef.current?.focus();
    }
    prevSelectedRef.current = selectedViewId;
  }, [selectedViewId]);

  // ── Attention system ───────────────────────────────────────────
  const attentionMap = useCanvasAttention(views, api);

  // Track container size for off-screen indicator computation
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      setContainerSize({ width, height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const offScreenIndicators = computeOffScreenIndicators(views, attentionMap, viewport, containerSize);

  // ── Pan via middle-click drag ───────────────────────────────────

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    const isEmptySpace = e.target === e.currentTarget;

    // Middle-click: always pan
    if (e.button === 1) {
      e.preventDefault();
      onSelectView(null);
      containerRef.current?.focus();
      setIsPanning(true);
      panStartRef.current = { x: e.clientX, y: e.clientY, panX: viewport.panX, panY: viewport.panY };
      return;
    }

    // Left-click on empty space: start selection rectangle (lasso)
    if (e.button === 0 && isEmptySpace) {
      e.preventDefault();
      // Clear keyboard-focus selection; preserve multi-selection only if Cmd/Ctrl held
      onSelectView(null);
      if (!e.metaKey && !e.ctrlKey) {
        onClearSelection();
      }
      containerRef.current?.focus();

      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const canvasPos = screenToCanvas(e.clientX, e.clientY, rect, viewport);
      setSelectionRect({ startX: canvasPos.x, startY: canvasPos.y, currentX: canvasPos.x, currentY: canvasPos.y });
    }
  }, [viewport, onSelectView, onClearSelection]);

  // ── Selection rectangle mouse tracking ──────────────────────────

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
        // Compute which views are fully contained in the selection rect
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
  }, [selectionRect, viewport, views, onSetSelectedViewIds]);

  // ── Pan effect (middle-click) ────────────────────────────────────

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

  // ── Multi-drag tracking ──────────────────────────────────────────

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
      // Compute the drop point from the primary view's final position
      const primaryView = views.find((v) => v.id === multiDrag.dragViewId);
      if (primaryView) {
        const dx = (e.clientX - multiDrag.startMouseX) / viewport.zoom;
        const dy = (e.clientY - multiDrag.startMouseY) / viewport.zoom;
        const dropOrigin: Position = {
          x: primaryView.position.x + dx,
          y: primaryView.position.y + dy,
        };

        const selectedViews = views.filter((v) => selectedViewIds.includes(v.id));
        const tiledPositions = computeTiledPositions(selectedViews, snapPosition(dropOrigin));
        onMoveViews(tiledPositions);
      }
      setMultiDrag(null);
      setMultiDragDelta({ dx: 0, dy: 0 });
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [multiDrag, viewport.zoom, views, selectedViewIds, onMoveViews]);

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

  // ── Keyboard: arrow keys pan when nothing is selected ─────────

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Escape always deselects (both single and multi)
    if (e.key === 'Escape') {
      if (selectedViewId || selectedViewIds.length > 0) {
        e.preventDefault();
        onClearSelection();
        containerRef.current?.focus();
        return;
      }
    }

    // When a widget is selected, let keyboard events pass through to it
    // (except global shortcuts handled by the app shell)
    if (selectedViewId) return;

    let dx = 0;
    let dy = 0;
    switch (e.key) {
      case 'ArrowLeft':  dx = ARROW_PAN_STEP; break;
      case 'ArrowRight': dx = -ARROW_PAN_STEP; break;
      case 'ArrowUp':    dy = ARROW_PAN_STEP; break;
      case 'ArrowDown':  dy = -ARROW_PAN_STEP; break;
      default: return;
    }

    e.preventDefault();
    onViewportChange({
      panX: viewport.panX + dx,
      panY: viewport.panY + dy,
      zoom: viewport.zoom,
    });
  }, [selectedViewId, selectedViewIds, viewport, onViewportChange, onClearSelection]);

  // ── Context menu ───────────────────────────────────────────────

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    if (e.target !== e.currentTarget) return;
    e.preventDefault();
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;

    const canvasPos = screenToCanvas(e.clientX, e.clientY, rect, viewport);

    setContextMenu({ x: e.clientX, y: e.clientY, canvasX: canvasPos.x, canvasY: canvasPos.y });
  }, [viewport]);

  const handleContextMenuAction = useCallback((selection: ContextMenuSelection) => {
    if (!contextMenu) { setContextMenu(null); return; }
    const pos = { x: contextMenu.canvasX, y: contextMenu.canvasY };
    if (selection.kind === 'builtin') {
      onAddView(selection.type, pos);
    } else {
      onAddPluginView(selection.pluginId, selection.qualifiedType, selection.label, pos, selection.defaultSize);
    }
    setContextMenu(null);
  }, [contextMenu, onAddView, onAddPluginView]);

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

  // ── Search → focus on view ────────────────────────────────────────

  const handleSearchSelect = useCallback((viewId: string) => {
    const view = views.find((v) => v.id === viewId);
    if (!view) return;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    // Center on the view and bring it to front
    onViewportChange(viewportToCenterView(view, rect.width, rect.height, viewport.zoom));
    onFocusView(viewId);
  }, [views, viewport.zoom, onViewportChange, onFocusView]);

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
    // If this was a multi-drag, the multi-drag mouseUp handler already moved all views
    if (multiDrag && multiDrag.dragViewId === viewId) {
      return;
    }
    const snapped = snapPosition(position);
    onMoveView(viewId, snapped);
  }, [onMoveView, multiDrag]);

  const handleViewResizeEnd = useCallback((viewId: string, size: Size, position: Position) => {
    const snapped = snapSize(size);
    const snappedPos = snapPosition(position);
    onResizeView(viewId, snapped);
    onMoveView(viewId, snappedPos);
  }, [onResizeView, onMoveView]);

  // ── Zoomed view ────────────────────────────────────────────────

  const zoomedView = zoomedViewId ? views.find((v) => v.id === zoomedViewId) : null;

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full overflow-hidden select-none bg-ctp-crust focus:outline-none"
      tabIndex={-1}
      style={dotGridStyle}
      onMouseDown={handleMouseDown}
      onWheel={handleWheel}
      onKeyDown={handleKeyDown}
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
        {views.map((view) => {
          return (
            <CanvasViewComponent
              key={view.id}
              view={view}
              api={api}
              zoom={viewport.zoom}
              isZoomed={zoomedViewId === view.id}
              isSelected={selectedViewId === view.id}
              isMultiSelected={selectedViewIds.includes(view.id)}
              attention={attentionMap.get(view.id) ?? null}
              onClose={() => onRemoveView(view.id)}
              onFocus={() => onFocusView(view.id)}
              onSelect={() => {
                onClearSelection();
                onSelectView(view.id);
              }}
              onToggleSelect={() => onToggleSelectView(view.id)}
              onCenterView={() => handleCenterView(view.id)}
              onZoomView={() => handleToggleZoomView(view.id)}
              onDragStart={handleViewMultiDragStart}
              onDragEnd={(pos) => handleViewDragEnd(view.id, pos)}
              onResizeEnd={(size, pos) => handleViewResizeEnd(view.id, size, pos)}
              onUpdate={(updates) => onUpdateView(view.id, updates)}
            />
          );
        })}

        {/* Selection rectangle (lasso) */}
        {selectionRect && (
          <div
            className="absolute border-2 border-ctp-blue/60 bg-ctp-blue/10 rounded-sm pointer-events-none"
            style={{
              left: Math.min(selectionRect.startX, selectionRect.currentX),
              top: Math.min(selectionRect.startY, selectionRect.currentY),
              width: Math.abs(selectionRect.currentX - selectionRect.startX),
              height: Math.abs(selectionRect.currentY - selectionRect.startY),
              zIndex: 99998,
            }}
            data-testid="canvas-selection-rect"
          />
        )}

        {/* Multi-drag stack visual */}
        {multiDrag && selectedViewIds.length > 1 && (() => {
          const primaryView = views.find((v) => v.id === multiDrag.dragViewId);
          if (!primaryView) return null;
          const stackX = primaryView.position.x + multiDragDelta.dx;
          const stackY = primaryView.position.y + multiDragDelta.dy;
          const ghostCount = Math.min(STACK_GHOST_COUNT, selectedViewIds.length - 1);

          return (
            <div
              className="absolute pointer-events-none"
              style={{ left: stackX, top: stackY, zIndex: 99997 }}
              data-testid="canvas-multi-drag-stack"
            >
              {/* Ghost cards stacked behind */}
              {Array.from({ length: ghostCount }, (_, i) => (
                <div
                  key={i}
                  className="absolute bg-ctp-mantle border border-surface-2 rounded-lg opacity-40"
                  style={{
                    left: (i + 1) * STACK_OFFSET,
                    top: (i + 1) * STACK_OFFSET,
                    width: primaryView.size.width,
                    height: primaryView.size.height,
                  }}
                />
              ))}
              {/* Count badge */}
              <div
                className="absolute -top-3 -right-3 bg-ctp-blue text-ctp-base text-xs font-bold rounded-full w-6 h-6 flex items-center justify-center"
                style={{ zIndex: 1 }}
              >
                {selectedViewIds.length}
              </div>
            </div>
          );
        })()}
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
              <span className="text-[10px] text-ctp-overlay1 bg-surface-0 rounded px-1.5 py-0.5 font-medium leading-none">
                {formatViewType(zoomedView.type)}
              </span>
              <span className="text-xs text-ctp-subtext0 truncate flex-1">{zoomedView.title}</span>
              {(() => { const ctx = buildProjectContext(zoomedView, api.projects.list()); return ctx ? <span className="text-[10px] text-ctp-overlay0 truncate flex-shrink-0">({ctx})</span> : null; })()}
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
              {zoomedView.type === 'anchor' && <AnchorCanvasView view={zoomedView as any} onUpdate={(u: Partial<CanvasView>) => onUpdateView(zoomedView.id, u)} />}
            </div>
          </div>
        </div>
      )}

      {/* Off-screen attention indicators */}
      <CanvasAttentionIndicators
        indicators={offScreenIndicators}
        onNavigate={handleSearchSelect}
      />

      {/* Controls overlay */}
      <CanvasControls
        zoom={viewport.zoom}
        onZoomIn={handleZoomIn}
        onZoomOut={handleZoomOut}
        onZoomReset={handleZoomReset}
        onCenter={handleCenter}
        onSizeToFit={handleSizeToFit}
        hasViews={views.length > 0}
        views={views}
        onSelectView={handleSearchSelect}
        attentionMap={attentionMap}
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
