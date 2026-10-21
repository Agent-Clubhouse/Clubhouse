/**
 * WireOverlay — SVG component rendering MCP binding wires behind canvas widgets.
 *
 * Rendered inside the canvas transform container (before views) so wires are
 * in canvas-space and track with pan/zoom automatically.
 */

import React, { useMemo } from 'react';
import type { CanvasView } from './canvas-types';
import type { McpBindingEntry } from '../../../stores/mcpBindingStore';
import { computeWirePath, bezierPathWithOffsets, viewRect, closestEdgeMidpoint } from './wire-utils';
import type { EdgeMidpoint } from './wire-utils';
import { WireFlowDots } from './WireFlowDots';
import { useWirePhysics } from './useWirePhysics';
import { useWireActivity } from './useWireActivity';
import type { ZoneWireDefinition } from './zone-wire-store';
import { buildViewIndex, resolveBindingWireViews, resolveZoneWireViews, bindingWireKey } from './wire-render-contract';

/**
 * Wires are plain 1.5px lines in a neutral color (#2020): no glow and no pulse.
 * Direction reads from the arrowheads and the dash; traffic reads from the
 * flow dots.
 */
const WIRE_WIDTH = 1.5;
/** Unidirectional wire color */
const UNI_COLOR = 'rgb(var(--ctp-overlay0))';
/** Bidirectional wire color */
const BIDIR_COLOR = 'rgb(var(--ctp-overlay0))';

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
  /** Zone-level wires — rendered as a single visual wire to the zone. */
  zoneWireDefinitions?: ZoneWireDefinition[];
  /** Optional per-view position overrides (e.g. during drag). */
  viewPositions?: Map<string, { x: number; y: number }>;
  /** Agent IDs whose status is sleeping or error — wires to/from them render dimmed. */
  sleepingAgentIds?: Set<string>;
  onWireClick?: (binding: McpBindingEntry, event: React.MouseEvent) => void;
  /** Click handler for a zone wire (e.g. to remove it). Receives the wire id. */
  onZoneWireClick?: (wireId: string, event: React.MouseEvent) => void;
  /** When true, all agent-to-agent wires render as bidirectional regardless of binding direction. */
  forceBidirectional?: boolean;
}

/** Zone wires use a distinct accent so the "bundle to a zone" reads differently. */
const ZONE_WIRE_COLOR = 'rgb(var(--ctp-accent2, 203 166 247))';

/** A single zone wire — a bundled connection drawn to the zone itself. */
const ZoneWireGroup = React.memo(function ZoneWireGroup({
  wireId,
  path,
  onZoneWireClick,
}: {
  wireId: string;
  path: string;
  onZoneWireClick?: (wireId: string, event: React.MouseEvent) => void;
}) {
  return (
    <g data-testid={`zone-wire-group-${wireId}`} data-zone-wire="true">
      {/* Invisible thick hitbox for click interaction */}
      <path
        d={path}
        fill="none"
        stroke="transparent"
        strokeWidth={10}
        style={{ pointerEvents: onZoneWireClick ? 'stroke' : 'none', cursor: onZoneWireClick ? 'pointer' : 'default' }}
        onClick={(e) => onZoneWireClick?.(wireId, e)}
        data-testid={`zone-wire-hitbox-${wireId}`}
      />
      {/* Inner dashed stroke */}
      <path
        d={path}
        fill="none"
        strokeWidth={WIRE_WIDTH}
        strokeLinecap="round"
        strokeDasharray="2 5"
        markerEnd="url(#zone-wire-arrow)"
        style={{ stroke: ZONE_WIRE_COLOR, pointerEvents: 'none' }}
        data-testid={`zone-wire-path-${wireId}`}
      />
    </g>
  );
});

/** Per-wire group component — allows calling useWireActivity hook per wire. */
const WireGroup = React.memo(function WireGroup({
  wireKey,
  activityKey,
  path,
  binding,
  bidir,
  sleepingAgentIds,
  onWireClick,
}: {
  wireKey: string;
  /** The binding's activity key; differs from `wireKey` on a duplicate card's wire. */
  activityKey: string;
  path: string;
  binding: McpBindingEntry;
  bidir: boolean;
  sleepingAgentIds?: Set<string>;
  onWireClick?: (binding: McpBindingEntry, event: React.MouseEvent) => void;
}) {
  // Keep alive=true so activity indicators fire even for sleeping wires (e.g. wake requests)
  const activity = useWireActivity(activityKey, true);

  // Dim wires when source or target agent is sleeping/error
  const isDimmed = sleepingAgentIds
    ? sleepingAgentIds.has(binding.agentId) || sleepingAgentIds.has(binding.targetId)
    : false;

  const wireColor = bidir ? BIDIR_COLOR : UNI_COLOR;
  const fwdMarker = bidir ? 'url(#wire-arrow-fwd-bidir)' : 'url(#wire-arrow-fwd)';
  const revMarker = 'url(#wire-arrow-rev-bidir)';

  return (
    <g
      data-testid={`wire-group-${wireKey}`}
      data-bidir={bidir ? 'true' : undefined}
      data-activity={activity}
      data-dimmed={isDimmed ? 'true' : undefined}
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
        strokeWidth={WIRE_WIDTH}
        strokeLinecap="round"
        strokeDasharray={bidir ? undefined : '8 4'}
        markerEnd={fwdMarker}
        markerStart={bidir ? revMarker : undefined}
        style={{
          stroke: wireColor,
          pointerEvents: 'none',
          opacity: isDimmed ? 0.35 : 1,
          transition: 'opacity 0.5s ease',
        }}
        data-testid={`wire-path-${wireKey}`}
      />
      {/* Flowing light dots — driven by activity state */}
      <WireFlowDots wireKey={wireKey} activity={activity} bidir={bidir} targetKind={binding.targetKind} />
    </g>
  );
});

