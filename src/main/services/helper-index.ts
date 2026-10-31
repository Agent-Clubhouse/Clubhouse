/**
 * Helpers across projects (#2511).
 *
 * A helper's row lives in the project it was created in. When its parent is
 * in another project the row carries `parentProjectPath`, so finding every
 * helper of an orchestrator means reading every registered project. This
 * module does that once and keeps the result until any agents.json changes
 * (onAgentConfigChanged, or a cache clear: see agentConfigGeneration) or the
 * list of projects does.
 *
 * Only local projects from the project store are read; remote (satellite)
 * and group projects never hold helpers of a local orchestrator.
 */
import type { DurableAgentConfig } from '../../shared/types';
import { isDisposedAgent } from '../../shared/agent-helpers';
import * as agentConfig from './agent-config';
import * as projectStore from './project-store';
import { pathExists } from './fs-utils';
import { appLog } from './log-service';

/** An agent and the project whose agents.json holds it. */
export interface HelperEntry {
  projectPath: string;
  config: DurableAgentConfig;
}

export interface ListHelpersEverywhereOptions {
  /** Include disposed helpers (direct helpers only, like listHelpers). */
  includeDisposed?: boolean;
  /** Every live helper below the orchestrator, helpers of helpers too, nearest first. */
  recursive?: boolean;
}

interface IndexedAgent extends HelperEntry {
  /** projectKey of the project holding the row. */
  key: string;
  /** projectKey of the project the parent is in; unset for a top-level agent. */
  parentKey?: string;
}

interface Snapshot {
  /** agentConfigGeneration when the build started. */
  generation: number;
  /** The project paths read, in order, joined by NUL. */
  paths: string;
  rows: IndexedAgent[];
}

let snapshot: Snapshot | null = null;

/** Forget the cached index. Any agents.json change does this too. */
export function clearHelperIndexCache(): void {
  snapshot = null;
}

async function projectPaths(homePath: string): Promise<string[]> {
  let registered: string[] = [];
  try {
    registered = (await projectStore.list()).map((p) => p.path);
  } catch (err) {
    // telemetry-exempt: logged; the home project is still read.
    appLog('core:agent-config', 'warn', 'Helper index could not list projects', {
      meta: { error: err instanceof Error ? err.message : String(err) },
    });
  }
  return [homePath, ...registered];
}

async function buildIndex(projectPathsInOrder: string[]): Promise<IndexedAgent[]> {
  const homePath = projectPathsInOrder[0];
  const seen = new Set<string>();
  const keyCache = new Map<string, Promise<string>>();
  const keyOf = (p: string) => {
    let key = keyCache.get(p);
    if (!key) {
      key = agentConfig.projectKey(p);
      keyCache.set(p, key);
    }
    return key;
  };
  const result: IndexedAgent[] = [];
  for (const projectPath of projectPathsInOrder) {
    const key = await keyOf(projectPath);
    if (seen.has(key)) continue;
    seen.add(key);
    // A registered project whose folder is gone holds no agents; don't load it.
    if (projectPath !== homePath && !await pathExists(projectPath)) continue;
    let agents: DurableAgentConfig[];
    try {
      agents = await agentConfig.listDurable(projectPath);
    } catch (err) {
      // telemetry-exempt: logged; one unreadable project doesn't hide the others' helpers.
      appLog('core:agent-config', 'warn', 'Helper index could not read a project', {
        meta: { projectPath, error: err instanceof Error ? err.message : String(err) },
      });
      continue;
    }
    for (const config of agents) {
      const parentKey = !config.parentAgentId
        ? undefined
        : config.parentProjectPath ? await keyOf(config.parentProjectPath) : key;
      result.push({ projectPath, config, key, parentKey });
    }
  }
  return result;
}

/**
 * Every agent in every local project, home project first. Reused while no
 * agents.json changed and the projects to read are the same.
 */
async function indexFor(homePath: string): Promise<IndexedAgent[]> {
  const paths = await projectPaths(homePath);
  const signature = paths.join('\0');
  const generation = agentConfig.agentConfigGeneration();
  if (snapshot && snapshot.generation === generation && snapshot.paths === signature) return snapshot.rows;
  const rows = await buildIndex(paths);
  // A change while the build ran leaves it unsaved, so the next call reads again.
  if (agentConfig.agentConfigGeneration() === generation) snapshot = { generation, paths: signature, rows };
  return rows;
}

/**
 * The helpers of `orchestratorId` (an agent in `homePath`) in every local
 * project: direct ones, or every live helper below it with `recursive`.
 * Home project first, then the project store's order; rows keep their file
 * order. Disposed helpers only with `includeDisposed` (never recursive).
 */
export async function listHelpersEverywhere(
  homePath: string,
  orchestratorId: string,
  options: ListHelpersEverywhereOptions = {},
): Promise<HelperEntry[]> {
  const homeKey = await agentConfig.projectKey(homePath);
  const index = await indexFor(homePath);
  const isChildOf = (row: IndexedAgent, parentKey: string, parentId: string) =>
    row.config.parentAgentId === parentId && row.parentKey === parentKey;
  const entry = ({ projectPath, config }: IndexedAgent): HelperEntry => ({ projectPath, config });

  if (!options.recursive) {
    return index
      .filter((row) => isChildOf(row, homeKey, orchestratorId) && (options.includeDisposed || !isDisposedAgent(row.config)))
      .map(entry);
  }
  const result: HelperEntry[] = [];
  const seen = new Set<string>([`${homeKey}\0${orchestratorId}`]);
  const queue: Array<{ key: string; id: string }> = [{ key: homeKey, id: orchestratorId }];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const row of index) {
      const self = `${row.key}\0${row.config.id}`;
      if (!isChildOf(row, parent.key, parent.id) || seen.has(self)) continue;
      seen.add(self);
      queue.push({ key: row.key, id: row.config.id });
      if (!isDisposedAgent(row.config)) result.push(entry(row));
    }
  }
  return result;
}

/**
 * A helper's parent and the project it is in, or null for a top-level agent
 * or a parent that can't be found (deleted, or its project removed or moved).
 * Uses `parentProjectPath` when it is set, otherwise the helper's own project.
 */
export async function findParent(helperPath: string, helperConfig: DurableAgentConfig): Promise<HelperEntry | null> {
  const parentId = helperConfig.parentAgentId;
  if (!parentId) return null;
  const parentPath = helperConfig.parentProjectPath || helperPath;
  if (parentPath !== helperPath && !await pathExists(parentPath)) return null;
  const config = await agentConfig.getDurableConfig(parentPath, parentId);
  return config ? { projectPath: parentPath, config } : null;
}
