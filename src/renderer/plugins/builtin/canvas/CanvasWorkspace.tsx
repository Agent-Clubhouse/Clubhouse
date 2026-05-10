import React, { useCallback, useMemo, useRef, useState, useEffect } from 'react';
import type { CanvasView, CanvasViewType, ZoneCanvasView, AgentCanvasView as AgentCanvasViewType, Viewport, Position, Size } from './canvas-types';
import { GRID_SIZE } from './canvas-types';
import type { ResizeDirection } from './CanvasView';
import { snapSize, snapPosition, screenToCanvas, viewportToCenterView } from './canvas-operations';
import { ZoneBackground } from './ZoneBackground';
import { ZoneCard } from './ZoneCard';
import { ZoneDeleteDialog } from './ZoneDeleteDialog';
import { ZoneThemeProvider } from './ZoneThemeProvider';
import { useZoneContainment, getViewThemeOverride } from './zone-containment';
import { CanvasViewComponent } from './CanvasView';
import { CanvasControls } from './CanvasControls';
import { CanvasContextMenu } from './CanvasContextMenu';
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
import { useMcpSettingsStore } from '../../../stores/mcpSettingsStore';
import { useAnnexClientStore } from '../../../stores/annexClientStore';
import { useRemoteProjectStore, isRemoteProjectId, parseNamespacedId } from '../../../stores/remoteProjectStore';
import { useProjectStore } from '../../../stores/projectStore';
import type { PluginAPI, AgentInfo } from '../../../../shared/plugin-types';
import { useBlueprintDrop } from './useBlueprintDrop';
import { getProjectCanvasStore, useAppCanvasStore } from './main';
import { buildWireDefinitionsFromResult, type ParseResult } from '../../../features/blueprints/parse-blueprint';
import { useAgentStore } from '../../../stores/agentStore';
import { useViewportControls } from './useViewportControls';
import { useSelectionManager } from './useSelectionManager';
import { useZoneManager } from './useZoneManager';
import { useCanvasContextMenu } from './useCanvasContextMenu';
import { ZoomedViewOverlay } from './ZoomedViewOverlay';
import { PinnedWidgetBar } from './PinnedWidgetBar';

interface CanvasWorkspaceProps {
  views: CanvasView[];
  viewport: Viewport;
  zoomedViewId: string | null;
  selectedViewId: string | null;
  selectedViewIds: string[];
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
  onCreateAgentCard?: (parentView: AgentCanvasViewType, agent: AgentInfo) => void;
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
  bidirectionalWires?: boolean;
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
  onCreateAgentCard,
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
  const [containerSize, setContainerSize] = useState<Size>({ width: 0, height: 0 });

  // ── MCP / wire store subscriptions ───────────────────────────────
  const mcpEnabled = !!useMcpSettingsStore((s) => s.enabled);
  const mcpBindings = useMcpBindingStore((s) => s.bindings);
  const addZoneWire = useZoneWireStore((s) => s.addWire);
  const mcpBind = useMcpBindingStore((s) => s.bind);

  const mergedWireBindings = useMemo(() => {
    const definitionKeys = new Set(wireDefinitions.map((w) => `${w.agentId}\0${w.targetId}`));
    const extras = mcpBindings.filter((b) => !definitionKeys.has(`${b.agentId}\0${b.targetId}`));
    return extras.length > 0 ? [...wireDefinitions, ...extras] : wireDefinitions;
  }, [wireDefinitions, mcpBindings]);

