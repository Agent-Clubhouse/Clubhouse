import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RoutedMessagePart } from '../../../../shared/chat';
import type { Agent } from '../../../../shared/types';
import { useAgentStore } from '../../../stores/agentStore';
import { useDispatcherStore } from '../../dispatcher/dispatcherStore';
import { reduceChatEvent, type AgentMessageItem, type NoticeItem, type TurnEndItem, type UserMessageItem } from '../../../stores/chatStore';
import { AgentMessage, isLongMessage, LONG_MESSAGE_CHARS, NoticeRow, TurnFooter, UserMessage } from './MessageBlocks';
import { createTranscriptExpansionStore, TranscriptExpansionProvider } from './transcript-expansion';
import { useActionsNav } from '../../actions/useActions';
import { DISPATCHER_OFF } from '../../../../shared/dispatcher-types';

function item(over: Partial<UserMessageItem>): UserMessageItem {
  const text = over.text ?? '';
  return {
    id: 'user:s:m1', sessionId: 's', seq: 1, ts: 1, kind: 'user_message', messageId: 'm1',
    content: [{ type: 'text', text }], text, source: 'user', delivery: 'prompt', ...over,
  };
}

const agent = (over: Partial<Agent>): Agent => ({
  id: 'durable_1', projectId: 'p', name: 'typecheck-leak', kind: 'durable', status: 'running', color: 'emerald', ...over,
}) as Agent;

const long = 'x'.repeat(LONG_MESSAGE_CHARS + 1);
const routed = (text: string, id = 'durable_1', name = 'typecheck-leak'): RoutedMessagePart[] => [{ sender: { agentId: id, name }, text }];

beforeEach(() => {
  useAgentStore.setState({ agents: {}, agentIcons: {} });
  useDispatcherStore.setState({ state: null, project: null });
});

