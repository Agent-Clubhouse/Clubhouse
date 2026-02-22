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

const mockAgents: Record<string, any> = {};

vi.mock('../../stores/agentStore', () => ({
  useAgentStore: (selector: (s: any) => any) => selector({
    agents: mockAgents,
    agentDetailedStatus: {},
    killAgent: vi.fn(),
    spawnDurableAgent: vi.fn(),
  }),
}));

vi.mock('../../stores/projectStore', () => ({
  useProjectStore: (selector: (s: any) => any) => selector({
    projects: [{ id: 'proj-1', name: 'Test', path: '/test' }],
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
}));

describe('PopoutHubView', () => {
  beforeEach(() => {
    for (const key of Object.keys(mockAgents)) delete mockAgents[key];

    window.clubhouse.pty.onExit = vi.fn().mockReturnValue(noop);
    window.clubhouse.agent.onHookEvent = vi.fn().mockReturnValue(noop);
    window.clubhouse.agent.killAgent = vi.fn().mockResolvedValue(undefined);
    window.clubhouse.window.focusMain = vi.fn().mockResolvedValue(undefined);
    window.clubhouse.window.createPopout = vi.fn().mockResolvedValue(1);
    window.clubhouse.agent.listDurable = vi.fn().mockResolvedValue([]);
  });

  it('shows error when no hubId', async () => {
    render(<PopoutHubView />);
    // Wait for async loadHubData
    expect(await screen.findByText('No hub ID specified')).toBeInTheDocument();
  });

  it('shows error when hub not found', async () => {
    window.clubhouse.plugin = {
      ...window.clubhouse.plugin,
      storageRead: vi.fn().mockResolvedValue([]),
    };
    window.clubhouse.project = {
      ...window.clubhouse.project,
      list: vi.fn().mockResolvedValue([{ id: 'proj-1', name: 'Test', path: '/test' }]),
    };

    render(<PopoutHubView hubId="nonexistent" projectId="proj-1" />);
    expect(await screen.findByText('Hub "nonexistent" not found')).toBeInTheDocument();
  });

  it('renders pane tree with running agent terminal', async () => {
    mockAgents['agent-1'] = {
      id: 'agent-1', name: 'running-agent', status: 'running',
      kind: 'durable', projectId: 'proj-1', color: 'red',
    };

    const paneTree = {
      type: 'leaf' as const,
      id: 'pane-1',
      agentId: 'agent-1',
      projectId: 'proj-1',
    };

    window.clubhouse.plugin = {
      ...window.clubhouse.plugin,
      storageRead: vi.fn().mockResolvedValue([{ id: 'hub-1', paneTree }]),
    };
    window.clubhouse.project = {
      ...window.clubhouse.project,
      list: vi.fn().mockResolvedValue([{ id: 'proj-1', name: 'Test', path: '/test' }]),
    };

    render(<PopoutHubView hubId="hub-1" projectId="proj-1" />);
    expect(await screen.findByTestId('agent-terminal-agent-1')).toBeInTheDocument();
  });

  it('renders SleepingAgent for sleeping agent in pane', async () => {
    mockAgents['agent-1'] = {
      id: 'agent-1', name: 'sleepy-agent', status: 'sleeping',
      kind: 'durable', projectId: 'proj-1', color: 'blue',
    };

    const paneTree = {
      type: 'leaf' as const,
      id: 'pane-1',
      agentId: 'agent-1',
      projectId: 'proj-1',
    };

    window.clubhouse.plugin = {
      ...window.clubhouse.plugin,
      storageRead: vi.fn().mockResolvedValue([{ id: 'hub-1', paneTree }]),
    };
    window.clubhouse.project = {
      ...window.clubhouse.project,
      list: vi.fn().mockResolvedValue([{ id: 'proj-1', name: 'Test', path: '/test' }]),
    };

    render(<PopoutHubView hubId="hub-1" projectId="proj-1" />);
    expect(await screen.findByTestId('sleeping-agent-agent-1')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-terminal-agent-1')).not.toBeInTheDocument();
  });

  it('renders agent name in floating chip', async () => {
    mockAgents['agent-1'] = {
      id: 'agent-1', name: 'my-agent', status: 'running',
      kind: 'durable', projectId: 'proj-1', color: 'red',
    };

    const paneTree = {
      type: 'leaf' as const,
      id: 'pane-1',
      agentId: 'agent-1',
      projectId: 'proj-1',
    };

    window.clubhouse.plugin = {
      ...window.clubhouse.plugin,
      storageRead: vi.fn().mockResolvedValue([{ id: 'hub-1', paneTree }]),
    };
    window.clubhouse.project = {
      ...window.clubhouse.project,
      list: vi.fn().mockResolvedValue([{ id: 'proj-1', name: 'Test', path: '/test' }]),
    };

    render(<PopoutHubView hubId="hub-1" projectId="proj-1" />);
    expect(await screen.findByText('my-agent')).toBeInTheDocument();
  });
});
