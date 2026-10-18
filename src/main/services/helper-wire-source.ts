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
 * deleted or reparented, the wires it created go, unless a canvas or zone
 * still has them or the user drew them. A project whose agents can't be read
 * keeps its wires as they are for that run.
 */

import * as projectStore from './project-store';
import { listDurable, onAgentConfigChanged } from './agent-config';
import type { CollectedBindings, PersistedBinding, PersistedBindingSource } from './persisted-bindings';
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

/**
 * projectPath → signature of the wires the bindings are known to reflect,
 * committed only after a rebuild in which every source collected.
 */
const committed = new Map<string, string>();
/** Signatures read by the current rebuild's collect, committed by afterRebuild. */
const collected = new Map<string, string>();
/** projectPath → pairs from the last successful read, kept unverified when a read fails. */
const lastPairs = new Map<string, Array<{ agentId: string; targetId: string }>>();
/** Never equal to a real signature: forces the next change check to rebuild. */
const STALE = '\u0000stale';

export const helperWireBindingSource: PersistedBindingSource = {
  id: HELPER_WIRE_SOURCE_ID,
  prune: true,
  async collect(): Promise<CollectedBindings> {
    const projects = await projectStore.list();
    const bindings: PersistedBinding[] = [];
    const unverified: Array<{ agentId: string; targetId: string }> = [];
    for (const project of projects) {
      let agents: DurableAgentConfig[];
      try {
        agents = await listDurable(project.path);
      } catch (err) {
        // telemetry-exempt: logged; the project's wires are kept unverified until a read succeeds
        appLog('core:mcp', 'warn', 'Could not read agents for helper wires; keeping that project\'s wires as they are', {
          meta: { projectPath: project.path, error: err instanceof Error ? err.message : String(err) },
        });
        unverified.push(...(lastPairs.get(project.path) ?? []));
        continue;
      }
      const projectBindings = bindingsFromHelperAgents(agents, project.displayName || project.name);
      collected.set(project.path, wireSignature(agents));
      lastPairs.set(project.path, projectBindings.map((b) => ({ agentId: b.agentId, targetId: b.targetId })));
      bindings.push(...projectBindings);
    }
    return { bindings, unverified };
  },
  afterRebuild(complete) {
    // An incomplete run skipped pruning, so the bindings may still hold wires
    // these signatures no longer list: mark them stale so the next check rebuilds.
    for (const [projectPath, signature] of collected) committed.set(projectPath, complete ? signature : STALE);
    collected.clear();
  },
};

/** Retry delays after a rebuild that did not bring a project's wires up to date. */
const RETRY_DELAYS_MS = [1_000, 5_000, 15_000, 60_000];

/**
 * Call `onWiresChanged` when a project's helper wires change (a helper is
 * created, disposed, deleted or reparented). Writes that leave the wires as
 * they were are ignored. A change counts as handled only once a rebuild
 * commits it; until then the check is retried a few times, and the next
 * config write retries it again. Returns an unsubscribe function.
 */
export function watchHelperWires(onWiresChanged: () => unknown): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let attempt = 0;
  const dirtyProjects = new Set<string>();

  /** Returns false when nothing was scheduled (stopped, or a check is already pending). */
  const schedule = (delayMs: number): boolean => {
    if (stopped || timer) return false;
    timer = setTimeout(() => { timer = null; void check(); }, delayMs);
    return true;
  };

  const check = async (): Promise<void> => {
    const paths = [...dirtyProjects];
    dirtyProjects.clear();
    const wanted = new Map<string, string>();
    for (const projectPath of paths) {
      try {
        const signature = wireSignature(await listDurable(projectPath));
        if (signature !== (committed.get(projectPath) ?? '')) wanted.set(projectPath, signature);
      } catch (err) {
        // telemetry-exempt: logged; the next change or rebuild retries
        appLog('core:mcp', 'warn', 'Could not read agents after a config change', {
          meta: { projectPath, error: err instanceof Error ? err.message : String(err) },
        });
      }
    }
    if (wanted.size === 0) {
      attempt = 0;
      return;
    }
    try {
      await onWiresChanged();
    } catch (err) {
      // telemetry-exempt: logged; retried below
      appLog('core:mcp', 'warn', 'Helper wire rebuild failed', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      });
    }
    const missed = [...wanted].filter(([projectPath, signature]) => committed.get(projectPath) !== signature);
    if (missed.length === 0 || stopped) {
      attempt = 0;
      return;
    }
    if (attempt >= RETRY_DELAYS_MS.length) {
      appLog('core:mcp', 'warn', 'Helper wires still out of date after retries; the next agent change retries', {
        meta: { projects: missed.map(([projectPath]) => projectPath) },
      });
      attempt = 0;
      return;
    }
    for (const [projectPath] of missed) dirtyProjects.add(projectPath);
    // A check already pending covers these projects; only a scheduled retry uses up an attempt.
    if (schedule(RETRY_DELAYS_MS[attempt])) attempt++;
  };

  const unsubscribe = onAgentConfigChanged((projectPath) => {
    dirtyProjects.add(projectPath);
    attempt = 0;
    // A new write supersedes a pending retry. Coalesce a burst of writes (and
    // the watcher echo of our own flush), and stay out of the writer's call stack.
    if (timer) clearTimeout(timer);
    timer = null;
    schedule(50);
  });
  return () => {
    stopped = true;
    unsubscribe();
    if (timer) clearTimeout(timer);
    timer = null;
  };
}

/** For testing: forget the signatures seen so far. */
export function _resetHelperWireSourceForTesting(): void {
  committed.clear();
  collected.clear();
  lastPairs.clear();
}
