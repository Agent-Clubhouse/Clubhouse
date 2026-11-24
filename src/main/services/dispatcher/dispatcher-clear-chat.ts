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
 *
 * A running agent whose saved provider changed (#3191 picks, or Runs on) is
 * still on the old CLI, which can't take the new one over. Clearing it there
 * would leave it on the old provider, so both stop it instead and its next
 * start is on the saved provider, with a new conversation. The controller
 * starts again idle at once; the chat starts at its next message. Memory,
 * requests' records and identity stay, as for any clear.
 */
import * as agentConfig from '../agent-config';
import * as agentSystem from '../agent-system';
import { getAgentRuntime } from '../agent-runtime';
import { appLog } from '../log-service';
import { noteNextStartNotice } from '../agent-runtime/stale-session';
import { getDispatcherChatPath, getDispatcherPath } from './dispatcher-paths';
import { agentRegistry } from '../agent-registry';
import type { OrchestratorId } from '../../orchestrators';
import {
  defaultDispatcherOrchestrator, getDispatcherAgentId, getDispatcherChatAgentId, prepareDispatcherSessionStart, wakeDispatcherController,
} from './dispatcher-service';
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
  verifyPolicy?: (dir: string, agentId: string) => Promise<unknown>;
  /** The provider its running session is on. */
  runningProvider?: (agentId: string) => string | undefined;
  /** The provider its record names for its next start. */
  savedProvider?: (dir: string, agentId: string) => Promise<string | undefined>;
  /** Stop a running agent and wait until it has exited. */
  stopRunning?: (dir: string, agentId: string, provider: string) => Promise<void>;
}

/** Restarts under way, one per agent, so a second click joins the first rather than stopping or starting twice. */
const restarting = new Map<string, Promise<unknown>>();

function once<T>(agentId: string, run: () => Promise<T>): Promise<T> {
  const under = restarting.get(agentId);
  if (under) return under as Promise<T>;
  const next = run().finally(() => { if (restarting.get(agentId) === next) restarting.delete(agentId); });
  restarting.set(agentId, next);
  return next;
}

async function savedProviderOf(dir: string, agentId: string): Promise<string | undefined> {
  return (await agentConfig.getDurableConfig(dir, agentId, { forLaunch: true }))?.orchestrator ?? defaultDispatcherOrchestrator();
}

async function stopAndWait(dir: string, agentId: string, provider: string): Promise<void> {
  await agentSystem.killAgent(agentId, dir, provider as OrchestratorId, 'user', { waitForExit: true, throwOnFailure: true });
}

/** Stop it on its old provider, and make sure it did: a failed or unfinished stop throws before anything is written. */
async function stopForProvider(dir: string, agentId: string, provider: string, deps: ClearChatDeps): Promise<void> {
  await (deps.stopRunning ?? stopAndWait)(dir, agentId, provider);
  if ((deps.isRunning ?? agentSystem.isAgentRunning)(agentId)) {
    throw new Error('It didn’t stop, so it still runs on its old provider. Try again.');
  }
}

/** The old provider a running agent is still on, when its record now names another; else null. */
async function staleProvider(dir: string, agentId: string, deps: ClearChatDeps): Promise<string | null> {
  const running = (deps.runningProvider ?? ((id) => agentRegistry.get(id)?.orchestrator))(agentId);
  if (!running) return null;
  const saved = await (deps.savedProvider ?? savedProviderOf)(dir, agentId);
  return saved && saved !== running ? running : null;
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
  return once(chatId, () => clearChatOnce(chatId, deps));
}

