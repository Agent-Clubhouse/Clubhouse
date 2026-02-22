import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PopoutHubView } from './PopoutHubView';

const noop = () => {};

vi.mock('../agents/AgentTerminal', () => ({
  AgentTerminal: ({ agentId }: { agentId: string }) => (
    <div data-testid={`agent-terminal-${agentId}`} />
  ),
}));

vi.mock('../agents/SleepingAgent', () => ({
  SleepingAgent: ({ agent }: { agent: { id: string } }) => (
    <div data-testid={`sleeping-agent-${agent.id}`} />
  ),
}));

vi.mock('../agents/AgentAvatar', () => ({
  AgentAvatarWithRing: ({ agent }: { agent: { name: string } }) => (
    <div data-testid="agent-avatar" data-name={agent.name} />
  ),
}));

vi.mock('../agents/QuickAgentGhost', () => ({
  QuickAgentGhost: ({ completed }: { completed: { id: string } }) => (
    <div data-testid={`quick-agent-ghost-${completed.id}`} />
  ),
}));

const mockAgents: Record<string, any> = {};
let mockDetailedStatuses: Record<string, any> = {};

vi.mock('../../stores/agentStore', () => ({
  useAgentStore: (selector: (s: any) => any) => selector({
    agents: mockAgents,
    agentDetailedStatus: mockDetailedStatuses,
    killAgent: vi.fn(),
    spawnDurableAgent: vi.fn(),
    loadDurableAgents: vi.fn().mockResolvedValue(undefined),
  }),
}));

let mockCompletedAgents: Record<string, any[]> = {};

vi.mock('../../stores/quickAgentStore', () => ({
  useQuickAgentStore: (selector: (s: any) => any) => selector({
    loadCompleted: vi.fn(),
    completedAgents: mockCompletedAgents,
    dismissCompleted: vi.fn(),
  }),
}));

vi.mock('../../plugins/builtin/hub/pane-tree', () => ({
  syncCounterToTree: vi.fn(),
  collectLeaves: (tree: any) => {
    if (tree.type === 'leaf') return [tree];
    const result: any[] = [];
    if (tree.children) {
      for (const child of tree.children) {
        if (child.type === 'leaf') result.push(child);
      }
    }
    return result;
  },
  findLeaf: (tree: any, paneId: string): any => {
    if (tree.type === 'leaf') return tree.id === paneId ? tree : null;
    if (tree.children) {
      for (const child of tree.children) {
        const found = child.type === 'leaf' && child.id === paneId ? child : null;
        if (found) return found;
      }
    }
    return null;
  },
  getFirstLeafId: (tree: any) => {
    if (tree.type === 'leaf') return tree.id;
    return tree.children?.[0]?.id || '';
  },
  splitPane: vi.fn((tree: any) => tree),
  closePane: vi.fn((tree: any) => tree),
  swapPanes: vi.fn((tree: any) => tree),
  assignAgent: vi.fn((tree: any) => tree),
  setSplitRatio: vi.fn((tree: any) => tree),
  createLeaf: vi.fn(() => ({ type: 'leaf', id: 'new-pane', agentId: null })),
}));

function setupHubMocks(paneTree: any) {
  window.clubhouse.plugin = {
    ...window.clubhouse.plugin,
    storageRead: vi.fn().mockResolvedValue([{ id: 'hub-1', paneTree }]),
  };
  window.clubhouse.project = {
    ...window.clubhouse.project,
    list: vi.fn().mockResolvedValue([{ id: 'proj-1', name: 'Test', path: '/test' }]),
  };
}

