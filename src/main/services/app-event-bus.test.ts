import { afterEach, describe, expect, it } from 'vitest';
import type { ChatEvent } from '../../shared/chat';
import {
  CHAIN_WINDOW_MS,
  onAppEvent,
  publishAppEvent,
  publishFromChatEvent,
  publishFromHookEvent,
  forgetHookTurn,
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
  it('starts a turn at a prompt hook or the first tool, and ends it at Stop', () => {
    const events = collect();
    publishFromHookEvent('a1', { kind: 'notification', rawName: 'UserPromptSubmit' }, 0);
    publishFromHookEvent('a1', { kind: 'pre_tool', rawName: 'PreToolUse' }, 1);
    publishFromHookEvent('a1', { kind: 'stop', rawName: 'Stop' }, 2);
    publishFromHookEvent('a1', { kind: 'pre_tool', rawName: 'PreToolUse' }, 3);
    publishFromHookEvent('a1', { kind: 'post_tool', rawName: 'PostToolUse' }, 4);
    expect(events.map((e) => e.type)).toEqual(['turn.started', 'turn.ended', 'turn.started']);
    expect(events[1]).toMatchObject({ via: 'hook', outcome: 'completed' });
  });

  it('treats a long-silent turn as over (an interrupt runs no Stop hook)', () => {
    const events = collect();
    publishFromHookEvent('a1', { kind: 'pre_tool' }, 0);
    publishFromHookEvent('a1', { kind: 'pre_tool' }, 10 * 60_000);
    expect(events.map((e) => e.type)).toEqual(['turn.started', 'turn.started']);
  });

  it.each([
    ['Interrupt', 'interrupted'],
    ['StopFailure', 'failed'],
  ] as const)('ends a turn once at %s even if Stop follows', (rawName, outcome) => {
    const events = collect();
    publishFromHookEvent('a1', { kind: 'notification', rawName: 'UserPromptSubmit' }, 0);
    publishFromHookEvent('a1', { kind: 'stop', rawName, message: 'Provider detail' }, 1);
    publishFromHookEvent('a1', { kind: 'stop', rawName }, 2);
    publishFromHookEvent('a1', { kind: 'stop', rawName: 'Stop' }, 3);
    expect(events.filter((event) => event.type === 'turn.ended')).toMatchObject([{ outcome }]);
    expect(events.filter((event) => event.type === 'agent.error')).toHaveLength(outcome === 'failed' ? 1 : 0);
  });

  it('deduplicates completion without a start and resets for the next process', () => {
    const events = collect();
    publishFromHookEvent('a1', { kind: 'stop', rawName: 'Stop' });
    publishFromHookEvent('a1', { kind: 'stop', rawName: 'Stop' });
    forgetHookTurn('a1');
    publishFromHookEvent('a1', { kind: 'stop', rawName: 'Stop' });
    expect(events.map((event) => event.type)).toEqual(['turn.ended', 'turn.ended']);
  });

  it.each(['Stop', 'StopFailure', 'Interrupt'])('ignores a late %s from the previous identified turn', (rawName) => {
    const events = collect();
    publishFromHookEvent('a1', { kind: 'notification', rawName: 'UserPromptSubmit', turnId: 'old' }, 0);
    publishFromHookEvent('a1', { kind: 'stop', rawName: 'Stop', turnId: 'old' }, 1);
    publishFromHookEvent('a1', { kind: 'notification', rawName: 'UserPromptSubmit', turnId: 'new' }, 2);
    publishFromHookEvent('a1', { kind: 'stop', rawName, turnId: 'old', message: 'old failure' }, 3);
    publishFromHookEvent('a1', { kind: 'post_tool', turnId: 'old' }, 4);
    publishFromHookEvent('a1', { kind: 'stop', rawName: 'Stop', turnId: 'new' }, 5);
    publishFromHookEvent('a1', { kind: 'post_tool', turnId: 'old' }, 6);
    publishFromHookEvent('a1', { kind: 'stop', rawName, turnId: 'old' }, 7);
    expect(events.map((event) => [event.type, event.at])).toEqual([
      ['turn.started', 0], ['turn.ended', 1], ['turn.started', 2], ['turn.ended', 5],
    ]);
  });

  it('does not reopen an identified turn for duplicate prompts or late tools', () => {
    const events = collect();
    publishFromHookEvent('a1', { kind: 'notification', rawName: 'UserPromptSubmit', turnId: 'one' }, 0);
    publishFromHookEvent('a1', { kind: 'notification', rawName: 'UserPromptSubmit', turnId: 'one' }, 1);
    publishFromHookEvent('a1', { kind: 'stop', rawName: 'Stop', turnId: 'one' }, 2);
    publishFromHookEvent('a1', { kind: 'post_tool', turnId: 'one' }, 3);
    publishFromHookEvent('a1', { kind: 'stop', rawName: 'Stop', turnId: 'one' }, 4);
    publishFromHookEvent('a1', { kind: 'notification', rawName: 'UserPromptSubmit', turnId: 'two' }, 5);
    publishFromHookEvent('a1', { kind: 'stop', rawName: 'Stop', turnId: 'two' }, 6);
    expect(events.map((event) => [event.type, event.at])).toEqual([
      ['turn.started', 0], ['turn.ended', 2], ['turn.started', 5], ['turn.ended', 6],
    ]);
  });

  it('publishes compaction without starting or ending a turn', () => {
    const events = collect();
    publishFromHookEvent('a1', { kind: 'notification', rawName: 'PostCompact' }, 1);
    expect(events).toEqual([{ type: 'agent.compacted', agentId: 'a1', at: 1 }]);
  });

  it('ignores session start, notifications, tool failures and Copilot’s session end', () => {
    const events = collect();
    publishFromHookEvent('a1', { kind: 'notification', rawName: 'SessionStart' });
    publishFromHookEvent('a1', { kind: 'notification', rawName: 'Notification' });
    publishFromHookEvent('a1', { kind: 'tool_error', rawName: 'PostToolUseFailure' });
    publishFromHookEvent('a1', { kind: 'stop', rawName: 'sessionEnd' });
    publishFromHookEvent('a1', { kind: 'stop', rawName: 'SessionEnd', outcome: 'failed' });
    expect(events).toEqual([]);
  });

  it('waits on you for permission requests and question tools', () => {
    const events = collect();
    publishFromHookEvent('a1', { kind: 'permission_request', rawName: 'PermissionRequest' }, 0);
    publishFromHookEvent('a1', { kind: 'pre_tool', toolName: 'AskUserQuestion' }, 1);
    expect(events.filter((e) => e.type === 'agent.waiting').map((e) => e.type === 'agent.waiting' && e.reason)).toEqual(['permission', 'question']);
  });
});
