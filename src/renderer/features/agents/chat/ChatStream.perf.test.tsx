import { afterEach, describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { foldChatEvents, reduceChatEvent, type ChatViewState } from '../../../stores/chatStore';
import { CHAT_STREAM_WINDOW_SIZE, ChatStream } from './ChatStream';
import { chatFixture, ChatFixture, FIXTURE_AGENT_ID, PROFILES } from './fixtures';

function longStream(turns: number): { state: ChatViewState; fixture: ChatFixture } {
  const prof = PROFILES.claude;
  const f = new ChatFixture();
  f.start(prof.driver, prof.provider, prof.capabilities);
  for (let t = 1; t <= turns; t++) {
    const turn = `turn-${t}`;
    f.prompt(turn, `Step ${t}: tidy the next component.`);
    f.tool(turn, { toolCallId: `edit-${t}`, kind: 'edit', title: 'Edit', status: 'in_progress', content: [prof.editContent] });
    f.tool(turn, { toolCallId: `cmd-${t}`, kind: 'execute', title: 'npm test', status: 'in_progress', content: [{ type: 'terminal', command: 'npm test', output: 'ok\n', exitCode: 0 }] });
    f.say(turn, `m-${t}`, `Done with step ${t}. Everything **passes** and \`npm test\` is green.`);
    f.end(turn, { stopReason: 'end_turn', durationMs: 5000 });
  }
  return { state: foldChatEvents(undefined, FIXTURE_AGENT_ID, f.events), fixture: f };
}

describe('ChatStream with a long transcript', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('mounts only the bounded tail of a 5,000-item transcript', () => {
    const { state } = longStream(1000);
    expect(state.items.length).toBeGreaterThanOrEqual(5000);

    render(<ChatStream state={state} />);

    expect(screen.getAllByTestId('chat-stream-block')).toHaveLength(CHAT_STREAM_WINDOW_SIZE);
    expect(screen.getAllByTestId('chat-agent-message').at(-1)).toHaveTextContent('Done with step 1000. Everything passes and npm test is green.');
    // Each turn is 4 rows, with its tool calls folded into one.
    expect(screen.getAllByTestId('chat-agent-message')[0]).toHaveTextContent('Done with step 938.');
  }, 30_000);

  it('navigates older windows and returns directly to the latest tail', () => {
    const { state } = longStream(100);
    render(<ChatStream state={state} onShowEarlier={vi.fn()} />);

    expect(screen.queryByTestId('chat-show-earlier')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('chat-window-older'));
    expect(screen.getAllByTestId('chat-stream-block')).toHaveLength(CHAT_STREAM_WINDOW_SIZE);
    expect(screen.getByTestId('chat-show-earlier')).toBeInTheDocument();
    expect(screen.getByTestId('chat-window-later')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('chat-window-latest'));
    expect(screen.queryByTestId('chat-window-later')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('chat-agent-message').at(-1)).toHaveTextContent('Done with step 100. Everything passes and npm test is green.');
  });

  it('resets window navigation when the transcript identity changes', () => {
    const { state } = longStream(100);
    const { state: nextState } = longStream(101);
    const { rerender } = render(<ChatStream state={state} />);

    fireEvent.click(screen.getByTestId('chat-window-older'));
    expect(screen.getByTestId('chat-window-later')).toBeInTheDocument();

    rerender(<ChatStream state={{ ...nextState, agentId: 'another-agent', sessionId: 'another-session' }} />);

    expect(screen.getAllByTestId('chat-agent-message').at(-1)).toHaveTextContent('Done with step 101. Everything passes and npm test is green.');
    expect(screen.queryByTestId('chat-window-later')).not.toBeInTheDocument();
    expect(screen.queryByTestId('chat-window-latest')).not.toBeInTheDocument();
  });

  it('preserves transcript expansion state across window navigation', () => {
    const { state } = longStream(100);
    render(<ChatStream state={state} />);
    fireEvent.click(screen.getByTestId('chat-window-older'));

    fireEvent.click(screen.getAllByTestId('chat-group-toggle')[0]);
    const firstCommand = screen.getAllByTestId('chat-command-card')[0];
    fireEvent.click(within(firstCommand).getByRole('button', { expanded: false }));
    expect(firstCommand).toHaveAttribute('data-open', 'true');

    fireEvent.click(screen.getByTestId('chat-window-latest'));
    fireEvent.click(screen.getByTestId('chat-window-older'));
    expect(screen.getAllByTestId('chat-command-card')[0]).toHaveAttribute('data-open', 'true');
  });

  it('moves the window for an out-of-window subagent jump', () => {
    const base = longStream(100).state;
    const subagent = foldChatEvents(undefined, FIXTURE_AGENT_ID, chatFixture('claude', 'subagents'));
    const state = {
      ...base,
      items: [...subagent.items.map((item) => ({ ...item, id: `subagent-fixture:${item.id}` })), ...base.items],
      subagents: subagent.subagents,
      capabilities: subagent.capabilities,
    };
    const onJumpResult = vi.fn();

    render(<ChatStream state={state} jump={{ subagentId: 'sub-1', nonce: 1 }} onJumpResult={onJumpResult} />);

    expect(screen.getByTestId('chat-subagent')).toHaveAttribute('data-jump-highlight', 'true');
    expect(onJumpResult).toHaveBeenCalledWith({ subagentId: 'sub-1', nonce: 1 }, true);
    expect(screen.getAllByTestId('chat-stream-block').length).toBeLessThanOrEqual(CHAT_STREAM_WINDOW_SIZE);
  });

  it('retries a missed jump when its target becomes available', () => {
    const state = foldChatEvents(undefined, FIXTURE_AGENT_ID, chatFixture('claude', 'subagents'));
    const initial = {
      ...state,
      items: state.items.filter((item) => !('subagentId' in item) || item.subagentId !== 'sub-1'),
      subagents: {},
    };
    const jump = { subagentId: 'sub-1', nonce: 1 };
    const onJumpResult = vi.fn();
    const { rerender } = render(<ChatStream state={initial} jump={jump} onJumpResult={onJumpResult} />);

    expect(onJumpResult).toHaveBeenLastCalledWith(jump, false);

    rerender(<ChatStream state={state} jump={jump} onJumpResult={onJumpResult} />);

    expect(onJumpResult).toHaveBeenLastCalledWith(jump, true);
    expect(screen.getAllByTestId('chat-subagent')[0]).toHaveAttribute('data-jump-highlight', 'true');

    const resultCount = onJumpResult.mock.calls.length;
    rerender(<ChatStream state={{ ...state, capabilities: { ...state.capabilities! } }} jump={jump} onJumpResult={onJumpResult} />);
    expect(onJumpResult).toHaveBeenCalledTimes(resultCount);
  });

  it('coalesces rapid live chunks to one frame and updates the bounded tail', async () => {
    vi.useFakeTimers();
    const { state, fixture } = longStream(100);
    const frames: FrameRequestCallback[] = [];
    const requestFrame = vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal('requestAnimationFrame', requestFrame);
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    const { rerender } = render(<ChatStream state={state} />);

    fixture.prompt('turn-x', 'One more thing');
    fixture.emit('agent_message_chunk', { messageId: 'm-x', text: 'Working on' }, { turnId: 'turn-x' });
    let next = state;
    for (const e of fixture.events.slice(-5)) next = reduceChatEvent(next, e);
    act(() => { rerender(<ChatStream state={next} />); });
    expect(screen.getByText('Working on')).toBeInTheDocument();

    next = {
      ...next,
      items: next.items.map((item) => item.kind === 'agent_message' && item.messageId === 'm-x'
        ? { ...item, text: 'Working on it now' }
        : item),
    };
    act(() => { rerender(<ChatStream state={next} />); });
    next = {
      ...next,
      items: next.items.map((item) => item.kind === 'agent_message' && item.messageId === 'm-x'
        ? { ...item, text: 'Working on it now and finishing' }
        : item),
    };
    expect(next.items.find((item) => item.kind === 'agent_message' && item.messageId === 'm-x')).toMatchObject({ text: 'Working on it now and finishing' });
    act(() => { rerender(<ChatStream state={next} announce={false} />); });

    expect(requestFrame).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Working on')).toBeInTheDocument();
    expect(screen.queryByTestId('chat-live-region')).not.toBeInTheDocument();
    await act(async () => { frames[0](16); });
    await act(async () => { vi.runAllTimers(); });
    expect(screen.getAllByTestId('chat-agent-message').at(-1)).toHaveTextContent('Working on it now and finishing');
    expect(screen.getAllByTestId('chat-stream-block').length).toBeLessThanOrEqual(CHAT_STREAM_WINDOW_SIZE);
  });
});
