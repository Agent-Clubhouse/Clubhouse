/**
 * Disposed helpers whose orchestrator is gone (#3186). A disposed helper's row
 * is kept for its orchestrator's Helpers card, and nothing else reads it: once
 * the orchestrator is deleted the row only fills the "Disposed helpers without
 * an orchestrator" list in Settings. So when an orchestrator is deleted its
 * disposed helpers are removed too, in every project, and a one-time pass
 * removes the ones left behind before this.
 *
 * Both only act on what they can see. A project that can't be read, or a
 * parent project that isn't registered, counts as still holding the
 * orchestrator, and those rows stay for Settings' Remove and Clear all.
 */

import * as fsp from 'fs/promises';
import * as path from 'path';
import { app } from 'electron';
import { isDisposedAgent } from '../../shared/agent-helpers';
import type { DeleteResult, DurableAgentConfig } from '../../shared/types';
import * as agentConfig from './agent-config';
import { onAppEvent } from './app-event-bus';
import { appLog } from './log-service';
import * as projectStore from './project-store';

/** Records that the one-time pass finished, so it doesn't run again. */
const DONE_FILE = 'disposed-helpers-cleaned.json';

interface ProjectRows {
  projectPath: string;
  key: string;
  readable: boolean;
  agents: readonly DurableAgentConfig[];
}

async function readProjects(extra: string[] = []): Promise<ProjectRows[]> {
  let registered: string[] = [];
  try {
    registered = (await projectStore.list()).map((p) => p.path);
  } catch (err) {
    // telemetry-exempt: logged; only the projects already named are read.
    appLog('core:agent-config', 'warn', 'Disposed helper cleanup could not list projects', {
      meta: { error: err instanceof Error ? err.message : String(err) },
    });
  }
  const seen = new Set<string>();
  const rows: ProjectRows[] = [];
  for (const projectPath of [...extra, ...registered]) {
    const key = await agentConfig.projectKey(projectPath);
    if (seen.has(key)) continue;
    seen.add(key);
    const { agents, readable } = await agentConfig.peekDurableConfigsChecked(projectPath);
    rows.push({ projectPath, key, readable, agents });
  }
  return rows;
}

/** The key of the project a helper's parent is in. */
async function parentKey(row: ProjectRows, config: DurableAgentConfig): Promise<string> {
  return config.parentProjectPath ? agentConfig.projectKey(config.parentProjectPath) : row.key;
}

async function removeRow(projectPath: string, config: DurableAgentConfig, why: string): Promise<boolean> {
  try {
    const result: DeleteResult = await agentConfig.deleteUnregister(projectPath, config.id);
    if (result.ok) return true;
    appLog('core:agent-config', 'warn', 'Could not remove a disposed helper', { meta: { projectPath, agentId: config.id, why, message: result.message } });
  } catch (err) {
    // telemetry-exempt: logged; the row stays in Settings for Remove.
    appLog('core:agent-config', 'warn', 'Could not remove a disposed helper', {
      meta: { projectPath, agentId: config.id, why, error: err instanceof Error ? err.message : String(err) },
    });
  }
  return false;
}

/**
 * Remove the disposed helpers of `orchestratorId`, an agent of `projectPath`
 * that is gone, and theirs in turn. Does nothing while the orchestrator's row
 * is still there (a disposed orchestrator keeps its card) or its project can't
 * be read. Returns how many rows were removed.
 */
export async function removeDisposedHelpersOf(projectPath: string, orchestratorId: string): Promise<number> {
  try {
    return await removeDisposedHelpersOfInner(projectPath, orchestratorId);
  } catch (err) {
    // telemetry-exempt: logged; the rows stay in Settings for Remove and Clear all.
    appLog('core:agent-config', 'warn', 'Disposed helper cleanup failed', { meta: { projectPath, orchestratorId, error: err instanceof Error ? err.message : String(err) } });
    return 0;
  }
}

async function removeDisposedHelpersOfInner(projectPath: string, orchestratorId: string): Promise<number> {
  const home = await agentConfig.peekDurableConfigsChecked(projectPath);
  if (!home.readable || home.agents.some((a) => a.id === orchestratorId)) return 0;
  let removed = 0;
  const queue: Array<{ key: string; id: string }> = [{ key: await agentConfig.projectKey(projectPath), id: orchestratorId }];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const parent = queue.shift()!;
    const tag = `${parent.key}\0${parent.id}`;
    if (seen.has(tag)) continue;
    seen.add(tag);
    for (const row of await readProjects([projectPath])) {
      if (!row.readable) continue;
      for (const config of row.agents) {
        if (!isDisposedAgent(config) || config.parentAgentId !== parent.id) continue;
        if (await parentKey(row, config) !== parent.key) continue;
        if (await removeRow(row.projectPath, config, 'orchestrator_deleted')) {
          removed++;
          queue.push({ key: row.key, id: config.id });
        }
      }
    }
  }
  if (removed > 0) appLog('core:agent-config', 'info', 'Removed disposed helpers of a deleted orchestrator', { meta: { projectPath, orchestratorId, removed } });
  return removed;
}

/**
 * Remove every disposed helper whose orchestrator is gone, as far as can be
 * told: no parent at all, or a parent missing from its registered, readable
 * project. Repeats until none is left, for helpers of a removed helper.
 * `complete` is false when a project couldn't be read.
 */
export async function removeOrphanedDisposedHelpers(): Promise<{ removed: number; complete: boolean }> {
  let removed = 0;
  let complete = true;
  for (;;) {
    const rows = await readProjects();
    complete = rows.every((r) => r.readable);
    const byKey = new Map(rows.map((r) => [r.key, r]));
    let removedThisPass = 0;
    for (const row of rows) {
      if (!row.readable) continue;
      for (const config of row.agents) {
        if (!isDisposedAgent(config)) continue;
        if (config.parentAgentId) {
          const parentProject = byKey.get(await parentKey(row, config));
          if (!parentProject || !parentProject.readable) continue;
          if (parentProject.agents.some((a) => a.id === config.parentAgentId)) continue;
        }
        if (await removeRow(row.projectPath, config, 'orphaned')) removedThisPass++;
      }
    }
    removed += removedThisPass;
    if (removedThisPass === 0) return { removed, complete };
  }
}

/** Once per install: the pass above, recorded only when every project could be read. */
export async function removeOrphanedDisposedHelpersOnce(): Promise<void> {
  const done = path.join(app.getPath('userData'), DONE_FILE);
  try {
    await fsp.access(done);
    return;
  } catch {
    // telemetry-exempt: no record means the pass hasn't run.
  }
  const { removed, complete } = await removeOrphanedDisposedHelpers();
  appLog('core:agent-config', 'info', 'Cleaned up disposed helpers without an orchestrator', { meta: { removed, complete } });
  if (complete) await fsp.writeFile(done, JSON.stringify({ cleanedAt: new Date().toISOString() }), 'utf-8');
}

let stop: (() => void) | null = null;

/** Remove a deleted orchestrator's disposed helpers from here on. `agent.deleted` also fires for a helper being disposed; its row is still there, so nothing happens. */
export function startDisposedHelperCleanup(): () => void {
  if (stop) return stop;
  // One at a time, so two deletions can't remove the same row twice.
  let chain: Promise<unknown> = Promise.resolve();
  const unsubscribe = onAppEvent((event) => {
    if (event.type !== 'agent.deleted') return;
    chain = chain.then(() => removeDisposedHelpersOf(event.projectPath, event.agentId));
  });
  stop = () => { unsubscribe(); stop = null; };
  return stop;
}
