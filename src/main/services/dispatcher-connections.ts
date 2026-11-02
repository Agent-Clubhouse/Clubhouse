/**
 * Direct orchestrator-to-orchestrator links the Dispatcher made (#2661), and
 * their provenance. Each entry is one direction of one pair.
 *
 * The store is `dispatcher-connections.json` under the Clubhouse base dir. Not
 * the Dispatcher's folder, which is its working directory, so its ordinary file
 * tools don't land on its own provenance. orchestrator-connections isn't reused:
 * its scope needs an owner in a project and ends that are the owner or its
 * helpers, and the Dispatcher is in no project.
 *
 * What an entry is worth now ({@link statusOf}):
 * - `active`: both ends are connected orchestrators, so it is bound.
 * - `suspended`: an end stopped being one (orchestration or Connect to
 *   Dispatcher off, Clubhouse MCP off), or the Dispatcher is off. The entry stays
 *   and the binding goes; it comes back when the end qualifies again. Readback
 *   and the Connections card show this state, so a return is never unseen.
 * - `unverified`: an end's project can't be read. Entry and binding stay as they are.
 * - `gone`: an end was disposed or deleted, became a helper, or its project was
 *   unregistered. The entry is dropped for good.
 *
 * A pair the user removes is dropped and leaves a tombstone, so it stays removed
 * across restarts until the user draws it. Tombstones only cover pairs in this
 * store: a wire the Dispatcher never made has no record once the session's
 * removedByUser set is gone.
 *
 * The source prunes under #2246's rules, so it only removes bindings it created.
 * A pair the user also drew restores from the canvas source first, which leaves
 * the binding the user's. It must be registered after that source.
 */

import * as fsp from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { getBaseDirPath } from './base-dir';
import { listDurable, onAgentConfigChanged } from './agent-config';
import { pathExists } from './fs-utils';
import { resolveOrchestrationPolicies } from './orchestration-policy';
import { onMcpEnablementChanged } from './mcp-settings';
import { onPersonaChanged } from './persona-change-hook';
import * as projectStore from './project-store';
import { isDispatcherEnabled, isDispatcherPath, onDispatcherChanged } from './dispatcher/dispatcher-service';
import {
  isBindingRemovedByUser,
  listSoleOwnedPairs,
  onBindingDrawnByUser,
  onBindingRemovedByUser,
  type CollectedBindings,
  type PersistedBinding,
  type PersistedBindingSource,
} from './persisted-bindings';
import { bindingManager } from './clubhouse-mcp/binding-manager';
import { appLog } from './log-service';
import { isDisposedAgent } from '../../shared/agent-helpers';
import type { ResolvedOrchestrationPolicy } from '../../shared/orchestration-policy';
import type { DispatcherLink, DurableAgentConfig } from '../../shared/types';

export const DISPATCHER_CONNECTION_SOURCE_ID = 'dispatcher-connections';
export const DISPATCHER_CONNECTION_STORE_VERSION = 1;
/** Each wire adds tools to an agent's list, so these stay small. */
export const MAX_DISPATCHER_LINKS = 50;
export const MAX_DISPATCHER_LINKS_PER_AGENT = 10;

export interface DispatcherConnection {
  agentId: string;
  targetId: string;
  agentProjectPath: string;
  targetProjectPath: string;
  createdAt: string;
  /** The Dispatcher agent that made it. */
  createdBy: string;
}

/** A pair the user removed: the Dispatcher can't make it again until the user draws it. */
export interface RemovedPair {
  agentId: string;
  targetId: string;
  agentProjectPath: string;
  targetProjectPath: string;
  removedAt: string;
}

type Pair = { agentId: string; targetId: string };

interface StoreState {
  connections: DispatcherConnection[];
  removedByUser: RemovedPair[];
  /** False for a store written by a newer Clubhouse: read it, but never rewrite it. */
  writable: boolean;
}

export class DispatcherLinkRefused extends Error {
  constructor(readonly code: 'removed_by_user' | 'link_limit', message: string) {
    super(message);
    this.name = 'DispatcherLinkRefused';
  }
}

export function dispatcherConnectionsPath(): string {
  return path.join(getBaseDirPath(), 'dispatcher-connections.json');
}

function isPairRecord(c: Record<string, unknown>): boolean {
  return typeof c.agentId === 'string' && typeof c.targetId === 'string'
    && typeof c.agentProjectPath === 'string' && typeof c.targetProjectPath === 'string';
}

