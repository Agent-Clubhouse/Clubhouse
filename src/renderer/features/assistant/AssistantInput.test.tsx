import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { AssistantInput } from './AssistantInput';

describe('AssistantInput', () => {
  it('renders the input and send button', () => {
    render(<AssistantInput onSend={vi.fn()} status="idle" />);
    expect(screen.getByTestId('assistant-message-input')).toBeInTheDocument();
    expect(screen.getByTestId('assistant-send-button')).toBeInTheDocument();
  });

  it('shows idle placeholder by default', () => {
    render(<AssistantInput onSend={vi.fn()} status="idle" />);
    expect(screen.getByPlaceholderText('Ask anything…')).toBeInTheDocument();
  });

  it('shows responding placeholder when status is responding', () => {
    render(<AssistantInput onSend={vi.fn()} status="responding" />);
    expect(screen.getByPlaceholderText('Waiting for response…')).toBeInTheDocument();
  });

  it('shows starting placeholder when status is starting', () => {
    render(<AssistantInput onSend={vi.fn()} status="starting" />);
    expect(screen.getByPlaceholderText('Starting assistant…')).toBeInTheDocument();
  });

  it('updates input value as user types', async () => {
    render(<AssistantInput onSend={vi.fn()} status="idle" />);
    const input = screen.getByTestId('assistant-message-input');
    await userEvent.type(input, 'hello');
    expect(input).toHaveValue('hello');
  });

  it('calls onSend with trimmed message on Enter', async () => {
    const onSend = vi.fn();
    render(<AssistantInput onSend={onSend} status="idle" />);
    const input = screen.getByTestId('assistant-message-input');
    await userEvent.type(input, '  hello world  ');
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });
    expect(onSend).toHaveBeenCalledWith('hello world');
  });

  it('clears input after sending via Enter', async () => {
    render(<AssistantInput onSend={vi.fn()} status="idle" />);
    const input = screen.getByTestId('assistant-message-input');
    await userEvent.type(input, 'hello');
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });
    expect(input).toHaveValue('');
  });

  it('does not submit on Shift+Enter', async () => {
    const onSend = vi.fn();
    render(<AssistantInput onSend={onSend} status="idle" />);
    const input = screen.getByTestId('assistant-message-input');
    await userEvent.type(input, 'hello');
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    expect(input).toHaveValue('hello');
  });

  it('calls onSend when send button is clicked', async () => {
    const onSend = vi.fn();
    render(<AssistantInput onSend={onSend} status="idle" />);
    const input = screen.getByTestId('assistant-message-input');
    await userEvent.type(input, 'test message');
    fireEvent.click(screen.getByTestId('assistant-send-button'));
    expect(onSend).toHaveBeenCalledWith('test message');
  });

  it('does not call onSend with empty input', async () => {
    const onSend = vi.fn();
    render(<AssistantInput onSend={onSend} status="idle" />);
    fireEvent.keyDown(screen.getByTestId('assistant-message-input'), { key: 'Enter' });
    fireEvent.click(screen.getByTestId('assistant-send-button'));
    expect(onSend).not.toHaveBeenCalled();
  });

  it('does not call onSend with whitespace-only input', async () => {
    const onSend = vi.fn();
    render(<AssistantInput onSend={onSend} status="idle" />);
    const input = screen.getByTestId('assistant-message-input');
    await userEvent.type(input, '   ');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('disables textarea and send button when disabled prop is true', () => {
    render(<AssistantInput onSend={vi.fn()} status="idle" disabled />);
    expect(screen.getByTestId('assistant-message-input')).toBeDisabled();
    expect(screen.getByTestId('assistant-send-button')).toBeDisabled();
  });

  it('does not send when disabled even with text entered', async () => {
    const onSend = vi.fn();
    render(<AssistantInput onSend={onSend} status="idle" disabled />);
    const input = screen.getByTestId('assistant-message-input');
    fireEvent.change(input, { target: { value: 'hello' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.click(screen.getByTestId('assistant-send-button'));
    expect(onSend).not.toHaveBeenCalled();
  });

  it('send button is disabled when input is empty', () => {
    render(<AssistantInput onSend={vi.fn()} status="idle" />);
    expect(screen.getByTestId('assistant-send-button')).toBeDisabled();
  });

  it('send button is enabled when input has text', async () => {
    render(<AssistantInput onSend={vi.fn()} status="idle" />);
    const input = screen.getByTestId('assistant-message-input');
    await userEvent.type(input, 'hello');
    expect(screen.getByTestId('assistant-send-button')).not.toBeDisabled();
  });
});
