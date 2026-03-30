/**
 * WireOverlay — SVG component rendering MCP binding wires behind canvas widgets.
 *
 * Rendered inside the canvas transform container (before views) so wires are
 * in canvas-space and track with pan/zoom automatically.
 */

import React, { useMemo } from 'react';
import type { CanvasView, AgentCanvasView as AgentCanvasViewType } from './canvas-types';
import type { McpBindingEntry } from '../../../stores/mcpBindingStore';
import { computeWirePath, bezierPathWithOffsets, viewRect, closestEdgeMidpoint } from './wire-utils';
import type { EdgeMidpoint } from './wire-utils';
import { WireFlowDots, WireFlowDotFilters } from './WireFlowDots';
import { useWirePhysics } from './useWirePhysics';
import { useWireActivity } from './useWireActivity';

/** CSS animations for wire glow — ambient is subtle, active is vivid */
const WIRE_GLOW_KEYFRAMES = `
@keyframes wire-pulse {
  0%, 100% { filter: drop-shadow(0 0 3px rgb(var(--wire-color) / 0.4)); }
  50% { filter: drop-shadow(0 0 6px rgb(var(--wire-color) / 0.7)); }
}
@keyframes wire-pulse-active {
  0%, 100% { filter: drop-shadow(0 0 6px rgb(var(--wire-color) / 0.8)); }
  50% { filter: drop-shadow(0 0 12px rgb(var(--wire-color) / 1)); }
}
`;

/** Unidirectional wire color (accent/blue) */
const UNI_COLOR = 'rgb(var(--ctp-accent, 137 180 250))';
/** Bidirectional wire color (success/green) */
const BIDIR_COLOR = 'rgb(var(--ctp-success, 166 227 161))';

/** Check whether a reverse binding exists (agent→target has a matching target→agent). */
function isBidirectional(binding: McpBindingEntry, allBindings: McpBindingEntry[]): boolean {
  if (binding.targetKind !== 'agent') return false;
  return allBindings.some(
    (b) => b.agentId === binding.targetId && b.targetId === binding.agentId,
  );
}

interface WireOverlayProps {
  views: CanvasView[];
  bindings: McpBindingEntry[];
  /** Optional per-view position overrides (e.g. during drag). */
  viewPositions?: Map<string, { x: number; y: number }>;
  /** Agent IDs whose status is sleeping or error — wires to/from them render dimmed. */
  sleepingAgentIds?: Set<string>;
  onWireClick?: (binding: McpBindingEntry, event: React.MouseEvent) => void;
  /** When true, all agent-to-agent wires render as bidirectional regardless of binding direction. */
  forceBidirectional?: boolean;
}

/**
 * Resolve a binding to its source and target views.
 * Source is the agent view (by agentId), target is looked up by targetId = view.id.
 */
function resolveBindingViews(
  binding: McpBindingEntry,
  viewMap: Map<string, CanvasView>,
): { source: CanvasView; target: CanvasView } | null {
  // Find agent view by agentId
  let source: CanvasView | undefined;
  for (const v of viewMap.values()) {
    if (v.type === 'agent' && (v as AgentCanvasViewType).agentId === binding.agentId) {
      source = v;
      break;
    }
  }
  if (!source) return null;

  // Look up target by view id first, then by agentId for agent-to-agent bindings,
  // then by metadata.groupProjectId for group-project bindings.
  let target = viewMap.get(binding.targetId);
  if (!target && binding.targetKind === 'agent') {
    for (const v of viewMap.values()) {
      if (v.type === 'agent' && (v as AgentCanvasViewType).agentId === binding.targetId) {
        target = v;
        break;
      }
    }
  }
  if (!target && binding.targetKind === 'group-project') {
    for (const v of viewMap.values()) {
      if (v.type === 'plugin' && v.metadata?.groupProjectId === binding.targetId) {
        target = v;
        break;
      }
    }
  }
  if (!target) return null;

  return { source, target };
}

