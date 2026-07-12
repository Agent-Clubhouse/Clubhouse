/**
 * Hook server toggle — applies the side effects when the user flips a single
 * orchestrator's per-provider hook server setting.  The hook server itself
 * stays running for the lifetime of the app; these helpers only govern whether
 * a given orchestrator's *agents* have Clubhouse hooks injected.
 *
 * **Disable**:  resolve that orchestrator's in-flight permissions as 'timeout'
 * (so the orchestrator's curl child returns), then strip Clubhouse-injected
 * hook entries from each of its running agents' hook config files.  The agent's
 * CLI process keeps running but its in-memory hook config may still reference
 * Clubhouse — surface a "needs restart" notice for each affected agent.
 *
 * **Enable**:  re-inject hook entries into each of that orchestrator's running
 * agents' hook config files, snapshot them again so a future disable can
 * restore the original.  Same "needs restart" notice — the agent's CLI process
 * won't pick up the new entries until it next reads its hook config.
 *
 * Auto-restart of agents is intentionally NOT performed: killing PTYs
 * mid-task would lose work.  Restart is the user's call.
 */

import * as path from 'path';
import { agentRegistry, readProjectOrchestrator, DEFAULT_ORCHESTRATOR } from './agent-registry';
import { getProvider } from '../orchestrators';
import { isHookCapable } from '../orchestrators';
import { appLog } from './log-service';
import * as configPipeline from './config-pipeline';
import * as permissionQueue from './annex-permission-queue';
import * as hookServer from './hook-server';
import * as projectStore from './project-store';
import * as agentConfig from './agent-config';
import { broadcastToAllWindows } from '../util/ipc-broadcast';
import { IPC } from '../../shared/ipc-channels';

const NS = 'core:hook-server-toggle';

/**
 * Apply the disabled state for a single orchestrator: resolve its pending
 * permissions, strip injected hooks from each of its running agents' configs,
 * reconcile any STOPPED durable agents whose hook config is still on disk, then
 * broadcast restart-needed.  Other orchestrators' agents are left untouched.
 */
