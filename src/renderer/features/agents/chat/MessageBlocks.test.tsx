import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RoutedMessagePart } from '../../../../shared/chat';
import type { Agent } from '../../../../shared/types';
import { useAgentStore } from '../../../stores/agentStore';
import { reduceChatEvent, type AgentMessageItem, type UserMessageItem } from '../../../stores/chatStore';
import { AgentMessage, isLongMessage, LONG_MESSAGE_CHARS, LONG_MESSAGE_LINES, UserMessage } from './MessageBlocks';
import { createTranscriptExpansionStore, TranscriptExpansionProvider } from './transcript-expansion';

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

  it('keeps the source and steer labels readable', () => {
    render(<UserMessage item={item({ text: 'hi', source: 'annex', delivery: 'steer' })} />);
    expect(screen.getByTestId('chat-you-label').textContent).toBe('You · From Annex · Steered into the running turn');
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

  it('shows the current name after a rename', () => {
    useAgentStore.setState({ agents: { durable_1: agent({ name: 'renamed' }) } });
    render(<UserMessage item={item({ text: 'x', source: 'mcp', routed: routed('Short') })} />);
    expect(screen.getByTestId('chat-sent-name').textContent).toBe('renamed');
  });

  it('still names an agent that no longer exists', () => {
    render(<UserMessage item={item({ text: 'x', source: 'mcp', routed: routed('Short') })} />);
    expect(screen.getByTestId('chat-sent-name').textContent).toBe('typecheck-leak');
    expect(screen.getByTestId('chat-sent-avatar').textContent).toBe('TL');
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
    expect(toggle.textContent).toContain('typecheck-leak sent a long message');
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
    expect(isLongMessage(Array(LONG_MESSAGE_LINES).fill('y').join('\n'))).toBe(false);
    expect(isLongMessage(Array(LONG_MESSAGE_LINES + 1).fill('y').join('\n'))).toBe(true);
  });
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