  const handleZoneWire: ZoneWireCallback = useCallback((sourceZoneId, targetId, targetType) => {
    addZoneWire({ sourceZoneId, targetId, targetType });
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

  // ── Zone containment ──────────────────────────────────────────────
  const zoneContainment = useZoneContainment(views);
  const zones = useMemo(() => views.filter((v): v is ZoneCanvasView => v.type === 'zone'), [views]);
  const nonZoneViews = useMemo(() => views.filter((v) => v.type !== 'zone'), [views]);

  // ── Blueprint drag-drop ──────────────────────────────────────────
  const [blueprintError, setBlueprintError] = useState<string | null>(null);
  const projectId = api.context.projectId ?? null;

  const handleBlueprintImport = useCallback((result: ParseResult) => {
    const store = projectId ? getProjectCanvasStore(projectId) : useAppCanvasStore;
    store.getState().insertCanvas(result.canvas);
    for (const wire of buildWireDefinitionsFromResult(result)) {
      store.getState().addWireDefinition(wire);
    }
  }, [projectId]);

  const handleBlueprintError = useCallback((message: string) => {
    setBlueprintError(message);
  }, []);

  const getBlueprintParseContext = useCallback(() => ({
    agents: Object.values(useAgentStore.getState().agents),
    projects: useProjectStore.getState().projects.map((p) => ({ id: p.id, name: p.name, path: p.path })),
    activeProjectId: projectId ?? undefined,
  }), [projectId]);

  const { isDragOver: isBlueprintDragOver } = useBlueprintDrop({
    containerRef,
    onImport: handleBlueprintImport,
    onError: handleBlueprintError,
    getParseContext: getBlueprintParseContext,
  });

  useEffect(() => {
    if (!blueprintError) return;
    const timer = setTimeout(() => setBlueprintError(null), 4000);
    return () => clearTimeout(timer);
  }, [blueprintError]);

  // ── Sleeping agent tracking (for wire dimming) ─────────────────
  const [sleepingLocalIds, setSleepingLocalIds] = useState<ReadonlySet<string>>(() => {
    const s = new Set<string>();
    for (const a of api.agents.list()) {
      if (a.status === 'sleeping' || a.status === 'error') s.add(a.id);
    }
    return s;
  });
  useEffect(() => {
    const sub = api.agents.onAnyChange(() => {
      setSleepingLocalIds((prev) => {
        const next = new Set<string>();
        for (const a of api.agents.list()) {
          if (a.status === 'sleeping' || a.status === 'error') next.add(a.id);
        }
        if (prev.size === next.size && [...prev].every((id) => next.has(id))) return prev;
        return next;
      });
    });
    return () => sub.dispose();
  }, [api]);

  const remoteAgents = useRemoteProjectStore((s) => s.remoteAgents);
  const sleepingAgentIds = useMemo(() => {
    const sleeping = new Set<string>(sleepingLocalIds);
    for (const [nsId, agent] of Object.entries(remoteAgents)) {
      if (agent.status === 'sleeping' || agent.status === 'error') sleeping.add(nsId);
    }
    return sleeping;
  }, [sleepingLocalIds, remoteAgents]);

  // ── Satellite pause detection ─────────────────────────────────
  const satellitePaused = useAnnexClientStore((s) => s.satellitePaused);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const isAnySatellitePaused = useMemo(() => {
    if (!activeProjectId || !isRemoteProjectId(activeProjectId)) return false;
    const parsed = parseNamespacedId(activeProjectId);
    if (!parsed) return false;
    return !!satellitePaused[parsed.satelliteId];
  }, [satellitePaused, activeProjectId]);

  const handleWireClick = useCallback((binding: McpBindingEntry, event: React.MouseEvent) => {
    setWirePopover({ binding, x: event.clientX, y: event.clientY });
  }, []);

  const handleWirePopoverClose = useCallback(() => setWirePopover(null), []);

  // Load MCP settings on mount
  useEffect(() => {
    useMcpSettingsStore.getState().loadSettings();
  }, []);

  // ── Attention system ───────────────────────────────────────────
  const attentionMap = useCanvasAttention(views, api);

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

  // ── Viewport controls hook ────────────────────────────────────
  const {
    handleWheel,
    handleKeyDown,
    handleZoomIn,
    handleZoomOut,
    handleZoomReset,
    handleCenter,
    handleSizeToFit,
    handleAutolayout,
    handleSearchSelect,
    handleCenterView,
    panStartRef,
  } = useViewportControls({
    viewport,
    views,
    wireDefinitions,
    selectedViewId,
    layoutCenterId,
    containerRef,
    onViewportChange,
    onMoveViews,
    onUpdateWireDefinition,
    onFocusView,
  });

  // ── Selection manager hook ────────────────────────────────────
  const {
    selectionRect,
    multiDrag,
    multiDragDelta,
    singleDragPos,
    setSingleDragPos,
    handleViewMultiDragStart,
    handleViewDragMove,
    handleViewDragEnd,
    startSelectionRect,
  } = useSelectionManager({
    views,
    viewport,
    selectedViewIds,
    containerRef,
    onSetSelectedViewIds,
    onMoveViews,
    onClearSelection,
  });

  // ── Zone manager hook ─────────────────────────────────────────
  const {
    zoneDrag,
    zoneDragDelta,
    zoneResize,
    zoneDeleteDialog,
    handleZoneDragStart,
    handleZoneResizeStart,
    handleZoneDelete,
    handleZoneDeleteConfirm,
    handleZoneDeleteCancel,
  } = useZoneManager({
    zones,
    views,
    viewport,
    onRemoveZone,
    onMoveViews,
    onMoveView,
    onResizeView,
    onSingleDragPosChange: setSingleDragPos,
  });

  // ── Context menu hook ─────────────────────────────────────────
  const {
    contextMenu,
    viewContextMenu,
    viewMenuRef,
    handleContextMenu,
    handleContextMenuAction,
    handleDismissContextMenu,
    handleViewContextMenu,
    handleSetLayoutCenter,
    handleDismissViewContextMenu: _handleDismissViewContextMenu,
    handleCenterViewFromMenu,
  } = useCanvasContextMenu({
    viewport,
    containerRef,
    layoutCenterId,
    onAddView,
    onAddPluginView,
    onSetLayoutCenterId,
  });

  // ── Auto-focus container for arrow-key panning ────────────────
  useEffect(() => {
    containerRef.current?.focus();
  }, []);

  const prevSelectedRef = useRef(selectedViewId);
  useEffect(() => {
    if (prevSelectedRef.current !== null && selectedViewId === null) {
      containerRef.current?.focus();
    }
    prevSelectedRef.current = selectedViewId;
  }, [selectedViewId]);

  // ── Middle-click pan ─────────────────────────────────────────
  useEffect(() => {
    if (!isPanning) return;
    const handleMouseMove = (e: MouseEvent) => {
      const dx = (e.clientX - panStartRef.current.x) / viewport.zoom;
      const dy = (e.clientY - panStartRef.current.y) / viewport.zoom;
      onViewportChange({ panX: panStartRef.current.panX + dx, panY: panStartRef.current.panY + dy, zoom: viewport.zoom });
    };
    const handleMouseUp = () => setIsPanning(false);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isPanning, viewport.zoom, onViewportChange, panStartRef]);

  // ── Mouse down: initiate pan or lasso selection ───────────────
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (isWireDragging) return;
    const isEmptySpace = e.target === e.currentTarget;

    if (e.button === 1) {
      e.preventDefault();
      onSelectView(null);
      containerRef.current?.focus();
      setIsPanning(true);
      panStartRef.current = { x: e.clientX, y: e.clientY, panX: viewport.panX, panY: viewport.panY };
      return;
    }

    if (e.button === 0 && isEmptySpace) {
      e.preventDefault();
      onSelectView(null);
      if (!e.metaKey && !e.ctrlKey) onClearSelection();
      containerRef.current?.focus();
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const canvasPos = screenToCanvas(e.clientX, e.clientY, rect, viewport);
      startSelectionRect(canvasPos.x, canvasPos.y);
    }
  }, [viewport, onSelectView, onClearSelection, isWireDragging, startSelectionRect, panStartRef]);

