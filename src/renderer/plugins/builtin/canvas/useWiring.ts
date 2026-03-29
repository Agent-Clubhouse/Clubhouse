/**
 * useWiring — hook managing wire drag state, hit-testing, and validation.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import type { CanvasView, AgentCanvasView as AgentCanvasViewType, PluginCanvasView as PluginCanvasViewType, ZoneCanvasView as ZoneCanvasViewType, Position, Viewport } from './canvas-types';
import { screenToCanvas } from './canvas-operations';
import { useMcpBindingStore } from '../../../stores/mcpBindingStore';

export interface WireDragState {
  /** The view initiating the drag (agent or zone). */
  sourceView: AgentCanvasViewType | ZoneCanvasViewType;
  /** Current mouse position in canvas-space. */
  canvasPos: Position;
  /** The view currently hovered (if valid target). */
  hoveredViewId: string | null;
  /** Whether the hovered view is a valid connection target. */
  hoveredValid: boolean;
}

export function isValidWireTarget(source: CanvasView, target: CanvasView): boolean {
  if (target.id === source.id) return false;
  // Zones can target agents, browsers, group projects, agent queues, and other zones
  if (source.type === 'zone' || target.type === 'zone') {
    if (target.type === 'zone' && source.type === 'zone') return true;
    if (target.type === 'zone') return true; // agent -> zone
    if (target.type === 'agent' && (target as AgentCanvasViewType).agentId) return true;
    if (target.type === 'plugin' && (target as PluginCanvasViewType).pluginWidgetType === 'plugin:browser:webview') return true;
    if (target.type === 'plugin' && (target as PluginCanvasViewType).pluginWidgetType === 'plugin:group-project:group-project' && target.metadata?.groupProjectId) return true;
    if (target.type === 'plugin' && (target as PluginCanvasViewType).pluginWidgetType === 'plugin:agent-queue:agent-queue' && target.metadata?.queueId) return true;
    return false;
  }
  if (target.type === 'agent' && (target as AgentCanvasViewType).agentId) return true;
  if (target.type === 'plugin' && (target as PluginCanvasViewType).pluginWidgetType === 'plugin:browser:webview') return true;
  if (target.type === 'plugin' && (target as PluginCanvasViewType).pluginWidgetType === 'plugin:group-project:group-project' && target.metadata?.groupProjectId) return true;
  if (target.type === 'plugin' && (target as PluginCanvasViewType).pluginWidgetType === 'plugin:agent-queue:agent-queue' && target.metadata?.queueId) return true;
  return false;
}

function targetKind(view: CanvasView): 'agent' | 'browser' | 'group-project' | 'agent-queue' | 'zone' {
  if (view.type === 'zone') return 'zone';
  if (view.type === 'agent') return 'agent';
  if (view.type === 'plugin' && (view as PluginCanvasViewType).pluginWidgetType === 'plugin:group-project:group-project') return 'group-project';
  if (view.type === 'plugin' && (view as PluginCanvasViewType).pluginWidgetType === 'plugin:agent-queue:agent-queue') return 'agent-queue';
  return 'browser';
}

export function hitTestViews(canvasPos: Position, views: CanvasView[]): CanvasView | null {
  // Check in reverse z-order (highest z-index first), but prioritize non-zone
  // views over zones so users can wire to individual agents inside zones.
  const sorted = [...views].sort((a, b) => b.zIndex - a.zIndex);
  let fallbackZone: CanvasView | null = null;
  for (const v of sorted) {
    if (
      canvasPos.x >= v.position.x &&
      canvasPos.x <= v.position.x + v.size.width &&
      canvasPos.y >= v.position.y &&
      canvasPos.y <= v.position.y + v.size.height
    ) {
      if (v.type === 'zone') {
        if (!fallbackZone) fallbackZone = v;
        continue;
      }
      return v;
    }
  }
  return fallbackZone;
}

export interface ZoneWireCallback {
  (sourceZoneId: string, targetId: string, targetType: 'zone' | 'agent' | 'group-project' | 'agent-queue' | 'browser'): void;
}

