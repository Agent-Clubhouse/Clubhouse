/**
 * Waking and sleeping another agent over MCP (#2577).
 *
 * - sleepAgent is the one sleep path of the group project sleep_agent and the
 *   Dispatcher's sleep_agent. sleep_helper keeps its own.
 * - wakeWiredAgent is the Dispatcher's wake_agent. It takes the target's own
 *   saved access, as every other wake does, and nothing from the caller:
 *   spawnAgent resolves the permission mode from the target's project and caps
 *   a helper at its orchestrator's ceiling.
 */

import { listDurable } from '../../agent-config';
import { agentRegistry } from '../../agent-registry';
import { getAgentRuntime } from '../../agent-runtime';
import { BUSY_STATES } from '../../agent-runtime/checkpoint-tracker';
import * as agentSystem from '../../agent-system';
import { listHelpersEverywhere } from '../../helper-index';
import { appLog } from '../../log-service';
import * as projectStore from '../../project-store';
import { bindingManager } from '../binding-manager';
import type { McpToolResult } from '../types';
import { broadcastToAllWindows } from '../../../util/ipc-broadcast';
import { IPC } from '../../../../shared/ipc-channels';
import { deliverNow } from './helper-delivery';

function jsonResult(value: unknown, isError = false): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], ...(isError && { isError }) };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Find an agent's durable config across every project. */
export async function findDurableAgentConfig(targetAgentId: string): Promise<{
  agentConfig: Awaited<ReturnType<typeof listDurable>>[number];
  projectPath: string;
} | null> {
  const projects = await projectStore.list();
  for (const proj of projects) {
    const durables = await listDurable(proj.path);
    const found = durables.find(d => d.id === targetAgentId);
    if (found) {
      return { agentConfig: found, projectPath: proj.path };
    }
  }
  return null;
}

/** Live, or registered and still starting. */
function isAlive(agentId: string): boolean {
  return agentSystem.isAgentRunning(agentId) || !!agentRegistry.get(agentId);
}

/** The agent's running helpers, for the result. Reported, never waited on. */
async function runningHelpers(projectPath: string, agentId: string): Promise<Array<{ id: string; name: string }>> {
  try {
    const helpers = await listHelpersEverywhere(projectPath, agentId);
    return helpers
      .filter(({ config }) => agentSystem.isAgentRunning(config.id))
      .map(({ config }) => ({ id: config.id, name: config.name }));
  } catch (err) {
    // telemetry-exempt: logged; the sleep goes on, its result just lists no helpers.
    appLog('core:mcp', 'warn', 'sleep_agent: could not list helpers', { meta: { agentId, error: errorText(err) } });
    return [];
  }
}

/** Why this agent can't be stopped without force, or null when it is idle. */
function turnRefusal(agentId: string, name: string): { reason: string; state?: string; note: string } | null {
  const runtime = getAgentRuntime(agentId);
  if (runtime?.kind !== 'chat') {
    return {
      reason: 'turn_state_unknown',
      note: `${name}'s turn state is unknown: terminal agents don't report it, so it may be mid-turn. ` +
        'To stop it anyway, call sleep_agent again with force: true.',
    };
  }
  const state = runtime.getState();
  if (!BUSY_STATES.has(state)) return null;
  return {
    reason: 'mid_turn',
    state,
    note: `${name} is mid-turn (${state}). Wait for it to finish, ` +
      'or call sleep_agent again with force: true to stop it and lose the turn in progress.',
  };
}

export interface SleepAgentRequest {
  callerId: string;
  targetId: string;
  targetName: string;
  force: boolean;
}

/**
 * Put an agent to sleep. Without `force`, refuses a chat agent mid-turn and
 * any terminal agent, whose turn state is unknown. Returns once the process
 * has exited, and records the caller as who put it to sleep.
 */
