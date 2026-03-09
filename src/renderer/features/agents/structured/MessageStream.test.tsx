import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MessageStream } from './MessageStream';

describe('MessageStream', () => {
  it('renders trusted markdown formatting for structured output', () => {
    render(<MessageStream text="**bold** and [docs](https://example.com)" isStreaming={false} />);

    expect(screen.getByText('bold').tagName).toBe('STRONG');
    const link = screen.getByRole('link', { name: 'docs' });
    expect(link).toHaveAttribute('href', 'https://example.com');
  });

  it('sanitizes quote-based href breakout payloads', () => {
    render(
      <MessageStream
        text={'[click](https://example.com" onclick="alert(1))'}
        isStreaming={false}
      />,
    );

    const link = document.querySelector('a');
    expect(link).not.toBeNull();
    expect(link).toHaveAttribute('href', 'https://example.com');
    expect(link).not.toHaveAttribute('onclick');
    expect(link.outerHTML).not.toContain('alert(1)');
  });

  it('strips unsafe link protocols from structured output', () => {
    render(<MessageStream text={'[click](javascript:alert(1))'} isStreaming={false} />);

    const link = document.querySelector('a');
    expect(link).not.toBeNull();
    expect(link).not.toHaveAttribute('href');
  });
});
