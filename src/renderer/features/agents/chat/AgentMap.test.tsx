import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
    const intoView = vi.fn();
    Element.prototype.scrollIntoView = intoView;
    const scrolled = vi.fn();
    Element.prototype.scrollTo = scrolled;
    renderState(stateFor('claude'));
    fireEvent.click(screen.getByTestId('chat-agent-map-toggle'));
    const node = screen.getAllByTestId('agent-map-node')[0];
    fireEvent.click(within(node).getByRole('button', { expanded: false }));
    fireEvent.click(within(node).getByText('Show in conversation'));
    const card = screen.getAllByTestId('chat-subagent')[0];
    expect(card).toHaveAttribute('data-jump-highlight', 'true');
    // Only the stream scrolls; scrollIntoView would also scroll the app shell (window shifts up).
    expect(intoView).not.toHaveBeenCalled();
    expect(scrolled.mock.contexts).toContain(screen.getByTestId('chat-stream'));
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

/** Append events after a fixture, continuing its seq and clock. */
function extend(events: ChatEvent[], ...more: Array<Pick<ChatEvent, 'type' | 'data'> & { turnId?: string }>): ChatEvent[] {
  const last = events[events.length - 1];
  return [...events, ...more.map((m, i) => ({ ...last, seq: last.seq + 1 + i, ts: last.ts + 1000 * (i + 1), type: m.type, data: m.data, turnId: m.turnId }) as ChatEvent)];
}

describe('agent map review fixes', () => {
  it('clears the previous outline when a second jump follows quickly', () => {
    renderState(stateFor('claude'));
    fireEvent.click(screen.getByTestId('chat-agent-map-toggle'));
    const [first, second] = screen.getAllByTestId('agent-map-node');
    fireEvent.click(within(first).getByRole('button', { expanded: false }));
    fireEvent.click(within(first).getByText('Show in conversation'));
    const cards = screen.getAllByTestId('chat-subagent');
    expect(cards[0]).toHaveAttribute('data-jump-highlight', 'true');
    fireEvent.click(within(second).getByRole('button', { expanded: false }));
    fireEvent.click(within(second).getByText('Show in conversation'));
    expect(cards[0]).not.toHaveAttribute('data-jump-highlight');
    expect(cards[0].className).not.toContain('outline');
    expect(cards[1]).toHaveAttribute('data-jump-highlight', 'true');
  });

  it.each([
    ['cancelled', 'cancelled'],
    ['error', 'cancelled'],
    ['end_turn', 'unknown'],
  ] as const)('settles a still-running subagent once the turn ended with %s', (stopReason, expected) => {
    const events = extend(chatFixture('claude', 'agent_map'),
      { type: 'turn_ended', data: { stopReason }, turnId: 'turn-1' },
      { type: 'session_state', data: { state: 'idle' } });
    const map = buildAgentMap(fold(events));
    expect(map.nodes.map((n) => n.status)).toEqual(['completed', expected]);
    expect(map.nodes.some((n) => n.status === 'running')).toBe(false);
  });

  it('settles ids-only subagents with tools still in progress once the agent is idle', () => {
    const events = extend(chatFixture('claude', 'agent_map'), { type: 'turn_ended', data: { stopReason: 'cancelled' }, turnId: 'turn-1' });
    const s = fold(events);
    const map = buildAgentMap({ ...s, capabilities: { ...s.capabilities!, subagents: 'ids_only' } });
    expect(map.nodes[1].status).toBe('cancelled');
  });

  it('says so when the conversation has nothing to jump to', () => {
    const s = stateFor('claude');
    const state = { ...s, subagents: { ...s.subagents, ghost: { subagentId: 'ghost', name: 'ghost', status: 'completed' as const } } };
    renderState(state);
    fireEvent.click(screen.getByTestId('chat-agent-map-toggle'));
    const node = screen.getAllByTestId('agent-map-node').find((n) => n.getAttribute('data-subagent-id') === 'ghost')!;
    fireEvent.click(within(node).getByRole('button', { expanded: false }));
    fireEvent.click(within(node).getByText('Show in conversation'));
    expect(within(node).getByTestId('agent-map-jump-missed')).toHaveTextContent('Not in the loaded conversation.');
  });

  it('ties the toggle to the panel, moves focus in on open and back on close', async () => {
    renderState(stateFor('codex'));
    const toggle = screen.getByTestId('chat-agent-map-toggle');
    fireEvent.click(toggle);
    const panel = screen.getByTestId('chat-agent-map');
    expect(toggle).toHaveAttribute('aria-controls', panel.id);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByLabelText('Close agent map')).toHaveFocus();
    fireEvent.keyDown(panel, { key: 'Escape' });
    expect(screen.queryByTestId('chat-agent-map')).not.toBeInTheDocument();
    await waitFor(() => expect(toggle).toHaveFocus());
  });
});
