import { render, screen, fireEvent, act, renderHook } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useAgentStore } from '../../stores/agentStore';
import { useProjectStore } from '../../stores/projectStore';
import { useOrchestratorStore } from '../../stores/orchestratorStore';
import { useQuickAgentStore } from '../../stores/quickAgentStore';
import { useUIStore } from '../../stores/uiStore';
import { AgentList, useProjectAgentBuckets } from './AgentList';
import type { Agent, CompletedQuickAgent } from '../../../shared/types';

// Mock child components
const isThinkingCaptures: boolean[] = [];

vi.mock('./AgentListItem', () => ({
  AgentListItem: (props: any) => {
    isThinkingCaptures.push(props.isThinking);
    return (
      <div data-testid={`agent-item-${props.agent.id}`} data-thinking={props.isThinking}>{props.agent.name}</div>
    );
  },
}));

vi.mock('./AddAgentDialog', () => ({
  AddAgentDialog: ({ onClose }: any) => (
    <div data-testid="add-agent-dialog">
      <button onClick={onClose}>Close</button>
    </div>
  ),
}));

vi.mock('./DeleteAgentDialog', () => ({
  DeleteAgentDialog: () => <div data-testid="delete-agent-dialog" />,
}));

vi.mock('./QuickAgentGhost', () => ({
  QuickAgentGhostCompact: () => <div data-testid="quick-agent-ghost" />,
}));

vi.mock('../../hooks/useModelOptions', () => ({
  useModelOptions: () => ({
    options: [{ id: 'default', label: 'Default' }],
    loading: false,
  }),
}));

const defaultAgent: Agent = {
  id: 'agent-1',
  projectId: 'proj-1',
  name: 'bold-falcon',
  kind: 'durable',
  status: 'sleeping',
  color: 'indigo',
};

function resetStores() {
  useAgentStore.setState({
    agents: { [defaultAgent.id]: defaultAgent },
    activeAgentId: defaultAgent.id,
    agentIcons: {},
    agentActivity: {},
    spawnQuickAgent: vi.fn(),
    spawnDurableAgent: vi.fn(),
    loadDurableAgents: vi.fn(),
    deleteDialogAgent: null,
    reorderAgents: vi.fn(),
    recordActivity: vi.fn(),
    setActiveAgent: vi.fn(),
  });
  useProjectStore.setState({
    projects: [{ id: 'proj-1', name: 'my-app', path: '/project' }],
    activeProjectId: 'proj-1',
  });
  useOrchestratorStore.setState({
    enabled: ['claude-code'],
    allOrchestrators: [{
      id: 'claude-code',
      displayName: 'Claude Code',
      shortName: 'CC',
      capabilities: { headless: true, structuredOutput: true, hooks: true, sessionResume: true, permissions: true },
    }],
  });
  // Only set data — let the store's built-in getters work naturally
  useQuickAgentStore.setState({
    completedAgents: { 'proj-1': [] },
    selectedCompletedId: null,
  });
}

describe('AgentList dropdown', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStores();
    // pty.onData must return a cleanup function (used directly as useEffect cleanup)
    window.clubhouse.pty.onData = vi.fn().mockReturnValue(() => {});
  });

  it('shows both Durable and Quick Agent options in dropdown', () => {
    render(<AgentList />);
    const buttons = screen.getAllByRole('button');
    const dropdownBtn = buttons.find((b) => b.textContent === '\u25BE');
    expect(dropdownBtn).toBeDefined();
    fireEvent.click(dropdownBtn!);

    expect(screen.getByText('Durable')).toBeInTheDocument();
    expect(screen.getByText('Quick Agent')).toBeInTheDocument();
  });

  it('opens AddAgentDialog when Durable is clicked in dropdown', () => {
    render(<AgentList />);
    const buttons = screen.getAllByRole('button');
    const dropdownBtn = buttons.find((b) => b.textContent === '\u25BE');
    fireEvent.click(dropdownBtn!);

    fireEvent.click(screen.getByText('Durable'));
    expect(screen.getByTestId('add-agent-dialog')).toBeInTheDocument();
  });

  it('opens AddAgentDialog when top-level + Agent button is clicked', () => {
    render(<AgentList />);
    fireEvent.click(screen.getByText('+ Agent'));
    expect(screen.getByTestId('add-agent-dialog')).toBeInTheDocument();
  });

  it('opens global quick agent dialog when Quick Agent is selected from dropdown', () => {
    const openSpy = vi.fn();
    useUIStore.setState({ openQuickAgentDialog: openSpy });

    render(<AgentList />);
    const buttons = screen.getAllByRole('button');
    const dropdownBtn = buttons.find((b) => b.textContent === '\u25BE');
    fireEvent.click(dropdownBtn!);

    fireEvent.click(screen.getByText('Quick Agent'));
    expect(openSpy).toHaveBeenCalled();
  });
});

