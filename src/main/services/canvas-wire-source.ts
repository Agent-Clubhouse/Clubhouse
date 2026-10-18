/**
 * The canvas plugin's persisted wires as a startup binding source (#1544).
 *
 * Reads canvas-wires.json and canvas-instances.json from the app-wide store
 * and every registered project's store, drops wires whose endpoints are gone
 * (the canvas plugin's own reconcile rules, shared/canvas-persistence.ts) and
 * group-project wires whose project no longer exists on this machine, and
 * returns the rest for {@link rebuildPersistedBindings}.
 */

import { readAllCanvasStores, type CanvasStoreSnapshot } from './canvas-store-reader';
import { groupProjectRegistry } from './group-project-registry';
import type { PersistedBinding, PersistedBindingSource } from './persisted-bindings';
import type { BindingTargetKind } from './clubhouse-mcp/types';
import { reconcilePersistedWires } from '../../shared/canvas-persistence';
import { appLog } from './log-service';

/** Wire kinds the canvas creates (plugin bindings are not canvas wires). */
const CANVAS_WIRE_KINDS: ReadonlySet<string> = new Set<BindingTargetKind>(['agent', 'browser', 'group-project', 'terminal']);

function storeLabel(snapshot: CanvasStoreSnapshot): string {
  return snapshot.location.scope === 'app' ? 'app' : `project:${snapshot.location.projectId}`;
}

/**
 * Bindings to restore from already-read stores. `groupProjects` maps each
 * group project on this machine to its current name; null when the registry
 * could not be read (group-project wires are then kept, as the renderer does).
 */
export function bindingsFromCanvasStores(
  snapshots: readonly CanvasStoreSnapshot[],
  groupProjects: ReadonlyMap<string, string> | null,
): PersistedBinding[] {
  const out: PersistedBinding[] = [];
  const seen = new Set<string>();
  for (const snapshot of snapshots) {
    if (snapshot.problems.length > 0) {
      appLog('core:mcp', 'warn', 'Canvas store skipped for startup bindings; the canvas restores it when opened', {
        meta: { store: storeLabel(snapshot), problems: snapshot.problems },
      });
    }
    // Without the views there is nothing to reconcile against, and binding
    // possibly stale wires blindly is worse than waiting for the canvas.
    if (!snapshot.canvases || !snapshot.wires || snapshot.wires.length === 0) continue;
    const views = snapshot.canvases.flatMap((c) => c.views);
    for (const wire of reconcilePersistedWires(snapshot.wires, views)) {
      if (!CANVAS_WIRE_KINDS.has(wire.targetKind)) continue;
      let projectName = wire.projectName;
      if (wire.targetKind === 'group-project' && groupProjects) {
        const current = groupProjects.get(wire.targetId);
        if (current === undefined) continue; // project deleted on this machine
        if (current) projectName = current;
      }
      const key = `${wire.agentId}\u0000${wire.targetId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        agentId: wire.agentId,
        targetId: wire.targetId,
        targetKind: wire.targetKind as BindingTargetKind,
        label: wire.label,
        agentName: wire.agentName,
        targetName: wire.targetName,
        projectName,
        ...(wire.instructions && typeof wire.instructions === 'object' ? { instructions: wire.instructions } : {}),
        ...(Array.isArray(wire.disabledTools) ? { disabledTools: wire.disabledTools } : {}),
      });
    }
  }
  return out;
}

async function readGroupProjectNames(): Promise<Map<string, string> | null> {
  try {
    const projects = await groupProjectRegistry.list();
    return new Map(projects.map((p) => [p.id, p.name ?? '']));
  } catch {
    // telemetry-exempt: null keeps group-project wires, as the renderer does
    return null;
  }
}

export const canvasWireBindingSource: PersistedBindingSource = {
  id: 'canvas-wires',
  async collect() {
    const [snapshots, groupProjects] = await Promise.all([readAllCanvasStores(), readGroupProjectNames()]);
    return bindingsFromCanvasStores(snapshots, groupProjects);
  },
};
