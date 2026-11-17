import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { foldChatEvents } from '../../../stores/chatStore';
import { ChatStream } from './ChatStream';
import { ChatFixture, FIXTURE_AGENT_ID, PROFILES } from './fixtures';

/** Messages routed from other agents stay in the stream, in order, outside tool groups (#3614). */
describe('ChatStream messages from others', () => {
  const run = (f: ChatFixture, id: string) =>
    ['a', 'b'].forEach((n) => {
      f.tool('t', { toolCallId: `${id}-${n}`, kind: 'execute', title: id, status: 'in_progress', content: [{ type: 'terminal', command: id, output: 'ok\n', exitCode: 0 }] });
    });

  it('shows the message between two tool groups without opening anything', () => {
    const prof = PROFILES.claude;
    const f = new ChatFixture();
    f.start(prof.driver, prof.provider, prof.capabilities);
    f.prompt('t', 'Go');
    run(f, 'before');
    f.emit('user_message', { messageId: 'm', content: [{ type: 'text', text: 'Build is green' }], text: 'Build is green', source: 'mcp', delivery: 'steer', routed: [{ sender: { name: 'sample-agent' }, text: 'Build is green' }] } as never, { turnId: 't' });
    run(f, 'after');
    render(<ChatStream state={foldChatEvents(undefined, FIXTURE_AGENT_ID, f.events)} />);

    const labels = screen.getAllByTestId('chat-group-toggle').map((t) => t.textContent);
    expect(labels).toEqual(['Made 2 tool calls', 'Made 2 tool calls']);
    expect(screen.getByTestId('chat-sent-name')).toHaveTextContent('sample-agent');
    expect(screen.getByTestId('chat-sent-body')).toHaveTextContent('Build is green');
    const order = screen.getAllByTestId(/^chat-group-toggle$|^chat-sent-part$/).map((el) => el.getAttribute('data-testid'));
    expect(order).toEqual(['chat-group-toggle', 'chat-sent-part', 'chat-group-toggle']);
  });
});
