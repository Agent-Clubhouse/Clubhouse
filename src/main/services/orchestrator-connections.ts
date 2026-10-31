/**
 * Connections an orchestrator made with its connection tools (#2230): its own
 * and its helpers' agent-to-agent wires and group-project memberships.
 *
 * Each project keeps them in `.clubhouse/.local/orchestrator-connections.json`
 * (local state like agents.json, whose agent ids it refers to). At startup,
 * and whenever bindings are rebuilt, {@link orchestratorConnectionSource}
 * lists them for {@link rebuildPersistedBindings}, silently like every other
 * restore: no join bulletin, no polling start.
 *
 * The source prunes, with #2246's rules: it removes only bindings it created
 * (at a restore, or through {@link claimSourceBinding} when a tool connects),
 * so a canvas wire, a zone or a helper wire for the same pair is never
 * removed by it. Entries are scoped to their owner: once the owner is gone or
 * an end is no longer the owner or one of its live direct helpers (in any
 * project, #2513), the entry is skipped at restore and dropped from the store
 * when agents change ({@link watchOrchestratorConnections}). An end in
 * another project is recorded with that project's path; while that project
 * can't be read, its entry is kept and its binding left as it is. A pair the user deletes in
 * the UI is dropped from the store too, so it stays deleted across restarts.
 *
 * The store is written atomically (temp file, then rename) and read and
 * written under a per-project lock. A file that can't be parsed is moved
 * aside as `.corrupt-<ts>` and the store continues empty.
 */

import * as fsp from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import * as projectStore from './project-store';
import { listDurable, onAgentConfigChanged, projectKey } from './agent-config';
import { listHelpersEverywhere } from './helper-index';
import { pathExists } from './fs-utils';
import { groupProjectRegistry } from './group-project-registry';
import { onBindingRemovedByUser, type CollectedBindings, type PersistedBinding, type PersistedBindingSource } from './persisted-bindings';
import { isDisposedAgent } from '../../shared/agent-helpers';
import type { DurableAgentConfig } from '../../shared/types';
import { appLog } from './log-service';

export const ORCHESTRATOR_CONNECTION_SOURCE_ID = 'orchestrator-connections';

/** One directed connection: an agent wire, or a member in a group project. */
export interface OrchestratorConnection {
  /** The orchestrator that made it. */
  ownerId: string;
  /** The agent that gets the binding. */
  agentId: string;
  /** The agent it reaches, or the group project it joined. */
  targetId: string;
  targetKind: 'agent' | 'group-project';
  createdAt: string;
  /** The project holding `agentId`, set only when it isn't the store's project (#2513). */
  agentProjectPath?: string;
  /** The project holding agent `targetId`, set only when it isn't the store's project (#2513). */
  targetProjectPath?: string;
}

/** The store format this build writes. */
export const CONNECTION_STORE_VERSION = 1;

interface StoreState {
  connections: OrchestratorConnection[];
  /** Entries this build doesn't recognize: kept as they are and written back. */
  unknown: unknown[];
  /** False for a store written by a newer Clubhouse: read it, but never rewrite it. */
  writable: boolean;
}

export function connectionsStorePath(projectPath: string): string {
  return path.join(projectPath, '.clubhouse', '.local', 'orchestrator-connections.json');
}

function isConnection(value: unknown): value is OrchestratorConnection {
  if (!value || typeof value !== 'object') return false;
  const c = value as Record<string, unknown>;
  const optionalPath = (v: unknown) => v === undefined || typeof v === 'string';
  return typeof c.ownerId === 'string' && typeof c.agentId === 'string' && typeof c.targetId === 'string'
    && (c.targetKind === 'agent' || c.targetKind === 'group-project')
    && optionalPath(c.agentProjectPath) && optionalPath(c.targetProjectPath);
}

/** Move an unreadable store aside so the next write starts clean, and say so in the log. */
async function quarantine(file: string, reason: string): Promise<void> {
  const aside = `${file}.corrupt-${Date.now()}`;
  await fsp.rename(file, aside);
  appLog('core:mcp', 'warn', 'Orchestrator connections file was unreadable; moved it aside and continued with none', {
    meta: { file, movedTo: aside, reason },
  });
}

/**
 * Read the store. Call under the project's lock. A missing file is empty; a
 * file that can't be parsed is moved aside (`.corrupt-<ts>`) and read as
 * empty. Other read errors throw.
 */
