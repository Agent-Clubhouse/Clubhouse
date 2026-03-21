/**
 * useWiring — hook managing wire drag state, hit-testing, and validation.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import type { CanvasView, AgentCanvasView as AgentCanvasViewType, PluginCanvasView as PluginCanvasViewType, Position, Viewport } from './canvas-types';
import { screenToCanvas } from './canvas-operations';
import { useMcpBindingStore } from '../../../stores/mcpBindingStore';

export interface WireDragState {
  /** The agent view initiating the drag. */
  sourceView: AgentCanvasViewType;
  /** Current mouse position in canvas-space. */
  canvasPos: Position;
  /** The view currently hovered (if valid target). */
  hoveredViewId: string | null;
  /** Whether the hovered view is a valid connection target. */
  hoveredValid: boolean;
}

export function isValidWireTarget(source: AgentCanvasViewType, target: CanvasView): boolean {
  if (target.id === source.id) return false;
  if (target.type === 'agent' && (target as AgentCanvasViewType).agentId) return true;
  if (target.type === 'plugin' && (target as PluginCanvasViewType).pluginWidgetType === 'plugin:browser:webview') return true;
  if (target.type === 'plugin' && (target as PluginCanvasViewType).pluginWidgetType === 'plugin:group-project:group-project' && target.metadata?.groupProjectId) return true;
  return false;
}

function targetKind(view: CanvasView): 'agent' | 'browser' | 'group-project' {
  if (view.type === 'agent') return 'agent';
  if (view.type === 'plugin' && (view as PluginCanvasViewType).pluginWidgetType === 'plugin:group-project:group-project') return 'group-project';
  return 'browser';
}

function hitTestViews(canvasPos: Position, views: CanvasView[]): CanvasView | null {
  // Check in reverse z-order (highest z-index first)
  const sorted = [...views].sort((a, b) => b.zIndex - a.zIndex);
  for (const v of sorted) {
    if (
      canvasPos.x >= v.position.x &&
      canvasPos.x <= v.position.x + v.size.width &&
      canvasPos.y >= v.position.y &&
      canvasPos.y <= v.position.y + v.size.height
    ) {
      return v;
    }
  }
  return null;
}

export function useWiring(
  views: CanvasView[],
  viewport: Viewport,
  containerRef: React.RefObject<HTMLDivElement | null>,
) {
  const [wireDrag, setWireDrag] = useState<WireDragState | null>(null);
  const bind = useMcpBindingStore((s) => s.bind);
  const viewsRef = useRef(views);
  viewsRef.current = views;
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;

  const startWireDrag = useCallback((sourceView: AgentCanvasViewType) => {
    // Initialize at the source view center
    const cx = sourceView.position.x + sourceView.size.width / 2;
    const cy = sourceView.position.y + sourceView.size.height / 2;
    setWireDrag({
      sourceView,
      canvasPos: { x: cx, y: cy },
      hoveredViewId: null,
      hoveredValid: false,
    });
  }, []);

  const cancelWireDrag = useCallback(() => {
    setWireDrag(null);
  }, []);

  // Global mouse tracking during wire drag
  useEffect(() => {
    if (!wireDrag) return;

    const handleMouseMove = (e: MouseEvent) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const canvasPos = screenToCanvas(e.clientX, e.clientY, rect, viewportRef.current);
      const hitView = hitTestViews(canvasPos, viewsRef.current);
      const valid = hitView ? isValidWireTarget(wireDrag.sourceView, hitView) : false;
      setWireDrag((prev) => prev ? {
        ...prev,
        canvasPos,
        hoveredViewId: hitView?.id ?? null,
        hoveredValid: valid,
      } : null);
    };

    const handleMouseUp = (e: MouseEvent) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const canvasPos = screenToCanvas(e.clientX, e.clientY, rect, viewportRef.current);
      const hitView = hitTestViews(canvasPos, viewsRef.current);

      if (hitView && isValidWireTarget(wireDrag.sourceView, hitView) && wireDrag.sourceView.agentId) {
        const kind = targetKind(hitView);
        // For agent targets, use the real agent ID (durable_*/quick_*) not the
        // canvas view ID (cv_*). Canvas view IDs are ephemeral, tab-scoped, and
        // not resolvable by the main process agent registry.
        const resolvedTargetId = kind === 'agent'
          ? (hitView as AgentCanvasViewType).agentId ?? hitView.id
          : kind === 'group-project'
          ? (hitView.metadata?.groupProjectId as string) ?? hitView.id
          : hitView.id;
        const projectName = (hitView.metadata?.projectName as string)
          || (wireDrag.sourceView.metadata?.projectName as string)
          || undefined;
        bind(wireDrag.sourceView.agentId, {
          targetId: resolvedTargetId,
          targetKind: kind,
          label: hitView.displayName || hitView.title,
          agentName: wireDrag.sourceView.displayName || wireDrag.sourceView.title,
          targetName: hitView.displayName || hitView.title,
          projectName,
        });
      }

      setWireDrag(null);
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setWireDrag(null);
      }
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [wireDrag, containerRef, bind]);

  return {
    wireDrag,
    startWireDrag,
    cancelWireDrag,
    isWireDragging: wireDrag !== null,
  };
}
