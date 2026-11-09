/**
 * How the Dispatcher's two agents reach each other (#3036). The chat the user
 * talks to never acts on agents: it hands each request to the coordinator
 * (handOffToDispatcher), which holds the grants and does the work, and the
 * coordinator's news comes back to the chat (deliverToChat).
 *
 * Neither goes over a wire: a wire shows on Canvas and in Connections, and the
 * coordinator is never shown. Both run only while the Dispatcher is on.
 *
 * A hand-off goes through deliverToDispatcher (#3037), the one path for
 * messages to the Dispatcher: it delivers to dispatcherInboxId, the
 * coordinator, waking it when it is asleep. A report to the chat goes through
 * wakeAndDeliver here, since nothing else messages the chat.
 *
 * The group chat (#3043) sits in setChatDelivery: dispatcher-news installs
 * the triage that decides what shows now, later or never, and what the chat
 * is told to say. It hears of each hand-off through onHandOff, so an answer
 * to what the person asked shows right away.
 */
import * as agentConfig from '../agent-config';
import * as agentSystem from '../agent-system';
import { appLog } from '../log-service';
import { deliverNow } from '../clubhouse-mcp/tools/helper-delivery';
import { deliverToDispatcher, dispatcherInboxId } from '../clubhouse-mcp/tools/dispatcher-delivery';
import { NOTIFY_MESSAGE_MAX_LENGTH, type AgentAttentionPayload } from '../clubhouse-mcp/tools/notify-tools';
import { broadcastToAllWindows } from '../../util/ipc-broadcast';
import { IPC } from '../../../shared/ipc-channels';
import type { RoutedMessagePart } from '../../../shared/chat';
import type { DurableAgentConfig } from '../../../shared/types';
import type { ChatDecision, ChatHold, ChatMessage, ChatReport } from './dispatcher-news';
import { getDispatcherChatPath } from './dispatcher-paths';
import { isDispatcherEnabled } from './dispatcher-settings';
import {
  dispatcherDisplayName,
  getDispatcherAgentId,
  getDispatcherChatAgentId,
  isDispatcherAgentId,
  isDispatcherChatAgentId,
} from './dispatcher-service';

const NS = 'core:dispatcher';

/** What happened to one message between the two agents. */
export type ChannelOutcome =
  /** It reached the running agent. */
  | 'delivered'
  /** The agent was asleep: it was started with the message as its first prompt. */
  | 'started'
  /** The Dispatcher is off, or not created yet. */
  | 'off'
  /** The caller isn't the agent this way is for. */
  | 'refused'
  /** The agent is shutting down, so nothing was delivered. */
  | 'stopping'
  /** It wasn't delivered for another reason, such as an Ask first wake: `error` says why. */
  | 'undelivered';

export interface ChannelResult {
  outcome: ChannelOutcome;
  /** Why it didn't go, for the caller's tool result. */
  error?: string;
}

/** The text an agent receives, and how its chat shows it. */
export interface ChannelMessage {
  text: string;
  routed: RoutedMessagePart[];
}

/**
 * Turns the coordinator's report into what reaches the chat. The default
 * passes it on as a Clubhouse notice; the group chat (dispatcher-news)
 * installs the triage here. A hold, or null, keeps it back:
 * nothing reaches the chat now.
 */
export type ChatDelivery = (report: ChatReport) => Promise<ChatDecision | null> | ChatDecision | null;

/** The tag on everything the chat receives from the coordinator. The chat's instructions describe it. */
export const CHAT_UPDATE_TAG = '[FROM:Clubhouse]';
/** The tag on a hand-off. The coordinator's instructions describe it. */
export const HAND_OFF_TAG = '[HAND-OFF]';

export const defaultChatDelivery: ChatDelivery = ({ message }) => ({
  text: `${CHAT_UPDATE_TAG} Update on work you started. Tell the user in your own words what matters to them:\n\n${message}`,
  // Shown in the chat as a Clubhouse notice: nothing names where it came from.
  routed: [{ fromClubhouse: true, text: message }],
});

