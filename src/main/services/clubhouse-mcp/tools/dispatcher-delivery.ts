/**
 * Messages from agents to the Dispatcher (#3037, part of #3034). An agent's
 * send_message to the Dispatcher goes through deliverToDispatcher, whether it
 * is running or asleep. A sleeping Dispatcher is woken with the message as its
 * first prompt instead of the call failing.
 *
 * The wake respects the sender's grants (#2921): it needs `agent.wake` on the
 * Dispatcher, which every agent has by default and a person can set to Ask
 * first or Off. Ask first goes to Needs you like any other ask-first call.
 *
 * Deliveries to the Dispatcher run one at a time, so a second message that
 * arrives while the first one is waking it is delivered to the woken session
 * instead of finding a wake in progress.
 *
 * Actions use the same path (#3042). An agent's action wakes the Dispatcher
 * only as far as that agent may. The Dispatcher's own subscriptions, and
 * Clubhouse's actions, send as the Dispatcher itself: waking yourself needs no
 * grant. An action can't wait for an Ask first answer, so it is not delivered.
 *
 * dispatcherInboxId is the one place that says which session takes agents'
 * messages. Today that is the Dispatcher agent itself.
 */

import * as agentConfig from '../../agent-config';
import { agentRegistry } from '../../agent-registry';
import { getAgentRuntime } from '../../agent-runtime';
import * as agentSystem from '../../agent-system';
import { getDispatcherAgentId, getDispatcherPath, isDispatcherAgentId, isDispatcherEnabled, isDispatcherIdentityAgentId } from '../../dispatcher/dispatcher-service';
import { recordAgentMessage } from '../../dispatcher/dispatcher-news-inbox';
import { appLog } from '../../log-service';
import { askFirst } from '../ask-first';
import { decideGrant } from '../grant-check';
import type { GrantCallTarget, GrantDecision } from '../../../../shared/agent-grants';
import type { MessageDelivery, RoutedMessagePart, RuntimeSendOptions } from '../../../../shared/chat';
import type { McpToolResult } from '../types';
import { wakeWiredAgent, type WakeAgentRequest, type DurableAgentLocation } from './agent-lifecycle';

/** The Dispatcher as a connected agent sees it, for the wake grant. */
const DISPATCHER_TARGET: GrantCallTarget = { kind: 'agent', relations: ['connected'], isDispatcher: true };

/** Whether a wire's target is the Dispatcher, asleep or awake. */
export function isDispatcherTarget(targetId: string): boolean {
  return isDispatcherAgentId(targetId);
}

/**
 * The session that takes agents' messages to the Dispatcher. Today the
 * Dispatcher agent itself; the one place to change when that moves.
 */
export function dispatcherInboxId(targetId: string): string {
  return getDispatcherAgentId() ?? targetId;
}

/** The Dispatcher's config, in its own folder: it is in no project. */
async function locateDispatcher(agentId: string): Promise<DurableAgentLocation | null> {
  const projectPath = getDispatcherPath();
  const config = await agentConfig.getDurableConfig(projectPath, agentId);
  return config ? { agentConfig: config, projectPath } : null;
}

/** Whether the sender may wake the Dispatcher: allow, ask first, or refuse. */
export function dispatcherWakeDecision(senderId: string): GrantDecision['outcome'] {
  return decideGrant(senderId, 'agent.wake', DISPATCHER_TARGET).outcome;
}

/** What get_status says about a sleeping Dispatcher to this sender. */
export function sleepingDispatcherHint(senderId: string): string {
  switch (dispatcherWakeDecision(senderId)) {
    case 'allow': return 'Agent is sleeping. send_message wakes it and delivers the message.';
    case 'ask': return 'Agent is sleeping. send_message asks the user to let you wake it first.';
    case 'refuse': return 'Agent is sleeping, and you don\'t have the Clubhouse permission to wake it (agent.wake). Ask the user if you need it.';
  }
}

export interface DispatcherDeliveryRequest {
  senderId: string;
  /** The Dispatcher's id, as the sender's wire names it. */
  targetId: string;
  targetName: string;
  /** The message as the Dispatcher receives it, already tagged with its sender. */
  text: string;
  routed: RoutedMessagePart[];
  taskId: string;
  /** Submit it (send_message's force_submit). A wake always submits: the message is its first prompt. */
  submit: boolean;
  /** The call itself, for an Ask first request the user approves. */
  toolName: string;
  args: Record<string, unknown>;
  /** Sent by an action's step (#3042): nobody can make the call again, so Ask first isn't asked. */
  fromAction?: boolean;
  /** Authenticated membership-owned controller input, admitted under this receiver's own rules. */
  wakeAsReceiver?: true;
  /** Trusted receiver admission, checked after queue waits and before a wake side effect. */
  admission?: () => boolean;
  messageOptions?: Pick<RuntimeSendOptions, 'delivery' | 'actionQueue'>;
}

export type DispatcherDelivery =
  /** `delivery`: how a running Dispatcher took it, when its runtime says. */
  | { delivered: true; woke: boolean; delivery?: MessageDelivery }
  | { delivered: false; text: string };

/** One delivery at a time per Dispatcher session. */
const queues = new Map<string, Promise<unknown>>();

function inOrder<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (queues.get(key) ?? Promise.resolve()).then(fn, fn);
  const tail = run.catch((): void => undefined);
  queues.set(key, tail);
  void tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
  return run;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Deliver a message to the Dispatcher, waking it first when it is asleep.
 * A runtime error while delivering to a running Dispatcher is thrown, as
 * send_message's own delivery does, so the caller reports it the same way.
 */
