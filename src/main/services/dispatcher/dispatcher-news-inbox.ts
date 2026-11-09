/**
 * Agents that messaged the Dispatcher lately (#3043), so the agent its
 * tell_user names in `from` is found by id or by name. deliverToDispatcher
 * records each one; dispatcher-news looks them up.
 *
 * In memory only, with no runtime imports: the delivery path and the group
 * chat both use it without depending on each other.
 */
import type { MessageSender } from '../../../shared/chat';

interface Seen {
  agentId: string;
  name: string;
  at: number;
}

/** Each agent that messaged the Dispatcher, by id, under the name it last used. */
const inbox = new Map<string, Seen>();
/** Older than this, an agent hasn't messaged lately. */
const SEEN_TTL_MS = 6 * 60 * 60 * 1000;

/** An agent's message reached the Dispatcher. */
export function recordAgentMessage(agentId: string, name: string, at = Date.now()): void {
  inbox.set(agentId, { agentId, name, at });
}

/** An agent that messaged the Dispatcher lately, by id, or by a name only one of them has. */
export function findInInbox(from: string, now = Date.now()): MessageSender | null {
  const recent = [...inbox.values()].filter((m) => now - m.at < SEEN_TTL_MS);
  const byId = recent.find((m) => m.agentId === from);
  if (byId) return { agentId: byId.agentId, name: byId.name };
  const lower = from.toLowerCase();
  const named = recent.filter((m) => m.name.toLowerCase() === lower);
  return named.length === 1 ? { agentId: named[0].agentId, name: named[0].name } : null;
}

/** For tests and resets. */
export function clearAgentMessages(): void {
  inbox.clear();
}