export async function applyDisabledForOrchestrator(orchestratorId: string): Promise<string[]> {
  const registrations = agentRegistry.getAllRegistrations();
  const affectedAgentIds: string[] = [];
  const runningCwds = new Set<string>();

  // 1. Running agents — strip via the snapshot/restore pipeline (which preserves
  //    user-authored settings) and release in-flight permissions.
  for (const [agentId, registration] of registrations) {
    if (registration.orchestrator !== orchestratorId) continue;
    if (registration.cwd) runningCwds.add(path.resolve(registration.cwd));

    // Release this agent's in-flight permissions so curls return immediately;
    // `clearForAgent` resolves each pending entry as 'timeout', which the hook
    // server maps to 'ask' on its way back to the orchestrator.
    permissionQueue.clearForAgent(agentId);

    try {
      await configPipeline.restoreForAgent(agentId);
      affectedAgentIds.push(agentId);
    } catch (err) {
      appLog(NS, 'error', 'Failed to strip hooks for agent', {
        meta: { agentId, orchestrator: orchestratorId, error: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  // 2. Stopped durable agents — never in the registry, but their hook config is
  //    still on disk and would keep firing after the disable (and is NOT
  //    re-stripped on restart, since startup injection is gated on the now-off
  //    toggle). Reconcile every matching durable agent that is not currently
  //    running by stripping its on-disk hook file directly.
  const stoppedIds = await reconcileStoppedDurableAgents(orchestratorId, runningCwds);
  affectedAgentIds.push(...stoppedIds);

  appLog(NS, 'info', 'Hook server disabled for orchestrator — agents stripped of injected hooks', {
    meta: { orchestrator: orchestratorId, affectedAgentIds, agentCount: affectedAgentIds.length },
  });

  if (affectedAgentIds.length > 0) {
    broadcastToAllWindows(IPC.HOOK_SERVER.AGENTS_NEED_RESTART, {
      reason: 'disabled',
      agentIds: affectedAgentIds,
    });
  }

  return affectedAgentIds;
}

/**
 * Sweep every project's durable agents and strip Clubhouse hook entries from
 * the on-disk config of each STOPPED agent belonging to `orchestratorId`.
 * Agents whose worktree is in `runningCwds` are skipped — they were already
 * handled via the snapshot/restore pipeline. Returns the IDs that actually had
 * hooks removed (so they can be folded into the "needs restart" broadcast).
 *
 * Best-effort: a failure reading one project or one agent's file is logged and
 * skipped rather than aborting the whole reconciliation.
 */
async function reconcileStoppedDurableAgents(
  orchestratorId: string,
  runningCwds: Set<string>,
): Promise<string[]> {
  const affected: string[] = [];

  const provider = getProvider(orchestratorId);
  if (!provider || !isHookCapable(provider)) {
    // Unknown or non-hook-capable orchestrator never wrote hooks to strip.
    return affected;
  }

  let projects: Awaited<ReturnType<typeof projectStore.list>>;
  try {
    projects = await projectStore.list();
  } catch (err) {
    appLog(NS, 'warn', 'Durable agent reconciliation skipped — failed to list projects', {
      meta: { orchestrator: orchestratorId, error: err instanceof Error ? err.message : String(err) },
    });
    return affected;
  }

  for (const project of projects) {
    // A durable agent with no explicit orchestrator inherits the project's
    // setting, falling back to the app default.
    const projectOrchestrator = (await readProjectOrchestrator(project.path)) || DEFAULT_ORCHESTRATOR;

    let durables: Awaited<ReturnType<typeof agentConfig.listDurable>>;
    try {
      durables = await agentConfig.listDurable(project.path);
    } catch (err) {
      appLog(NS, 'warn', 'Failed to list durable agents for project', {
        meta: { projectPath: project.path, error: err instanceof Error ? err.message : String(err) },
      });
      continue;
    }

    for (const durable of durables) {
      if (!durable.worktreePath) continue;
      const effectiveOrchestrator = durable.orchestrator || projectOrchestrator;
      if (effectiveOrchestrator !== orchestratorId) continue;
      if (runningCwds.has(path.resolve(durable.worktreePath))) continue; // handled as a running agent

      const hookConfigPath = configPipeline.getHooksConfigPath(provider, durable.worktreePath);
      if (!hookConfigPath) continue;

      try {
        const stripped = await configPipeline.stripClubhouseHooksFromFile(hookConfigPath);
        if (stripped) affected.push(durable.id);
      } catch (err) {
        appLog(NS, 'error', 'Failed to strip hooks for stopped durable agent', {
          meta: {
            agentId: durable.id,
            orchestrator: orchestratorId,
            error: err instanceof Error ? err.message : String(err),
          },
        });
      }
    }
  }

  return affected;
}

/**
 * Apply the enabled state for a single orchestrator: re-inject hook entries
 * into each of its running agents' configs, broadcast restart-needed.
 */
export async function applyEnabledForOrchestrator(orchestratorId: string): Promise<string[]> {
  const registrations = agentRegistry.getAllRegistrations();
  const affectedAgentIds: string[] = [];

  const provider = getProvider(orchestratorId);
  if (!provider || !isHookCapable(provider)) {
    // Nothing to inject for an unknown or non-hook-capable orchestrator.
    return affectedAgentIds;
  }

  const port = hookServer.getPort();
  if (port === 0) {
    appLog(NS, 'warn', 'Hook server enabled but server port is 0 — re-injection skipped', {
      meta: { orchestrator: orchestratorId },
    });
    return affectedAgentIds;
  }
  const hookUrl = `http://127.0.0.1:${port}/hook`;

  for (const [agentId, registration] of registrations) {
    if (registration.orchestrator !== orchestratorId) continue;
    if (!registration.cwd) {
      appLog(NS, 'warn', 'Cannot re-inject hooks for agent — cwd unknown', {
        meta: { agentId, orchestrator: registration.orchestrator },
      });
      continue;
    }

    try {
      // Snapshot the (possibly user-edited) current state before we re-inject,
      // so a future disable can restore it cleanly.
      const hookConfigPath = configPipeline.getHooksConfigPath(provider, registration.cwd);
      if (hookConfigPath) {
        await configPipeline.snapshotFile(agentId, hookConfigPath);
      }
      await provider.writeHooksConfig(registration.cwd, hookUrl);
      affectedAgentIds.push(agentId);
    } catch (err) {
      appLog(NS, 'error', 'Failed to re-inject hooks for agent', {
        meta: { agentId, orchestrator: orchestratorId, error: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  appLog(NS, 'info', 'Hook server enabled for orchestrator — agents re-injected with hooks', {
    meta: { orchestrator: orchestratorId, affectedAgentIds, agentCount: affectedAgentIds.length },
  });

  if (affectedAgentIds.length > 0) {
    broadcastToAllWindows(IPC.HOOK_SERVER.AGENTS_NEED_RESTART, {
      reason: 'enabled',
      agentIds: affectedAgentIds,
    });
  }

  return affectedAgentIds;
}

/**
 * Apply the side effect for a per-orchestrator hook server toggle change.
 */
export async function onOrchestratorHookServerChanged(
  orchestratorId: string,
  enabled: boolean,
): Promise<void> {
  if (enabled) {
    await applyEnabledForOrchestrator(orchestratorId);
  } else {
    await applyDisabledForOrchestrator(orchestratorId);
  }
}
