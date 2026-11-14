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
import type { DurableAgentConfig, McpServerDef, QuickTemplateChoice } from '../../../shared/types';
import { PREPARE_HANDOFF_SKILL_ID } from '../../../shared/managed-agents-types';
import { agentHoldsAction } from '../agent-grants-service';
import type { ManagedAgentSetup, ManagedAgentStatus, ManagedMcpProblem, ManagedPlainChoice, ManagedPlainPreview, ManagedRunningSnapshot } from '../../../shared/managed-agents-types';
import { createManagedAgentsService, ManagedError, type ManagedAgentsService } from './service';
import { createManagedStateStore, managedStateDir } from './state-store';
import { ensureBuiltinsOnceFor } from './builtins-once';
import { queueManagedExcludes } from './git-excludes';
import { keepInstructionsAtFirstStart } from './before-managed';
import { previewSwitchToPlain, switchToPlain, type PlainDeps } from './plain';
import * as path from 'path';
import { delivered, failedDeliveries, forgetDelivery, mcpProblems } from './delivery-records';
import { managedActivationFor, partRevisions } from './activation';
import { restartWithReceipt } from './activation-receipts';
import { withAgentTransition } from '../agent-transition';
import type { AgentRuntime } from '../../../shared/chat';
import { agentRegistry } from '../agent-registry';
import { getAgentRuntime } from '../agent-runtime';
import { processIdentity } from '../pty-manager';
import { isDeepStrictEqual } from 'node:util';
import {
  deliverManagedSetup,
  managedSettingsRows,
  mcpServersOf,
  quickManagedLaunch,
  removeManagedClaudeExcludes,
  resolveManagedSetup,
  setGrantedSkills,
  setupFingerprint,
  type DeliveryRecord,
  type QuickManagedLaunch,
} from './delivery';

let service: ManagedAgentsService | null = null;

// Built-in skills that follow what an agent may do (#3344): prepare-handoff while it holds handoff.offer.
// Read when an agent's setup resolves, never at import, so the import cycle through agent-config is harmless.
setGrantedSkills((agent) => (agentHoldsAction(agent.id, agent, 'handoff.offer') ? [PREPARE_HANDOFF_SKILL_ID] : []));

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
      listProjects: async () => (await projectStore.peekProjects()).map((p) => ({ id: p.id, path: p.path, name: p.displayName || p.name })),
      listAgents: (projectPath) => agentConfig.peekDurableConfigs(projectPath),
      listProjectsChecked: async () => {
        const { projects, readable } = await projectStore.peekProjectsChecked();
        return { projects: projects.map((p) => ({ path: p.path, name: p.displayName || p.name })), readable };
      },
      listAgentsChecked: (projectPath) => agentConfig.peekDurableConfigsChecked(projectPath),
      getAgent: (projectPath, agentId) => agentConfig.getDurableConfig(projectPath, agentId),
      setManagedSetup: (projectPath, agentId, setup, precondition) => precondition
        ? agentConfig.setManagedSetup(projectPath, agentId, setup, precondition)
        : agentConfig.setManagedSetup(projectPath, agentId, setup),
      isRunning,
      onChanged: () => broadcastToAllWindows(IPC.MANAGED.CHANGED),
      setHelperTemplate: async (projectPath, agentId, templateId) => { await agentConfig.updateDurableConfig(projectPath, agentId, { helperTemplateId: templateId }); },
      onSetupRemapped: (_projectPath, agent, before, after) => followRemappedSetup(agent, before, after),
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
 * A retired built-in swapped for its copy delivers the same text (D99), so a
 * running session that was up to date stays so: its delivery record moves to
 * the copy's ids, and no setup-changed bar shows. A session already waiting
 * for a change keeps waiting.
 */
