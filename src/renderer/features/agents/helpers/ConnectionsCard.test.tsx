import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Agent, DispatcherLink } from '../../../../shared/types';
import { useAgentStore } from '../../../stores/agentStore';
import { useMcpBindingStore, type McpBindingEntry } from '../../../stores/mcpBindingStore';
import { ConnectionsCard, agentConnections, connectionMeta } from './ConnectionsCard';
import type { ConnectionSourceKind } from '../../../../shared/connection-sources';
import { useProjectStore } from '../../../stores/projectStore';
import type { ConnectionGuidanceSnapshot } from '../../../../shared/connection-guidance';
import { DISPATCHER_OFF } from '../../../../shared/dispatcher-types';
import { useDispatcherStore } from '../../dispatcher/dispatcherStore';
import { ConnectionEditorDialog } from './ConnectionEditorDialog';
import fs, * as fsExports from 'fs';
import * as fspExports from 'fs/promises';
import { syncBuiltinESMExports } from 'module';
import * as os from 'os';
import * as path from 'path';

const offlineFiles = vi.hoisted(() => ({ base: '' }));
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => offlineFiles.base } }));
vi.mock('../../../../main/services/base-dir', () => ({ getBaseDirPath: () => offlineFiles.base }));
vi.mock('../../../../main/services/log-service', () => ({ appLog: vi.fn() }));
vi.mock('../../../../main/services/annex-identity', () => ({ getIdentity: () => null }));

import { bindingManager as mainBindings } from '../../../../main/services/clubhouse-mcp/binding-manager';
import * as mainSources from '../../../../main/services/persisted-bindings';
import * as mainGuidance from '../../../../main/services/connection-guidance';
import * as mainDispatcher from '../../../../main/services/dispatcher/dispatcher-service';
import * as mainAgentConfig from '../../../../main/services/agent-config';
import * as mainProjects from '../../../../main/services/project-store';
import * as mainPolicies from '../../../../main/services/orchestration-policy';
import { dispatcherWireBindingSource } from '../../../../main/services/dispatcher-wire-source';
import { canvasWireBindingSource } from '../../../../main/services/canvas-wire-source';
import { groupProjectRegistry } from '../../../../main/services/group-project-registry';
import { listConnectionSources } from '../../../../main/services/connection-sources';
import { listDispatcherLinksForUser } from '../../../../main/services/dispatcher-connections';
import { listConnectionDirectionsForInspection } from '../../../../main/services/connection-grants-store';
import { agentRegistry as mainAgents } from '../../../../main/services/agent-registry';
import { resetAllSettingsStoresForTests } from '../../../../main/services/settings-store';

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