function isConnection(value: unknown): value is DispatcherConnection {
  return !!value && typeof value === 'object' && isPairRecord(value as Record<string, unknown>)
    && typeof (value as Record<string, unknown>).createdBy === 'string';
}

function isRemovedPair(value: unknown): value is RemovedPair {
  return !!value && typeof value === 'object' && isPairRecord(value as Record<string, unknown>);
}

async function quarantine(file: string, reason: string): Promise<void> {
  const aside = `${file}.corrupt-${Date.now()}`;
  await fsp.rename(file, aside);
  appLog('core:mcp', 'warn', 'Dispatcher connections file was unreadable; moved it aside and continued with none', {
    meta: { file, movedTo: aside, reason },
  });
}

/** Read the store, under the lock. Unparseable moves aside and reads as empty; other read errors throw. */
async function loadStore(): Promise<StoreState> {
  const empty: StoreState = { connections: [], removedByUser: [], writable: true };
  const file = dispatcherConnectionsPath();
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
  if (!record || !Array.isArray(record.connections) || typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    await quarantine(file, 'not a Dispatcher connections store');
    return empty;
  }
  return {
    connections: (record.connections as unknown[]).filter(isConnection),
    removedByUser: (Array.isArray(record.removedByUser) ? record.removedByUser as unknown[] : []).filter(isRemovedPair),
    writable: version <= DISPATCHER_CONNECTION_STORE_VERSION,
  };
}

