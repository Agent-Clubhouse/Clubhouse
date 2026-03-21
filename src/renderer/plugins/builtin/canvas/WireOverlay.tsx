/**
 * WireOverlay — SVG component rendering MCP binding wires behind canvas widgets.
 *
 * Rendered inside the canvas transform container (before views) so wires are
 * in canvas-space and track with pan/zoom automatically.
 */

import React, { useMemo } from 'react';
import type { CanvasView, AgentCanvasView as AgentCanvasViewType } from './canvas-types';
import type { McpBindingEntry } from '../../../stores/mcpBindingStore';
import { computeWirePath, bezierPathWithOffsets, viewRect } from './wire-utils';
import type { EdgeMidpoint } from './wire-utils';
import { WireFlowDots } from './WireFlowDots';
import { useWirePhysics } from './useWirePhysics';
import { useWireActivity } from './useWireActivity';

/** CSS animation for ambient wire glow */
const WIRE_GLOW_KEYFRAMES = `
@keyframes wire-pulse {
  0%, 100% { filter: drop-shadow(0 0 3px rgb(var(--ctp-accent, 137 180 250) / 0.4)); }
  50% { filter: drop-shadow(0 0 6px rgb(var(--ctp-accent, 137 180 250) / 0.7)); }
}
`;

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

  return (
    <g data-testid={`wire-group-${wireKey}`} data-bidir={bidir ? 'true' : undefined} data-activity={activity} data-dimmed={isDimmed ? 'true' : undefined}>
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
      {/* Visible styled wire */}
      <path
        d={path}
        fill="none"
        stroke="rgb(var(--ctp-accent, 137 180 250))"
        strokeWidth={2}
        strokeLinecap="round"
        markerEnd="url(#wire-arrow-fwd)"
        markerStart={bidir ? 'url(#wire-arrow-rev)' : undefined}
        style={{
          pointerEvents: 'none',
          animation: isDimmed ? 'none' : 'wire-pulse 3s ease-in-out infinite',
          opacity: isDimmed ? 0.35 : 1,
          transition: 'opacity 0.5s ease',
        }}
        data-testid={`wire-path-${wireKey}`}
      />
      {/* Flowing light dots — driven by activity state */}
      <WireFlowDots wireKey={wireKey} activity={activity} />
    </g>
  );
});

export const WireOverlay = React.memo(function WireOverlay({
  views,
  bindings,
  viewPositions,
  sleepingAgentIds,
  onWireClick,
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
      const bidir = isBidirectional(binding, bindings);

      // For bidirectional pairs, only render the first direction we encounter
      if (bidir) {
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
      const { path, from, to } = computeWirePath(srcRect, tgtRect);

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
  }, [bindings, viewMap, viewPositions]);

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

  if (wires.length === 0) return null;

  return (
    <svg
      className="absolute top-0 left-0 pointer-events-none overflow-visible"
      style={{ width: 1, height: 1, zIndex: 0 }}
    >
      <style>{WIRE_GLOW_KEYFRAMES}</style>
      <defs>
        {/* Forward arrowhead (at target end) */}
        <marker
          id="wire-arrow-fwd"
          markerWidth="8"
          markerHeight="8"
          refX="7"
          refY="4"
          orient="auto"
          markerUnits="userSpaceOnUse"
        >
          <path d="M 1 1 L 7 4 L 1 7" fill="none" stroke="rgb(var(--ctp-accent, 137 180 250))" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </marker>
        {/* Reverse arrowhead (at source end, for bidirectional) */}
        <marker
          id="wire-arrow-rev"
          markerWidth="8"
          markerHeight="8"
          refX="1"
          refY="4"
          orient="auto"
          markerUnits="userSpaceOnUse"
        >
          <path d="M 7 1 L 1 4 L 7 7" fill="none" stroke="rgb(var(--ctp-accent, 137 180 250))" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </marker>
        {/* Wire path definitions (referenced by flow dots via <mpath>) */}
        {wires.map(({ key, path, from, to }) => {
          const offsets = wireOffsets.get(key);
          const defPath = offsets
            ? bezierPathWithOffsets(from, to, { dx: offsets.fromDx, dy: offsets.fromDy }, { dx: offsets.toDx, dy: offsets.toDy })
            : path;
          return <path key={`def-${key}`} id={`wire-path-${key}`} d={defPath} fill="none" />;
        })}
      </defs>
      {wires.map(({ key, path, from, to, binding, bidir }) => {
        const offsets = wireOffsets.get(key);
        const physicsPath = offsets
          ? bezierPathWithOffsets(from, to, { dx: offsets.fromDx, dy: offsets.fromDy }, { dx: offsets.toDx, dy: offsets.toDy })
          : path;
        return (
          <WireGroup
            key={key}
            wireKey={key}
            path={physicsPath}
            binding={binding}
            bidir={bidir}
            sleepingAgentIds={sleepingAgentIds}
            onWireClick={onWireClick}
          />
        );
      })}
    </svg>
  );
});
