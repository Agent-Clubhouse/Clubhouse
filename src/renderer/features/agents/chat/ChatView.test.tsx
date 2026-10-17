import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Agent } from '../../../../shared/types';
import type { ChatEvent } from '../../../../shared/chat';
import { foldChatEvents, useChatStore, type ChatViewState } from '../../../stores/chatStore';
import { ChatView, ChatViewBody } from './ChatView';
import type { ChatActions } from './useChatSession';
import { chatFixture, FIXTURE_AGENT_ID, PROFILES, type FixtureProvider } from './fixtures';

const agent: Agent = {
  id: FIXTURE_AGENT_ID,
  projectId: 'proj-1',
  name: 'gallant-swift',
  kind: 'durable',
  status: 'running',
  color: 'emerald',
};

function makeActions(): ChatActions & { [K in keyof ChatActions]: ReturnType<typeof vi.fn> } {
  return {
    send: vi.fn(async () => ({ delivery: 'prompt' as const })),
    interrupt: vi.fn(async () => {}),
    respondPermission: vi.fn(async () => {}),
    answerQuestion: vi.fn(async () => {}),
    setLevel: vi.fn(async () => {}),
  };
}

function fold(events: ChatEvent[]): ChatViewState {
  return foldChatEvents(undefined, FIXTURE_AGENT_ID, events);
}

function renderState(state: ChatViewState, actions = makeActions()) {
  const utils = render(<ChatViewBody agent={agent} state={state} actions={actions} providerName="Provider" onSwitchToTerminal={vi.fn()} />);
  return { ...utils, actions };
}

function renderFixture(p: FixtureProvider, scenario: Parameters<typeof chatFixture>[1], actions = makeActions()) {
  return renderState(fold(chatFixture(p, scenario)), actions);
}

describe('ChatView conversation', () => {
  it.each(['claude', 'codex', 'copilot'] as const)('renders one stream for %s', (p) => {
    renderFixture(p, 'conversation');
    expect(screen.getByTestId('chat-user-message')).toHaveTextContent('The agent list rows are too tall');
    expect(screen.getByTestId('chat-thought')).toHaveTextContent('Thought for 6s');
    expect(screen.getByTestId('chat-explore-group')).toHaveTextContent('Explored 3 files, 2 searches');
    const diffs = screen.getAllByTestId('chat-diff-card');
    expect(diffs).toHaveLength(2);
    expect(diffs[0]).toHaveTextContent('src/renderer/features/agents/AgentListItem.tsx');
    expect(diffs[0]).toHaveTextContent('+3');
    expect(diffs[0]).toHaveTextContent('−2');
    expect(diffs[1]).toHaveTextContent('Created');
    const cmd = screen.getByTestId('chat-command-card');
    expect(cmd).toHaveTextContent('$ npm run typecheck');
    expect(cmd).toHaveTextContent('exit 0');
    expect(cmd).toHaveTextContent('0 errors');
    expect(screen.getAllByTestId('chat-agent-message')).toHaveLength(2);
    expect(screen.getByTestId('chat-turn-footer')).toHaveTextContent('Turn 1');
    expect(screen.getByTestId('chat-turn-footer')).toHaveTextContent('1m 12s');
    expect(screen.getByTestId('chat-state')).toHaveTextContent('Idle');
    expect(screen.getByTestId('chat-context')).toBeInTheDocument();
  });

  it('expands the explore group to show each call', () => {
    renderFixture('claude', 'conversation');
    expect(screen.queryAllByTestId('chat-tool-row')).toHaveLength(0);
    fireEvent.click(within(screen.getByTestId('chat-explore-group')).getByRole('button'));
    expect(screen.getAllByTestId('chat-tool-row')).toHaveLength(5);
  });

  it('shows cost only when the driver reports dollars', () => {
    renderFixture('claude', 'conversation');
    expect(screen.getByTestId('chat-turn-footer')).toHaveTextContent('≈ $0.31 at API rates');
  });

  it('shows cached input tokens for token-reporting drivers', () => {
    renderFixture('codex', 'conversation');
    const footer = screen.getByTestId('chat-turn-footer');
    expect(footer).toHaveTextContent('24.6k in (19.1k cached)');
    expect(footer).not.toHaveTextContent('$');
  });

  it('hides tokens and cost when the driver reports only context fill', () => {
    renderFixture('copilot', 'conversation');
    const footer = screen.getByTestId('chat-turn-footer');
    expect(footer).not.toHaveTextContent(' in');
    expect(footer).not.toHaveTextContent('$');
  });

  it.each([['claude', 2], ['codex', 2], ['copilot', 0]] as const)('shows plan-limit meters by capability (%s)', (p, n) => {
    renderFixture(p, 'conversation');
    expect(screen.queryAllByTestId('chat-limit')).toHaveLength(n);
  });

  it('streams text and thinking before the final events arrive', () => {
    const events = chatFixture('claude', 'conversation');
    const firstChunk = events.findIndex((e) => e.type === 'agent_message_chunk');
    const thoughtChunk = events.findIndex((e) => e.type === 'agent_thought_chunk');
    const thinking = fold(events.slice(0, thoughtChunk + 1));
    const { unmount } = renderState(thinking);
    expect(screen.getByTestId('chat-thought')).toHaveTextContent('Thinking…');
    expect(screen.getByTestId('chat-state')).toHaveTextContent('Working');
    unmount();

    renderState(fold(events.slice(0, firstChunk + 2)));
    expect(screen.getByLabelText('Streaming')).toBeInTheDocument();
  });

  it('marks the command card running while output streams', () => {
    const events = chatFixture('codex', 'conversation');
    const firstOutput = events.findIndex((e) => e.type === 'tool_call_update' && e.data.toolCallId === 'cmd-1');
    renderState(fold(events.slice(0, firstOutput + 1)));
    const card = screen.getByTestId('chat-command-card');
    expect(card).toHaveAttribute('data-status', 'in_progress');
    expect(card).toHaveTextContent('running');
    expect(card).toHaveTextContent('tsc --noEmit');
  });
});

