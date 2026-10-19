import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Agent } from '../../../../shared/types';
import { useAgentStore } from '../../../stores/agentStore';
import { useMcpBindingStore, type McpBindingEntry } from '../../../stores/mcpBindingStore';
import { ConnectionsCard, agentConnections, connectionMeta } from './ConnectionsCard';

const lead: Agent = { id: 'lead', projectId: 'p1', name: 'epic-lead', kind: 'durable', status: 'running', color: 'teal' };

const wire = (agentId: string, targetId: string, names: [string, string], kind: McpBindingEntry['targetKind'] = 'agent', extra: Partial<McpBindingEntry> = {}): McpBindingEntry => ({
  agentId, targetId, targetKind: kind, label: names[1], agentName: names[0], targetName: names[1], ...extra,
});

const bindings: McpBindingEntry[] = [
  // Helper wires, both ways (#2225).
  wire('lead', 'h1', ['epic-lead', 'impl-ipc']),
  wire('h1', 'lead', ['impl-ipc', 'epic-lead']),
  // A canvas wire one way out, and one in.
  wire('lead', 'rev', ['epic-lead', 'reviewer']),
  wire('docs', 'lead', ['docs-bot', 'epic-lead']),
  // A group project and a browser.
  wire('lead', 'gp1', ['epic-lead', 'settings-epic'], 'group-project', { projectName: 'settings-epic' }),
  wire('lead', 'br1', ['epic-lead', 'Browser'], 'browser'),
  // Not this agent's.
  wire('h1', 'rev', ['impl-ipc', 'reviewer']),
];

describe('agentConnections', () => {
  it('folds both directions into one two-way row and puts family first', () => {
    const rows = agentConnections(bindings, 'lead', { helperIds: new Set(['h1']) });
    expect(rows.map((r) => [r.name, connectionMeta(r)])).toEqual([
      ['impl-ipc', 'helper, two-way'],
      ['settings-epic', 'group project'],
      ['Browser', 'browser'],
      ['docs-bot', 'sends to this agent'],
      ['reviewer', 'sends to it'],
    ]);
  });

  it('names the orchestrator on a helper', () => {
    const rows = agentConnections(bindings, 'h1', { helperIds: new Set(), parentId: 'lead' });
    expect(rows.map((r) => [r.name, connectionMeta(r)])).toEqual([
      ['epic-lead', 'orchestrator, two-way'],
      ['reviewer', 'sends to it'],
    ]);
  });
});

