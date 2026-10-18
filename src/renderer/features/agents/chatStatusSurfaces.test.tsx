import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, renderHook, screen, within } from '@testing-library/react';
import { useAgentStore } from '../../stores/agentStore';
import { useChatStore } from '../../stores/chatStore';
import { useProjectStore } from '../../stores/projectStore';
import { useQuickAgentStore } from '../../stores/quickAgentStore';
import { useOrchestratorStore } from '../../stores/orchestratorStore';
import { agentDot } from './agent-status';
import { getAgentStatus, onChatStatusChange, useAgentStatus, useAgentStatuses } from './agent-status-store';
import { AgentAvatarWithRing } from './AgentAvatar';
import { AgentListItem } from './AgentListItem';
import { TerminalPaneToolbar } from './pane/AgentPaneToolbar';
import { Dashboard } from '../projects/Dashboard';
import { createAgentsAPI } from '../../plugins/plugin-api-agents';
import { createMockContext } from '../../plugins/testing';
import type { Agent } from '../../../shared/types';
import type { ChatEvent, ChatEventDataMap, ChatEventType } from '../../../shared/chat';

/**
 * #2208: the surfaces #2199 didn't convert read hook status, which
 * clearStaleStatuses drops after 30s without a tool event, so they showed Done
 * mid chat turn. Each now reads the effective status (agent-status-store).
 * Every case runs for a chat agent mid-turn and for a terminal agent, whose
 * status still follows its hooks.
 */

const ID = 'durable_agent';
const agent = { id: ID, projectId: 'p1', name: 'radiant-bobcat', kind: 'durable', status: 'running', color: 'blue' } as Agent;

let seq = 0;
function ev<T extends ChatEventType>(type: T, data: ChatEventDataMap[T], turnId?: string): ChatEvent {
  seq += 1;
  return { v: 2, agentId: ID, sessionId: 's1', seq, ts: Date.now(), type, data, ...(turnId && { turnId }) } as ChatEvent;
}

function advance(ms: number) {
  vi.setSystemTime(Date.now() + ms);
}

function resetStores() {
  seq = 0;
  useProjectStore.setState({ projects: [{ id: 'p1', name: 'proj', path: '/proj' }], activeProjectId: 'p1', projectIcons: {} });
  useAgentStore.setState({
    agents: { [ID]: agent },
    agentDetailedStatus: {},
    agentIcons: {},
    agentSpawnedAt: { [ID]: Date.now() - 10 * 60_000 },
    activeAgentId: null,
  });
  useQuickAgentStore.setState({ completedAgents: {}, selectedCompletedId: null });
  useOrchestratorStore.setState({ enabled: ['claude-code'], allOrchestrators: [] });
  useChatStore.setState({ agents: {} });
}

/** A chat turn that last reported a tool 31s ago, after the renderer's stale sweep. */
function chatTurnQuietFor31s() {
  useChatStore.getState().applyEvent(ev('session_state', { state: 'running' }));
  useChatStore.getState().applyEvent(ev('turn_started', { trigger: 'prompt' }, 't1'));
  useAgentStore.getState().handleHookEvent(ID, { kind: 'post_tool', toolName: 'execute', timestamp: Date.now() });
  advance(31_000);
  act(() => { useAgentStore.getState().clearStaleStatuses(); });
}

/** A terminal agent whose hook status says it's running a tool. */
function terminalWorking() {
  act(() => {
    useAgentStore.getState().handleHookEvent(ID, { kind: 'pre_tool', toolName: 'Bash', toolVerb: 'Running a command', timestamp: Date.now() });
  });
}

/** A terminal agent whose last hook status went stale: Done, as before. */
function terminalStale() {
  terminalWorking();
  advance(31_000);
  act(() => { useAgentStore.getState().clearStaleStatuses(); });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-18T09:13:29Z'));
  resetStores();
});
afterEach(() => vi.useRealTimers());

const cases: Array<{ name: string; setup: () => void; dot: 'working' | 'idle' }> = [
  { name: 'chat agent 31s into a quiet turn', setup: chatTurnQuietFor31s, dot: 'working' },
  { name: 'terminal agent mid tool', setup: terminalWorking, dot: 'working' },
  { name: 'terminal agent with stale hook status', setup: terminalStale, dot: 'idle' },
];