export function useWiring(
  views: CanvasView[],
  viewport: Viewport,
  containerRef: React.RefObject<HTMLDivElement | null>,
  onZoneWire?: ZoneWireCallback,
  /** Callback to persist a wire definition in the canvas store. */
  onAddWireDefinition?: (entry: { agentId: string; targetId: string; targetKind: string; label: string; agentName?: string; targetName?: string; projectName?: string }) => void,
  /** When true (default), agent-to-agent wires auto-create the reverse direction. */
  createBidirectional = true,
) {
  const [wireDrag, setWireDrag] = useState<WireDragState | null>(null);
  const bind = useMcpBindingStore((s) => s.bind);
  const onAddWireDefRef = useRef(onAddWireDefinition);
  onAddWireDefRef.current = onAddWireDefinition;
  const onZoneWireRef = useRef(onZoneWire);
  onZoneWireRef.current = onZoneWire;
  const viewsRef = useRef(views);
  viewsRef.current = views;
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;

  const startWireDrag = useCallback((sourceView: AgentCanvasViewType | ZoneCanvasViewType) => {
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

      if (hitView && isValidWireTarget(wireDrag.sourceView, hitView)) {
        const kind = targetKind(hitView);
        const isZoneInvolved = wireDrag.sourceView.type === 'zone' || kind === 'zone';

        if (isZoneInvolved && onZoneWireRef.current) {
          // Zone wire — delegate to zone wire handler
          const sourceIsZone = wireDrag.sourceView.type === 'zone';
          if (sourceIsZone) {
            // Zone -> target
            const resolvedTargetId = kind === 'agent'
              ? (hitView as AgentCanvasViewType).agentId ?? hitView.id
              : kind === 'group-project'
              ? (hitView.metadata?.groupProjectId as string) ?? hitView.id
              : kind === 'agent-queue'
              ? (hitView.metadata?.queueId as string) ?? hitView.id
              : hitView.id;
            onZoneWireRef.current(wireDrag.sourceView.id, resolvedTargetId, kind as 'zone' | 'agent' | 'group-project' | 'agent-queue' | 'browser');
          } else if (wireDrag.sourceView.type === 'agent' && (wireDrag.sourceView as AgentCanvasViewType).agentId) {
            // Agent -> zone: create a zone wire from the zone to the agent
            onZoneWireRef.current(hitView.id, (wireDrag.sourceView as AgentCanvasViewType).agentId!, 'agent');
          }
        } else if (wireDrag.sourceView.type === 'agent' && (wireDrag.sourceView as AgentCanvasViewType).agentId) {
          // Standard agent wire
          const agentSource = wireDrag.sourceView as AgentCanvasViewType;
          const resolvedTargetId = kind === 'agent'
            ? (hitView as AgentCanvasViewType).agentId ?? hitView.id
            : kind === 'group-project'
            ? (hitView.metadata?.groupProjectId as string) ?? hitView.id
            : kind === 'agent-queue'
            ? (hitView.metadata?.queueId as string) ?? hitView.id
            : hitView.id;
          const projectName = (hitView.metadata?.projectName as string)
            || (agentSource.metadata?.projectName as string)
            || undefined;
          const sourceLabel = agentSource.displayName || agentSource.title;
          const targetLabel = hitView.displayName || hitView.title;
          const fwdTarget = {
            targetId: resolvedTargetId,
            targetKind: kind as 'agent' | 'browser' | 'group-project' | 'agent-queue',
            label: targetLabel,
            agentName: sourceLabel,
            targetName: targetLabel,
            projectName,
          };
          bind(agentSource.agentId!, fwdTarget);
          onAddWireDefRef.current?.({ agentId: agentSource.agentId!, ...fwdTarget });

          // Agent-to-agent wires: optionally create reverse direction
          if (kind === 'agent' && createBidirectional) {
            const revTarget = {
              targetId: agentSource.agentId!,
              targetKind: 'agent' as const,
              label: sourceLabel,
              agentName: targetLabel,
              targetName: sourceLabel,
              projectName,
            };
            bind(resolvedTargetId, revTarget);
            onAddWireDefRef.current?.({ agentId: resolvedTargetId, ...revTarget });
          }
        }
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
  }, [wireDrag, containerRef, bind, createBidirectional]);

  return {
    wireDrag,
    startWireDrag,
    cancelWireDrag,
    isWireDragging: wireDrag !== null,
  };
}
