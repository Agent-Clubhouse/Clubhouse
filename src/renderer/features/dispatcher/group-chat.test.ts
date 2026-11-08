import { describe, expect, it } from 'vitest';
import { createChatViewState, type ChatItem } from '../../stores/chatStore';
import type { RoutedMessagePart } from '../../../shared/chat';
import { groupChatItem, groupChatItems, groupChatState, type GroupChatContext } from './group-chat';

const ctx: GroupChatContext = { ownAgentIds: new Set(['chat', 'coordinator']) };
let n = 0;
const base = () => ({ id: `i${++n}`, sessionId: 's', seq: n, ts: n });

const you = (text: string): ChatItem => ({ ...base(), kind: 'user_message', messageId: `m${n}`, content: [{ type: 'text', text }], text, source: 'user', delivery: 'prompt' });
const routedMessage = (routed: RoutedMessagePart[], text = 'tagged text for the agent'): ChatItem => ({
  ...base(), kind: 'user_message', messageId: `m${n}`, content: [{ type: 'text', text }], text, source: 'mcp', delivery: 'prompt', routed,
});
const said = (text: string, streaming = false): ChatItem => ({ ...base(), kind: 'agent_message', messageId: `a${n}`, text, streaming });
const tool = (): ChatItem => ({
  ...base(), kind: 'tool_call', toolCallId: `t${n}`, title: 'list_agents', toolKind: 'other', status: 'completed', content: [],
} as unknown as ChatItem);

describe('the Dispatcher\'s group chat', () => {
  it('shows the person, the Dispatcher and agents\' interjections, and nothing else', () => {
    const items: ChatItem[] = [
      you('let me know when checkout is fixed'),
      tool(),
      { ...base(), kind: 'thought', messageId: 'th', text: 'checking', streaming: false },
      said('On it.'),
      { ...base(), kind: 'turn_end', stopReason: 'end_turn', durationMs: 900 },
      routedMessage([{ sender: { agentId: 'a1', name: 'webapp-lead' }, text: 'Safari checkout is fixed in #412. All 41 tests pass now.' }]),
      said('That unblocks the release. release-lead is asleep; want me to wake it to tag 1.0?'),
    ];
    const shown = groupChatItems(items, ctx);
    expect(shown.map((i) => i.kind)).toEqual(['user_message', 'agent_message', 'user_message', 'agent_message']);
    const interjection = shown[2] as Extract<ChatItem, { kind: 'user_message' }>;
    expect(interjection.routed).toEqual([{ sender: { agentId: 'a1', name: 'webapp-lead' }, text: 'Safari checkout is fixed in #412. All 41 tests pass now.' }]);
  });

  it('never shows Clubhouse updates, which the Dispatcher says in its own words', () => {
    expect(groupChatItem(routedMessage([{ fromClubhouse: true, text: 'Check-in summary' }]), ctx)).toBeNull();
  });

  it('never shows the Dispatcher\'s own agents as interjections', () => {
    expect(groupChatItem(routedMessage([{ sender: { agentId: 'coordinator', name: 'Dispatcher' }, text: 'x' }]), ctx)).toBeNull();
    expect(groupChatItem(routedMessage([{ sender: { agentId: 'chat', name: 'Conversation' }, text: 'x' }]), ctx)).toBeNull();
    expect(groupChatItem(routedMessage([{ sender: { name: 'Conversation' }, text: 'x' }]), ctx)).toBeNull();
  });

  it('keeps only the interjections of a message with several parts', () => {
    const item = groupChatItem(routedMessage([
      { fromClubhouse: true, text: 'notice' },
      { sender: { agentId: 'a1', name: 'webapp-lead' }, text: 'Fixed it (task_id=t_1abcdef).' },
    ]), ctx) as Extract<ChatItem, { kind: 'user_message' }>;
    expect(item.routed).toEqual([{ sender: { agentId: 'a1', name: 'webapp-lead' }, text: 'Fixed it.' }]);
  });

  it('reads an old message without routing data from its tags, without the reply footer', () => {
    const text = '[TASK:t_1abcdef] [FROM:webapp-lead@shop] Checkout is fixed.\n\n---\nReply to Dispatcher via tool "send_message" with task_id="t_1abcdef". Prefix your response with TASK_RESULT:t_1abcdef.';
    const item = groupChatItem({ ...base(), kind: 'user_message', messageId: 'm', content: [{ type: 'text', text }], text, source: 'mcp', delivery: 'prompt' }, ctx) as Extract<ChatItem, { kind: 'user_message' }>;
    expect(item.routed).toEqual([{ sender: { name: 'webapp-lead' }, text: 'Checkout is fixed.' }]);
  });

  it('cleans tool noise out of the Dispatcher\'s replies, and drops a reply with nothing left', () => {
    expect((groupChatItem(said('Sent it (task_id=t_1abcdef). TASK_RESULT:x'), ctx) as { text: string }).text).toBe('Sent it. TASK_RESULT:x');
    expect(groupChatItem(said('```json\n{"status":"ok"}\n```'), ctx)).toBeNull();
    // A reply still arriving stays, so the stream doesn't jump.
    expect(groupChatItem(said('', true), ctx)).not.toBeNull();
  });

  it('keeps a turn that failed or was stopped, questions, notices and errors', () => {
    const failed: ChatItem = { ...base(), kind: 'turn_end', stopReason: 'error' };
    const notice: ChatItem = { ...base(), kind: 'notice', level: 'info', code: 'context_cleared', message: 'Started a new conversation.' };
    const error: ChatItem = { ...base(), kind: 'error', code: 'x', message: 'boom', fatal: false };
    for (const item of [failed, notice, error]) expect(groupChatItem(item, ctx)).toBe(item);
  });

  it('drops a subagent\'s work', () => {
    expect(groupChatItem({ ...said('sub'), subagentId: 'sa1' } as ChatItem, ctx)).toBeNull();
  });

  it('keeps the same state object when nothing is hidden', () => {
    const state = { ...createChatViewState('chat'), items: [you('hi'), said('Hello.')] };
    expect(groupChatState(state, ctx)).toBe(state);
    const noisy = { ...state, items: [...state.items, tool()] };
    expect(groupChatState(noisy, ctx).items).toHaveLength(2);
  });
});
