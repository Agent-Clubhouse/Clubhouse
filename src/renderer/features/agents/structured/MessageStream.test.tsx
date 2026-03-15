import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageStream } from './MessageStream';

// Spy on the markdown pipeline to verify debounce behaviour
const renderMarkdownSafeSpy = vi.fn<(c: string) => string>();

vi.mock('../../../utils/safe-markdown', () => ({
  renderMarkdownSafe: (...args: unknown[]) => renderMarkdownSafeSpy(...(args as [string])),
}));

describe('MessageStream', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    renderMarkdownSafeSpy.mockImplementation((c: string) => c);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders markdown for non-streaming text immediately', () => {
    renderMarkdownSafeSpy.mockImplementation(() => '<strong>bold</strong>');
    render(<MessageStream text="**bold**" isStreaming={false} />);

    expect(screen.getByTestId('message-stream').innerHTML).toContain('<strong>bold</strong>');
    expect(renderMarkdownSafeSpy).toHaveBeenCalledWith('**bold**');
  });

  it('returns null when text is empty', () => {
    const { container } = render(<MessageStream text="" isStreaming={false} />);
    expect(container.innerHTML).toBe('');
  });

  it('shows cursor when streaming', () => {
    render(<MessageStream text="hello" isStreaming={true} />);
    const cursor = document.querySelector('.animate-pulse');
    expect(cursor).not.toBeNull();
  });

  it('hides cursor when not streaming', () => {
    render(<MessageStream text="hello" isStreaming={false} />);
    const cursor = document.querySelector('.animate-pulse');
    expect(cursor).toBeNull();
  });

  it('debounces markdown processing during streaming', () => {
    const { rerender } = render(<MessageStream text="a" isStreaming={true} />);
    renderMarkdownSafeSpy.mockClear();

    // Simulate rapid token deltas — none should trigger markdown yet
    rerender(<MessageStream text="ab" isStreaming={true} />);
    rerender(<MessageStream text="abc" isStreaming={true} />);
    rerender(<MessageStream text="abcd" isStreaming={true} />);

    expect(renderMarkdownSafeSpy).not.toHaveBeenCalled();

    // Advance past debounce window
    act(() => { vi.advanceTimersByTime(150); });

    // Should have rendered only once with the latest accumulated text
    expect(renderMarkdownSafeSpy).toHaveBeenCalledTimes(1);
    expect(renderMarkdownSafeSpy).toHaveBeenCalledWith('abcd');
  });

  it('renders immediately when streaming stops', () => {
    const { rerender } = render(<MessageStream text="a" isStreaming={true} />);
    renderMarkdownSafeSpy.mockClear();

    // Simulate a few deltas then stop streaming
    rerender(<MessageStream text="ab" isStreaming={true} />);
    rerender(<MessageStream text="abc" isStreaming={true} />);
    rerender(<MessageStream text="abc" isStreaming={false} />);

    // The transition to isStreaming=false should trigger an immediate update
    expect(renderMarkdownSafeSpy).toHaveBeenCalledWith('abc');
  });

  it('does not leave stale timers after unmount', () => {
    const { unmount } = render(<MessageStream text="a" isStreaming={true} />);
    renderMarkdownSafeSpy.mockClear();

    unmount();

    // Advancing timers should not throw or trigger state updates
    act(() => { vi.advanceTimersByTime(200); });
    expect(renderMarkdownSafeSpy).not.toHaveBeenCalled();
  });
});
