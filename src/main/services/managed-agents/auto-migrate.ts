/**
 * The automatic switch to managed (D59, #2901). An unmanaged agent that uses Clubhouse Mode or a persona switches to
 * managed on its own, keeping what it has now. It is the reviewed
 * `convertToManaged` with Keep: Clubhouse Mode's instructions and defaults,
 * the persona's orchestration, backups, and removing what a failed switch
 * made all come from there.
 *
 * It runs at two points, never under a running session:
 * - at spawn, before Clubhouse Mode would materialize, so the agent starts as
 *   managed and never runs on the legacy runtime again;
 * - once after app ready, for sleeping agents in local projects, one at a
 *   time. Running and waking agents are left for their next spawn.
 *
 * A failed switch is logged with codes only and recorded on the agent, which
 * keeps starting on its old setup. It isn't tried again at its spawns until
 * the app restarts, or it is switched by hand. An agent switched once, by
 * hand or on its own, is never switched on its own again.
 */
import * as os from 'os';
import * as path from 'path';
import * as agentConfig from '../agent-config';
import * as projectStore from '../project-store';
import { isClubhouseModeEnabled } from '../clubhouse-mode-settings';
import { isDispatcherPath } from '../dispatcher/dispatcher-paths';
import { agentTransitionBusy } from '../agent-transition';
import { withSettingsSurface } from '../settings-audit';
import { appLog } from '../log-service';
import { broadcastToAllWindows } from '../../util/ipc-broadcast';
import { IPC } from '../../../shared/ipc-channels';
import { isDisposedAgent } from '../../../shared/agent-helpers';
import type { DurableAgentConfig } from '../../../shared/types';
import type { ManagedMigrationFrom } from '../../../shared/managed-agents-types';
import { beforeManagedDir, clearPendingSwitch, readPendingSwitch, switchedBefore } from './before-managed';
import { codeOf } from './log-code';
import { ManagedError } from './service';

/**
 * What makes an agent legacy-configured: Clubhouse Mode on for its project
 * and not turned off for it, or a persona. Null for a managed or plain agent.
 */
export function legacyConfiguredFrom(projectPath: string, agent: DurableAgentConfig): ManagedMigrationFrom | null {
  if (agent.managed) return null;
  if (!agent.clubhouseModeOverride && isClubhouseModeEnabled(projectPath)) return 'clubhouse-mode';
  if (agent.persona) return 'persona';
  return null;
}

/**
 * Whether Clubhouse may switch this agent on its own, and from what. The
 * Switch agents page's filters (no helpers, disposed agents or agents still
 * being created, and an agent needs its own folder), plus never the
 * Dispatcher, never a plain CLI (Clubhouse features off), and never twice:
 * an agent switched once, by hand or on its own, stays as it is, even after
 * Stop managing. switchedBefore covers agents switched before the marker.
 */
export function autoMigrateFrom(projectPath: string, agent: DurableAgentConfig): ManagedMigrationFrom | null {
  if (agent.managed || agent.managedMigration || agent.switchedToManagedAt) return null;
  // A plain CLI with Clubhouse's features turned off stays as the person set it.
  if (agent.clubhouseFeatures === false) return null;
  if (isDispatcherPath(projectPath)) return null;
  if (agent.parentAgentId || isDisposedAgent(agent) || agent.creation || !agent.worktreePath) return null;
  return legacyConfiguredFrom(projectPath, agent);
}

/**
 * Switched to managed before the switched-once marker was kept: its
 * before-managed folder is there with no switch in progress. An agent whose
 * automatic switch failed is tried again, since a failed switch leaves no copy.
 */
async function switchedEarlier(agent: DurableAgentConfig): Promise<boolean> {
  if (agent.managedMigrationFailure) return false;
  return switchedBefore(agent.id);
}

/** Only projects registered on this machine. An agent on another machine is that machine's to switch. */
async function isLocalProject(projectPath: string): Promise<boolean> {
  const key = path.resolve(projectPath);
  return (await projectStore.peekProjects()).some((p) => path.resolve(p.path) === key);
}

/** "~/.clubhouse/managed-agents/before-managed/<id>", or the full path outside the home folder. */
export function backupLocation(agentId: string, home: string = os.homedir()): string {
  const dir = beforeManagedDir(agentId);
  const rel = path.relative(home, dir);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? path.join('~', rel) : dir;
}

/** The reason in words, for the switch offer. */
function reasonOf(err: unknown): string {
  if (err instanceof ManagedError && err.message && err.message !== err.code) return err.message;
  if (codeOf(err) === 'agent_transition_busy') return 'It was changing state at the time.';
  return 'Something went wrong while switching it.';
}

/** Agents whose automatic switch failed since the app started. Not tried again at spawn until a restart. */
const failedThisRun = new Set<string>();
/** Automatic switches in progress, so a spawn during the startup pass waits for that agent's instead of starting another. */
const inflight = new Map<string, Promise<boolean>>();
/** Every switch of an agent, automatic or by hand, one after another (the tail of each agent's queue). */
const switching = new Map<string, Promise<unknown>>();