describe.each(cases)('status surfaces: $name', ({ setup, dot }) => {
  const word = dot === 'working' ? 'Working' : 'Done';

  it('the hook status alone reads Done for the chat case (the drift)', () => {
    setup();
    const hookOnly = agentDot(agent, useAgentStore.getState().agentDetailedStatus[ID]);
    const chatCase = !!useChatStore.getState().agents[ID];
    expect(hookOnly).toBe(chatCase ? 'idle' : dot);
  });

  it('useAgentStatus / useAgentStatuses / getAgentStatus', () => {
    setup();
    const one = renderHook(() => useAgentStatus(agent));
    const all = renderHook(() => useAgentStatuses());
    expect(agentDot(agent, one.result.current)).toBe(dot);
    expect(agentDot(agent, all.result.current[ID])).toBe(dot);
    expect(agentDot(agent, getAgentStatus(ID))).toBe(dot);
  });

  it('Dashboard: agent row, avatar ring and Working count', () => {
    setup();
    render(<Dashboard />);
    const row = screen.getByTestId(`dashboard-agent-row-${ID}`);
    expect(row).toHaveTextContent(word);
    expect(!!row.querySelector('.animate-pulse-ring')).toBe(dot === 'working');
    const stat = screen.getAllByText('Working').find((el) => el.previousElementSibling?.className.includes('text-xl'));
    expect(stat?.previousElementSibling).toHaveTextContent(dot === 'working' ? '1' : '0');
  });

  it('avatar ring (AgentAvatarWithRing)', () => {
    setup();
    const { container } = render(<AgentAvatarWithRing agent={agent} />);
    expect(!!container.querySelector('.animate-pulse-ring')).toBe(dot === 'working');
    const ring = container.querySelector('[style*="border"]') as HTMLElement;
    expect(ring.style.border).toContain(dot === 'working' ? '--ctp-success' : '--ctp-info');
  });

  it('agent list item', () => {
    setup();
    const { container } = render(<AgentListItem agent={agent} isActive={false} isThinking={false} onSelect={vi.fn()} />);
    expect(!!container.querySelector('.animate-pulse-ring')).toBe(dot === 'working');
    expect(container).toHaveTextContent(word);
  });

  it('pane toolbar (TerminalPaneToolbar)', () => {
    setup();
    render(<TerminalPaneToolbar agent={agent} />);
    expect(screen.getByTestId('pane-status')).toHaveTextContent(word);
  });

  it('canvas cards and Review, through the plugin API', () => {
    setup();
    const api = createAgentsAPI(createMockContext({ scope: 'app', projectId: undefined, projectPath: undefined }));
    const status = api.getDetailedStatus(ID);
    expect(agentDot(agent, status ?? undefined)).toBe(dot);
  });
});

describe('re-rendering on chat status (#2208)', () => {
  it('plugin onAnyChange fires on a turn start, not on streamed chunks', () => {
    const api = createAgentsAPI(createMockContext({ scope: 'app', projectId: undefined, projectPath: undefined }));
    useChatStore.getState().applyEvent(ev('session_state', { state: 'idle' }));
    const listener = vi.fn();
    const sub = api.onAnyChange(listener);
    useChatStore.getState().applyEvent(ev('turn_started', { trigger: 'prompt' }, 't1'));
    expect(listener).toHaveBeenCalled();
    listener.mockClear();
    useChatStore.getState().applyEvent(ev('agent_message_chunk', { messageId: 'm1', text: 'hi' } as ChatEventDataMap['agent_message_chunk'], 't1'));
    expect(listener).not.toHaveBeenCalled();
    sub.dispose();
  });

  it('onChatStatusChange stops after unsubscribe', () => {
    const listener = vi.fn();
    const off = onChatStatusChange(listener);
    off();
    useChatStore.getState().applyEvent(ev('session_state', { state: 'running' }));
    expect(listener).not.toHaveBeenCalled();
  });

  it('a toolbar already on screen turns Working when a quiet chat turn starts', () => {
    useChatStore.getState().applyEvent(ev('session_state', { state: 'idle' }));
    render(<TerminalPaneToolbar agent={agent} />);
    expect(screen.getByTestId('pane-status')).toHaveTextContent('Done');
    act(() => {
      useChatStore.getState().applyEvent(ev('session_state', { state: 'running' }));
      useChatStore.getState().applyEvent(ev('turn_started', { trigger: 'prompt' }, 't1'));
    });
    advance(45_000);
    act(() => { useAgentStore.getState().clearStaleStatuses(); });
    expect(within(screen.getByTestId('agent-pane-toolbar')).getByTestId('pane-status')).toHaveTextContent('Working');
  });
});
