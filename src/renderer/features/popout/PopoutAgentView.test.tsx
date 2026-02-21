import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PopoutAgentView } from './PopoutAgentView';

const noop = () => {};

vi.mock('../agents/AgentTerminal', () => ({
  AgentTerminal: ({ agentId, focused }: { agentId: string; focused?: boolean }) => (
    <div data-testid="agent-terminal" data-agent-id={agentId} data-focused={focused} />
  ),
}));

describe('PopoutAgentView', () => {
  beforeEach(() => {
    window.clubhouse.pty.onExit = vi.fn().mockReturnValue(noop);
    window.clubhouse.agent.onHookEvent = vi.fn().mockReturnValue(noop);
    window.clubhouse.agent.killAgent = vi.fn().mockResolvedValue(undefined);
    window.clubhouse.pty.kill = vi.fn().mockResolvedValue(undefined);
  });

  it('renders "No agent specified" when no agentId', () => {
    render(<PopoutAgentView />);
    expect(screen.getByText('No agent specified')).toBeInTheDocument();
  });

  it('renders AgentTerminal with correct agentId', () => {
    render(<PopoutAgentView agentId="agent-1" projectId="proj-1" />);
    const terminal = screen.getByTestId('agent-terminal');
    expect(terminal).toBeInTheDocument();
    expect(terminal).toHaveAttribute('data-agent-id', 'agent-1');
    expect(terminal).toHaveAttribute('data-focused', 'true');
  });

  it('renders stop button when running', () => {
    render(<PopoutAgentView agentId="agent-1" projectId="proj-1" />);
    expect(screen.getByTestId('popout-stop-button')).toBeInTheDocument();
  });

  it('calls killAgent when stop is clicked', () => {
    render(<PopoutAgentView agentId="agent-1" projectId="proj-1" />);
    fireEvent.click(screen.getByTestId('popout-stop-button'));
    expect(window.clubhouse.agent.killAgent).toHaveBeenCalledWith('agent-1', 'proj-1');
  });

  it('does not render AgentTerminal when no agentId', () => {
    render(<PopoutAgentView />);
    expect(screen.queryByTestId('agent-terminal')).not.toBeInTheDocument();
  });
});