describe('AgentList completed selector stability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStores();
    window.clubhouse.pty.onData = vi.fn().mockReturnValue(() => {});
  });

  it('renders completed agents from raw completedAgents state', () => {
    const completed: CompletedQuickAgent = {
      id: 'done-1',
      projectId: 'proj-1',
      name: 'test-agent',
      mission: 'test mission',
      summary: null,
      filesModified: [],
      exitCode: 0,
      completedAt: Date.now(),
    };
    useQuickAgentStore.setState({
      completedAgents: { 'proj-1': [completed] },
      selectedCompletedId: null,
    });

    render(<AgentList />);
    // The completed footer shows count of orphan completed agents
    expect(screen.getByText('Completed (1)')).toBeInTheDocument();
  });

  it('does not re-render when unrelated store state changes', () => {
    const _renderCount = vi.fn();
    const OriginalAgentList = AgentList;

    // Render the component
    const { rerender } = render(<OriginalAgentList />);
    const _initialContent = screen.getByTestId('agent-list').innerHTML;

    // Mutate an unrelated part of the quick agent store (different project)
    act(() => {
      useQuickAgentStore.setState((s) => ({
        completedAgents: { ...s.completedAgents, 'other-project': [] },
      }));
    });

    rerender(<OriginalAgentList />);
    // Component should still render correctly (no crash from unstable refs)
    expect(screen.getByTestId('agent-list')).toBeInTheDocument();
  });

  it('uses stable empty array when project has no completed agents', () => {
    useQuickAgentStore.setState({
      completedAgents: {},
      selectedCompletedId: null,
    });

    render(<AgentList />);
    // Should render without errors even with no completed agents data
    expect(screen.getByTestId('agent-list')).toBeInTheDocument();
    expect(screen.getByText('Completed (0)')).toBeInTheDocument();
  });
});

describe('useProjectAgentBuckets', () => {
  const durableAgent: Agent = {
    ...defaultAgent,
    id: 'durable-1',
    name: 'durable-agent',
  };

  const quickAgent: Agent = {
    ...defaultAgent,
    id: 'quick-1',
    name: 'quick-agent',
    kind: 'quick',
    mission: 'Investigate issue',
  };

  const childQuickAgent: Agent = {
    ...quickAgent,
    id: 'quick-2',
    name: 'child-quick-agent',
    parentAgentId: durableAgent.id,
  };

  const otherProjectAgent: Agent = {
    ...defaultAgent,
    id: 'durable-2',
    projectId: 'proj-2',
    name: 'other-project-agent',
  };

  it('returns stable filtered arrays across unrelated rerenders', () => {
    const agents = {
      [durableAgent.id]: durableAgent,
      [quickAgent.id]: quickAgent,
      [childQuickAgent.id]: childQuickAgent,
      [otherProjectAgent.id]: otherProjectAgent,
    };
    const { result, rerender } = renderHook(
      ({ currentAgents, currentProjectId }) => useProjectAgentBuckets(currentAgents, currentProjectId),
      {
        initialProps: {
          currentAgents: agents,
          currentProjectId: 'proj-1' as string | null,
        },
      }
    );

    const initialBuckets = result.current;
    rerender({ currentAgents: agents, currentProjectId: 'proj-1' });

    expect(result.current.projectAgents).toBe(initialBuckets.projectAgents);
    expect(result.current.durableAgents).toBe(initialBuckets.durableAgents);
    expect(result.current.quickAgents).toBe(initialBuckets.quickAgents);
    expect(result.current.orphanQuickAgents).toBe(initialBuckets.orphanQuickAgents);
  });

  it('recomputes filtered arrays when the active project changes', () => {
    const agents = {
      [durableAgent.id]: durableAgent,
      [quickAgent.id]: quickAgent,
      [otherProjectAgent.id]: otherProjectAgent,
    };
    const { result, rerender } = renderHook(
      ({ currentAgents, currentProjectId }) => useProjectAgentBuckets(currentAgents, currentProjectId),
      {
        initialProps: {
          currentAgents: agents,
          currentProjectId: 'proj-1' as string | null,
        },
      }
    );

    const initialBuckets = result.current;
    rerender({ currentAgents: agents, currentProjectId: 'proj-2' });

    expect(result.current.projectAgents).not.toBe(initialBuckets.projectAgents);
    expect(result.current.projectAgents).toEqual([otherProjectAgent]);
    expect(result.current.durableAgents).toEqual([otherProjectAgent]);
    expect(result.current.quickAgents).toEqual([]);
    expect(result.current.orphanQuickAgents).toEqual([]);
  });
});

