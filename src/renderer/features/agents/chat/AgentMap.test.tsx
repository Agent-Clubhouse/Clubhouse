import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Agent } from '../../../../shared/types';
import type { ChatEvent } from '../../../../shared/chat';
import { foldChatEvents, type ChatViewState } from '../../../stores/chatStore';
import { ChatViewBody } from './ChatView';
import { useChatDraftStore, type ChatActions } from './useChatSession';
import { chatFixture, FEWER_CAPABILITIES, FIXTURE_AGENT_ID, type FixtureProvider } from './fixtures';
import { buildAgentMap } from './view-model';
import { FINISHED_SHOWN, subagentSummary } from './AgentMapPanel';
import { useAgentDetailsStore } from '../details/detailsStore';

const agent: Agent = { id: FIXTURE_AGENT_ID, projectId: 'p', name: 'gallant-swift', kind: 'durable', status: 'running', color: 'emerald' };

const actions: ChatActions = {
  send: vi.fn(async () => ({ delivery: 'prompt' as const })),
  interrupt: vi.fn(async () => true),
  respondPermission: vi.fn(async () => true),
  answerQuestion: vi.fn(async () => true),
  setLevel: vi.fn(async () => true),
};

const fold = (events: ChatEvent[]): ChatViewState => foldChatEvents(undefined, FIXTURE_AGENT_ID, events);
const stateFor = (p: FixtureProvider, mode?: 'full' | 'ids_only' | 'none') => {
  const s = fold(chatFixture(p, 'agent_map'));
  return mode ? { ...s, capabilities: { ...s.capabilities!, subagents: mode } } : s;
};
const renderState = (state: ChatViewState) => render(<ChatViewBody agent={agent} state={state} actions={actions} providerName="P" />);

beforeEach(() => {
  useChatDraftStore.setState({ drafts: {} });
  useAgentDetailsStore.setState({ open: false, focus: null });
});

/** Show Agent details and open its Subagents card. */
function openSubagents() {
  fireEvent.click(screen.getByTestId('agent-details-toggle'));
  fireEvent.click(screen.getByTestId('details-card-subagents-toggle'));
}

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

