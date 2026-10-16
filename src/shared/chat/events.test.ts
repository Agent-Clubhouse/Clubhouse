import { describe, it, expect } from 'vitest';
import {
  CHAT_CONTRACT_VERSION,
  CHAT_EVENT_TYPES,
  isChatEvent,
  type ChatEvent,
  type ChatEventDataMap,
  type ChatEventType,
} from './events';
import { MINIMAL_CHAT_CAPABILITIES, PERMISSION_LEVELS } from './capabilities';

// Compile-time: CHAT_EVENT_TYPES and ChatEventDataMap must list the same types.
type MissingFromList = Exclude<keyof ChatEventDataMap, ChatEventType>;
type MissingFromMap = Exclude<ChatEventType, keyof ChatEventDataMap>;
const listMatchesMap: [MissingFromList, MissingFromMap] extends [never, never] ? true : false = true;

function envelope(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    v: CHAT_CONTRACT_VERSION,
    agentId: 'agent-1',
    sessionId: 'session-1',
    seq: 1,
    ts: 1_760_000_000_000,
    type: 'session_state',
    data: { state: 'idle' },
    ...overrides,
  };
}

describe('chat event contract', () => {
  it('keeps the type list and payload map in sync', () => {
    expect(listMatchesMap).toBe(true);
    expect(new Set(CHAT_EVENT_TYPES).size).toBe(CHAT_EVENT_TYPES.length);
  });

  it('accepts a well-formed envelope', () => {
    expect(isChatEvent(envelope())).toBe(true);
  });

  it('narrows on type', () => {
    const value: unknown = envelope({
      type: 'tool_call',
      turnId: 'turn-1',
      data: { toolCallId: 't1', kind: 'execute', title: 'npm test', status: 'in_progress' },
    });
    if (!isChatEvent(value)) throw new Error('expected a chat event');
    const event: ChatEvent = value;
    if (event.type === 'tool_call') {
      expect(event.data.kind).toBe('execute');
    } else {
      throw new Error('expected tool_call');
    }
  });

  it.each([
    ['another contract version', { v: 1 }],
    ['an unknown event type', { type: 'not_a_real_event' }],
    ['a missing sequence number', { seq: undefined }],
    ['a missing session id', { sessionId: undefined }],
    ['a null payload', { data: null }],
  ])('rejects %s', (_label, overrides) => {
    expect(isChatEvent(envelope(overrides))).toBe(false);
  });

  it('rejects non-objects', () => {
    expect(isChatEvent(null)).toBe(false);
    expect(isChatEvent('session_state')).toBe(false);
  });
});

describe('chat capabilities', () => {
  it('starts from a conservative, frozen baseline', () => {
    expect(Object.isFrozen(MINIMAL_CHAT_CAPABILITIES)).toBe(true);
    expect(MINIMAL_CHAT_CAPABILITIES.steer).toBe(false);
    expect(MINIMAL_CHAT_CAPABILITIES.queue).toBe('client');
    expect(MINIMAL_CHAT_CAPABILITIES.liveLevels).toEqual([]);
  });

  it('orders the permission ladder from most to least restrictive', () => {
    expect(PERMISSION_LEVELS).toEqual(['plan', 'ask', 'auto_edit', 'auto', 'full_access']);
  });
});
