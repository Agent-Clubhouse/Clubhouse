/**
 * Which sessions are polling a group project, as far as the app can tell, so a
 * loop paused because Clubhouse MCP went off can be resumed, and nothing else can.
 *
 * Polling is a loop the agent runs itself, and the app can't see inside it. Two
 * things are visible: that this session was told to poll, and that it has called
 * read_bulletin lately. A run counts as live only with both, read within
 * {@link POLLING_LIVE_WINDOW_MS}. So a loop the agent ended itself reads as ended
 * once that passes, and a long turn with no read also reads as ended, which costs
 * that loop its stop and its resume.
 *
 * A session is the agent's nonce, new at every start, and its chat session id, new
 * at a /clear. In memory only: nothing here outlives its session.
 */

import { getAgentRuntime } from './agent-runtime';
import { agentRegistry } from './agent-registry';

/** A loop reads every 60 seconds, so this allows for a few turns of other work. */
export const POLLING_LIVE_WINDOW_MS = 5 * 60_000;

export interface PollingSession {
  nonce: string | undefined;
  sessionId: string | null;
}

interface PollingRun {
  session: PollingSession;
  lastSeenAt: number;
}

const runs = new Map<string, Map<string, PollingRun>>();

/** The session an agent is in now, or null when it isn't running. */
export function currentPollingSession(agentId: string): PollingSession | null {
  const registration = agentRegistry.get(agentId);
  if (!registration) return null;
  return { nonce: registration.nonce, sessionId: getAgentRuntime(agentId)?.getSessionId?.() ?? null };
}

/** A chat session id can arrive after the start, so only two known ids can differ. */
export function isSamePollingSession(a: PollingSession, b: PollingSession): boolean {
  return a.nonce === b.nonce && (a.sessionId === null || b.sessionId === null || a.sessionId === b.sessionId);
}

/** This session was just told to poll this project. */
export function notePollingStart(agentId: string, projectId: string): void {
  const session = currentPollingSession(agentId);
  if (!session) return;
  const byProject = runs.get(agentId) ?? new Map<string, PollingRun>();
  byProject.set(projectId, { session, lastSeenAt: Date.now() });
  runs.set(agentId, byProject);
}

/** This agent read the board. Counts only for a session that was told to poll. */
export function notePollingRead(agentId: string, projectId: string): void {
  const run = runs.get(agentId)?.get(projectId);
  const session = currentPollingSession(agentId);
  if (!run || !session || !isSamePollingSession(run.session, session)) return;
  run.lastSeenAt = Date.now();
  run.session = session;
}

/** Whether this agent's current session looks to be polling this project now. */
export function isPollingLive(agentId: string, projectId: string): boolean {
  const run = runs.get(agentId)?.get(projectId);
  const session = currentPollingSession(agentId);
  return !!run && !!session && isSamePollingSession(run.session, session) && Date.now() - run.lastSeenAt <= POLLING_LIVE_WINDOW_MS;
}

/** The loop was told to stop, for whatever reason. */
export function forgetPollingRun(agentId: string, projectId: string): void {
  const byProject = runs.get(agentId);
  byProject?.delete(projectId);
  if (byProject?.size === 0) runs.delete(agentId);
}

/** Polling was turned off for the project: no member is polling it. */
export function forgetPollingRuns(projectId: string): void {
  for (const agentId of [...runs.keys()]) forgetPollingRun(agentId, projectId);
}

/** For testing. */
export function _resetPollingRunsForTesting(): void {
  runs.clear();
}
