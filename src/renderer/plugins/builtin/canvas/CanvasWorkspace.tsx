import React, { useCallback, useMemo, useRef, useState, useEffect } from 'react';
import type { CanvasView, CanvasViewType, ZoneCanvasView, Viewport, Position, Size } from './canvas-types';
import { GRID_SIZE } from './canvas-types';
import { zoomTowardPoint, clampZoom, snapPosition, snapSize, viewportToCenterView, viewportToFitViews, screenToCanvas, isViewFullyInRect } from './canvas-operations';
import { ZoneBackground } from './ZoneBackground';
import { ZoneCard } from './ZoneCard';
import { ZoneDeleteDialog } from './ZoneDeleteDialog';
import { ZoneThemeProvider } from './ZoneThemeProvider';
import { useZoneContainment, getViewThemeOverride } from './zone-containment';
import { CanvasViewComponent, formatViewType, buildProjectContext } from './CanvasView';
import { AgentCanvasView } from './AgentCanvasView';
import { CanvasControls } from './CanvasControls';
import { CanvasContextMenu, type ContextMenuSelection } from './CanvasContextMenu';
import { CanvasAttentionIndicators } from './CanvasAttentionIndicators';
import { useCanvasAttention, computeOffScreenIndicators } from './canvas-attention';
import { WireOverlay } from './WireOverlay';
import { WireDragOverlay } from './WireDragOverlay';
import { WireConfigPopover } from './WireConfigPopover';
import { CanvasMinimap } from './CanvasMinimap';
import { useWiring, type ZoneWireCallback } from './useWiring';
import { useZoneWireStore } from './zone-wire-store';
import { expandZoneWires, reconcileZoneBindings } from './zone-wire-expansion';
import { useMcpBindingStore, type McpBindingEntry } from '../../../stores/mcpBindingStore';
import { useMcpSettingsStore } from '../../../stores/mcpSettingsStore';
import type { PluginCanvasView as PluginCanvasViewType } from './canvas-types';
import type { PluginAPI, CanvasWidgetMetadata } from '../../../../shared/plugin-types';
import { getRegisteredWidgetType } from '../../canvas-widget-registry';

