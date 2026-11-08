/**
 * The Dispatcher's chat reads as a group chat (#3043): the person, the
 * Dispatcher, and brief interjections from agents in their own name and
 * avatar. Nothing else shows: no tool-call rows, thoughts or plans, no JSON,
 * task ids or reply instructions, and no Clubhouse updates, which the
 * Dispatcher puts in its own words.
 *
 * The rules are pure: they narrow the chat store's items for the view, and
 * the transcript keeps everything. useGroupChatContext tells ChatView when
 * they apply.
 */
import { useMemo } from 'react';
import { messageDisplay } from '../../../shared/chat';
import type { RoutedMessagePart } from '../../../shared/chat';
import { cleanChatText } from '../../../shared/dispatcher-chat-noise';
import type { ChatItem, ChatViewState } from '../../stores/chatStore';
import type { Agent } from '../../../shared/types';
import { isDispatcherAgent, useDispatcherStore } from './dispatcherStore';

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

/** One item as the group chat shows it, or null when it isn't shown. */
export function groupChatItem(item: ChatItem, ctx: GroupChatContext): ChatItem | null {
  // A subagent's work is the Dispatcher's own business.
  if ('subagentId' in item && item.subagentId) return null;
  switch (item.kind) {
    case 'tool_call':
    case 'thought':
    case 'plan_document':
      return null;
    case 'turn_end':
      // A turn that ended normally needs no footer; one that failed or was stopped does.
      return item.stopReason === 'end_turn' ? null : item;
    case 'agent_message': {
      const text = cleanChatText(item.text);
      if (!text && !item.streaming) return null;
      return text === item.text ? item : { ...item, text };
    }
    case 'user_message': {
      const display = messageDisplay(item);
      if (display.from === 'you') return item;
      const parts = display.parts
        .filter((part) => isInterjection(part, ctx))
        .map((part) => ({ ...part, text: cleanChatText(part.text) }))
        .filter((part) => part.text);
      return parts.length ? { ...item, routed: parts } : null;
    }
    default:
      return item;
  }
}

/** The chat's items as the group chat shows them. */
export function groupChatItems(items: readonly ChatItem[], ctx: GroupChatContext): ChatItem[] {
  const out: ChatItem[] = [];
  for (const item of items) {
    const shown = groupChatItem(item, ctx);
    if (shown) out.push(shown);
  }
  return out;
}

/** The chat view state as the group chat shows it. The same object when nothing changes. */
export function groupChatState(state: ChatViewState, ctx: GroupChatContext): ChatViewState {
  const items = groupChatItems(state.items, ctx);
  const same = items.length === state.items.length && items.every((item, i) => item === state.items[i]);
  return same ? state : { ...state, items };
}

/** The group chat's context when this agent is the Dispatcher, else null: any other agent's chat shows everything. */
export function useGroupChatContext(agent: Pick<Agent, 'id' | 'projectId'>): GroupChatContext | null {
  const chatId = useDispatcherStore((s) => s.state?.chatAgentId ?? null);
  const coordinatorId = useDispatcherStore((s) => s.state?.agentId ?? null);
  const isDispatcher = isDispatcherAgent(agent) || agent.id === chatId;
  return useMemo(() => {
    if (!isDispatcher) return null;
    const ids = [agent.id, chatId, coordinatorId].filter((id): id is string => !!id);
    return { ownAgentIds: new Set(ids) };
  }, [isDispatcher, agent.id, chatId, coordinatorId]);
}
