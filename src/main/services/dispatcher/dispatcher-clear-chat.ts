/**
 * Clear chat (#3043): the Dispatcher's conversation starts over. One long
 * conversation is the rule, compacted by the CLI as it grows; clearing is the
 * person's choice.
 *
 * Only the conversation goes. Memory, the Dispatcher's work, its agents,
 * connections and Actions, and news held for the next check-in all stay. A
 * running chat starts a new conversation at once, with its instructions and
 * memory index written fresh; a sleeping one starts fresh at its next wake.
 *
 * Start fresh (#3240) does the same for the Dispatcher's controller conversation,
 * or for both. The controller conversation's native session is quarantined, so no
 * wake resumes it and no late session end makes it the resume id again.
 * Clubhouse starts the controller fresh on its own when its conversation fails
 * every turn (dispatcher-work-health).
 */
import * as agentConfig from '../agent-config';
import * as agentSystem from '../agent-system';
import { getAgentRuntime } from '../agent-runtime';
import { appLog } from '../log-service';
import { noteNextStartNotice } from '../agent-runtime/stale-session';
import { getDispatcherChatPath, getDispatcherPath } from './dispatcher-paths';
import { getDispatcherAgentId, getDispatcherChatAgentId, prepareDispatcherSessionStart } from './dispatcher-service';
import { endWaitingRequests, waitingRequests, type WaitingRequests } from './dispatcher-requests';
import type { ChatEventDataMap } from '../../../shared/chat';
import type { StartFreshResult, StartFreshScope } from '../../../shared/dispatcher-types';

export type ClearChatResult =
  /** The running chat started a new conversation. */
  | { cleared: 'now' }
  /** The chat was asleep: its next start is a new conversation. */
  | { cleared: 'next_start' };

export interface ClearChatDeps {
  chatAgentId?: () => string | null;
  isRunning?: (agentId: string) => boolean;
  clearContext?: (agentId: string) => Promise<void>;
  forgetSession?: (dir: string, agentId: string) => Promise<void>;
  prepareStart?: (dir: string, agentId: string) => Promise<void>;
}

/** Bumped by every clear, from any surface, so a confirmation read before it goes stale (#3206). */
let clearGeneration = 0;

/** How many times the chat was cleared in this run. A phone's Clear chat confirmation is bound to it. */
export function getClearChatGeneration(): number {
  return clearGeneration;
}

async function clearRunning(agentId: string): Promise<void> {
  const runtime = getAgentRuntime(agentId);
  if (!runtime) throw new Error('The Dispatcher\'s conversation can\'t be cleared right now.');
  await runtime.clearContext();
}

export async function clearDispatcherChat(deps: ClearChatDeps = {}): Promise<ClearChatResult> {
  const chatId = (deps.chatAgentId ?? getDispatcherChatAgentId)();
  if (!chatId) throw new Error('The Dispatcher is not set up yet.');
  const dir = getDispatcherChatPath();
  // Before the clear, so a second request confirmed for the same conversation can't run it again.
  clearGeneration++;
  if ((deps.isRunning ?? agentSystem.isAgentRunning)(chatId)) {
    // The new conversation reads its instructions and memory index as a fresh start does.
    await (deps.prepareStart ?? prepareDispatcherSessionStart)(dir, chatId);
    await (deps.clearContext ?? clearRunning)(chatId);
    appLog('core:dispatcher', 'info', 'Dispatcher chat cleared', { meta: { running: true } });
    return { cleared: 'now' };
  }
  await (deps.forgetSession ?? ((d, id) => agentConfig.updateSessionId(d, id, null)))(dir, chatId);
  appLog('core:dispatcher', 'info', 'Dispatcher chat cleared', { meta: { running: false } });
  return { cleared: 'next_start' };
}

/** Why the controller conversation starts fresh: the person asked, or it failed every turn. */
export type StartFreshReason = 'user' | 'repeated_failures';

export interface StartFreshDeps extends ClearChatDeps {
  workAgentId?: () => string | null;
  /** The controller conversation's native session now, or its saved resume id when it's asleep. */
  workSessionId?: (dir: string, agentId: string) => Promise<string | null>;
  quarantine?: (dir: string, agentId: string, sessionId: string) => Promise<unknown>;
  /** Write a notice into a running agent's conversation. */
  addNotice?: (agentId: string, notice: ChatEventDataMap['notice']) => Promise<void>;
  /** Write a notice into a sleeping agent's next conversation. */
  noteNextStart?: (agentId: string, notice: ChatEventDataMap['notice']) => void;
  clearChat?: () => Promise<ClearChatResult>;
  /** The requests the old controller conversation owes an outcome (#3260), taken before it is replaced. */
  takeWaiting?: () => WaitingRequests;
  /** End those requests, telling the chat. */
  endWaiting?: (waiting: WaitingRequests) => void;
}

