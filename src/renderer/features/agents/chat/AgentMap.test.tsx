import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { Agent } from '../../../../shared/types';
import type { ChatEvent } from '../../../../shared/chat';
import { foldChatEvents, type ChatViewState } from '../../../stores/chatStore';
import { ChatViewBody } from './ChatView';
import { useChatDraftStore, type ChatActions } from './useChatSession';
import { chatFixture, FIXTURE_AGENT_ID, type FixtureProvider } from './fixtures';
import { buildAgentMap } from './view-model';

const agent: Agent = { id: FIXTURE_AGENT_ID, projectId: 'p', name: 'gallant-swift', kind: 'durable', status: 'running', color: 'emerald' };

const actions: ChatActions = {
  send: vi.fn(async () => ({ delivery: 'prompt' as const })),
  interrupt: vi.fn(async () => {}),
  respondPermission: vi.fn(async () => true),
  answerQuestion: vi.fn(async () => true),
  setLevel: vi.fn(async () => {}),
};

const fold = (events: ChatEvent[]): ChatViewState => foldChatEvents(undefined, FIXTURE_AGENT_ID, events);
const stateFor = (p: FixtureProvider, mode?: 'full' | 'ids_only' | 'none') => {
  const s = fold(chatFixture(p, 'agent_map'));
  return mode ? { ...s, capabilities: { ...s.capabilities!, subagents: mode } } : s;
};
const renderState = (state: ChatViewState) => render(<ChatViewBody agent={agent} state={state} actions={actions} providerName="P" />);

beforeEach(() => {
  useChatDraftStore.setState({ drafts: {} });
});

describe('buildAgentMap', () => {
  it.each(['claude', 'codex'] as const)('lists reported subagents in order with status, tools, time and tokens (%s)', (p) => {
    const map = buildAgentMap(stateFor(p));
    expect(map.mode).toBe('full');
    expect(map.nodes.map((n) => [n.label, n.status])).toEqual(
      p === 'claude' ? [['Explore', 'completed'], ['code-reviewer', 'running']] : [['worker-1', 'completed'], ['worker-2', 'running']],
    );
    const [done, running] = map.nodes;
    expect(done).toMatchObject({ toolCount: 12, tokens: 9800, durationMs: 41_000, description: 'Find every consumer of AgentChips' });
    expect(done.items.map((i) => i.kind)).toEqual(['tool_call', 'tool_call', 'agent_message']);
    expect(running.durationMs).toBeUndefined();
    expect(running.toolCount).toBe(2);
    expect(running.activity).toBe('npx contrast-check');
  });

  it('groups work by id with generic labels when only ids are reported', () => {
    const map = buildAgentMap(stateFor('claude', 'ids_only'));
    expect(map.mode).toBe('ids_only');
    expect(map.nodes.map((n) => [n.label, n.status])).toEqual([['Subagent 1', 'unknown'], ['Subagent 2', 'running']]);
    expect(map.nodes[0].description).toBeUndefined();
  });

  it('is empty when the driver reports no subagents', () => {
    expect(buildAgentMap(stateFor('claude', 'none'))).toEqual({ mode: 'none', nodes: [] });
  });

  it('keeps ids the driver tagged but never described', () => {
    const s = stateFor('claude');
    const { ['sub-2']: _dropped, ...subagents } = s.subagents;
    const map = buildAgentMap({ ...s, subagents });
    expect(map.nodes.map((n) => n.label)).toEqual(['Explore', 'Subagent 2']);
  });
});

