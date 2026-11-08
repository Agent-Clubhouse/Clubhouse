import { describe, expect, it } from 'vitest';
import type { ChatEvent } from './chat';
import { groupChatEvent, groupChatEvents, groupChatMessage, groupChatReply, showsTurnEnd, type GroupChatContext } from './dispatcher-group-chat';

const ctx: GroupChatContext = { ownAgentIds: new Set(['chat', 'coordinator']) };
let seq = 0;
const ev = (type: string, data: Record<string, unknown>): ChatEvent => ({ v: 2, agentId: 'chat', sessionId: 's', seq: ++seq, ts: seq, type, data }) as ChatEvent;
const message = (text: string, extra: Record<string, unknown> = {}) =>
  ev('user_message', { messageId: `m${seq}`, source: 'mcp', delivery: 'prompt', content: [{ type: 'text', text }], ...extra });

describe('the Dispatcher\'s group chat rules', () => {
  it('drop tool calls, thoughts, plan documents and subagent work from the events a phone gets', () => {
    for (const event of [
      ev('tool_call', { toolCallId: 't', kind: 'other', title: 'list_agents', status: 'pending' }),
      ev('tool_call_update', { toolCallId: 't', status: 'completed' }),
      ev('agent_thought_chunk', { messageId: 'th', text: 'hm' }),
      ev('agent_thought', { messageId: 'th', text: 'hm' }),
      ev('plan_document', { planId: 'p', markdown: '# Plan', status: 'ready' }),
      ev('subagent', { subagentId: 'sa', name: 'Explore', status: 'running' }),
      ev('agent_message_chunk', { messageId: 'a', text: 'x', subagentId: 'sa' }),
      ev('agent_message', { messageId: 'a', text: 'x', subagentId: 'sa' }),
    ]) expect(groupChatEvent(event, ctx), event.type).toBeNull();
  });

  it('keep every event that moves state, as it is, including a normal turn end', () => {
    for (const event of [
      ev('session_started', { driver: 'claude_agent_sdk', provider: 'claude-code', cwd: '/', resumed: false, capabilities: {} }),
      ev('turn_started', { trigger: 'prompt' }),
      ev('turn_ended', { stopReason: 'end_turn' }),
      ev('session_state', { state: 'idle' }),
      ev('queue_state', { queuedMessageIds: [], transition: { messageIds: [], status: 'delivered' } }),
      ev('permission_request', { requestId: 'r', title: 'Run', options: [] }),
      ev('question', { requestId: 'q', questions: [] }),
      ev('notice', { level: 'info', code: 'x', message: 'Started a new conversation.' }),
      ev('agent_message_chunk', { messageId: 'a', text: 'On it (task_id=t_1abcdef)' }),
    ]) expect(groupChatEvent(event, ctx), event.type).toBe(event);
  });

  it('clean the Dispatcher\'s final reply and keep one with nothing left, which replaces its chunks', () => {
    const reply = groupChatEvent(ev('agent_message', { messageId: 'a', text: 'Sent it (task_id=t_1abcdef).' }), ctx);
    expect(reply).toMatchObject({ type: 'agent_message', data: { messageId: 'a', text: 'Sent it.' } });
    expect(groupChatEvent(ev('agent_message', { messageId: 'b', text: '```json\n{"ok":true}\n```' }), ctx)).toMatchObject({ data: { text: '' } });
  });

  it('show the person\'s own messages as they are and agents\' as interjections only', () => {
    const own = ev('user_message', { messageId: 'u', source: 'annex', delivery: 'prompt', content: [{ type: 'text', text: '[FROM:x] mine' }] });
    expect(groupChatEvent(own, ctx)).toBe(own);
    const burst = message('tagged', { routed: [{ fromClubhouse: true, text: 'notice' }, { sender: { agentId: 'a1', name: 'webapp-lead' }, text: 'Fixed (task_id=t_1abcdef).' }] });
    expect(groupChatEvent(burst, ctx)).toMatchObject({ data: { routed: [{ sender: { agentId: 'a1', name: 'webapp-lead' }, text: 'Fixed.' }], content: [{ type: 'text', text: 'tagged' }] } });
    expect(groupChatEvent(message('[Clubhouse] Docs is asleep.'), ctx)).toBeNull();
    expect(groupChatEvent(message('x', { routed: [{ sender: { agentId: 'coordinator', name: 'Dispatcher' }, text: 'x' }] }), ctx)).toBeNull();
    expect(groupChatEvent(ev('user_message', { messageId: 's', source: 'system', delivery: 'prompt', content: [{ type: 'text', text: 'Continued from the terminal.' }] }), ctx)).toBeNull();
    // An old message without routing data, read from its tags across text blocks.
    const old = ev('user_message', { messageId: 'o', source: 'mcp', delivery: 'prompt', content: [{ type: 'text', text: '[FROM:webapp-lead@shop] Checkout is fixed.' }, { type: 'text', text: 'Reply to Dispatcher via tool "send_message".' }] });
    expect(groupChatEvent(old, ctx)).toMatchObject({ data: { routed: [{ sender: { name: 'webapp-lead' }, text: 'Checkout is fixed.' }] } });
  });

  it('are the same rules the desktop draws its items with', () => {
    expect(showsTurnEnd('end_turn')).toBe(false);
    expect(showsTurnEnd('error')).toBe(true);
    expect(groupChatReply('', true)).toBe('');
    expect(groupChatReply('```json\n{}\n```', false)).toBeNull();
    expect(groupChatMessage({ source: 'user', text: 'hi' }, ctx)).toBe('own');
    expect(groupChatMessage({ source: 'mcp', text: '[Clubhouse] x' }, ctx)).toBeNull();
  });

  it('filter a list, keeping order', () => {
    const events = [ev('turn_started', { trigger: 'prompt' }), ev('tool_call', { toolCallId: 't', kind: 'other', title: 'x', status: 'pending' }), ev('turn_ended', { stopReason: 'end_turn' })];
    expect(groupChatEvents(events, ctx).map((e) => e.type)).toEqual(['turn_started', 'turn_ended']);
  });
});
