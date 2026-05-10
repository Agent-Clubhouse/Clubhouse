/**
 * useViewportControls — pan, zoom, keyboard navigation, and auto-layout.
 *
 * Extracted from CanvasWorkspace to isolate viewport state so zoom/pan
 * changes don't cascade re-renders into selection or zone sub-trees.
 */

import { useCallback, useRef } from 'react';
import type { CanvasView, ZoneCanvasView, Viewport, Position } from './canvas-types';
import { zoomTowardPoint, clampZoom, viewportToCenterView, viewportToFitViews, resolveRadialRootId } from './canvas-operations';
import type { AutolayoutOptions } from './CanvasControls';
import type { McpBindingEntry } from '../../../stores/mcpBindingStore';

/** Pixels to pan per arrow key press. */
const ARROW_PAN_STEP = 40;

export interface ViewportControlsOptions {
  viewport: Viewport;
  views: CanvasView[];
  wireDefinitions: McpBindingEntry[];
  selectedViewId: string | null;
  layoutCenterId: string | null;
  containerRef: React.RefObject<HTMLDivElement | null>;
  onViewportChange: (viewport: Viewport) => void;
  onMoveViews: (positions: Map<string, Position>) => void;
  onUpdateWireDefinition: (agentId: string, targetId: string, updates: Partial<McpBindingEntry>) => void;
  onFocusView?: (viewId: string) => void;
}

export interface ViewportControlsResult {
  handleWheel: (e: React.WheelEvent) => void;
  handleKeyDown: (e: React.KeyboardEvent, selectedViewId: string | null, selectedViewIds: string[], onClearSelection: () => void) => void;
  handleZoomIn: () => void;
  handleZoomOut: () => void;
  handleZoomReset: () => void;
  handleCenter: () => void;
  handleSizeToFit: () => void;
  handleAutolayout: (opts: AutolayoutOptions) => Promise<void>;
  handleSearchSelect: (viewId: string) => void;
  handleCenterView: (viewId: string) => void;
  panStartRef: React.RefObject<{ x: number; y: number; panX: number; panY: number }>;
}

export function useViewportControls({
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
}: ViewportControlsOptions): ViewportControlsResult {
  const panStartRef = useRef({ x: 0, y: 0, panX: 0, panY: 0 });

  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (!containerRef.current) return;
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const delta = -e.deltaY * 0.002;
      const newZoom = clampZoom(viewport.zoom * (1 + delta));
      const rect = containerRef.current.getBoundingClientRect();
      onViewportChange(zoomTowardPoint(viewport, newZoom, e.clientX, e.clientY, rect));
    } else {
      onViewportChange({
        panX: viewport.panX - e.deltaX / viewport.zoom,
        panY: viewport.panY - e.deltaY / viewport.zoom,
        zoom: viewport.zoom,
      });
    }
  }, [viewport, onViewportChange, containerRef]);

  const handleKeyDown = useCallback((
    e: React.KeyboardEvent,
    currentSelectedViewId: string | null,
    selectedViewIds: string[],
    onClearSelection: () => void,
  ) => {
    if (e.key === 'Escape') {
      if (currentSelectedViewId || selectedViewIds.length > 0) {
        e.preventDefault();
        onClearSelection();
        containerRef.current?.focus();
        return;
      }
    }
    if (currentSelectedViewId) return;

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
    onViewportChange({ panX: viewport.panX + dx, panY: viewport.panY + dy, zoom: viewport.zoom });
  }, [viewport, onViewportChange, containerRef]);

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
  }, [views, onViewportChange, containerRef]);

  const handleSearchSelect = useCallback((viewId: string) => {
    const view = views.find((v) => v.id === viewId);
    if (!view) return;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    onViewportChange(viewportToCenterView(view, rect.width, rect.height, viewport.zoom));
    onFocusView?.(viewId);
  }, [views, viewport.zoom, onViewportChange, containerRef, onFocusView]);

  const handleCenterView = useCallback((viewId: string) => {
    const view = views.find((v) => v.id === viewId);
    if (!view) return;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    onViewportChange(viewportToCenterView(view, rect.width, rect.height, viewport.zoom));
  }, [views, viewport.zoom, onViewportChange, containerRef]);

  const handleAutolayout = useCallback(async (opts: AutolayoutOptions) => {
    if (views.length === 0) return;

    const zoneViews = views.filter(v => v.type === 'zone') as ZoneCanvasView[];
    const elkZones = zoneViews.map(z => ({
      id: z.id,
      width: z.size.width,
      height: z.size.height,
      childIds: z.containedViewIds || [],
    }));

    const nonZoneViews = views.filter(v => v.type !== 'zone');
    const cardIdSet = new Set(nonZoneViews.map(v => v.id));
    const elkCards = nonZoneViews.map(v => {
      const zoneId = zoneViews.find(z => (z.containedViewIds || []).includes(v.id))?.id;
      return { id: v.id, width: v.size.width, height: v.size.height, zoneId };
    });

    const edgeIndexToWire: Array<{ agentId: string; targetId: string }> = [];
    const elkEdges: Array<{ id: string; source: string; target: string }> = [];
    for (let i = 0; i < wireDefinitions.length; i++) {
      const wire = wireDefinitions[i];
      const sourceView = nonZoneViews.find(v => (v as any).agentId === wire.agentId || v.id === wire.agentId);
      const targetView = nonZoneViews.find(v => (v as any).agentId === wire.targetId || v.id === wire.targetId);
      if (sourceView && targetView && cardIdSet.has(sourceView.id) && cardIdSet.has(targetView.id)) {
        const edgeId = `e${elkEdges.length}`;
        elkEdges.push({ id: edgeId, source: sourceView.id, target: targetView.id });
        edgeIndexToWire.push({ agentId: wire.agentId, targetId: wire.targetId });
      }
    }

    const rootId = resolveRadialRootId(opts.algorithm, selectedViewId, layoutCenterId);

    try {
      const result = await window.clubhouse.canvas.layoutElk({
        cards: elkCards,
        edges: elkEdges,
        zones: elkZones,
        options: { algorithm: opts.algorithm, direction: opts.direction, rootId, layoutCenterId: layoutCenterId ?? undefined },
      });

      const targetMap = new Map(result.nodes.map(n => [n.id, { x: n.x, y: n.y }]));
      const startPositions = new Map(nonZoneViews.map(v => [v.id, { ...v.position }]));
      const duration = 500;
      const startTime = performance.now();
      const wireMap = [...edgeIndexToWire];

      function animateStep(now: number) {
        const elapsed = now - startTime;
        const t = Math.min(elapsed / duration, 1);
        const ease = 1 - Math.pow(1 - t, 3);
        const positions = new Map<string, Position>();
        for (const [id, start] of startPositions) {
          const target = targetMap.get(id);
          if (!target) continue;
          positions.set(id, { x: Math.round(start.x + (target.x - start.x) * ease), y: Math.round(start.y + (target.y - start.y) * ease) });
        }
        onMoveViews(positions);
        if (t < 1) {
          requestAnimationFrame(animateStep);
        } else {
          for (const edge of result.edges) {
            const idx = parseInt(edge.id.slice(1));
            const wire = wireMap[idx];
            if (wire) onUpdateWireDefinition(wire.agentId, wire.targetId, { routedPath: edge.path });
          }
        }
      }

      requestAnimationFrame(animateStep);
    } catch (err) {
      console.error('[Autolayout] layout failed:', err);
    }
  }, [views, wireDefinitions, selectedViewId, layoutCenterId, onMoveViews, onUpdateWireDefinition]);

  return {
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
  };
}