describe('agent map panel', () => {
  it('opens from the header and shows the root agent and both subagents', () => {
    renderState(stateFor('claude'));
    const toggle = screen.getByTestId('chat-agent-map-toggle');
    expect(toggle).toHaveTextContent('Agents 2');
    expect(screen.queryByTestId('chat-agent-map')).not.toBeInTheDocument();
    fireEvent.click(toggle);
    const panel = screen.getByTestId('chat-agent-map');
    expect(within(panel).getByTestId('agent-map-root')).toHaveTextContent('gallant-swift');
    expect(panel).toHaveTextContent('2 subagents, 1 running');
    const nodes = within(panel).getAllByTestId('agent-map-node');
    expect(nodes[0]).toHaveTextContent('Explore');
    expect(nodes[0]).toHaveTextContent('12 tools · 41s · 9.8k tok');
    expect(nodes[1]).toHaveTextContent('code-reviewer');
    expect(nodes[1]).toHaveTextContent('running');
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
  });

  it('expands a subagent to its own stream', () => {
    renderState(stateFor('codex'));
    fireEvent.click(screen.getByTestId('chat-agent-map-toggle'));
    const node = screen.getAllByTestId('agent-map-node')[1];
    fireEvent.click(within(node).getByRole('button', { expanded: false }));
    const stream = within(node).getByTestId('agent-map-stream');
    expect(within(stream).getAllByTestId('chat-tool-row')).toHaveLength(2);
    expect(stream).toHaveTextContent('Read ChipStyles.ts');
  });

  it('jumps from a subagent card to its node in the map', () => {
    renderState(stateFor('claude'));
    const cards = screen.getAllByTestId('chat-subagent');
    fireEvent.click(within(cards[1]).getByTestId('chat-subagent-open-map'));
    const node = screen.getAllByTestId('agent-map-node')[1];
    expect(within(node).getByRole('button', { expanded: true })).toBeInTheDocument();
    expect(within(node).getByTestId('agent-map-stream')).toBeInTheDocument();
  });

  it('jumps from the map back to the subagent in the conversation', () => {
    vi.useFakeTimers();
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    renderState(stateFor('claude'));
    fireEvent.click(screen.getByTestId('chat-agent-map-toggle'));
    const node = screen.getAllByTestId('agent-map-node')[0];
    fireEvent.click(within(node).getByRole('button', { expanded: false }));
    fireEvent.click(within(node).getByText('Show in conversation'));
    const card = screen.getAllByTestId('chat-subagent')[0];
    expect(card).toHaveAttribute('data-jump-highlight', 'true');
    expect(scrolled).toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(2000); });
    expect(card).not.toHaveAttribute('data-jump-highlight');
    vi.useRealTimers();
  });

  it('says names and status are not reported for ids-only drivers, and links inline work to the map', () => {
    renderState(stateFor('claude', 'ids_only'));
    expect(screen.queryByTestId('chat-subagent')).not.toBeInTheDocument();
    const jumps = screen.getAllByTestId('chat-subagent-jump');
    expect(jumps).toHaveLength(2);
    fireEvent.click(jumps[1]);
    const panel = screen.getByTestId('chat-agent-map');
    expect(within(panel).getByTestId('agent-map-ids-only')).toBeInTheDocument();
    const nodes = within(panel).getAllByTestId('agent-map-node');
    expect(nodes.map((n) => n.getAttribute('data-subagent-id'))).toEqual(['sub-1', 'sub-2']);
    expect(within(nodes[1]).getByTestId('agent-map-stream')).toBeInTheDocument();
    expect(nodes[0]).toHaveTextContent('status not reported');
  });

  it.each(['none'] as const)('hides the map and jump links when subagents are %s', (mode) => {
    renderState(stateFor('claude', mode));
    expect(screen.queryByTestId('chat-agent-map-toggle')).not.toBeInTheDocument();
    expect(screen.queryByTestId('chat-subagent-jump')).not.toBeInTheDocument();
    expect(screen.queryByTestId('chat-subagent-open-map')).not.toBeInTheDocument();
  });

  it('hides the map for the Copilot driver, which reports no subagents', () => {
    renderState(fold(chatFixture('copilot', 'agent_map')));
    expect(screen.queryByTestId('chat-agent-map-toggle')).not.toBeInTheDocument();
  });

  it('hides the map until there is a subagent', () => {
    renderState(fold(chatFixture('claude', 'conversation')));
    expect(screen.queryByTestId('chat-agent-map-toggle')).not.toBeInTheDocument();
  });

  it('closes from its own button', () => {
    renderState(stateFor('claude'));
    fireEvent.click(screen.getByTestId('chat-agent-map-toggle'));
    fireEvent.click(screen.getByLabelText('Close agent map'));
    expect(screen.queryByTestId('chat-agent-map')).not.toBeInTheDocument();
  });
});
