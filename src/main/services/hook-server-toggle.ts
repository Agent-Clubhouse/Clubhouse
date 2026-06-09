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

import { agentRegistry } from './agent-registry';
import { getProvider } from '../orchestrators';
import { isHookCapable } from '../orchestrators';
import { appLog } from './log-service';
import * as configPipeline from './config-pipeline';
import * as permissionQueue from './annex-permission-queue';
import * as hookServer from './hook-server';
import { broadcastToAllWindows } from '../util/ipc-broadcast';
import { IPC } from '../../shared/ipc-channels';

const NS = 'core:hook-server-toggle';

/**
 * Apply the disabled state for a single orchestrator: resolve its pending
 * permissions, strip injected hooks from each of its running agents' configs,
 * broadcast restart-needed.  Other orchestrators' agents are left untouched.
 */
export async function applyDisabledForOrchestrator(orchestratorId: string): Promise<string[]> {
  const registrations = agentRegistry.getAllRegistrations();
  const affectedAgentIds: string[] = [];

  for (const [agentId, registration] of registrations) {
    if (registration.orchestrator !== orchestratorId) continue;

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
