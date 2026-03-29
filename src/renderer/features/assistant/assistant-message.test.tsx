import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AssistantMessage } from './AssistantMessage';
import type { AssistantMessage as AssistantMessageType } from './types';

function makeMessage(overrides: Partial<AssistantMessageType> = {}): AssistantMessageType {
  return {
    id: 'msg_1',
    role: 'assistant',
    content: 'Hello world',
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('AssistantMessage', () => {
  it('renders user message with user-message testid', () => {
    const msg = makeMessage({ role: 'user', content: 'Hi there' });
    render(<AssistantMessage message={msg} />);

    expect(screen.getByTestId('user-message')).toBeInTheDocument();
    expect(screen.queryByTestId('assistant-message')).not.toBeInTheDocument();
  });

  it('renders assistant message with assistant-message testid', () => {
    const msg = makeMessage({ role: 'assistant', content: 'Hello!' });
    render(<AssistantMessage message={msg} />);

    expect(screen.getByTestId('assistant-message')).toBeInTheDocument();
    expect(screen.queryByTestId('user-message')).not.toBeInTheDocument();
  });

  it('displays user message content as plain text', () => {
    const msg = makeMessage({ role: 'user', content: 'What is Clubhouse?' });
    render(<AssistantMessage message={msg} />);

    expect(screen.getByText('What is Clubhouse?')).toBeInTheDocument();
  });

  it('renders assistant message content as markdown HTML', () => {
    const msg = makeMessage({ role: 'assistant', content: '**bold text**' });
    render(<AssistantMessage message={msg} />);

    const el = screen.getByTestId('assistant-message');
    // Markdown should be rendered as HTML with <strong>
    expect(el.innerHTML).toContain('<strong>');
    expect(el.textContent).toContain('bold text');
  });

  it('shows mascot avatar on assistant messages', () => {
    const msg = makeMessage({ role: 'assistant', content: 'Hello' });
    render(<AssistantMessage message={msg} />);

    // Avatar is an SVG inside the assistant message container
    const container = screen.getByTestId('assistant-message').parentElement!;
    const svg = container.querySelector('svg');
    expect(svg).toBeInTheDocument();
  });

  it('does not show avatar on user messages', () => {
    const msg = makeMessage({ role: 'user', content: 'Hi' });
    render(<AssistantMessage message={msg} />);

    const container = screen.getByTestId('user-message').parentElement!;
    const svg = container.querySelector('svg');
    expect(svg).not.toBeInTheDocument();
  });

  it('renders code blocks in assistant messages', () => {
    const msg = makeMessage({ role: 'assistant', content: '```js\nconsole.log("hi")\n```' });
    render(<AssistantMessage message={msg} />);

    const el = screen.getByTestId('assistant-message');
    expect(el.innerHTML).toContain('<code');
    expect(el.textContent).toContain('console.log');
  });
});
