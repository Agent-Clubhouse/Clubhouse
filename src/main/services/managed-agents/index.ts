/**
 * The app's managed-agents service (#2819) with real dependencies, plus what
 * running agents need: which setup each session started with, whether it has
 * changed since, and restarting so it picks the change up.
 */
import { assetCatalogDir, createAssetCatalogStore } from '../asset-catalog/store';
import * as agentConfig from '../agent-config';
import * as projectStore from '../project-store';
import { broadcastToAllWindows } from '../../util/ipc-broadcast';
import { IPC } from '../../../shared/ipc-channels';
import { appLog } from '../log-service';
import type { OrchestratorProvider } from '../../orchestrators/types';
import type { DurableAgentConfig, McpServerDef } from '../../../shared/types';
import type { ManagedAgentStatus } from '../../../shared/managed-agents-types';
import { createManagedAgentsService, ManagedError, type ManagedAgentsService } from './service';
import { createManagedStateStore, managedStateDir } from './state-store';
import { ensureBuiltinsOnceFor } from './builtins-once';
import { MCP_BACKUP_DIR } from './mcp-backup';
import { keepInstructionsAtFirstStart } from './before-managed';
import * as path from 'path';
import { skillsFolderOf } from '../../../shared/skills-folder';
import {
  deliverManagedSetup,
  EXCLUDES_MANIFEST,
  instructionsExcludePattern,
  mcpServersOf,
  quickManagedLaunch,
  removeManagedClaudeExcludes,
  resolveManagedSetup,
  setupFingerprint,
  type DeliveryRecord,
  type QuickManagedLaunch,
} from './delivery';

let service: ManagedAgentsService | null = null;

function isRunning(agentId: string): boolean {
  // Lazy: agent-system imports this module through the spawn path.
  const agentSystem = require('../agent-system') as typeof import('../agent-system');
  return agentSystem.isAgentRunning(agentId);
}

export function managedAgents(): ManagedAgentsService {
  if (!service) {
    service = createManagedAgentsService({
      catalog: createAssetCatalogStore({ dir: assetCatalogDir() }),
      state: createManagedStateStore(),
      listProjects: async () => (await projectStore.peekProjects()).map((p) => ({ path: p.path, name: p.displayName || p.name })),
      listAgents: (projectPath) => agentConfig.peekDurableConfigs(projectPath),
      getAgent: (projectPath, agentId) => agentConfig.getDurableConfig(projectPath, agentId),
      setManagedSetup: (projectPath, agentId, setup) => agentConfig.setManagedSetup(projectPath, agentId, setup),
      isRunning,
      onChanged: () => broadcastToAllWindows(IPC.MANAGED.CHANGED),
      onUnmanaged: async (_projectPath, agent) => {
        if (!agent.worktreePath) return;
        try {
          // The CLAUDE.md excludes Clubhouse added come out; the person's settings stay (D49).
          await removeManagedClaudeExcludes(agent.worktreePath);
        } catch (err) {
          // telemetry-exempt: the agent is already unmanaged; the entries only turn off parent CLAUDE.md files.
          appLog('core:managed', 'warn', 'Could not remove the CLAUDE.md excludes Clubhouse added', { meta: { agentId: agent.id, error: err instanceof Error ? err.message : String(err) } });
        }
      },
    });
  }
  return service;
}

/**
 * Install or update the app service's built-in parts once per app run.
 * Startup, the automatic switch to managed (D59) and helper starts share it;
 * a failure lets the next caller try again.
 */
export function ensureBuiltinsOnce(): Promise<void> {
  return ensureBuiltinsOnceFor(managedAgents());
}

/** Tests only. */
export function _setManagedAgentsForTesting(next: ManagedAgentsService | null): void {
  service = next;
}

// ── What each running session started with ─────────────────────────────

const delivered = new Map<string, DeliveryRecord>();
/** Agents whose last delivery failed, with the reason, until a delivery succeeds. */
const failedDeliveries = new Map<string, string>();

