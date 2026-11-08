/**
 * Clubhouse's git excludes for managed agents (D73, D76, D97).
 * `.git/info/exclude` is read from the repository's common git dir, so every
 * pattern here applies to the main checkout and every worktree. Each CLI has
 * one block, `clubhouse-managed-<cli>`, that lists:
 * - each skill folder Clubhouse delivered and the skills manifest (D73),
 * - its own bookkeeping files (D49, D54),
 * - the root files it delivers for that CLI (the instructions file, the MCP
 *   file, Claude Code's `.claude/settings.local.json`), while any managed
 *   agent in the project runs that CLI (D97).
 */
import * as fs from 'fs';
import * as path from 'path';
import * as agentConfig from '../agent-config';
import * as gitExclude from '../git-exclude-manager';
import { appLog } from '../log-service';
import { getAllProviders } from '../../orchestrators/registry';
import type { OrchestratorProvider } from '../../orchestrators/types';
import type { DurableAgentConfig } from '../../../shared/types';
import { EXCLUDES_MANIFEST, managedSkillExcludes, rootFileCandidates, rootFileExcludes } from './delivery';
import { MCP_BACKUP_DIR } from './mcp-backup';

export const managedExcludeTag = (cliId: string) => `clubhouse-managed-${cliId}`;

/** Names only Clubhouse writes: which claudeMdExcludes it added (D49), and the MCP file it kept aside (D54). */
const BOOKKEEPING = [`/${EXCLUDES_MANIFEST}`, `/${MCP_BACKUP_DIR}/`];

export interface ManagedExcludeDeps {
  listAgents(projectPath: string): Promise<readonly DurableAgentConfig[]>;
  /** The CLI the agent runs: its own, else the project's, else the app default. Null when it can't be told. */
  cliOf(projectPath: string, agent: DurableAgentConfig): Promise<string | null>;
  providers(): OrchestratorProvider[];
  /** After a refresh finishes, so the project's settings page shows the names as written. */
  onRefreshed?(projectPath: string): void;
}

const defaultDeps: ManagedExcludeDeps = {
  listAgents: (projectPath) => agentConfig.peekDurableConfigs(projectPath),
  cliOf: async (projectPath, agent) => {
    // Lazy: agent-registry imports the spawn path, which imports this module.
    const { resolveOrchestrator } = await import('../agent-registry');
    return resolveOrchestrator(projectPath, agent.orchestrator).then((p) => p.id, (): null => null);
  },
  providers: () => getAllProviders(),
  onRefreshed: () => {
    // Lazy: the broadcast reaches every window, which tests and the startup path don't have yet.
    void Promise.all([import('../../util/ipc-broadcast'), import('../../../shared/ipc-channels')])
      .then(([{ broadcastToAllWindows }, { IPC }]) => broadcastToAllWindows(IPC.MANAGED.CHANGED))
      .catch(() => { /* telemetry-exempt: a refresh signal only; the page reloads on its next visit */ });
  },
};

/**
 * Rewrite every CLI's managed block for the project from its managed agents
 * as they are now. A CLI that no managed agent runs any more loses its root
 * files and keeps the rest of its block, since the skill folders and
 * bookkeeping files it lists can still be in those worktrees. Writes nothing
 * outside a git checkout.
 */
export async function refreshManagedExcludes(projectPath: string, deps: ManagedExcludeDeps = defaultDeps): Promise<void> {
  if (!fs.existsSync(path.join(projectPath, '.git'))) return;
  const agents = (await deps.listAgents(projectPath)).filter((a) => a.managed && a.worktreePath);
  const worktrees = agents.map((a) => a.worktreePath!);
  const byCli = new Map<string, string[]>();
  for (const agent of agents) {
    const cli = await deps.cliOf(projectPath, agent);
    if (cli) byCli.set(cli, [...(byCli.get(cli) ?? []), agent.worktreePath!]);
  }
  for (const provider of deps.providers()) {
    const tag = managedExcludeTag(provider.id);
    const own = byCli.get(provider.id) ?? [];
    if (own.length === 0) {
      await gitExclude.removePatterns(projectPath, tag, rootFileCandidates(provider).map((r) => `/${r}`));
      continue;
    }
    const root = new Set<string>();
    for (const worktree of own) for (const p of await rootFileExcludes(worktree, provider)) root.add(p);
    await gitExclude.replaceExclusions(projectPath, tag, [
      ...(await managedSkillExcludes(worktrees, provider)),
      ...BOOKKEEPING,
      ...[...root].sort(),
    ]);
  }
  if (agents.length > 0) {
    // Blocks nothing writes any more, in the old `<pattern> # <tag>` form git never matched: Clubhouse
    // Mode's (retired in #2901) and the kept MCP file's own tag, now in the CLI's block (D76).
    await gitExclude.removeExclusions(projectPath, 'clubhouse-mode');
    await gitExclude.removeExclusions(projectPath, 'clubhouse-managed-backup');
  }
}

/**
 * The root-file names git ignores for the whole repository because of
 * managed agents, read from the blocks as written, for the project's
 * settings page (D97).
 */
export async function managedRootExcludesInEffect(projectPath: string, providers: OrchestratorProvider[] = getAllProviders()): Promise<string[]> {
  const out = new Set<string>();
  for (const provider of providers) {
    const candidates = new Set(rootFileCandidates(provider).map((r) => `/${r}`));
    for (const p of await gitExclude.listExclusions(projectPath, managedExcludeTag(provider.id))) {
      if (candidates.has(p)) out.add(p);
    }
  }
  return [...out].sort();
}

const queues = new Map<string, Promise<void>>();

/** One refresh per project at a time; a call while one runs waits for it, then runs again. */
export function queueManagedExcludes(projectPath: string, deps: ManagedExcludeDeps = defaultDeps): Promise<void> {
  const previous = queues.get(projectPath) ?? Promise.resolve();
  const run = () => refreshManagedExcludes(projectPath, deps).then(() => deps.onRefreshed?.(projectPath)).catch((err) => {
    // telemetry-exempt: not a git project, or the exclude file is read-only; the agents work either way.
    appLog('core:managed', 'warn', 'Could not update managed files in git excludes', { meta: { error: err instanceof Error ? err.message : String(err) } });
  });
  const current = previous.then(run, run);
  queues.set(projectPath, current);
  return current.finally(() => { if (queues.get(projectPath) === current) queues.delete(projectPath); });
}

/** Which managed agents a project has, and on which CLI, as a change key. */
function managedKey(agents: readonly DurableAgentConfig[]): string {
  return agents.filter((a) => a.managed && a.worktreePath).map((a) => `${a.id}:${a.orchestrator ?? ''}`).sort().join('|');
}

/**
 * Refresh a project's blocks when its managed agents change: one is
 * unmanaged, deleted, made, or moves to another CLI. That is when a CLI's root
 * files come out, once no managed agent needs them. Every start refreshes
 * them too. Returns the unsubscribe.
 */
export function watchManagedExcludes(deps: ManagedExcludeDeps = defaultDeps): () => void {
  const seen = new Map<string, string>();
  return agentConfig.onAgentConfigChanged((projectPath) => {
    void deps.listAgents(projectPath).then((agents) => {
      const key = managedKey(agents);
      if (seen.get(projectPath) === key) return;
      seen.set(projectPath, key);
      return queueManagedExcludes(projectPath, deps);
    }).catch((err) => {
      // telemetry-exempt: logged; the next start refreshes the blocks.
      appLog('core:managed', 'warn', 'Could not read a project\'s agents for git excludes', { meta: { error: err instanceof Error ? err.message : String(err) } });
    });
  });
}
