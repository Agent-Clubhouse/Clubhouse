import { afterEach, describe, expect, it } from 'vitest';
import type { ChatEvent } from '../../shared/chat';
import {
  CHAIN_WINDOW_MS,
  onAppEvent,
  publishAppEvent,
  publishFromChatEvent,
  publishFromHookEvent,
  resetAppEventBus,
  setAgentChain,
  turnOutcomeFromStopReason,
  type AppEvent,
} from './app-event-bus';

function collect(): AppEvent[] {
  const events: AppEvent[] = [];
  onAppEvent((e) => events.push(e));
  return events;
}

function chat(type: string, data: Record<string, unknown>): ChatEvent {
  return { v: 1, agentId: 'a1', sessionId: 's', seq: 1, ts: 1, type, data } as unknown as ChatEvent;
}

afterEach(() => resetAppEventBus());

describe('app event bus', () => {
  it('stamps and delivers events, and survives a failing listener', () => {
    onAppEvent(() => { throw new Error('boom'); });
    const events = collect();
    publishAppEvent({ type: 'app.started', at: 5 });
    expect(events).toEqual([{ type: 'app.started', at: 5 }]);
  });

  it('unsubscribes', () => {
    const events: AppEvent[] = [];
    const off = onAppEvent((e) => events.push(e));
    off();
    publishAppEvent({ type: 'app.started' });
    expect(events).toEqual([]);
  });

  it('attaches an agent chain within its window and not after', () => {
    const events = collect();
    setAgentChain('a1', ['act1'], 1000);
    publishAppEvent({ type: 'agent.awake', agentId: 'a1', at: 1000 + CHAIN_WINDOW_MS - 1 });
    publishAppEvent({ type: 'agent.awake', agentId: 'a2', at: 1001 });
    publishAppEvent({ type: 'agent.awake', agentId: 'a1', at: 1000 + CHAIN_WINDOW_MS + 1 });
    expect(events.map((e) => e.chain)).toEqual([['act1'], undefined, undefined]);
  });
});

describe('from chat events', () => {
  it('maps turns, waits, errors and compaction', () => {
    const events = collect();
    publishFromChatEvent(chat('turn_started', {}));
    publishFromChatEvent(chat('turn_ended', { stopReason: 'cancelled' }));
    publishFromChatEvent(chat('permission_request', {}));
    publishFromChatEvent(chat('question', {}));
    publishFromChatEvent(chat('error', { message: 'x', willRetry: true }));
    publishFromChatEvent(chat('error', { message: 'bad' }));
    publishFromChatEvent(chat('notice', { code: 'compaction_in_progress' }));
    publishFromChatEvent(chat('notice', { code: 'compacted' }));
    publishFromChatEvent(chat('agent_message', {}));
    expect(events.map((e) => e.type)).toEqual([
      'turn.started', 'turn.ended', 'agent.waiting', 'agent.waiting', 'agent.error', 'agent.compacted',
    ]);
    expect(events[1]).toMatchObject({ outcome: 'interrupted', via: 'chat' });
    expect(events[3]).toMatchObject({ reason: 'question' });
  });

  it('a message from the person ends the action chain on that agent', () => {
    const events = collect();
    setAgentChain('a1', ['act1']);
    publishFromChatEvent(chat('user_message', { source: 'user' }));
    publishAppEvent({ type: 'agent.awake', agentId: 'a1' });
    expect(events[0].chain).toBeUndefined();
  });

  it('maps stop reasons to outcomes', () => {
    expect(turnOutcomeFromStopReason('end_turn')).toBe('completed');
    expect(turnOutcomeFromStopReason('max_tokens')).toBe('completed');
    expect(turnOutcomeFromStopReason('error')).toBe('failed');
    expect(turnOutcomeFromStopReason('cancelled')).toBe('interrupted');
  });
});

describe('from terminal hooks', () => {
  it('starts a turn on the first tool after a stop and ends it at the stop', () => {
    const events = collect();
    publishFromHookEvent('a1', 'pre_tool');
    publishFromHookEvent('a1', 'post_tool');
    publishFromHookEvent('a1', 'pre_tool');
    publishFromHookEvent('a1', 'stop');
    publishFromHookEvent('a1', 'pre_tool');
    publishFromHookEvent('a1', 'permission_request');
    publishFromHookEvent('a1', 'tool_error', 'oops');
    expect(events.map((e) => e.type)).toEqual(['turn.started', 'turn.ended', 'turn.started', 'agent.waiting', 'agent.error']);
    expect(events[1]).toMatchObject({ via: 'hook', outcome: 'completed' });
    expect(events[4]).toMatchObject({ message: 'oops' });
  });
});
