/**
 * Dispatcher ↔ agent wires as a startup binding source (#2537, epic #2533).
 *
 * The orchestration policy is the source of truth: every agent whose resolved
 * policy has `connectToDispatcher` on gets a two-way agent-to-agent wire with
 * the Dispatcher. Unset, that follows `orchestrate` (#2578), so an orchestrate
 * change can move a wire too. The policy lives in agents.json
 * (and the persona), so nothing new is persisted and the wires come back on
 * restart. There are no wires while the Dispatcher is off.
 *
 * The wires carry only what one side sends with `send_message`, plus what
 * the Dispatcher pulls with `get_status`/`read_output`. Nothing is forwarded
 * to the Dispatcher automatically.
 *
 * Modelled on helper-wire-source. orchestrator-connections isn't reused: its
 * scope pruning drops agents that aren't in a project, and the Dispatcher is
 * in none. The source prunes: once an agent's resolved switch goes off, or
 * the Dispatcher is turned off, the wires it created go. A project whose agents can't be read keeps its wires as they are for
 * that run.
 *
 * The switch resolves off where Clubhouse MCP is off for the agent (#2589), so
 * an MCP change moves wires too. The Dispatcher turning MCP on for itself
 * (mcpOverride, isMcpEnabledForAny) gives no other agent MCP, so it gives none
 * of them a wire.
 */

import * as projectStore from './project-store';
import { listDurable, onAgentConfigChanged } from './agent-config';
import { resolveOrchestrationPolicies } from './orchestration-policy';
import { onMcpEnablementChanged } from './mcp-settings';
import { onPersonaChanged } from './persona-change-hook';
import {
  DISPATCHER_NAME,
  getDispatcherAgentId,
  isDispatcherEnabled,
  isDispatcherPath,
  onDispatcherChanged,
} from './dispatcher/dispatcher-service';
import { bindingSignature, type CollectedBindings, type PersistedBinding, type PersistedBindingSource } from './persisted-bindings';
import { isDisposedAgent } from '../../shared/agent-helpers';
import type { DurableAgentConfig } from '../../shared/types';
import { appLog } from './log-service';

export const DISPATCHER_WIRE_SOURCE_ID = 'dispatcher-wires';

type Pair = { agentId: string; targetId: string };

/**
 * Both directions of one Dispatcher ↔ agent pair. The Dispatcher end is named
 * "Dispatcher" and both carry the agent's project, so the Dispatcher's tool
 * names read `<project>_<agent>` and a message from the agent shows which
 * project it came from. The Dispatcher's own messages are labelled just
 * "Dispatcher" (agent-tools' buildSenderLabel).
 */
function pairBindings(dispatcherId: string, agent: DurableAgentConfig, projectName?: string): PersistedBinding[] {
  const project = projectName ? { projectName } : {};
  return [
    {
      agentId: dispatcherId, targetId: agent.id, targetKind: 'agent',
      label: agent.name, agentName: DISPATCHER_NAME, targetName: agent.name, ...project,
    },
    {
      agentId: agent.id, targetId: dispatcherId, targetKind: 'agent',
      label: DISPATCHER_NAME, agentName: agent.name, targetName: DISPATCHER_NAME, ...project,
    },
  ];
}

/** The Dispatcher wires of one project's agents, from their resolved policies. */
export async function dispatcherWiresForProject(
  dispatcherId: string,
  projectPath: string,
  agents: readonly DurableAgentConfig[],
  projectName?: string,
): Promise<PersistedBinding[]> {
  const live = agents.filter((a) => a.id !== dispatcherId && !isDisposedAgent(a));
  if (live.length === 0) return [];
  const policies = await resolveOrchestrationPolicies(projectPath, live);
  const out: PersistedBinding[] = [];
  for (const agent of live) {
    if (policies.get(agent.id)?.connectToDispatcher) out.push(...pairBindings(dispatcherId, agent, projectName));
  }
  return out;
}

/** A project's wires, or null when its agents or policies couldn't be read. */
interface ProjectWires {
  path: string;
  bindings: PersistedBinding[] | null;
}

async function registeredProjects(): Promise<Array<{ path: string; name?: string }>> {
  return (await projectStore.list()).map((p) => ({ path: p.path, name: p.displayName || p.name }));
}

