import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { PopoutAgentActions } from './PopoutAgentActions';

const mockAgents: Record<string, any> = {};

vi.mock('../../stores/agentStore', () => ({
  useAgentStore: (selector: (s: any) => any) => selector({
    agents: mockAgents,
    spawnDurableAgent: vi.fn(),
  }),
}));

vi.mock('../../stores/projectStore', () => ({
  useProjectStore: (selector: (s: any) => any) => selector({ projects: [] }),
}));

const agent = (over: Record<string, unknown> = {}) => ({
  id: 'agent-1', name: 'test-agent', status: 'running', kind: 'durable', projectId: 'proj-1', color: 'red', ...over,
});

function setWidth(w: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: w });
}

describe('PopoutAgentActions', () => {
  const width = window.innerWidth;
  beforeEach(() => {
    for (const key of Object.keys(mockAgents)) delete mockAgents[key];
    window.clubhouse.agent.killAgent = vi.fn().mockResolvedValue(undefined);
    window.clubhouse.pty.kill = vi.fn().mockResolvedValue(undefined);
    window.clubhouse.window.focusMain = vi.fn().mockResolvedValue(undefined);
    setWidth(800);
  });
  afterEach(() => setWidth(width));

  it('shows Show in main window and Stop while running', () => {
    mockAgents['agent-1'] = agent();
    render(<PopoutAgentActions agentId="agent-1" projectId="proj-1" />);
    expect(screen.getByTestId('popout-view-button')).toHaveTextContent('Show in main window');
    expect(screen.getByTestId('popout-stop-button')).toHaveTextContent('Stop');
    expect(screen.queryByTestId('popout-wake-button')).not.toBeInTheDocument();
  });

  it('shows Wake instead of Stop for a sleeping durable agent', () => {
    mockAgents['agent-1'] = agent({ status: 'sleeping' });
    render(<PopoutAgentActions agentId="agent-1" projectId="proj-1" />);
    expect(screen.getByTestId('popout-wake-button')).toBeInTheDocument();
    expect(screen.queryByTestId('popout-stop-button')).not.toBeInTheDocument();
  });

  it('offers no Wake for a sleeping quick agent', () => {
    mockAgents['agent-1'] = agent({ status: 'sleeping', kind: 'quick' });
    render(<PopoutAgentActions agentId="agent-1" projectId="proj-1" />);
    expect(screen.queryByTestId('popout-wake-button')).not.toBeInTheDocument();
  });

  it('shows the agent in the main window and stops it', () => {
    mockAgents['agent-1'] = agent();
    render(<PopoutAgentActions agentId="agent-1" projectId="proj-1" />);
    fireEvent.click(screen.getByTestId('popout-view-button'));
    expect(window.clubhouse.window.focusMain).toHaveBeenCalledWith('agent-1');
    fireEvent.click(screen.getByTestId('popout-stop-button'));
    expect(window.clubhouse.agent.killAgent).toHaveBeenCalledWith('agent-1', 'proj-1');
  });

  it('turns into icons with tooltips below 640px wide', () => {
    mockAgents['agent-1'] = agent();
    render(<PopoutAgentActions agentId="agent-1" projectId="proj-1" />);
    act(() => { setWidth(400); window.dispatchEvent(new Event('resize')); });
    const view = screen.getByTestId('popout-view-button');
    expect(view).toHaveTextContent('');
    expect(view).toHaveAttribute('aria-label', 'Show in main window');
    expect(view).toHaveAttribute('title', 'Show in main window');
    expect(screen.getByTestId('popout-stop-button')).toHaveAttribute('aria-label', 'Stop agent');
  });
});
