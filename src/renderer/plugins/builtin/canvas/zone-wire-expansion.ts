/**
 * Zone wire expansion — computes the set of individual MCP bindings that
 * should exist based on zone wire definitions and current containment.
 *
 * Zone wires are "shorthand" for connecting all valid entities within a zone:
 * - Zone -> agent: all agents/browsers/group-projects in zone connect to that agent
 * - Zone -> group project: all agents in zone added to group project
 * - Zone -> zone: many:many mapping of all entities in both zones
 */

import type { CanvasView, AgentCanvasView, ZoneCanvasView } from './canvas-types';
import type { PluginCanvasView as PluginCanvasViewType } from './canvas-types';
import type { ZoneWireDefinition } from './zone-wire-store';

export interface ExpandedBinding {
  agentId: string;
  targetId: string;
  targetKind: 'agent' | 'browser' | 'group-project' | 'agent-queue';
  label: string;
  agentName: string;
  targetName: string;
}

/** Get all agent views from a list of views. */
function getAgents(views: CanvasView[]): AgentCanvasView[] {
  return views.filter((v): v is AgentCanvasView => v.type === 'agent' && !!v.agentId);
}

/** Get browser plugin views from a list of views. */
function getBrowsers(views: CanvasView[]): PluginCanvasViewType[] {
  return views.filter(
    (v): v is PluginCanvasViewType =>
      v.type === 'plugin' && (v as PluginCanvasViewType).pluginWidgetType === 'plugin:browser:webview',
  );
}

/** Get group-project plugin views from a list of views. */
function getGroupProjects(views: CanvasView[]): PluginCanvasViewType[] {
  return views.filter(
    (v): v is PluginCanvasViewType =>
      v.type === 'plugin' &&
      (v as PluginCanvasViewType).pluginWidgetType === 'plugin:group-project:group-project' &&
      !!v.metadata?.groupProjectId,
  );
}

/** Get agent-queue plugin views from a list of views. */
function getAgentQueues(views: CanvasView[]): PluginCanvasViewType[] {
  return views.filter(
    (v): v is PluginCanvasViewType =>
      v.type === 'plugin' &&
      (v as PluginCanvasViewType).pluginWidgetType === 'plugin:agent-queue:agent-queue' &&
      !!v.metadata?.queueId,
  );
}

/** Get views contained in a zone. */
function getContainedViews(zone: ZoneCanvasView, allViews: CanvasView[]): CanvasView[] {
  const ids = new Set(zone.containedViewIds);
  return allViews.filter((v) => ids.has(v.id));
}

/**
 * Expand zone wires into individual MCP bindings based on current containment.
 */
