import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ChatEvent } from '../../../shared/chat';
import type { ControllerChatPage } from '../../../shared/controller-chat';
import { useAnnexClientStore } from '../../stores/annexClientStore';
import { mergeControllerEvents, RemoteControllerChatView } from './RemoteControllerChatView';

const message = (seq: number, text: string, sessionId = 's'): ChatEvent => ({ agentId: 'work', sessionId, seq, ts: seq, type: 'agent_message', data: { messageId: `m${seq}`, text } });
function page(events: ChatEvent[] = [], rest: Partial<ControllerChatPage> = {}) {
  return { status: 'ok' as const, value: { version: 1 as const, agentId: 'work', sessionId: 's', currentSessionId: 's', events,
    lastSeq: events[events.length - 1]?.seq ?? 0, nextBeforeSeq: null, nextAfterSeq: null, readOnly: true as const, ...rest } };
}
const read = () => vi.mocked(window.clubhouse.annexClient.controllerChatPage);
beforeEach(() => {
  useAnnexClientStore.setState({ satellites: [] });
  read().mockResolvedValue(page());
  vi.mocked(window.clubhouse.annexClient.controllerChatSessions).mockResolvedValue({ status: 'ok', value: { sessions: [] } });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('remote controller desktop chat', () => {
  it('renders full conversation messages read-only and fetches earlier pages lazily', async () => {
    read().mockResolvedValueOnce(page([message(3, 'Newest controller reply')], { nextBeforeSeq: 3 }))
      .mockResolvedValueOnce(page([message(1, 'Earlier controller reply')], { nextBeforeSeq: null }));
    render(<RemoteControllerChatView machine="peer" />);
    expect(await screen.findByText('Newest controller reply')).toBeInTheDocument();
    expect(read()).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Show earlier' }));
    expect(await screen.findByText('Earlier controller reply')).toBeInTheDocument();
    expect(screen.getByText('Newest controller reply')).toBeInTheDocument();
    expect(read()).toHaveBeenLastCalledWith('peer', { sessionId: 's', beforeSeq: 3 });
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /send|approve|take.*lead|permission/i })).toBeNull();
  });
  it('lazily lists saved conversations and pages the selected archive', async () => {
    vi.mocked(window.clubhouse.annexClient.controllerChatSessions).mockResolvedValue({ status: 'ok', value: { sessions: [
      { sessionId: 'old', title: 'Previous work', startedAt: 1, lastActiveAt: 2, lastSeq: 1 },
    ] } });
    read().mockImplementation(async (_machine, opts) => opts?.sessionId === 'old'
      ? page([message(1, 'Archived reply', 'old')], { sessionId: 'old' }) : page([message(3, 'Current reply')]));
    render(<RemoteControllerChatView machine="peer" />);
    await screen.findByText('Current reply');
    expect(window.clubhouse.annexClient.controllerChatSessions).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Browse history' }));
    const select = await screen.findByRole('combobox', { name: 'Controller conversation' });
    fireEvent.change(select, { target: { value: 'old' } });
    expect(await screen.findByText('Archived reply')).toBeInTheDocument();
    expect(screen.queryByText('Current reply')).toBeNull();
    expect(read()).toHaveBeenLastCalledWith('peer', { sessionId: 'old' });
  });
  it.each([
    ['unavailable', /not available on that computer’s version/],
    ['offline', /That computer is offline/],
    ['forbidden', /does not allow this desktop/],
    ['error', /Could not load the controller conversation/],
  ] as const)('shows %s and waits for retry instead of looping', async (status, text) => {
    vi.useFakeTimers();
    read().mockResolvedValue({ status });
    await act(async () => { render(<RemoteControllerChatView machine="peer" />); });
    expect(screen.getByText(text)).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(read()).toHaveBeenCalledTimes(1);
    read().mockResolvedValue(page());
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
    expect(screen.getByText('This conversation has no messages.')).toBeInTheDocument();
  });
  it('shows an empty conversation after a successful read', async () => {
    render(<RemoteControllerChatView machine="peer" />);
    expect(await screen.findByText('This conversation has no messages.')).toBeInTheDocument();
    expect(screen.queryByText(/not available/)).toBeNull();
  });
  it('polls forward, preserves loaded history, resets cursors for a new session and stops on unmount', async () => {
    vi.useFakeTimers();
    read().mockResolvedValueOnce(page([message(1, 'Initial reply')]))
      .mockResolvedValueOnce(page([message(2, 'Live reply')]))
      .mockResolvedValueOnce(page([], { sessionId: 'new', currentSessionId: 'new' }))
      .mockResolvedValueOnce(page([message(1, 'Fresh conversation', 'new')], { sessionId: 'new', currentSessionId: 'new' }));
    let unmount!: () => void;
    await act(async () => { ({ unmount } = render(<RemoteControllerChatView machine="peer" />)); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(read()).toHaveBeenNthCalledWith(2, 'peer', { afterSeq: 1 });
    expect(screen.getByText('Initial reply')).toBeInTheDocument();
    expect(screen.getByText('Live reply')).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(read()).toHaveBeenNthCalledWith(4, 'peer');
    expect(screen.getByText('Fresh conversation')).toBeInTheDocument();
    expect(screen.queryByText('Initial reply')).toBeNull();
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(read()).toHaveBeenCalledTimes(4);
  });
  it('backs off unchanged polls from 5 seconds to 10, 20 and 30 seconds', async () => {
    vi.useFakeTimers();
    await act(async () => { render(<RemoteControllerChatView machine="peer" />); });
    expect(read()).toHaveBeenCalledTimes(1);
    for (const [delay, calls] of [[5000, 2], [10000, 3], [20000, 4], [30000, 5]]) {
      await act(async () => { await vi.advanceTimersByTimeAsync(delay - 1); });
      expect(read()).toHaveBeenCalledTimes(calls - 1);
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(read()).toHaveBeenCalledTimes(calls);
    }
  });
  it('discards superseded body copies across polls and backward history pages', () => {
    const old = { ...message(1, 'old token prefix'), data: { messageId: 'same', text: 'old token prefix' } };
    const latest = { ...message(2, 'replacement'), data: { messageId: 'same', text: 'replacement' } };
    const merged = mergeControllerEvents([old], [latest]);
    expect(merged).toEqual([latest]);
    expect(mergeControllerEvents(merged, [old])).toEqual([latest]);
    const tool: ChatEvent = { ...message(3, ''), type: 'tool_call', data: { toolCallId: 't', title: 'Tool metadata', kind: 'other', status: 'in_progress', content: [{ type: 'terminal', output: 'old output' }] } };
    const update: ChatEvent = { ...message(4, ''), type: 'tool_call_update', data: { toolCallId: 't', contentMode: 'replace', content: [{ type: 'terminal', output: 'latest output' }] } };
    const newest: ChatEvent = { ...message(5, ''), type: 'tool_call_update', data: { toolCallId: 't', contentMode: 'replace', content: [{ type: 'terminal', output: 'complete output' }] } };
    expect(mergeControllerEvents([tool, update], [newest])).toEqual([{ ...tool, data: { ...tool.data, content: [] } }, newest]);
  });
  it('ignores late replies from a conversation that is no longer open', async () => {
    let resolve!: (result: ReturnType<typeof page>) => void;
    read().mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const { unmount } = render(<RemoteControllerChatView machine="peer" />);
    await waitFor(() => expect(read()).toHaveBeenCalledTimes(1));
    unmount();
    await act(async () => { resolve(page([message(1, 'Late reply')])); });
    expect(screen.queryByText('Late reply')).toBeNull();
  });
});