describe('ChatView approvals', () => {
  it.each(['claude', 'codex', 'copilot'] as const)('docks the provider options in place of the composer (%s)', (p) => {
    const { actions } = renderFixture(p, 'approval');
    const card = screen.getByTestId('chat-permission');
    expect(screen.queryByTestId('chat-composer')).not.toBeInTheDocument();
    expect(card).toHaveTextContent(PROFILES[p].installTitle);
    const labels = within(card).getAllByRole('button').map((b) => b.textContent);
    expect(labels).toHaveLength(PROFILES[p].installOptions.length);
    PROFILES[p].installOptions.forEach((o, i) => expect(labels[i]).toContain(o.label));
    expect(screen.getByTestId('chat-state')).toHaveTextContent('Waiting for you');
    expect(screen.getByTestId('chat-command-card')).toHaveTextContent('waiting for approval');

    fireEvent.click(within(card).getAllByRole('button')[1]);
    expect(actions.respondPermission).toHaveBeenCalledWith('perm-1', PROFILES[p].installOptions[1].optionId);
  });

  it('shows what an always-allow option covers', () => {
    renderFixture('claude', 'approval');
    expect(screen.getByTestId('chat-permission')).toHaveTextContent('npm install:*');
  });

  it('answers with Enter, Esc and number keys', () => {
    const a1 = makeActions();
    const { unmount } = renderFixture('codex', 'approval', a1);
    fireEvent.keyDown(screen.getByTestId('chat-permission'), { key: 'Enter' });
    expect(a1.respondPermission).toHaveBeenCalledWith('perm-1', 'accept');
    unmount();

    const a2 = makeActions();
    const r2 = renderFixture('codex', 'approval', a2);
    fireEvent.keyDown(screen.getByTestId('chat-permission'), { key: 'Escape' });
    expect(a2.respondPermission).toHaveBeenCalledWith('perm-1', 'decline');
    r2.unmount();

    const a3 = makeActions();
    renderFixture('codex', 'approval', a3);
    fireEvent.keyDown(screen.getByTestId('chat-permission'), { key: '5' });
    expect(a3.respondPermission).toHaveBeenCalledWith('perm-1', 'cancel');
  });

  it('answers only once', () => {
    const { actions } = renderFixture('claude', 'approval');
    const card = screen.getByTestId('chat-permission');
    fireEvent.keyDown(card, { key: 'Enter' });
    fireEvent.keyDown(card, { key: 'Enter' });
    expect(actions.respondPermission).toHaveBeenCalledTimes(1);
  });

  it('returns to the composer once the request is resolved', () => {
    const events = chatFixture('claude', 'approval');
    const resolved = fold([...events, { ...events[events.length - 1], seq: events.length + 1, type: 'permission_resolved', data: { requestId: 'perm-1', decision: 'allow', by: 'user' } } as ChatEvent]);
    renderState(resolved);
    expect(screen.queryByTestId('chat-permission')).not.toBeInTheDocument();
    expect(screen.getByTestId('chat-composer')).toBeInTheDocument();
  });
});