describe('PopoutHubView', () => {
  beforeEach(() => {
    for (const key of Object.keys(mockAgents)) delete mockAgents[key];
    mockDetailedStatuses = {};
    mockCompletedAgents = {};

    window.clubhouse.pty.onExit = vi.fn().mockReturnValue(noop);
    window.clubhouse.agent.onHookEvent = vi.fn().mockReturnValue(noop);
    window.clubhouse.agent.killAgent = vi.fn().mockResolvedValue(undefined);
    window.clubhouse.window.focusMain = vi.fn().mockResolvedValue(undefined);
    window.clubhouse.window.createPopout = vi.fn().mockResolvedValue(1);
    window.clubhouse.agent.listDurable = vi.fn().mockResolvedValue([]);
  });

  it('shows error when no hubId', async () => {
    render(<PopoutHubView />);
    expect(await screen.findByText('No hub ID specified')).toBeInTheDocument();
  });

  it('shows error when hub not found', async () => {
    setupHubMocks(null);
    window.clubhouse.plugin.storageRead = vi.fn().mockResolvedValue([]);

    render(<PopoutHubView hubId="nonexistent" projectId="proj-1" />);
    expect(await screen.findByText('Hub "nonexistent" not found')).toBeInTheDocument();
  });

  it('renders pane tree with running agent terminal', async () => {
    mockAgents['agent-1'] = {
      id: 'agent-1', name: 'running-agent', status: 'running',
      kind: 'durable', projectId: 'proj-1', color: 'red',
    };

    setupHubMocks({ type: 'leaf', id: 'pane-1', agentId: 'agent-1', projectId: 'proj-1' });

    render(<PopoutHubView hubId="hub-1" projectId="proj-1" />);
    expect(await screen.findByTestId('agent-terminal-agent-1')).toBeInTheDocument();
  });

  it('renders SleepingAgent for sleeping agent in pane', async () => {
    mockAgents['agent-1'] = {
      id: 'agent-1', name: 'sleepy-agent', status: 'sleeping',
      kind: 'durable', projectId: 'proj-1', color: 'blue',
    };

    setupHubMocks({ type: 'leaf', id: 'pane-1', agentId: 'agent-1', projectId: 'proj-1' });

    render(<PopoutHubView hubId="hub-1" projectId="proj-1" />);
    expect(await screen.findByTestId('sleeping-agent-agent-1')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-terminal-agent-1')).not.toBeInTheDocument();
  });

  it('renders agent name in floating chip', async () => {
    mockAgents['agent-1'] = {
      id: 'agent-1', name: 'my-agent', status: 'running',
      kind: 'durable', projectId: 'proj-1', color: 'red',
    };

    setupHubMocks({ type: 'leaf', id: 'pane-1', agentId: 'agent-1', projectId: 'proj-1' });

    render(<PopoutHubView hubId="hub-1" projectId="proj-1" />);
    expect(await screen.findByText('my-agent')).toBeInTheDocument();
  });

  it('renders agent avatar in floating chip', async () => {
    mockAgents['agent-1'] = {
      id: 'agent-1', name: 'avatar-agent', status: 'running',
      kind: 'durable', projectId: 'proj-1', color: 'blue',
    };

    setupHubMocks({ type: 'leaf', id: 'pane-1', agentId: 'agent-1', projectId: 'proj-1' });

    render(<PopoutHubView hubId="hub-1" projectId="proj-1" />);
    expect(await screen.findByTestId('agent-avatar')).toBeInTheDocument();
  });

  it('renders edge split indicators on hover', async () => {
    mockAgents['agent-1'] = {
      id: 'agent-1', name: 'hover-agent', status: 'running',
      kind: 'durable', projectId: 'proj-1', color: 'red',
    };

    setupHubMocks({ type: 'leaf', id: 'pane-1', agentId: 'agent-1', projectId: 'proj-1' });

    render(<PopoutHubView hubId="hub-1" projectId="proj-1" />);
    await screen.findByTestId('agent-terminal-agent-1');

    const paneContainer = screen.getByTestId('agent-terminal-agent-1').closest('[class*="rounded-sm"]');
    expect(paneContainer).toBeTruthy();
    fireEvent.mouseEnter(paneContainer!);

    expect(screen.getByTitle('Split Up')).toBeInTheDocument();
    expect(screen.getByTitle('Split Down')).toBeInTheDocument();
    expect(screen.getByTitle('Split Left')).toBeInTheDocument();
    expect(screen.getByTitle('Split Right')).toBeInTheDocument();
  });

  it('shows agent picker for unassigned panes', async () => {
    setupHubMocks({ type: 'leaf', id: 'pane-1', agentId: null });

    render(<PopoutHubView hubId="hub-1" projectId="proj-1" />);
    // Agent picker should render with "Assign an agent" text
    expect(await screen.findByText('Assign an agent')).toBeInTheDocument();
  });

  // ── Parity feature tests ──────────────────────────────────────────

  it('shows zoom button on hover', async () => {
    mockAgents['agent-1'] = {
      id: 'agent-1', name: 'zoom-agent', status: 'running',
      kind: 'durable', projectId: 'proj-1', color: 'red',
    };

    setupHubMocks({ type: 'leaf', id: 'pane-1', agentId: 'agent-1', projectId: 'proj-1' });

    render(<PopoutHubView hubId="hub-1" projectId="proj-1" />);
    await screen.findByTestId('agent-terminal-agent-1');

    // Hover to expand the chip
    const paneContainer = screen.getByTestId('agent-terminal-agent-1').closest('[class*="rounded-sm"]');
    fireEvent.mouseEnter(paneContainer!);

    expect(screen.getByTestId('zoom-button')).toBeInTheDocument();
    expect(screen.getByTitle('Zoom pane')).toBeInTheDocument();
  });

  it('shows agent picker with available agents in empty pane', async () => {
    mockAgents['agent-1'] = {
      id: 'agent-1', name: 'durable-agent', status: 'sleeping',
      kind: 'durable', projectId: 'proj-1', color: 'blue',
    };
    mockAgents['agent-2'] = {
      id: 'agent-2', name: 'quick-runner', status: 'running',
      kind: 'quick', projectId: 'proj-1', color: 'green',
    };

    setupHubMocks({ type: 'leaf', id: 'pane-1', agentId: null });

    render(<PopoutHubView hubId="hub-1" projectId="proj-1" />);
    expect(await screen.findByText('Assign an agent')).toBeInTheDocument();
    expect(screen.getByText('Durable')).toBeInTheDocument();
    expect(screen.getByText('Quick')).toBeInTheDocument();
    expect(screen.getByText('durable-agent')).toBeInTheDocument();
    expect(screen.getByText('quick-runner')).toBeInTheDocument();
  });

  it('shows "No agents available" when no agents exist', async () => {
    setupHubMocks({ type: 'leaf', id: 'pane-1', agentId: null });

    render(<PopoutHubView hubId="hub-1" projectId="proj-1" />);
    expect(await screen.findByText('No agents available')).toBeInTheDocument();
  });
});
