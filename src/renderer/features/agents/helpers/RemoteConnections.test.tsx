import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { RemoteConnections, remoteConnections } from './RemoteConnections';
import { useAnnexClientStore } from '../../../stores/annexClientStore';
import { useAnnexStore } from '../../../stores/annexStore';
import { useRemoteProjectStore } from '../../../stores/remoteProjectStore';
import type { Agent } from '../../../../shared/types';
import type { ConnectionDirection } from '../../../../shared/connection-grants';

const NET = Array(16).fill('bb').join(':');
const OLD = Array(16).fill('cc').join(':');
const agent = { id: 'a', name: 'alpha', projectId: 'p', kind: 'durable' } as unknown as Agent;
const at = '2026-11-08T00:00:00Z';
const dir = (from: ConnectionDirection['from'], to: ConnectionDirection['to'], link = true): ConnectionDirection =>
  ({ from, to, disabledTools: [], ...(link && { link: { createdAt: at } }), updatedAt: at });

describe('connections with agents on other computers (#3064)', () => {
  beforeEach(() => {
    useAnnexClientStore.setState({ satellites: [
      { id: NET, fingerprint: NET.toUpperCase(), alias: 'Studio', state: 'connected' },
      { id: OLD, fingerprint: OLD, alias: 'Old Mac', state: 'connected' },
    ] } as never);
    useAnnexStore.setState({
      devices: [
        { fingerprint: NET, alias: 'Studio', role: 'member', kind: 'desktop', state: 'connected' },
        { fingerprint: OLD, alias: 'Old Mac', role: 'satellite', state: 'connected' },
      ],
      loadDevices: vi.fn(),
    } as never);
    useRemoteProjectStore.setState({ remoteAgents: {
      [`remote||${NET}||z`]: { id: `remote||${NET}||z`, name: 'zed', kind: 'durable' },
      [`remote||${NET}||q`]: { id: `remote||${NET}||q`, name: 'quick', kind: 'quick' },
      [`remote||${NET}||y`]: { id: `remote||${NET}||y`, name: 'yara', kind: 'durable' },
      [`remote||${OLD}||o`]: { id: `remote||${OLD}||o`, name: 'old one', kind: 'durable' },
    } } as never);
  });

  it('folds the two directions with one agent into a two-way row, and leaves out links that are off and local ones', () => {
    const rows = remoteConnections([
      dir({ agentId: 'a' }, { agentId: 'z', machineId: NET }),
      dir({ agentId: 'z', machineId: NET }, { agentId: 'a' }),
      dir({ agentId: 'y', machineId: NET }, { agentId: 'a' }),
      dir({ agentId: 'a' }, { agentId: 'w', machineId: NET }, false),
      dir({ agentId: 'a' }, { agentId: 'b' }),
    ], 'a');
    expect(rows).toEqual([
      { address: `z@${NET}`, agentId: 'z', machine: NET, direction: 'two-way' },
      { address: `y@${NET}`, agentId: 'y', machine: NET, direction: 'from' },
    ]);
  });

  it('lists each connection with its computer', () => {
    render(<RemoteConnections agent={agent} grants={[dir({ agentId: 'a' }, { agentId: 'z', machineId: NET })]} onChanged={vi.fn()} />);
    expect(screen.getByTestId('remote-connection-row')).toHaveTextContent('zed');
    expect(screen.getByTestId('remote-connection-row')).toHaveTextContent('on Studio, sends to it');
    expect(screen.queryByTestId('remote-connection-add')).not.toBeInTheDocument();
  });

  it('shows an agent-created direction and its maker without a user link', () => {
    const networkDirection = { ...dir({ agentId: 'a' }, { agentId: 'z', machineId: NET }, false), agentLinks: [{ agentId: 'maker', machineId: NET, name: 'Morgan', createdAt: at }] };
    render(<RemoteConnections agent={agent} grants={[networkDirection]} onChanged={vi.fn()} />);
    expect(screen.getByTestId('remote-connection-row')).toHaveTextContent('Made by Morgan');
    fireEvent.click(screen.getByTestId('remote-connection-manage'));
    expect(screen.getByRole('region', { name: 'alpha to zed' })).toBeInTheDocument();
  });

  it('removes both directions after confirming', async () => {
    const disconnect = vi.fn().mockResolvedValue(undefined);
    Object.assign(window.clubhouse.mcpBinding, { removeRemoteSource: disconnect });
    render(<RemoteConnections agent={agent} grants={[dir({ agentId: 'a' }, { agentId: 'z', machineId: NET })]} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByTestId('remote-connection-manage'));
    fireEvent.click(screen.getByTestId('connection-source-remove-user_link'));
    await waitFor(() => expect(disconnect).toHaveBeenCalledWith('a', `z@${NET}`, 'user_link'));
  });

  it('removes only the card source in both directions from the shared editor', async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    Object.assign(window.clubhouse.mcpBinding, { removeRemoteSource: remove });
    const card = (from: ConnectionDirection['from'], to: ConnectionDirection['to']): ConnectionDirection =>
      ({ from, to, disabledTools: [], cardLink: { createdAt: at }, updatedAt: at });
    render(<RemoteConnections agent={agent} onChanged={vi.fn()} grants={[
      { ...card({ agentId: 'a' }, { agentId: 'z', machineId: NET }), link: { createdAt: at } },
      card({ agentId: 'z', machineId: NET }, { agentId: 'a' }),
    ]} />);
    fireEvent.click(screen.getByTestId('remote-connection-manage'));
    expect(screen.getByTestId('connection-source-user_link')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('connection-source-remove-card_link'));
    await waitFor(() => expect(remove).toHaveBeenCalledWith('a', `z@${NET}`, 'card_link'));
  });

  it('switches each tool, wake included, on each direction, and saves the direction it belongs to', async () => {
    const setTools = vi.fn().mockResolvedValue(undefined);
    Object.assign(window.clubhouse.mcpBinding, { setToolsAcrossMachines: setTools });
    const onChanged = vi.fn();
    render(<RemoteConnections agent={agent} onChanged={onChanged} grants={[
      { ...dir({ agentId: 'a' }, { agentId: 'z', machineId: NET }), disabledTools: ['clear_agent'] },
      dir({ agentId: 'z', machineId: NET }, { agentId: 'a' }),
    ]} />);
    fireEvent.click(screen.getByTestId('remote-connection-manage'));
    expect(screen.getByRole('region', { name: 'alpha to zed' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'zed to alpha' })).toBeInTheDocument();
    const wakes = screen.getAllByRole('switch', { name: /Wake it/ });
    expect(wakes).toHaveLength(2);
    expect(screen.getAllByRole('switch', { name: /Clear its context/ })[0]).toHaveAttribute('aria-checked', 'false');
    // Wake off for zed → alpha: the incoming direction.
    fireEvent.click(wakes[1]);
    await waitFor(() => expect(setTools).toHaveBeenCalledWith('a', `z@${NET}`, false, ['wake_agent']));
    // Clear on for alpha → zed.
    fireEvent.click(screen.getAllByRole('switch', { name: /Clear its context/ })[0]);
    await waitFor(() => expect(setTools).toHaveBeenCalledWith('a', `z@${NET}`, true, []));
    expect(onChanged).toHaveBeenCalled();
  });

  it('shows nothing with no connections and no computer to connect to', () => {
    useAnnexStore.setState({ devices: [] } as never);
    const { container } = render(<RemoteConnections agent={agent} grants={[]} onChanged={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });
});