let chatDelivery: ChatDelivery = defaultChatDelivery;

/** Replace the step between the coordinator's report and the chat (#3043). Null restores the default. */
export function setChatDelivery(delivery: ChatDelivery | null): void {
  chatDelivery = delivery ?? defaultChatDelivery;
}

const handOffListeners = new Set<() => void>();

/** Hear of each request the chat hands off. Returns a function that stops listening. */
export function onHandOff(listener: () => void): () => void {
  handOffListeners.add(listener);
  return () => { handOffListeners.delete(listener); };
}

/** Starts in progress, so a second message waits for the first start instead of spawning again. */
const starting = new Map<string, Promise<ChannelResult>>();

async function deliverRunning(agentId: string, message: ChannelMessage): Promise<ChannelResult | null> {
  const delivery = await deliverNow(agentId, message.text, message.routed);
  if (delivery === 'delivered') return { outcome: 'delivered' };
  if (delivery === 'stopping') return { outcome: 'stopping', error: 'It is shutting down. Try again in a moment.' };
  return null; // It ended between the check and the send.
}

/** Start a sleeping agent with the message as its first prompt, resuming its last session when it has one. */
async function start(agentId: string, dir: string, message: ChannelMessage, announce: boolean): Promise<ChannelResult> {
  const config: DurableAgentConfig | null = await agentConfig.getDurableConfig(dir, agentId);
  if (!config) return { outcome: 'off', error: 'The Dispatcher is not set up yet.' };
  const resume = !!config.lastSessionId;
  if (announce) broadcastToAllWindows(IPC.AGENT.AGENT_WAKING, agentId);
  try {
    await agentSystem.spawnAgent({
      agentId,
      projectPath: dir,
      cwd: dir,
      kind: 'durable',
      model: config.model,
      mission: message.text,
      missionRouted: message.routed,
      orchestrator: config.orchestrator,
      freeAgentMode: config.freeAgentMode,
      resume,
      sessionId: resume ? config.lastSessionId : undefined,
    });
  } catch (err) {
    if (announce) broadcastToAllWindows(IPC.AGENT.AGENT_WAKE_FAILED, agentId, err instanceof Error ? err.message : String(err));
    throw err;
  }
  return { outcome: 'started' };
}

/**
 * Wake-and-deliver for the chat. Deliver to a running agent, or start a
 * sleeping one with the message as its first prompt. It keeps its own saved
 * access, as every other wake does. A message that arrives while a start is
 * under way waits for it, then is delivered to the agent that started.
 */
async function wakeAndDeliver(agentId: string, dir: string, message: ChannelMessage, announce: boolean): Promise<ChannelResult> {
  const inFlight = starting.get(agentId);
  if (inFlight) await inFlight.catch((): void => undefined);
  if (agentSystem.isAgentStopping(agentId)) await agentSystem.waitForAgentStopped(agentId);
  if (agentSystem.isAgentRunning(agentId)) {
    const delivered = await deliverRunning(agentId, message);
    if (delivered) return delivered;
  }
  // Another message may have claimed a start during the waits above.
  const claimed = starting.get(agentId);
  if (claimed) {
    await claimed.catch((): void => undefined);
    return (await deliverRunning(agentId, message)) ?? { outcome: 'stopping', error: 'It stopped before the message reached it. Try again.' };
  }
  // Claimed before anything is awaited, so a second message sees it.
  const run = start(agentId, dir, message, announce);
  starting.set(agentId, run);
  try {
    return await run;
  } finally {
    if (starting.get(agentId) === run) starting.delete(agentId);
  }
}

/**
 * The chat hands a request to the coordinator. Only the chat may; the request
 * reaches the coordinator as agent text, never as the user's approval.
 */