export function deliverToDispatcher(req: DispatcherDeliveryRequest): Promise<DispatcherDelivery> {
  const inboxId = dispatcherInboxId(req.targetId);
  return inOrder(inboxId, async () => {
    const delivery = await deliver(inboxId, req);
    if (delivery.delivered) recordForGroupChat(req);
    return delivery;
  });
}

/** The shared wake: the Dispatcher lives outside project agent configs. */
function wakeController(req: WakeAgentRequest): Promise<McpToolResult> {
  return wakeWiredAgent({ ...req, targetId: dispatcherInboxId(req.targetId), locate: locateDispatcher });
}

/**
 * Explicit wake, serialized with deliveries. The wire tool declares agent.wake,
 * so callTool checks it (including Ask first) before reaching this function.
 * Clubhouse itself uses the same path to open an idle controller without a prompt.
 */
export function wakeDispatcher(req: WakeAgentRequest): Promise<McpToolResult> {
  const inboxId = dispatcherInboxId(req.targetId);
  return inOrder(inboxId, async () => {
    if (!isDispatcherEnabled()) return { content: [{ type: 'text', text: `${req.targetName} is turned off.` }], isError: true };
    return wakeController(req);
  });
}

/**
 * Note the agent for the group chat (#3043), so the Dispatcher's news can name
 * it. The Dispatcher's chat handing work over isn't news from an agent.
 */
function recordForGroupChat(req: DispatcherDeliveryRequest): void {
  if (isDispatcherIdentityAgentId(req.senderId)) return;
  const name = req.routed.find((p) => p.sender?.agentId === req.senderId)?.sender?.name
    ?? req.routed.find((p) => p.sender)?.sender?.name
    ?? req.senderId;
  recordAgentMessage(req.senderId, name);
}

async function deliver(inboxId: string, req: DispatcherDeliveryRequest): Promise<DispatcherDelivery> {
  if (req.admission && !req.admission()) return { delivered: false, text: 'The controller connection was revoked before delivery.' };
  const { senderId, targetName } = req;
  const meta = { sourceAgent: senderId, targetAgent: inboxId, taskId: req.taskId };

  // Running and not on its way out: deliver as send_message does to any agent.
  if (agentRegistry.get(inboxId) && !agentSystem.isAgentStopping(inboxId)) {
    const runtime = getAgentRuntime(inboxId);
    if (!runtime) return { delivered: false, text: `${targetName}'s runtime does not support input.` };
    if (req.wakeAsReceiver && runtime.kind === 'chat' && (runtime.getState() !== 'idle' || runtime.hasPendingWork?.())) {
      return { delivered: false, text: 'The receiving controller is not ready for remote input.' };
    }
    const sent = await runtime.sendMessage(req.text, {
      source: req.messageOptions ? 'action' : 'mcp', taskId: req.taskId, submit: req.submit, routed: req.routed,
      ...(req.messageOptions && { delivery: 'queued', ...req.messageOptions }),
    });
    return { delivered: true, woke: false, ...(sent?.delivery && { delivery: sent.delivery }) };
  }

  if (!isDispatcherEnabled()) {
    return { delivered: false, text: `${targetName} is turned off, so the message was not delivered.` };
  }

  // The Dispatcher's own subscription (or Clubhouse acting for it) wakes itself: no grant to check.
  const decision = senderId === inboxId || req.wakeAsReceiver ? 'allow' : dispatcherWakeDecision(senderId);
  switch (decision) {
    case 'refuse':
      appLog('core:mcp', 'info', 'send_message: sender may not wake the Dispatcher', { meta });
      return {
        delivered: false,
        text: `${targetName} is asleep, and you don't have the Clubhouse permission to wake it (agent.wake on the Dispatcher), `
          + 'so the message was not delivered. Only the user can grant it; ask them if you need it.',
      };
    case 'ask': {
      if (req.fromAction) {
        appLog('core:mcp', 'info', 'send_message: an action may not wake the Dispatcher without asking', { meta });
        return {
          delivered: false,
          text: `${targetName} is asleep, and waking it asks the user first (agent.wake on the Dispatcher), so an action can't wake it.`,
        };
      }
      const outcome = await askFirst(senderId, req.toolName, req.args, [{ action: 'agent.wake', where: 'the Dispatcher' }]);
      if (outcome.kind === 'asked') return { delivered: false, text: `${targetName} is asleep, so the message was not delivered. ${outcome.text}` };
      break;
    }
    case 'allow':
      break;
  }

  appLog('core:mcp', 'info', 'send_message: waking the Dispatcher to deliver', { meta });
  const result = await wakeController({
    callerId: req.wakeAsReceiver ? inboxId : senderId, targetId: inboxId, targetName, mission: req.text, missionRouted: req.routed,
    ...(req.admission && { admission: req.admission }),
  });
  const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
  if (result.isError) {
    appLog('core:mcp', 'warn', 'send_message: the Dispatcher could not be woken', { meta: { ...meta, error: text } });
    return { delivered: false, text: `${targetName} is asleep and could not be started, so the message was not delivered. ${text}` };
  }
  let status: unknown;
  let messageDelivered: unknown;
  try {
    ({ status, messageDelivered } = JSON.parse(text) as { status?: unknown; messageDelivered?: unknown });
  } catch (err) {
    // telemetry-exempt: wakeWiredAgent always answers JSON when it succeeds; reported to the sender as undelivered
    appLog('core:mcp', 'warn', 'send_message: unreadable wake result', { meta: { ...meta, error: errorText(err) } });
  }
  if (messageDelivered === true) return { delivered: true, woke: status === 'running' };
  return {
    delivered: false,
    text: `${targetName} is ${status === 'stopping' ? 'shutting down' : 'starting'} right now, so the message was not delivered. Try again in a moment.`,
  };
}

/** For tests. */
export function _resetDispatcherDeliveryForTesting(): void {
  queues.clear();
}