const WORK_NOTICE: Record<StartFreshReason, string> = {
  user: 'Started fresh. The previous controller conversation ended and is not resumed again.',
  repeated_failures: 'Started fresh. The previous controller conversation failed every turn, so Clubhouse stopped resuming it.',
};

const CHAT_NOTICE: Record<StartFreshReason, string> = {
  user: 'Dispatcher controller started fresh. Memory, agents, connections, Actions and settings are unchanged. Ask again for anything that was in progress.',
  repeated_failures: 'Dispatcher controller kept failing in its conversation, so it started a fresh one. '
    + 'Memory, agents, connections, Actions and settings are unchanged. Ask again for anything that was in progress.',
};

const BOTH_NOTICE = 'Both Dispatcher conversations started fresh. Memory, agents, connections, Actions and settings are unchanged. Ask again for anything that was in progress.';

async function currentWorkSession(dir: string, agentId: string): Promise<string | null> {
  const live = getAgentRuntime(agentId)?.getNativeSessionId();
  if (live) return live;
  return (await agentConfig.getDurableConfig(dir, agentId))?.lastSessionId ?? null;
}

async function addRunningNotice(agentId: string, notice: ChatEventDataMap['notice']): Promise<void> {
  await getAgentRuntime(agentId)?.addNotice?.(notice);
}

/** Say it in the agent's conversation: now when it runs, else when it next starts. */
async function tell(agentId: string, notice: ChatEventDataMap['notice'], deps: StartFreshDeps): Promise<void> {
  if ((deps.isRunning ?? agentSystem.isAgentRunning)(agentId)) await (deps.addNotice ?? addRunningNotice)(agentId, notice);
  else (deps.noteNextStart ?? noteNextStartNotice)(agentId, notice);
}

/**
 * Start the Dispatcher's controller conversation fresh. Its native session is
 * quarantined first, so the old one can't come back; a running controller
 * then starts a new conversation at once, a sleeping one at its next wake.
 */
export async function startDispatcherWorkFresh(reason: StartFreshReason, deps: StartFreshDeps = {}): Promise<'now' | 'next_start'> {
  const workId = (deps.workAgentId ?? getDispatcherAgentId)();
  if (!workId) throw new Error('The Dispatcher is not set up yet.');
  const dir = getDispatcherPath();
  const sessionId = await (deps.workSessionId ?? currentWorkSession)(dir, workId);
  if (sessionId) await (deps.quarantine ?? agentConfig.quarantineSession)(dir, workId, sessionId);
  else await (deps.forgetSession ?? ((d, id) => agentConfig.updateSessionId(d, id, null)))(dir, workId);
  const notice: ChatEventDataMap['notice'] = { level: reason === 'user' ? 'info' : 'warn', code: 'started_fresh', message: WORK_NOTICE[reason] };
  let result: 'now' | 'next_start';
  if ((deps.isRunning ?? agentSystem.isAgentRunning)(workId)) {
    await (deps.prepareStart ?? prepareDispatcherSessionStart)(dir, workId);
    // Taken first: a hand-off that lands during the clear goes to the new conversation and stays under way.
    const waiting = (deps.takeWaiting ?? waitingRequests)();
    await (deps.clearContext ?? clearRunning)(workId);
    // Its queue and any open turn went with the old conversation: those requests are told as stopped.
    (deps.endWaiting ?? ((w) => { endWaitingRequests('cancelled', w); }))(waiting);
    await (deps.addNotice ?? addRunningNotice)(workId, notice);
    result = 'now';
  } else {
    (deps.noteNextStart ?? noteNextStartNotice)(workId, notice);
    result = 'next_start';
  }
  appLog('core:dispatcher', reason === 'user' ? 'info' : 'warn', 'Dispatcher controller started fresh', { meta: { reason, running: result === 'now', quarantined: !!sessionId } });
  return result;
}

/**
 * Start fresh from the Dispatcher's menu: its controller conversation, or both of
 * its conversations. Only conversations go; memory, agents, connections,
 * Actions and settings stay. The visible chat says what happened.
 */
export async function startDispatcherFresh(scope: StartFreshScope, deps: StartFreshDeps = {}, reason: StartFreshReason = 'user'): Promise<StartFreshResult> {
  const chatId = (deps.chatAgentId ?? getDispatcherChatAgentId)();
  const work = await startDispatcherWorkFresh(reason, deps);
  const level = reason === 'user' ? 'info' : 'warn';
  if (scope === 'both') {
    const chat = (await (deps.clearChat ?? (() => clearDispatcherChat(deps)))()).cleared;
    if (chatId) await tell(chatId, { level, code: 'dispatcher_started_fresh', message: BOTH_NOTICE }, deps);
    return { work, chat };
  }
  if (chatId) await tell(chatId, { level, code: 'dispatcher_work_started_fresh', message: CHAT_NOTICE[reason] }, deps);
  return { work };
}