describe('ChatView plans and questions', () => {
  it('shows a plan document with its structured approval (planApproval)', () => {
    const { actions } = renderFixture('claude', 'plan');
    expect(screen.getByTestId('chat-plan-document')).toHaveTextContent('Ready for review');
    expect(screen.getByTestId('chat-plan-document')).toHaveTextContent('Row layout.');
    const card = screen.getByTestId('chat-permission');
    expect(card).toHaveTextContent('Claude finished planning');
    fireEvent.click(within(card).getByText('Approve, auto-accept edits'));
    expect(actions.respondPermission).toHaveBeenCalledWith('perm-plan', 'acceptEdits');
  });

  it('asks a question with options and free text', () => {
    const { actions } = renderFixture('codex', 'plan');
    expect(screen.getByTestId('chat-plan-document')).toHaveTextContent('Writing…');
    const q = screen.getByTestId('chat-question');
    const send = within(q).getByText('Send answer');
    expect(send).toBeDisabled();
    fireEvent.click(within(q).getByText('Replace the tooltips'));
    fireEvent.click(send);
    expect(actions.answerQuestion).toHaveBeenCalledWith('q-1', { tooltips: 'replace' });
  });

  it('submits a free-text answer', () => {
    const { actions } = renderFixture('codex', 'plan');
    fireEvent.change(screen.getByLabelText(/^Answer:/), { target: { value: 'Neither, remove them' } });
    fireEvent.click(screen.getByText('Send answer'));
    expect(actions.answerQuestion).toHaveBeenCalledWith('q-1', { tooltips: 'Neither, remove them' });
  });

  it('offers Clubhouse\'s own hand-off when the driver has no plan approval', async () => {
    const { actions } = renderFixture('copilot', 'plan');
    expect(screen.getByTestId('chat-tasks')).toHaveTextContent('0/4');
    fireEvent.click(screen.getByText('Switch to Ask first and implement'));
    await waitFor(() => expect(actions.send).toHaveBeenCalledWith('Implement the plan.', 'auto'));
    expect(actions.setLevel).toHaveBeenCalledWith('ask');
  });
});

