import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { AssistantActionCard } from './AssistantActionCard';
import type { ActionCardData } from './types';

function makeAction(overrides: Partial<ActionCardData> = {}): ActionCardData {
  return {
    id: 'action-1',
    toolName: 'create_project',
    description: 'Create a new project',
    status: 'completed',
    ...overrides,
  };
}

describe('AssistantActionCard', () => {
  it('renders with completed status', () => {
    render(<AssistantActionCard action={makeAction({ status: 'completed' })} />);
    expect(screen.getByTestId('assistant-action-card')).toBeInTheDocument();
    expect(screen.getByTestId('assistant-action-card')).toHaveAttribute('data-status', 'completed');
  });

  it('renders human-friendly tool name', () => {
    render(<AssistantActionCard action={makeAction({ toolName: 'create_project' })} />);
    expect(screen.getByText('Create project')).toBeInTheDocument();
  });

  it('renders unknown tool name as-is with underscores replaced', () => {
    render(<AssistantActionCard action={makeAction({ toolName: 'some_unknown_tool' })} />);
    expect(screen.getByText('some unknown tool')).toBeInTheDocument();
  });

  it('shows description in header', () => {
    render(<AssistantActionCard action={makeAction({ description: 'My action' })} />);
    expect(screen.getByText('My action')).toBeInTheDocument();
  });

  it('expands on header click', () => {
    const action = makeAction({
      status: 'completed',
      input: { path: '/foo' },
    });
    render(<AssistantActionCard action={action} />);
    const card = screen.getByTestId('assistant-action-card');
    // Initially closed for completed (no error/pending)
    expect(card.querySelector('details')).not.toBeInTheDocument();
    fireEvent.click(card.querySelector('button')!);
    expect(card.querySelector('details')).toBeInTheDocument();
  });

  it('collapses after second click on header', () => {
    const action = makeAction({ status: 'completed', input: { path: '/foo' } });
    render(<AssistantActionCard action={action} />);
    const headerBtn = screen.getByTestId('assistant-action-card').querySelector('button')!;
    fireEvent.click(headerBtn);
    fireEvent.click(headerBtn);
    expect(screen.getByTestId('assistant-action-card').querySelector('details')).not.toBeInTheDocument();
  });

  it('shows approval controls for pending_approval status', () => {
    render(<AssistantActionCard action={makeAction({ status: 'pending_approval' })} />);
    expect(screen.getByTestId('action-approve')).toBeInTheDocument();
    expect(screen.getByTestId('action-skip')).toBeInTheDocument();
  });

  it('does not show approval controls for completed status', () => {
    render(<AssistantActionCard action={makeAction({ status: 'completed' })} />);
    expect(screen.queryByTestId('action-approve')).not.toBeInTheDocument();
    expect(screen.queryByTestId('action-skip')).not.toBeInTheDocument();
  });

  it('calls onApprove with action id when approve clicked', () => {
    const onApprove = vi.fn();
    render(
      <AssistantActionCard
        action={makeAction({ id: 'act-42', status: 'pending_approval' })}
        onApprove={onApprove}
      />
    );
    fireEvent.click(screen.getByTestId('action-approve'));
    expect(onApprove).toHaveBeenCalledWith('act-42');
  });

  it('calls onSkip with action id when skip clicked', () => {
    const onSkip = vi.fn();
    render(
      <AssistantActionCard
        action={makeAction({ id: 'act-42', status: 'pending_approval' })}
        onSkip={onSkip}
      />
    );
    fireEvent.click(screen.getByTestId('action-skip'));
    expect(onSkip).toHaveBeenCalledWith('act-42');
  });

  it('auto-expands for error status and shows error message', () => {
    const action = makeAction({ status: 'error', error: 'Something went wrong' });
    render(<AssistantActionCard action={action} />);
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
  });

  it('strips JSON wrapper from error message', () => {
    render(
      <AssistantActionCard
        action={makeAction({ status: 'error', error: '{"message":"File not found"}' })}
      />
    );
    expect(screen.getByText('File not found')).toBeInTheDocument();
  });

  it('auto-expands for pending_approval status', () => {
    render(<AssistantActionCard action={makeAction({ status: 'pending_approval' })} />);
    // The approval controls section is rendered (auto-expanded)
    expect(screen.getByTestId('action-approve')).toBeInTheDocument();
  });

  it('shows duration in ms for completed actions under 1s', () => {
    render(<AssistantActionCard action={makeAction({ status: 'completed', durationMs: 450 })} />);
    expect(screen.getByText('450ms')).toBeInTheDocument();
  });

  it('shows duration in seconds for completed actions >= 1s', () => {
    render(<AssistantActionCard action={makeAction({ status: 'completed', durationMs: 2500 })} />);
    expect(screen.getByText('2.5s')).toBeInTheDocument();
  });

  it('shows result summary for completed creation tools', () => {
    render(
      <AssistantActionCard
        action={makeAction({
          status: 'completed',
          toolName: 'create_project',
          output: '{"name":"My Project","id":"p1"}',
        })}
      />
    );
    expect(screen.getByText('project "My Project" created')).toBeInTheDocument();
  });

  it('renders running state with spinning icon', () => {
    render(<AssistantActionCard action={makeAction({ status: 'running' })} />);
    const card = screen.getByTestId('assistant-action-card');
    expect(card).toHaveAttribute('data-status', 'running');
    // <Spinner> renders a span with role="status" and animate-spin
    expect(card.querySelector('[role="status"]')).toBeInTheDocument();
  });

  it('shows skipped text when expanded in skipped state', () => {
    render(<AssistantActionCard action={makeAction({ status: 'skipped' })} />);
    const headerBtn = screen.getByTestId('assistant-action-card').querySelector('button')!;
    fireEvent.click(headerBtn);
    expect(screen.getByText(/Action skipped by user/)).toBeInTheDocument();
  });
});