async function loadStore(projectPath: string): Promise<StoreState> {
  const empty: StoreState = { connections: [], unknown: [], writable: true };
  const file = connectionsStorePath(projectPath);
  let raw: string;
  try {
    raw = await fsp.readFile(file, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return empty;
    throw err;
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    // telemetry-exempt: logged by quarantine; the store continues empty
    await quarantine(file, err instanceof Error ? err.message : String(err));
    return empty;
  }
  const record = data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : null;
  const version = record?.version;
  // A newer Clubhouse wrote it: read what this build recognizes, never rewrite or move it.
  if (typeof version === 'number' && version > CONNECTION_STORE_VERSION) {
    const entries = Array.isArray(record!.connections) ? record!.connections as unknown[] : [];
    return { connections: entries.filter(isConnection), unknown: entries.filter((e) => !isConnection(e)), writable: false };
  }
  if (!record || !Array.isArray(record.connections) || typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    await quarantine(file, 'not a connections store');
    return empty;
  }
  const entries = record.connections as unknown[];
  return {
    connections: entries.filter(isConnection),
    unknown: entries.filter((e) => !isConnection(e)),
    writable: true,
  };
}

/** Write atomically: a temp file, then a rename, so a crash never leaves a torn store. */
async function saveStore(projectPath: string, state: StoreState): Promise<void> {
  if (!state.writable) {
    throw new Error('The orchestrator connections file was written by a newer version of Clubhouse, so this version leaves it unchanged.');
  }
  const file = connectionsStorePath(projectPath);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${randomUUID().slice(0, 8)}`;
  const body = JSON.stringify({ version: CONNECTION_STORE_VERSION, connections: [...state.connections, ...state.unknown] }, null, 2);
  try {
    await fsp.writeFile(tmp, body, 'utf-8');
    await fsp.rename(tmp, file);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch((): void => undefined);
    throw err;
  }
}

/** One read or read-modify-write at a time per project. */
const locks = new Map<string, Promise<unknown>>();

function withStoreLock<T>(projectPath: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(projectPath);
  const run = (locks.get(key) ?? Promise.resolve()).catch((): void => undefined).then(fn);
  const settled = run.catch((): void => undefined);
  locks.set(key, settled);
  void settled.then(() => {
    if (locks.get(key) === settled) locks.delete(key);
  });
  return run;
}

/** The project's connections, read under the store lock; empty when it has none. */
export function readConnections(projectPath: string): Promise<OrchestratorConnection[]> {
  return withStoreLock(projectPath, async () => (await loadStore(projectPath)).connections);
}

const sameConnection = (a: Pick<OrchestratorConnection, 'agentId' | 'targetId'>, b: Pick<OrchestratorConnection, 'agentId' | 'targetId'>) =>
  a.agentId === b.agentId && a.targetId === b.targetId;

/** Add connections the store doesn't have yet. Returns the ones added. */
export function addConnections(projectPath: string, entries: OrchestratorConnection[]): Promise<OrchestratorConnection[]> {
  return withStoreLock(projectPath, async () => {
    const state = await loadStore(projectPath);
    const added = entries.filter((e, i) =>
      !state.connections.some((c) => sameConnection(c, e)) && entries.findIndex((o) => sameConnection(o, e)) === i);
    if (added.length > 0) await saveStore(projectPath, { ...state, connections: [...state.connections, ...added] });
    return added;
  });
}

/**
 * Remove `ownerId`'s connections that `match` selects. Returns the ones
 * removed and the connections left, so a caller can tell whether another
 * entry still lists a pair.
 */
export function removeConnections(
  projectPath: string,
  ownerId: string,
  match: (c: OrchestratorConnection) => boolean,
): Promise<{ removed: OrchestratorConnection[]; remaining: OrchestratorConnection[] }> {
  return withStoreLock(projectPath, async () => {
    const state = await loadStore(projectPath);
    const drop = (c: OrchestratorConnection) => c.ownerId === ownerId && match(c);
    const removed = state.connections.filter(drop);
    const remaining = state.connections.filter((c) => !drop(c));
    if (removed.length > 0) await saveStore(projectPath, { ...state, connections: remaining });
    return { removed, remaining };
  });
}

/**
 * Drop every stored entry for a pair, whoever made it, in every registered
 * project: the user removed that connection, and it stays removed across
 * restarts. Returns the number of entries dropped.
 */
export async function removeStoredPair(agentId: string, targetId: string): Promise<number> {
  let dropped = 0;
  for (const project of await projectStore.list()) {
    const removed = await withStoreLock(project.path, async () => {
      const state = await loadStore(project.path);
      const match = (c: OrchestratorConnection) => c.agentId === agentId && c.targetId === targetId;
      const hits = state.connections.filter(match);
      if (hits.length > 0) await saveStore(project.path, { ...state, connections: state.connections.filter((c) => !match(c)) });
      return hits.length;
    });
    dropped += removed;
  }
  return dropped;
}

/** An agent a connection can name, and the name of the project holding it. */
export interface ScopedAgent {
  config: DurableAgentConfig;
  projectName?: string;
}

/**
 * The agents a project's stored connections can name: the project's own, and
 * the live direct helpers its agents have in other projects (#2513).
 */
export interface ConnectionScope {
  /** The store's project's agents, by id. */
  local: ReadonlyMap<string, DurableAgentConfig>;
  /** The store's project's name, for bindings to its agents. */
  projectName?: string;
  /** owner id → its live direct helpers in other projects, by id. */
  foreign: ReadonlyMap<string, ReadonlyMap<string, ScopedAgent>>;
  /** Recorded end projects (agentProjectPath, targetProjectPath) that are gone or can't be read. */
  unreadable: ReadonlySet<string>;
}

/** Whether a project's agents can be read now. A folder that is gone counts as unreadable. */
async function isReadable(projectPath: string): Promise<boolean> {
  try {
    if (!await pathExists(projectPath)) return false;
    await listDurable(projectPath);
    return true;
  } catch {
    // telemetry-exempt: an unreadable project only means its entries are kept as they are
    return false;
  }
}

/**
 * Build the scope for `connections`, stored in `projectPath` whose agents are
 * `agents`. Other projects are only read when an entry has an end in one.
 */
export async function loadConnectionScope(
  projectPath: string,
  agents: readonly DurableAgentConfig[],
  connections: readonly OrchestratorConnection[],
  projectName?: string,
): Promise<ConnectionScope> {
  const local = new Map(agents.map((a) => [a.id, a]));
  const foreign = new Map<string, Map<string, ScopedAgent>>();
  const unreadable = new Set<string>();
  const endProjects = new Set(connections.flatMap((c) => [c.agentProjectPath, c.targetProjectPath]).filter((p): p is string => !!p));
  if (endProjects.size === 0) return { local, projectName, foreign, unreadable };
  for (const p of endProjects) {
    if (!await isReadable(p)) unreadable.add(p);
  }
  const homeKey = await projectKey(projectPath);
  const names = new Map((await projectStore.list()).map((p) => [p.path, p.displayName || p.name]));
  const owners = new Set(connections.filter((c) => c.agentProjectPath || c.targetProjectPath).map((c) => c.ownerId));
  for (const ownerId of owners) {
    if (!local.has(ownerId)) continue;
    const helpers = new Map<string, ScopedAgent>();
    for (const entry of await listHelpersEverywhere(projectPath, ownerId)) {
      if (await projectKey(entry.projectPath) === homeKey) continue;
      helpers.set(entry.config.id, { config: entry.config, projectName: names.get(entry.projectPath) });
    }
    if (helpers.size > 0) foreign.set(ownerId, helpers);
  }
  return { local, projectName, foreign, unreadable };
}

/**
 * Whether a connection is still within its owner's reach: `in` when the owner
 * exists and is not disposed and each agent end is the owner or one of its
 * live direct helpers, in this project or the one recorded for it. A helper
 * that was disposed, deleted, reparented or released (an orchestrator turned
 * off or deleted with "keep helpers") makes it `out`. `unknown` when an end's
 * recorded project can't be read.
 */
export function connectionStatus(c: OrchestratorConnection, scope: ConnectionScope): 'in' | 'out' | 'unknown' {
  const owner = scope.local.get(c.ownerId);
  if (!owner || isDisposedAgent(owner)) return 'out';
  const reach = (id: string, recordedProject: string | undefined): 'in' | 'out' | 'unknown' => {
    if (id === owner.id) return 'in';
    if (!recordedProject) {
      const agent = scope.local.get(id);
      return agent && !isDisposedAgent(agent) && agent.parentAgentId === owner.id && !agent.parentProjectPath ? 'in' : 'out';
    }
    if (scope.foreign.get(owner.id)?.has(id)) return 'in';
    return scope.unreadable.has(recordedProject) ? 'unknown' : 'out';
  };
  const from = reach(c.agentId, c.agentProjectPath);
  const to = c.targetKind === 'agent' ? reach(c.targetId, c.targetProjectPath) : 'in';
  if (from === 'out' || to === 'out') return 'out';
  return from === 'unknown' || to === 'unknown' ? 'unknown' : 'in';
}

/** An agent in the scope, and the name of its project. */
function scopedAgent(scope: ConnectionScope, ownerId: string, id: string, recordedProject: string | undefined): ScopedAgent | undefined {
  if (recordedProject) return scope.foreign.get(ownerId)?.get(id);
  const local = scope.local.get(id);
  return local ? { config: local, projectName: scope.projectName } : undefined;
}

/**
 * The bindings for a project's stored connections. Drops entries that are out
 * of scope ({@link connectionStatus}) and memberships of group projects that
 * no longer exist (`groupProjects`: id → name; null when the registry can't
 * be read, which keeps them). Pairs whose scope is unknown come back in
 * `unknown`, to be kept as they are. An agent wire is labelled with its
 * target's project.
 */
export function bindingsFromConnections(
  connections: readonly OrchestratorConnection[],
  scope: ConnectionScope,
  groupProjects: ReadonlyMap<string, string> | null,
): { bindings: PersistedBinding[]; unknown: Array<{ agentId: string; targetId: string }> } {
  const out: PersistedBinding[] = [];
  const unknown: Array<{ agentId: string; targetId: string }> = [];
  const seen = new Set<string>();
  for (const c of connections) {
    if (c.agentId === c.targetId) continue;
    const status = connectionStatus(c, scope);
    if (status === 'unknown') unknown.push({ agentId: c.agentId, targetId: c.targetId });
    if (status !== 'in') continue;
    const from = scopedAgent(scope, c.ownerId, c.agentId, c.agentProjectPath)!.config;
    const pair = `${c.agentId}\u0000${c.targetId}`;
    if (seen.has(pair)) continue;
    if (c.targetKind === 'agent') {
      const to = scopedAgent(scope, c.ownerId, c.targetId, c.targetProjectPath)!;
      seen.add(pair);
      out.push({
        agentId: from.id, targetId: to.config.id, targetKind: 'agent', label: to.config.name,
        agentName: from.name, targetName: to.config.name, ...(to.projectName ? { projectName: to.projectName } : {}),
      });
    } else {
      let name = c.targetId;
      if (groupProjects) {
        const current = groupProjects.get(c.targetId);
        if (current === undefined) continue; // project deleted
        if (current) name = current;
      }
      seen.add(pair);
      out.push({ agentId: from.id, targetId: c.targetId, targetKind: 'group-project', label: name, agentName: from.name, targetName: name });
    }
  }
  return { bindings: out, unknown };
}

async function readGroupProjectNames(): Promise<Map<string, string> | null> {
  try {
    const projects = await groupProjectRegistry.list();
    return new Map(projects.map((p) => [p.id, p.name ?? '']));
  } catch {
    // telemetry-exempt: null keeps memberships, as the canvas source does
    return null;
  }
}

/** projectPath → pairs from the last successful read, kept unverified when a read fails. */
const lastPairs = new Map<string, Array<{ agentId: string; targetId: string }>>();

export const orchestratorConnectionSource: PersistedBindingSource = {
  id: ORCHESTRATOR_CONNECTION_SOURCE_ID,
  prune: true,
  async collect(): Promise<CollectedBindings> {
    const [projects, groupProjects] = await Promise.all([projectStore.list(), readGroupProjectNames()]);
    const bindings: PersistedBinding[] = [];
    const unverified: Array<{ agentId: string; targetId: string }> = [];
    for (const project of projects) {
      let projectBindings: PersistedBinding[] = [];
      let unknown: Array<{ agentId: string; targetId: string }> = [];
      try {
        const connections = await readConnections(project.path);
        if (connections.length > 0) {
          const name = project.displayName || project.name;
          const scope = await loadConnectionScope(project.path, await listDurable(project.path), connections, name);
          const result = bindingsFromConnections(connections, scope, groupProjects);
          projectBindings = result.bindings;
          // An end in a project that can't be read: keep the pair as it is.
          unknown = result.unknown;
          unverified.push(...unknown);
        }
      } catch (err) {
        // telemetry-exempt: logged; the project's connections are kept unverified until a read succeeds
        appLog('core:mcp', 'warn', 'Could not read orchestrator connections; keeping that project\'s connections as they are', {
          meta: { projectPath: project.path, error: err instanceof Error ? err.message : String(err) },
        });
        unverified.push(...(lastPairs.get(project.path) ?? []));
        continue;
      }
      lastPairs.set(project.path, [...projectBindings.map((b) => ({ agentId: b.agentId, targetId: b.targetId })), ...unknown]);
      bindings.push(...projectBindings);
    }
    return { bindings, unverified };
  },
};

/**
 * Drop the stored connections that fell out of scope
 * ({@link connectionStatus}), group-project memberships included. An empty
 * agent list deletes nothing: it is more likely a failed read than a project
 * whose every agent is gone. Neither does an end whose recorded project
 * can't be read. Returns the connections removed.
 */
export async function pruneOutOfScopeConnections(projectPath: string): Promise<OrchestratorConnection[]> {
  const agents = await listDurable(projectPath);
  if (agents.length === 0) return [];
  return withStoreLock(projectPath, async () => {
    const state = await loadStore(projectPath);
    if (state.connections.length === 0) return [];
    const scope = await loadConnectionScope(projectPath, agents, state.connections);
    const removed = state.connections.filter((c) => connectionStatus(c, scope) === 'out');
    if (removed.length > 0) {
      await saveStore(projectPath, { ...state, connections: state.connections.filter((c) => !removed.includes(c)) });
    }
    return removed;
  });
}

/**
 * Keep the stores in step. When the user removes a pair through the UI, drop
 * its stored entries so it stays removed after a restart. When any project's
 * agents change, drop the connections in every project that fell out of
 * scope (a helper disposed, deleted, reparented or released) and call
 * `onConnectionsChanged` (a rebuild, which prunes their bindings). Returns an
 * unsubscribe function.
 */
export function watchOrchestratorConnections(onConnectionsChanged: () => unknown): () => void {
  const dirty = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const check = async (): Promise<void> => {
    const paths = [...dirty];
    dirty.clear();
    // A store in one project lists helpers in others (#2513): a change
    // anywhere can put any project's entries out of scope.
    try {
      for (const project of await projectStore.list()) {
        if (!paths.includes(project.path)) paths.push(project.path);
      }
    } catch (err) {
      // telemetry-exempt: logged; the changed projects are still checked
      appLog('core:mcp', 'warn', 'Could not list projects after an agent change', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      });
    }
    let changed = false;
    for (const projectPath of paths) {
      try {
        const removed = await pruneOutOfScopeConnections(projectPath);
        if (removed.length > 0) {
          changed = true;
          appLog('core:mcp', 'info', 'Dropped orchestrator connections that fell out of scope', {
            meta: { projectPath, removed: removed.length },
          });
        }
      } catch (err) {
        // telemetry-exempt: logged; the next agent change retries, and rebuilds skip gone agents anyway
        appLog('core:mcp', 'warn', 'Could not update orchestrator connections after an agent change', {
          meta: { projectPath, error: err instanceof Error ? err.message : String(err) },
        });
      }
    }
    if (changed && !stopped) await onConnectionsChanged();
  };

  const unsubscribe = onAgentConfigChanged((projectPath) => {
    dirty.add(projectPath);
    // Coalesce a burst of writes and stay out of the writer's call stack.
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void check().catch((err) => {
        // telemetry-exempt: logged; the next agent change retries
        appLog('core:mcp', 'warn', 'Orchestrator connection rebuild failed', {
          meta: { error: err instanceof Error ? err.message : String(err) },
        });
      });
    }, 50);
  });
  // The user deleted a tool-made wire in the UI: drop it from the store so a
  // restart doesn't bring it back. The binding is already gone.
  const unsubscribeRemovals = onBindingRemovedByUser((agentId, targetId) => {
    void removeStoredPair(agentId, targetId).then((dropped) => {
      if (dropped > 0) {
        appLog('core:mcp', 'info', 'Dropped orchestrator connections the user removed', { meta: { agentId, targetId, dropped } });
      }
    }, (err) => {
      // telemetry-exempt: logged; the pair stays skipped this session, and the next removal retries
      appLog('core:mcp', 'warn', 'Could not drop a user-removed orchestrator connection', {
        meta: { agentId, targetId, error: err instanceof Error ? err.message : String(err) },
      });
    });
  });
  return () => {
    stopped = true;
    unsubscribe();
    unsubscribeRemovals();
    if (timer) clearTimeout(timer);
    timer = null;
  };
}

/** For testing: forget the pairs seen so far. */
export function _resetOrchestratorConnectionsForTesting(): void {
  lastPairs.clear();
  locks.clear();
}
