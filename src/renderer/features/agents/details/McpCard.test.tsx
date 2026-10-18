import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Agent } from '../../../../shared/types';
import { MINIMAL_CHAT_CAPABILITIES } from '../../../../shared/chat';
import { createChatViewState } from '../../../stores/chatStore';
import { useAgentStore } from '../../../stores/agentStore';
import { useMcpBindingStore } from '../../../stores/mcpBindingStore';
import { useProjectStore } from '../../../stores/projectStore';
import { AgentDetails } from './AgentDetails';
import { useAgentDetailsStore } from './detailsStore';
import { mcpRows, mcpSummary } from './McpCard';

const SPAWNED = 1_000;

const agent: Agent = {
  id: 'a1', projectId: 'p1', name: 'faithful-urchin', kind: 'durable', status: 'running', color: 'teal',
  orchestrator: 'claude-code', worktreePath: '/work/proj/.clubhouse/agents/faithful-urchin', mcpIds: ['github'],
};

describe('mcpRows and mcpSummary', () => {
  it('counts what the CLI reported, connected first', () => {
    const live = [
      { name: 'linear', status: 'failed' as const },
      { name: 'clubhouse', status: 'connected' as const },
      { name: 'figma', status: 'needs_auth' as const },
      { name: 'github', status: 'connected' as const },
    ];
    const { rows, configuredOnly } = mcpRows(live, null, ['github', 'sentry']);
    expect(rows.map((r) => r.name)).toEqual(['clubhouse', 'github', 'figma', 'linear']);
    expect(configuredOnly).toEqual(['sentry']);
    expect(mcpSummary(rows, configuredOnly)).toBe('2 connected · 1 needs sign-in · 1 not connected · 1 configured');
  });

  it('adds the Clubhouse MCP from the bridge, with its tool count, when the CLI list is missing or stale', () => {
    expect(mcpRows(null, { connectedAt: 1, toolCount: 9 }, []).rows).toEqual([{ name: 'clubhouse', status: 'connected', toolCount: 9 }]);
    const { rows } = mcpRows([{ name: 'clubhouse', status: 'pending' }], { connectedAt: 1, toolCount: null }, []);
    expect(rows).toEqual([{ name: 'clubhouse', status: 'connected', toolCount: undefined }]);
  });

  it('says none when there is nothing at all', () => {
    expect(mcpSummary([], [])).toBe('none');
  });
});