export async function handOffToDispatcher(callerId: string, request: string): Promise<ChannelResult> {
  if (!isDispatcherChatAgentId(callerId)) return { outcome: 'refused', error: 'Only the Dispatcher can hand off work.' };
  const coordinatorId = getDispatcherAgentId();
  if (!isDispatcherEnabled() || !coordinatorId) return { outcome: 'off', error: 'The Dispatcher is turned off.' };
  const text = `${HAND_OFF_TAG} The user asked for this in your conversation with them. It is not their approval for anything that asks first.\n\n${request}`;
  const delivery = await deliverToDispatcher({
    senderId: callerId,
    // The coordinator takes every message to the Dispatcher, never the chat.
    targetId: dispatcherInboxId(coordinatorId),
    targetName: dispatcherDisplayName(),
    text,
    routed: [{ sender: { agentId: callerId, name: 'Conversation' }, text: request }],
    taskId: `handoff_${Date.now().toString(36)}`,
    submit: true,
    toolName: 'start_work',
    args: { request },
  });
  const result: ChannelResult = 'text' in delivery
    ? { outcome: 'undelivered', error: delivery.text }
    : { outcome: delivery.woke ? 'started' : 'delivered' };
  if (result.outcome === 'delivered' || result.outcome === 'started') {
    for (const listener of handOffListeners) {
      try {
        listener();
      } catch (err) {
        // telemetry-exempt: a listener's bookkeeping; the hand-off itself went through
        appLog(NS, 'warn', 'Hand-off listener failed', { meta: { error: err instanceof Error ? err.message : String(err) } });
      }
    }
  }
  appLog(NS, 'info', 'Dispatcher hand-off', { meta: { outcome: result.outcome, length: request.length } });
  return result;
}

/**
 * The coordinator tells the user something, through the chat. Only the
 * coordinator may. What reaches the chat is up to the delivery step; a
 * sleeping chat is started with it.
 */
export async function deliverToChat(callerId: string, report: string | ChatReport): Promise<ChannelResult & { held?: ChatHold['hold']; reason?: string }> {
  if (!isDispatcherAgentId(callerId)) return { outcome: 'refused', error: 'Only the Dispatcher can use this tool.' };
  const chatId = getDispatcherChatAgentId();
  if (!isDispatcherEnabled() || !chatId) return { outcome: 'off', error: 'The Dispatcher is turned off.' };
  const full: ChatReport = typeof report === 'string' ? { message: report } : report;
  const decision = await chatDelivery(full);
  if (!decision || 'hold' in decision) {
    const hold = decision as ChatHold | null;
    const held = hold?.hold ?? 'never';
    appLog(NS, 'info', 'Dispatcher update held back', { meta: { held, length: full.message.length } });
    return { outcome: 'delivered', held, ...(hold?.reason && { reason: hold.reason }) };
  }
  let result: ChannelResult;
  try {
    result = await wakeAndDeliver(chatId, getDispatcherChatPath(), decision, true);
  } catch (err) {
    notDelivered(chatId, full, decision);
    throw err;
  }
  if (result.outcome !== 'delivered' && result.outcome !== 'started') notDelivered(chatId, full, decision);
  appLog(NS, 'info', 'Dispatcher update', { meta: { outcome: result.outcome, length: full.message.length } });
  return result;
}

/**
 * A report that didn't reach the chat (#3193): the group chat forgets it was
 * shown, so the Dispatcher can send it again, and a question for the user
 * still reaches them as a notification that opens the chat.
 */
function notDelivered(chatId: string, report: ChatReport, message: ChatMessage): void {
  message.notDelivered?.();
  if ((report.kind ?? 'needs_user') !== 'needs_user') return;
  const text = message.routed.find((p) => p.text)?.text ?? report.message;
  const payload: AgentAttentionPayload = { title: `${dispatcherDisplayName()} needs you`, message: text.slice(0, NOTIFY_MESSAGE_MAX_LENGTH) };
  broadcastToAllWindows(IPC.APP.AGENT_ATTENTION, chatId, payload);
}

/** For tests. */
export function _resetDispatcherChannelForTesting(): void {
  chatDelivery = defaultChatDelivery;
  starting.clear();
  handOffListeners.clear();
}