/** The wires of each project; one that can't be read is null, and logged. */
async function readWires(
  dispatcherId: string,
  projects: ReadonlyArray<{ path: string; name?: string }>,
  failure: string,
): Promise<ProjectWires[]> {
  const out: ProjectWires[] = [];
  const seen = new Set<string>();
  for (const project of projects) {
    if (seen.has(project.path) || isDispatcherPath(project.path)) continue;
    seen.add(project.path);
    try {
      const agents = await listDurable(project.path);
      out.push({ path: project.path, bindings: await dispatcherWiresForProject(dispatcherId, project.path, agents, project.name) });
    } catch (err) {
      // telemetry-exempt: logged; the caller treats the project's wires as unknown
      appLog('core:mcp', 'warn', failure, {
        meta: { projectPath: project.path, error: err instanceof Error ? err.message : String(err) },
      });
      out.push({ path: project.path, bindings: null });
    }
  }
  return out;
}

/** The Dispatcher the wires go to, or null while it is off or was never created. */
function activeDispatcherId(): string | null {
  return isDispatcherEnabled() ? getDispatcherAgentId() : null;
}

function wireSignature(bindings: readonly PersistedBinding[]): string {
  return bindings.map(bindingSignature).sort().join(',');
}

/** Key in the signature maps for the Dispatcher itself: its id, or '' while off. */
const DISPATCHER_KEY = '\u0000dispatcher';
/** Never equal to a real signature: forces the next change check to rebuild. */
const STALE = '\u0000stale';

/**
 * projectPath → signature of the wires the bindings are known to reflect,
 * committed only after a rebuild in which every source collected.
 */
const committed = new Map<string, string>();
/** Signatures read by the current rebuild's collect, committed by afterRebuild. */
const collected = new Map<string, string>();
/** projectPath → pairs from the last successful read, kept unverified when a read fails. */
const lastPairs = new Map<string, Pair[]>();
/** The Dispatcher id {@link lastPairs} was read for. */
let lastPairsFor: string | null = null;

export const dispatcherWireBindingSource: PersistedBindingSource = {
  id: DISPATCHER_WIRE_SOURCE_ID,
  prune: true,
  async collect(): Promise<CollectedBindings> {
    const dispatcherId = activeDispatcherId();
    collected.set(DISPATCHER_KEY, dispatcherId ?? '');
    if (dispatcherId !== lastPairsFor) {
      // Pairs read for another Dispatcher (or while it was off) hold nothing now.
      lastPairs.clear();
      lastPairsFor = dispatcherId;
    }
    if (!dispatcherId) return { bindings: [], unverified: [] };

    const listed = await registeredProjects();
    // A project that is no longer registered has no wires: pruned like any other change.
    const listedPaths = new Set(listed.map((p) => p.path));
    for (const path of new Set([...committed.keys(), ...lastPairs.keys()])) {
      if (path === DISPATCHER_KEY || listedPaths.has(path)) continue;
      collected.set(path, '');
      lastPairs.delete(path);
    }
    const projects = await readWires(
      dispatcherId,
      listed,
      'Could not read agents for Dispatcher wires; keeping that project\'s wires as they are',
    );
    const bindings: PersistedBinding[] = [];
    const unverified: Pair[] = [];
    for (const project of projects) {
      if (!project.bindings) {
        unverified.push(...(lastPairs.get(project.path) ?? []));
        continue;
      }
      collected.set(project.path, wireSignature(project.bindings));
      lastPairs.set(project.path, project.bindings.map((b) => ({ agentId: b.agentId, targetId: b.targetId })));
      bindings.push(...project.bindings);
    }
    return { bindings, unverified };
  },
  afterRebuild(complete) {
    // An incomplete run skipped pruning, so the bindings may still hold wires
    // these signatures no longer list: mark them stale so the next check rebuilds.
    for (const [key, signature] of collected) committed.set(key, complete ? signature : STALE);
    collected.clear();
  },
};

/** Retry delays after a rebuild that did not bring the wires up to date. */
const RETRY_DELAYS_MS = [1_000, 5_000, 15_000, 60_000];

/**
 * Call `onWiresChanged` when the Dispatcher wires change: the Dispatcher is
 * turned on or off, an agent's policy changes (its switch, its orchestration,
 * its persona, a project default persona), MCP changes for it (its own setting,
 * its project's, the app's, or Clubhouse Mode), or a project is
 * added or removed. Changes that leave the wires as they were are ignored. A
 * change counts as handled only once a rebuild commits it; until then the
 * check is retried a few times, and the next change retries it again.
 *
 * A project's wires depend only on its own agents, defaults and personas, so
 * an agent or persona change reads only that project. The Dispatcher
 * changing, the project list changing, an MCP setting changing, a retry, and a path that matches no
 * registered project read every project. Returns an unsubscribe function.
 */
