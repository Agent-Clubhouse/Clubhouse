// ── Blueprint wire plan ──────────────────────────────────────────────
//
// The one rule for turning a blueprint's wires into canvas wire definitions
// (#2055). Every import path (gallery card, "Open from file…", canvas drop,
// canvas paste) and deferred resolution after a stub is bound go through
// planBlueprintWires, so the same manifest always yields the same wires.
//
// The contract matches what wiring by hand on the canvas produces
// (useWiring.ts):
//
// - Target identity: an agent target is the target view's agent id, a group
//   project is the widget's `metadata.groupProjectId`, a browser
//   (`plugin:browser:webview`) is its view id. Nothing else can be a wire
//   target (terminals, notes, anchors, zones, other widgets), so wires to them
//   are skipped and reported, never imported as browser wires.
// - Deferred binding: a wire whose source agent view has no agent yet, or
//   whose target agent view or group-project widget isn't bound yet, is
//   deferred, not created. Deferred wires keep their view ids so they can be
//   resolved once the stub is bound.
// - Metadata: per-wire `instructions` and `disabledTools` are copied onto
//   every definition the wire produces.
// - Bidirectionality: a bidirectional agent-to-agent wire also creates the
//   reverse definition (as dragging with "both ways" does). It means nothing
//   for widget targets.
// - Duplicates (an explicit reverse wire next to a bidirectional one) are
//   created once; a wire from a card (or agent) to itself is skipped.

import type { BlueprintWire } from '../../../shared/blueprint-types';
import type { AgentCanvasView, CanvasView, DeferredCanvasWire, PluginCanvasView } from '../../plugins/builtin/canvas/canvas-types';
import type { McpBindingEntry } from '../../stores/mcpBindingStore';

export const BROWSER_WIDGET_TYPE = 'plugin:browser:webview';
export const GROUP_PROJECT_WIDGET_TYPE = 'plugin:group-project:group-project';

/** Why a wire is waiting: one of its ends has no agent (or group project) yet. */
export type DeferredWireReason = 'source_unbound' | 'target_unbound';
/** Why a wire can never be created on this canvas. */
export type SkippedWireReason = 'missing_view' | 'source_not_agent' | 'unsupported_target' | 'self';

export interface DeferredBlueprintWire {
  wire: BlueprintWire;
  sourceViewId: string;
  targetViewId: string;
  reason: DeferredWireReason;
}

export interface SkippedBlueprintWire {
  wire: BlueprintWire;
  reason: SkippedWireReason;
}

export interface BlueprintWirePlan {
  /** Wire definitions to add to the canvas store now. */
  create: McpBindingEntry[];
  /** Wires to create once their stub is bound. */
  deferred: DeferredBlueprintWire[];
  /** Wires this canvas can't represent. */
  skipped: SkippedBlueprintWire[];
}

export const EMPTY_WIRE_PLAN: BlueprintWirePlan = Object.freeze({ create: [], deferred: [], skipped: [] }) as BlueprintWirePlan;

type TargetIdentity =
  | { kind: 'agent' | 'browser' | 'group-project'; id: string }
  | { unbound: true };

/** How a view is addressed as a wire target, or null when it can't be one. */
function targetIdentity(view: CanvasView): TargetIdentity | null {
  if (view.type === 'agent') {
    const agentId = (view as AgentCanvasView).agentId;
    return agentId ? { kind: 'agent', id: agentId } : { unbound: true };
  }
  if (view.type === 'plugin') {
    const widget = (view as PluginCanvasView).pluginWidgetType;
    if (widget === GROUP_PROJECT_WIDGET_TYPE) {
      const groupProjectId = view.metadata?.groupProjectId;
      return typeof groupProjectId === 'string' && groupProjectId ? { kind: 'group-project', id: groupProjectId } : { unbound: true };
    }
    if (widget === BROWSER_WIDGET_TYPE) return { kind: 'browser', id: view.id };
  }
  return null;
}

function wireMetadata(wire: BlueprintWire): Pick<McpBindingEntry, 'instructions' | 'disabledTools'> {
  return {
    ...(wire.instructions && Object.keys(wire.instructions).length ? { instructions: { ...wire.instructions } } : {}),
    ...(wire.disabledTools?.length ? { disabledTools: [...wire.disabledTools] } : {}),
  };
}

function projectName(...views: CanvasView[]): string | undefined {
  for (const v of views) {
    const name = v.metadata?.projectName;
    if (typeof name === 'string' && name) return name;
  }
  return undefined;
}