/** Per-wire group component — allows calling useWireActivity hook per wire. */
const WireGroup = React.memo(function WireGroup({
  wireKey,
  path,
  binding,
  bidir,
  sleepingAgentIds,
  onWireClick,
}: {
  wireKey: string;
  path: string;
  binding: McpBindingEntry;
  bidir: boolean;
  sleepingAgentIds?: Set<string>;
  onWireClick?: (binding: McpBindingEntry, event: React.MouseEvent) => void;
}) {
  // Keep alive=true so activity indicators fire even for sleeping wires (e.g. wake requests)
  const activity = useWireActivity(wireKey, true);

  // Dim wires when source or target agent is sleeping/error
  const isDimmed = sleepingAgentIds
    ? sleepingAgentIds.has(binding.agentId) || sleepingAgentIds.has(binding.targetId)
    : false;

  const isActive = activity.startsWith('active');
  const wireColor = bidir ? BIDIR_COLOR : UNI_COLOR;
  const wireColorVar = bidir ? 'var(--ctp-success, 166 227 161)' : 'var(--ctp-accent, 137 180 250)';
  const fwdMarker = bidir ? 'url(#wire-arrow-fwd-bidir)' : 'url(#wire-arrow-fwd)';
  const revMarker = 'url(#wire-arrow-rev-bidir)';

  return (
    <g
      data-testid={`wire-group-${wireKey}`}
      data-bidir={bidir ? 'true' : undefined}
      data-activity={activity}
      data-dimmed={isDimmed ? 'true' : undefined}
      style={{ '--wire-color': wireColorVar } as React.CSSProperties}
    >
      {/* Invisible thick hitbox for click interaction */}
      <path
        d={path}
        fill="none"
        stroke="transparent"
        strokeWidth={8}
        style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
        onClick={(e) => onWireClick?.(binding, e)}
        data-testid={`wire-hitbox-${wireKey}`}
      />
      {/* Visible styled wire — solid for bidir, dashed for unidirectional */}
      <path
        d={path}
        fill="none"
        stroke={wireColor}
        strokeWidth={isActive ? 2.5 : 2}
        strokeLinecap="round"
        strokeDasharray={bidir ? undefined : '8 4'}
        markerEnd={fwdMarker}
        markerStart={bidir ? revMarker : undefined}
        style={{
          pointerEvents: 'none',
          animation: isDimmed ? 'none' : isActive ? 'wire-pulse-active 1.5s ease-in-out infinite' : 'wire-pulse 3s ease-in-out infinite',
          opacity: isDimmed ? 0.35 : 1,
          transition: 'opacity 0.5s ease, stroke-width 0.3s ease',
        }}
        data-testid={`wire-path-${wireKey}`}
      />
      {/* Flowing light dots — driven by activity state */}
      <WireFlowDots wireKey={wireKey} activity={activity} bidir={bidir} />
    </g>
  );
});

