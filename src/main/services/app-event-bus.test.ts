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

  it('ignores session start, notifications, tool failures and Copilot’s session end', () => {
    const events = collect();
    publishFromHookEvent('a1', { kind: 'notification', rawName: 'SessionStart' });
    publishFromHookEvent('a1', { kind: 'notification', rawName: 'Notification' });
    publishFromHookEvent('a1', { kind: 'tool_error', rawName: 'PostToolUseFailure' });
    publishFromHookEvent('a1', { kind: 'stop', rawName: 'sessionEnd' });
    expect(events).toEqual([]);
  });

  it('waits on you for permission requests and question tools', () => {
    const events = collect();
    publishFromHookEvent('a1', { kind: 'permission_request', rawName: 'PermissionRequest' }, 0);
    publishFromHookEvent('a1', { kind: 'pre_tool', toolName: 'AskUserQuestion' }, 1);
    expect(events.filter((e) => e.type === 'agent.waiting').map((e) => e.type === 'agent.waiting' && e.reason)).toEqual(['permission', 'question']);
  });
});