/** Spawn path: write the setup into the agent's folder and remember what this session got. */
export async function deliverForSpawn(projectPath: string, agent: DurableAgentConfig, provider: OrchestratorProvider): Promise<void> {
  if (!agent.managed) {
    delivered.delete(agent.id);
    failedDeliveries.delete(agent.id);
    return;
  }
  // Forget the last record first: if this delivery fails, nothing claims the agent is up to date.
  delivered.delete(agent.id);
  let record: DeliveryRecord | null;
  try {
    // A session still on the old files may have changed them after the switch (#2901).
    await keepInstructionsAtFirstStart(agent, provider);
    record = await deliverManagedSetup({
      service: managedAgents(), projectPath, agent, provider,
      backupRoot: path.join(managedStateDir(), 'replaced-skills', agent.id),
    });
  } catch (err) {
    // The session still starts on whatever files are there; statusFor shows the bar with the reason.
    failedDeliveries.set(agent.id, err instanceof Error ? err.message : String(err));
    broadcastToAllWindows(IPC.MANAGED.CHANGED);
    throw err;
  }
  failedDeliveries.delete(agent.id);
  if (record) delivered.set(agent.id, record);
  void excludeManagedFiles(projectPath, agent.worktreePath, provider);
  broadcastToAllWindows(IPC.MANAGED.CHANGED);
  if (record?.missing) {
    broadcastToAllWindows(IPC.AGENT.AGENT_MATERIALIZATION_FAILED, agent.id,
      `${record.missing} part${record.missing === 1 ? '' : 's'} in ${agent.name}'s setup no longer exist${record.missing === 1 ? 's' : ''} and ${record.missing === 1 ? 'was' : 'were'} skipped. Open its builder to fix the setup.`);
  }
}

/**
 * Keep Clubhouse's managed files out of commits, as Clubhouse Mode's own
 * exclude block did. That block stays where it was written, but nothing adds
 * one any more (#2901), so the instructions file is listed here too, anchored
 * to the root and only when the agent's worktree doesn't track it. A file the
 * project tracks shows as modified either way (D16). The block is rewritten
 * each time, so it lists exactly what this start excludes.
 */
async function excludeManagedFiles(projectPath: string, worktreePath: string | undefined, provider: OrchestratorProvider): Promise<void> {
  try {
    const conv = provider.conventions;
    const instructions = worktreePath ? await instructionsExcludePattern(worktreePath, provider) : null;
    const gitExclude = await import('../git-exclude-manager');
    await gitExclude.replaceExclusions(projectPath, `clubhouse-managed-${provider.id}`, [
      ...(instructions ? [instructions] : []),
      conv.mcpConfigFile,
      `${skillsFolderOf(conv)}/`,
      // Where Claude Code's claudeMdExcludes go (D49).
      ...(provider.id === 'claude-code' ? [`${conv.configDir}/${conv.localSettingsFile || 'settings.local.json'}`] : []),
      // Which of those excludes Clubhouse added, so it replaces only its own.
      EXCLUDES_MANIFEST,
      `${MCP_BACKUP_DIR}/`,
    ]);
  } catch (err) {
    // telemetry-exempt: not a git project, or the exclude file is read-only; delivery already succeeded.
    appLog('core:managed', 'warn', 'Could not add managed files to git excludes', { meta: { error: err instanceof Error ? err.message : String(err) } });
  }
}

/**
 * Spawn path for a quick agent started from a template (#2893, D25). Reads the
 * template and writes nothing. What can't reach the agent is logged: skills
 * always (its folder isn't its own), MCP servers on a CLI with no launch flag
 * for them (Claude Code reads them only from the folder's MCP file).
 */
