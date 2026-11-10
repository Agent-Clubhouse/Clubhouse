import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { useToastStore } from '../../stores/toastStore';
import { PopoutAgentActions } from './PopoutAgentActions';
import { useDispatcherStore } from '../dispatcher/dispatcherStore';
import { DISPATCHER_OFF, DISPATCHER_PROJECT_ID } from '../../../shared/dispatcher-types';

const mockAgents: Record<string, any> = {};

vi.mock('../../stores/agentStore', () => ({
  useAgentStore: (selector: (s: any) => any) => selector({
    agents: mockAgents,
    spawnDurableAgent: vi.fn(),
  }),
}));

vi.mock('../../stores/projectStore', () => ({
  useProjectStore: (selector: (s: any) => any) => selector({ projects: [{ id: 'proj-1', path: '/proj' }] }),
}));

const mockWake = vi.fn();
vi.mock('../agents/wake-durable-agent', () => ({
  wakeDurableAgent: (...args: unknown[]) => mockWake(...args),
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

  it('wakes by resuming the last session, like every other Wake', async () => {
    mockAgents['agent-1'] = agent({ status: 'sleeping' });
    render(<PopoutAgentActions agentId="agent-1" projectId="proj-1" />);
    fireEvent.click(screen.getByTestId('popout-wake-button'));
    await waitFor(() => expect(mockWake).toHaveBeenCalledWith('proj-1', '/proj', 'agent-1', 'resume'));
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
    // The call takes the project's folder.
    expect(window.clubhouse.agent.killAgent).toHaveBeenCalledWith('agent-1', '/proj');
  });

  describe('the Dispatcher (#3235)', () => {
    beforeEach(() => {
      useDispatcherStore.getState().setState({ enabled: true, flagOn: true, agentId: 'disp-work', path: 'dispatcher-work-dir', chatAgentId: 'disp', chatPath: 'dispatcher-dir', config: null });
    });
    afterEach(() => useDispatcherStore.getState().setState(DISPATCHER_OFF));

    it('wakes it in its folder, which is no registered project', async () => {
      mockAgents.disp = agent({ id: 'disp', name: 'Dispatcher', status: 'sleeping', projectId: DISPATCHER_PROJECT_ID });
      render(<PopoutAgentActions agentId="disp" projectId={DISPATCHER_PROJECT_ID} />);
      fireEvent.click(screen.getByTestId('popout-wake-button'));
      await waitFor(() => expect(mockWake).toHaveBeenCalledWith(DISPATCHER_PROJECT_ID, 'dispatcher-dir', 'disp', 'resume'));
    });

    it('stops it with its folder and shows its view in the main window', () => {
      mockAgents.disp = agent({ id: 'disp', name: 'Dispatcher', projectId: DISPATCHER_PROJECT_ID });
      render(<PopoutAgentActions agentId="disp" projectId={DISPATCHER_PROJECT_ID} />);
      fireEvent.click(screen.getByTestId('popout-stop-button'));
      expect(window.clubhouse.agent.killAgent).toHaveBeenCalledWith('disp', 'dispatcher-dir');
      fireEvent.click(screen.getByTestId('popout-view-button'));
      expect(window.clubhouse.window.focusMain).toHaveBeenCalledWith('disp');
    });
  });

  it('toasts when Stop fails', async () => {
    window.clubhouse.agent.killAgent = vi.fn().mockRejectedValue(new Error('gone'));
    mockAgents['agent-1'] = agent();
    render(<PopoutAgentActions agentId="agent-1" projectId="proj-1" />);
    fireEvent.click(screen.getByTestId('popout-stop-button'));
    await waitFor(() => expect(useToastStore.getState().toasts.some((t) => t.message.includes("Couldn't stop the agent: gone"))).toBe(true));
  });

  it('turns into icons with tooltips below 640px wide', () => {
    mockAgents['agent-1'] = agent();
    render(<PopoutAgentActions agentId="agent-1" projectId="proj-1" />);
    act(() => { setWidth(400); window.dispatchEvent(new Event('resize')); });
    const view = screen.getByTestId('popout-view-button');
    expect(view).toHaveTextContent('');
    expect(view).toHaveAttribute('aria-label', 'Show in main window');
    expect(screen.getByTestId('popout-stop-button')).toHaveAttribute('aria-label', 'Stop agent');
  });
});