  // ── View drag/resize end handlers ────────────────────────────
  const handleViewResizeEnd = useCallback((viewId: string, size: Size, position: Position) => {
    onResizeView(viewId, snapSize(size));
    onMoveView(viewId, snapPosition(position));
  }, [onResizeView, onMoveView]);

  const handleToggleZoomView = useCallback((viewId: string) => {
    if (zoomedViewId === viewId) {
      onZoomView(null);
    } else {
      onZoomView(viewId);
      const view = views.find((v) => v.id === viewId);
      if (view) {
        const rect = containerRef.current?.getBoundingClientRect();
        if (rect) {
          onViewportChange(viewportToCenterView(view, rect.width, rect.height, viewport.zoom));
        }
      }
    }
  }, [views, viewport.zoom, zoomedViewId, onZoomView, onViewportChange]);

  // ── Merged positions for wire overlay ────────────────────────
  const wireViewPositions = useMemo(() => {
    const map = new Map<string, Position>();
    for (const [id, pos] of singleDragPos) map.set(id, pos);
    if (multiDrag && (multiDragDelta.dx !== 0 || multiDragDelta.dy !== 0)) {
      for (const v of views) {
        if (selectedViewIds.includes(v.id)) {
          map.set(v.id, { x: v.position.x + multiDragDelta.dx, y: v.position.y + multiDragDelta.dy });
        }
      }
    }
    return map.size > 0 ? map : undefined;
  }, [singleDragPos, multiDrag, multiDragDelta, views, selectedViewIds]);

  const zoomedView = zoomedViewId ? views.find((v) => v.id === zoomedViewId) : null;

  const gridSpacing = GRID_SIZE * viewport.zoom;
  const dotGridStyle: React.CSSProperties = {
    backgroundImage: `radial-gradient(circle, color-mix(in srgb, rgb(var(--ctp-overlay0)) 45%, transparent) 0.75px, transparent 0.75px)`,
    backgroundSize: `${gridSpacing}px ${gridSpacing}px`,
    backgroundPosition: `${viewport.panX * viewport.zoom}px ${viewport.panY * viewport.zoom}px`,
  };

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full overflow-hidden select-none bg-ctp-crust focus:outline-none"
      tabIndex={-1}
      style={dotGridStyle}
      onMouseDown={handleMouseDown}
      onWheel={handleWheel}
      onKeyDown={(e) => handleKeyDown(e, selectedViewId, selectedViewIds, onClearSelection)}
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
        {/* Layer 1: Zone backgrounds */}
        {zones.map((zone) => (
          <ZoneBackground
            key={`zone-bg-${zone.id}`}
            zone={zone}
            dragOffset={zoneDrag?.zoneId === zone.id ? zoneDragDelta : undefined}
            resizeOverride={zoneResize?.zoneId === zone.id ? { size: zoneResize.size, position: zoneResize.position } : undefined}
            onResizeStart={(dir: ResizeDirection, e: React.MouseEvent) => handleZoneResizeStart(zone.id, dir, e)}
          />
        ))}