export async function quickLaunchFor(
  projectPath: string,
  cwd: string,
  agentId: string,
  template: { id: string; agentName: string },
  provider: OrchestratorProvider,
): Promise<QuickManagedLaunch> {
  const { getCurrentBranch } = await import('../git-service');
  const branch = await getCurrentBranch(cwd).catch((): null => null);
  const launch = await quickManagedLaunch({
    service: managedAgents(), projectPath, cwd, agentId, agentName: template.agentName, templateId: template.id, branch,
  });
  const serversLeftOut = provider.buildMcpArgs ? 0 : Object.keys(launch.servers).length;
  if (launch.skippedSkills > 0 || serversLeftOut > 0 || launch.missing > 0) {
    appLog('core:managed', 'warn', 'Quick agent template: some parts were not delivered', {
      meta: { agentId, templateId: template.id, skills: launch.skippedSkills, mcpServers: serversLeftOut, missing: launch.missing, orchestrator: provider.id },
    });
  }
  return provider.buildMcpArgs ? launch : { ...launch, servers: {} };
}

export async function managedMcpServersFor(agent: DurableAgentConfig): Promise<Record<string, McpServerDef>> {
  if (!agent.managed) return {};
  return mcpServersOf(await resolveManagedSetup(managedAgents(), agent.managed));
}

export async function statusFor(projectPath: string, agentId: string): Promise<ManagedAgentStatus> {
  const agent = await agentConfig.getDurableConfig(projectPath, agentId);
  const running = (await import('../agent-system')).isAgentRunning(agentId);
  if (!agent?.managed) {
    // The switch offer says why an automatic switch didn't happen (D59).
    const migrationFailed = agent?.managedMigrationFailure?.message;
    return { managed: false, running, waiting: false, changes: [], cliChanged: false, ...(migrationFailed && { migrationFailed }) };
  }
  const notice = agent.managedMigration && !agent.managedMigration.dismissed
    ? { migrated: { from: agent.managedMigration.from, backup: agent.managedMigration.backup } }
    : {};
  const failed = failedDeliveries.get(agentId);
  if (running && failed) {
    return { managed: true, running, waiting: true, changes: [`Setup couldn't be written: ${failed}`], cliChanged: false, deliveryFailed: failed, ...notice };
  }
  const record = delivered.get(agentId);
  if (!running || !record) return { managed: true, running, waiting: false, changes: [], cliChanged: false, ...notice };
  const resolved = await resolveManagedSetup(managedAgents(), agent.managed);
  const now = setupFingerprint(agent, resolved);
  if (now.fingerprint === record.fingerprint) {
    return { managed: true, running, waiting: false, changes: [], deliveredAt: record.deliveredAt, cliChanged: false, ...notice };
  }
  const changes: string[] = [];
  for (const [id, part] of Object.entries(now.parts)) {
    const before = record.parts[id];
    if (!before) changes.push(`${part.name} was added`);
    else if (before.revision !== part.revision) changes.push(`${part.name} was edited`);
  }
  for (const [id, part] of Object.entries(record.parts)) {
    if (!now.parts[id]) changes.push(`${part.name} was removed`);
  }
  if (changes.length === 0 && now.order.join('|') !== record.order.join('|')) changes.push('The block order changed');
  const cliChanged = (record.orchestrator ?? '') !== (agent.orchestrator ?? '');
  if (changes.length === 0) changes.push(cliChanged ? 'The CLI changed' : 'Its settings changed');
  return { managed: true, running, waiting: true, changes, deliveredAt: record.deliveredAt, cliChanged, ...notice };
}

/** The person dismissed the "Switched to managed when Clubhouse updated" notice. The marker stays (D59). */
export async function dismissMigrationNotice(projectPath: string, agentId: string): Promise<void> {
  await agentConfig.setManagedMigration(projectPath, agentId, { dismissed: true });
  broadcastToAllWindows(IPC.MANAGED.CHANGED);
}

export function forgetDelivery(agentId: string): void {
  delivered.delete(agentId);
  failedDeliveries.delete(agentId);
}

// ── Restart ────────────────────────────────────────────────────────────

const restarting = new Set<string>();

