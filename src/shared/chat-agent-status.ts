import type { Agent, AgentDetailedStatus } from './types';
import type { ChatSessionState } from './chat';

/**
 * Chat agents' status, shared by the renderer's status surfaces and Annex
 * (#2197, #2208). A chat agent's hook-shaped status comes only from tool and
 * permission events (chat-status-bridge), and both the renderer and Annex
 * drop it after 30s, so the chat session's own state decides while it runs.
 */

/**
 * Hook status between tool calls: post_tool and permission_resolved report
 * state 'idle' with message "Thinking" while the turn is still going
 * (agentStatusSlice). That is working, not done.
 */
export function isMidTurn(detailed: Pick<AgentDetailedStatus, 'state' | 'message'> | undefined): boolean {
  return detailed?.state === 'idle' && detailed.message === 'Thinking';
}

/** The detailed-status message of a chat agent waiting on a question. */
export const QUESTION_STATUS_MESSAGE = 'Has a question';

/** Tools that ask the user a question rather than for permission (terminal agents report them as permission requests). */
const QUESTION_TOOLS: ReadonlySet<string> = new Set(['AskUserQuestion']);

/** A waiting status that is a question for the user, not a permission prompt (#2366). */
export function isQuestionStatus(detailed: Pick<AgentDetailedStatus, 'state' | 'message' | 'toolName'> | undefined): boolean {
  if (detailed?.state !== 'needs_permission') return false;
  return detailed.message === QUESTION_STATUS_MESSAGE || (!!detailed.toolName && QUESTION_TOOLS.has(detailed.toolName));
}

/** What is known about an agent's chat session, for status surfaces. */
export interface ChatStatus {
  state: ChatSessionState | null;
  /** ts of the running turn's turn_started. */
  turnStartedAt: number | null;
}

/**
 * Hook-shaped status for an agent a chat runtime runs, from its chat session
 * state: the state the chat header shows. The status bridge only reports
 * tool and permission events, and stale hook status is cleared after 30s
 * (clearStaleStatuses), so during a long tool call or a long think the hook
 * status alone reads as Done mid-turn (#2197). Returns `detailed` unchanged
 * when the chat state can't say (no session yet, sleeping, or an error, which
 * the agent's own status reports).
 */
export function chatDetailedStatus(
  agent: Pick<Agent, 'status'>,
  detailed: AgentDetailedStatus | undefined,
  chat: ChatStatus | undefined,
): AgentDetailedStatus | undefined {
  if (agent.status !== 'running' || !chat?.state) return detailed;
  const at = Math.max(detailed?.timestamp ?? 0, chat.turnStartedAt ?? 0) || Date.now();
  switch (chat.state) {
    case 'running':
      if (detailed?.state === 'working' || detailed?.state === 'tool_error' || isMidTurn(detailed)) return detailed;
      return { state: 'working', message: 'Working', timestamp: at };
    case 'waiting_permission':
      if (detailed?.state === 'needs_permission') return detailed;
      return { state: 'needs_permission', message: 'Needs permission', toolName: detailed?.toolName, timestamp: at };
    case 'waiting_input':
      return { state: 'needs_permission', message: QUESTION_STATUS_MESSAGE, timestamp: at };
    case 'idle':
      if (!detailed || (detailed.state === 'idle' && !isMidTurn(detailed))) return detailed;
      return { state: 'idle', message: 'Idle', timestamp: detailed.timestamp };
    default:
      return detailed;
  }
}