describe('MCP servers card', () => {
  beforeEach(() => {
    useProjectStore.setState({ projects: [{ id: 'p1', name: 'proj', path: '/work/proj' }] as never });
    useAgentDetailsStore.setState({ open: true, focus: null });
    useAgentStore.setState({ agentSpawnedAt: { a1: SPAWNED } } as never);
    useMcpBindingStore.setState({
      bindings: [
        { agentId: 'a1', targetId: 'a2', targetKind: 'agent', label: 'Agent', targetName: 'curious-tapir' },
        { agentId: 'other', targetId: 'a3', targetKind: 'agent', label: 'Agent', targetName: 'not-mine' },
      ],
    });
    window.clubhouse.git.branchChanges = vi.fn(async () => ({ available: false, files: [] }));
    window.clubhouse.mcpBinding.getAgentConnection = vi.fn(async () => ({ connectedAt: SPAWNED + 5, toolCount: 9 }));
  });

  afterEach(() => {
    useProjectStore.setState({ projects: [] });
    useMcpBindingStore.setState({ bindings: [] });
  });

  it('lists a chat agent\'s live servers, not "none configured" (#2093)', async () => {
    const chat = {
      ...createChatViewState('a1'),
      mcpServers: [
        { name: 'clubhouse', status: 'connected' as const },
        { name: 'github', status: 'connected' as const },
        { name: 'slack', status: 'connected' as const },
        { name: 'linear', status: 'failed' as const },
      ],
    };
    render(<AgentDetails agent={{ ...agent, mcpIds: [] }} chat={chat} />);
    expect(screen.getByTestId('details-card-mcp-summary')).toHaveTextContent('3 connected · 1 not connected');
    fireEvent.click(screen.getByTestId('details-card-mcp-toggle'));
    const card = screen.getByTestId('details-card-mcp');
    expect(card).not.toHaveTextContent('none configured');
    await waitFor(() => expect(card).toHaveTextContent('Connected · 9 tools'));
    expect(screen.getAllByTestId('details-mcp-row').map((r) => r.textContent)).toEqual([
      'ClubhouseConnected · 9 tools', 'githubConnected', 'slackConnected', 'linearFailed',
    ]);
    // The Clubhouse MCP's wires, and only this agent's.
    expect(screen.getByTestId('details-mcp-wires')).toHaveTextContent('Wired to curious-tapir');
    expect(screen.getByTestId('details-mcp-wires')).not.toHaveTextContent('not-mine');
  });

  it('shows a terminal agent\'s Clubhouse MCP connection and keeps configured servers apart', async () => {
    render(<AgentDetails agent={agent} />);
    await waitFor(() => expect(screen.getByTestId('details-card-mcp-summary')).toHaveTextContent('1 connected · 1 configured'));
    fireEvent.click(screen.getByTestId('details-card-mcp-toggle'));
    expect(screen.getAllByTestId('details-mcp-row')[0]).toHaveTextContent('ClubhouseConnected · 9 tools');
    expect(screen.getByTestId('details-mcp-configured')).toHaveTextContent('githubConfigured');
    expect(window.clubhouse.mcpBinding.getAgentConnection).toHaveBeenCalledWith('a1');
  });

  it('doesn\'t count a handshake from before the agent started', async () => {
    window.clubhouse.mcpBinding.getAgentConnection = vi.fn(async () => ({ connectedAt: SPAWNED - 1, toolCount: 9 }));
    render(<AgentDetails agent={{ ...agent, mcpIds: [] }} />);
    await waitFor(() => expect(window.clubhouse.mcpBinding.getAgentConnection).toHaveBeenCalled());
    expect(screen.getByTestId('details-card-mcp-summary')).toHaveTextContent('none');
    fireEvent.click(screen.getByTestId('details-card-mcp-toggle'));
    expect(screen.getByTestId('details-card-mcp')).toHaveTextContent('isn’t connected to any MCP servers');
  });

  it('lists no connection when the Clubhouse MCP is off and its handler is missing', async () => {
    window.clubhouse.mcpBinding.getAgentConnection = vi.fn(async () => { throw new Error('No handler registered'); });
    render(<AgentDetails agent={agent} />);
    await waitFor(() => expect(window.clubhouse.mcpBinding.getAgentConnection).toHaveBeenCalled());
    expect(screen.getByTestId('details-card-mcp-summary')).toHaveTextContent('1 configured');
  });
});

describe('Context window card', () => {
  beforeEach(() => {
    useProjectStore.setState({ projects: [{ id: 'p1', name: 'proj', path: '/work/proj' }] as never });
    window.clubhouse.git.branchChanges = vi.fn(async () => ({ available: false, files: [] }));
  });

  it('is left out until the agent reports its context, then shows it (#2094)', () => {
    const chat = { ...createChatViewState('a1'), capabilities: { ...MINIMAL_CHAT_CAPABILITIES, usage: 'tokens' as const } };
    const { rerender } = render(<AgentDetails agent={agent} chat={chat} />);
    expect(screen.queryByTestId('details-card-context')).not.toBeInTheDocument();
    rerender(<AgentDetails agent={agent} chat={{ ...chat, usage: { ...chat.usage, context: { used: 62_000, size: 100_000 } } }} />);
    expect(screen.getByTestId('details-card-context-summary')).toHaveTextContent('62% of');
  });
});
