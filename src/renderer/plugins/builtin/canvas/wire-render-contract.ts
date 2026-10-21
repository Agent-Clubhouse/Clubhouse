/**
 * Wire rendering contract — the single source of truth for which wires are
 * drawn on the canvas.
 *
 * ## The contract
 *
 * The set of rendered wires is a **pure function** of three synced inputs:
 *   1. `views`               — the canvas views (agents, zones, plugin widgets…)
 *   2. `wireDefinitions`     — persisted agent→target MCP-binding wires
 *   3. `zoneWireDefinitions` — persisted zone-level wires
 *
 * Nothing else influences what is rendered. In particular, the *transient*
 * runtime MCP binding store (`mcpBindingStore`) is NOT consulted for rendering.
 * Runtime bindings come and go as agents sleep/wake and as the main process
 * reconciles them; relying on them for rendering is exactly why wires
 * "disappeared over the annex protocol while the tools still worked" — the
 * controller/satellite never receives the runtime bindings, only the synced
 * definitions.
 *
 * Because both the local window and the annex controller call this same
 * function over the same snapshot (`wireDefinitions` + `zoneWireDefinitions`
 * are both serialised in `CanvasStateSnapshot`), a wire that exists logically
 * renders identically everywhere.
 *
 * ## Endpoint resolution (stable, in priority order)
 *
 * Binding wire (`kind: 'binding'`):
 *   - source: agent view by `agentId`
 *   - target: view by `id` → agent view by `agentId` → plugin view by
 *     `metadata.groupProjectId`
 *   An agent with more than one card gets a wire from each card (#2415).
 *
 * Zone wire (`kind: 'zone'`): rendered as a **single** wire to the zone itself
 * (not one wire per contained agent). Under the hood the zone wire expands to
 * per-agent bindings (see `zone-wire-expansion.ts`), but visually it is one
 * wire that auto-tracks the zone as members are added/removed.
 *   - source: zone view by `sourceZoneId`
 *   - target by `targetType`:
 *       'zone'          → zone view by `targetId`
 *       'agent'         → agent view by `agentId` (== targetId)
 *       'group-project' → plugin view by `metadata.groupProjectId`
 *       'browser'       → view by `id`
 *
 * Any wire whose source or target cannot be resolved is silently dropped (it is
 * not an error — the referenced view may simply not exist on this canvas yet).
 *
 * Every rendered wire carries a stable, unique `key` so React reconciliation
 * and activity tracking are deterministic.
 */

import type { CanvasView, AgentCanvasView, ZoneCanvasView, PluginCanvasView } from './canvas-types';
import type { McpBindingEntry } from '../../../stores/mcpBindingStore';
import type { ZoneWireDefinition } from './zone-wire-store';

/** A wire resolved to concrete source/target views, ready to render. */
export interface RenderedWire {
  /** Stable unique key for React + activity tracking. */
  key: string;
  kind: 'binding' | 'zone';
  source: CanvasView;
  target: CanvasView;
  /** Present when `kind === 'binding'`. */
  binding?: McpBindingEntry;
  /** Present when `kind === 'zone'`. */
  zoneWire?: ZoneWireDefinition;
}

/** O(1) lookup indexes over the view list. */
export interface ViewIndex {
  byId: Map<string, CanvasView>;
  /**
   * Every card of each agent, in view order. One agent can have more than one
   * card on a canvas (saved before duplicates were prevented, #2415), and a
   * binding draws a wire to each of them.
   */
  byAgentId: Map<string, CanvasView[]>;
  byGroupProjectId: Map<string, CanvasView>;
}

export function buildViewIndex(views: CanvasView[]): ViewIndex {
  const byId = new Map<string, CanvasView>();
  const byAgentId = new Map<string, CanvasView[]>();
  const byGroupProjectId = new Map<string, CanvasView>();
  for (const v of views) {
    byId.set(v.id, v);
    if (v.type === 'agent' && (v as AgentCanvasView).agentId) {
      const agentId = (v as AgentCanvasView).agentId as string;
      const cards = byAgentId.get(agentId);
      if (cards) cards.push(v);
      else byAgentId.set(agentId, [v]);
    }
    if (v.type === 'plugin') {
      const gpId = v.metadata?.groupProjectId;
      if (gpId) byGroupProjectId.set(gpId as string, v);
    }
  }
  return { byId, byAgentId, byGroupProjectId };
}

