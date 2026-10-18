import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useAgentStore } from '../../stores/agentStore';
import { useChatStore, useChatStatuses } from '../../stores/chatStore';
import { agentDot, withChatStatus } from '../../features/agents/agent-status';
import type { Agent } from '../../../shared/types';
import type { ChatEvent, ChatEventDataMap, ChatEventType } from '../../../shared/chat';

/**
 * #2197: a chat turn ran for minutes while the rail showed Done. The status
 * bridge only reports tool and permission events, and clearStaleStatuses
 * drops hook status after 30s, so a long think between tools read as Done.
 */

const ID = 'durable_chat';
const agent = { id: ID, projectId: 'p1', name: 'radiant-bobcat', kind: 'durable', status: 'running', color: 'blue' } as Agent;

let seq = 0;
function ev<T extends ChatEventType>(type: T, data: ChatEventDataMap[T], turnId?: string): ChatEvent {
  seq += 1;
  return { v: 2, agentId: ID, sessionId: 's1', seq, ts: Date.now(), type, data, ...(turnId && { turnId }) } as ChatEvent;
}

function railDot() {
  const { result } = renderHook(() => useChatStatuses());
  const { agents, agentDetailedStatus } = useAgentStore.getState();
  const detailed = withChatStatus(agents, agentDetailedStatus, result.current);
  return { dot: agentDot(agent, detailed[ID]), detailed: detailed[ID], hookOnly: agentDot(agent, agentDetailedStatus[ID]) };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-18T09:13:29Z'));
  seq = 0;
  useAgentStore.setState({ agents: { [ID]: agent }, agentDetailedStatus: {}, agentSpawnedAt: { [ID]: Date.now() - 33 * 60_000 } });
  useChatStore.setState({ agents: {} });
  useChatStore.getState().applyEvent(ev('session_state', { state: 'running' }));
  useChatStore.getState().applyEvent(ev('turn_started', { trigger: 'prompt' }, 't1'));
});
afterEach(() => vi.useRealTimers());

describe('rail status for a chat agent mid-turn (#2197)', () => {
  it('stays Working after the hook status goes stale between tool calls', () => {
    const turnStartedAt = Date.now();
    act(() => { vi.advanceTimersByTime(30_000); });
    useAgentStore.getState().handleHookEvent(ID, { kind: 'post_tool', toolName: 'execute', timestamp: Date.now() });
    expect(railDot().dot).toBe('working');

    // 55s with no tool event, as at 02:19:59-02:20:54.
    act(() => { vi.advanceTimersByTime(31_000); });
    useAgentStore.getState().clearStaleStatuses();
    const after = railDot();
    // The hook status alone is what drifted to Done.
    expect(useAgentStore.getState().agentDetailedStatus[ID]).toBeUndefined();
    expect(after.hookOnly).toBe('idle');
    expect(after.dot).toBe('working');
    // The row time is the turn's, not the spawn 33 minutes ago.
    expect(after.detailed?.timestamp).toBe(turnStartedAt);
  });

  it('is Working from turn_started, before the first tool event', () => {
    act(() => { vi.advanceTimersByTime(45_000); });
    useAgentStore.getState().clearStaleStatuses();
    expect(railDot().dot).toBe('working');
  });

  it('shows Needs you while a permission or question waits, and Done after the turn ends', () => {
    useChatStore.getState().applyEvent(ev('session_state', { state: 'waiting_input' }));
    expect(railDot().dot).toBe('needs');

    useChatStore.getState().applyEvent(ev('session_state', { state: 'running' }));
    useAgentStore.getState().handleHookEvent(ID, { kind: 'pre_tool', toolName: 'execute', toolVerb: 'Running a command', timestamp: Date.now() });
    expect(railDot().detailed?.message).toBe('Running a command');

    useChatStore.getState().applyEvent(ev('turn_ended', { stopReason: 'end_turn' }, 't1'));
    expect(useChatStore.getState().agents[ID].state).toBe('idle');
    // A tool status left over from the turn doesn't keep the dot green.
    expect(railDot().dot).toBe('idle');
  });

  it('leaves sleeping and terminal agents to their own status', () => {
    useAgentStore.setState({ agents: { [ID]: { ...agent, status: 'sleeping' } } });
    const { result } = renderHook(() => useChatStatuses());
    const detailed = withChatStatus(useAgentStore.getState().agents, {}, result.current);
    expect(detailed[ID]).toBeUndefined();
    expect(withChatStatus({ t: { id: 't', status: 'running' } }, {}, {})).toEqual({});
  });
});
