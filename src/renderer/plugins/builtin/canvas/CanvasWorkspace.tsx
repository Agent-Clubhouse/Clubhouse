import React, { useCallback, useMemo, useRef, useState, useEffect } from 'react';
import type { CanvasView, CanvasViewType, ZoneCanvasView, Viewport, Position, Size } from './canvas-types';
import { GRID_SIZE, MIN_VIEW_WIDTH, MIN_VIEW_HEIGHT } from './canvas-types';
import type { ResizeDirection } from './CanvasView';
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
import { MenuPortal } from './MenuPortal';
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
import type { AutolayoutOptions } from './CanvasControls';
import { useMcpSettingsStore } from '../../../stores/mcpSettingsStore';
import { useAnnexClientStore } from '../../../stores/annexClientStore';
import { useRemoteProjectStore } from '../../../stores/remoteProjectStore';
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
  /** Canvas-owned wire definitions — persists across agent sleep/wake cycles. */
  wireDefinitions: McpBindingEntry[];
  onAddWireDefinition: (entry: McpBindingEntry) => void;
  onRemoveWireDefinition: (agentId: string, targetId: string) => void;
  onUpdateWireDefinition: (agentId: string, targetId: string, updates: Partial<McpBindingEntry>) => void;
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
  minimapAutoHide: boolean;
  onMinimapAutoHideChange: (value: boolean) => void;
  elkAlgorithm: 'layered' | 'radial' | 'force' | 'mrtree';
  elkDirection: 'RIGHT' | 'DOWN' | 'LEFT' | 'UP';
  layoutCenterId: string | null;
  onElkAlgorithmChange: (value: 'layered' | 'radial' | 'force' | 'mrtree') => void;
  onElkDirectionChange: (value: 'RIGHT' | 'DOWN' | 'LEFT' | 'UP') => void;
  onSetLayoutCenterId: (value: string | null) => void;
  /** When true, render all agent-to-agent wires as bidirectional. */
  bidirectionalWires?: boolean;
  /** When true, auto-create reverse direction for agent-to-agent wires. */
  createBidirectionalWires?: boolean;
}