/**
 * Resolve a binding wire to every source/target view pair it connects: one
 * pair per card of the source agent (and per card of the target agent, for
 * agent→agent bindings). Empty when either end is not on the canvas.
 */
export function resolveBindingWireViews(
  binding: McpBindingEntry,
  index: ViewIndex,
): Array<{ source: CanvasView; target: CanvasView }> {
  const sources = index.byAgentId.get(binding.agentId);
  if (!sources) return [];

  let targets: CanvasView[] | undefined;
  const byId = index.byId.get(binding.targetId);
  if (byId) targets = [byId];
  if (!targets && binding.targetKind === 'agent') {
    targets = index.byAgentId.get(binding.targetId);
  }
  if (!targets && binding.targetKind === 'group-project') {
    const gp = index.byGroupProjectId.get(binding.targetId);
    if (gp) targets = [gp];
  }
  if (!targets) return [];

  const pairs: Array<{ source: CanvasView; target: CanvasView }> = [];
  for (const source of sources) {
    for (const target of targets) pairs.push({ source, target });
  }
  return pairs;
}

/**
 * Key for one drawn wire of a binding. The first pair keeps the plain
 * `${agentId}--${targetId}` key that activity tracking uses; any further pair
 * (a duplicate card) adds its view ids so every key stays unique.
 */
export function bindingWireKey(binding: McpBindingEntry, pair: { source: CanvasView; target: CanvasView }, pairIndex: number): string {
  const base = `${binding.agentId}--${binding.targetId}`;
  return pairIndex === 0 ? base : `${base}@${pair.source.id}--${pair.target.id}`;
}

/** Resolve a zone wire's source zone + target views, or null if unresolvable. */
export function resolveZoneWireViews(
  wire: ZoneWireDefinition,
  index: ViewIndex,
): { source: ZoneCanvasView; target: CanvasView } | null {
  const source = index.byId.get(wire.sourceZoneId);
  if (!source || source.type !== 'zone') return null;

  let target: CanvasView | undefined;
  switch (wire.targetType) {
    case 'zone':
    case 'browser':
      target = index.byId.get(wire.targetId);
      break;
    case 'agent':
      target = index.byAgentId.get(wire.targetId)?.[0] ?? index.byId.get(wire.targetId);
      break;
    case 'group-project':
      target = index.byGroupProjectId.get(wire.targetId) ?? index.byId.get(wire.targetId);
      break;
  }
  if (!target) return null;

  return { source: source as ZoneCanvasView, target };
}

/**
 * THE rendering contract: resolve every renderable wire from synced state.
 *
 * Returns binding wires first, then zone wires, each in input order, so output
 * ordering is deterministic.
 */
export function resolveRenderedWires(
  views: CanvasView[],
  wireDefinitions: McpBindingEntry[],
  zoneWireDefinitions: ZoneWireDefinition[] = [],
): RenderedWire[] {
  const index = buildViewIndex(views);
  const out: RenderedWire[] = [];

  for (const binding of wireDefinitions) {
    resolveBindingWireViews(binding, index).forEach((pair, i) => {
      out.push({
        key: `binding:${bindingWireKey(binding, pair, i)}`,
        kind: 'binding',
        source: pair.source,
        target: pair.target,
        binding,
      });
    });
  }

  for (const wire of zoneWireDefinitions) {
    const resolved = resolveZoneWireViews(wire, index);
    if (!resolved) continue;
    out.push({
      key: `zone:${wire.id}`,
      kind: 'zone',
      source: resolved.source,
      target: resolved.target,
      zoneWire: wire,
    });
  }

  return out;
}

// Re-export so callers (and the plugin's PluginCanvasView typing) stay co-located.
export type { PluginCanvasView };
