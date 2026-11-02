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
 * A removal the store can't take stays pending: in memory, and in a file of its
 * own when that can be written. Every read of the store applies pending removals
 * first, so a restore never sees the stale entry, and the next successful save
 * carries them in. If the store's folder took no write at all, the removal has no
 * record past this session, so the user is told, and a later session that still
 * can't write here restores nothing.
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
/** How often to try a store that refused a write again. */
const STORE_RETRY_MS = 30_000;

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

/** A user removal the store hasn't taken. No project paths when the store couldn't be read. */
type PendingRemoval = Pair & Partial<Pick<RemovedPair, 'agentProjectPath' | 'targetProjectPath'>> & { removedAt: string };

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

export function dispatcherPendingRemovalsPath(): string {
  return path.join(getBaseDirPath(), 'dispatcher-connections.pending-removals.json');
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

/** The store file as written, under the lock. Unparseable moves aside and reads as empty; other read errors throw. */
async function readStoreFile(): Promise<StoreState> {
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

async function writeFileAtomically(file: string, body: string): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${randomUUID().slice(0, 8)}`;
  try {
    await fsp.writeFile(tmp, body, 'utf-8');
    await fsp.rename(tmp, file);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch((): void => undefined);
    throw err;
  }
}

const pairKey = (pair: Pair) => `${pair.agentId}\u0000${pair.targetId}`;

/** Holds the pending file's entries too once it has been read. All access is under the lock. */
const pendingRemovals = new Map<string, PendingRemoval>();
/** False while pendingRemovals holds something the pending file doesn't. */
let pendingSaved = true;
/** A save or a probe has landed in the store's folder this session. */
let writesProven = false;
/** The probe failed, so nothing can rule out a removal the last session couldn't record. */
let writesBlocked = false;

function isPendingRemoval(value: unknown): value is PendingRemoval {
  const record = value as Record<string, unknown> | null;
  return !!record && typeof record === 'object' && typeof record.agentId === 'string' && typeof record.targetId === 'string';
}

/** Throws on a file it can't read: what it may hold is unknown, so nothing should restore past it. */
async function readPendingFile(): Promise<void> {
  let raw: string;
  try {
    raw = await fsp.readFile(dispatcherPendingRemovalsPath(), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  const removals = (JSON.parse(raw) as { removals?: unknown } | null)?.removals;
  if (!Array.isArray(removals) || !removals.every(isPendingRemoval)) {
    throw new Error('The Dispatcher pending removals file is not one this version can read.');
  }
  for (const removal of removals) {
    if (!pendingRemovals.has(pairKey(removal))) pendingRemovals.set(pairKey(removal), removal);
  }
}

async function savePendingRemovals(): Promise<void> {
  try {
    // Reading first means a file this can't read is left alone, not overwritten.
    await readPendingFile();
    await writeFileAtomically(dispatcherPendingRemovalsPath(), JSON.stringify({ version: 1, removals: [...pendingRemovals.values()] }, null, 2));
    pendingSaved = true;
  } catch (err) {
    // telemetry-exempt: logged; the caller reports pendingSaved to the user
    pendingSaved = false;
    appLog('core:mcp', 'warn', 'Could not save a pending Dispatcher connection removal', {
      meta: { error: err instanceof Error ? err.message : String(err) },
    });
  }
}

/** The store now holds these removals. A leftover file only re-applies what the store already says. */
async function clearPendingRemovals(): Promise<void> {
  if (pendingRemovals.size === 0) return;
  pendingRemovals.clear();
  pendingSaved = true;
  await fsp.rm(dispatcherPendingRemovalsPath(), { force: true }).catch((err) => {
    // telemetry-exempt: logged; the next save tries again
    appLog('core:mcp', 'warn', 'Could not delete the Dispatcher pending removals file', {
      meta: { error: err instanceof Error ? err.message : String(err) },
    });
  });
}

/** Read the store as it should be: with pending removals dropped and tombstoned. */
async function loadStore(): Promise<StoreState> {
  await readPendingFile();
  const state = await readStoreFile();
  if (pendingRemovals.size === 0) return state;
  const removedByUser = [...state.removedByUser];
  for (const removal of pendingRemovals.values()) {
    const paths = state.connections.find((c) => pairKey(c) === pairKey(removal)) ?? removal;
    if (paths.agentProjectPath === undefined || paths.targetProjectPath === undefined) continue;
    const at = removedByUser.findIndex((r) => pairKey(r) === pairKey(removal));
    const tombstone: RemovedPair = {
      agentId: removal.agentId,
      targetId: removal.targetId,
      agentProjectPath: paths.agentProjectPath,
      targetProjectPath: paths.targetProjectPath,
      removedAt: removal.removedAt,
    };
    if (at >= 0) removedByUser[at] = tombstone;
    else removedByUser.push(tombstone);
  }
  return { ...state, connections: state.connections.filter((c) => !pendingRemovals.has(pairKey(c))), removedByUser };
}

/** Takes state from loadStore, so a save carries every pending removal with it. */
async function saveStore(state: StoreState): Promise<void> {
  if (!state.writable) {
    throw new Error('The Dispatcher connections file was written by a newer version of Clubhouse, so this version leaves it unchanged.');
  }
  await writeFileAtomically(dispatcherConnectionsPath(), JSON.stringify({
    version: DISPATCHER_CONNECTION_STORE_VERSION,
    connections: state.connections,
    removedByUser: state.removedByUser,
  }, null, 2));
  writesProven = true;
  writesBlocked = false;
  await clearPendingRemovals();
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

/**
 * The user removed a pair: drop its entry and remember the removal. A pair not in
 * the store leaves no record. If the store can't take that, the removal stays
 * pending, which every later read of the store applies first.
 */
export function recordUserRemoval(pair: Pair): Promise<boolean> {
  return withStoreLock(async () => {
    const { agentId, targetId } = pair;
    const removedAt = new Date().toISOString();
    let entry: DispatcherConnection | undefined;
    let failure: unknown;
    try {
      const state = await loadStore();
      entry = state.connections.find((c) => samePair(c, pair));
      if (!entry) return false;
      await saveStore({
        ...state,
        connections: state.connections.filter((c) => c !== entry),
        removedByUser: [...state.removedByUser.filter((r) => !samePair(r, pair)), {
          agentId,
          targetId,
          agentProjectPath: entry.agentProjectPath,
          targetProjectPath: entry.targetProjectPath,
          removedAt,
        }],
      });
      return true;
    } catch (err) {
      failure = err;
    }
    // telemetry-exempt: logged; the removal stays pending, and isRemovalUnsaved tells the user if that isn't on disk
    appLog('core:mcp', 'warn', 'Could not save a user-removed Dispatcher connection to the store; keeping it pending', {
      meta: { agentId, targetId, error: failure instanceof Error ? failure.message : String(failure) },
    });
    pendingRemovals.set(pairKey(pair), {
      agentId,
      targetId,
      ...(entry && { agentProjectPath: entry.agentProjectPath, targetProjectPath: entry.targetProjectPath }),
      removedAt,
    });
    pendingSaved = false;
    await savePendingRemovals();
    return true;
  });
}

/**
 * Whether this removal has no record that would survive a restart. Runs after the
 * write the removal queued, since that holds the lock first.
 */
export function isRemovalUnsaved(pair: Pair): Promise<boolean> {
  return withStoreLock(async () => pendingRemovals.has(pairKey(pair)) && !pendingSaved);
}

/**
 * Removals of the Dispatcher's links the store hasn't taken yet, and whether each
 * would survive a restart. One with no project paths may not be its link, so it isn't listed.
 */
export function listPendingRemovals(): Promise<Array<Pair & { saved: boolean }>> {
  return withStoreLock(async () => {
    await readPendingFile();
    return [...pendingRemovals.values()]
      .filter((r) => r.agentProjectPath !== undefined)
      .map(({ agentId, targetId }) => ({ agentId, targetId, saved: pendingSaved }));
  });
}

/**
 * Try again to move pending removals into the store, or failing that onto disk.
 * Returns whether another try could help. A store from a newer Clubhouse can't
 * take them, so once they are in the pending file they just stay there.
 */
export function settlePendingRemovals(): Promise<boolean> {
  return withStoreLock(async () => {
    let newerStore = false;
    try {
      await readPendingFile();
      if (pendingRemovals.size === 0) return false;
      const state = await loadStore();
      if (state.writable) {
        await saveStore(state);
        return false;
      }
      newerStore = true;
    } catch (err) {
      // telemetry-exempt: logged; pending removals keep applying, and the caller retries
      appLog('core:mcp', 'warn', 'Could not save pending Dispatcher connection removals', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      });
    }
    if (pendingRemovals.size === 0) return false;
    if (!pendingSaved) await savePendingRemovals();
    return !pendingSaved || !newerStore;
  });
}

/**
 * Whether the store's folder takes a write, until once this session it has. If it
 * doesn't, the session before may have had no way to record a removal, so saved
 * links stay down ({@link statusOf}) until it does.
 */
function probeStoreWrites(): Promise<boolean> {
  return withStoreLock(async () => {
    if (writesProven) return true;
    const probe = `${dispatcherConnectionsPath()}.probe.${randomUUID().slice(0, 8)}`;
    try {
      await writeFileAtomically(probe, '');
      await fsp.rm(probe, { force: true });
      writesProven = true;
      writesBlocked = false;
    } catch (err) {
      // telemetry-exempt: logged; readback and the Connections card show the links as suspended
      writesBlocked = true;
      appLog('core:mcp', 'warn', 'Dispatcher connections folder takes no writes; leaving saved links down', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      });
    }
    return writesProven;
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
export type SuspensionReason = 'dispatcher_off' | 'store_unwritable' | 'mcp_off' | 'orchestration_off' | 'not_connected_to_dispatcher';

function endStatus(id: string, projectPath: string, census: AgentCensus): LinkStatus {
  if (!census.registered.has(projectPath)) return 'gone';
  if (census.unreadable.has(projectPath)) return 'unverified';
  const entry = census.agents.get(id);
  if (!entry || isDisposedAgent(entry.agent) || entry.agent.parentAgentId) return 'gone';
  return isConnectedOrchestrator(entry.agent, entry.policy) ? 'active' : 'suspended';
}

/** The worse of the two ends. The Dispatcher being off, or a store that takes no writes, suspends anything not gone for good. */
export function statusOf(c: DispatcherConnection, census: AgentCensus, dispatcherOn: boolean): LinkStatus {
  const ends = [endStatus(c.agentId, c.agentProjectPath, census), endStatus(c.targetId, c.targetProjectPath, census)];
  if (ends.includes('gone')) return 'gone';
  if (!dispatcherOn || writesBlocked) return 'suspended';
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
  if (writesBlocked) return { reason: 'store_unwritable' };
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

/** Set while the watcher runs: try the store again later. */
let scheduleRetry: (() => void) | null = null;
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
      if (!await probeStoreWrites()) scheduleRetry?.();
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
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const check = async (): Promise<void> => {
    if (writesBlocked) await probeStoreWrites();
    if (await settlePendingRemovals() || writesBlocked) scheduleRetry?.();
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

  const retry = (): void => {
    if (stopped || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      changed();
    }, STORE_RETRY_MS);
    retryTimer.unref?.();
  };
  scheduleRetry = retry;
  // Removals an earlier session left pending go into the store as soon as it takes them.
  void settlePendingRemovals().then((again) => { if (again) retry(); });

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
        if (pendingRemovals.has(pairKey({ agentId, targetId }))) retry();
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
    if (scheduleRetry === retry) scheduleRetry = null;
    for (const unsubscribe of unsubscribers) unsubscribe();
    if (timer) clearTimeout(timer);
    timer = null;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
  };
}

/** For testing: forget what was seen so far. */
export function _resetDispatcherConnectionsForTesting(): void {
  lastPairs = [];
  lastListed = '';
  lock = Promise.resolve();
  pendingRemovals.clear();
  pendingSaved = true;
  writesProven = false;
  writesBlocked = false;
  scheduleRetry = null;
}