describe('ChatView composer', () => {
  function type(text: string) {
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: text } });
  }

  it('sends with Enter when idle', () => {
    const { actions } = renderFixture('claude', 'conversation');
    expect(screen.getByTestId('chat-send')).toBeDisabled();
    type('Yes, do that too');
    fireEvent.keyDown(screen.getByLabelText('Message'), { key: 'Enter' });
    expect(actions.send).toHaveBeenCalledWith('Yes, do that too', 'auto');
    expect(screen.getByLabelText('Message')).toHaveValue('');
  });

  it('keeps Shift+Enter as a newline when idle', () => {
    const { actions } = renderFixture('claude', 'conversation');
    type('line one');
    fireEvent.keyDown(screen.getByLabelText('Message'), { key: 'Enter', shiftKey: true });
    expect(actions.send).not.toHaveBeenCalled();
  });

  it.each(['claude', 'codex'] as const)('steers with Enter and queues with Shift+Enter during a turn (%s)', (p) => {
    const { actions } = renderFixture(p, 'steer');
    expect(screen.getByTestId('chat-send-primary')).toHaveTextContent('Steer');
    expect(screen.getByTestId('chat-send-secondary')).toHaveTextContent('Queue');
    type('Keep the hover delay at 300ms');
    fireEvent.keyDown(screen.getByLabelText('Message'), { key: 'Enter' });
    expect(actions.send).toHaveBeenLastCalledWith('Keep the hover delay at 300ms', 'steer');
    type('Then rebase');
    fireEvent.keyDown(screen.getByLabelText('Message'), { key: 'Enter', shiftKey: true });
    expect(actions.send).toHaveBeenLastCalledWith('Then rebase', 'queued');
  });

  it('offers Stop & send when the driver cannot steer', async () => {
    const { actions } = renderFixture('copilot', 'steer');
    expect(screen.getByTestId('chat-send-primary')).toHaveTextContent('Stop & send');
    type('Actually, skip the tests');
    fireEvent.click(screen.getByTestId('chat-send-primary'));
    await waitFor(() => expect(actions.send).toHaveBeenCalledWith('Actually, skip the tests', 'auto'));
    expect(actions.interrupt).toHaveBeenCalled();
    expect(actions.interrupt.mock.invocationCallOrder[0]).toBeLessThan(actions.send.mock.invocationCallOrder[0]);
  });

  it('stops the turn with Esc or the Stop button', () => {
    const { actions } = renderFixture('claude', 'steer');
    fireEvent.keyDown(screen.getByLabelText('Message'), { key: 'Escape' });
    fireEvent.click(screen.getByTestId('chat-stop'));
    expect(actions.interrupt).toHaveBeenCalledTimes(2);
  });

  it('hides Stop when the driver cannot interrupt', () => {
    const state = fold(chatFixture('claude', 'steer'));
    renderState({ ...state, capabilities: { ...state.capabilities!, interrupt: false } });
    expect(screen.queryByTestId('chat-stop')).not.toBeInTheDocument();
  });

  it('shows tasks and the queue above the composer', () => {
    renderFixture('codex', 'steer');
    expect(screen.getByTestId('chat-tasks')).toHaveTextContent('3/4');
    const queue = screen.getByTestId('chat-queue');
    expect(queue).toHaveTextContent('2 · sent when this turn ends');
    expect(queue).toHaveTextContent('Then open a draft PR');
  });

  it('shows the model, effort and level', () => {
    renderFixture('claude', 'conversation');
    expect(screen.getByTestId('chat-model-pill')).toHaveTextContent('claude-opus-5-5· high');
    expect(screen.getByTestId('chat-level-pill')).toHaveTextContent('Ask first');
  });

  it('disables levels the driver cannot switch to live', () => {
    const { actions } = renderFixture('copilot', 'conversation');
    fireEvent.click(screen.getByTestId('chat-level-pill'));
    const items = screen.getAllByRole('menuitemradio');
    expect(items.map((i) => i.textContent)).toEqual(expect.arrayContaining([expect.stringContaining('Auto-accept edits')]));
    const autoEdit = items.find((i) => i.textContent?.startsWith('Auto-accept edits'))!;
    expect(autoEdit).toBeDisabled();
    fireEvent.click(items.find((i) => i.textContent?.startsWith('Plan'))!);
    expect(actions.setLevel).toHaveBeenCalledWith('plan');
  });

  it('disables the level menu when the driver reports no live levels', () => {
    const state = fold(chatFixture('claude', 'conversation'));
    renderState({ ...state, capabilities: { ...state.capabilities!, liveLevels: [] } });
    expect(screen.getByTestId('chat-level-pill')).toBeDisabled();
  });

  it('suggests slash commands only when the driver supports them', () => {
    const withCommands = (p: FixtureProvider) => {
      const f = chatFixture(p, 'conversation');
      const last = f[f.length - 1];
      return fold([...f, { ...last, seq: last.seq + 1, type: 'commands_available', data: { commands: [{ name: 'compact', description: 'Compact the context' }, { name: 'review' }] } } as ChatEvent]);
    };
    const { unmount } = renderState(withCommands('claude'));
    type('/co');
    expect(screen.getByTestId('chat-slash-menu')).toHaveTextContent('/compact');
    fireEvent.keyDown(screen.getByLabelText('Message'), { key: 'Tab' });
    expect(screen.getByLabelText('Message')).toHaveValue('/compact ');
    unmount();

    renderState(withCommands('codex'));
    type('/co');
    expect(screen.queryByTestId('chat-slash-menu')).not.toBeInTheDocument();
  });
});

