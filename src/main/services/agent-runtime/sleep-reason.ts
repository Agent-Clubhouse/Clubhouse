/**
 * Why a durable agent went to sleep (#2104): an idle timeout, a Stop, another
 * agent's sleep_agent, or the CLI exiting on its own. Saved on the agent's
 * durable config and sent to the renderer, which shows it on the sleeping
 * card and the sidebar hover card.
 */
import type { AgentSleepInfo } from '../../../shared/types';
import type { SessionEndReason } from '../../../shared/chat';
import { IPC } from '../../../shared/ipc-channels';
import { updateDurableConfig } from '../agent-config';
import { appLog } from '../log-service';
import { broadcastToAllWindows } from '../../util/ipc-broadcast';

export interface KillRequest {
  trigger: 'user' | 'agent_tool';
  /** Name of the agent that asked, for agent_tool. */
  by?: string;
}

/** Kill requests not yet matched to an exit, per agent. */
const pendingKills = new Map<string, KillRequest>();

/** Remember who asked for this agent to stop, for the exit that follows. */
export function noteKillRequest(agentId: string, request: KillRequest): void {
  pendingKills.set(agentId, request);
}

/** Read and forget the agent's pending kill request. */
export function takeKillRequest(agentId: string): KillRequest | undefined {
  const request = pendingKills.get(agentId);
  pendingKills.delete(agentId);
  return request;
}

/** The sleep reason for an exit that followed a kill request, or a CLI that exited on its own. */
export function sleepInfoForExit(kill: KillRequest | undefined, exitCode: number, at = new Date()): AgentSleepInfo {
  const time = at.toISOString();
  if (kill?.trigger === 'agent_tool') return { reason: 'agent', at: time, ...(kill.by ? { by: kill.by } : {}) };
  if (kill) return { reason: 'user', at: time };
  return exitCode === 0 ? { reason: 'exited', at: time } : { reason: 'crashed', at: time, exitCode };
}

/** Persist the reason on the durable config and tell the renderer. Never throws. */
export async function recordSleep(projectPath: string, agentId: string, info: AgentSleepInfo): Promise<void> {
  appLog('core:agent', 'info', 'Agent went to sleep', { meta: { agentId, ...info } });
  broadcastToAllWindows(IPC.AGENT.AGENT_SLEEP_REASON, agentId, info);
  try {
    await updateDurableConfig(projectPath, agentId, { lastSleep: info });
  } catch (err) {
    // telemetry-exempt: bookkeeping; the renderer already has the reason for this session.
    appLog('core:agent', 'warn', 'Failed to save sleep reason', {
      meta: { agentId, error: err instanceof Error ? err.message : String(err) },
    });
  }
}

/**
 * Why a chat session ended, as a sleep reason, or undefined when it isn't a
 * sleep (a fallback to the terminal).
 */
export function chatSleepInfo(
  reason: SessionEndReason,
  exitCode: number,
  kill: KillRequest | undefined,
  idleMs: number | undefined,
  at = new Date(),
): AgentSleepInfo | undefined {
  if (reason === 'idle_timeout') {
    return { reason: 'idle', at: at.toISOString(), ...(idleMs ? { idleMinutes: Math.round(idleMs / 60_000) } : {}) };
  }
  if (reason === 'fallback') return undefined;
  // A stop without a request is Clubhouse's own (e.g. quitting): the user's.
  if (reason === 'stopped') return sleepInfoForExit(kill ?? { trigger: 'user' }, exitCode, at);
  return sleepInfoForExit(undefined, reason === 'error' && exitCode === 0 ? 1 : exitCode, at);
}
