/**
 * Agents' raw messages to the Dispatcher (#3043), kept until the Dispatcher
 * passes that agent's news on, so the rewrite step works from the agent's own
 * words. deliverToDispatcher records each one; dispatcher-news takes them.
 *
 * In memory only, with no runtime imports: the delivery path and the group
 * chat both use it without depending on each other.
 */
import type { MessageSender } from '../../../shared/chat';

interface RawMessage {
  agentId: string;
  name: string;
  text: string;
  at: number;
}

/** What each agent sent the Dispatcher that hasn't been passed on yet, oldest first. */
const inbox = new Map<string, RawMessage[]>();
/** Older than this, a message is no longer the one being passed on. */
const RAW_TTL_MS = 6 * 60 * 60 * 1000;
const RAW_PER_AGENT = 5;

/**
 * An agent's message reached the Dispatcher. Kept until the Dispatcher passes
 * that agent's news on, so the rewrite works from the agent's own words.
 */
export function recordAgentMessage(agentId: string, name: string, text: string, at = Date.now()): void {
  if (!text.trim()) return;
  const kept = (inbox.get(agentId) ?? []).filter((m) => at - m.at < RAW_TTL_MS);
  inbox.set(agentId, [...kept, { agentId, name, text, at }].slice(-RAW_PER_AGENT));
}

/** The agent's messages not yet passed on, joined, and forgotten. */
export function takeAgentMessages(agentId: string, now: number): string | undefined {
  const messages = (inbox.get(agentId) ?? []).filter((m) => now - m.at < RAW_TTL_MS);
  inbox.delete(agentId);
  return messages.length ? messages.map((m) => m.text).join('\n\n') : undefined;
}

function latest(list: RawMessage[] | undefined): RawMessage | undefined {
  return list?.[list.length - 1];
}

/** An agent that messaged the Dispatcher lately, by id, or by a name only one of them has. */
export function findInInbox(from: string): MessageSender | null {
  const byId = latest(inbox.get(from));
  if (byId) return { agentId: byId.agentId, name: byId.name };
  const lower = from.toLowerCase();
  const named = [...inbox.values()].map((list) => latest(list)!).filter((m) => m.name.toLowerCase() === lower);
  return named.length === 1 ? { agentId: named[0].agentId, name: named[0].name } : null;
}

/** For tests and resets. */
export function clearAgentMessages(): void {
  inbox.clear();
}