describe('UserMessage', () => {
  it('labels the user\'s message You, on the right, with the text as typed', () => {
    render(<UserMessage item={item({ text: '[FROM:x] mine' })} />);
    const row = screen.getByTestId('chat-user-message');
    expect(row.dataset.from).toBe('you');
    expect(row.className).toContain('ml-auto');
    expect(screen.getByTestId('chat-you-label').textContent).toBe('You');
    expect(row.textContent).toContain('[FROM:x] mine');
  });

  it('fills the user\'s own bubble, and gives a routed one only a neutral hairline', () => {
    const { unmount } = render(<UserMessage item={item({ text: 'mine' })} />);
    expect(screen.getByTestId('chat-you-body').className).toContain('bg-surface-0');
    unmount();
    render(<UserMessage item={item({ text: 'x', source: 'mcp', routed: routed('Short') })} />);
    const body = screen.getByTestId('chat-sent-body');
    expect(body.className).toContain('border-surface-1');
    expect(body.className).not.toMatch(/\bbg-/);
    expect(body.getAttribute('style')).toBeNull();
  });

  it('keeps the source and steer labels readable', () => {
    render(<UserMessage item={item({ text: 'hi', source: 'annex', delivery: 'steer' })} />);
    expect(screen.getByTestId('chat-you-label').textContent).toBe('You · From Annex · Steered into the running turn');
  });

  it('says plainly when a queued message was not delivered, and nothing while it is sending', () => {
    const { rerender } = render(<UserMessage item={item({ text: 'hi', delivery: 'queued', sendState: 'not_delivered' })} />);
    expect(screen.getByTestId('chat-you-label').textContent).toBe('You · Not delivered');
    expect(screen.getByTestId('chat-user-message').dataset.sendState).toBe('not_delivered');
    rerender(<UserMessage item={item({ text: 'hi', delivery: 'queued', sendState: 'sending' })} />);
    expect(screen.getByTestId('chat-you-label').textContent).toBe('You');
  });

  it('shows another agent on the left with name and avatar and no routing text', () => {
    useAgentStore.setState({ agents: { durable_1: agent({}) } });
    render(<UserMessage item={item({ text: '[TASK:t] [FROM:typecheck-leak@p] Short one', source: 'mcp', routed: routed('Short one') })} />);
    const row = screen.getByTestId('chat-user-message');
    expect(row.dataset.from).toBe('others');
    expect(row.className).toContain('mr-auto');
    expect(screen.getByTestId('chat-sent-name').textContent).toBe('typecheck-leak');
    expect(screen.getByTestId('chat-sent-avatar').textContent).toBe('TL');
    expect(screen.getByTestId('chat-sent-body').textContent).toContain('Short one');
    expect(row.textContent).not.toContain('[FROM');
    expect(row.textContent).not.toContain('[TASK');
  });

  it('colors only the avatar', () => {
    useAgentStore.setState({ agents: { durable_1: agent({}) } });
    const { container } = render(<UserMessage item={item({ text: 'x', source: 'mcp', routed: routed('Short') })} />);
    const colored = [...container.querySelectorAll<HTMLElement>('[style]')];
    expect(colored).toHaveLength(1);
    expect(screen.getByTestId('chat-sent-avatar').contains(colored[0])).toBe(true);
  });

  it('uses the sender\'s picture', () => {
    useAgentStore.setState({ agents: { durable_1: agent({ icon: 'a.png' }) }, agentIcons: { durable_1: 'data:image/png;base64,AAAA' } });
    render(<UserMessage item={item({ text: 'x', source: 'mcp', routed: routed('Short') })} />);
    expect(screen.getByTestId('chat-sent-avatar').querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AAAA');
  });

  it.each(['Dispatcher', 'Sage'])('keeps controller sender metadata unified under chat name %s and its avatar', (name) => {
    useDispatcherStore.setState({ state: { ...DISPATCHER_OFF, agentId: 'dispatcher_work', chatAgentId: 'dispatcher_chat' } });
    useAgentStore.setState({
      agents: {
        dispatcher_chat: agent({ id: 'dispatcher_chat', name, icon: 'd.png' }),
        // In the debug view (#3188) the controller is loaded too, with no picture of its own.
        dispatcher_work: agent({ id: 'dispatcher_work', name: 'Navi' }),
      },
      agentIcons: { dispatcher_chat: 'data:image/png;base64,DDDD' },
    });
    for (const [id, senderName] of [['dispatcher_work', 'Navi'], ['dispatcher_work', 'Dispatcher controller'], ['dispatcher_chat', name]]) {
      const { unmount } = render(<UserMessage item={item({ text: 'x', source: 'mcp', routed: routed('Short', id, senderName) })} />);
      expect(screen.getByTestId('chat-sent-name').textContent).toBe(name);
      expect(screen.getByTestId('chat-sent-avatar').querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,DDDD');
      expect(screen.getByTestId('chat-sent-avatar').textContent).not.toBe('N');
      unmount();
    }
  });

  it('shows the current name after a rename', () => {
    useAgentStore.setState({ agents: { durable_1: agent({ name: 'renamed' }) } });
    render(<UserMessage item={item({ text: 'x', source: 'mcp', routed: routed('Short') })} />);
    expect(screen.getByTestId('chat-sent-name').textContent).toBe('renamed');
  });

  it('still names an agent that no longer exists', () => {
    render(<UserMessage item={item({ text: 'x', source: 'mcp', routed: routed('Short') })} />);
    expect(screen.getByTestId('chat-sent-name').textContent).toBe('typecheck-leak');
    expect(screen.getByTestId('chat-sent-avatar').textContent).toBe('TL');
    expect(screen.getByTestId('chat-sent-avatar').querySelector<HTMLElement>('[style]')?.style.backgroundColor).toBe('rgb(99, 102, 241)');
  });

  it('doesn\'t fall back from an unknown id to an agent of the same name', () => {
    useAgentStore.setState({ agents: { other: agent({ id: 'other', color: 'rose' }) } });
    render(<UserMessage item={item({ text: 'x', source: 'mcp', routed: routed('Short') })} />);
    expect(screen.getByTestId('chat-sent-avatar').querySelector<HTMLElement>('[style]')?.style.backgroundColor).toBe('rgb(99, 102, 241)');
  });

  it('falls back to parsing an old message, finding the agent by its only name', () => {
    useAgentStore.setState({ agents: { durable_1: agent({ color: 'rose' }) } });
    render(<UserMessage item={item({ text: '[TASK:t] [FROM:typecheck-leak@p] Old one', source: 'mcp' })} />);
    expect(screen.getByTestId('chat-sent-body').textContent).toContain('Old one');
    expect(screen.getByTestId('chat-sent-avatar').querySelector<HTMLElement>('[style]')?.style.backgroundColor).toBe('rgb(244, 63, 94)');
  });

  it('doesn\'t guess between two agents of the same name', () => {
    useAgentStore.setState({ agents: { a: agent({ id: 'a', color: 'rose' }), b: agent({ id: 'b', color: 'rose' }) } });
    render(<UserMessage item={item({ text: '[FROM:typecheck-leak] Old', source: 'mcp' })} />);
    expect(screen.getByTestId('chat-sent-avatar').querySelector<HTMLElement>('[style]')?.style.backgroundColor).not.toBe('rgb(244, 63, 94)');
  });

  it('shows Clubhouse notices with no avatar', () => {
    render(<UserMessage item={item({ text: '[Clubhouse] Ready', source: 'mcp', routed: [{ fromClubhouse: true, text: 'Ready' }] })} />);
    expect(screen.getByTestId('chat-sent-name').textContent).toBe('Clubhouse');
    expect(screen.queryByTestId('chat-sent-avatar')).toBeNull();
    expect(screen.getByTestId('chat-sent-body').textContent).toBe('Ready');
  });

  it('labels a sender\'s steer and mission beside the name', () => {
    render(<UserMessage item={item({ text: 'x', source: 'mission', delivery: 'steer', routed: routed('Short') })} />);
    expect(screen.getByTestId('chat-sent-part').textContent).toContain('· Mission · Steered into the running turn');
  });

  it('shows each sender of a burst, in one row', () => {
    render(<UserMessage item={item({ text: 'x', source: 'mcp', routed: [...routed('one', 'a', 'first'), ...routed('two', 'b', 'second')] })} />);
    expect(screen.getAllByTestId('chat-user-message')).toHaveLength(1);
    expect(screen.getAllByTestId('chat-sent-name').map((n) => n.textContent)).toEqual(['first', 'second']);
  });

  it('shows a short message in full, with nothing to toggle', () => {
    render(<UserMessage item={item({ text: 'x', source: 'mcp', routed: routed('Short') })} />);
    expect(screen.queryByTestId('chat-sent-toggle')).toBeNull();
    expect(screen.getByTestId('chat-sent-body')).toBeTruthy();
  });

  it('collapses a long message, and a click expands and collapses it', () => {
    render(<UserMessage item={item({ text: 'x', source: 'mcp', routed: routed(long) })} />);
    const toggle = screen.getByTestId('chat-sent-toggle');
    expect(toggle.textContent).toContain('typecheck-leak');
    expect(screen.getByTestId('chat-sent-preview').textContent).toContain('xxx');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('chat-sent-body')).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('chat-sent-body').textContent).toContain(long);
    fireEvent.click(toggle);
    expect(screen.queryByTestId('chat-sent-body')).toBeNull();
  });

  it('expands from the keyboard', async () => {
    const user = userEvent.setup();
    render(<UserMessage item={item({ text: 'x', source: 'mcp', routed: routed(long) })} />);
    await user.tab();
    expect(document.activeElement).toBe(screen.getByTestId('chat-sent-toggle'));
    await user.keyboard('{Enter}');
    expect(screen.getByTestId('chat-sent-body')).toBeTruthy();
    await user.keyboard(' ');
    expect(screen.queryByTestId('chat-sent-body')).toBeNull();
  });

  it('keeps a message open when the stream unmounts and remounts it', () => {
    const store = createTranscriptExpansionStore();
    const row = () => (
      <TranscriptExpansionProvider store={store}>
        <UserMessage item={item({ text: 'x', source: 'mcp', routed: routed(long) })} expansionKey="k" />
      </TranscriptExpansionProvider>
    );
    const first = render(row());
    fireEvent.click(screen.getByTestId('chat-sent-toggle'));
    first.unmount();
    render(row());
    expect(screen.getByTestId('chat-sent-body')).toBeTruthy();
  });

  it('renders a restored transcript the same, from its stored event', () => {
    const state = reduceChatEvent(undefined, {
      v: 2, agentId: 'a', sessionId: 's', seq: 1, ts: 1, type: 'user_message',
      data: { messageId: 'm', content: [{ type: 'text', text: '[FROM:gone@p] Hi' }], source: 'mcp', delivery: 'prompt', routed: routed('Hi', 'durable_9', 'gone') },
    });
    render(<UserMessage item={state.items[0] as UserMessageItem} />);
    expect(screen.getByTestId('chat-sent-name').textContent).toBe('gone');
    expect(screen.getByTestId('chat-sent-body').textContent).toContain('Hi');
  });
});

