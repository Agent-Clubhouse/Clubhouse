/**
 * Resuming a CLI session that no longer exists (#2086): the CLI says so and
 * exits. Clubhouse must not keep resuming that id, and must not save one it
 * made up in its place. This module recognizes the "not found" errors and
 * clears the agent's resume id so the next wake starts fresh.
 */
import { stripVTControlCharacters } from 'util';
import { getDurableConfig, updateSessionId } from '../agent-config';
import { appLog } from '../log-service';
import { broadcastToAllWindows } from '../../util/ipc-broadcast';
import { IPC } from '../../../shared/ipc-channels';

/**
 * What each CLI prints when asked to resume a session it doesn't have.
 * Codex: `no rollout found for thread id <id>` (app-server) or `No saved
 * session found with ID <id>` (TUI). Claude Code: `No conversation found with
 * session ID: <id>`. Copilot and the generic forms cover the rest.
 */
const SESSION_NOT_FOUND = [
  /no rollout found/i,
  /no saved session found/i,
  /no conversation found/i,
  /\b(?:session|conversation|thread)\b[^\n]{0,60}\b(?:not found|does not exist|doesn't exist|no longer exists)\b/i,
];

/** True when CLI output or an error message says the session to resume doesn't exist. */
export function isSessionNotFound(text: string | undefined | null): boolean {
  if (!text) return false;
  const plain = stripVTControlCharacters(text);
  return SESSION_NOT_FOUND.some((re) => re.test(plain));
}

/** The last chat start error per agent, for the terminal fallback to read. */
const chatStartFailures = new Map<string, string>();

/** Record why a chat start failed, so the terminal fallback can tell a dead session from other errors. */
export function noteChatStartFailure(agentId: string, error: string): void {
  chatStartFailures.set(agentId, error);
}

/** Read and forget the agent's last chat start error. */
export function takeChatStartFailure(agentId: string): string | undefined {
  const error = chatStartFailures.get(agentId);
  chatStartFailures.delete(agentId);
  return error;
}

/** Why a resume is given up on: the CLI said the session is gone, or the CLI quit right away. */
export type StaleResumeReason = 'not_found' | 'exited_early';

const NOTICE: Record<StaleResumeReason, string> = {
  not_found: "Couldn't resume the previous session because it no longer exists. The next wake starts a new session.",
  exited_early: "Couldn't resume the previous session. The next wake starts a new session; the old one is still listed under Sessions.",
};

/**
 * Clear the agent's resume id after resuming `failedSessionId` failed, and
 * tell the user. Leaves the config alone when the id has moved on since
 * (another run saved a newer one). The session history entry is kept.
 * Returns whether it cleared anything.
 */
export async function clearStaleResume(
  projectPath: string,
  agentId: string,
  failedSessionId: string,
  reason: StaleResumeReason,
): Promise<boolean> {
  const config = await getDurableConfig(projectPath, agentId);
  if (!config || config.lastSessionId !== failedSessionId) return false;
  await updateSessionId(projectPath, agentId, null);
  appLog('core:agent', 'warn', 'Cleared resume id after a failed resume', {
    meta: { agentId, sessionId: failedSessionId, reason },
  });
  broadcastToAllWindows(IPC.CHAT.RUNTIME_NOTICE, agentId, {
    level: 'warn',
    code: reason === 'not_found' ? 'resume_session_missing' : 'resume_failed',
    message: NOTICE[reason],
  });
  return true;
}
