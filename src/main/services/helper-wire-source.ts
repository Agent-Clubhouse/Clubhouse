/**
 * Orchestrator ↔ helper wires as a startup binding source (#2225).
 *
 * A helper is a durable agent whose `parentAgentId` names another agent, in the
 * same project (#2224) or, with `parentProjectPath`, in another one (#2513).
 * The agent config is the source of truth for the wire,
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
import { listDurable, onAgentConfigChanged, projectKey } from './agent-config';
import { bindingSignature, type CollectedBindings, type PersistedBinding, type PersistedBindingSource } from './persisted-bindings';
import { isDisposedAgent } from '../../shared/agent-helpers';
import type { DurableAgentConfig } from '../../shared/types';
import { appLog } from './log-service';

export const HELPER_WIRE_SOURCE_ID = 'helper-wires';

/**
 * Both directions of one parent ↔ helper pair. Each binding is labelled with
 * its target's project, as a canvas wire is. Empty when either is disposed: a
 * disposed helper keeps its link for history, but has no wire.
 */
function pairBindings(
  parent: DurableAgentConfig,
  helper: DurableAgentConfig,
  helperProjectName?: string,
  parentProjectName?: string,
): PersistedBinding[] {
  if (parent.id === helper.id || isDisposedAgent(helper) || isDisposedAgent(parent)) return [];
  return [
    {
      agentId: parent.id, targetId: helper.id, targetKind: 'agent', label: helper.name, agentName: parent.name, targetName: helper.name,
      ...(helperProjectName ? { projectName: helperProjectName } : {}),
    },
    {
      agentId: helper.id, targetId: parent.id, targetKind: 'agent', label: parent.name, agentName: helper.name, targetName: parent.name,
      ...(parentProjectName ? { projectName: parentProjectName } : {}),
    },
  ];
}

/**
 * Both directions of every live parent ↔ helper pair in one project. A helper
 * whose parent is in another project (`parentProjectPath`, #2511) is left to
 * {@link helperWiresAcrossProjects}.
 */
export function bindingsFromHelperAgents(
  agents: readonly DurableAgentConfig[],
  projectName?: string,
): PersistedBinding[] {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const out: PersistedBinding[] = [];
  for (const helper of agents) {
    if (helper.parentProjectPath) continue;
    const parent = helper.parentAgentId ? byId.get(helper.parentAgentId) : undefined;
    if (parent) out.push(...pairBindings(parent, helper, projectName, projectName));
  }
  return out;
}

/** A project's agents, or null when they couldn't be read. */
export interface ProjectAgents {
  path: string;
  name?: string;
  agents: readonly DurableAgentConfig[] | null;
}

/** The wires of the helpers in one project, wherever their parents are. */
export interface ProjectHelperWires {
  bindings: PersistedBinding[];
  /** Helpers whose parent is in a project that couldn't be read: their wires are unknown. */
  unresolved: string[];
}

/**
 * The helper wires of every readable project, keyed by the path of the
 * project holding the helper. One id map covers all the projects, so a helper
 * gets a wire to a parent in another project (#2513). A parent whose project
 * isn't listed has no wire; one whose project couldn't be read is unresolved.
 */
export async function helperWiresAcrossProjects(projects: readonly ProjectAgents[]): Promise<Map<string, ProjectHelperWires>> {
  const keys = new Map<string, Promise<string>>();
  const keyOf = (p: string) => {
    let key = keys.get(p);
    if (!key) {
      key = projectKey(p);
      keys.set(p, key);
    }
    return key;
  };
  const byKey = new Map<string, { project: ProjectAgents; byId: Map<string, DurableAgentConfig> | null }>();
  for (const project of projects) {
    const key = await keyOf(project.path);
    if (byKey.has(key)) continue;
    byKey.set(key, { project, byId: project.agents ? new Map(project.agents.map((a) => [a.id, a])) : null });
  }
  const out = new Map<string, ProjectHelperWires>();
  for (const project of projects) {
    if (!project.agents || out.has(project.path)) continue;
    const wires: ProjectHelperWires = { bindings: [], unresolved: [] };
    out.set(project.path, wires);
    const ownKey = await keyOf(project.path);
    for (const helper of project.agents) {
      if (!helper.parentAgentId) continue;
      const parentKey = helper.parentProjectPath ? await keyOf(helper.parentProjectPath) : ownKey;
      const home = byKey.get(parentKey);
      if (!home) continue;
      if (!home.byId) {
        wires.unresolved.push(helper.id);
        continue;
      }
      const parent = home.byId.get(helper.parentAgentId);
      if (parent) wires.bindings.push(...pairBindings(parent, helper, project.name, home.project.name));
    }
  }
  return out;
}

