import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ChatEvent } from '../../../../shared/chat';
import { ChatHistory } from './ChatHistory';
import { useChatStore } from '../../../stores/chatStore';

function message(seq: number, sessionId: string, text: string): ChatEvent {
  return { v: 2, agentId: 'a1', sessionId, seq, ts: seq, type: 'agent_message', data: { messageId: `m${seq}`, text } };
}
const sessions = [
  { sessionId: 'current', startedAt: 2_000, lastActiveAt: 3_000, lastSeq: 10, title: 'Current task' },
  { sessionId: 'old', startedAt: 1_000, lastActiveAt: 1_500, lastSeq: 600, title: 'Earlier task' },
];

describe('ChatHistory', () => {
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