/**
 * Run a switch of this agent after any other switch of it, automatic or by
 * hand, has finished. The hand switch (IPC convert, and so the Switch agents
 * page) and the automatic one both go through here, so they never make the
 * same parts twice: the second finds the agent managed.
 */
export function withSwitchLock<T>(agentId: string, run: () => Promise<T>): Promise<T> {
  const previous = switching.get(agentId) ?? Promise.resolve();
  const next = previous.then(run, run);
  const tail: Promise<void> = next.then((): void => undefined, (): void => undefined);
  switching.set(agentId, tail);
  void tail.then(() => { if (switching.get(agentId) === tail) switching.delete(agentId); });
  return next;
}

/** A switch of this agent is running or queued. */
function switchInProgress(agentId: string): boolean {
  return inflight.has(agentId) || switching.has(agentId);
}

/** The agent's config when it is managed now, else null. */
async function managedNow(projectPath: string, agentId: string): Promise<DurableAgentConfig | null> {
  const config = await agentConfig.getDurableConfig(projectPath, agentId);
  return config?.managed ? config : null;
}

/**
 * Switch one agent with Keep and record the outcome on it. True when it is
 * managed now. Never throws.
 */
function migrate(projectPath: string, agent: DurableAgentConfig, from: ManagedMigrationFrom): Promise<boolean> {
  const running = inflight.get(agent.id);
  if (running) return running;
  const run = withSwitchLock(agent.id, async () => {
    // A switch by hand may have finished while this one waited: nothing to do, and no notice.
    const current = await agentConfig.getDurableConfig(projectPath, agent.id);
    if (!current) return false;
    if (current.managed) return true;
    if (!autoMigrateFrom(projectPath, current)) return false;
    try {
      // The switch adds the built-in Clubhouse part, so the built-ins come first.
      const { ensureBuiltinsOnce } = await import('./index');
      await ensureBuiltinsOnce();
      const { convertToManaged } = await import('./agents');
      await withSettingsSurface('system', undefined, () => convertToManaged(projectPath, agent.id, { keep: true }));
    } catch (err) {
      const code = codeOf(err);
      // A failure after the setup was saved (the reconcile, say): the agent is managed, so the switch stands.
      if (!(await managedNow(projectPath, agent.id).catch((): null => null))) {
        failedThisRun.add(agent.id);
        appLog('core:managed', 'warn', 'Automatic switch to managed failed; the agent keeps its current setup', { meta: { agentId: agent.id, from, code } });
        await agentConfig.setManagedMigration(projectPath, agent.id, { failed: { at: new Date().toISOString(), code, message: reasonOf(err) } }).catch((recordErr) => {
          // telemetry-exempt: logged; the agent still isn't tried again until the app restarts.
          appLog('core:managed', 'warn', 'Could not record the failed automatic switch to managed', { meta: { agentId: agent.id, code: codeOf(recordErr) } });
        });
        broadcastToAllWindows(IPC.MANAGED.CHANGED);
        return false;
      }
      appLog('core:managed', 'warn', 'Automatic switch to managed was saved, then a later step failed', { meta: { agentId: agent.id, from, code } });
    }
    failedThisRun.delete(agent.id);
    await agentConfig.setManagedMigration(projectPath, agent.id, { migrated: { at: new Date().toISOString(), from, backup: backupLocation(agent.id) } }).catch((err) => {
      // telemetry-exempt: logged; the agent is managed, it just doesn't show the notice.
      appLog('core:managed', 'warn', 'Could not record the automatic switch to managed', { meta: { agentId: agent.id, code: codeOf(err) } });
    });
    appLog('core:managed', 'info', 'Switched agent to managed automatically', { meta: { agentId: agent.id, from } });
    broadcastToAllWindows(IPC.MANAGED.CHANGED);
    return true;
  }).catch((err) => {
    // telemetry-exempt: logged; the agent starts as it is.
    appLog('core:managed', 'warn', 'Could not switch the agent to managed automatically', { meta: { agentId: agent.id, code: codeOf(err) } });
    return false;
  }).finally(() => inflight.delete(agent.id));
  inflight.set(agent.id, run);
  return run;
}

/**
 * Spawn path, before Clubhouse Mode would materialize: switch a
 * legacy-configured agent first. Returns its config whenever it is managed
 * now (even when the switch reported a failure after its save), or null to
 * start it as it is (nothing to switch, the switch failed, or it
 * failed earlier since the app started).
 */
export async function migrateAtSpawn(projectPath: string, agent: DurableAgentConfig): Promise<DurableAgentConfig | null> {
  try {
    if (!autoMigrateFrom(projectPath, agent)) return null;
    // A startup pass may be switching it right now.
    const pending = inflight.get(agent.id);
    if (pending) {
      await pending;
      return await managedNow(projectPath, agent.id);
    }
    if (failedThisRun.has(agent.id)) return null;
    if (!(await isLocalProject(projectPath))) return null;
    const fresh = await agentConfig.getDurableConfig(projectPath, agent.id);
    if (!fresh) return null;
    if (fresh.managed) return fresh;
    const from = autoMigrateFrom(projectPath, fresh);
    if (!from) return null;
    if (await switchedEarlier(fresh)) {
      // A switch by hand may be writing it right now (its backup exists before
      // its save): wait for it, so this start runs as managed.
      const tail = switching.get(agent.id);
      if (tail) {
        await tail;
        return await managedNow(projectPath, agent.id);
      }
      return null;
    }
    await migrate(projectPath, fresh, from);
    return await managedNow(projectPath, agent.id);
  } catch (err) {
    // telemetry-exempt: logged; the spawn goes on as it would have.
    appLog('core:managed', 'warn', 'Could not check whether to switch the agent to managed', { meta: { agentId: agent.id, code: codeOf(err) } });
    return null;
  }
}