const guidance = (agentId: string, targetId: string, changes: Partial<ConnectionGuidanceSnapshot> = {}): ConnectionGuidanceSnapshot => ({
  agentId, targetId, instructions: { '*': 'Saved routing guidance' }, hasOverride: true, sources: [], unreadable: [],
  conflictingSources: false, needsSourceConfirmation: false, readOnly: false, revision: 'r1', ...changes,
});

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
    useProjectStore.setState({ projects: [{ id: 'p1', name: 'Project', path: '/project' }] });
    window.clubhouse.canvas.resolveAgentTarget = vi.fn(async () => ({ project: { id: 'p1', name: 'Project', path: '/project' } }));
    useDispatcherStore.getState().setState(DISPATCHER_OFF);
    useMcpBindingStore.setState({ bindings });
    useAgentStore.setState({
      agents: { lead, h1: { id: 'h1', projectId: 'p1', name: 'impl-ipc', kind: 'durable', status: 'running', color: 'teal' } },
      activeAgentId: 'lead',
    } as never);
  });
  afterEach(() => {
    useDispatcherStore.getState().setState(DISPATCHER_OFF);
    useMcpBindingStore.setState({ bindings: [] });
    useAgentStore.setState({ agents: {} } as never);
  });

  it('lists the wires like the Canvases card, read-only without the connection tools', async () => {
    render(<ConnectionsCard agent={lead} helperIds={new Set(['h1'])} open onToggle={() => {}} />);
    expect(screen.getByTestId('details-card-connections-summary')).toHaveTextContent('5');
    const rows = screen.getAllByTestId('connection-row');
    expect(rows).toHaveLength(5);
    expect(rows[0]).toHaveTextContent('impl-ipc');
    expect(rows[0]).toHaveTextContent('helper, two-way');
    expect(screen.queryByTestId('connection-disconnect')).not.toBeInTheDocument();
    // Open resolves target IDs independently of whether a rail card is loaded.
    expect(within(rows[0]).getByTestId('connection-open')).toBeInTheDocument();
    expect(within(rows[4]).getByTestId('connection-open')).toBeInTheDocument();
    fireEvent.click(within(rows[0]).getByTestId('connection-open'));
    await waitFor(() => expect(useAgentStore.getState().activeAgentId).toBe('h1'));
  });

  it.each(['Dispatcher', 'Rosie'])('distinguishes controller and chat connections named %s without changing ordinary rows or directions', (name) => {
    useDispatcherStore.getState().setState({
      ...DISPATCHER_OFF, agentId: 'work', chatAgentId: 'chat',
      config: { id: 'work', name, color: 'indigo', createdAt: 'then' },
    });
    const wires = [
      wire('lead', 'work', ['epic-lead', name]),
      wire('work', 'lead', [name, 'epic-lead']),
      wire('lead', 'chat', ['epic-lead', name]),
      wire('lead', 'rev', ['epic-lead', 'reviewer']),
    ];
    useMcpBindingStore.setState({ bindings: wires });
    render(<ConnectionsCard agent={lead} helperIds={new Set()} open onToggle={() => {}} />);
    expect(screen.getAllByTestId('connection-name').map((node) => node.textContent).sort()).toEqual(['Dispatcher controller', name, 'reviewer'].sort());
    expect(screen.getAllByTestId('connection-row').find((row) => row.textContent?.includes('Dispatcher controller'))).toHaveTextContent('two-way');
    const controller = agentConnections(wires, 'lead', { helperIds: new Set() }).find((row) => row.id === 'work');
    expect(controller).toMatchObject({ id: 'work', pairs: [{ agentId: 'lead', targetId: 'work' }, { agentId: 'work', targetId: 'lead' }] });
    expect(wires[0].targetName).toBe(name);
  });

  it('uses physical controller labels in the connection editor even if a stale agent record has the chat name', async () => {
    useDispatcherStore.getState().setState({
      ...DISPATCHER_OFF, agentId: 'work', chatAgentId: 'chat',
      config: { id: 'work', name: 'Rosie', color: 'indigo', createdAt: 'then' },
    });
    useAgentStore.setState({ agents: { lead, work: { ...lead, id: 'work', name: 'Rosie' } } });
    const binding = wire('lead', 'work', ['epic-lead', 'Rosie']);
    useMcpBindingStore.setState({ bindings: [binding] });
    window.clubhouse.mcpBinding.getConnectionSources = vi.fn(async () => ({
      pairs: [{ agentId: 'lead', targetId: 'work', bound: true, sources: [{ kind: 'dispatcher_auto' as const, sourceId: 'dispatcher-wires' }] }],
      unreadable: [],
    }));
    window.clubhouse.mcpBinding.getConnectionGrants = vi.fn(async () => []);
    window.clubhouse.mcpBinding.getConnectionGuidance = vi.fn(async (from, to) => guidance(from, to));
    window.clubhouse.mcpBinding.getConnectionToolCatalog = vi.fn(async () => ({ state: 'available', tools: [] }));
    const canvas = render(<ConnectionEditorDialog binding={binding} onClose={vi.fn()} />);
    expect(await screen.findByRole('region', { name: 'epic-lead to Dispatcher controller' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Dispatcher controller to epic-lead' })).toBeInTheDocument();
    expect(window.clubhouse.mcpBinding.getConnectionSources).toHaveBeenCalledWith('lead');
    canvas.unmount();
    render(<ConnectionsCard agent={lead} helperIds={new Set()} open onToggle={vi.fn()} onDisconnect={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    expect(await screen.findByRole('region', { name: 'epic-lead to Dispatcher controller' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Dispatcher controller to epic-lead' })).toBeInTheDocument();
    expect(await screen.findByRole('textbox', { name: 'Instructions' })).toHaveValue('Saved routing guidance');
  });

  it('offers Edit for connection rows, and removes one source at a time, saying what keeps them connected (#2744)', async () => {
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
    await waitFor(() => expect(screen.getAllByTestId('connection-sources')).toHaveLength(5));
    const rows = screen.getAllByTestId('connection-row');
    expect(within(rows[0]).getByTestId('connection-meta').getAttribute('title')).toBe('From: Helper');
    expect(within(rows[4]).getByTestId('connection-meta').getAttribute('title')).toBe('From: Made by an agent, Canvas wire');

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

  it('shows a fresh connection with the Dispatcher as it starts: every tool for the Dispatcher, no clear or compact over it (#3214)', async () => {
    // As main binds it: each direction with its starting lists, nothing saved yet.
    useMcpBindingStore.setState({ bindings: [
      wire('lead', 'disp', ['epic-lead', 'Dispatcher'], 'agent', { disabledTools: ['clear_agent', 'compact_agent'], enabledTools: ['wake_agent'] }),
      wire('disp', 'lead', ['Dispatcher', 'epic-lead'], 'agent', { enabledTools: ['wake_agent'] }),
    ] });
    useAgentStore.setState({ agents: { lead, disp: { id: 'disp', projectId: '__dispatcher__', name: 'Dispatcher', kind: 'durable', status: 'running', color: 'teal' } } } as never);
    const auto = [{ kind: 'dispatcher_auto' as const, sourceId: 'dispatcher-wires' }];
    window.clubhouse.mcpBinding.getConnectionSources = vi.fn(async () => ({
      pairs: [{ agentId: 'lead', targetId: 'disp', bound: true, sources: auto }, { agentId: 'disp', targetId: 'lead', bound: true, sources: auto }],
      unreadable: [],
    }));
    window.clubhouse.mcpBinding.getConnectionGrants = vi.fn(async () => []);
    render(<ConnectionsCard agent={lead} helperIds={new Set()} open onToggle={() => {}} onDisconnect={vi.fn()} />);
    fireEvent.click(await screen.findByTestId('connection-sources'));
    for (const [id, from, to, reset] of [['connection-direction-lead-disp', 'epic-lead', 'Dispatcher', 'false'], ['connection-direction-disp-lead', 'Dispatcher', 'epic-lead', 'true']]) {
      const direction = await screen.findByTestId(id);
      expect(within(direction).getByRole('switch', { name: `Clear its context (${from} to ${to})` })).toHaveAttribute('aria-checked', reset);
      expect(within(direction).getByRole('switch', { name: `Compact its context (${from} to ${to})` })).toHaveAttribute('aria-checked', reset);
      expect(within(direction).getByRole('switch', { name: `Send messages (${from} to ${to})` })).toHaveAttribute('aria-checked', 'true');
    }
  });

  it('shows Wake it on for a connection whose source started it on, with nothing saved (2026-11-09 defaults)', async () => {
    const starting = { disabledTools: ['clear_agent', 'compact_agent'], enabledTools: ['wake_agent'] };
    useMcpBindingStore.setState({ bindings: [wire('lead', 'rev', ['epic-lead', 'reviewer'], 'agent', starting), wire('rev', 'lead', ['reviewer', 'epic-lead'])] });
    window.clubhouse.mcpBinding.getConnectionSources = vi.fn(async () => ({
      pairs: [
        { agentId: 'lead', targetId: 'rev', bound: true, sources: [{ kind: 'orchestrator' as const, sourceId: 'orchestrator-connections' }] },
        { agentId: 'rev', targetId: 'lead', bound: true, sources: [{ kind: 'canvas' as const, sourceId: 'canvas-wires' }] },
      ],
      unreadable: [],
    }));
    window.clubhouse.mcpBinding.getConnectionGrants = vi.fn(async () => []);
    render(<ConnectionsCard agent={lead} helperIds={new Set()} open onToggle={() => {}} onDisconnect={vi.fn()} />);
    fireEvent.click(await screen.findByTestId('connection-sources'));
    const outgoing = await screen.findByTestId('connection-direction-lead-rev');
    expect(within(outgoing).getByRole('switch', { name: 'Wake it (epic-lead to reviewer)' })).toHaveAttribute('aria-checked', 'true');
    expect(within(outgoing).getByRole('switch', { name: 'Clear its context (epic-lead to reviewer)' })).toHaveAttribute('aria-checked', 'false');
    // A wire with no starting switches (an older one) reads wake off.
    expect(within(screen.getByTestId('connection-direction-rev-lead')).getByRole('switch', { name: 'Wake it (reviewer to epic-lead)' })).toHaveAttribute('aria-checked', 'false');
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
    fireEvent.click(await within(screen.getAllByTestId('connection-row')[0]).findByRole('button', { name: 'Edit' }));
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
      const getDispatcherLinks = vi.fn(async () => [link('lead', 'rev', { targetName: 'reviewer', status: 'suspended', reason: 'not_connected_to_dispatcher' })] as DispatcherLink[]);
      window.clubhouse.mcpBinding.getDispatcherLinks = getDispatcherLinks;
      window.clubhouse.mcpBinding.getConnectionSources = vi.fn(async () => ({
        pairs: [{ agentId: 'lead', targetId: 'rev', bound: false, sources: [{ kind: 'dispatcher_link' as const, sourceId: 'dispatcher-connections', suspended: 'One of these agents is not connected to the Dispatcher.' }] }],
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
      expect(screen.getByTestId('connection-source-dispatcher_link')).toHaveTextContent('Not connected now: One of these agents is not connected');
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

  it.each(['browser', 'terminal', 'group-project'] as const)('offers Edit and guidance inspection for a %s row without requiring Canvas metadata', async (kind) => {
    useMcpBindingStore.setState({ bindings: [wire('lead', 'target', ['epic-lead', 'Target'], kind)] });
    window.clubhouse.mcpBinding.getConnectionSources = vi.fn(async () => ({ pairs: [], unreadable: [] }));
    window.clubhouse.mcpBinding.getConnectionGuidance = vi.fn(async (from, to) => guidance(from, to));
    window.clubhouse.mcpBinding.getConnectionToolCatalog = vi.fn(async () => ({ state: 'unavailable', reason: 'tools_not_registered', tools: [] }));
    window.clubhouse.mcpBinding.saveConnectionGuidance = vi.fn(async (from, to, request) => guidance(from, to, { instructions: request.instructions }));
    render(<ConnectionsCard agent={lead} helperIds={new Set()} open onToggle={vi.fn()} onDisconnect={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    const textarea = await screen.findByRole('textbox', { name: 'Instructions' });
    expect(textarea).toHaveValue('Saved routing guidance');
    expect(textarea).toBeEnabled();
    expect(screen.getByTestId('connection-sources-dialog')).toHaveTextContent('Connected now, but no saved source lists it.');
    expect(screen.queryByTestId('connection-directions')).toBeNull();
    fireEvent.change(textarea, { target: { value: 'Save without a running tool client' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save direction' }));
    await waitFor(() => expect(window.clubhouse.mcpBinding.saveConnectionGuidance).toHaveBeenCalledExactlyOnceWith('lead', 'target', {
      instructions: { '*': 'Save without a running tool client' }, revision: 'r1', replaceAcrossSources: false,
    }));
  });

  it.each([false, true])('lets backend ownership decide helper guidance writability: readOnly=%s', async (readOnly) => {
    useMcpBindingStore.setState({ bindings: [wire('lead', 'h1', ['epic-lead', 'impl-ipc'])] });
    window.clubhouse.mcpBinding.getConnectionSources = vi.fn(async () => ({
      pairs: [{ agentId: 'lead', targetId: 'h1', bound: true, sources: [{ kind: 'helper' as const, sourceId: 'helper-wires' }] }], unreadable: [],
    }));
    window.clubhouse.mcpBinding.getConnectionGuidance = vi.fn(async (from, to) => guidance(from, to, {
      readOnly, ...(readOnly && { readOnlyReason: 'This derived connection is managed by its source.' }),
    }));
    window.clubhouse.mcpBinding.getConnectionToolCatalog = vi.fn(async () => ({ state: 'available', tools: [] }));
    render(<ConnectionsCard agent={lead} helperIds={new Set(['h1'])} open onToggle={vi.fn()} onDisconnect={vi.fn()} />);
    const row = await screen.findByTestId('connection-row');
    expect(within(row).getByRole('button', { name: 'Open' })).toBeInTheDocument();
    fireEvent.click(await within(row).findByRole('button', { name: 'Edit' }));
    const textarea = await screen.findByRole('textbox', { name: 'Instructions' });
    if (readOnly) {
      expect(textarea).toBeDisabled();
      expect(screen.getByRole('alert')).toHaveTextContent('managed by its source');
    } else {
      expect(textarea).toBeEnabled();
    }
    expect(screen.queryByTestId('connection-source-remove-helper')).toBeNull();
  });

  it('keeps guidance inspection available when source discovery fails and exposes retry instead of hiding Edit', async () => {
    useMcpBindingStore.setState({ bindings: [wire('lead', 'target', ['epic-lead', 'Target'], 'browser')] });
    window.clubhouse.mcpBinding.getConnectionSources = vi.fn().mockRejectedValue(new Error('Source index offline'));
    window.clubhouse.mcpBinding.getConnectionGuidance = vi.fn(async (from, to) => guidance(from, to, {
      readOnly: true, readOnlyReason: 'Connection ownership could not be checked.',
    }));
    render(<ConnectionsCard agent={lead} helperIds={new Set()} open onToggle={vi.fn()} onDisconnect={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    expect(await screen.findByRole('textbox', { name: 'Instructions' })).toBeDisabled();
    expect(screen.getByText(/Couldn't refresh connection sources: Source index offline/)).toBeInTheDocument();
    window.clubhouse.mcpBinding.getConnectionSources = vi.fn(async () => ({ pairs: [], unreadable: [] }));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByText(/Couldn't refresh connection sources/)).toBeNull());
  });

  it('inspects plugin guidance with its backend read-only reason and no connection permission controls', async () => {
    useMcpBindingStore.setState({ bindings: [wire('lead', 'plugin-target', ['epic-lead', 'Plugin tools'], 'plugin')] });
    window.clubhouse.mcpBinding.getConnectionSources = vi.fn(async () => ({ pairs: [], unreadable: [] }));
    window.clubhouse.mcpBinding.getConnectionGuidance = vi.fn(async (from, to) => guidance(from, to, {
      readOnly: true, readOnlyReason: 'Plugin connection guidance cannot be changed from this window.',
    }));
    window.clubhouse.mcpBinding.getConnectionToolCatalog = vi.fn(async () => ({ state: 'available', tools: [] }));
    window.clubhouse.mcpBinding.saveConnectionGuidance = vi.fn();
    render(<ConnectionsCard agent={lead} helperIds={new Set()} open onToggle={vi.fn()} onDisconnect={vi.fn()} />);
    expect(await screen.findByTestId('connection-meta')).toHaveTextContent('plugin');
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    expect(await screen.findByRole('textbox', { name: 'Instructions' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('Plugin connection guidance cannot be changed');
    expect(screen.getByRole('button', { name: 'Save direction' })).toBeDisabled();
    expect(screen.queryByTestId('connection-directions')).toBeNull();
    expect(window.clubhouse.mcpBinding.saveConnectionGuidance).not.toHaveBeenCalled();
  });

  it.each([false, true])('reads the actual automatic-OFF producer through Card inspection without writes, repair or clients (corrupt source: %s)', async (corrupt) => {
    offlineFiles.base = fs.mkdtempSync(path.join(os.tmpdir(), 'clubhouse-card-offline-'));
    const bridge = { ...window.clubhouse.mcpBinding };
    let view: ReturnType<typeof render> | undefined;
    try {
      resetAllSettingsStoresForTests();
      mainBindings._resetForTesting();
      mainSources._resetPersistedBindingSourcesForTesting();
      mainGuidance.startConnectionGuidance();
      const projectPath = path.join(offlineFiles.base, 'project');
      const agentsFile = path.join(projectPath, '.clubhouse', 'agents.json');
      const projectsFile = path.join(offlineFiles.base, 'projects.json');
      const canvasDir = path.join(projectPath, '.clubhouse', 'plugin-data-local', 'canvas', 'kv');
      const registryFile = path.join(offlineFiles.base, '.clubhouse-dev', 'group-projects', 'registry.json');
      fs.mkdirSync(canvasDir, { recursive: true });
      fs.mkdirSync(path.dirname(registryFile), { recursive: true });
      fs.writeFileSync(projectsFile, JSON.stringify({ version: 1, projects: [{ id: 'p1', name: 'Project', path: projectPath }] }));
      fs.writeFileSync(agentsFile, JSON.stringify(['lead', 'work'].map((id) => ({
        id, name: id === 'lead' ? lead.name : 'Rosie', color: 'teal', createdAt: '2026-11-07',
        orchestration: { orchestrate: true, connectToDispatcher: true },
      }))));
      fs.writeFileSync(path.join(canvasDir, 'canvas-instances.json'), JSON.stringify([{
        id: 'canvas', name: 'Project canvas', views: [
          { id: 'lead-view', type: 'agent', agentId: 'lead' },
          { id: 'gp-view', type: 'plugin', metadata: { groupProjectId: 'legacy-gp' } },
        ],
      }]));
      fs.writeFileSync(path.join(canvasDir, 'canvas-wires.json'), JSON.stringify([
        { agentId: 'lead', targetId: 'legacy-gp', targetKind: 'group-project', label: 'Legacy group', agentName: lead.name },
      ]));
      fs.writeFileSync(registryFile, JSON.stringify([{ id: 'legacy-gp', name: 'Legacy group', description: '', instructions: '', createdAt: '2026-11-07', metadata: {} }]));
      mainSources.applyPersistedBinding({ agentId: 'lead', targetId: 'work', targetKind: 'agent', label: 'Rosie' });
      const before = await mainGuidance.getConnectionGuidance('lead', 'work');
      await mainGuidance.saveConnectionGuidance('lead', 'work', {
        instructions: { '*': 'Actual saved automatic routing', absent_tool: 'Actual saved unavailable replacement' }, revision: before.revision,
      });
      mainBindings.unbind('lead', 'work');
      vi.spyOn(mainDispatcher, 'getDispatcherAgentId').mockReturnValue('work');
      vi.spyOn(mainDispatcher, 'isDispatcherEnabled').mockReturnValue(false);
      vi.spyOn(mainDispatcher, 'isDispatcherPath').mockReturnValue(false);
      mainSources.registerPersistedBindingSource(canvasWireBindingSource);
      mainSources.registerPersistedBindingSource(dispatcherWireBindingSource);
      const grantsFile = path.join(offlineFiles.base, 'connection-grants.json');
      fs.writeFileSync(grantsFile, JSON.stringify({
        version: 1, directions: [{ from: { agentId: 'lead' }, to: { agentId: 'work' }, disabledTools: ['send_message'], updatedAt: '2026-11-07' }],
      }));
      const grantsTemp = `${grantsFile}.tmp-0-retained`;
      fs.writeFileSync(grantsTemp, 'Uncommitted permission bytes');
      if (corrupt) {
        fs.copyFileSync(projectsFile, `${projectsFile}.bak`);
        fs.writeFileSync(projectsFile, '{malformed');
      }
      resetAllSettingsStoresForTests();
      const protectedFiles = [projectsFile, agentsFile, registryFile, grantsFile, grantsTemp,
        path.join(canvasDir, 'canvas-instances.json'), path.join(canvasDir, 'canvas-wires.json'),
        path.join(offlineFiles.base, 'connection-instructions.json')];
      const bytes = protectedFiles.map((file) => fs.readFileSync(file, 'utf8'));
      const names = fs.readdirSync(offlineFiles.base, { recursive: true }).sort();
      const forbidden = [
        vi.spyOn(fs.promises, 'rename'), vi.spyOn(fs.promises, 'writeFile'), vi.spyOn(fs.promises, 'mkdir'),
        vi.spyOn(fs.promises, 'rm'), vi.spyOn(fs.promises, 'unlink'), vi.spyOn(fs.promises, 'open'),
        vi.spyOn(fs, 'renameSync'), vi.spyOn(fs, 'writeFileSync'), vi.spyOn(fs, 'mkdirSync'),
        vi.spyOn(fs, 'rmSync'), vi.spyOn(fs, 'unlinkSync'), vi.spyOn(fs, 'watch'), vi.spyOn(fs, 'watchFile'),
        vi.spyOn(fs.promises, 'watch'), vi.spyOn(mainBindings, 'bind'),
        vi.spyOn(canvasWireBindingSource, 'collect'), vi.spyOn(dispatcherWireBindingSource, 'collect'),
        vi.spyOn(mainProjects, 'list'), vi.spyOn(mainAgentConfig, 'listDurable'),
        vi.spyOn(mainPolicies, 'resolveOrchestrationPolicies'), vi.spyOn(groupProjectRegistry, 'list'),
      ];
      syncBuiltinESMExports();
      expect(fsExports.renameSync).toBe(fs.renameSync);
      expect(fsExports.watch).toBe(fs.watch);
      expect(fspExports.open).toBe(fs.promises.open);
      expect(fspExports.rename).toBe(fs.promises.rename);
      window.clubhouse.mcpBinding.getConnectionSources = vi.fn(listConnectionSources);
      window.clubhouse.mcpBinding.getDispatcherLinks = vi.fn(async () => listDispatcherLinksForUser({ strict: true }));
      window.clubhouse.mcpBinding.getToolConnections = vi.fn(async () => mainSources.listSoleOwnedPairs('orchestrator-connections'));
      window.clubhouse.mcpBinding.getConnectionGrants = vi.fn(async (id) => listConnectionDirectionsForInspection(id));
      window.clubhouse.mcpBinding.getConnectionGuidance = vi.fn(mainGuidance.getConnectionGuidance);
      window.clubhouse.mcpBinding.getConnectionToolCatalog = vi.fn();
      window.clubhouse.mcpBinding.saveConnectionGuidance = vi.fn();
      window.clubhouse.mcpBinding.previewConnectionGuidance = vi.fn();
      window.clubhouse.mcpBinding.removeConnectionSource = vi.fn();
      window.clubhouse.mcpBinding.setDisabledTools = vi.fn();
      window.clubhouse.mcpBinding.setLocalWake = vi.fn();
      window.clubhouse.mcpBinding.makeTwoWay = vi.fn();
      useMcpBindingStore.setState({ bindings: [] });
      useDispatcherStore.getState().setState({
        ...DISPATCHER_OFF, agentId: 'work', chatAgentId: 'chat',
        config: { id: 'work', name: 'Rosie', color: 'indigo', createdAt: 'then' },
      });
      view = render(<ConnectionsCard agent={{ ...lead, status: 'sleeping' }} helperIds={new Set()} open onToggle={vi.fn()} onDisconnect={vi.fn()} />);
      if (corrupt) {
        expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't check saved connection sources");
        expect(screen.queryByTestId('connection-row')).toBeNull();
      } else {
        const row = await screen.findByTestId('connection-row');
        expect(row).toHaveTextContent('Dispatcher controller');
        expect(row).toHaveTextContent('configured two-way, suspended, not connected');
        expect(within(row).queryByTestId('connection-disconnect')).toBeNull();
        fireEvent.click(within(row).getByRole('button', { name: 'Edit' }));
        const dialog = screen.getByTestId('connection-sources-dialog');
        expect(await within(dialog).findByRole('textbox', { name: 'Instructions' })).toHaveValue('Actual saved automatic routing');
        expect(within(dialog).getByRole('textbox', { name: 'Instructions' })).toBeDisabled();
        expect(within(dialog).getByTestId('connection-source-dispatcher_auto')).toHaveTextContent('Not connected now');
        expect(within(dialog).queryByTestId('connection-source-dispatcher_link')).toBeNull();
        expect(within(dialog).queryAllByRole('switch')).toHaveLength(0);
        expect(within(dialog).queryByText('Make two-way')).toBeNull();
        expect(within(dialog).getByRole('button', { name: 'Save direction' })).toBeDisabled();
        fireEvent.click(within(dialog).getByTestId('connection-source-remove-dispatcher_auto'));
        expect(within(dialog).getByTestId('connection-source-confirm-dispatcher_auto')).toHaveTextContent('Turn it off');
        expect(window.clubhouse.mcpBinding.getConnectionGuidance).toHaveBeenCalledWith('lead', 'work');
        expect(window.clubhouse.mcpBinding.getConnectionGuidance).toHaveBeenCalledWith('work', 'lead');
      }
      for (const action of ['getConnectionToolCatalog', 'saveConnectionGuidance', 'previewConnectionGuidance', 'removeConnectionSource', 'setDisabledTools', 'setLocalWake', 'makeTwoWay'] as const) {
        expect(window.clubhouse.mcpBinding[action]).not.toHaveBeenCalled();
      }
      for (const operation of forbidden) expect(operation).not.toHaveBeenCalled();
      expect(mainBindings.getAllBindings()).toEqual([]);
      expect(useMcpBindingStore.getState().bindings).toEqual([]);
      expect(mainAgents.get('lead')).toBeUndefined();
      expect(mainAgents.get('work')).toBeUndefined();
      expect(groupProjectRegistry.getSync('legacy-gp')).toBeNull();
      expect(protectedFiles.map((file) => fs.readFileSync(file, 'utf8'))).toEqual(bytes);
      expect(fs.readdirSync(offlineFiles.base, { recursive: true }).sort()).toEqual(names);
    } finally {
      view?.unmount();
      vi.restoreAllMocks();
      syncBuiltinESMExports();
      Object.assign(window.clubhouse.mcpBinding, bridge);
      mainBindings.setConnectionInstructionsSource(null);
      mainBindings._resetForTesting();
      mainSources._resetPersistedBindingSourcesForTesting();
      fs.rmSync(offlineFiles.base, { recursive: true, force: true });
    }
  });
});