async function waitForTurnEnd(agentId: string, timeoutMs = 30 * 60_000): Promise<boolean> {
  const { getAgentRuntime } = await import('../agent-runtime');
  const { BUSY_STATES } = await import('../agent-runtime/checkpoint-tracker');
  const ptyManager = await import('../pty-manager');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isRunning(agentId)) return false;
    const runtime = getAgentRuntime(agentId);
    const busy = runtime?.kind === 'chat'
      ? BUSY_STATES.has(runtime.getState())
      : (() => { const last = ptyManager.getLastActivity(agentId); return last !== null && Date.now() - last < 5000; })();
    if (!busy) return true;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return false;
}

/** Whether the agent is mid-turn now, as the app-update restart judges it. */
export async function isAgentWorking(agentId: string): Promise<boolean> {
  const { getLiveAgentsForUpdate } = await import('../restart-session-service');
  return getLiveAgentsForUpdate().some((a) => a.agentId === agentId && a.isWorking);
}

/**
 * Stop the agent and start it again on its current setup. It resumes the same
 * conversation unless `fresh`, or unless the CLI changed (a session can't move
 * between CLIs). With `whenTurnEnds`, waits for the current turn first.
 *
 * Only a running managed agent: a sleeping one picks its setup up at its next
 * start, and starting it here would wake it outside the wake rules.
 */
export async function restartManagedAgent(projectPath: string, agentId: string, options: { fresh?: boolean; whenTurnEnds?: boolean } = {}): Promise<{ resumed: boolean; noSession?: boolean }> {
  const target = await agentConfig.getDurableConfig(projectPath, agentId);
  if (!target) throw new ManagedError('not_found', 'agent not found');
  if (!target.managed) throw new ManagedError('not_managed', `${target.name} isn't Clubhouse managed, so there is no setup to restart into.`);
  const agentSystem = await import('../agent-system');
  if (!agentSystem.isAgentRunning(agentId)) throw new ManagedError('invalid', `${target.name} isn't running. It gets its setup when it next starts.`);
  if (restarting.has(agentId)) throw new Error('already restarting');
  restarting.add(agentId);
  try {
    if (options.whenTurnEnds && !(await waitForTurnEnd(agentId))) {
      // Stopped by someone else, or still working after the wait: don't restart behind their back.
      throw new Error(isRunning(agentId) ? 'The agent is still working. Try Restart again later.' : 'The agent stopped before its turn ended.');
    }
    const before = await agentConfig.getDurableConfig(projectPath, agentId);
    if (!before) throw new Error('agent not found');
    if (agentSystem.isAgentRunning(agentId)) {
      await agentSystem.killAgent(agentId, projectPath, before.orchestrator, 'user', { waitForExit: true });
    }
    // Read after the exit: it just saved the session id this restart resumes.
    const agent = await agentConfig.getDurableConfig(projectPath, agentId);
    if (!agent) throw new Error('agent not found');
    const record = delivered.get(agentId);
    const cliChanged = !!record && (record.orchestrator ?? '') !== (agent.orchestrator ?? '');
    const resume = !options.fresh && !cliChanged && !!agent.lastSessionId;
    broadcastToAllWindows(IPC.AGENT.AGENT_WAKING, agentId);
    try {
      await agentSystem.spawnAgent({
        agentId,
        projectPath,
        cwd: agent.worktreePath || projectPath,
        kind: 'durable',
        model: agent.model,
        orchestrator: agent.orchestrator,
        freeAgentMode: agent.freeAgentMode,
        resume,
        sessionId: resume ? agent.lastSessionId : undefined,
      });
    } catch (err) {
      broadcastToAllWindows(IPC.AGENT.AGENT_WAKE_FAILED, agentId, err instanceof Error ? err.message : String(err));
      throw err;
    }
    // Neither asked for nor forced by a CLI change: there was no conversation to resume.
    const noSession = !resume && !options.fresh && !cliChanged;
    appLog('core:managed', 'info', 'Restarted managed agent', { meta: { agentId, resume, noSession } });
    return { resumed: resume, ...(noSession && { noSession: true }) };
  } finally {
    restarting.delete(agentId);
  }
}