export async function followRemappedSetup(agent: DurableAgentConfig, before: ManagedAgentSetup, after: ManagedAgentSetup): Promise<void> {
  const record = delivered.get(agent.id);
  if (!record) return;
  const svc = managedAgents();
  const was = setupFingerprint({ ...agent, managed: before }, await resolveManagedSetup(svc, before, agent));
  if (was.fingerprint !== record.fingerprint) return;
  const now = setupFingerprint({ ...agent, managed: after }, await resolveManagedSetup(svc, after, agent));
  delivered.set(agent.id, { ...record, fingerprint: now.fingerprint, parts: now.parts, order: now.order });
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

// Freed when the agent is deleted or a helper disposed, and the text when its session ends (delivery-records).

/** The spawn path: what this session's MCP servers lack. Details shows it while the agent runs; delivery-records frees it. */
export function recordMcpStartProblems(agentId: string, problems: ManagedMcpProblem[]): void {
  const before = JSON.stringify(mcpProblems.get(agentId) ?? []);
  if (problems.length > 0) mcpProblems.set(agentId, problems.map((p) => ({ server: p.server, missingEnv: [...p.missingEnv] })));
  else mcpProblems.delete(agentId);
  if (JSON.stringify(problems) !== before) broadcastToAllWindows(IPC.MANAGED.CHANGED);
}

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
  // Keep what Clubhouse delivered out of commits (D73, D76, D97).
  void queueManagedExcludes(projectPath);
  broadcastToAllWindows(IPC.MANAGED.CHANGED);
  if (record?.missing) {
    broadcastToAllWindows(IPC.AGENT.AGENT_MATERIALIZATION_FAILED, agent.id,
      `${record.missing} part${record.missing === 1 ? '' : 's'} in ${agent.name}'s setup no longer exist${record.missing === 1 ? 's' : ''} and ${record.missing === 1 ? 'was' : 'were'} skipped. Open its builder to fix the setup.`);
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
  template: QuickTemplateChoice,
  provider: OrchestratorProvider,
): Promise<QuickManagedLaunch> {
  const { getCurrentBranch } = await import('../git-service');
  const branch = await getCurrentBranch(cwd).catch((): null => null);
  const launch = await quickManagedLaunch({
    service: managedAgents(), projectPath, cwd, agentId, agentName: template.agentName, templateId: template.id, branch,
    addParts: template.addParts, removeParts: template.removeParts, mcpLaunchFlags: !!provider.buildMcpArgs,
  });
  if (launch.changes.added.length > 0 || launch.changes.removed.length > 0) {
    // Ids only: what this one launch changed from its template (#2928). Nothing is saved.
    appLog('core:managed', 'info', 'Quick agent template: parts changed for this launch', {
      meta: { agentId, templateId: template.id, added: launch.changes.added, removed: launch.changes.removed },
    });
  }
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
  return mcpServersOf(await resolveManagedSetup(managedAgents(), agent.managed, agent));
}

export async function statusFor(projectPath: string, agentId: string): Promise<ManagedAgentStatus> {
  const agent = await agentConfig.getDurableConfig(projectPath, agentId);
  const running = (await import('../agent-system')).isAgentRunning(agentId);
  if (!agent?.managed) {
    // The switch offer says why an automatic switch didn't happen (D59).
    const migrationFailed = agent?.managedMigrationFailure?.message;
    return { managed: false, running, waiting: false, changes: [], cliChanged: false, ...(migrationFailed && { migrationFailed }) };
  }
  const problems = running ? mcpProblems.get(agentId) : undefined;
  const notice = {
    ...(agent.managedMigration && !agent.managedMigration.dismissed && { migrated: { from: agent.managedMigration.from, backup: agent.managedMigration.backup } }),
    ...(problems && problems.length > 0 && { mcpProblems: problems }),
  };
  const failed = failedDeliveries.get(agentId);
  if (running && failed) {
    return { managed: true, running, waiting: true, changes: [`Setup couldn't be written: ${failed}`], cliChanged: false, deliveryFailed: failed, ...notice };
  }
  const record = delivered.get(agentId);
  if (!running || !record) return { managed: true, running, waiting: false, changes: [], cliChanged: false, ...notice };
  const resolved = await resolveManagedSetup(managedAgents(), agent.managed, agent);
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
  if (changes.length === 0 && cliChanged) changes.push('The CLI changed');
  if (changes.length === 0 && record.launch && now.launch) {
    const was = record.launch, is = now.launch;
    if (was.model !== is.model) changes.push('The model changed');
    if (was.effort !== is.effort) changes.push('The effort changed');
    if (was.access !== is.access || was.freeAgentMode !== is.freeAgentMode) changes.push('Access changed');
  }
  if (changes.length === 0) changes.push('Its settings changed');
  return { managed: true, running, waiting: true, changes, deliveredAt: record.deliveredAt, cliChanged, ...notice };
}

export async function activationFor(projectPath: string, agentId: string) {
  const agent = await agentConfig.getDurableConfig(projectPath, agentId);
  if (!agent) throw new ManagedError('not_found', 'Agent not found.');
  const system = await import('../agent-system');
  const provider = await system.resolveOrchestrator(projectPath, agent.orchestrator);
  const running = system.isAgentRunning(agentId);
  const report = running ? getAgentRuntime(agentId)?.getProviderReport?.() : undefined;
  return managedActivationFor({
    service: managedAgents(), agent, running, effectiveProvider: provider.id, materialized: delivered.get(agentId),
    deliveryFailed: failedDeliveries.has(agentId), mcpProblems: mcpProblems.get(agentId), report,
  });
}

/** Preview's settings rows a running session picks up without a restart. */
const LIVE_SETTINGS_ROWS = new Set(['orchestration', 'helpers', 'helperTemplate', 'dispatcher']);

/**
 * What a running agent's session started with, for Preview's "Running now",
 * while its next start differs (the setup-changed bar is showing). Null when
 * it isn't running, nothing is waiting, or this app run didn't deliver it.
 */
export async function runningSnapshotFor(projectPath: string, agentId: string): Promise<ManagedRunningSnapshot | null> {
  const status = await statusFor(projectPath, agentId);
  const snapshot = delivered.get(agentId)?.snapshot;
  if (!status.running || !status.waiting || !snapshot) return null;
  // Orchestration and the helper template reach a running agent at once (D83, #3197), so they are
  // never waiting: show them as they are now. The rest is what the session started with.
  const agent = await agentConfig.getDurableConfig(projectPath, agentId);
  const now = agent ? await managedSettingsRows(managedAgents(), agent, undefined) : undefined;
  const settings = now
    ? now.map((r) => (LIVE_SETTINGS_ROWS.has(r.key) ? r : snapshot.settings.find((s) => s.key === r.key) ?? r))
    : snapshot.settings;
  return { ...snapshot, settings, changes: status.changes };
}

/** The person dismissed the "Switched to managed when Clubhouse updated" notice. The marker stays (D59). */
export async function dismissMigrationNotice(projectPath: string, agentId: string): Promise<void> {
  await agentConfig.setManagedMigration(projectPath, agentId, { dismissed: true });
  broadcastToAllWindows(IPC.MANAGED.CHANGED);
}

export { forgetDelivery };

// ── Switch to plain (#2927) ────────────────────────────────────────────

function plainDeps(): PlainDeps {
  return {
    service: managedAgents(),
    getAgent: (projectPath, agentId) => agentConfig.getDurableConfig(projectPath, agentId),
    providerFor: async (projectPath, agent) => (await import('../agent-registry')).resolveOrchestrator(projectPath, agent.orchestrator),
    deliveredInstructions: (agentId) => delivered.get(agentId)?.snapshot?.instructions,
  };
}

/** What switching the agent to plain leaves in its folder, and what can come back (D98). Writes nothing. */
export function previewPlain(projectPath: string, agentId: string): Promise<ManagedPlainPreview> {
  return previewSwitchToPlain(plainDeps(), projectPath, agentId);
}

/** Switch a managed agent to plain, bringing back the earlier files chosen (D98). */
export function switchPlain(projectPath: string, agentId: string, choice: ManagedPlainChoice): Promise<void> {
  return switchToPlain(plainDeps(), projectPath, agentId, choice);
}

// ── Restart ────────────────────────────────────────────────────────────

const restarting = new Set<string>();

function restartRuntimeIdentity(agentId: string): AgentRuntime | string | undefined {
  const runtime = getAgentRuntime(agentId);
  if (runtime?.kind === 'chat') return runtime;
  return processIdentity(agentId);
}

export type RestartAuthorization = (() => void) & { refresh?: () => Promise<void> };

async function restartConfig(projectPath: string, agentId: string) {
  const generation = agentConfig.agentConfigGeneration();
  const agent = await agentConfig.getDurableConfig(projectPath, agentId);
  const current = agentConfig.peekCachedDurableConfig(projectPath, agentId);
  if (!agent?.managed || !current?.managed) throw new ManagedError('not_managed', 'The managed agent is no longer available. It was not started.');
  if (generation !== agentConfig.agentConfigGeneration()
    && !isDeepStrictEqual(restartConfigSnapshot(agent), restartConfigSnapshot(current))) {
    throw new ManagedError('stale', 'Agent configuration changed while restart was preparing.');
  }
  return { agent: { ...current } };
}

function restartConfigSnapshot(agent: Readonly<DurableAgentConfig>): DurableAgentConfig {
  const snapshot = { ...agent };
  // spawnAgent clears this exit annotation before opening the new runtime.
  delete snapshot.lastSleep;
  return snapshot;
}

function assertRestartConfig(projectPath: string, agentId: string, pinned: DurableAgentConfig): void {
  const current = agentConfig.peekCachedDurableConfig(projectPath, agentId);
  if (!current?.managed || !isDeepStrictEqual(restartConfigSnapshot(current), restartConfigSnapshot(pinned))) {
    throw new ManagedError('stale', 'The pinned managed configuration is no longer current. No runtime effect was authorized.');
  }
}

/** A synchronous "is it mid-turn" check, as the wait for a turn end judges it. */
async function turnBusyCheck(): Promise<(agentId: string) => boolean> {
  const { getAgentRuntime } = await import('../agent-runtime');
  const { BUSY_STATES } = await import('../agent-runtime/checkpoint-tracker');
  const ptyManager = await import('../pty-manager');
  return (agentId) => {
    const runtime = getAgentRuntime(agentId);
    if (runtime?.kind === 'chat') return BUSY_STATES.has(runtime.getState());
    const last = ptyManager.getLastActivity(agentId);
    return last !== null && Date.now() - last < 5000;
  };
}

async function waitForTurnEnd(agentId: string, stillCurrent: () => boolean, timeoutMs = 30 * 60_000): Promise<boolean> {
  const { isAgentRunning } = await import('../agent-system');
  const busy = await turnBusyCheck();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAgentRunning(agentId) || !stillCurrent()) return false;
    if (!busy(agentId)) return true;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return false;
}