/**
 * Plan the wire definitions for an imported canvas. `refIdToViewId` maps the
 * blueprint's view refIds to the canvas views created for them.
 */
export function planBlueprintWires(
  wires: BlueprintWire[],
  refIdToViewId: Map<string, string>,
  views: CanvasView[],
): BlueprintWirePlan {
  const plan: BlueprintWirePlan = { create: [], deferred: [], skipped: [] };
  if (wires.length === 0) return plan;
  const viewById = new Map(views.map((v) => [v.id, v]));
  const created = new Set<string>();
  const create = (entry: McpBindingEntry) => {
    const key = `${entry.agentId}\0${entry.targetKind}\0${entry.targetId}`;
    if (created.has(key)) return;
    created.add(key);
    plan.create.push(entry);
  };

  for (const wire of wires) {
    const sourceViewId = refIdToViewId.get(wire.sourceRef);
    const targetViewId = refIdToViewId.get(wire.targetRef);
    const source = sourceViewId ? viewById.get(sourceViewId) : undefined;
    const target = targetViewId ? viewById.get(targetViewId) : undefined;
    if (!source || !target || !sourceViewId || !targetViewId) { plan.skipped.push({ wire, reason: 'missing_view' }); continue; }
    if (sourceViewId === targetViewId) { plan.skipped.push({ wire, reason: 'self' }); continue; }
    if (source.type !== 'agent') { plan.skipped.push({ wire, reason: 'source_not_agent' }); continue; }
    const identity = targetIdentity(target);
    if (!identity) { plan.skipped.push({ wire, reason: 'unsupported_target' }); continue; }
    const sourceAgentId = (source as AgentCanvasView).agentId;
    if (!sourceAgentId) { plan.deferred.push({ wire, sourceViewId, targetViewId, reason: 'source_unbound' }); continue; }
    if ('unbound' in identity) { plan.deferred.push({ wire, sourceViewId, targetViewId, reason: 'target_unbound' }); continue; }
    // Two cards bound to the same agent: an agent can't be wired to itself.
    if (identity.kind === 'agent' && identity.id === sourceAgentId) { plan.skipped.push({ wire, reason: 'self' }); continue; }

    const metadata = wireMetadata(wire);
    const project = projectName(target, source);
    create({
      agentId: sourceAgentId,
      targetId: identity.id,
      targetKind: identity.kind,
      label: target.displayName,
      agentName: source.displayName,
      targetName: target.displayName,
      ...(project ? { projectName: project } : {}),
      ...metadata,
    });
    if (wire.bidirectional && identity.kind === 'agent') {
      create({
        agentId: identity.id,
        targetId: sourceAgentId,
        targetKind: 'agent',
        label: source.displayName,
        agentName: target.displayName,
        targetName: source.displayName,
        ...(project ? { projectName: project } : {}),
        ...wireMetadata(wire),
      });
    }
  }
  return plan;
}

/**
 * Resolve wires deferred at import against the canvas's current views
 * (#2069): those whose ends are now bound become wire definitions, those
 * still waiting stay deferred, and those that can no longer be created (a view
 * was removed, or a target changed into something that can't be wired) are
 * dropped. Each entry gets its own refs, so entries from different imports
 * can't collide.
 */
export function resolveDeferredWires(
  deferred: DeferredCanvasWire[],
  views: CanvasView[],
): { create: McpBindingEntry[]; deferred: DeferredCanvasWire[] } {
  const refIdToViewId = new Map<string, string>();
  const wires = deferred.map((d, i) => {
    refIdToViewId.set(`s${i}`, d.sourceViewId);
    refIdToViewId.set(`t${i}`, d.targetViewId);
    return { ...d.wire, sourceRef: `s${i}`, targetRef: `t${i}` };
  });
  const plan = planBlueprintWires(wires, refIdToViewId, views);
  return {
    create: plan.create,
    deferred: plan.deferred.map((d) => deferred[Number(d.wire.sourceRef.slice(1))]),
  };
}

/** Deferred wires with every entry touching one of `viewIds` removed. */
export function pruneDeferredWires(deferred: DeferredCanvasWire[] | undefined, viewIds: Iterable<string>): DeferredCanvasWire[] | undefined {
  if (!deferred?.length) return deferred;
  const removed = new Set(viewIds);
  const kept = deferred.filter((d) => !removed.has(d.sourceViewId) && !removed.has(d.targetViewId));
  return kept.length ? kept : undefined;
}