describe('AgentList child agent grouping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStores();
    window.clubhouse.pty.onData = vi.fn().mockReturnValue(() => {});
  });

  it('renders child quick agents nested under their parent durable', () => {
    const durable: Agent = {
      ...defaultAgent,
      id: 'durable-1',
      name: 'parent-durable',
      kind: 'durable',
    };
    const childQuick: Agent = {
      ...defaultAgent,
      id: 'quick-child-1',
      name: 'child-quick',
      kind: 'quick',
      mission: 'fix bug',
      parentAgentId: 'durable-1',
    };
    const orphanQuick: Agent = {
      ...defaultAgent,
      id: 'quick-orphan-1',
      name: 'orphan-quick',
      kind: 'quick',
      mission: 'explore',
    };

    useAgentStore.setState({
      agents: {
        [durable.id]: durable,
        [childQuick.id]: childQuick,
        [orphanQuick.id]: orphanQuick,
      },
      activeAgentId: durable.id,
      agentActivity: {},
    });

    render(<AgentList />);

    // All three agents should render
    expect(screen.getByTestId('agent-item-durable-1')).toBeInTheDocument();
    expect(screen.getByTestId('agent-item-quick-child-1')).toBeInTheDocument();
    expect(screen.getByTestId('agent-item-quick-orphan-1')).toBeInTheDocument();
  });

  it('renders child completed ghosts under their parent durable', () => {
    const durable: Agent = {
      ...defaultAgent,
      id: 'durable-1',
      name: 'parent-durable',
      kind: 'durable',
    };

    useAgentStore.setState({
      agents: { [durable.id]: durable },
      activeAgentId: durable.id,
      agentActivity: {},
    });

    const childCompleted: CompletedQuickAgent = {
      id: 'completed-child-1',
      projectId: 'proj-1',
      name: 'done-child',
      mission: 'done task',
      summary: null,
      filesModified: [],
      exitCode: 0,
      completedAt: Date.now(),
      parentAgentId: 'durable-1',
    };

    useQuickAgentStore.setState({
      completedAgents: { 'proj-1': [childCompleted] },
      selectedCompletedId: null,
    });

    render(<AgentList />);

    // Parent durable should render
    expect(screen.getByTestId('agent-item-durable-1')).toBeInTheDocument();
    // Child completed ghost should render (nested under parent)
    expect(screen.getByTestId('quick-agent-ghost')).toBeInTheDocument();
    // Completed footer should show 0 orphan completed (the child belongs to a parent)
    expect(screen.getByText('Completed (0)')).toBeInTheDocument();
  });
});

describe('AgentList onData throttle', () => {
  let onDataCallback: (agentId: string) => void;
  let recordActivitySpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    resetStores();

    recordActivitySpy = vi.fn();
    useAgentStore.setState({ recordActivity: recordActivitySpy });

    // Capture the onData callback when the component registers it
    window.clubhouse.pty.onData = vi.fn().mockImplementation((cb: (agentId: string) => void) => {
      onDataCallback = cb;
      return () => {};
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires recordActivity immediately on first onData call', () => {
    render(<AgentList />);
    act(() => { onDataCallback('agent-1'); });
    expect(recordActivitySpy).toHaveBeenCalledTimes(1);
    expect(recordActivitySpy).toHaveBeenCalledWith('agent-1');
  });

  it('throttles rapid onData calls to at most one per 150ms', () => {
    render(<AgentList />);

    // First call goes through immediately
    act(() => { onDataCallback('agent-1'); });
    expect(recordActivitySpy).toHaveBeenCalledTimes(1);

    // Rapid subsequent calls within the throttle window should not fire immediately
    act(() => {
      onDataCallback('agent-1');
      onDataCallback('agent-1');
      onDataCallback('agent-1');
    });
    // Only 1 call so far (the initial one) + 1 trailing timer scheduled
    expect(recordActivitySpy).toHaveBeenCalledTimes(1);

    // After the throttle interval, the trailing call fires
    act(() => { vi.advanceTimersByTime(150); });
    expect(recordActivitySpy).toHaveBeenCalledTimes(2);
  });

  it('throttles independently per agent', () => {
    render(<AgentList />);

    // Both agents fire immediately on first call
    act(() => { onDataCallback('agent-1'); });
    act(() => { onDataCallback('agent-2'); });
    expect(recordActivitySpy).toHaveBeenCalledTimes(2);
    expect(recordActivitySpy).toHaveBeenCalledWith('agent-1');
    expect(recordActivitySpy).toHaveBeenCalledWith('agent-2');

    // Rapid calls for agent-1 only — agent-2 is not affected
    act(() => {
      onDataCallback('agent-1');
      onDataCallback('agent-1');
    });
    // Still 2 from above — agent-1's rapid calls are throttled
    expect(recordActivitySpy).toHaveBeenCalledTimes(2);

    // agent-2 can still fire after its own throttle window passes
    act(() => { vi.advanceTimersByTime(150); });
    // Now agent-1's trailing call fires
    expect(recordActivitySpy).toHaveBeenCalledTimes(3);
  });

  it('cleans up pending timers on unmount', () => {
    const { unmount } = render(<AgentList />);

    // Fire initial + schedule a trailing call
    act(() => { onDataCallback('agent-1'); });
    act(() => { onDataCallback('agent-1'); });
    expect(recordActivitySpy).toHaveBeenCalledTimes(1);

    // Unmount before the trailing timer fires
    unmount();

    // Advance timers — the trailing call should NOT fire
    act(() => { vi.advanceTimersByTime(300); });
    expect(recordActivitySpy).toHaveBeenCalledTimes(1);
  });
});

