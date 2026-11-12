import { beforeEach, describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ChatEvent } from '../../../../shared/chat';
import { MINIMAL_CHAT_CAPABILITIES } from '../../../../shared/chat';
import { ChatHistory } from './ChatHistory';
import { useChatStore } from '../../../stores/chatStore';
import { DISPATCHER_OFF } from '../../../../shared/dispatcher-types';
import { useDispatcherStore } from '../../dispatcher/dispatcherStore';

function message(seq: number, sessionId: string, text: string): ChatEvent {
  return { v: 2, agentId: 'a1', sessionId, seq, ts: seq, type: 'agent_message', data: { messageId: `m${seq}`, text } };
}
const sessions = [
  { sessionId: 'current', startedAt: 2_000, lastActiveAt: 3_000, lastSeq: 10, title: 'Current task' },
  { sessionId: 'old', startedAt: 1_000, lastActiveAt: 1_500, lastSeq: 600, title: 'Earlier task' },
];

describe('ChatHistory', () => {
  beforeEach(() => useDispatcherStore.getState().setState(DISPATCHER_OFF));

  const emptySessions = ['d4708bba', '39d32489'].map((sessionId, i) => ({
    sessionId, startedAt: 4_000 + i, lastActiveAt: 4_000 + i, lastSeq: 2,
  }));

  it.each([
    ['copilot_sdk', 'copilot-cli'],
    ['codex_app_server', 'codex-cli'],
    ['claude_agent_sdk', 'claude-code'],
  ] as const)('uses a fixed controller display title for %s history without changing saved titles or chat history', async (driver, provider) => {
    useDispatcherStore.getState().setState({
      ...DISPATCHER_OFF, agentId: 'work', chatAgentId: 'chat',
      config: { id: 'work', name: 'Rosie', color: 'indigo', createdAt: 'then' },
    });
    window.clubhouse.chat.listSessions = vi.fn(async () => sessions);
    window.clubhouse.chat.readTranscript = vi.fn(async (agentId: string, _tail?: number, sessionId?: string): Promise<ChatEvent[]> => [
      { v: 2, agentId, sessionId: sessionId!, seq: 1, ts: 1, type: 'session_started', data: { driver, provider, cwd: '/dispatcher', resumed: true, capabilities: MINIMAL_CHAT_CAPABILITIES } },
      { v: 2, agentId, sessionId: sessionId!, seq: 2, ts: 2, type: 'session_info', data: { title: 'Provider auto-title', nativeSessionId: 'native-controller' } },
    ]);
    const { rerender } = render(<ChatHistory agentId="work" currentSessionId="current" onClose={vi.fn()} />);
    await screen.findByText('This session has no messages.');
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      expect.stringContaining('Dispatcher controller (current)'), expect.stringContaining('Dispatcher controller'),
    ]);
    expect(window.clubhouse.chat.readTranscript).toHaveBeenLastCalledWith('work', 500, 'old');
    expect(screen.queryByText(/Provider auto-title/)).not.toBeInTheDocument();
    expect(sessions.map((s) => s.title)).toEqual(['Current task', 'Earlier task']);
    rerender(<ChatHistory agentId="chat" currentSessionId="current" onClose={vi.fn()} />);
    await waitFor(() => expect(window.clubhouse.chat.readTranscript).toHaveBeenLastCalledWith('chat', 500, 'old'));
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      expect.stringContaining('Current task (current)'), expect.stringContaining('Earlier task'),
    ]);
  });

  it('defaults to the most recent non-current conversation and groups sessions without user messages last', async () => {
    window.clubhouse.chat.listSessions = vi.fn(async () => [
      emptySessions[0], sessions[1], { ...sessions[1], sessionId: 'older', lastActiveAt: 500 },
      emptySessions[1], sessions[0],
    ]);
    window.clubhouse.chat.readTranscript = vi.fn(async () => [message(1, 'old', 'Earlier reply')]);
    render(<ChatHistory agentId="a1" currentSessionId="current" onClose={vi.fn()} />);
    await screen.findByText('Earlier reply');
    expect(screen.getByLabelText('Saved session')).toHaveValue('old');
    expect(screen.getAllByRole('option').map((option) => (option as HTMLOptionElement).value))
      .toEqual(['current', 'old', 'older', '39d32489', 'd4708bba']);
    expect(within(screen.getByRole('group', { name: 'Sessions without user messages' })).getAllByRole('option')).toHaveLength(2);
  });

  it('keeps attachment-only conversations eligible even without a text title', async () => {
    window.clubhouse.chat.listSessions = vi.fn(async () => [...emptySessions, sessions[0], { ...sessions[1], title: '' }]);
    window.clubhouse.chat.readTranscript = vi.fn(async () => [message(1, 'old', 'Image reply')]);
    render(<ChatHistory agentId="a1" currentSessionId="current" onClose={vi.fn()} />);
    await screen.findByText('Image reply');
    expect(screen.getByLabelText('Saved session')).toHaveValue('old');
  });

  it('falls back to the current conversation when it is the only session with user messages', async () => {
    window.clubhouse.chat.listSessions = vi.fn(async () => [...emptySessions, sessions[0]]);
    window.clubhouse.chat.readTranscript = vi.fn(async () => [message(1, 'current', 'Current reply')]);
    render(<ChatHistory agentId="a1" currentSessionId="current" onClose={vi.fn()} />);
    await screen.findByText('Current reply');
    expect(screen.getByLabelText('Saved session')).toHaveValue('current');
  });

  it('can inspect empty sessions without inviting the user to send a message', async () => {
    window.clubhouse.chat.listSessions = vi.fn(async () => emptySessions);
    window.clubhouse.chat.readTranscript = vi.fn(async (_agentId, _tail, sessionId) => [
      { v: 2, agentId: 'a1', sessionId: sessionId!, seq: 1, ts: 1, type: 'session_state', data: { state: 'idle' } },
      { v: 2, agentId: 'a1', sessionId: sessionId!, seq: 2, ts: 2, type: 'session_info', data: { nativeSessionId: 'native' } },
    ] as ChatEvent[]);
    render(<ChatHistory agentId="a1" currentSessionId="current" onClose={vi.fn()} />);
    await screen.findByText('This session has no messages.');
    expect(screen.getByLabelText('Saved session')).toHaveValue('39d32489');
    expect(screen.queryByText(/Send one to start/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Message')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Saved session'), { target: { value: 'd4708bba' } });
    await screen.findByText('This session has no messages.');
    expect(window.clubhouse.chat.readTranscript).toHaveBeenLastCalledWith('a1', 500, 'd4708bba');
  });

  it('focuses history and handles Escape from its controls without propagating to the pane', async () => {
    window.clubhouse.chat.listSessions = vi.fn(async () => sessions);
    window.clubhouse.chat.readTranscript = vi.fn(async () => []);
    const onClose = vi.fn();
    const onPaneKey = vi.fn();
    render(<div onKeyDown={onPaneKey}><ChatHistory agentId="a1" currentSessionId="current" onClose={onClose} /></div>);
    expect(screen.getByRole('region', { name: 'Chat history' })).toHaveFocus();
    await screen.findByText('This session has no messages.');
    const select = screen.getByLabelText('Saved session');
    fireEvent.keyDown(select, { key: 'Escape', isComposing: true });
    expect(onClose).not.toHaveBeenCalled();
    onPaneKey.mockClear();
    fireEvent.keyDown(select, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
    expect(onPaneKey).not.toHaveBeenCalled();
  });

  it('browses a saved session read-only, expands only that session, and leaves live state alone', async () => {
    window.clubhouse.chat.listSessions = vi.fn(async () => sessions);
    const all = Array.from({ length: 501 }, (_, i) => message(i + 1, 'old', `Saved reply ${i + 1}`));
    window.clubhouse.chat.readTranscript = vi.fn(async (_agentId, tail) => tail ? all.slice(-tail) : all);
    const live = useChatStore.getState().agents;
    const onClose = vi.fn();
    render(<ChatHistory agentId="a1" currentSessionId="current" onClose={onClose} />);
    await screen.findByText('Saved reply 501');
    expect(screen.getByLabelText('Saved session')).toHaveValue('old');
    expect(screen.queryByLabelText('Message')).not.toBeInTheDocument();
    expect(screen.queryByText('Saved reply 1')).not.toBeInTheDocument();
    expect(window.clubhouse.chat.readTranscript).toHaveBeenCalledWith('a1', 500, 'old');
    for (let page = 0; page < 10 && screen.queryByTestId('chat-window-older'); page++) {
      fireEvent.click(screen.getByTestId('chat-window-older'));
    }
    fireEvent.click(screen.getByText('Show earlier'));
    await screen.findByText('Saved reply 1');
    expect(window.clubhouse.chat.readTranscript).toHaveBeenLastCalledWith('a1', undefined, 'old');
    expect(useChatStore.getState().agents).toBe(live);
    fireEvent.click(screen.getByText('Back to current chat'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('ignores a saved-session read that finishes after switching to another session', async () => {
    window.clubhouse.chat.listSessions = vi.fn(async () => sessions);
    let resolve!: (events: ChatEvent[]) => void;
    window.clubhouse.chat.readTranscript = vi.fn()
      .mockReturnValueOnce(new Promise<ChatEvent[]>((r) => { resolve = r; }))
      .mockResolvedValue([message(1, 'current', 'Current reply')]);
    render(<ChatHistory agentId="a1" currentSessionId="current" onClose={vi.fn()} />);
    await waitFor(() => expect(window.clubhouse.chat.readTranscript).toHaveBeenCalledWith('a1', 500, 'old'));
    fireEvent.change(screen.getByLabelText('Saved session'), { target: { value: 'current' } });
    await screen.findByText('Current reply');
    await act(async () => { resolve([message(1, 'old', 'Obsolete reply')]); });
    expect(screen.queryByText('Obsolete reply')).not.toBeInTheDocument();
  });

  it('shows an error when saved sessions cannot be read', async () => {
    window.clubhouse.chat.listSessions = vi.fn().mockRejectedValue(new Error('unreadable'));
    render(<ChatHistory agentId="a1" currentSessionId="current" onClose={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load saved sessions');
  });
});
