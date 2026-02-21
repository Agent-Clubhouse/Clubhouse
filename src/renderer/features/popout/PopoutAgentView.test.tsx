import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PopoutAgentView } from './PopoutAgentView';

describe('PopoutAgentView', () => {
  it('renders "No agent specified" when no agentId', () => {
    render(<PopoutAgentView />);
    expect(screen.getByText('No agent specified')).toBeInTheDocument();
  });

  it('renders agent name and status when agentId is given', () => {
    render(<PopoutAgentView agentId="agent-1" projectId="proj-1" />);
    expect(screen.getByText('agent-1')).toBeInTheDocument();
    expect(screen.getByText('running')).toBeInTheDocument();
  });

  it('renders stop button when running', () => {
    render(<PopoutAgentView agentId="agent-1" projectId="proj-1" />);
    expect(screen.getByTestId('popout-stop-button')).toBeInTheDocument();
  });

  it('calls killAgent when stop is clicked', () => {
    const killAgent = vi.fn().mockResolvedValue(undefined);
    window.clubhouse.agent.killAgent = killAgent;

    render(<PopoutAgentView agentId="agent-1" projectId="proj-1" />);
    fireEvent.click(screen.getByTestId('popout-stop-button'));
    expect(killAgent).toHaveBeenCalledWith('agent-1', 'proj-1');
  });
});