        {/* Layer 2: MCP wire overlay */}
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

        {/* Layer 3: Non-zone views */}
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
                  (multiDrag != null && selectedViewIds.includes(view.id) && view.id !== multiDrag.dragViewId)
                    ? multiDragDelta
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
                onSelect={() => { onClearSelection(); onSelectView(view.id); }}
                onToggleSelect={() => onToggleSelectView(view.id)}
                onCenterView={() => handleCenterView(view.id)}
                onZoomView={() => handleToggleZoomView(view.id)}
                onDragStart={handleViewMultiDragStart}
                onDragMove={handleViewDragMove}
                onDragEnd={(pos) => handleViewDragEnd(view.id, pos, onMoveView)}
                onResizeEnd={(size, pos) => handleViewResizeEnd(view.id, size, pos)}
                onUpdate={(updates) => onUpdateView(view.id, updates)}
                onCreateAgentCard={onCreateAgentCard}
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

        {/* Lasso selection rectangle */}
        {selectionRect && (
          <div
            className="absolute border-2 border-ctp-accent/60 bg-ctp-accent/10 rounded-sm pointer-events-none"
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

        {wireDrag && <WireDragOverlay wireDrag={wireDrag} views={views} />}

        {multiDrag && selectedViewIds.length > 1 && (() => {
          const primaryView = views.find((v) => v.id === multiDrag.dragViewId);
          if (!primaryView) return null;
          const badgeX = primaryView.position.x + multiDragDelta.dx + primaryView.size.width - 8;
          const badgeY = primaryView.position.y + multiDragDelta.dy - 8;
          return (
            <div
              className="absolute pointer-events-none bg-ctp-accent text-ctp-base text-xs font-bold rounded-full w-6 h-6 flex items-center justify-center"
              style={{ left: badgeX, top: badgeY, zIndex: 99997 }}
              data-testid="canvas-multi-drag-badge"
            >
              {selectedViewIds.length}
            </div>
          );
        })()}
      </div>

      {/* Satellite pause overlay */}
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

      {/* Blueprint drag-drop overlay */}
      {isBlueprintDragOver && (
        <div
          className="absolute inset-0 z-[9997] flex items-center justify-center bg-ctp-accent/10 border-2 border-dashed border-ctp-accent/50 pointer-events-none"
          data-testid="canvas-blueprint-drop-overlay"
        >
          <div className="text-center">
            <div className="w-12 h-12 mx-auto mb-3 rounded-full bg-ctp-accent/20 flex items-center justify-center">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-ctp-accent">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
            </div>
            <p className="text-sm text-ctp-accent font-medium">Drop blueprint to import</p>
          </div>
        </div>
      )}

      {/* Blueprint error toast */}
      {blueprintError && (
        <div
          className="absolute bottom-4 left-1/2 -translate-x-1/2 z-canvas-overlay px-4 py-2 bg-ctp-error text-ctp-text text-sm rounded-lg shadow-lg"
          data-testid="canvas-blueprint-error-toast"
        >
          {blueprintError}
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
        <ZoomedViewOverlay
          view={zoomedView}
          api={api}
          viewport={viewport}
          onClose={() => onZoomView(null)}
          onUpdateView={onUpdateView}
          onCreateAgentCard={onCreateAgentCard}
        />
      )}

      {/* Off-screen attention indicators */}
      <CanvasAttentionIndicators
        indicators={offScreenIndicators}
        onNavigate={handleSearchSelect}
      />

      {/* Canvas controls + pinned widgets */}
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
      />

      <PinnedWidgetBar
        views={views}
        viewport={viewport}
        containerRef={containerRef}
        containerSize={containerSize}
        api={api}
        onUpdateView={onUpdateView}
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

      {/* View context menu */}
      {viewContextMenu && (
        <MenuPortal>
          <div
            ref={viewMenuRef}
            className="fixed z-canvas-overlay min-w-[180px] bg-ctp-mantle border border-surface-1 rounded-lg shadow-xl py-1 backdrop-blur-none"
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
              onClick={() => handleCenterViewFromMenu(viewContextMenu.viewId, handleCenterView)}
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

      {/* Wire config popover */}
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
          onCancel={handleZoneDeleteCancel}
        />
      )}
    </div>
  );
}
