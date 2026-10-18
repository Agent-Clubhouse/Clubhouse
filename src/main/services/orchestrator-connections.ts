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
 * removed by it. Entries whose agents were disposed or deleted are dropped
 * from the store when the project's agents change
 * ({@link watchOrchestratorConnections}).
 */

import * as fsp from 'fs/promises';
import * as path from 'path';
import * as projectStore from './project-store';
import { listDurable, onAgentConfigChanged } from './agent-config';
import { groupProjectRegistry } from './group-project-registry';
import type { CollectedBindings, PersistedBinding, PersistedBindingSource } from './persisted-bindings';
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
}

interface StoreFile {
  version: 1;
  connections: OrchestratorConnection[];
}

export function connectionsStorePath(projectPath: string): string {
  return path.join(projectPath, '.clubhouse', '.local', 'orchestrator-connections.json');
}

function isConnection(value: unknown): value is OrchestratorConnection {
  if (!value || typeof value !== 'object') return false;
  const c = value as Record<string, unknown>;
  return typeof c.ownerId === 'string' && typeof c.agentId === 'string' && typeof c.targetId === 'string'
    && (c.targetKind === 'agent' || c.targetKind === 'group-project');
}

/** The project's connections; empty when it has none. Throws when the file can't be read or parsed. */
export async function readConnections(projectPath: string): Promise<OrchestratorConnection[]> {
  let raw: string;
  try {
    raw = await fsp.readFile(connectionsStorePath(projectPath), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const data = JSON.parse(raw) as Partial<StoreFile>;
  if (!data || !Array.isArray(data.connections)) throw new Error('Orchestrator connections file is malformed');
  return data.connections.filter(isConnection);
}

async function writeConnections(projectPath: string, connections: OrchestratorConnection[]): Promise<void> {
  const file = connectionsStorePath(projectPath);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const data: StoreFile = { version: 1, connections };
  await fsp.writeFile(file, JSON.stringify(data, null, 2), 'utf-8');
}

/** One read-modify-write at a time per project. */
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

const sameConnection = (a: Pick<OrchestratorConnection, 'agentId' | 'targetId'>, b: Pick<OrchestratorConnection, 'agentId' | 'targetId'>) =>
  a.agentId === b.agentId && a.targetId === b.targetId;

/** Add connections the store doesn't have yet. Returns the ones added. */
export function addConnections(projectPath: string, entries: OrchestratorConnection[]): Promise<OrchestratorConnection[]> {
  return withStoreLock(projectPath, async () => {
    const current = await readConnections(projectPath);
    const added = entries.filter((e, i) =>
      !current.some((c) => sameConnection(c, e)) && entries.findIndex((o) => sameConnection(o, e)) === i);
    if (added.length > 0) await writeConnections(projectPath, [...current, ...added]);
    return added;
  });
}

/** Remove the connections `match` selects. Returns the ones removed. */
export function removeConnections(
  projectPath: string,
  match: (c: OrchestratorConnection) => boolean,
): Promise<OrchestratorConnection[]> {
  return withStoreLock(projectPath, async () => {
    const current = await readConnections(projectPath);
    const removed = current.filter(match);
    if (removed.length > 0) await writeConnections(projectPath, current.filter((c) => !match(c)));
    return removed;
  });
}

/**
 * The bindings for a project's stored connections. Drops entries whose agents
 * are gone or disposed, and memberships of group projects that no longer
 * exist (`groupProjects`: id → name; null when the registry can't be read,
 * which keeps them).
 */
export function bindingsFromConnections(
  connections: readonly OrchestratorConnection[],
  agents: readonly DurableAgentConfig[],
  groupProjects: ReadonlyMap<string, string> | null,
  projectName?: string,
): PersistedBinding[] {
  const live = new Map(agents.filter((a) => !isDisposedAgent(a)).map((a) => [a.id, a]));
  const out: PersistedBinding[] = [];
  const seen = new Set<string>();
  for (const c of connections) {
    const from = live.get(c.agentId);
    if (!from || c.agentId === c.targetId) continue;
    const pair = `${c.agentId}\u0000${c.targetId}`;
    if (seen.has(pair)) continue;
    if (c.targetKind === 'agent') {
      const to = live.get(c.targetId);
      if (!to) continue;
      seen.add(pair);
      out.push({
        agentId: from.id, targetId: to.id, targetKind: 'agent', label: to.name,
        agentName: from.name, targetName: to.name, ...(projectName ? { projectName } : {}),
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
  return out;
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
      let projectBindings: PersistedBinding[];
      try {
        const connections = await readConnections(project.path);
        projectBindings = connections.length === 0
          ? []
          : bindingsFromConnections(connections, await listDurable(project.path), groupProjects, project.displayName || project.name);
      } catch (err) {
        // telemetry-exempt: logged; the project's connections are kept unverified until a read succeeds
        appLog('core:mcp', 'warn', 'Could not read orchestrator connections; keeping that project\'s connections as they are', {
          meta: { projectPath: project.path, error: err instanceof Error ? err.message : String(err) },
        });
        unverified.push(...(lastPairs.get(project.path) ?? []));
        continue;
      }
      lastPairs.set(project.path, projectBindings.map((b) => ({ agentId: b.agentId, targetId: b.targetId })));
      bindings.push(...projectBindings);
    }
    return { bindings, unverified };
  },
};

/**
 * Drop the stored connections of agents that were disposed or deleted. An
 * empty agent list deletes nothing: it is more likely a failed read than a
 * project whose every agent is gone. Returns the connections removed.
 */
export async function pruneConnectionsOfGoneAgents(projectPath: string): Promise<OrchestratorConnection[]> {
  const agents = await listDurable(projectPath);
  if (agents.length === 0) return [];
  const live = new Set(agents.filter((a) => !isDisposedAgent(a)).map((a) => a.id));
  const gone = (id: string) => !live.has(id);
  return removeConnections(projectPath, (c) => gone(c.agentId) || (c.targetKind === 'agent' && gone(c.targetId)));
}

/**
 * When a project's agents change, drop the connections of helpers that were
 * disposed or deleted and call `onConnectionsChanged` (a rebuild, which
 * prunes their bindings). Returns an unsubscribe function.
 */
export function watchOrchestratorConnections(onConnectionsChanged: () => unknown): () => void {
  const dirty = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const check = async (): Promise<void> => {
    const paths = [...dirty];
    dirty.clear();
    let changed = false;
    for (const projectPath of paths) {
      try {
        const removed = await pruneConnectionsOfGoneAgents(projectPath);
        if (removed.length > 0) {
          changed = true;
          appLog('core:mcp', 'info', 'Dropped orchestrator connections of disposed or deleted agents', {
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
  return () => {
    stopped = true;
    unsubscribe();
    if (timer) clearTimeout(timer);
    timer = null;
  };
}

/** For testing: forget the pairs seen so far. */
export function _resetOrchestratorConnectionsForTesting(): void {
  lastPairs.clear();
  locks.clear();
}