/** Read each project's agents; one that can't be read is null, and logged. */
async function readProjects(projects: ReadonlyArray<{ path: string; name?: string }>, failure: string): Promise<ProjectAgents[]> {
  const out: ProjectAgents[] = [];
  for (const project of projects) {
    let agents: DurableAgentConfig[] | null;
    try {
      agents = await listDurable(project.path);
    } catch (err) {
      // telemetry-exempt: logged; the caller treats the project's wires as unknown
      appLog('core:mcp', 'warn', failure, {
        meta: { projectPath: project.path, error: err instanceof Error ? err.message : String(err) },
      });
      agents = null;
    }
    out.push({ ...project, agents });
  }
  return out;
}

async function registeredProjects(): Promise<Array<{ path: string; name?: string }>> {
  return (await projectStore.list()).map((p) => ({ path: p.path, name: p.displayName || p.name }));
}

/** Stable description of a project's helper wires, to tell a relevant change from any other write. */
function wireSignature(wires: ProjectHelperWires): string {
  if (wires.unresolved.length > 0) return STALE;
  return wires.bindings
    .map(bindingSignature)
    .sort()
    .join(',');
}

/**
 * projectPath → signature of the wires the bindings are known to reflect,
 * committed only after a rebuild in which every source collected. A project's
 * signature covers the wires of the helpers it holds, so a change to a parent
 * in another project changes it too.
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
    const listed = await registeredProjects();
    // A project that is no longer registered has no wires: pruned like any other change.
    const listedPaths = new Set(listed.map((p) => p.path));
    for (const projectPath of new Set([...committed.keys(), ...lastPairs.keys()])) {
      if (listedPaths.has(projectPath)) continue;
      collected.set(projectPath, '');
      lastPairs.delete(projectPath);
    }
    const projects = await readProjects(
      listed,
      'Could not read agents for helper wires; keeping that project\'s wires as they are',
    );
    const wiresByProject = await helperWiresAcrossProjects(projects);
    const bindings: PersistedBinding[] = [];
    const unverified: Array<{ agentId: string; targetId: string }> = [];
    for (const project of projects) {
      const previous = lastPairs.get(project.path) ?? [];
      const wires = wiresByProject.get(project.path);
      if (!wires) {
        // Unreadable (or listed twice): its wires are kept unverified until a read succeeds.
        if (!project.agents) unverified.push(...previous);
        continue;
      }
      // A helper whose parent's project couldn't be read keeps the wires it had.
      const unresolved = new Set(wires.unresolved);
      const kept = previous.filter((p) => unresolved.has(p.agentId) || unresolved.has(p.targetId));
      unverified.push(...kept);
      collected.set(project.path, wireSignature(wires));
      lastPairs.set(project.path, [...wires.bindings.map((b) => ({ agentId: b.agentId, targetId: b.targetId })), ...kept]);
      bindings.push(...wires.bindings);
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
 * created, disposed, deleted or reparented, or a project is removed). Writes that leave the wires as
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
    // A parent in one project wires helpers in others (#2513), so every
    // project's signature is checked, not only the ones that changed.
    let listed: Array<{ path: string; name?: string }> = [];
    let listedOk = false;
    try {
      listed = await registeredProjects();
      listedOk = true;
    } catch (err) {
      // telemetry-exempt: logged; the changed projects are still checked
      appLog('core:mcp', 'warn', 'Could not list projects after a config change', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      });
    }
    const toRead = [...listed, ...paths.filter((p) => !listed.some((l) => l.path === p)).map((p) => ({ path: p }))];
    const wiresByProject = await helperWiresAcrossProjects(await readProjects(toRead, 'Could not read agents after a config change'));
    const wanted = new Map<string, string>();
    const listedPaths = new Set(listed.map((l) => l.path));
    for (const [projectPath, wires] of wiresByProject) {
      // Collect reads only registered projects, so an unregistered one is held to no wires.
      if (listedOk && !listedPaths.has(projectPath)) continue;
      const signature = wireSignature(wires);
      if (signature !== (committed.get(projectPath) ?? '')) wanted.set(projectPath, signature);
    }
    if (listedOk) {
      for (const [projectPath, signature] of committed) {
        if (!listedPaths.has(projectPath) && signature !== '') wanted.set(projectPath, '');
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

  const changed = (): void => {
    attempt = 0;
    // A new write supersedes a pending retry. Coalesce a burst of writes (and
    // the watcher echo of our own flush), and stay out of the writer's call stack.
    if (timer) clearTimeout(timer);
    timer = null;
    schedule(50);
  };
  const unsubscribers = [
    onAgentConfigChanged((projectPath) => {
      dirtyProjects.add(projectPath);
      changed();
    }),
    // A removed project's wires go; every check already reads every project.
    projectStore.onProjectsChanged(changed),
  ];
  return () => {
    stopped = true;
    for (const unsubscribe of unsubscribers) unsubscribe();
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