/** A turn started between the wait and the stop: nothing was stopped, so the restart waits again. */
class TurnStartedError extends Error {}

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
export async function restartManagedAgent(projectPath: string, agentId: string, options: { fresh?: boolean; whenTurnEnds?: boolean; authorize?: () => Promise<RestartAuthorization> } = {}): Promise<{ resumed: boolean; noSession?: boolean }> {
  const originalRuntime = restartRuntimeIdentity(agentId);
  const originalProvider = agentRegistry.get(agentId)?.orchestrator;
  const target = await agentConfig.getDurableConfig(projectPath, agentId);
  if (!target) throw new ManagedError('not_found', 'agent not found');
  if (!target.managed) throw new ManagedError('not_managed', `${target.name} isn't Clubhouse managed, so there is no setup to restart into.`);
  const agentSystem = await import('../agent-system');
  if (!agentSystem.isAgentRunning(agentId)) throw new ManagedError('invalid', `${target.name} isn't running. It gets its setup when it next starts.`);
  if (restarting.has(agentId)) throw new Error('already restarting');
  restarting.add(agentId);
  try {
    const service = managedAgents();
    const requested = setupFingerprint(target, await resolveManagedSetup(service, target.managed, target));
    return await restartWithReceipt({
      agentId, fresh: !!options.fresh, whenTurnEnds: !!options.whenTurnEnds, requestedParts: partRevisions(requested.parts),
    }, (receipt) => service.recordRestartReceipt(receipt), async () => {
      const busy = await turnBusyCheck();
      const restartOnce = () => withAgentTransition(agentId, async () => {
        const assertOriginal = () => {
          if (!originalProvider || !originalRuntime || !agentSystem.isAgentRunning(agentId) || restartRuntimeIdentity(agentId) !== originalRuntime) {
            throw new ManagedError('stale', 'The original runtime is no longer running. A replacement was not restarted.');
          }
        };
        const assertStopped = (candidate?: AgentRuntime) => {
          const current = restartRuntimeIdentity(agentId);
          if (agentSystem.isAgentRunning(agentId) || (candidate && (current !== candidate || candidate.isRunning()))
            || (!candidate && current !== undefined && current !== originalRuntime)) {
            throw new ManagedError('stale', 'Stopping the original runtime was not confirmed, or another runtime replaced it. Nothing was started.');
          }
        };
        assertOriginal();
        const authorizeStop = await options.authorize?.();
        const before = await restartConfig(projectPath, agentId);
        await authorizeStop?.refresh?.();
        const beforeStop = () => {
          authorizeStop?.();
          assertRestartConfig(projectPath, agentId, before.agent);
          assertOriginal();
          // Waiting for the turn end promised not to cut one off: a turn that began while this prepared is waited out too.
          if (options.whenTurnEnds && busy(agentId)) throw new TurnStartedError('A turn started before the stop.');
        };
        beforeStop();
        await agentSystem.killAgent(agentId, projectPath, originalProvider, 'user', { waitForExit: true, throwOnFailure: true, beforeStop });
        assertStopped();
        const authorizeStart = await options.authorize?.();
        const prepared = await restartConfig(projectPath, agentId);
        const projectVersion = projectStore.projectRegistryMutationState();
        if (projectVersion.pending) throw new ManagedError('stale', 'Project configuration is changing. Nothing was started.');
        const provider = await agentSystem.resolveOrchestrator(projectPath, prepared.agent.orchestrator);
        const latest = await restartConfig(projectPath, agentId);
        if (!isDeepStrictEqual(restartConfigSnapshot(prepared.agent), restartConfigSnapshot(latest.agent))) throw new ManagedError('stale', 'Agent configuration changed during provider resolution. Nothing was started.');
        const agent = latest.agent;
        const cliChanged = originalProvider !== provider.id;
        const resume = !options.fresh && !cliChanged && !!agent.lastSessionId;
        await authorizeStart?.refresh?.();
        broadcastToAllWindows(IPC.AGENT.AGENT_WAKING, agentId);
        try {
          let createdChat: AgentRuntime | undefined;
          const beforeCreate = (candidate?: AgentRuntime) => {
            authorizeStart?.();
            const currentProject = projectStore.projectRegistryMutationState();
            if (currentProject.pending || currentProject.generation !== projectVersion.generation) {
              throw new ManagedError('stale', 'Project configuration changed before starting. Nothing was started.');
            }
            assertRestartConfig(projectPath, agentId, agent);
            assertStopped(candidate);
            createdChat = candidate;
          };
          beforeCreate();
          await agentSystem.spawnAgent({
            agentId, projectPath, cwd: agent.worktreePath || projectPath, kind: 'durable',
            model: agent.model, orchestrator: provider.id, freeAgentMode: agent.freeAgentMode,
            resume, sessionId: resume ? agent.lastSessionId : undefined,
            beforeCreate,
          });
          const started = restartRuntimeIdentity(agentId);
          if (!agentSystem.isAgentRunning(agentId) || !started || started === originalRuntime || (createdChat && started !== createdChat)) {
            throw new ManagedError('failed', 'A new running runtime was not confirmed after the start. Inspect the current target before retrying.');
          }
        } catch (err) {
          broadcastToAllWindows(IPC.AGENT.AGENT_WAKE_FAILED, agentId, 'Managed restart failed. Inspect the lifecycle receipt and current target state before retrying.');
          throw err;
        }
        const noSession = !resume && !options.fresh && !cliChanged;
        appLog('core:managed', 'info', 'Restarted managed agent', { meta: { agentId, resume, noSession } });
        return { resumed: resume, ...(noSession && { noSession: true }) };
      });
      const waitUntil = Date.now() + 30 * 60_000;
      for (;;) {
        if (options.whenTurnEnds && !(await waitForTurnEnd(agentId, () => !!originalRuntime && restartRuntimeIdentity(agentId) === originalRuntime, Math.max(0, waitUntil - Date.now())))) {
          // Stopped by someone else, or still working after the wait: don't restart behind their back.
          throw new Error(agentSystem.isAgentRunning(agentId) ? 'The agent is still working. Try Restart again later.' : 'The agent stopped before its turn ended.');
        }
        try {
          return await restartOnce();
        } catch (err) {
          if (err instanceof TurnStartedError) continue;
          throw err;
        }
      }
    });
  } finally {
    restarting.delete(agentId);
  }
}