export const WireOverlay = React.memo(function WireOverlay({
  views,
  bindings,
  zoneWireDefinitions,
  viewPositions,
  sleepingAgentIds,
  onWireClick,
  onZoneWireClick,
  forceBidirectional,
}: WireOverlayProps) {
  // Shared with the wire rendering contract, so local and annex paths agree.
  const viewIndex = useMemo(() => buildViewIndex(views), [views]);

  // Zone wires render as a single bundled wire to the zone.
  const zoneWires = useMemo(() => {
    if (!zoneWireDefinitions || zoneWireDefinitions.length === 0) return [];
    const result: Array<{ id: string; path: string }> = [];
    for (const wire of zoneWireDefinitions) {
      const resolved = resolveZoneWireViews(wire, viewIndex);
      if (!resolved) continue;
      const { source, target } = resolved;
      const srcPos = viewPositions?.get(source.id) ?? source.position;
      const tgtPos = viewPositions?.get(target.id) ?? target.position;
      const { path } = computeWirePath(viewRect(srcPos, source.size), viewRect(tgtPos, target.size));
      result.push({ id: wire.id, path });
    }
    return result;
  }, [zoneWireDefinitions, viewIndex, viewPositions]);

  const wires = useMemo(() => {
    // Track already-rendered pairs so bidirectional bindings only emit one wire
    const rendered = new Set<string>();
    const result: Array<{
      key: string;
      activityKey: string;
      path: string;
      from: EdgeMidpoint;
      to: EdgeMidpoint;
      fromViewId: string;
      toViewId: string;
      binding: McpBindingEntry;
      bidir: boolean;
      routed: boolean;
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

      // One wire per card of the agent: a canvas saved with duplicate cards
      // shows the wire on each of them, not only the last (#2415).
      resolveBindingWireViews(binding, viewIndex).forEach((pair, i) => {
        const { source, target } = pair;
        const srcPos = viewPositions?.get(source.id) ?? source.position;
        const tgtPos = viewPositions?.get(target.id) ?? target.position;

        const srcRect = viewRect(srcPos, source.size);
        const tgtRect = viewRect(tgtPos, target.size);
        // Use ELK-routed path when available, otherwise compute direct bezier.
        // A routed path was laid out for one card, so other cards get a bezier.
        const { path, from, to } = binding.routedPath && i === 0
          ? { path: binding.routedPath, from: closestEdgeMidpoint(srcRect, tgtRect), to: closestEdgeMidpoint(tgtRect, srcRect) }
          : computeWirePath(srcRect, tgtRect);

        result.push({
          key: bindingWireKey(binding, pair, i),
          activityKey: bindingWireKey(binding, pair, 0),
          path,
          from,
          to,
          fromViewId: source.id,
          toViewId: target.id,
          binding,
          bidir,
          routed: !!binding.routedPath && i === 0,
        });
      });
    }

    return result;
  }, [bindings, viewIndex, viewPositions, forceBidirectional]);

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
    for (const { key, path, from, to, routed } of wires) {
      // When ELK has routed the path, use it directly — physics offsets
      // would replace the carefully-calculated route with a straight bezier.
      if (routed) {
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

  if (wires.length === 0 && zoneWires.length === 0) return null;

  return (
    <svg
      className="absolute top-0 left-0 pointer-events-none overflow-visible"
      style={{ width: 1, height: 1 }}
    >
      <defs>
        {/* Unidirectional arrowhead */}
        <marker id="wire-arrow-fwd" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="userSpaceOnUse">
          <path d="M 1 1 L 7 4 L 1 7" fill="none" style={{ stroke: UNI_COLOR }} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </marker>
        {/* Bidirectional arrowheads */}
        <marker id="wire-arrow-fwd-bidir" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="userSpaceOnUse">
          <path d="M 1 1 L 7 4 L 1 7" fill="none" style={{ stroke: BIDIR_COLOR }} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </marker>
        <marker id="wire-arrow-rev-bidir" markerWidth="8" markerHeight="8" refX="1" refY="4" orient="auto" markerUnits="userSpaceOnUse">
          <path d="M 7 1 L 1 4 L 7 7" fill="none" style={{ stroke: BIDIR_COLOR }} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </marker>
        {/* Zone wire arrowhead (mauve) */}
        <marker id="zone-wire-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="userSpaceOnUse">
          <path d="M 1 1 L 7 4 L 1 7" fill="none" style={{ stroke: ZONE_WIRE_COLOR }} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </marker>
        {/* Wire path definitions (referenced by flow dots via <mpath>) */}
        {wires.map(({ key }) => (
          <path key={`def-${key}`} id={`wire-path-${key}`} d={resolvedPaths.get(key)!} fill="none" />
        ))}
      </defs>
      {/* Zone wires drawn first so per-agent binding wires sit visually on top */}
      {zoneWires.map(({ id, path }) => (
        <ZoneWireGroup key={`zone-${id}`} wireId={id} path={path} onZoneWireClick={onZoneWireClick} />
      ))}
      {wires.map(({ key, activityKey, binding, bidir }) => (
        <WireGroup
          key={key}
          wireKey={key}
          activityKey={activityKey}
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
