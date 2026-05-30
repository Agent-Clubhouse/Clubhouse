/**
 * Hook server toggle — applies the side effects when the user flips the
 * global hook server enable setting.
 *
 * **Disable**:  resolve all in-flight permissions as 'timeout' (so the
 * orchestrator's curl child returns), then strip Clubhouse-injected hook
 * entries from each running agent's hook config file.  The agent's CLI
 * process keeps running but its in-memory hook config may still reference
 * Clubhouse — surface a "needs restart" notice for each affected agent.
 *
 * **Enable**:  re-inject hook entries into each running agent's hook config
 * file, snapshot them again so a future disable can restore the original.
 * Same "needs restart" notice — the agent's CLI process won't pick up the
 * new entries until it next reads its hook config.
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
import type { HookServerSettings } from '../../shared/types';

const NS = 'core:hook-server-toggle';

/**
 * Apply the disabled state: resolve pending permissions, strip injected
 * hooks from each running agent's config, broadcast restart-needed.
 */
export async function applyDisabled(): Promise<string[]> {
  const registrations = agentRegistry.getAllRegistrations();
  const affectedAgentIds: string[] = [];

  // 1. Stop the server from processing new requests.
  hookServer.setEnabled(false);

  // 2. Resolve any in-flight permissions so curls return immediately.
  //    `permissionQueue.reset()` resolves every pending entry as 'timeout',
  //    which the hook server maps to 'ask' on its way back to the orchestrator.
  const pendingCount = permissionQueue.listPending().length;
  if (pendingCount > 0) {
    permissionQueue.reset();
    appLog(NS, 'info', 'Released in-flight permissions on disable', {
      meta: { count: pendingCount },
    });
  }

  // 3. Strip Clubhouse-injected hooks from every running agent's config.
  for (const [agentId] of registrations) {
    try {
      await configPipeline.restoreForAgent(agentId);
      affectedAgentIds.push(agentId);
    } catch (err) {
      appLog(NS, 'error', 'Failed to strip hooks for agent', {
        meta: { agentId, error: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  appLog(NS, 'info', 'Hook server disabled — agents stripped of injected hooks', {
    meta: { affectedAgentIds, agentCount: affectedAgentIds.length },
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
 * Apply the enabled state: re-inject hook entries into each running agent's
 * config, broadcast restart-needed.
 */
export async function applyEnabled(): Promise<string[]> {
  const registrations = agentRegistry.getAllRegistrations();
  const affectedAgentIds: string[] = [];

  hookServer.setEnabled(true);

  const port = hookServer.getPort();
  if (port === 0) {
    appLog(NS, 'warn', 'Hook server enabled but server port is 0 — re-injection skipped', {
      meta: {},
    });
    return affectedAgentIds;
  }
  const hookUrl = `http://127.0.0.1:${port}/hook`;

  for (const [agentId, registration] of registrations) {
    if (!registration.cwd) {
      appLog(NS, 'warn', 'Cannot re-inject hooks for agent — cwd unknown', {
        meta: { agentId, orchestrator: registration.orchestrator },
      });
      continue;
    }

    try {
      const provider = getProvider(registration.orchestrator);
      if (!provider || !isHookCapable(provider)) continue;

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
        meta: { agentId, error: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  appLog(NS, 'info', 'Hook server enabled — agents re-injected with hooks', {
    meta: { affectedAgentIds, agentCount: affectedAgentIds.length },
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
 * onSave hook for the HOOK_SERVER_SETTINGS managed setting.  Applies the
 * appropriate side effect when the user flips the toggle.
 */
export async function onHookServerSettingsChanged(settings: HookServerSettings): Promise<void> {
  if (settings.enabled) {
    await applyEnabled();
  } else {
    await applyDisabled();
  }
}
