import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
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

  it('offers Disconnect once the connection tools hand it a callback (#2253)', () => {
    const onDisconnect = vi.fn();
    render(<ConnectionsCard agent={lead} helperIds={new Set(['h1'])} open onToggle={() => {}} onDisconnect={onDisconnect} />);
    fireEvent.click(screen.getAllByTestId('connection-disconnect')[0]);
    expect(onDisconnect).toHaveBeenCalledWith(expect.objectContaining({ id: 'h1', direction: 'two-way', family: 'helper' }));
  });

  it('says where wires come from when there are none', () => {
    useMcpBindingStore.setState({ bindings: [] });
    render(<ConnectionsCard agent={lead} helperIds={new Set()} open onToggle={() => {}} />);
    expect(screen.getByTestId('details-card-connections-summary')).toHaveTextContent('none');
    expect(screen.getByTestId('details-card-connections')).toHaveTextContent('No Clubhouse MCP wires.');
  });
});
