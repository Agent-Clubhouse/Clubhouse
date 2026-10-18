import { describe, it, expect, vi } from 'vitest';
import type { ChatEvent, ChatEventDataMap, ChatEventType } from '../../../shared/chat';
import { CHAT_CONTRACT_VERSION } from '../../../shared/chat';
import { createStatusBridge } from './chat-status-bridge';

let seq = 0;
function ev<T extends ChatEventType>(type: T, data: ChatEventDataMap[T]): ChatEvent {
  return { v: CHAT_CONTRACT_VERSION, agentId: 'a1', sessionId: 's', seq: ++seq, ts: 5, type, data } as ChatEvent;
}

describe('chat status bridge', () => {
  it('derives hook-shaped status from chat events', () => {
    const emit = vi.fn();
    const bridge = createStatusBridge(emit);
    bridge(ev('tool_call', { toolCallId: 't1', kind: 'execute', title: 'Running tests', status: 'in_progress', toolName: 'Bash' }));
    bridge(ev('tool_call_update', { toolCallId: 't1', status: 'completed' }));
    bridge(ev('permission_request', { requestId: 'p', title: 'Edit file', toolName: 'Edit', options: [] }));
    bridge(ev('permission_resolved', { requestId: 'p', decision: 'allow', by: 'user' }));
    bridge(ev('turn_ended', { stopReason: 'end_turn' }));
    bridge(ev('agent_message_chunk', { messageId: 'm', text: 'hi' }));

    expect(emit.mock.calls.map(([agentId, e]) => [agentId, e.kind, e.toolName])).toEqual([
      ['a1', 'pre_tool', 'Bash'],
      ['a1', 'post_tool', 'Bash'],
      ['a1', 'permission_request', 'Edit'],
      ['a1', 'permission_resolved', undefined],
      ['a1', 'stop', undefined],
    ]);
    expect(emit.mock.calls[0][1].toolVerb).toBe('Running tests');
  });

  it('carries the permission decision, so an allow plays the granted sound', () => {
    const emit = vi.fn();
    const bridge = createStatusBridge(emit);
    bridge(ev('permission_resolved', { requestId: 'p1', decision: 'allow', by: 'user' }));
    bridge(ev('permission_resolved', { requestId: 'p2', decision: 'deny', by: 'user' }));
    bridge(ev('permission_resolved', { requestId: 'p3', decision: 'cancelled', by: 'user' }));
    expect(emit.mock.calls.map(([, e]) => e.message)).toEqual(['allow', 'deny', 'deny']);
  });

  it('reports failures as tool errors and ignores non-fatal errors', () => {
    const emit = vi.fn();
    const bridge = createStatusBridge(emit);
    bridge(ev('tool_call', { toolCallId: 't2', kind: 'edit', title: 'Edit', status: 'pending' }));
    bridge(ev('tool_call_update', { toolCallId: 't2', status: 'failed', error: 'denied' }));
    bridge(ev('error', { code: 'rate_limited', message: 'slow down', fatal: false, willRetry: true }));
    bridge(ev('error', { code: 'auth', message: 'login required', fatal: true }));
    expect(emit.mock.calls.map(([, e]) => [e.kind, e.message])).toEqual([
      ['pre_tool', undefined],
      ['tool_error', 'denied'],
      ['tool_error', 'login required'],
    ]);
  });
});
