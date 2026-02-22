import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PopoutAgentView } from './PopoutAgentView';

const noop = () => {};

vi.mock('../agents/AgentTerminal', () => ({
  AgentTerminal: ({ agentId, focused }: { agentId: string; focused?: boolean }) => (
    <div data-testid="agent-terminal" data-agent-id={agentId} data-focused={focused} />
  ),
}));

vi.mock('../agents/SleepingAgent', () => ({
  SleepingAgent: ({ agent }: { agent: { id: string } }) => (
    <div data-testid="sleeping-agent" data-agent-id={agent.id} />
  ),
}));

vi.mock('../agents/AgentAvatar', () => ({
  AgentAvatarWithRing: ({ agent }: { agent: { name: string } }) => (
    <div data-testid="agent-avatar" data-name={agent.name} />
  ),
}));

const mockAgents: Record<string, any> = {};

vi.mock('../../stores/agentStore', () => ({
  useAgentStore: (selector: (s: any) => any) => selector({
    agents: mockAgents,
    spawnDurableAgent: vi.fn(),
  }),
}));

vi.mock('../../stores/projectStore', () => ({
  useProjectStore: (selector: (s: any) => any) => selector({
    projects: [],
  }),
}));

describe('PopoutAgentView', () => {
  beforeEach(() => {
    // Clear mock agents
    for (const key of Object.keys(mockAgents)) delete mockAgents[key];

    window.clubhouse.pty.onExit = vi.fn().mockReturnValue(noop);
    window.clubhouse.agent.onHookEvent = vi.fn().mockReturnValue(noop);
    window.clubhouse.agent.killAgent = vi.fn().mockResolvedValue(undefined);
    window.clubhouse.pty.kill = vi.fn().mockResolvedValue(undefined);
    window.clubhouse.window.focusMain = vi.fn().mockResolvedValue(undefined);
  });

  it('renders "No agent specified" when no agentId', () => {
    render(<PopoutAgentView />);
    expect(screen.getByText('No agent specified')).toBeInTheDocument();
  });

  it('renders AgentTerminal when agent is running', () => {
    mockAgents['agent-1'] = {
      id: 'agent-1', name: 'test-agent', status: 'running',
      kind: 'durable', projectId: 'proj-1', color: 'red',
    };
    render(<PopoutAgentView agentId="agent-1" projectId="proj-1" />);
    const terminal = screen.getByTestId('agent-terminal');
    expect(terminal).toBeInTheDocument();
    expect(terminal).toHaveAttribute('data-agent-id', 'agent-1');
  });

  it('renders SleepingAgent when agent is sleeping', () => {
    mockAgents['agent-1'] = {
      id: 'agent-1', name: 'test-agent', status: 'sleeping',
      kind: 'durable', projectId: 'proj-1', color: 'red',
    };
    render(<PopoutAgentView agentId="agent-1" projectId="proj-1" />);
    expect(screen.getByTestId('sleeping-agent')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-terminal')).not.toBeInTheDocument();
  });

  it('renders avatar and name in floating bar', () => {
    mockAgents['agent-1'] = {
      id: 'agent-1', name: 'test-agent', status: 'running',
      kind: 'durable', projectId: 'proj-1', color: 'red',
    };
    render(<PopoutAgentView agentId="agent-1" projectId="proj-1" />);
    expect(screen.getByTestId('agent-avatar')).toBeInTheDocument();
    expect(screen.getByText('test-agent')).toBeInTheDocument();
  });

  it('renders stop button when running', () => {
    mockAgents['agent-1'] = {
      id: 'agent-1', name: 'test-agent', status: 'running',
      kind: 'durable', projectId: 'proj-1', color: 'red',
    };
    render(<PopoutAgentView agentId="agent-1" projectId="proj-1" />);
    expect(screen.getByTestId('popout-stop-button')).toBeInTheDocument();
  });

  it('renders wake button when sleeping durable agent', () => {
    mockAgents['agent-1'] = {
      id: 'agent-1', name: 'test-agent', status: 'sleeping',
      kind: 'durable', projectId: 'proj-1', color: 'red',
    };
    render(<PopoutAgentView agentId="agent-1" projectId="proj-1" />);
    expect(screen.getByTestId('popout-wake-button')).toBeInTheDocument();
    expect(screen.queryByTestId('popout-stop-button')).not.toBeInTheDocument();
  });

  it('renders View button that calls focusMain', () => {
    mockAgents['agent-1'] = {
      id: 'agent-1', name: 'test-agent', status: 'running',
      kind: 'durable', projectId: 'proj-1', color: 'red',
    };
    render(<PopoutAgentView agentId="agent-1" projectId="proj-1" />);
    fireEvent.click(screen.getByTestId('popout-view-button'));
    expect(window.clubhouse.window.focusMain).toHaveBeenCalledWith('agent-1');
  });

  it('calls killAgent when stop is clicked', () => {
    mockAgents['agent-1'] = {
      id: 'agent-1', name: 'test-agent', status: 'running',
      kind: 'durable', projectId: 'proj-1', color: 'red',
    };
    render(<PopoutAgentView agentId="agent-1" projectId="proj-1" />);
    fireEvent.click(screen.getByTestId('popout-stop-button'));
    expect(window.clubhouse.agent.killAgent).toHaveBeenCalledWith('agent-1', 'proj-1');
  });

  it('does not render AgentTerminal when no agentId', () => {
    render(<PopoutAgentView />);
    expect(screen.queryByTestId('agent-terminal')).not.toBeInTheDocument();
  });
});