export interface StartupMigrationResult {
  switched: number;
  failed: number;
  /** Running or waking: they switch at their next spawn. */
  deferred: number;
  /** Plain agents whose persona layer was checked and kept as their own fields (D62). */
  carried: number;
}

/**
 * A plain agent stays unmanaged, so it would lose what a project or user
 * `orchestrator.md` (or a project default persona) gives its orchestration
 * once the persona layer is removed. Keep the fields that layer decides as
 * its own, once (D62). Agents that switch get the same from the switch.
 */
async function carryPersonaLayer(projectPath: string, agent: DurableAgentConfig): Promise<boolean> {
  if (agent.managed || agent.personaLayerCarriedAt || isDispatcherPath(projectPath)) return false;
  if (agent.parentAgentId || isDisposedAgent(agent) || agent.creation) return false;
  if (legacyConfiguredFrom(projectPath, agent)) return false;
  if (agentTransitionBusy(agent.id)) return false;
  try {
    const { carryPersonaOrchestration } = await import('../orchestration-policy');
    await carryPersonaOrchestration(projectPath, agent.id, 'plain');
    await agentConfig.setManagedMigration(projectPath, agent.id, { layerCarriedAt: new Date().toISOString() });
    return true;
  } catch (err) {
    // telemetry-exempt: logged; the persona layer still applies, and the next start tries again.
    appLog('core:managed', 'warn', 'Could not keep the persona layer\'s orchestration on a plain agent', { meta: { agentId: agent.id, code: codeOf(err) } });
    return false;
  }
}

/**
 * A managed agent whose switch was saved and then cut short still has its
 * switch-in-progress record. Its parts are its setup, so the record goes,
 * and a later switch (after Stop managing) never removes them.
 */
async function clearSavedSwitchRecord(agentId: string): Promise<void> {
  try {
    if (await readPendingSwitch(agentId)) await clearPendingSwitch(agentId);
  } catch (err) {
    // telemetry-exempt: logged; a later switch sees from the agent that this one was saved.
    appLog('core:managed', 'warn', 'Could not clear a saved switch\'s in-progress record', { meta: { agentId, code: codeOf(err) } });
  }
}

let startupPass: Promise<StartupMigrationResult> | null = null;

/**
 * Once after app ready, after the built-in parts are installed: switch the
 * sleeping legacy-configured agents of every local project, one at a time.
 * A second call returns the first call's result.
 */
export function runStartupMigration(): Promise<StartupMigrationResult> {
  if (!startupPass) startupPass = startupMigration();
  return startupPass;
}

async function startupMigration(): Promise<StartupMigrationResult> {
  const result: StartupMigrationResult = { switched: 0, failed: 0, deferred: 0, carried: 0 };
  // Settings that only follow from Clubhouse Mode today become explicit first (D61, D63).
  const { migrateLegacySettings } = await import('./legacy-settings');
  await migrateLegacySettings();
  const { isAgentRunning } = await import('../agent-system');
  for (const project of await projectStore.peekProjects()) {
    let agents: readonly DurableAgentConfig[];
    try {
      agents = await agentConfig.peekDurableConfigs(project.path);
    } catch (err) {
      // telemetry-exempt: logged; that project's agents switch at their next spawn.
      appLog('core:managed', 'warn', 'Could not read a project\'s agents for the automatic switch to managed', { meta: { code: codeOf(err) } });
      continue;
    }
    for (const agent of agents) {
      if (agent.managed) {
        await clearSavedSwitchRecord(agent.id);
        continue;
      }
      const from = autoMigrateFrom(project.path, agent);
      if (!from) {
        if (await carryPersonaLayer(project.path, agent)) result.carried++;
        continue;
      }
      if (await switchedEarlier(agent).catch(() => true)) continue;
      // Running, waking or mid-change: never under a session. Its next spawn switches it.
      if (isAgentRunning(agent.id) || agentTransitionBusy(agent.id) || switchInProgress(agent.id)) {
        result.deferred++;
        continue;
      }
      if (await migrate(project.path, agent, from)) result.switched++;
      else result.failed++;
    }
  }
  if (result.switched || result.failed || result.deferred || result.carried) {
    appLog('core:managed', 'info', 'Automatic switch to managed at startup', { meta: { ...result } });
  }
  return result;
}

/** Tests only. */
export function _resetAutoMigrateForTesting(): void {
  failedThisRun.clear();
  inflight.clear();
  switching.clear();
  startupPass = null;
}