describe('Connections card (#2232)', () => {
  beforeEach(() => {
    useMcpBindingStore.setState({ bindings });
    useAgentStore.setState({
      agents: { lead, h1: { id: 'h1', projectId: 'p1', name: 'impl-ipc', kind: 'durable', status: 'running', color: 'teal' } },
      activeAgentId: 'lead',
    } as never);
  });
  afterEach(() => {
    useMcpBindingStore.setState({ bindings: [] });
    useAgentStore.setState({ agents: {} } as never);
  });

  it('lists the wires like the Canvases card, read-only without the connection tools', () => {
    render(<ConnectionsCard agent={lead} helperIds={new Set(['h1'])} open onToggle={() => {}} />);
    expect(screen.getByTestId('details-card-connections-summary')).toHaveTextContent('5');
    const rows = screen.getAllByTestId('connection-row');
    expect(rows).toHaveLength(5);
    expect(rows[0]).toHaveTextContent('impl-ipc');
    expect(rows[0]).toHaveTextContent('helper, two-way');
    expect(screen.queryByTestId('connection-disconnect')).not.toBeInTheDocument();
    // Only agents in the rail can be opened.
    expect(within(rows[0]).getByTestId('connection-open')).toBeInTheDocument();
    expect(within(rows[4]).queryByTestId('connection-open')).not.toBeInTheDocument();
    fireEvent.click(within(rows[0]).getByTestId('connection-open'));
    expect(useAgentStore.getState().activeAgentId).toBe('h1');
  });

  it('offers Disconnect only for wires the connection tools alone made, and confirms first (#2253)', async () => {
    // reviewer (one way) and docs-bot (one way in) are tool-made; the helper wire and the browser aren't.
    window.clubhouse.mcpBinding.getToolConnections = vi.fn(async () => [
      { agentId: 'lead', targetId: 'rev' },
      { agentId: 'docs', targetId: 'lead' },
      // A tool also claimed one direction of the helper wire: it stays read-only.
      { agentId: 'lead', targetId: 'h1' },
    ]);
    const onDisconnect = vi.fn();
    render(<ConnectionsCard agent={lead} helperIds={new Set(['h1'])} open onToggle={() => {}} onDisconnect={onDisconnect} />);
    await waitFor(() => expect(screen.getAllByTestId('connection-disconnect')).toHaveLength(2));
    const rows = screen.getAllByTestId('connection-row');
    expect(within(rows[0]).queryByTestId('connection-disconnect')).not.toBeInTheDocument(); // impl-ipc, helper
    expect(within(rows[1]).queryByTestId('connection-disconnect')).not.toBeInTheDocument(); // group project
    expect(within(rows[2]).queryByTestId('connection-disconnect')).not.toBeInTheDocument(); // browser

    fireEvent.click(within(rows[4]).getByTestId('connection-disconnect'));
    expect(screen.getByText('Disconnect reviewer?')).toBeInTheDocument();
    expect(onDisconnect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('confirm-destructive-confirm'));
    expect(onDisconnect).toHaveBeenCalledWith(expect.objectContaining({ id: 'rev', toolMade: true, pairs: [{ agentId: 'lead', targetId: 'rev' }] }));
  });

  it('stays read-only for a two-way wire when only one direction is tool-made', async () => {
    useMcpBindingStore.setState({ bindings: [wire('lead', 'rev', ['epic-lead', 'reviewer']), wire('rev', 'lead', ['reviewer', 'epic-lead'])] });
    window.clubhouse.mcpBinding.getToolConnections = vi.fn(async () => [{ agentId: 'lead', targetId: 'rev' }]);
    render(<ConnectionsCard agent={lead} helperIds={new Set()} open onToggle={() => {}} onDisconnect={vi.fn()} />);
    await waitFor(() => expect(window.clubhouse.mcpBinding.getToolConnections).toHaveBeenCalled());
    expect(screen.queryByTestId('connection-disconnect')).not.toBeInTheDocument();
  });

  it('disconnects in Agent details through the plain unbind, with no cause', async () => {
    const { AgentDetails } = await import('../details/AgentDetails');
    const { useProjectStore } = await import('../../../stores/projectStore');
    const { useAgentDetailsStore } = await import('../details/detailsStore');
    useProjectStore.setState({ projects: [{ id: 'p1', name: 'proj', path: '/work/proj' }] } as never);
    useAgentDetailsStore.setState({ open: true, focus: null });
    window.clubhouse.git.branchChanges = vi.fn(async () => ({ available: false, files: [] }));
    window.clubhouse.agent.listDurable = vi.fn(async () => [{ id: 'lead', name: 'epic-lead', color: 'teal', createdAt: '' }]) as never;
    window.clubhouse.mcpBinding.getToolConnections = vi.fn(async () => [{ agentId: 'lead', targetId: 'rev' }]);
    const unbind = vi.fn(async () => ({ kept: false }));
    window.clubhouse.mcpBinding.unbind = unbind as never;
    render(<AgentDetails agent={lead} />);
    fireEvent.click(await screen.findByTestId('details-card-connections-toggle'));
    fireEvent.click(await screen.findByTestId('connection-disconnect'));
    fireEvent.click(screen.getByTestId('confirm-destructive-confirm'));
    await waitFor(() => expect(unbind).toHaveBeenCalledWith('lead', 'rev'));
    expect(unbind.mock.calls[0]).toHaveLength(2);
    await waitFor(() => expect(useMcpBindingStore.getState().bindings.some((b) => b.agentId === 'lead' && b.targetId === 'rev')).toBe(false));
    useProjectStore.setState({ projects: [] });
  });

  it('says where wires come from when there are none', () => {
    useMcpBindingStore.setState({ bindings: [] });
    render(<ConnectionsCard agent={lead} helperIds={new Set()} open onToggle={() => {}} />);
    expect(screen.getByTestId('details-card-connections-summary')).toHaveTextContent('none');
    expect(screen.getByTestId('details-card-connections')).toHaveTextContent('No Clubhouse MCP wires.');
  });
});
