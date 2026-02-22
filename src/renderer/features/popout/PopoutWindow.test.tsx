import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { PopoutWindow } from './PopoutWindow';

const noop = () => {};

vi.mock('../../stores/themeStore', () => ({
  useThemeStore: (selector: (s: any) => any) => selector({
    loadTheme: vi.fn(),
  }),
}));

// Shared mock state. vi.mock factories are hoisted so we declare at module
// scope with `vi.hoisted` so the mock can safely reference it.
const { mockAgentState, mockSetState } = vi.hoisted(() => ({
  mockAgentState: {
    agents: {} as Record<string, any>,
    agentDetailedStatus: {} as Record<string, any>,
    agentIcons: {} as Record<string, string>,
  },
  mockSetState: vi.fn(),
}));

vi.mock('../../stores/agentStore', () => ({
  useAgentStore: Object.assign(
    (selector: (s: any) => any) => selector(mockAgentState),
    {
      getState: () => ({
        agents: mockAgentState.agents,
        agentDetailedStatus: mockAgentState.agentDetailedStatus,
        agentIcons: mockAgentState.agentIcons,
        handleHookEvent: vi.fn(),
        updateAgentStatus: vi.fn(),
      }),
      setState: mockSetState,
    },
  ),
}));

vi.mock('./PopoutAgentView', () => ({
  PopoutAgentView: ({ agentId }: { agentId?: string }) => (
    <div data-testid="popout-agent-view">{agentId}</div>
  ),
}));

vi.mock('./PopoutHubView', () => ({
  PopoutHubView: ({ hubId }: { hubId?: string }) => (
    <div data-testid="popout-hub-view">{hubId}</div>
  ),
}));

describe('PopoutWindow', () => {
  let getAgentStateMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockAgentState.agents = {};
    mockAgentState.agentDetailedStatus = {};
    mockAgentState.agentIcons = {};
    mockSetState.mockReset();
    getAgentStateMock = vi.fn().mockResolvedValue({
      agents: { 'a1': { id: 'a1', name: 'test', status: 'running', kind: 'durable', projectId: 'p1', color: 'red' } },
      agentDetailedStatus: { 'a1': { state: 'idle', message: 'Thinking', timestamp: 1 } },
      agentIcons: { 'a1': 'data:image/png;base64,...' },
    });
    window.clubhouse.pty.onExit = vi.fn().mockReturnValue(noop);
    window.clubhouse.agent.onHookEvent = vi.fn().mockReturnValue(noop);
    window.clubhouse.window.getAgentState = getAgentStateMock;
    window.clubhouse.window.getPopoutParams = vi.fn().mockReturnValue({
      type: 'hub',
      hubId: 'hub-1',
      projectId: 'proj-1',
    });
  });

  it('shows syncing message while loading state', () => {
    // Delay resolution to keep loading state visible
    getAgentStateMock.mockReturnValue(new Promise(() => {}));

    render(<PopoutWindow />);
    expect(screen.getByText('Syncing agent state...')).toBeInTheDocument();
  });

  it('requests agent state from main window on mount', async () => {
    render(<PopoutWindow />);
    expect(getAgentStateMock).toHaveBeenCalledTimes(1);
  });

  it('hydrates agent store with snapshot from main window', async () => {
    render(<PopoutWindow />);
    await waitFor(() => {
      expect(mockSetState).toHaveBeenCalled();
    });

    const setStateCall = mockSetState.mock.calls[0][0];
    expect(setStateCall.agents).toHaveProperty('a1');
    expect(setStateCall.agentDetailedStatus).toHaveProperty('a1');
    expect(setStateCall.agentIcons).toHaveProperty('a1');
  });

  it('subscribes to hook events on mount', async () => {
    render(<PopoutWindow />);
    expect(window.clubhouse.agent.onHookEvent).toHaveBeenCalled();
  });

  it('subscribes to pty exit events on mount', async () => {
    render(<PopoutWindow />);
    expect(window.clubhouse.pty.onExit).toHaveBeenCalled();
  });

  it('renders hub view after state sync completes', async () => {
    render(<PopoutWindow />);
    await waitFor(() => {
      expect(screen.getByTestId('popout-hub-view')).toBeInTheDocument();
    });
    expect(screen.getByText('hub-1')).toBeInTheDocument();
  });

  it('renders agent view when type is agent', async () => {
    (window.clubhouse.window.getPopoutParams as any).mockReturnValue({
      type: 'agent',
      agentId: 'a1',
      projectId: 'proj-1',
    });

    render(<PopoutWindow />);
    await waitFor(() => {
      expect(screen.getByTestId('popout-agent-view')).toBeInTheDocument();
    });
  });

  it('shows invalid config message when params are null', () => {
    (window.clubhouse.window.getPopoutParams as any).mockReturnValue(null);

    render(<PopoutWindow />);
    expect(screen.getByText('Invalid pop-out configuration')).toBeInTheDocument();
  });

  it('still renders on snapshot failure', async () => {
    getAgentStateMock.mockRejectedValue(new Error('IPC failed'));

    render(<PopoutWindow />);
    await waitFor(() => {
      expect(screen.getByTestId('popout-hub-view')).toBeInTheDocument();
    });
  });
});