async function clearChatOnce(chatId: string, deps: ClearChatDeps): Promise<ClearChatResult> {
  const dir = getDispatcherChatPath();
  await (deps.verifyPolicy ?? ((d, id) => agentConfig.getDurableConfig(d, id, { forLaunch: true })))(dir, chatId);
  // Before the clear, so a second request confirmed for the same conversation can't run it again.
  clearGeneration++;
  if ((deps.isRunning ?? agentSystem.isAgentRunning)(chatId)) {
    const stale = await staleProvider(dir, chatId, deps);
    if (stale) {
      // Nothing is written until the old CLI has stopped. Its next message starts a new chat on the saved
      // provider, prepared as any start is. The record dropped the old CLI's session already; this keeps it so.
      await stopForProvider(dir, chatId, stale, deps);
      await (deps.forgetSession ?? ((d, id) => agentConfig.updateSessionId(d, id, null)))(dir, chatId);
      appLog('core:dispatcher', 'info', 'Dispatcher chat cleared by stopping it, for its new provider', { meta: { from: stale } });
      return { cleared: 'next_start' };
    }
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
  /** Start the stopped controller again, idle. */
  wakeWork?: () => Promise<void>;
  /** Run with hand-offs to the controller held. */
  holdDeliveries?: <T>(workId: string, fn: () => Promise<T>) => Promise<T>;
}

/** Loaded here: the delivery module reaches agent-system and the MCP tools. */
async function holdControllerDeliveries<T>(workId: string, fn: () => Promise<T>): Promise<T> {
  const { holdDispatcherDeliveries } = await import('../clubhouse-mcp/tools/dispatcher-delivery');
  return holdDispatcherDeliveries(workId, fn);
}

/** Start the controller again after a stop. One that won't start now starts at its next message, so that is logged, not thrown. */
async function startControllerAgain(deps: StartFreshDeps): Promise<'now' | 'next_start'> {
  try {
    await (deps.wakeWork ?? wakeDispatcherController)();
    return 'now';
  } catch (err) {
    // telemetry-exempt: logged; it stays asleep and its next message starts it on the saved provider
    appLog('core:dispatcher', 'warn', 'Dispatcher controller stopped for its new provider but did not start again', {
      meta: { error: err instanceof Error ? err.message : String(err) },
    });
    return 'next_start';
  }
}

const WORK_NOTICE: Record<StartFreshReason, string> = {
  user: 'Started fresh. The previous controller conversation ended and is not resumed again.',
  repeated_failures: 'Started fresh. The previous controller conversation failed every turn, so Clubhouse stopped resuming it.',
};

const CHAT_NOTICE: Record<StartFreshReason, string> = {
  user: 'Dispatcher restarted. Memory, agents, connections, Actions and settings are unchanged. Ask again for anything that was in progress.',
  repeated_failures: 'Dispatcher kept failing at its work, so it restarted. '
    + 'Memory, agents, connections, Actions and settings are unchanged. Ask again for anything that was in progress.',
};

const BOTH_NOTICE = 'Dispatcher restarted and started a new chat. Memory, agents, connections, Actions and settings are unchanged. Ask again for anything that was in progress.';

async function currentWorkSession(dir: string, agentId: string): Promise<string | null> {
  const live = getAgentRuntime(agentId)?.getNativeSessionId();
  if (live) return live;
  return (await agentConfig.getDurableConfig(dir, agentId, { forLaunch: true }))?.lastSessionId ?? null;
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
  return once(workId, () => startWorkFreshOnce(workId, reason, deps));
}

async function startWorkFreshOnce(workId: string, reason: StartFreshReason, deps: StartFreshDeps): Promise<'now' | 'next_start'> {
  const dir = getDispatcherPath();
  await (deps.verifyPolicy ?? ((d, id) => agentConfig.getDurableConfig(d, id, { forLaunch: true })))(dir, workId);
  const sessionId = await (deps.workSessionId ?? currentWorkSession)(dir, workId);
  const setAside = async () => {
    if (sessionId) await (deps.quarantine ?? agentConfig.quarantineSession)(dir, workId, sessionId);
    else await (deps.forgetSession ?? ((d, id) => agentConfig.updateSessionId(d, id, null)))(dir, workId);
  };
  const notice: ChatEventDataMap['notice'] = { level: reason === 'user' ? 'info' : 'warn', code: 'started_fresh', message: WORK_NOTICE[reason] };
  const running = (deps.isRunning ?? agentSystem.isAgentRunning)(workId);
  const stale = running ? await staleProvider(dir, workId, deps) : null;
  let result: 'now' | 'next_start';
  if (stale) {
    // Stopped and started again, so it runs on its saved provider: clearing would keep the old CLI. Hand-offs
    // wait meanwhile, and nothing is written until it has stopped, so a stop that fails leaves its session,
    // its resume id and its requests as they were, still on the old provider.
    await (deps.holdDeliveries ?? holdControllerDeliveries)(workId, async () => {
      await stopForProvider(dir, workId, stale, deps);
      await setAside();
      // Taken once it has stopped: every request the old conversation took, up to its last moment, ended with it.
      (deps.endWaiting ?? ((w) => { endWaitingRequests('cancelled', w); }))((deps.takeWaiting ?? waitingRequests)());
      (deps.noteNextStart ?? noteNextStartNotice)(workId, notice);
    });
    // Outside the hold: the start goes through the same delivery queue. A hand-off that waited may have started it already.
    result = await startControllerAgain(deps);
    appLog('core:dispatcher', 'info', 'Dispatcher controller stopped for its new provider', { meta: { from: stale, started: result === 'now' } });
  } else {
    await setAside();
    if (running) {
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
