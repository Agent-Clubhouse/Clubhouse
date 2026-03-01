import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ActionBar } from './ActionBar';

describe('ActionBar', () => {
  const defaultProps = {
    agentId: 'a1',
    elapsed: 45_000,
    usage: null,
    isComplete: false,
    onStop: vi.fn(),
    onSendMessage: vi.fn(),
  };

  it('renders elapsed time', () => {
    render(<ActionBar {...defaultProps} />);
    expect(screen.getByText('45s')).toBeInTheDocument();
  });

  it('renders stop button when not complete', () => {
    render(<ActionBar {...defaultProps} />);
    expect(screen.getByTestId('stop-button')).toBeInTheDocument();
  });

  it('hides stop button when complete', () => {
    render(<ActionBar {...defaultProps} isComplete={true} />);
    expect(screen.queryByTestId('stop-button')).not.toBeInTheDocument();
  });

  it('hides message input when complete', () => {
    render(<ActionBar {...defaultProps} isComplete={true} />);
    expect(screen.queryByTestId('message-input')).not.toBeInTheDocument();
  });

  it('calls onStop when stop is clicked', () => {
    const onStop = vi.fn();
    render(<ActionBar {...defaultProps} onStop={onStop} />);

    fireEvent.click(screen.getByTestId('stop-button'));
    expect(onStop).toHaveBeenCalled();
  });

  it('calls onSendMessage with text on Enter', () => {
    const onSendMessage = vi.fn();
    render(<ActionBar {...defaultProps} onSendMessage={onSendMessage} />);

    const input = screen.getByTestId('message-input');
    act(() => {
      fireEvent.change(input, { target: { value: 'test message' } });
      fireEvent.keyDown(input, { key: 'Enter' });
    });

    expect(onSendMessage).toHaveBeenCalledWith('test message');
  });

  it('clears input after sending', () => {
    const onSendMessage = vi.fn();
    render(<ActionBar {...defaultProps} onSendMessage={onSendMessage} />);

    const input = screen.getByTestId('message-input') as HTMLInputElement;
    act(() => {
      fireEvent.change(input, { target: { value: 'test' } });
      fireEvent.keyDown(input, { key: 'Enter' });
    });

    expect(input.value).toBe('');
  });

  it('renders cost tracker when usage is provided', () => {
    render(
      <ActionBar
        {...defaultProps}
        usage={{ inputTokens: 1200, outputTokens: 450, costUsd: 0.003 }}
      />,
    );

    expect(screen.getByTestId('cost-tracker')).toBeInTheDocument();
  });

  it('formats elapsed time as minutes', () => {
    render(<ActionBar {...defaultProps} elapsed={125_000} />);
    expect(screen.getByText('2m 5s')).toBeInTheDocument();
  });
});