export function CanvasWorkspace({
  views,
  viewport,
  zoomedViewId,
  selectedViewId,
  selectedViewIds,
  wireDefinitions,
  onAddWireDefinition,
  onRemoveWireDefinition,
  onUpdateWireDefinition,
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
  minimapAutoHide,
  onMinimapAutoHideChange,
  elkAlgorithm,
  elkDirection,
  layoutCenterId,
  onElkAlgorithmChange,
  onElkDirectionChange,
  onSetLayoutCenterId,
  bidirectionalWires,
  createBidirectionalWires,
}: CanvasWorkspaceProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isPanning, setIsPanning] = useState(false);
  const panStartRef = useRef({ x: 0, y: 0, panX: 0, panY: 0 });
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; canvasX: number; canvasY: number } | null>(null);
  const [viewContextMenu, setViewContextMenu] = useState<{ x: number; y: number; viewId: string } | null>(null);
  const [containerSize, setContainerSize] = useState<Size>({ width: 0, height: 0 });

  // ── Selection rectangle (lasso) ──────────────────────────────
  const [selectionRect, setSelectionRect] = useState<SelectionRect | null>(null);

  // ── Multi-drag state ─────────────────────────────────────────
  const [multiDrag, setMultiDrag] = useState<MultiDragState | null>(null);
  const [multiDragDelta, setMultiDragDelta] = useState<{ dx: number; dy: number }>({ dx: 0, dy: 0 });

  // ── Zone drag state ─────────────────────────────────────────
  const [zoneDrag, setZoneDrag] = useState<{ zoneId: string; containedViewIds: string[] } | null>(null);
  const [zoneDragDelta, setZoneDragDelta] = useState<{ dx: number; dy: number }>({ dx: 0, dy: 0 });

  // ── Zone resize state ──────────────────────────────────────
  const [zoneResize, setZoneResize] = useState<{ zoneId: string; size: Size; position: Position } | null>(null);

  // ── Single-view drag position tracking (for wire overlay) ─────
  const [singleDragPos, setSingleDragPos] = useState<Map<string, Position>>(new Map());

  // ── MCP wiring state ──────────────────────────────────────────
  const mcpEnabled = !!useMcpSettingsStore((s) => s.enabled);
  // Live bindings used for the config popover's live state (instructions, etc.)
  const mcpBindings = useMcpBindingStore((s) => s.bindings);
  const addZoneWire = useZoneWireStore((s) => s.addWire);
  const mcpBind = useMcpBindingStore((s) => s.bind);

  // Merge wireDefinitions with live MCP bindings so the overlay shows both
  // canvas-persisted wires (survive sleep) and zone-expanded wires (dynamic).
  const mergedWireBindings = useMemo(() => {
    const definitionKeys = new Set(wireDefinitions.map((w) => `${w.agentId}\0${w.targetId}`));
    // Start with all wire definitions, then add any live MCP bindings not
    // already covered (e.g. zone-expanded bindings).
    const extras = mcpBindings.filter((b) => !definitionKeys.has(`${b.agentId}\0${b.targetId}`));
    return extras.length > 0 ? [...wireDefinitions, ...extras] : wireDefinitions;
  }, [wireDefinitions, mcpBindings]);

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

  const handleAddWireDef = useCallback((entry: { agentId: string; targetId: string; targetKind: string; label: string; agentName?: string; targetName?: string; projectName?: string }) => {
    onAddWireDefinition(entry as McpBindingEntry);
  }, [onAddWireDefinition]);

  const { wireDrag, startWireDrag, isWireDragging } = useWiring(views, viewport, containerRef, handleZoneWire, handleAddWireDef, createBidirectionalWires);
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
  // Also subscribe to remote agent state changes so wires re-render after annex wake
  const remoteAgents = useRemoteProjectStore((s) => s.remoteAgents);
  const sleepingAgentIds = useMemo(() => {
    void agentTick; // reactive dependency
    const sleeping = new Set<string>();
    // Local agents
    const agents = api.agents.list();
    for (const agent of agents) {
      if (agent.status === 'sleeping' || agent.status === 'error') {
        sleeping.add(agent.id);
      }
    }
    // Remote agents (annex)
    for (const [nsId, agent] of Object.entries(remoteAgents)) {
      if (agent.status === 'sleeping' || agent.status === 'error') {
        sleeping.add(nsId);
      }
    }
    return sleeping;
  }, [api, agentTick, remoteAgents]);

  // ── Satellite pause detection (full canvas overlay) ───────────
  const satellitePaused = useAnnexClientStore((s) => s.satellitePaused);
  const isAnySatellitePaused = useMemo(
    () => Object.values(satellitePaused).some(Boolean),
    [satellitePaused],
  );

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
    setViewContextMenu(null);
  }, []);

  // ── View context menu (right-click on card) ────────────────────

  const handleViewContextMenu = useCallback((viewId: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setViewContextMenu({ x: e.clientX, y: e.clientY, viewId });
  }, []);

  const handleSetLayoutCenter = useCallback((viewId: string) => {
    onSetLayoutCenterId(layoutCenterId === viewId ? null : viewId);
    setViewContextMenu(null);
  }, [layoutCenterId, onSetLayoutCenterId]);

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

  // ── Auto Layout (ELK-based, supports multiple algorithms) ────────

  const handleAutolayout = useCallback(async (opts: AutolayoutOptions) => {
    if (views.length === 0) return;

    // Build zones
    const zoneViews = views.filter(v => v.type === 'zone') as ZoneCanvasView[];
    const elkZones = zoneViews.map(z => ({
      id: z.id,
      width: z.size.width,
      height: z.size.height,
      childIds: z.containedViewIds || [],
    }));

    // Build cards (non-zone views only — zones are compound containers, not nodes)
    const nonZoneViews = views.filter(v => v.type !== 'zone');
    const cardIdSet = new Set(nonZoneViews.map(v => v.id));
    const elkCards = nonZoneViews.map(v => {
      const zoneId = zoneViews.find(z => (z.containedViewIds || []).includes(v.id))?.id;
      return { id: v.id, width: v.size.width, height: v.size.height, zoneId };
    });

    // Build edges from wire definitions — map wire index to edge id for post-layout lookup
    const edgeIndexToWire: Array<{ agentId: string; targetId: string }> = [];
    const elkEdges: Array<{ id: string; source: string; target: string }> = [];
    for (let i = 0; i < wireDefinitions.length; i++) {
      const wire = wireDefinitions[i];
      const sourceView = nonZoneViews.find(v => (v as any).agentId === wire.agentId || v.id === wire.agentId);
      const targetView = nonZoneViews.find(v => (v as any).agentId === wire.targetId || v.id === wire.targetId);
      // Only include edges where both endpoints exist as card nodes (not zones)
      if (sourceView && targetView && cardIdSet.has(sourceView.id) && cardIdSet.has(targetView.id)) {
        const edgeId = `e${elkEdges.length}`;
        elkEdges.push({ id: edgeId, source: sourceView.id, target: targetView.id });
        edgeIndexToWire.push({ agentId: wire.agentId, targetId: wire.targetId });
      }
    }

    // For radial layout, use selected view as root, falling back to stored center
    const rootId = opts.algorithm === 'radial' && selectedViewId ? selectedViewId : undefined;

    try {
      const result = await window.clubhouse.canvas.layoutElk({
        cards: elkCards,
        edges: elkEdges,
        zones: elkZones,
        options: {
          algorithm: opts.algorithm,
          direction: opts.direction,
          rootId,
          layoutCenterId: layoutCenterId ?? undefined,
        },
      });

      // Animate to positions
      const targetMap = new Map(result.nodes.map(n => [n.id, { x: n.x, y: n.y }]));
      const startPositions = new Map(nonZoneViews.map(v => [v.id, { ...v.position }]));
      const duration = 500;
      const startTime = performance.now();
      // Snapshot wire mapping — safe to use after async animation completes
      const wireMap = [...edgeIndexToWire];

      function animateStep(now: number) {
        const elapsed = now - startTime;
        const t = Math.min(elapsed / duration, 1);
        const ease = 1 - Math.pow(1 - t, 3);

        const positions = new Map<string, Position>();
        for (const [id, start] of startPositions) {
          const target = targetMap.get(id);
          if (!target) continue;
          positions.set(id, {
            x: Math.round(start.x + (target.x - start.x) * ease),
            y: Math.round(start.y + (target.y - start.y) * ease),
          });
        }
        onMoveViews(positions);

        if (t < 1) {
          requestAnimationFrame(animateStep);
        } else {
          // After animation, store routed paths on wire definitions
          for (const edge of result.edges) {
            const idx = parseInt(edge.id.slice(1));
            const wire = wireMap[idx];
            if (wire) {
              onUpdateWireDefinition(wire.agentId, wire.targetId, { routedPath: edge.path });
            }
          }
        }
      }

      requestAnimationFrame(animateStep);
    } catch (err) {
      console.error('[Autolayout] layout failed:', err);
    }
  }, [views, wireDefinitions, selectedViewId, layoutCenterId, onMoveViews, onUpdateWireDefinition]);

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
          const snappedSize = snapSize(current.size);
          const snappedPos = snapPosition(current.position);
          onResizeView(zoneId, snappedSize);
          onMoveView(zoneId, snappedPos);
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
            resizeOverride={zoneResize?.zoneId === zone.id ? { size: zoneResize.size, position: zoneResize.position } : undefined}
            onResizeStart={(dir, e) => handleZoneResizeStart(zone.id, dir, e)}
          />
        ))}

        {/* Layer 2: MCP wire overlay — rendered from wireDefinitions merged
            with live MCP bindings.  wireDefinitions ensure individually-created
            wires survive agent sleep; live bindings cover zone-expanded wires
            and any other dynamically-created bindings.
            Wrapped with z-index above zone backgrounds so wires inside a zone
            remain visible and clickable. */}
        {mcpEnabled && (
          <div
            data-testid="wire-layer"
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              zIndex: zones.reduce((max, z) => Math.max(max, z.zIndex), -1) + 1,
            }}
          >
            <WireOverlay
              views={views}
              bindings={mergedWireBindings}
              viewPositions={wireViewPositions}
              sleepingAgentIds={sleepingAgentIds}
              onWireClick={handleWireClick}
              forceBidirectional={bidirectionalWires}
            />
          </div>
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
                zoneThemeId={themeOverride}
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
                onViewContextMenu={(e) => handleViewContextMenu(view.id, e)}
                isLayoutCenter={layoutCenterId === view.id}
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

      {/* Satellite pause overlay — covers entire canvas content area */}
      {isAnySatellitePaused && (
        <div
          className="absolute inset-0 z-[9998] flex items-center justify-center bg-ctp-crust/80 backdrop-blur-sm"
          data-testid="canvas-satellite-paused-overlay"
        >
          <div className="text-center">
            <div className="w-12 h-12 mx-auto mb-4 rounded-full bg-surface-2 flex items-center justify-center">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" className="text-ctp-subtext0">
                <rect x="6" y="4" width="4" height="16" rx="1" />
                <rect x="14" y="4" width="4" height="16" rx="1" />
              </svg>
            </div>
            <p className="text-sm text-ctp-subtext0 font-medium">Session paused</p>
            <p className="text-xs text-ctp-overlay0 mt-1">The satellite has paused remote control</p>
          </div>
        </div>
      )}

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
          autoHide={minimapAutoHide}
          onAutoHideChange={onMinimapAutoHideChange}
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
                    api={registered.pluginApi ?? api}
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

      {/* Compute pinned widgets */}
      {useMemo(() => {
        const pinnedWidgets = views
          .filter((v): v is PluginCanvasViewType =>
            v.type === 'plugin' && !!(v.metadata as CanvasWidgetMetadata).__pinnedToControls
          )
          .map((view) => {
            const registered = getRegisteredWidgetType(view.pluginWidgetType);
            return registered ? {
              view,
              registered,
              onUpdateMetadata: (updates: CanvasWidgetMetadata) => {
                // When unpinning, place widget in current viewport instead of old position
                const newMetadata = { ...view.metadata, ...updates };
                const isUnpinning = updates.__pinnedToControls === false && (view.metadata as CanvasWidgetMetadata).__pinnedToControls === true;

                if (isUnpinning) {
                  // Use existing screenToCanvas to convert viewport center to canvas coords
                  const rect = containerRef.current?.getBoundingClientRect();
                  if (!rect) {
                    onUpdateView(view.id, { metadata: newMetadata });
                    return;
                  }

                  const viewportCenter = screenToCanvas(
                    rect.left + containerSize.width / 2,
                    rect.top + containerSize.height / 2,
                    rect,
                    viewport
                  );

                  // Use widget's current size or a sensible default
                  const widgetSize = view.size || { width: 300, height: 300 };

                  // Helper to check if position overlaps with any view
                  const doesOverlap = (px: number, py: number) => {
                    for (const otherView of views) {
                      if (otherView.id === view.id || otherView.type === 'zone') continue;
                      const ox = otherView.position.x;
                      const oy = otherView.position.y;
                      const ow = otherView.size.width;
                      const oh = otherView.size.height;
                      if (px < ox + ow && px + widgetSize.width > ox &&
                          py < oy + oh && py + widgetSize.height > oy) {
                        return true;
                      }
                    }
                    return false;
                  };

                  // Try viewport center first, then corners
                  const viewportWidth = containerSize.width / viewport.zoom;
                  const viewportHeight = containerSize.height / viewport.zoom;

                  const candidates = [
                    // Center
                    { x: viewportCenter.x - widgetSize.width / 2, y: viewportCenter.y - widgetSize.height / 2 },
                    // Top-left
                    { x: viewportCenter.x - viewportWidth / 3, y: viewportCenter.y - viewportHeight / 3 },
                    // Top-right
                    { x: viewportCenter.x + viewportWidth / 3 - widgetSize.width, y: viewportCenter.y - viewportHeight / 3 },
                    // Bottom-left
                    { x: viewportCenter.x - viewportWidth / 3, y: viewportCenter.y + viewportHeight / 3 - widgetSize.height },
                    // Bottom-right
                    { x: viewportCenter.x + viewportWidth / 3 - widgetSize.width, y: viewportCenter.y + viewportHeight / 3 - widgetSize.height },
                  ];

                  let finalPos = candidates[0]; // Default to center
                  for (const candidate of candidates) {
                    if (!doesOverlap(candidate.x, candidate.y)) {
                      finalPos = candidate;
                      break;
                    }
                  }

                  onUpdateView(view.id, {
                    metadata: newMetadata,
                    position: finalPos,
                    size: widgetSize,
                  });
                } else {
                  onUpdateView(view.id, { metadata: newMetadata });
                }
              }
            } : null;
          })
          .filter((item): item is NonNullable<typeof item> => item !== null);

        return (
          <>
            <CanvasControls
              zoom={viewport.zoom}
              onZoomIn={handleZoomIn}
              onZoomOut={handleZoomOut}
              onZoomReset={handleZoomReset}
              onCenter={handleCenter}
              onSizeToFit={handleSizeToFit}
              onAutolayout={handleAutolayout}
              hasSelection={selectedViewId !== null}
              elkAlgorithm={elkAlgorithm}
              elkDirection={elkDirection}
              layoutCenterId={layoutCenterId}
              onElkAlgorithmChange={onElkAlgorithmChange}
              onElkDirectionChange={onElkDirectionChange}
              hasViews={views.length > 0}
              views={views}
              onSelectView={handleSearchSelect}
              attentionMap={attentionMap}
              api={api}
              pinnedWidgets={pinnedWidgets}
            />

            {/* Pinned widgets bar */}
            {pinnedWidgets.length > 0 && (
              <div
                className="absolute top-12 right-3 flex items-center gap-1 bg-ctp-mantle/90 backdrop-blur-sm rounded-lg border border-surface-0 px-1.5 py-1 shadow-sm flex-wrap max-w-[calc(100%-24px)]"
                data-testid="canvas-pinned-widgets"
              >
                {pinnedWidgets.map((item) => {
                  const PinnedComponent = item.registered.descriptor.pinnedComponent;
                  if (!PinnedComponent) return null;

                  return (
                    <div
                      key={item.view.id}
                      className="flex items-center gap-1 px-2 py-1 bg-surface-0/50 rounded"
                    >
                      <div className="flex-1">
                        <PinnedComponent
                          widgetId={item.view.id}
                          api={item.registered.pluginApi ?? api}
                          metadata={item.view.metadata}
                          onUpdateMetadata={item.onUpdateMetadata}
                        />
                      </div>
                      <button
                        onClick={() => item.onUpdateMetadata({ __pinnedToControls: false })}
                        className="w-4 h-4 flex items-center justify-center rounded text-ctp-blue hover:bg-surface-1 transition-colors flex-shrink-0"
                        title="Unpin from toolbar"
                        data-testid={`canvas-unpin-${item.view.id}`}
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                          <polygon points="12 2 8 8 16 8" />
                          <rect x="11" y="8" width="2" height="8" />
                          <circle cx="12" cy="19" r="3" />
                        </svg>
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        );
      }, [views, viewport.zoom, handleZoomIn, handleZoomOut, handleZoomReset, handleCenter, handleSizeToFit, handleSearchSelect, attentionMap, api, onUpdateView])}

      {/* Context menu */}
      {contextMenu && (
        <CanvasContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onSelect={handleContextMenuAction}
          onDismiss={handleDismissContextMenu}
        />
      )}

      {/* View context menu (right-click on card) */}
      {viewContextMenu && (
        <MenuPortal>
          <div
            className="fixed z-[9999] min-w-[180px] bg-ctp-mantle border border-surface-1 rounded-lg shadow-xl py-1 backdrop-blur-none"
            style={{ left: viewContextMenu.x, top: viewContextMenu.y }}
            data-testid="view-context-menu"
          >
            <button
              className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-ctp-text hover:bg-surface-1 transition-colors text-left"
              onClick={() => handleSetLayoutCenter(viewContextMenu.viewId)}
              data-testid="view-context-menu-set-layout-center"
            >
              <span className="w-4 text-center text-ctp-overlay0">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <circle cx="12" cy="12" r="10" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              </span>
              {layoutCenterId === viewContextMenu.viewId ? 'Remove as Layout Center' : 'Set as Layout Center'}
            </button>
            <button
              className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-ctp-text hover:bg-surface-1 transition-colors text-left"
              onClick={() => { handleCenterView(viewContextMenu.viewId); setViewContextMenu(null); }}
              data-testid="view-context-menu-center-view"
            >
              <span className="w-4 text-center text-ctp-overlay0">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <circle cx="12" cy="12" r="3" />
                  <line x1="12" y1="2" x2="12" y2="6" />
                  <line x1="12" y1="18" x2="12" y2="22" />
                  <line x1="2" y1="12" x2="6" y2="12" />
                  <line x1="18" y1="12" x2="22" y2="12" />
                </svg>
              </span>
              Center in Viewport
            </button>
          </div>
        </MenuPortal>
      )}

      {/* Wire config popover (screen-space, outside transform container) */}
      {wirePopover && (
        <WireConfigPopover
          binding={wirePopover.binding}
          x={wirePopover.x}
          y={wirePopover.y}
          onClose={handleWirePopoverClose}
          onAddWireDefinition={onAddWireDefinition}
          onRemoveWireDefinition={onRemoveWireDefinition}
          onUpdateWireDefinition={onUpdateWireDefinition}
          forceBidirectional={bidirectionalWires}
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