describe('isLongMessage', () => {
  it('goes by length or by lines, past the limit only', () => {
    expect(isLongMessage('x'.repeat(LONG_MESSAGE_CHARS))).toBe(false);
    expect(isLongMessage('x'.repeat(LONG_MESSAGE_CHARS + 1))).toBe(true);
    expect(isLongMessage('one line\n')).toBe(false);
    expect(isLongMessage('two\nlines')).toBe(true);
  });
});

it('shows an empty response as a quiet notice rather than a failed turn (#3284)', () => {
  const notice: NoticeItem = { id: 'notice:s:1', sessionId: 's', seq: 1, ts: 1, kind: 'notice', level: 'info', code: 'empty_response', message: 'No response' };
  const end: TurnEndItem = { id: 'end:s:2', sessionId: 's', seq: 2, ts: 2, kind: 'turn_end', stopReason: 'end_turn' };
  render(<><NoticeRow item={notice} /><TurnFooter item={end} turnNumber={1} capabilities={null} /></>);
  expect(screen.getByTestId('chat-notice').textContent).toBe('No response');
  expect(screen.getByTestId('chat-notice').className).toContain('text-ctp-overlay1');
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByText('Turn failed')).toBeNull();
});

it('restores an Action summary and uses Settings navigation and the user turn-off path', async () => {
  let enabled = true;
  window.clubhouse.actions.list = vi.fn(async () => [{ id: 'a1', enabled } as import('../../../../shared/actions').ActionView]);
  window.clubhouse.actions.setEnabled = vi.fn(async () => { enabled = false; return { id: 'a1', enabled } as import('../../../../shared/actions').ActionView; });
  const state = reduceChatEvent(undefined, {
    v: 2, agentId: 'conversation', sessionId: 's', seq: 1, ts: 1, type: 'notice',
    data: {
      level: 'info', code: 'action_changed', message: 'raw fallback',
      actionSummary: { id: 'a1', name: 'Morning', trigger: 'Every day at 9:00 AM', steps: 'Notify you', enabled: true },
    },
  });
  render(<NoticeRow item={state.items[0] as NoticeItem} />);
  expect(screen.getByTestId('chat-action-summary').textContent).toContain('Morning');
  expect(screen.getByText('Every day at 9:00 AM')).toBeTruthy();
  expect(screen.getByText('Notify you')).toBeTruthy();
  expect(screen.queryByText('raw fallback')).toBeNull();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Open' })).not.toBeDisabled());
  fireEvent.click(screen.getByRole('button', { name: 'Open' }));
  expect(useActionsNav.getState().pending).toEqual({ cardId: 'a1' });
  fireEvent.click(screen.getByRole('button', { name: 'Turn off' }));
  await waitFor(() => expect(window.clubhouse.actions.setEnabled).toHaveBeenCalledWith('a1', false));
  await waitFor(() => expect(screen.getByText('Off')).toBeTruthy());
});

