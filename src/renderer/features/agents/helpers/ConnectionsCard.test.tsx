import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Agent, DispatcherLink } from '../../../../shared/types';
import { useAgentStore } from '../../../stores/agentStore';
import { useMcpBindingStore, type McpBindingEntry } from '../../../stores/mcpBindingStore';
import { ConnectionsCard, agentConnections, connectionMeta } from './ConnectionsCard';
import type { ConnectionSourceKind } from '../../../../shared/connection-sources';

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

  it('offers Sources for agent rows, and removes one source at a time, saying what keeps them connected (#2744)', async () => {
    const pair = (agentId: string, targetId: string, kinds: ConnectionSourceKind[]) => ({ agentId, targetId, bound: true, sources: kinds.map((kind) => ({ kind, sourceId: kind })) });
    let reviewerSources: ConnectionSourceKind[] = ['tool_link', 'canvas'];
    window.clubhouse.mcpBinding.getConnectionSources = vi.fn(async () => ({
      pairs: [pair('lead', 'h1', ['helper']), pair('h1', 'lead', ['helper']), pair('lead', 'rev', reviewerSources), pair('docs', 'lead', ['canvas'])],
      unreadable: [],
    }));
    const removeConnectionSource = vi.fn(async () => {
      reviewerSources = ['canvas'];
      return { ok: true as const, remaining: [{ kind: 'canvas' as const, sourceId: 'canvas-wires' }], stillConnected: true };
    });
    window.clubhouse.mcpBinding.removeConnectionSource = removeConnectionSource;
    render(<ConnectionsCard agent={lead} helperIds={new Set(['h1'])} open onToggle={() => {}} onDisconnect={vi.fn()} />);
    await waitFor(() => expect(screen.getAllByTestId('connection-sources')).toHaveLength(3));
    const rows = screen.getAllByTestId('connection-row');
    expect(within(rows[0]).getByTestId('connection-meta').getAttribute('title')).toBe('From: Helper');
    expect(within(rows[4]).getByTestId('connection-meta').getAttribute('title')).toBe('From: Made by an orchestrator, Canvas wire');

    fireEvent.click(within(rows[4]).getByTestId('connection-sources'));
    const dialog = screen.getByTestId('connection-sources-dialog');
    // A canvas wire is removed on its canvas: no button here.
    expect(within(dialog).getByTestId('connection-source-canvas')).toHaveTextContent('Remove it on its canvas');
    expect(within(dialog).queryByTestId('connection-source-remove-canvas')).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByTestId('connection-source-remove-tool_link'));
    await waitFor(() => expect(removeConnectionSource).toHaveBeenCalledWith('lead', 'rev', 'tool_link'));
    expect(await within(dialog).findByTestId('connection-source-result')).toHaveTextContent('Still connected through: Canvas wire.');
  });

  it('turns off Connect to Dispatcher once for both directions, after confirming, and warns when a removal couldn\'t be saved', async () => {
    const src = { kind: 'dispatcher_auto' as const, sourceId: 'dispatcher-wires' };
    useMcpBindingStore.setState({ bindings: [wire('lead', 'rev', ['epic-lead', 'reviewer']), wire('rev', 'lead', ['reviewer', 'epic-lead'])] });
    window.clubhouse.mcpBinding.getConnectionSources = vi.fn(async () => ({
      pairs: [{ agentId: 'lead', targetId: 'rev', bound: true, sources: [src] }, { agentId: 'rev', targetId: 'lead', bound: true, sources: [src] }],
      unreadable: ['canvas-wires'],
    }));
    const removeConnectionSource = vi.fn(async () => ({ ok: true as const, remaining: [], stillConnected: false, notSaved: true }));
    window.clubhouse.mcpBinding.removeConnectionSource = removeConnectionSource;
    render(<ConnectionsCard agent={lead} helperIds={new Set()} open onToggle={() => {}} onDisconnect={vi.fn()} />);
    fireEvent.click(await screen.findByTestId('connection-sources'));
    expect(screen.getByTestId('connection-source-unreadable')).toHaveTextContent('Couldn\u2019t check: Canvas wire');
    fireEvent.click(screen.getByTestId('connection-source-remove-dispatcher_auto'));
    fireEvent.click(screen.getByTestId('connection-source-confirm-dispatcher_auto'));
    await waitFor(() => expect(removeConnectionSource).toHaveBeenCalledTimes(1));
    expect(await screen.findByTestId('connection-source-result')).toHaveTextContent('may come back after a restart');
  });

  it('the connection view shows both directions with their own tools, saves a change, and makes a one-way connection two-way (#2972)', async () => {
    useMcpBindingStore.setState({ bindings: [wire('lead', 'rev', ['epic-lead', 'reviewer'], 'agent', { disabledTools: ['clear_agent', 'compact_agent'] })] });
    window.clubhouse.mcpBinding.getConnectionSources = vi.fn(async () => ({
      pairs: [{ agentId: 'lead', targetId: 'rev', bound: true, sources: [{ kind: 'canvas' as const, sourceId: 'canvas-wires' }] }],
      unreadable: [],
    }));
    window.clubhouse.mcpBinding.getConnectionGrants = vi.fn(async () => [
      { from: { agentId: 'lead' }, to: { agentId: 'rev' }, disabledTools: ['clear_agent', 'compact_agent'], updatedAt: 't' },
    ]);
    const setDisabledTools = vi.fn(async () => {});
    const makeTwoWay = vi.fn(async () => {
      // After Make two-way, main lists the user's link for the other direction.
      window.clubhouse.mcpBinding.getConnectionSources = vi.fn(async () => ({
        pairs: [
          { agentId: 'lead', targetId: 'rev', bound: true, sources: [{ kind: 'canvas' as const, sourceId: 'canvas-wires' }] },
          { agentId: 'rev', targetId: 'lead', bound: true, sources: [{ kind: 'user_link' as const, sourceId: 'user-connections' }] },
        ],
        unreadable: [],
      }));
    });
    window.clubhouse.mcpBinding.setDisabledTools = setDisabledTools as never;
    window.clubhouse.mcpBinding.makeTwoWay = makeTwoWay;
    render(<ConnectionsCard agent={lead} helperIds={new Set()} open onToggle={() => {}} onDisconnect={vi.fn()} />);
    fireEvent.click(await screen.findByTestId('connection-sources'));
    const outgoing = await screen.findByTestId('connection-direction-lead-rev');
    expect(within(outgoing).getByRole('switch', { name: 'Send messages (epic-lead to reviewer)' })).toHaveAttribute('aria-checked', 'true');
    const clear = within(outgoing).getByRole('switch', { name: 'Clear its context (epic-lead to reviewer)' });
    expect(clear).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(clear);
    await waitFor(() => expect(setDisabledTools).toHaveBeenCalledWith('lead', 'rev', ['compact_agent']));
    // The other way isn't connected: Make two-way.
    const incoming = screen.getByTestId('connection-direction-rev-lead');
    expect(incoming).toHaveTextContent('Not connected this way.');
    fireEvent.click(within(incoming).getByTestId('connection-make-two-way-rev-lead'));
    await waitFor(() => expect(makeTwoWay).toHaveBeenCalledWith('rev', 'lead'));
    // The new direction shows as connected, with its switches.
    expect(await within(screen.getByTestId('connection-direction-rev-lead')).findByRole('switch', { name: 'Send messages (reviewer to epic-lead)' })).toBeInTheDocument();
  });

  it('shows Wake it with the tool switches, off until turned on, saved per direction (#3215)', async () => {
    useMcpBindingStore.setState({ bindings: [wire('lead', 'rev', ['epic-lead', 'reviewer']), wire('rev', 'lead', ['reviewer', 'epic-lead'])] });
    window.clubhouse.mcpBinding.getConnectionSources = vi.fn(async () => ({
      pairs: [
        { agentId: 'lead', targetId: 'rev', bound: true, sources: [{ kind: 'dispatcher_link' as const, sourceId: 'dispatcher-connections' }] },
        { agentId: 'rev', targetId: 'lead', bound: true, sources: [{ kind: 'dispatcher_link' as const, sourceId: 'dispatcher-connections' }] },
      ],
      unreadable: [],
    }));
    window.clubhouse.mcpBinding.getConnectionGrants = vi.fn(async () => [
      { from: { agentId: 'lead' }, to: { agentId: 'rev' }, disabledTools: ['clear_agent', 'compact_agent'], updatedAt: 't' },
      { from: { agentId: 'rev' }, to: { agentId: 'lead' }, disabledTools: ['clear_agent', 'compact_agent'], enabledTools: ['wake_agent'], updatedAt: 't' },
    ]);
    const setLocalWake = vi.fn(async () => {});
    window.clubhouse.mcpBinding.setLocalWake = setLocalWake;
    render(<ConnectionsCard agent={lead} helperIds={new Set()} open onToggle={() => {}} onDisconnect={vi.fn()} />);
    fireEvent.click(await screen.findByTestId('connection-sources'));
    const outgoing = await screen.findByTestId('connection-direction-lead-rev');
    const wake = within(outgoing).getByRole('switch', { name: 'Wake it (epic-lead to reviewer)' });
    expect(wake).toHaveAttribute('aria-checked', 'false');
    // Listed after the connection tools.
    expect(within(outgoing).getAllByRole('switch').at(-1)).toBe(wake);
    await waitFor(() => expect(within(screen.getByTestId('connection-direction-rev-lead')).getByRole('switch', { name: 'Wake it (reviewer to epic-lead)' })).toHaveAttribute('aria-checked', 'true'));
    fireEvent.click(wake);
    await waitFor(() => expect(setLocalWake).toHaveBeenCalledWith('lead', 'rev', true));
    expect(wake).toHaveAttribute('aria-checked', 'true');
  });

  it('has no Wake it switch on a wire with the Dispatcher, whose own wake doesn\'t depend on it (#3215)', async () => {
    useMcpBindingStore.setState({ bindings: [wire('lead', 'disp', ['epic-lead', 'Dispatcher'])] });
    useAgentStore.setState({ agents: { lead, disp: { id: 'disp', projectId: '__dispatcher__', name: 'Dispatcher', kind: 'durable', status: 'running', color: 'teal' } } } as never);
    window.clubhouse.mcpBinding.getConnectionSources = vi.fn(async () => ({
      pairs: [{ agentId: 'lead', targetId: 'disp', bound: true, sources: [{ kind: 'dispatcher_auto' as const, sourceId: 'dispatcher-wires' }] }],
      unreadable: [],
    }));
    window.clubhouse.mcpBinding.getConnectionGrants = vi.fn(async () => []);
    render(<ConnectionsCard agent={lead} helperIds={new Set()} open onToggle={() => {}} onDisconnect={vi.fn()} />);
    fireEvent.click(await screen.findByTestId('connection-sources'));
    const outgoing = await screen.findByTestId('connection-direction-lead-disp');
    expect(within(outgoing).getByRole('switch', { name: 'Send messages (epic-lead to Dispatcher)' })).toBeInTheDocument();
    expect(within(outgoing).queryByRole('switch', { name: /Wake it/ })).not.toBeInTheDocument();
  });

  it('has no Wake it switch on a helper\'s link with its orchestrator, where it can\'t take effect (#3215)', async () => {
    useMcpBindingStore.setState({ bindings: [wire('lead', 'h1', ['epic-lead', 'impl-ipc']), wire('h1', 'lead', ['impl-ipc', 'epic-lead'])] });
    window.clubhouse.mcpBinding.getConnectionSources = vi.fn(async () => ({
      pairs: [
        { agentId: 'lead', targetId: 'h1', bound: true, sources: [{ kind: 'helper' as const, sourceId: 'helper-wires' }] },
        { agentId: 'h1', targetId: 'lead', bound: true, sources: [{ kind: 'helper' as const, sourceId: 'helper-wires' }] },
      ],
      unreadable: [],
    }));
    window.clubhouse.mcpBinding.getConnectionGrants = vi.fn(async () => []);
    render(<ConnectionsCard agent={lead} helperIds={new Set(['h1'])} open onToggle={() => {}} onDisconnect={vi.fn()} />);
    fireEvent.click(await screen.findByTestId('connection-sources'));
    for (const id of ['connection-direction-lead-h1', 'connection-direction-h1-lead']) {
      const direction = await screen.findByTestId(id);
      expect(within(direction).getAllByRole('switch').length).toBeGreaterThan(0);
      expect(within(direction).queryByRole('switch', { name: /Wake it/ })).not.toBeInTheDocument();
    }
  });

  it('a helper link says to dispose the helper; it can\'t be removed here', async () => {
    window.clubhouse.mcpBinding.getConnectionSources = vi.fn(async () => ({
      pairs: [{ agentId: 'lead', targetId: 'h1', bound: true, sources: [{ kind: 'helper' as const, sourceId: 'helper-wires' }] }],
      unreadable: [],
    }));
    render(<ConnectionsCard agent={lead} helperIds={new Set(['h1'])} open onToggle={() => {}} onDisconnect={vi.fn()} />);
    fireEvent.click(await screen.findByTestId('connection-sources'));
    expect(screen.getByTestId('connection-source-helper')).toHaveTextContent('dispose the helper from the Helpers card');
    expect(screen.queryByTestId('connection-source-remove-helper')).not.toBeInTheDocument();
  });

  it('stays read-only for a two-way wire when only one direction is tool-made', async () => {
    useMcpBindingStore.setState({ bindings: [wire('lead', 'rev', ['epic-lead', 'reviewer']), wire('rev', 'lead', ['reviewer', 'epic-lead'])] });
    window.clubhouse.mcpBinding.getToolConnections = vi.fn(async () => [{ agentId: 'lead', targetId: 'rev' }]);
    render(<ConnectionsCard agent={lead} helperIds={new Set()} open onToggle={() => {}} onDisconnect={vi.fn()} />);
    await waitFor(() => expect(window.clubhouse.mcpBinding.getToolConnections).toHaveBeenCalled());
    expect(screen.queryByTestId('connection-disconnect')).not.toBeInTheDocument();
  });

  it('disconnects a tool-made group project wire in Agent details through the plain unbind, with no cause', async () => {
    const { AgentDetails } = await import('../details/AgentDetails');
    const { useProjectStore } = await import('../../../stores/projectStore');
    const { useAgentDetailsStore } = await import('../details/detailsStore');
    useProjectStore.setState({ projects: [{ id: 'p1', name: 'proj', path: '/work/proj' }] } as never);
    useAgentDetailsStore.setState({ open: true, focus: null });
    window.clubhouse.git.branchChanges = vi.fn(async () => ({ available: false, files: [] }));
    window.clubhouse.agent.listDurable = vi.fn(async () => [{ id: 'lead', name: 'epic-lead', color: 'teal', createdAt: '' }]) as never;
    window.clubhouse.mcpBinding.getToolConnections = vi.fn(async () => [{ agentId: 'lead', targetId: 'gp1' }]);
    const unbind = vi.fn(async () => ({ kept: false }));
    window.clubhouse.mcpBinding.unbind = unbind as never;
    render(<AgentDetails agent={lead} />);
    fireEvent.click(await screen.findByTestId('details-card-connections-toggle'));
    fireEvent.click(await screen.findByTestId('connection-disconnect'));
    fireEvent.click(screen.getByTestId('confirm-destructive-confirm'));
    await waitFor(() => expect(unbind).toHaveBeenCalledWith('lead', 'gp1'));
    expect(unbind.mock.calls[0]).toHaveLength(2);
    await waitFor(() => expect(useMcpBindingStore.getState().bindings.some((b) => b.agentId === 'lead' && b.targetId === 'gp1')).toBe(false));
    useProjectStore.setState({ projects: [] });
    // The dynamic import of AgentDetails transforms its whole card tree on a
    // cold run, which can take longer than the default 5s on its own.
  }, 60_000);

  describe('links the Dispatcher made (#2661)', () => {
    const link = (agentId: string, targetId: string, extra: Partial<DispatcherLink> = {}): DispatcherLink => ({
      agentId, targetId, agentName: agentId, targetName: targetId, status: 'active', ...extra,
    });

    it('marks an active link as the Dispatcher\'s, and its source removal says the Dispatcher can\'t redraw it', async () => {
      useMcpBindingStore.setState({ bindings: [wire('lead', 'rev', ['epic-lead', 'reviewer']), wire('rev', 'lead', ['reviewer', 'epic-lead'])] });
      window.clubhouse.mcpBinding.getDispatcherLinks = vi.fn(async () => [link('lead', 'rev'), link('rev', 'lead')]);
      const linkSource = { kind: 'dispatcher_link' as const, sourceId: 'dispatcher-connections' };
      window.clubhouse.mcpBinding.getConnectionSources = vi.fn(async () => ({
        pairs: [{ agentId: 'lead', targetId: 'rev', bound: true, sources: [linkSource] }, { agentId: 'rev', targetId: 'lead', bound: true, sources: [linkSource] }],
        unreadable: [],
      }));
      const removeConnectionSource = vi.fn(async () => ({ ok: true as const, remaining: [], stillConnected: false }));
      window.clubhouse.mcpBinding.removeConnectionSource = removeConnectionSource;
      render(<ConnectionsCard agent={lead} helperIds={new Set()} open onToggle={() => {}} onDisconnect={vi.fn()} />);
      fireEvent.click(await screen.findByTestId('connection-sources'));
      expect(screen.getByTestId('connection-meta')).toHaveTextContent('Dispatcher, two-way');
      expect(screen.getByTestId('connection-source-dispatcher_link')).toHaveTextContent('can\'t connect them again unless you draw the wire yourself');
      fireEvent.click(screen.getByTestId('connection-source-remove-dispatcher_link'));
      // It can't be drawn back by the Dispatcher, so it's confirmed first.
      expect(removeConnectionSource).not.toHaveBeenCalled();
      fireEvent.click(screen.getByTestId('connection-source-confirm-dispatcher_link'));
      await waitFor(() => expect(removeConnectionSource).toHaveBeenCalledTimes(2));
      expect(removeConnectionSource).toHaveBeenCalledWith('rev', 'lead', 'dispatcher_link');
      expect(await screen.findByTestId('connection-source-result')).toHaveTextContent('They aren\u2019t connected now.');
    });

    it('shows a suspended link with no binding, says why, and re-reads after removing it', async () => {
      useMcpBindingStore.setState({ bindings: [] });
      const getDispatcherLinks = vi.fn(async () => [link('lead', 'rev', { targetName: 'reviewer', status: 'suspended', reason: 'orchestration_off' })] as DispatcherLink[]);
      window.clubhouse.mcpBinding.getDispatcherLinks = getDispatcherLinks;
      window.clubhouse.mcpBinding.getConnectionSources = vi.fn(async () => ({
        pairs: [{ agentId: 'lead', targetId: 'rev', bound: false, sources: [{ kind: 'dispatcher_link' as const, sourceId: 'dispatcher-connections', suspended: 'Orchestration is off for one of these agents.' }] }],
        unreadable: [],
      }));
      window.clubhouse.mcpBinding.removeConnectionSource = vi.fn(async () => {
        getDispatcherLinks.mockResolvedValue([]);
        return { ok: true as const, remaining: [], stillConnected: false };
      });
      render(<ConnectionsCard agent={lead} helperIds={new Set()} open onToggle={() => {}} onDisconnect={vi.fn()} />);
      const meta = await screen.findByTestId('connection-meta');
      expect(meta).toHaveTextContent('Dispatcher, sends to it, suspended');
      expect(screen.getByText('reviewer')).toBeInTheDocument();
      fireEvent.click(await screen.findByTestId('connection-sources'));
      expect(screen.getByTestId('connection-source-dispatcher_link')).toHaveTextContent('Not connected now: Orchestration is off');
      fireEvent.click(screen.getByTestId('connection-source-remove-dispatcher_link'));
      fireEvent.click(screen.getByTestId('connection-source-confirm-dispatcher_link'));
      await waitFor(() => expect(screen.queryByTestId('connection-meta')).not.toBeInTheDocument());
    });

    it('leaves a wire main doesn\'t list as the Dispatcher\'s unmarked and read-only', async () => {
      useMcpBindingStore.setState({ bindings: [wire('lead', 'rev', ['epic-lead', 'reviewer'])] });
      window.clubhouse.mcpBinding.getToolConnections = vi.fn(async () => []);
      const getDispatcherLinks = vi.fn(async (): Promise<DispatcherLink[]> => []);
      window.clubhouse.mcpBinding.getDispatcherLinks = getDispatcherLinks;
      render(<ConnectionsCard agent={lead} helperIds={new Set()} open onToggle={() => {}} onDisconnect={vi.fn()} />);
      await waitFor(() => expect(getDispatcherLinks).toHaveBeenCalled());
      expect(screen.getByTestId('connection-meta')).toHaveTextContent('sends to it');
      expect(screen.getByTestId('connection-meta')).not.toHaveTextContent('Dispatcher');
      expect(screen.queryByTestId('connection-disconnect')).not.toBeInTheDocument();
    });
  });

  it('gives every name the same fixed column, so the meta lines up whether or not a name is cut (#3184)', () => {
    useMcpBindingStore.setState({ bindings: [
      wire('lead', 'x', ['epic-lead', 'ab']), wire('x', 'lead', ['ab', 'epic-lead']),
      wire('lead', 'y', ['epic-lead', 'a-very-long-agent-name-that-truncates']), wire('y', 'lead', ['a-very-long-agent-name-that-truncates', 'epic-lead']),
    ] });
    render(<ConnectionsCard agent={lead} helperIds={new Set()} open onToggle={() => {}} onDisconnect={vi.fn()} />);
    const names = screen.getAllByTestId('connection-name');
    expect(names).toHaveLength(2);
    for (const name of names) {
      expect(name).toHaveClass('w-[96px]', 'flex-shrink-0', 'truncate');
      expect(name).toHaveAttribute('title', name.textContent);
    }
    for (const row of screen.getAllByTestId('connection-row')) {
      expect(within(row).getByTestId('connection-meta')).toHaveTextContent('two-way');
      expect(within(row).getByTestId('connection-meta')).toHaveClass('truncate');
      expect(within(row).getByTestId('connection-meta').nextElementSibling).toHaveClass('ml-auto', 'flex-shrink-0');
    }
  });

  it('says where wires come from when there are none', () => {
    useMcpBindingStore.setState({ bindings: [] });
    render(<ConnectionsCard agent={lead} helperIds={new Set()} open onToggle={() => {}} />);
    expect(screen.getByTestId('details-card-connections-summary')).toHaveTextContent('none');
    expect(screen.getByTestId('details-card-connections')).toHaveTextContent('No Clubhouse MCP wires.');
  });
});