describe('Subagents card', () => {
  it('answers on one line, then opens to the root agent and both subagents', () => {
    renderState(stateFor('claude'));
    expect(screen.queryByTestId('agent-details')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('agent-details-toggle'));
    expect(screen.getByTestId('details-card-subagents-summary')).toHaveTextContent('1 running · 1 finished');
    expect(screen.queryByTestId('chat-agent-map')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('details-card-subagents-toggle'));
    const panel = screen.getByTestId('chat-agent-map');
    expect(within(panel).getByTestId('agent-map-root')).toHaveTextContent('gallant-swift');
    // Running first, then finished (#3250).
    const nodes = within(panel).getAllByTestId('agent-map-node');
    expect(nodes[0]).toHaveTextContent('code-reviewer');
    // A running subagent shows what it is doing.
    expect(nodes[0]).toHaveTextContent('npx contrast-check');
    expect(within(panel).getByTestId('agent-map-finished-heading')).toHaveTextContent('Finished');
    expect(nodes[1]).toHaveTextContent('Find every consumer of AgentChips');
    expect(nodes[1]).toHaveTextContent('Explore · 12 tools · 41s · 9.8k tok');
    expect(screen.getByTestId('agent-details-toggle')).toHaveAttribute('aria-pressed', 'true');
  });

  it('expands a subagent to its last steps', () => {
    renderState(stateFor('codex'));
    openSubagents();
    const node = screen.getAllByTestId('agent-map-node')[0];
    fireEvent.click(within(node).getByRole('button', { expanded: false }));
    const stream = within(node).getByTestId('agent-map-stream');
    expect(within(stream).getAllByTestId('chat-tool-row')).toHaveLength(2);
    expect(stream).toHaveTextContent('Read ChipStyles.ts');
  });

  it('opens from a subagent card in the conversation, expanded to that subagent', () => {
    renderState(stateFor('claude'));
    const cards = screen.getAllByTestId('chat-subagent');
    fireEvent.click(within(cards[1]).getByTestId('chat-subagent-open-map'));
    expect(screen.getByTestId('details-card-subagents')).toHaveAttribute('data-open', 'true');
    const node = screen.getAllByTestId('agent-map-node')[0];
    expect(within(node).getByRole('button', { expanded: true })).toBeInTheDocument();
    expect(within(node).getByTestId('agent-map-stream')).toBeInTheDocument();
  });

  it('jumps from the card back to the subagent in the conversation', () => {
    vi.useFakeTimers();
    const intoView = vi.fn();
    Element.prototype.scrollIntoView = intoView;
    const scrolled = vi.fn();
    Element.prototype.scrollTo = scrolled;
    renderState(stateFor('claude'));
    openSubagents();
    const node = screen.getAllByTestId('agent-map-node')[1];
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

  it('says names and status are not reported for ids-only drivers, and links inline work to the card', () => {
    renderState(stateFor('claude', 'ids_only'));
    expect(screen.queryByTestId('chat-subagent')).not.toBeInTheDocument();
    const jumps = screen.getAllByTestId('chat-subagent-jump');
    expect(jumps).toHaveLength(2);
    fireEvent.click(jumps[1]);
    const panel = screen.getByTestId('chat-agent-map');
    expect(within(panel).getByTestId('agent-map-ids-only')).toBeInTheDocument();
    const nodes = within(panel).getAllByTestId('agent-map-node');
    expect(nodes.map((n) => n.getAttribute('data-subagent-id'))).toEqual(['sub-2', 'sub-1']);
    expect(within(nodes[0]).getByTestId('agent-map-stream')).toBeInTheDocument();
    expect(nodes[1]).toHaveTextContent('Status not reported');
    expect(within(panel).getByTestId('agent-map-finished-heading')).toHaveTextContent('Earlier');
    expect(screen.getByTestId('details-card-subagents-summary')).toHaveTextContent('2 threads');
  });

  it.each(['none'] as const)('hides the jump links and the Subagents card when subagents are %s', (mode) => {
    renderState(stateFor('claude', mode));
    expect(screen.queryByTestId('chat-subagent-jump')).not.toBeInTheDocument();
    expect(screen.queryByTestId('chat-subagent-open-map')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('agent-details-toggle'));
    // A card the driver can't fill is left out (#2094).
    expect(screen.getByTestId('agent-details')).toBeInTheDocument();
    expect(screen.queryByTestId('details-card-subagents')).not.toBeInTheDocument();
  });

  it('leaves out the Subagents card for a driver that reports none', () => {
    renderState(fold(chatFixture('copilot', 'agent_map', undefined, FEWER_CAPABILITIES)));
    fireEvent.click(screen.getByTestId('agent-details-toggle'));
    expect(screen.getByTestId('agent-details')).toBeInTheDocument();
    expect(screen.queryByTestId('details-card-subagents')).not.toBeInTheDocument();
  });

  it('sums per-turn tokens in the Session card when the driver sends no session total (Copilot)', () => {
    renderState(fold(chatFixture('copilot', 'conversation')));
    fireEvent.click(screen.getByTestId('agent-details-toggle'));
    fireEvent.click(screen.getByTestId('details-card-session-toggle'));
    const session = screen.getByTestId('details-card-session');
    expect(session).not.toHaveTextContent('none yet');
    expect(session).toHaveTextContent(/27(\.0)?k tokens/);
  });

  it('says none yet before there is a subagent', () => {
    renderState(fold(chatFixture('claude', 'conversation')));
    fireEvent.click(screen.getByTestId('agent-details-toggle'));
    expect(screen.getByTestId('details-card-subagents-summary')).toHaveTextContent('none yet');
  });

  it('hides details from its own button', () => {
    renderState(stateFor('claude'));
    openSubagents();
    fireEvent.click(screen.getByTestId('agent-details-close'));
    expect(screen.queryByTestId('agent-details')).not.toBeInTheDocument();
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
    openSubagents();
    const [second, first] = screen.getAllByTestId('agent-map-node');
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
    openSubagents();
    const node = screen.getAllByTestId('agent-map-node').find((n) => n.getAttribute('data-subagent-id') === 'ghost')!;
    fireEvent.click(within(node).getByRole('button', { expanded: false }));
    fireEvent.click(within(node).getByText('Show in conversation'));
    expect(within(node).getByTestId('agent-map-jump-missed')).toHaveTextContent('Not in the loaded conversation.');
  });

  it('hides details on Escape and returns focus to the toolbar button', async () => {
    renderState(stateFor('codex'));
    openSubagents();
    const column = screen.getByTestId('agent-details');
    fireEvent.keyDown(column, { key: 'Escape' });
    expect(screen.queryByTestId('agent-details')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('agent-details-toggle')).toHaveFocus());
  });
});

describe('a long-running orchestrator\'s subagents (#3250)', () => {
  /** The claude fixture plus `extra` finished subagents, oldest first. */
  function withFinished(extra: number, failed = 0): ChatViewState {
    const s = stateFor('claude');
    const subagents = { ...s.subagents };
    for (let i = 0; i < extra; i++) {
      subagents[`old-${i}`] = { subagentId: `old-${i}`, name: `old-${i}`, status: i < failed ? 'failed' as const : 'completed' as const };
    }
    return { ...s, subagents };
  }

  it('says what runs now first, and how many finished', () => {
    expect(subagentSummary(buildAgentMap(withFinished(78, 2)))).toBe('1 running · 79 finished (2 failed)');
    const idle = withFinished(1);
    const settled = { ...idle, subagents: { ...idle.subagents, 'sub-2': { ...idle.subagents['sub-2'], status: 'completed' as const } } };
    expect(subagentSummary(buildAgentMap(settled))).toBe('none running · 3 finished');
  });

  it('lists running first, then the newest finished, with the rest behind Show all', () => {
    renderState(withFinished(8));
    openSubagents();
    const ids = () => screen.getAllByTestId('agent-map-node').map((n) => n.getAttribute('data-subagent-id'));
    expect(ids()).toHaveLength(1 + FINISHED_SHOWN);
    expect(ids()[0]).toBe('sub-2');
    expect(ids().slice(1)).toEqual(['old-7', 'old-6', 'old-5', 'old-4', 'old-3']);
    fireEvent.click(screen.getByTestId('agent-map-show-all'));
    expect(ids()).toHaveLength(10);
    expect(ids()[9]).toBe('sub-1');
    expect(screen.getByTestId('agent-map-show-all')).toHaveTextContent('Show fewer');
    fireEvent.click(screen.getByTestId('agent-map-show-all'));
    expect(ids()).toHaveLength(1 + FINISHED_SHOWN);
  });

  it('shows a finished subagent past the cap when it is opened from the conversation', () => {
    renderState(withFinished(8));
    fireEvent.click(within(screen.getAllByTestId('chat-subagent')[0]).getByTestId('chat-subagent-open-map'));
    const node = screen.getAllByTestId('agent-map-node').find((n) => n.getAttribute('data-subagent-id') === 'sub-1')!;
    expect(within(node).getByRole('button', { expanded: true })).toBeInTheDocument();
  });
});