it('shows a turn-off error without claiming the Action is off', async () => {
  window.clubhouse.actions.list = vi.fn(async () => [{ id: 'a1', enabled: true } as import('../../../../shared/actions').ActionView]);
  window.clubhouse.actions.setEnabled = vi.fn(async () => { throw new Error('Could not save'); });
  const notice: NoticeItem = {
    id: 'n', sessionId: 's', seq: 1, ts: 1, kind: 'notice', level: 'info', code: 'action_changed', message: '',
    actionSummary: { id: 'a1', name: 'Morning', trigger: 'Every day', steps: 'Notify you', enabled: true },
  };
  render(<NoticeRow item={notice} />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Turn off' })).not.toBeDisabled());
  fireEvent.click(screen.getByRole('button', { name: 'Turn off' }));
  expect((await screen.findByRole('alert')).textContent).toContain('Could not save');
  expect(screen.getByText('On')).toBeTruthy();
});

describe('AgentMessage', () => {
  const message: AgentMessageItem = { id: 'msg:s:1', sessionId: 's', seq: 1, ts: 1, kind: 'agent_message', messageId: '1', text: 'Reply', streaming: false };

  it('shows a name only when given one', () => {
    const { rerender } = render(<AgentMessage item={message} name="rover" />);
    expect(screen.getByTestId('chat-agent-name').textContent).toBe('rover');
    rerender(<AgentMessage item={message} />);
    expect(screen.queryByTestId('chat-agent-name')).toBeNull();
  });

  it('hides a leading reply marker but not a command\'s own output', () => {
    const marked = { ...message, text: 'TASK_RESULT:t_1: Done' };
    const { rerender } = render(<AgentMessage item={marked} />);
    expect(screen.getByTestId('chat-agent-message').textContent).not.toContain('TASK_RESULT');
    rerender(<AgentMessage item={marked} preformatted />);
    expect(screen.getByTestId('chat-command-output').textContent).toBe('TASK_RESULT:t_1: Done');
  });
});