export const WireOverlay = React.memo(function WireOverlay({
  views,
  bindings,
  viewPositions,
  sleepingAgentIds,
  onWireClick,
  forceBidirectional,
}: WireOverlayProps) {
  const viewMap = useMemo(() => {
    const m = new Map<string, CanvasView>();
    for (const v of views) m.set(v.id, v);
    return m;
  }, [views]);

  const wires = useMemo(() => {
    // Track already-rendered pairs so bidirectional bindings only emit one wire
    const rendered = new Set<string>();
    const result: Array<{
      key: string;
      path: string;
      from: EdgeMidpoint;
      to: EdgeMidpoint;
      fromViewId: string;
      toViewId: string;
      binding: McpBindingEntry;
      bidir: boolean;
    }> = [];

    for (const binding of bindings) {
      // Force all agent-to-agent wires bidirectional when the setting is on
      const bidir = (forceBidirectional && binding.targetKind === 'agent')
        || isBidirectional(binding, bindings);

      // For bidirectional pairs, render only one wire per pair.
      // When both directions exist as real bindings, prefer the one
      // where agentId < targetId for deterministic rendering order.
      if (bidir) {
        const realBidir = isBidirectional(binding, bindings);
        if (realBidir && binding.agentId > binding.targetId) continue;
        const pairKey = [binding.agentId, binding.targetId].sort().join('--');
        if (rendered.has(pairKey)) continue;
        rendered.add(pairKey);
      }

      const resolved = resolveBindingViews(binding, viewMap);
      if (!resolved) continue;

      const { source, target } = resolved;
      const srcPos = viewPositions?.get(source.id) ?? source.position;
      const tgtPos = viewPositions?.get(target.id) ?? target.position;

      const srcRect = viewRect(srcPos, source.size);
      const tgtRect = viewRect(tgtPos, target.size);
      // Use ELK-routed path when available, otherwise compute direct bezier
      const { path, from, to } = binding.routedPath
        ? { path: binding.routedPath, from: closestEdgeMidpoint(srcRect, tgtRect), to: closestEdgeMidpoint(tgtRect, srcRect) }
        : computeWirePath(srcRect, tgtRect);

      result.push({
        key: `${binding.agentId}--${binding.targetId}`,
        path,
        from,
        to,
        fromViewId: source.id,
        toViewId: target.id,
        binding,
        bidir,
      });
    }

    return result;
  }, [bindings, viewMap, viewPositions, forceBidirectional]);

  // Build wire specs for physics hook
  const wireSpecs = useMemo(
    () => wires.map((w) => ({
      key: w.key,
      fromEdge: w.from.edge,
      toEdge: w.to.edge,
      fromViewId: w.fromViewId,
      toViewId: w.toViewId,
    })),
    [wires],
  );

  const wireOffsets = useWirePhysics(wireSpecs, viewPositions, wires.length > 0);

  // Pre-compute physics-adjusted paths once per wire per render,
  // avoiding duplicate bezierPathWithOffsets calls for <defs> and <WireGroup>.
  const resolvedPaths = useMemo(() => {
    const result = new Map<string, string>();
    for (const { key, path, from, to, binding } of wires) {
      // When ELK has routed the path, use it directly — physics offsets
      // would replace the carefully-calculated route with a straight bezier.
      if (binding.routedPath) {
        result.set(key, path);
        continue;
      }
      const offsets = wireOffsets.get(key);
      result.set(
        key,
        offsets
          ? bezierPathWithOffsets(from, to, { dx: offsets.fromDx, dy: offsets.fromDy }, { dx: offsets.toDx, dy: offsets.toDy })
          : path,
      );
    }
    return result;
  }, [wires, wireOffsets]);

  if (wires.length === 0) return null;

  return (
    <svg
      className="absolute top-0 left-0 pointer-events-none overflow-visible"
      style={{ width: 1, height: 1 }}
    >
      <style>{WIRE_GLOW_KEYFRAMES}</style>
      <defs>
        {/* Shared glow filters for flow dots (ambient + active) */}
        <WireFlowDotFilters />
        {/* Unidirectional arrowhead (accent color) */}
        <marker id="wire-arrow-fwd" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="userSpaceOnUse">
          <path d="M 1 1 L 7 4 L 1 7" fill="none" stroke={UNI_COLOR} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </marker>
        {/* Bidirectional arrowheads (success color) */}
        <marker id="wire-arrow-fwd-bidir" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="userSpaceOnUse">
          <path d="M 1 1 L 7 4 L 1 7" fill="none" stroke={BIDIR_COLOR} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </marker>
        <marker id="wire-arrow-rev-bidir" markerWidth="8" markerHeight="8" refX="1" refY="4" orient="auto" markerUnits="userSpaceOnUse">
          <path d="M 7 1 L 1 4 L 7 7" fill="none" stroke={BIDIR_COLOR} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </marker>
        {/* Wire path definitions (referenced by flow dots via <mpath>) */}
        {wires.map(({ key }) => (
          <path key={`def-${key}`} id={`wire-path-${key}`} d={resolvedPaths.get(key)!} fill="none" />
        ))}
      </defs>
      {wires.map(({ key, binding, bidir }) => (
        <WireGroup
          key={key}
          wireKey={key}
          path={resolvedPaths.get(key)!}
          binding={binding}
          bidir={bidir}
          sleepingAgentIds={sleepingAgentIds}
          onWireClick={onWireClick}
        />
      ))}
    </svg>
  );
});