export async function sleepAgent({ callerId, targetId, targetName, force }: SleepAgentRequest): Promise<McpToolResult> {
  const target = { agentId: targetId, agentName: targetName };
  if (!isAlive(targetId)) return jsonResult({ ...target, status: 'already_sleeping' });

  try {
    const tracked = agentRegistry.get(targetId);
    const durable = tracked ? null : await findDurableAgentConfig(targetId);
    const projectPath = tracked?.projectPath || durable?.projectPath;
    if (!projectPath) {
      return { content: [{ type: 'text', text: `Could not determine project path for agent ${targetId}.` }], isError: true };
    }

    const helpers = await runningHelpers(projectPath, targetId);
    const helperFields = helpers.length ? { runningHelpers: helpers } : {};

    // A sleep already under way (from here or the app) needs no force: it is waited on.
    if (agentSystem.isAgentStopping(targetId)) {
      await agentSystem.waitForAgentStopped(targetId);
    } else {
      const refusal = force ? null : turnRefusal(targetId, targetName);
      if (refusal) {
        appLog('core:mcp', 'info', 'sleep_agent: refused without force', { meta: { callerId, targetId, reason: refusal.reason } });
        return jsonResult({ ...target, status: 'refused', ...refusal, ...helperFields }, true);
      }
      // The caller's name becomes the target's sleep reason ("put to sleep by …").
      const by = bindingManager.getBindingsForAgent(callerId)[0]?.agentName;
      await agentSystem.killAgent(targetId, projectPath, tracked?.orchestrator || durable?.agentConfig.orchestrator, 'agent_tool', {
        ...(by && { by }),
        waitForExit: true,
      });
    }

    if (agentSystem.isAgentRunning(targetId)) {
      appLog('core:mcp', 'warn', 'sleep_agent: target has not exited', { meta: { callerId, targetId } });
      return jsonResult({
        ...target, status: 'stopping', ...helperFields,
        note: 'It was told to stop but has not exited yet. Check again before waking it.',
      });
    }
    broadcastToAllWindows(IPC.AGENT.AGENT_SLEEPING, targetId);
    appLog('core:mcp', 'info', 'sleep_agent: target put to sleep', { meta: { callerId, targetId, force } });
    return jsonResult({ ...target, status: 'sleeping', ...helperFields });
  } catch (err) {
    // telemetry-exempt: the error reaches the caller as the tool result
    return { content: [{ type: 'text', text: `Failed to sleep agent: ${errorText(err)}` }], isError: true };
  }
}

export interface WakeAgentRequest {
  callerId: string;
  targetId: string;
  targetName: string;
  /** The first prompt, already tagged with who sent it. */
  mission?: string;
}

/** Wakes in progress here: a parallel wake must not spawn the agent too. */
const waking = new Set<string>();

/**
 * Wake an agent, resuming its last session when it has one. An agent that is
 * still stopping is waited on and then woken for real, so the mission goes to
 * a new session instead of the one that is exiting.
 */
export async function wakeWiredAgent({ callerId, targetId, targetName, mission }: WakeAgentRequest): Promise<McpToolResult> {
  const target = { agentId: targetId, agentName: targetName };
  const undelivered = mission ? { messageDelivered: false } : {};
  const stillStopping = () => jsonResult({
    ...target, status: 'stopping', ...undelivered,
    note: 'It is still shutting down. Call wake_agent again once get_status shows it sleeping.',
  });
  const stillStarting = () => jsonResult({
    ...target, status: 'starting', ...undelivered,
    note: 'It is changing state. Check get_status, then use send_message once it is running.',
  });

  if (agentSystem.isAgentStopping(targetId) && !(await agentSystem.waitForAgentStopped(targetId))) return stillStopping();
  if (waking.has(targetId)) return stillStarting();
  if (agentSystem.isAgentRunning(targetId)) {
    // A sleep that began during the wait above.
    if (agentSystem.isAgentStopping(targetId)) return stillStopping();
    const delivery = mission ? await deliverNow(targetId, mission) : undefined;
    if (delivery === 'stopping') return stillStopping();
    return jsonResult({ ...target, status: 'already_running', ...(mission && { messageDelivered: delivery === 'delivered' }) });
  }
  if (isAlive(targetId)) return stillStarting();

  // Claimed before anything is awaited.
  waking.add(targetId);
  let announced = false;
  try {
    // Read after any wait above: the exit just saved the session id this wake resumes.
    const durable = await findDurableAgentConfig(targetId);
    if (!durable) {
      return { content: [{ type: 'text', text: `Could not find durable config for agent ${targetId}.` }], isError: true };
    }
    const { agentConfig, projectPath } = durable;
    const resume = !!agentConfig.lastSessionId;
    announced = true;
    broadcastToAllWindows(IPC.AGENT.AGENT_WAKING, targetId);
    await agentSystem.spawnAgent({
      agentId: targetId,
      projectPath,
      cwd: agentConfig.worktreePath || projectPath,
      kind: 'durable',
      model: agentConfig.model,
      mission,
      orchestrator: agentConfig.orchestrator,
      freeAgentMode: agentConfig.freeAgentMode,
      resume,
      sessionId: resume ? agentConfig.lastSessionId : undefined,
    });
    appLog('core:mcp', 'info', 'wake_agent: target woken', { meta: { callerId, targetId, projectPath, resume } });
    return jsonResult({ ...target, status: 'running', resumed: resume, ...(mission && { messageDelivered: true }) });
  } catch (err) {
    // telemetry-exempt: logged, and the error reaches the caller as the tool result
    const reason = errorText(err);
    if (announced) broadcastToAllWindows(IPC.AGENT.AGENT_WAKE_FAILED, targetId, reason);
    appLog('core:mcp', 'warn', 'wake_agent: could not wake target', { meta: { callerId, targetId, error: reason } });
    return { content: [{ type: 'text', text: `Failed to wake agent: ${reason}` }], isError: true };
  } finally {
    waking.delete(targetId);
  }
}