/** Pixels to pan per arrow key press (2 grid units). */
const ARROW_PAN_STEP = 40;

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
  onRemoveZone: (zoneId: string, removeContents: boolean) => void;
  onUpdateZoneTheme: (zoneId: string, themeId: string) => void;
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
  onRemoveZone,
  onUpdateZoneTheme,
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

  // ── Zone drag state ─────────────────────────────────────────
  const [zoneDrag, setZoneDrag] = useState<{ zoneId: string; containedViewIds: string[] } | null>(null);
  const [zoneDragDelta, setZoneDragDelta] = useState<{ dx: number; dy: number }>({ dx: 0, dy: 0 });

  // ── Single-view drag position tracking (for wire overlay) ─────
  const [singleDragPos, setSingleDragPos] = useState<Map<string, Position>>(new Map());

  // ── MCP wiring state ──────────────────────────────────────────
  const mcpEnabled = !!useMcpSettingsStore((s) => s.enabled);
  const mcpBindings = useMcpBindingStore((s) => s.bindings);
  const addZoneWire = useZoneWireStore((s) => s.addWire);
  const mcpBind = useMcpBindingStore((s) => s.bind);

  const handleZoneWire: ZoneWireCallback = useCallback((sourceZoneId, targetId, targetType) => {
    addZoneWire({ sourceZoneId, targetId, targetType });
    // Immediately expand and reconcile bindings
    const allWires = [...useZoneWireStore.getState().wires];
    const expanded = expandZoneWires(allWires, views);
    const current = useMcpBindingStore.getState().bindings;
    const { toAdd } = reconcileZoneBindings(expanded, current);
    for (const b of toAdd) {
      mcpBind(b.agentId, {
        targetId: b.targetId,
        targetKind: b.targetKind,
        label: b.label,
        agentName: b.agentName,
        targetName: b.targetName,
      });
    }
  }, [views, addZoneWire, mcpBind]);

  const { wireDrag, startWireDrag, isWireDragging } = useWiring(views, viewport, containerRef, handleZoneWire);
  const [wirePopover, setWirePopover] = useState<{ binding: McpBindingEntry; x: number; y: number } | null>(null);

  // ── Zone state ──────────────────────────────────────────────────
  const zoneContainment = useZoneContainment(views);
  const zones = useMemo(() => views.filter((v): v is ZoneCanvasView => v.type === 'zone'), [views]);
  const nonZoneViews = useMemo(() => views.filter((v) => v.type !== 'zone'), [views]);
  const [zoneDeleteDialog, setZoneDeleteDialog] = useState<{ zoneId: string; zoneName: string; containedCount: number } | null>(null);

  // ── Sleeping agent tracking (for wire dimming) ─────────────────
  const [agentTick, setAgentTick] = useState(0);
  useEffect(() => {
    const sub = api.agents.onAnyChange(() => setAgentTick((n) => n + 1));
    return () => sub.dispose();
  }, [api]);
  const sleepingAgentIds = useMemo(() => {
    void agentTick; // reactive dependency
    const agents = api.agents.list();
    const sleeping = new Set<string>();
    for (const agent of agents) {
      if (agent.status === 'sleeping' || agent.status === 'error') {
        sleeping.add(agent.id);
      }
    }
    return sleeping;
  }, [api, agentTick]);

  const handleWireClick = useCallback((binding: McpBindingEntry, event: React.MouseEvent) => {
    setWirePopover({ binding, x: event.clientX, y: event.clientY });
  }, []);

  const handleWirePopoverClose = useCallback(() => {
    setWirePopover(null);
  }, []);

  // Load MCP settings on mount
  useEffect(() => {
    useMcpSettingsStore.getState().loadSettings();
  }, []);

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
    // Suppress pan/select during wire drag
    if (isWireDragging) return;

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
  }, [viewport, onSelectView, onClearSelection, isWireDragging]);

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
      // Move all selected views by the same delta (preserves relative layout)
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
      // End the selection so the user gets a clean slate after the drop
      onClearSelection();
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [multiDrag, viewport.zoom, views, selectedViewIds, onMoveViews, onClearSelection]);

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

  // ── Zone handlers ────────────────────────────────────────────────

  const handleZoneDragStart = useCallback((zoneId: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const zone = zones.find((z) => z.id === zoneId);
    if (!zone) return;

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

    const handleMove = (ev: MouseEvent) => {
      const dx = (ev.clientX - startMouseX) / viewport.zoom;
      const dy = (ev.clientY - startMouseY) / viewport.zoom;
      setZoneDragDelta({ dx, dy });
      // Update positions for wire overlay tracking
      const dragPositions = new Map<string, Position>();
      for (const [id, pos] of startPositions) {
        dragPositions.set(id, { x: pos.x + dx, y: pos.y + dy });
      }
      setSingleDragPos(dragPositions);
    };

    const handleUp = (ev: MouseEvent) => {
      const dx = (ev.clientX - startMouseX) / viewport.zoom;
      const dy = (ev.clientY - startMouseY) / viewport.zoom;
      const positions = new Map<string, Position>();
      for (const [id, pos] of startPositions) {
        positions.set(id, snapPosition({ x: pos.x + dx, y: pos.y + dy }));
      }
      onMoveViews(positions);
      setSingleDragPos(new Map());
      setZoneDrag(null);
      setZoneDragDelta({ dx: 0, dy: 0 });
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
  }, [zones, views, viewport.zoom, onMoveViews]);

  const handleZoneDelete = useCallback((zoneId: string) => {
    const zone = zones.find((z) => z.id === zoneId);
    if (!zone) return;
    if (zone.containedViewIds.length === 0) {
      // No contained widgets — just delete
      onRemoveZone(zoneId, false);
    } else {
      setZoneDeleteDialog({
        zoneId,
        zoneName: zone.displayName,
        containedCount: zone.containedViewIds.length,
      });
    }
  }, [zones, onRemoveZone]);

  const handleZoneDeleteConfirm = useCallback((removeContents: boolean) => {
    if (zoneDeleteDialog) {
      onRemoveZone(zoneDeleteDialog.zoneId, removeContents);
      setZoneDeleteDialog(null);
    }
  }, [zoneDeleteDialog, onRemoveZone]);

  // ── Dot grid background ────────────────────────────────────────

  const gridSpacing = GRID_SIZE * viewport.zoom;
  const dotGridStyle: React.CSSProperties = {
    backgroundImage: `radial-gradient(circle, color-mix(in srgb, var(--ctp-overlay0, #6c7086) 45%, transparent) 0.75px, transparent 0.75px)`,
    backgroundSize: `${gridSpacing}px ${gridSpacing}px`,
    backgroundPosition: `${viewport.panX * viewport.zoom}px ${viewport.panY * viewport.zoom}px`,
  };

  // ── View drag handlers ─────────────────────────────────────────

  const handleViewDragMove = useCallback((viewId: string, position: Position) => {
    setSingleDragPos((prev) => {
      const next = new Map(prev);
      next.set(viewId, position);
      return next;
    });
  }, []);

  const handleViewDragEnd = useCallback((viewId: string, position: Position) => {
    // Clear single-drag tracking for this view
    setSingleDragPos((prev) => {
      const next = new Map(prev);
      next.delete(viewId);
      return next;
    });
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

  // ── Merged view positions for wire overlay (single-drag + multi-drag) ──
  const wireViewPositions = useMemo(() => {
    const map = new Map<string, Position>();
    // Single-view drag positions
    for (const [id, pos] of singleDragPos) {
      map.set(id, pos);
    }
    // Multi-drag: apply delta to all selected views
    if (multiDrag && (multiDragDelta.dx !== 0 || multiDragDelta.dy !== 0)) {
      for (const v of views) {
        if (selectedViewIds.includes(v.id)) {
          map.set(v.id, {
            x: v.position.x + multiDragDelta.dx,
            y: v.position.y + multiDragDelta.dy,
          });
        }
      }
    }
    return map.size > 0 ? map : undefined;
  }, [singleDragPos, multiDrag, multiDragDelta, views, selectedViewIds]);

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
        {/* Layer 1: Zone backgrounds (behind everything) */}
        {zones.map((zone) => (
          <ZoneBackground
            key={`zone-bg-${zone.id}`}
            zone={zone}
            dragOffset={zoneDrag?.zoneId === zone.id ? zoneDragDelta : undefined}
          />
        ))}

        {/* Layer 2: MCP wire overlay */}
        {mcpEnabled && (
          <WireOverlay
            views={views}
            bindings={mcpBindings}
            viewPositions={wireViewPositions}
            sleepingAgentIds={sleepingAgentIds}
            onWireClick={handleWireClick}
          />
        )}

        {/* Layer 3: Non-zone views (with zone theme scoping) */}
        {nonZoneViews.map((view) => {
          const themeOverride = getViewThemeOverride(view.id, zoneContainment);
          return (
            <ZoneThemeProvider key={view.id} themeId={themeOverride}>
              <CanvasViewComponent
                view={view}
                api={api}
                zoom={viewport.zoom}
                isZoomed={zoomedViewId === view.id}
                isSelected={selectedViewId === view.id}
                isMultiSelected={selectedViewIds.includes(view.id)}
                dragOffset={
                  // Multi-drag: non-primary selected views move with the drag delta
                  (multiDrag != null && selectedViewIds.includes(view.id) && view.id !== multiDrag.dragViewId)
                    ? multiDragDelta
                    // Zone drag: contained views move with the zone
                    : (zoneDrag != null && zoneDrag.containedViewIds.includes(view.id))
                      ? zoneDragDelta
                      : undefined
                }
                attention={attentionMap.get(view.id) ?? null}
                allViews={views}
                mcpEnabled={mcpEnabled}
                onStartWireDrag={startWireDrag}
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
                onDragMove={handleViewDragMove}
                onDragEnd={(pos) => handleViewDragEnd(view.id, pos)}
                onResizeEnd={(size, pos) => handleViewResizeEnd(view.id, size, pos)}
                onUpdate={(updates) => onUpdateView(view.id, updates)}
              />
            </ZoneThemeProvider>
          );
        })}

        {/* Layer 4: Zone cards */}
        {zones.map((zone) => (
          <ZoneCard
            key={`zone-card-${zone.id}`}
            zone={zone}
            mcpEnabled={mcpEnabled}
            dragOffset={zoneDrag?.zoneId === zone.id ? zoneDragDelta : undefined}
            onRename={(name) => onUpdateView(zone.id, { displayName: name, title: name })}
            onThemeChange={(themeId) => onUpdateZoneTheme(zone.id, themeId)}
            onDelete={() => handleZoneDelete(zone.id)}
            onDragStart={(e) => handleZoneDragStart(zone.id, e)}
            onStartWireDrag={() => startWireDrag(zone)}
          />
        ))}

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

        {/* Wire drag overlay (high z-index, inside transform container) */}
        {wireDrag && <WireDragOverlay wireDrag={wireDrag} views={views} />}

        {/* Multi-drag count badge (floating on the primary view) */}
        {multiDrag && selectedViewIds.length > 1 && (() => {
          const primaryView = views.find((v) => v.id === multiDrag.dragViewId);
          if (!primaryView) return null;
          const badgeX = primaryView.position.x + multiDragDelta.dx + primaryView.size.width - 8;
          const badgeY = primaryView.position.y + multiDragDelta.dy - 8;
          return (
            <div
              className="absolute pointer-events-none bg-ctp-blue text-ctp-base text-xs font-bold rounded-full w-6 h-6 flex items-center justify-center"
              style={{ left: badgeX, top: badgeY, zIndex: 99997 }}
              data-testid="canvas-multi-drag-badge"
            >
              {selectedViewIds.length}
            </div>
          );
        })()}
      </div>

      {/* Minimap */}
      {views.length > 0 && !zoomedView && (
        <CanvasMinimap
          views={views}
          viewport={viewport}
          containerSize={containerSize}
          selectedViewId={selectedViewId}
          selectedViewIds={selectedViewIds}
          attentionMap={attentionMap}
          onViewportChange={onViewportChange}
        />
      )}

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
              {zoomedView.type === 'plugin' && (() => {
                const pluginView = zoomedView as PluginCanvasViewType;
                const registered = getRegisteredWidgetType(pluginView.pluginWidgetType);
                if (!registered) return null;
                const Component = registered.descriptor.component;
                return (
                  <Component
                    widgetId={zoomedView.id}
                    api={api}
                    metadata={zoomedView.metadata}
                    onUpdateMetadata={(updates: CanvasWidgetMetadata) => onUpdateView(zoomedView.id, { metadata: { ...zoomedView.metadata, ...updates } })}
                    size={zoomedView.size}
                  />
                );
              })()}
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

      {/* Wire config popover (screen-space, outside transform container) */}
      {wirePopover && (
        <WireConfigPopover
          binding={wirePopover.binding}
          x={wirePopover.x}
          y={wirePopover.y}
          onClose={handleWirePopoverClose}
        />
      )}

      {/* Zone delete confirmation dialog */}
      {zoneDeleteDialog && (
        <ZoneDeleteDialog
          zoneName={zoneDeleteDialog.zoneName}
          containedCount={zoneDeleteDialog.containedCount}
          onConfirm={handleZoneDeleteConfirm}
          onCancel={() => setZoneDeleteDialog(null)}
        />
      )}
    </div>
  );
}
