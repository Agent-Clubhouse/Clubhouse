import { describe, it, expect } from 'vitest';
import type { ChatEvent, ChatEventDataMap, ChatEventType } from '../../../shared/chat';
import { CHAT_CONTRACT_VERSION } from '../../../shared/chat';
import { chatEventsToText } from './chat-text';

let seq = 0;
function ev<T extends ChatEventType>(type: T, data: ChatEventDataMap[T]): ChatEvent {
  return { v: CHAT_CONTRACT_VERSION, agentId: 'a', sessionId: 's', seq: ++seq, ts: 1, type, data } as ChatEvent;
}

describe('chatEventsToText', () => {
  it('renders messages, tools and markers other agents poll for', () => {
    const text = chatEventsToText([
      ev('user_message', { messageId: 'u', content: [{ type: 'text', text: '[TASK:t1] run tests' }], source: 'mcp', delivery: 'prompt' }),
      ev('tool_call', { toolCallId: 'x', kind: 'execute', title: 'npm test', status: 'in_progress' }),
      ev('tool_call_update', { toolCallId: 'x', status: 'completed' }),
      ev('agent_message', { messageId: 'm', text: 'All green.\nTASK_RESULT:t1 pass' }),
      ev('agent_message_chunk', { messageId: 'm2', text: 'Still ' }),
      ev('agent_message_chunk', { messageId: 'm2', text: 'typing' }),
    ], 50);
    expect(text).toContain('> [TASK:t1] run tests');
    expect(text).toContain('[tool] npm test (in_progress)');
    expect(text).toContain('TASK_RESULT:t1 pass');
    expect(text.endsWith('Still typing')).toBe(true);
  });

  it('notes queued messages removed before delivery (#2413)', () => {
    const text = chatEventsToText([
      ev('user_message', { messageId: 'q', content: [{ type: 'text', text: 'later' }], source: 'user', delivery: 'queued' }),
      ev('queue_removed', { messageIds: ['q'] }),
    ], 50);
    expect(text).toBe('> later\n[removed from queue] 1 message');
  });

  it('keeps only the last N lines', () => {
    const text = chatEventsToText([ev('agent_message', { messageId: 'm', text: 'a\nb\nc\nd' })], 2);
    expect(text).toBe('c\nd');
  });
});
