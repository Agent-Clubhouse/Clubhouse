/**
 * The Dispatcher's chat reads as a group chat (#3043): the person, the
 * Dispatcher, and brief interjections from agents in their own name and
 * avatar. Nothing else shows: no tool-call rows, thoughts or plans, no JSON,
 * task ids or reply instructions, no normal turn footers, and no Clubhouse
 * updates, which the Dispatcher puts in its own words.
 *
 * One set of rules for every place the chat is drawn. The desktop applies
 * them to its chat items as it draws them (renderer/features/dispatcher/
 * group-chat.ts); a phone draws the chat itself from chat events, so main
 * applies them to the Dispatcher's events before they reach it
 * (`groupChatEvent`). The transcript keeps everything. Any other agent's chat
 * shows everything, on the desktop and on a phone.
 */
import { messageDisplay } from './chat/message-routing';
import type { ChatEvent, MessageSource, RoutedMessagePart, TurnStopReason } from './chat/events';
import { cleanChatText } from './dispatcher-chat-noise';

export interface GroupChatContext {
  /** The Dispatcher's own agents: a message from either is its own words, never an interjection. */
  ownAgentIds: ReadonlySet<string>;
}

/** The sender name a hand-off from the chat carries (dispatcher-channel). */
const OWN_SENDER_NAMES = new Set(['Conversation']);

function isInterjection(part: RoutedMessagePart, ctx: GroupChatContext): boolean {
  if (part.fromClubhouse || !part.sender) return false;
  if (part.sender.agentId && ctx.ownAgentIds.has(part.sender.agentId)) return false;
  return !OWN_SENDER_NAMES.has(part.sender.name);
}

/** A subagent's work is the Dispatcher's own business. */
export function isSubagentWork(value: { subagentId?: string }): boolean {
  return !!value.subagentId;
}

/** A turn that ended normally needs no footer; one that failed or was stopped does. */
export function showsTurnEnd(stopReason: TurnStopReason): boolean {
  return stopReason !== 'end_turn';
}

/** The Dispatcher's reply as the chat shows it, or null when nothing is left. A reply still arriving stays, so the stream doesn't jump. */
export function groupChatReply(text: string, streaming: boolean): string | null {
  const cleaned = cleanChatText(text);
  return cleaned || streaming ? cleaned : null;
}

/**
 * A message the Dispatcher received, as the chat shows it: `'own'` for the
 * person's own, which shows as it is; else the agents' interjections, cleaned,
 * or null when none is left.
 */
export function groupChatMessage(
  message: { source: MessageSource; text: string; routed?: RoutedMessagePart[] },
  ctx: GroupChatContext,
): 'own' | RoutedMessagePart[] | null {
  const display = messageDisplay(message);
  if (display.from === 'you') return 'own';
  const parts = display.parts
    .filter((part) => isInterjection(part, ctx))
    .map((part) => ({ ...part, text: cleanChatText(part.text) }))
    .filter((part) => part.text);
  return parts.length ? parts : null;
}

/** The text a user_message carries, as the chat store reads it. */
function contentText(event: ChatEvent & { type: 'user_message' }): string {
  return event.data.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');
}

/**
 * One of the Dispatcher's chat events as a phone gets it, or null when it
 * isn't sent: the same rules as the desktop's items, on the events they are
 * folded from. Events that move state (turns, the session, the queue,
 * approvals and questions) always go, so a phone's chat keeps working; a
 * phone draws no footer for `turn_ended`. Streamed reply chunks go as they
 * are, and the reply's final `agent_message`, which replaces them, is cleaned.
 */
export function groupChatEvent(event: ChatEvent, ctx: GroupChatContext): ChatEvent | null {
  switch (event.type) {
    case 'tool_call':
    case 'tool_call_update':
    case 'agent_thought':
    case 'agent_thought_chunk':
    case 'plan_document':
    case 'subagent':
      return null;
    case 'agent_message_chunk':
      return isSubagentWork(event.data) ? null : event;
    case 'agent_message': {
      if (isSubagentWork(event.data)) return null;
      // A reply with nothing left still goes, empty, since its chunks may have gone first.
      const text = cleanChatText(event.data.text);
      return text === event.data.text ? event : { ...event, data: { ...event.data, text } };
    }
    case 'user_message': {
      const shown = groupChatMessage({ source: event.data.source, text: contentText(event), routed: event.data.routed }, ctx);
      if (shown === 'own') return event;
      return shown ? { ...event, data: { ...event.data, routed: shown } } : null;
    }
    default:
      return event;
  }
}

/** The Dispatcher's chat events as a phone gets them. */
export function groupChatEvents(events: readonly ChatEvent[], ctx: GroupChatContext): ChatEvent[] {
  const out: ChatEvent[] = [];
  for (const event of events) {
    const shown = groupChatEvent(event, ctx);
    if (shown) out.push(shown);
  }
  return out;
}