export function expandZoneWires(
  zoneWires: ZoneWireDefinition[],
  allViews: CanvasView[],
): ExpandedBinding[] {
  const bindings: ExpandedBinding[] = [];
  const seen = new Set<string>(); // dedup key: `${agentId}:${targetId}`

  function addBinding(b: ExpandedBinding): void {
    const key = `${b.agentId}:${b.targetId}`;
    if (seen.has(key)) return;
    seen.add(key);
    bindings.push(b);
  }

  for (const wire of zoneWires) {
    const sourceZone = allViews.find(
      (v): v is ZoneCanvasView => v.id === wire.sourceZoneId && v.type === 'zone',
    );
    if (!sourceZone) continue;

    const contained = getContainedViews(sourceZone, allViews);

    if (wire.targetType === 'agent') {
      // Zone -> agent: each agent in zone connects to target agent;
      // target agent connects to each browser/group-project in zone
      const targetAgent = allViews.find(
        (v): v is AgentCanvasView => v.type === 'agent' && v.agentId === wire.targetId,
      );
      if (!targetAgent || !targetAgent.agentId) continue;

      for (const agent of getAgents(contained)) {
        if (agent.agentId === targetAgent.agentId) continue;
        addBinding({
          agentId: agent.agentId!,
          targetId: targetAgent.agentId,
          targetKind: 'agent',
          label: targetAgent.displayName,
          agentName: agent.displayName,
          targetName: targetAgent.displayName,
        });
      }
      for (const browser of getBrowsers(contained)) {
        addBinding({
          agentId: targetAgent.agentId,
          targetId: browser.id,
          targetKind: 'browser',
          label: browser.displayName,
          agentName: targetAgent.displayName,
          targetName: browser.displayName,
        });
      }
      for (const gp of getGroupProjects(contained)) {
        addBinding({
          agentId: targetAgent.agentId,
          targetId: gp.metadata.groupProjectId as string,
          targetKind: 'group-project',
          label: gp.displayName,
          agentName: targetAgent.displayName,
          targetName: gp.displayName,
        });
      }
      for (const aq of getAgentQueues(contained)) {
        addBinding({
          agentId: targetAgent.agentId,
          targetId: aq.metadata.queueId as string,
          targetKind: 'agent-queue',
          label: aq.displayName,
          agentName: targetAgent.displayName,
          targetName: aq.displayName,
        });
      }
    } else if (wire.targetType === 'group-project') {
      // Zone -> group project: each agent in zone binds to group project
      for (const agent of getAgents(contained)) {
        addBinding({
          agentId: agent.agentId!,
          targetId: wire.targetId,
          targetKind: 'group-project',
          label: wire.targetId,
          agentName: agent.displayName,
          targetName: wire.targetId,
        });
      }
    } else if (wire.targetType === 'agent-queue') {
      // Zone -> agent queue: each agent in zone binds to agent queue
      for (const agent of getAgents(contained)) {
        addBinding({
          agentId: agent.agentId!,
          targetId: wire.targetId,
          targetKind: 'agent-queue',
          label: wire.targetId,
          agentName: agent.displayName,
          targetName: wire.targetId,
        });
      }
    } else if (wire.targetType === 'zone') {
      // Zone -> zone: cross-product of all valid entity pairs
      const targetZone = allViews.find(
        (v): v is ZoneCanvasView => v.id === wire.targetId && v.type === 'zone',
      );
      if (!targetZone) continue;

      const targetContained = getContainedViews(targetZone, allViews);
      const sourceAgents = getAgents(contained);
      const targetAgents = getAgents(targetContained);

      // Each source agent -> each target agent
      for (const sa of sourceAgents) {
        for (const ta of targetAgents) {
          if (sa.agentId === ta.agentId) continue;
          addBinding({
            agentId: sa.agentId!,
            targetId: ta.agentId!,
            targetKind: 'agent',
            label: ta.displayName,
            agentName: sa.displayName,
            targetName: ta.displayName,
          });
        }
        // Each source agent -> each target browser
        for (const tb of getBrowsers(targetContained)) {
          addBinding({
            agentId: sa.agentId!,
            targetId: tb.id,
            targetKind: 'browser',
            label: tb.displayName,
            agentName: sa.displayName,
            targetName: tb.displayName,
          });
        }
        // Each source agent -> each target group project
        for (const tgp of getGroupProjects(targetContained)) {
          addBinding({
            agentId: sa.agentId!,
            targetId: tgp.metadata.groupProjectId as string,
            targetKind: 'group-project',
            label: tgp.displayName,
            agentName: sa.displayName,
            targetName: tgp.displayName,
          });
        }
        // Each source agent -> each target agent queue
        for (const taq of getAgentQueues(targetContained)) {
          addBinding({
            agentId: sa.agentId!,
            targetId: taq.metadata.queueId as string,
            targetKind: 'agent-queue',
            label: taq.displayName,
            agentName: sa.displayName,
            targetName: taq.displayName,
          });
        }
      }

      // Reverse: each target agent -> each source browser/group-project
      for (const ta of targetAgents) {
        for (const sb of getBrowsers(contained)) {
          addBinding({
            agentId: ta.agentId!,
            targetId: sb.id,
            targetKind: 'browser',
            label: sb.displayName,
            agentName: ta.displayName,
            targetName: sb.displayName,
          });
        }
        for (const sgp of getGroupProjects(contained)) {
          addBinding({
            agentId: ta.agentId!,
            targetId: sgp.metadata.groupProjectId as string,
            targetKind: 'group-project',
            label: sgp.displayName,
            agentName: ta.displayName,
            targetName: sgp.displayName,
          });
        }
        for (const saq of getAgentQueues(contained)) {
          addBinding({
            agentId: ta.agentId!,
            targetId: saq.metadata.queueId as string,
            targetKind: 'agent-queue',
            label: saq.displayName,
            agentName: ta.displayName,
            targetName: saq.displayName,
          });
        }
      }
    } else if (wire.targetType === 'browser') {
      // Zone -> browser: each agent in zone connects to browser
      for (const agent of getAgents(contained)) {
        addBinding({
          agentId: agent.agentId!,
          targetId: wire.targetId,
          targetKind: 'browser',
          label: wire.targetId,
          agentName: agent.displayName,
          targetName: wire.targetId,
        });
      }
    }
  }

  return bindings;
}

/**
 * Reconcile expanded zone bindings with current MCP bindings.
 * Returns lists of bindings to add and remove.
 */
export function reconcileZoneBindings(
  desired: ExpandedBinding[],
  current: Array<{ agentId: string; targetId: string }>,
): {
  toAdd: ExpandedBinding[];
  toRemove: Array<{ agentId: string; targetId: string }>;
} {
  const desiredSet = new Set(desired.map((b) => `${b.agentId}:${b.targetId}`));
  const currentSet = new Set(current.map((b) => `${b.agentId}:${b.targetId}`));

  const toAdd = desired.filter((b) => !currentSet.has(`${b.agentId}:${b.targetId}`));
  const toRemove = current.filter((b) => !desiredSet.has(`${b.agentId}:${b.targetId}`));

  return { toAdd, toRemove };
}
