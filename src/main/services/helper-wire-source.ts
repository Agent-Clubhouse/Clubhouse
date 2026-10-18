/**
 * Orchestrator ↔ helper wires as a startup binding source (#2225).
 *
 * A helper is a durable agent whose `parentAgentId` names another agent in the
 * same project (#2224). The agent config is the source of truth for the wire,
 * so nothing else is persisted: at startup, and whenever a project's agents
 * change, the wires are derived from every registered project's agents and
 * applied through {@link rebuildPersistedBindings}, alongside the canvas wires.
 *
 * Each live parent/helper pair gets an agent-to-agent wire in both
 * directions, shaped like a bidirectional canvas wire, so a canvas showing the
 * same pair binds nothing twice. The source prunes: once a helper is disposed,
 * deleted or reparented, the wires it created go, unless a canvas still has
 * them or the user drew them.
 */

import * as projectStore from './project-store';
import { listDurable, onAgentConfigChanged } from './agent-config';
import type { PersistedBinding, PersistedBindingSource } from './persisted-bindings';
import { isDisposedAgent } from '../../shared/agent-helpers';
import type { DurableAgentConfig } from '../../shared/types';
import { appLog } from './log-service';

export const HELPER_WIRE_SOURCE_ID = 'helper-wires';

/** Both directions of every live parent ↔ helper pair in one project. */
export function bindingsFromHelperAgents(
  agents: readonly DurableAgentConfig[],
  projectName?: string,
): PersistedBinding[] {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const out: PersistedBinding[] = [];
  for (const helper of agents) {
    const parent = helper.parentAgentId ? byId.get(helper.parentAgentId) : undefined;
    if (!parent || parent.id === helper.id) continue;
    // A disposed helper keeps its link for history, but has no wire.
    if (isDisposedAgent(helper) || isDisposedAgent(parent)) continue;
    const project = projectName ? { projectName } : {};
    out.push(
      { agentId: parent.id, targetId: helper.id, targetKind: 'agent', label: helper.name, agentName: parent.name, targetName: helper.name, ...project },
      { agentId: helper.id, targetId: parent.id, targetKind: 'agent', label: parent.name, agentName: helper.name, targetName: parent.name, ...project },
    );
  }
  return out;
}

/** Stable description of a project's helper wires, to tell a relevant change from any other write. */
function wireSignature(agents: readonly DurableAgentConfig[]): string {
  return bindingsFromHelperAgents(agents)
    .map((b) => `${b.agentId}>${b.targetId}`)
    .sort()
    .join(',');
}

/** projectPath → signature of the wires last collected or seen for it. */
const signatures = new Map<string, string>();

export const helperWireBindingSource: PersistedBindingSource = {
  id: HELPER_WIRE_SOURCE_ID,
  prune: true,
  async collect() {
    const projects = await projectStore.list();
    const out: PersistedBinding[] = [];
    for (const project of projects) {
      let agents: DurableAgentConfig[];
      try {
        agents = await listDurable(project.path);
      } catch (err) {
        // telemetry-exempt: logged; failing the collect keeps every helper wire until the next run
        appLog('core:mcp', 'warn', 'Could not read agents for helper wires', {
          meta: { projectPath: project.path, error: err instanceof Error ? err.message : String(err) },
        });
        throw err;
      }
      signatures.set(project.path, wireSignature(agents));
      out.push(...bindingsFromHelperAgents(agents, project.displayName || project.name));
    }
    return out;
  },
};

/**
 * Call `onWiresChanged` when a project's helper wires change (a helper is
 * created, disposed, deleted or reparented). Writes that leave the wires as
 * they were are ignored. Returns an unsubscribe function.
 */
export function watchHelperWires(onWiresChanged: () => void): () => void {
  let pending: ReturnType<typeof setTimeout> | null = null;
  const dirtyProjects = new Set<string>();

  const check = async (): Promise<void> => {
    pending = null;
    const paths = [...dirtyProjects];
    dirtyProjects.clear();
    let changed = false;
    for (const projectPath of paths) {
      try {
        const signature = wireSignature(await listDurable(projectPath));
        if (signature !== (signatures.get(projectPath) ?? '')) {
          signatures.set(projectPath, signature);
          changed = true;
        }
      } catch (err) {
        // telemetry-exempt: logged; the next change or rebuild retries
        appLog('core:mcp', 'warn', 'Could not read agents after a config change', {
          meta: { projectPath, error: err instanceof Error ? err.message : String(err) },
        });
      }
    }
    if (changed) onWiresChanged();
  };

  const unsubscribe = onAgentConfigChanged((projectPath) => {
    dirtyProjects.add(projectPath);
    // Coalesce a burst of writes (and the watcher echo of our own flush), and
    // stay out of the writer's call stack.
    if (!pending) pending = setTimeout(() => { void check(); }, 50);
  });
  return () => {
    unsubscribe();
    if (pending) clearTimeout(pending);
    pending = null;
  };
}

/** For testing: forget the signatures seen so far. */
export function _resetHelperWireSourceForTesting(): void {
  signatures.clear();
}