export function watchDispatcherWires(onWiresChanged: () => unknown): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let attempt = 0;
  /** Projects to read on the next check; ignored while `dirtyAll` is set. */
  const dirty = new Set<string>();
  let dirtyAll = false;

  /** Returns false when nothing was scheduled (stopped, or a check is already pending). */
  const schedule = (delayMs: number): boolean => {
    if (stopped || timer) return false;
    timer = setTimeout(() => { timer = null; void check(); }, delayMs);
    return true;
  };

  const wantedSignatures = async (all: boolean, paths: ReadonlySet<string>): Promise<Map<string, string>> => {
    const dispatcherId = activeDispatcherId();
    const wanted = new Map<string, string>();
    if ((committed.get(DISPATCHER_KEY) ?? '') !== (dispatcherId ?? '')) wanted.set(DISPATCHER_KEY, dispatcherId ?? '');
    if (!dispatcherId) return wanted;
    let listed: Array<{ path: string; name?: string }>;
    try {
      listed = await registeredProjects();
    } catch (err) {
      // telemetry-exempt: logged; the next change checks again
      appLog('core:mcp', 'warn', 'Could not list projects for Dispatcher wires', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      });
      return wanted;
    }
    const listedPaths = new Set(listed.map((p) => p.path));
    // A path no project is registered under may still be one of them, spelled differently.
    const readAll = all || [...paths].some((p) => !listedPaths.has(p));
    for (const [path, signature] of committed) {
      if (path !== DISPATCHER_KEY && !listedPaths.has(path) && signature !== '') wanted.set(path, '');
    }
    const toRead = readAll ? listed : listed.filter((p) => paths.has(p.path));
    for (const project of await readWires(dispatcherId, toRead, 'Could not read agents after a config change')) {
      if (!project.bindings) continue;
      const signature = wireSignature(project.bindings);
      if (signature !== (committed.get(project.path) ?? '')) wanted.set(project.path, signature);
    }
    return wanted;
  };

  const check = async (): Promise<void> => {
    const all = dirtyAll;
    const paths = new Set(dirty);
    dirtyAll = false;
    dirty.clear();
    const wanted = await wantedSignatures(all, paths);
    if (wanted.size === 0 || stopped) {
      attempt = 0;
      return;
    }
    try {
      await onWiresChanged();
    } catch (err) {
      // telemetry-exempt: logged; retried below
      appLog('core:mcp', 'warn', 'Dispatcher wire rebuild failed', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      });
    }
    const missed = [...wanted].filter(([key, signature]) => committed.get(key) !== signature);
    if (missed.length === 0 || stopped) {
      attempt = 0;
      return;
    }
    if (attempt >= RETRY_DELAYS_MS.length) {
      appLog('core:mcp', 'warn', 'Dispatcher wires still out of date after retries; the next change retries', {
        meta: { keys: missed.map(([key]) => (key === DISPATCHER_KEY ? 'dispatcher' : key)) },
      });
      attempt = 0;
      return;
    }
    // A check already pending covers these; only a scheduled retry uses up an attempt.
    dirtyAll = true;
    if (schedule(RETRY_DELAYS_MS[attempt])) attempt++;
  };

  const changed = (): void => {
    attempt = 0;
    // A new change supersedes a pending retry. Coalesce a burst of writes (and
    // the watcher echo of our own flush), and stay out of the writer's call stack.
    if (timer) clearTimeout(timer);
    timer = null;
    schedule(50);
  };

  const allChanged = (): void => {
    dirtyAll = true;
    changed();
  };

  const projectChanged = (projectPath: string): void => {
    // The Dispatcher's own writes (status, sessions) never change a wire.
    if (isDispatcherPath(projectPath)) return;
    dirty.add(projectPath);
    changed();
  };

  const unsubscribers = [
    onAgentConfigChanged(projectChanged),
    // Both kinds of persona change are scoped to one project's agents.
    onPersonaChanged((change) => projectChanged(change.projectPath)),
    onDispatcherChanged(allChanged),
    // Any project's agents may follow the setting that changed.
    onMcpEnablementChanged(allChanged),
    // Rare (add, remove, rename): read every project, and drop the wires of one that went.
    projectStore.onProjectsChanged(allChanged),
  ];
  return () => {
    stopped = true;
    for (const unsubscribe of unsubscribers) unsubscribe();
    if (timer) clearTimeout(timer);
    timer = null;
  };
}

/** For testing: forget the signatures seen so far. */
export function _resetDispatcherWireSourceForTesting(): void {
  committed.clear();
  collected.clear();
  lastPairs.clear();
  lastPairsFor = null;
}
