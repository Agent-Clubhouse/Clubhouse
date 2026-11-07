/**
 * The automatic switch to managed (D59, #2901). With the `managedAgents` flag
 * on, an unmanaged agent that uses Clubhouse Mode or a persona switches to
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
 * the app restarts, or it is switched by hand.
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
import { beforeManagedDir } from './before-managed';
import { ManagedError } from './service';

async function flagOn(): Promise<boolean> {
  const { getSettings } = await import('../experimental-settings');
  return getSettings().managedAgents === true;
}

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
 * Dispatcher, and never twice: an agent with the marker stays as it is, even
 * after Stop managing.
 */
export function autoMigrateFrom(projectPath: string, agent: DurableAgentConfig): ManagedMigrationFrom | null {
  if (agent.managed || agent.managedMigration) return null;
  if (isDispatcherPath(projectPath)) return null;
  if (agent.parentAgentId || isDisposedAgent(agent) || agent.creation || !agent.worktreePath) return null;
  return legacyConfiguredFrom(projectPath, agent);
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

/** An error code fit for the log: never a message, a path or a name. */
function codeOf(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[\w.-]{1,64}$/.test(code) ? code : 'failed';
}

/** The reason in words, for the switch offer. */
function reasonOf(err: unknown): string {
  if (err instanceof ManagedError && err.message && err.message !== err.code) return err.message;
  if (codeOf(err) === 'agent_transition_busy') return 'It was changing state at the time.';
  return 'Something went wrong while switching it.';
}

/** Agents whose automatic switch failed since the app started. Not tried again at spawn until a restart. */
const failedThisRun = new Set<string>();
/** Switches in progress, so a spawn during the startup pass waits for that agent's instead of starting another. */
const inflight = new Map<string, Promise<boolean>>();

/**
 * Switch one agent with Keep and record the outcome on it. True when it is
 * managed now. Never throws.
 */
function migrate(projectPath: string, agent: DurableAgentConfig, from: ManagedMigrationFrom): Promise<boolean> {
  const running = inflight.get(agent.id);
  if (running) return running;
  const run = (async () => {
    try {
      // The switch adds the built-in Clubhouse part, so the built-ins come first.
      const { ensureBuiltinsOnce } = await import('./index');
      await ensureBuiltinsOnce();
      const { convertToManaged } = await import('./agents');
      await withSettingsSurface('system', undefined, () => convertToManaged(projectPath, agent.id, { keep: true }));
    } catch (err) {
      failedThisRun.add(agent.id);
      const code = codeOf(err);
      appLog('core:managed', 'warn', 'Automatic switch to managed failed; the agent keeps its current setup', { meta: { agentId: agent.id, from, code } });
      await agentConfig.setManagedMigration(projectPath, agent.id, { failed: { at: new Date().toISOString(), code, message: reasonOf(err) } }).catch((recordErr) => {
        // telemetry-exempt: logged; the agent still isn't tried again until the app restarts.
        appLog('core:managed', 'warn', 'Could not record the failed automatic switch to managed', { meta: { agentId: agent.id, code: codeOf(recordErr) } });
      });
      broadcastToAllWindows(IPC.MANAGED.CHANGED);
      return false;
    }
    failedThisRun.delete(agent.id);
    await agentConfig.setManagedMigration(projectPath, agent.id, { migrated: { at: new Date().toISOString(), from, backup: backupLocation(agent.id) } }).catch((err) => {
      // telemetry-exempt: logged; the agent is managed, it just doesn't show the notice.
      appLog('core:managed', 'warn', 'Could not record the automatic switch to managed', { meta: { agentId: agent.id, code: codeOf(err) } });
    });
    appLog('core:managed', 'info', 'Switched agent to managed automatically', { meta: { agentId: agent.id, from } });
    broadcastToAllWindows(IPC.MANAGED.CHANGED);
    return true;
  })().finally(() => inflight.delete(agent.id));
  inflight.set(agent.id, run);
  return run;
}

/**
 * Spawn path, before Clubhouse Mode would materialize: switch a
 * legacy-configured agent first. Returns its config as managed, or null to
 * start it as it is (flag off, nothing to switch, the switch failed, or it
 * failed earlier since the app started).
 */
export async function migrateAtSpawn(projectPath: string, agent: DurableAgentConfig): Promise<DurableAgentConfig | null> {
  try {
    if (!(await flagOn())) return null;
    if (!autoMigrateFrom(projectPath, agent)) return null;
    // A startup pass may be switching it right now.
    const pending = inflight.get(agent.id);
    if (pending) return (await pending) ? await agentConfig.getDurableConfig(projectPath, agent.id) : null;
    if (failedThisRun.has(agent.id)) return null;
    if (!(await isLocalProject(projectPath))) return null;
    const fresh = await agentConfig.getDurableConfig(projectPath, agent.id);
    if (!fresh) return null;
    if (fresh.managed) return fresh;
    const from = autoMigrateFrom(projectPath, fresh);
    if (!from) return null;
    return (await migrate(projectPath, fresh, from)) ? await agentConfig.getDurableConfig(projectPath, agent.id) : null;
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
  if (!(await flagOn())) return result;
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
      const from = autoMigrateFrom(project.path, agent);
      if (!from) {
        if (await carryPersonaLayer(project.path, agent)) result.carried++;
        continue;
      }
      // Running, waking or mid-change: never under a session. Its next spawn switches it.
      if (isAgentRunning(agent.id) || agentTransitionBusy(agent.id) || inflight.has(agent.id)) {
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
  startupPass = null;
}