async function saveStore(state: StoreState): Promise<void> {
  if (!state.writable) {
    throw new Error('The Dispatcher connections file was written by a newer version of Clubhouse, so this version leaves it unchanged.');
  }
  const file = dispatcherConnectionsPath();
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${randomUUID().slice(0, 8)}`;
  const body = JSON.stringify({
    version: DISPATCHER_CONNECTION_STORE_VERSION,
    connections: state.connections,
    removedByUser: state.removedByUser,
  }, null, 2);
  try {
    await fsp.writeFile(tmp, body, 'utf-8');
    await fsp.rename(tmp, file);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch((): void => undefined);
    throw err;
  }
}

let lock: Promise<unknown> = Promise.resolve();

function withStoreLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = lock.catch((): void => undefined).then(fn);
  lock = run.catch((): void => undefined);
  return run;
}

const samePair = (a: Pair, b: Pair) => a.agentId === b.agentId && a.targetId === b.targetId;

export function readDispatcherConnections(): Promise<DispatcherConnection[]> {
  return withStoreLock(async () => (await loadStore()).connections);
}

/** Whether the user removed this pair, in any session. */
export function isTombstoned(pair: Pair): Promise<boolean> {
  return withStoreLock(async () => (await loadStore()).removedByUser.some((r) => samePair(r, pair)));
}

/**
 * Add entries the store doesn't have, all or none. Throws when one is tombstoned
 * or the limits would be passed. Returns the ones added.
 */
export function addDispatcherConnections(entries: DispatcherConnection[]): Promise<DispatcherConnection[]> {
  return withStoreLock(async () => {
    const state = await loadStore();
    if (entries.some((e) => state.removedByUser.some((r) => samePair(r, e)))) {
      throw new DispatcherLinkRefused('removed_by_user', 'The user removed this connection. It stays removed until the user draws it again.');
    }
    const added = entries.filter((e) => !state.connections.some((c) => samePair(c, e)));
    const next = [...state.connections, ...added];
    if (added.length > 0 && next.length > MAX_DISPATCHER_LINKS) {
      throw new DispatcherLinkRefused('link_limit', `You can have at most ${MAX_DISPATCHER_LINKS} links. Disconnect one first.`);
    }
    for (const { agentId } of added) {
      if (next.filter((c) => c.agentId === agentId).length > MAX_DISPATCHER_LINKS_PER_AGENT) {
        throw new DispatcherLinkRefused('link_limit', `An orchestrator can have at most ${MAX_DISPATCHER_LINKS_PER_AGENT} outgoing links. Disconnect one first.`);
      }
    }
    if (added.length > 0) await saveStore({ ...state, connections: next });
    return added;
  });
}

/** Remove these pairs' entries. Returns the ones removed. */
export function removeDispatcherConnections(pairs: readonly Pair[]): Promise<DispatcherConnection[]> {
  return withStoreLock(async () => {
    const state = await loadStore();
    const removed = state.connections.filter((c) => pairs.some((p) => samePair(p, c)));
    if (removed.length > 0) await saveStore({ ...state, connections: state.connections.filter((c) => !removed.includes(c)) });
    return removed;
  });
}

/** The user removed a pair: drop its entry and remember the removal. A pair not in the store leaves no record. */
export function recordUserRemoval(pair: Pair): Promise<boolean> {
  return withStoreLock(async () => {
    const state = await loadStore();
    const entry = state.connections.find((c) => samePair(c, pair));
    if (!entry) return false;
    await saveStore({
      ...state,
      connections: state.connections.filter((c) => c !== entry),
      removedByUser: [...state.removedByUser.filter((r) => !samePair(r, pair)), {
        agentId: entry.agentId,
        targetId: entry.targetId,
        agentProjectPath: entry.agentProjectPath,
        targetProjectPath: entry.targetProjectPath,
        removedAt: new Date().toISOString(),
      }],
    });
    return true;
  });
}

/** The user drew a pair: the removal no longer stands. */
export function clearUserRemoval(pair: Pair): Promise<boolean> {
  return withStoreLock(async () => {
    const state = await loadStore();
    if (!state.removedByUser.some((r) => samePair(r, pair))) return false;
    await saveStore({ ...state, removedByUser: state.removedByUser.filter((r) => !samePair(r, pair)) });
    return true;
  });
}

// ── Status ───────────────────────────────────────────────────────────────

export interface OrchestratorEntry {
  agent: DurableAgentConfig;
  projectPath: string;
  projectName: string;
  policy: ResolvedOrchestrationPolicy;
}

/**
 * What the registered projects hold now. A project is in `unreadable` when its
 * agents can't be read. An empty agent list counts as unreadable too: it is more
 * likely a failed read than a project whose every agent is gone.
 */
export interface AgentCensus {
  registered: ReadonlySet<string>;
  unreadable: ReadonlySet<string>;
  agents: ReadonlyMap<string, OrchestratorEntry>;
}

export async function readAgentCensus(): Promise<AgentCensus> {
  const registered = new Set<string>();
  const unreadable = new Set<string>();
  const agents = new Map<string, OrchestratorEntry>();
  for (const project of await projectStore.list()) {
    if (isDispatcherPath(project.path) || registered.has(project.path)) continue;
    registered.add(project.path);
    try {
      if (!await pathExists(project.path)) throw new Error('The project folder is gone');
      const list = await listDurable(project.path);
      if (list.length === 0) {
        unreadable.add(project.path);
        continue;
      }
      const policies = await resolveOrchestrationPolicies(project.path, list);
      for (const agent of list) {
        const policy = policies.get(agent.id);
        if (policy) agents.set(agent.id, { agent, projectPath: project.path, projectName: project.displayName || project.name, policy });
      }
    } catch (err) {
      // telemetry-exempt: logged; that project's entries are kept as they are
      unreadable.add(project.path);
      appLog('core:mcp', 'warn', 'Could not read a project for Dispatcher connections', {
        meta: { projectPath: project.path, error: err instanceof Error ? err.message : String(err) },
      });
    }
  }
  return { registered, unreadable, agents };
}

/** Whether an entry can be the end of a Dispatcher link or setting change. */
export function isConnectedOrchestrator(agent: DurableAgentConfig, policy: ResolvedOrchestrationPolicy): boolean {
  return !isDisposedAgent(agent) && !agent.parentAgentId && policy.orchestrate && policy.connectToDispatcher;
}

export type LinkStatus = 'active' | 'suspended' | 'unverified' | 'gone';
export type SuspensionReason = 'dispatcher_off' | 'mcp_off' | 'orchestration_off' | 'not_connected_to_dispatcher';

function endStatus(id: string, projectPath: string, census: AgentCensus): LinkStatus {
  if (!census.registered.has(projectPath)) return 'gone';
  if (census.unreadable.has(projectPath)) return 'unverified';
  const entry = census.agents.get(id);
  if (!entry || isDisposedAgent(entry.agent) || entry.agent.parentAgentId) return 'gone';
  return isConnectedOrchestrator(entry.agent, entry.policy) ? 'active' : 'suspended';
}

/** The worse of the two ends. The Dispatcher being off suspends anything not gone for good. */
export function statusOf(c: DispatcherConnection, census: AgentCensus, dispatcherOn: boolean): LinkStatus {
  const ends = [endStatus(c.agentId, c.agentProjectPath, census), endStatus(c.targetId, c.targetProjectPath, census)];
  if (ends.includes('gone')) return 'gone';
  if (!dispatcherOn) return 'suspended';
  if (ends.includes('unverified')) return 'unverified';
  return ends.includes('suspended') ? 'suspended' : 'active';
}

function endReason({ policy }: OrchestratorEntry): SuspensionReason {
  if (policy.mcpOff) return 'mcp_off';
  return policy.orchestrate ? 'not_connected_to_dispatcher' : 'orchestration_off';
}

/** Why a suspended link is suspended, and which end caused it, if an end did. */
export function suspensionOf(
  c: DispatcherConnection,
  census: AgentCensus,
  dispatcherOn: boolean,
): { reason: SuspensionReason; agentId?: string } {
  if (!dispatcherOn) return { reason: 'dispatcher_off' };
  for (const [id, projectPath] of [[c.agentId, c.agentProjectPath], [c.targetId, c.targetProjectPath]]) {
    const entry = census.agents.get(id);
    if (entry && endStatus(id, projectPath, census) === 'suspended') return { reason: endReason(entry), agentId: id };
  }
  return { reason: 'not_connected_to_dispatcher' };
}

/** Drop the entries and tombstones whose ends are gone for good. Returns the entries dropped. */
export function pruneGoneConnections(census: AgentCensus): Promise<DispatcherConnection[]> {
  return withStoreLock(async () => {
    const state = await loadStore();
    const gone = state.connections.filter((c) => statusOf(c, census, true) === 'gone');
    const removedByUser = state.removedByUser.filter((r) =>
      endStatus(r.agentId, r.agentProjectPath, census) !== 'gone' && endStatus(r.targetId, r.targetProjectPath, census) !== 'gone');
    if (gone.length > 0 || removedByUser.length !== state.removedByUser.length) {
      await saveStore({ ...state, connections: state.connections.filter((c) => !gone.includes(c)), removedByUser });
    }
    return gone;
  });
}

// ── The binding source ───────────────────────────────────────────────────

export function bindingFor(from: OrchestratorEntry, to: OrchestratorEntry): PersistedBinding {
  return {
    agentId: from.agent.id, targetId: to.agent.id, targetKind: 'agent', label: to.agent.name,
    agentName: from.agent.name, targetName: to.agent.name, projectName: to.projectName,
  };
}

/** Pairs from the last successful read, kept unverified when a read fails. */
let lastPairs: Pair[] = [];
/** The pairs the last collect listed, so the watcher can tell a change that moves a wire. */
let lastListed = '';

const pairsSignature = (pairs: readonly Pair[]) => pairs.map((p) => `${p.agentId}\u0000${p.targetId}`).sort().join(',');

export const dispatcherConnectionSource: PersistedBindingSource = {
  id: DISPATCHER_CONNECTION_SOURCE_ID,
  prune: true,
  async collect(): Promise<CollectedBindings> {
    // Off: nothing is listed, so the wires are pruned. The entries stay and come back when it is on.
    if (!isDispatcherEnabled()) {
      lastPairs = [];
      lastListed = '';
      return { bindings: [], unverified: [] };
    }
    try {
      const connections = await readDispatcherConnections();
      if (connections.length === 0) {
        lastPairs = [];
        lastListed = '';
        return { bindings: [], unverified: [] };
      }
      const census = await readAgentCensus();
      const bindings: PersistedBinding[] = [];
      const unverified: Pair[] = [];
      for (const c of connections) {
        const status = statusOf(c, census, true);
        if (status === 'unverified') unverified.push({ agentId: c.agentId, targetId: c.targetId });
        if (status === 'active') bindings.push(bindingFor(census.agents.get(c.agentId)!, census.agents.get(c.targetId)!));
      }
      lastPairs = [...bindings, ...unverified];
      lastListed = pairsSignature(bindings);
      return { bindings, unverified };
    } catch (err) {
      // telemetry-exempt: logged; the pairs are kept unverified until a read succeeds
      appLog('core:mcp', 'warn', 'Could not read Dispatcher connections; keeping them as they are', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      });
      return { bindings: [], unverified: lastPairs };
    }
  },
};

/**
 * The links the Connections card shows as the Dispatcher's. `active` is a wire
 * this source alone owns. `suspended` has no binding at all. A pair the user
 * also drew is neither: it reads as an ordinary wire.
 */
export async function listDispatcherLinksForUser(): Promise<DispatcherLink[]> {
  const connections = await readDispatcherConnections();
  if (connections.length === 0) return [];
  const census = await readAgentCensus();
  const dispatcherOn = isDispatcherEnabled();
  const owned = listSoleOwnedPairs(DISPATCHER_CONNECTION_SOURCE_ID);
  const out: DispatcherLink[] = [];
  for (const c of connections) {
    if (isBindingRemovedByUser(c.agentId, c.targetId)) continue;
    const bound = bindingManager.getBindingsForAgent(c.agentId).some((b) => b.targetId === c.targetId);
    const status = statusOf(c, census, dispatcherOn);
    const shape = status === 'suspended' && !bound ? 'suspended' : owned.some((p) => samePair(p, c)) ? 'active' : null;
    if (!shape) continue;
    out.push({
      agentId: c.agentId,
      targetId: c.targetId,
      agentName: census.agents.get(c.agentId)?.agent.name ?? c.agentId,
      targetName: census.agents.get(c.targetId)?.agent.name ?? c.targetId,
      status: shape,
      ...(shape === 'suspended' && { reason: suspensionOf(c, census, dispatcherOn).reason }),
    });
  }
  return out;
}

// ── Keeping up with changes ──────────────────────────────────────────────

/**
 * Keep the store and the wires in step: the user removing or drawing a pair, and
 * any change that can move a link's status (an agent's policy, its persona, MCP,
 * the Dispatcher, the project list). Returns an unsubscribe function.
 */
export function watchDispatcherConnections(onChanged: () => unknown): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const check = async (): Promise<void> => {
    const { connections, removedByUser } = await withStoreLock(loadStore);
    if (connections.length === 0 && removedByUser.length === 0 && lastListed === '') return;
    const census = await readAgentCensus();
    const gone = await pruneGoneConnections(census);
    if (gone.length > 0) {
      appLog('core:mcp', 'info', 'Dropped Dispatcher connections whose ends are gone', { meta: { removed: gone.length } });
    }
    const dispatcherOn = isDispatcherEnabled();
    const wanted = connections.filter((c) => statusOf(c, census, dispatcherOn) === 'active');
    if (pairsSignature(wanted) !== lastListed && !stopped) await onChanged();
  };

  const changed = (): void => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    // Coalesce a burst of writes, and stay out of the writer's call stack.
    timer = setTimeout(() => {
      timer = null;
      void check().catch((err) => {
        // telemetry-exempt: logged; the next change retries, and rebuilds read the store anyway
        appLog('core:mcp', 'warn', 'Could not update Dispatcher connections after a change', {
          meta: { error: err instanceof Error ? err.message : String(err) },
        });
      });
    }, 50);
  };

  const projectChanged = (projectPath: string): void => {
    // The Dispatcher's own writes (status, sessions) never move a link.
    if (!isDispatcherPath(projectPath)) changed();
  };

  const unsubscribers = [
    onAgentConfigChanged(projectChanged),
    onPersonaChanged((change) => projectChanged(change.projectPath)),
    onDispatcherChanged(changed),
    onMcpEnablementChanged(changed),
    projectStore.onProjectsChanged(changed),
    onBindingRemovedByUser((agentId, targetId) => {
      void recordUserRemoval({ agentId, targetId }).then((recorded) => {
        if (recorded) appLog('core:mcp', 'info', 'The user removed a Dispatcher connection', { meta: { agentId, targetId } });
      }, (err) => {
        // telemetry-exempt: logged; the pair stays skipped this session
        appLog('core:mcp', 'warn', 'Could not record a user-removed Dispatcher connection', {
          meta: { agentId, targetId, error: err instanceof Error ? err.message : String(err) },
        });
      });
    }),
    onBindingDrawnByUser((agentId, targetId) => {
      void clearUserRemoval({ agentId, targetId }).catch((err) => {
        // telemetry-exempt: logged; the Dispatcher stays refused for this pair, which is the safe side
        appLog('core:mcp', 'warn', 'Could not clear a Dispatcher connection removal', {
          meta: { agentId, targetId, error: err instanceof Error ? err.message : String(err) },
        });
      });
    }),
  ];
  return () => {
    stopped = true;
    for (const unsubscribe of unsubscribers) unsubscribe();
    if (timer) clearTimeout(timer);
    timer = null;
  };
}

/** For testing: forget what was seen so far. */
export function _resetDispatcherConnectionsForTesting(): void {
  lastPairs = [];
  lastListed = '';
  lock = Promise.resolve();
}