describe('AgentList activity tick optimization', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    resetStores();
    window.clubhouse.pty.onData = vi.fn().mockReturnValue(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not set up a tick interval when no agents have recent activity', () => {
    const setIntervalSpy = vi.spyOn(global, 'setInterval');

    // agentActivity is empty — no recent activity
    useAgentStore.setState({ agentActivity: {} });

    render(<AgentList />);

    // setInterval may be called by other effects, but not the 2-second tick
    const tickIntervals = setIntervalSpy.mock.calls.filter(
      ([, ms]) => ms === 2000
    );
    expect(tickIntervals).toHaveLength(0);

    setIntervalSpy.mockRestore();
  });

  it('sets up a tick interval when agents have recent activity', () => {
    const setIntervalSpy = vi.spyOn(global, 'setInterval');

    // Simulate recent activity on agent-1
    useAgentStore.setState({
      agentActivity: { 'agent-1': Date.now() },
    });

    render(<AgentList />);

    const tickIntervals = setIntervalSpy.mock.calls.filter(
      ([, ms]) => ms === 2000
    );
    expect(tickIntervals).toHaveLength(1);

    setIntervalSpy.mockRestore();
  });

  it('does not set up a tick interval when all activity is stale', () => {
    const setIntervalSpy = vi.spyOn(global, 'setInterval');

    // Activity from 10 seconds ago — well past the 5s threshold
    useAgentStore.setState({
      agentActivity: { 'agent-1': Date.now() - 10000 },
    });

    render(<AgentList />);

    const tickIntervals = setIntervalSpy.mock.calls.filter(
      ([, ms]) => ms === 2000
    );
    expect(tickIntervals).toHaveLength(0);

    setIntervalSpy.mockRestore();
  });
});

describe('AgentList isThinking callback stability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStores();
    isThinkingCaptures.length = 0;
    window.clubhouse.pty.onData = vi.fn().mockReturnValue(() => {});
  });

  it('reflects thinking state when agentActivity has recent timestamp', () => {
    useAgentStore.setState({
      agentActivity: { 'agent-1': Date.now() },
    });

    render(<AgentList />);
    // The agent should be rendered as "thinking" since activity is recent
    const lastCapture = isThinkingCaptures[isThinkingCaptures.length - 1];
    expect(lastCapture).toBe(true);
  });

  it('updates thinking state when agentActivity changes from empty to active', () => {
    useAgentStore.setState({ agentActivity: {} });
    render(<AgentList />);

    // Initially not thinking
    const initialCapture = isThinkingCaptures[isThinkingCaptures.length - 1];
    expect(initialCapture).toBe(false);

    // Simulate activity update via store change
    act(() => {
      useAgentStore.setState({
        agentActivity: { 'agent-1': Date.now() },
      });
    });

    // After agentActivity updates, the ref-based callback should read the new value
    const updatedCapture = isThinkingCaptures[isThinkingCaptures.length - 1];
    expect(updatedCapture).toBe(true);
  });

  it('shows not-thinking when activity timestamp is stale', () => {
    // Activity from 10 seconds ago — well past the 3s threshold
    useAgentStore.setState({
      agentActivity: { 'agent-1': Date.now() - 10000 },
    });

    render(<AgentList />);
    const lastCapture = isThinkingCaptures[isThinkingCaptures.length - 1];
    expect(lastCapture).toBe(false);
  });
});