describe('ChatView subagents', () => {
  it.each(['claude', 'codex'] as const)('renders a subagent card with its work folded in (%s)', (p) => {
    renderFixture(p, 'subagents');
    const card = screen.getByTestId('chat-subagent');
    expect(card).toHaveTextContent(p === 'claude' ? 'Explore' : 'worker-1');
    expect(card).toHaveTextContent('12 tools');
    expect(card).toHaveTextContent('Found 3 consumers');
    fireEvent.click(within(card).getByRole('button'));
    expect(within(card).getAllByTestId('chat-tool-row')).toHaveLength(2);
  });

  it('shows subagent work as ordinary rows when only ids are reported', () => {
    renderFixture('copilot', 'subagents');
    expect(screen.queryByTestId('chat-subagent')).not.toBeInTheDocument();
    expect(screen.getByTestId('chat-explore-group')).toBeInTheDocument();
    expect(screen.getAllByTestId('chat-agent-message')).toHaveLength(2);
  });
});

describe('ChatView failures', () => {
  it.each(['claude', 'codex', 'copilot'] as const)('shows a failed turn and keeps the composer (%s)', (p) => {
    renderFixture(p, 'turn_error');
    expect(screen.getByRole('alert')).toHaveTextContent('Usage limit reached');
    const footer = screen.getByTestId('chat-turn-footer');
    expect(footer).toHaveAttribute('data-stop-reason', 'error');
    expect(footer).toHaveTextContent('Turn failed');
    expect(screen.getByLabelText('Message')).not.toBeDisabled();
    expect(screen.queryByLabelText('Streaming')).not.toBeInTheDocument();
  });

  it.each(['claude', 'codex', 'copilot'] as const)('notes unrecognized protocol messages and a fatal exit (%s)', (p) => {
    renderFixture(p, 'protocol_drift');
    expect(screen.getByTestId('chat-protocol-unknown')).toHaveTextContent('sent 2 messages Clubhouse doesn\'t recognize');
    expect(screen.getByRole('alert')).toHaveTextContent('The CLI exited unexpectedly');
    expect(screen.getByLabelText('Message')).toBeDisabled();
    expect(screen.getByTestId('chat-state')).toHaveTextContent('Error');
  });
});

describe('ChatView (store-bound)', () => {
  beforeEach(() => {
    useChatStore.setState({ agents: {}, loading: {} });
  });

  it('loads the transcript and applies live events on top', async () => {
    const events = chatFixture('codex', 'approval');
    const live = events.pop()!;
    vi.mocked(window.clubhouse.chat).readTranscript = vi.fn(async () => events);
    render(<ChatView agent={agent} />);
    await screen.findByTestId('chat-permission');
    expect(window.clubhouse.chat.readTranscript).toHaveBeenCalledWith(FIXTURE_AGENT_ID, undefined);
    act(() => { useChatStore.getState().applyEvent(live); });
    expect(screen.getByTestId('chat-state')).toHaveTextContent('Waiting for you');
  });

  it('sends through the chat API', async () => {
    vi.mocked(window.clubhouse.chat).readTranscript = vi.fn(async () => chatFixture('claude', 'conversation'));
    const sendMessage = vi.fn(async () => ({ delivery: 'prompt' as const }));
    vi.mocked(window.clubhouse.chat).sendMessage = sendMessage;
    render(<ChatView agent={agent} />);
    await screen.findByTestId('chat-turn-footer');
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'hi' } });
    fireEvent.keyDown(screen.getByLabelText('Message'), { key: 'Enter' });
    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith(FIXTURE_AGENT_ID, 'hi', 'auto'));
  });
});
