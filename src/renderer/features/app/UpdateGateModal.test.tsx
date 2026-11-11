import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { UpdateGateModal } from './UpdateGateModal';

describe('UpdateGateModal', () => {
  const mockOnCancel = vi.fn();
  const mockOnConfirm = vi.fn();
  const mockOnResolveAgent = vi.fn();

  const baseAgents = [
    { agentId: 'darling-gazelle', agentName: 'darling-gazelle', projectPath: 'project', orchestrator: 'claude-code', isWorking: true, resumeStrategy: 'auto' as const },
    { agentId: 'mega-camel', agentName: 'mega-camel', projectPath: 'project', orchestrator: 'copilot-cli', isWorking: false, resumeStrategy: 'manual' as const },
  ];

  beforeEach(() => { vi.clearAllMocks(); });

  it('renders working agents with action buttons', () => {
    render(<UpdateGateModal agents={baseAgents} onCancel={mockOnCancel} onConfirm={mockOnConfirm} onResolveAgent={mockOnResolveAgent} />);
    expect(screen.getByText('darling-gazelle')).toBeDefined();
    expect(screen.getByRole('img', { name: 'Working' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Interrupt' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Wait' })).not.toBeInTheDocument();
    expect(screen.getByText(/Only the conversation resumes/)).toBeInTheDocument();
  });

  it('renders idle agents in will-resume section', () => {
    render(<UpdateGateModal agents={baseAgents} onCancel={mockOnCancel} onConfirm={mockOnConfirm} onResolveAgent={mockOnResolveAgent} />);
    expect(screen.getByText('mega-camel')).toBeDefined();
    expect(screen.getByText(/manual resume/i)).toBeDefined();
  });

  it('disables Restart Now when working agents exist', () => {
    render(<UpdateGateModal agents={baseAgents} onCancel={mockOnCancel} onConfirm={mockOnConfirm} onResolveAgent={mockOnResolveAgent} />);
    const btn = screen.getByTestId('update-gate-restart-btn');
    expect(btn).toBeDisabled();
    expect(btn).toHaveAccessibleDescription(/Restart is unavailable while agents are working/);
  });

  it('enables Restart Now when no working agents', () => {
    const allIdle = baseAgents.map((a) => ({ ...a, isWorking: false }));
    render(<UpdateGateModal agents={allIdle} onCancel={mockOnCancel} onConfirm={mockOnConfirm} onResolveAgent={mockOnResolveAgent} />);
    const btn = screen.getByTestId('update-gate-restart-btn');
    expect(btn).not.toBeDisabled();
  });

  it('calls onResolveAgent with correct action', () => {
    render(<UpdateGateModal agents={baseAgents} onCancel={mockOnCancel} onConfirm={mockOnConfirm} onResolveAgent={mockOnResolveAgent} />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop now' }));
    expect(mockOnResolveAgent).toHaveBeenCalledWith('darling-gazelle', 'kill');
  });

  it.each(['interrupt', 'kill'] as const)('shows pending %s and disables repeated actions even if the agent goes idle', (action) => {
    render(<UpdateGateModal agents={baseAgents.map((a) => ({ ...a, isWorking: false }))}
      actionStates={{ 'darling-gazelle': { action, status: 'pending' } }}
      onCancel={mockOnCancel} onConfirm={mockOnConfirm} onResolveAgent={mockOnResolveAgent} />);
    expect(screen.getByRole('status')).toHaveTextContent(action === 'kill' ? 'Stopping...' : 'Interrupting...');
    fireEvent.click(screen.getByRole('button', { name: 'Interrupt' }));
    fireEvent.click(screen.getByRole('button', { name: 'Stop now' }));
    expect(mockOnResolveAgent).not.toHaveBeenCalled();
    expect(screen.getByTestId('update-gate-restart-btn')).toBeDisabled();
  });

  it.each(['error', 'timeout'] as const)('shows an interrupt %s and offers Stop now', (status) => {
    render(<UpdateGateModal agents={baseAgents}
      actionStates={{ 'darling-gazelle': { action: 'interrupt', status, message: 'Choose Stop now to end this agent.' } }}
      onCancel={mockOnCancel} onConfirm={mockOnConfirm} onResolveAgent={mockOnResolveAgent} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Choose Stop now');
    expect(screen.getByRole('button', { name: 'Stop now' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Stop now' }));
    expect(mockOnResolveAgent).toHaveBeenCalledWith('darling-gazelle', 'kill');
  });

  it('explains why Restart is disabled while live agents cannot be checked and allows retry', () => {
    const retry = vi.fn();
    render(<UpdateGateModal agents={[]} error="Could not check active agents." onRetry={retry}
      onCancel={mockOnCancel} onConfirm={mockOnConfirm} onResolveAgent={mockOnResolveAgent} />);
    expect(screen.getByTestId('update-gate-restart-btn')).toHaveAccessibleDescription(/until active agents can be checked/);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledOnce();
  });
});
