/**
 * Subscriptions (#3042): an agent asks to be told when something happens
 * ("tell me when main is pushed"). That becomes an Action the agent owns,
 * with an event trigger and one step that messages the agent. The Dispatcher
 * subscribes to agent events for itself the same way.
 *
 * A subscription is an ordinary Action, so it shows in Settings > Actions,
 * follows the same rights and grants, and can be edited, turned off or
 * deleted like any other. It is marked `subscription` so the list can say
 * "Tell pm" instead of "Message pm".
 *
 * The shape is the owner's, not the caller's: Clubhouse's own actions (owner
 * 'app', #3040) tell the Dispatcher, so hidden upkeep can reuse it.
 */

import { describeTrigger, type ActionNames } from './describe';
import type { ActionStep, ActionTrigger, EventTrigger } from './types';

/** What the message says when the subscriber left no note. */
export const DEFAULT_SUBSCRIPTION_NOTE = 'You asked to be told when this happens.';

/** A subscription waits for events: the other triggers are schedules. */
export function isSubscriptionTrigger(trigger: ActionTrigger): trigger is EventTrigger {
  return trigger.kind === 'event';
}

/**
 * Whether a trigger and steps still make a subscription that tells this
 * agent: an event trigger and one message step to it.
 */
export function isSubscriptionShape(a: { trigger: ActionTrigger; steps: ActionStep[] }, recipientAgentId: string | undefined): boolean {
  if (!recipientAgentId || !isSubscriptionTrigger(a.trigger) || a.steps.length !== 1) return false;
  const step = a.steps[0];
  return step.kind === 'message' && step.agentId === recipientAgentId;
}

/** The one step a subscription runs: message the subscriber, with its note. */
export function subscriptionStep(recipientAgentId: string, note: string | undefined): ActionStep {
  return { kind: 'message', agentId: recipientAgentId, text: note?.trim() || DEFAULT_SUBSCRIPTION_NOTE };
}

/** "Tell pm when web is pushed, pulled or fetched (main)". Editable, like any suggested name. */
export function suggestSubscriptionName(trigger: EventTrigger, recipient: string, names?: ActionNames): string {
  const when = describeTrigger(trigger, names);
  // "When X …" and "X goes idle for …" read as "when …"; "30 minutes after X …" stays as it is.
  const tail = when.startsWith('When ') ? `when ${when.slice(5)}` : trigger.delayMinutes && trigger.event !== 'agent.idle' ? when : `when ${when}`;
  const name = `Tell ${recipient} ${tail}`;
  return name.length > 80 ? `${name.slice(0, 79)}…` : name;
}
