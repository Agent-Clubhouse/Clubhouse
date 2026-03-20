import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { UpdateGateModal } from './UpdateGateModal';

describe('UpdateGateModal', () => {
  const mockOnCancel = vi.fn();
  const mockOnConfirm = vi.fn();
  const mockOnResolveAgent = vi.fn();

  const baseAgents = [
    { agentId: 'darling-gazelle', agentName: 'darling-gazelle', projectPath: '/projects/club', orchestrator: 'claude-code', isWorking: true, resumeStrategy: 'auto' as const },
    { agentId: 'mega-camel', agentName: 'mega-camel', projectPath: '/projects/club', orchestrator: 'copilot-cli', isWorking: false, resumeStrategy: 'manual' as const },
  ];

  beforeEach(() => { vi.clearAllMocks(); });

  it('renders working agents with action buttons', () => {
    render(<UpdateGateModal agents={baseAgents} onCancel={mockOnCancel} onConfirm={mockOnConfirm} onResolveAgent={mockOnResolveAgent} />);
    expect(screen.getByText('darling-gazelle')).toBeDefined();
    expect(screen.getByText(/actively generating/i)).toBeDefined();
    expect(screen.getByText('Interrupt & Resume')).toBeDefined();
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
  });

  it('enables Restart Now when no working agents', () => {
    const allIdle = baseAgents.map((a) => ({ ...a, isWorking: false }));
    render(<UpdateGateModal agents={allIdle} onCancel={mockOnCancel} onConfirm={mockOnConfirm} onResolveAgent={mockOnResolveAgent} />);
    const btn = screen.getByTestId('update-gate-restart-btn');
    expect(btn).not.toBeDisabled();
  });

  it('calls onResolveAgent with correct action', () => {
    render(<UpdateGateModal agents={baseAgents} onCancel={mockOnCancel} onConfirm={mockOnConfirm} onResolveAgent={mockOnResolveAgent} />);
    fireEvent.click(screen.getByText('Kill'));
    expect(mockOnResolveAgent).toHaveBeenCalledWith('darling-gazelle', 'kill');
  });
});
