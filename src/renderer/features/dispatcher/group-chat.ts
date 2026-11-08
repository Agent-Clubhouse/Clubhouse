/**
 * The Dispatcher's group chat (#3043) on the desktop: the shared rules
 * (shared/dispatcher-group-chat.ts) applied to the chat store's items as
 * ChatView draws them. A phone gets the same rules applied in main.
 * useGroupChatContext tells ChatView when they apply.
 */
import { useMemo } from 'react';
import { groupChatMessage, groupChatReply, isSubagentWork, showsTurnEnd, type GroupChatContext } from '../../../shared/dispatcher-group-chat';
import type { ChatItem, ChatViewState } from '../../stores/chatStore';
import type { Agent } from '../../../shared/types';
import { isDispatcherAgent, useDispatcherStore } from './dispatcherStore';

export type { GroupChatContext };

/** One item as the group chat shows it, or null when it isn't shown. */
export function groupChatItem(item: ChatItem, ctx: GroupChatContext): ChatItem | null {
  if ('subagentId' in item && isSubagentWork(item)) return null;
  switch (item.kind) {
    case 'tool_call':
    case 'thought':
    case 'plan_document':
      return null;
    case 'turn_end':
      return showsTurnEnd(item.stopReason) ? item : null;
    case 'agent_message': {
      const text = groupChatReply(item.text, item.streaming);
      if (text === null) return null;
      return text === item.text ? item : { ...item, text };
    }
    case 'user_message': {
      const shown = groupChatMessage(item, ctx);
      if (shown === 'own') return item;
      return shown ? { ...item, routed: shown } : null;
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
