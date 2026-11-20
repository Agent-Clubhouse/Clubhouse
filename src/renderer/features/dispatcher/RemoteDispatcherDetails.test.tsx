import { act, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SatelliteConnection, SatelliteSnapshot } from '../../../shared/types';
import type { RemoteDispatcherPresence } from '../../../shared/dispatcher-presence';
import { useAnnexClientStore } from '../../stores/annexClientStore';
import { RemoteDispatcherDetails } from './RemoteDispatcherDetails';

const remote = (machineId: string, extra: Partial<RemoteDispatcherPresence> = {}): RemoteDispatcherPresence => ({
  machineId, machineName: machineId, address: `published-controller@${machineId}`, dispatcherName: 'Selected Dispatcher', label: `Dispatcher on ${machineId}`, state: 'online', link: { state: 'active' }, ...extra,
});
const snapshot = (extra: Partial<SatelliteSnapshot> = {}): SatelliteSnapshot => ({
  projects: [], agents: {}, quickAgents: {}, theme: null, orchestrators: [], pendingPermissions: [], lastSeq: 1,
  dispatcher: { enabled: true, agent: null }, dispatcherPresence: { remotes: [remote('HOST_PRIVATE_PEER')] }, ...extra,
});
const satellite = (extra: Partial<SatelliteConnection> = {}): SatelliteConnection => ({
  id: 'sat', alias: 'Selected host', fingerprint: 'TARGET', state: 'connected', snapshot: snapshot(), icon: '', color: 'blue', host: 'target', mainPort: 1, pairingPort: 2, lastError: null, ...extra,
});
const setHost = (extra: Partial<SatelliteConnection> = {}) => useAnnexClientStore.setState({ satellites: [satellite(extra)] });
const forbiddenCalls: unknown[] = [];
beforeEach(() => {
  setHost();
  vi.spyOn(window.clubhouse.dispatcher, 'getPresence').mockResolvedValue({ remotes: [remote('target'), remote('LOCAL_ONLY_PEER')] });
  forbiddenCalls.length = 0;
  forbiddenCalls.push(
    vi.spyOn(window.clubhouse.agent, 'getDurableConfig'), vi.spyOn(window.clubhouse.agent, 'updateDurable'),
    vi.spyOn(window.clubhouse.actions, 'list'), vi.spyOn(window.clubhouse.managed, 'getSetup'),
    vi.spyOn(window.clubhouse.mcpBinding, 'getConnectionGrants'), vi.spyOn(window.clubhouse.dispatcher, 'wake'),
    vi.spyOn(window.clubhouse.dispatcher, 'get'), vi.spyOn(window.clubhouse.annexClient, 'agentSpawn'),
    vi.spyOn(window.clubhouse.annexClient, 'agentWake'), vi.spyOn(window.clubhouse.annexClient, 'agentKill'),
    vi.spyOn(window.clubhouse.annexClient, 'controllerChatPage'), vi.spyOn(window.clubhouse.annexClient, 'controllerChatSessions'),
  );
  const details = vi.fn(), settings = vi.fn();
  Object.assign(window.clubhouse.annexClient, { agentDetails: details, agentSettings: settings });
  forbiddenCalls.push(details, settings);
});
afterEach(() => {
  for (const call of forbiddenCalls) expect(call).not.toHaveBeenCalled();
});
const cards = () => screen.getByRole('complementary', { name: 'Dispatcher snapshot details' });

describe('no-chat remote Dispatcher observations', () => {
  it('shows selected-host settings and peers with published-link provenance, without treating an address as a role id', async () => {
    render(<RemoteDispatcherDetails machineId="TaRgEt" />);
    await screen.findByText('Dispatcher on target');
    expect(screen.getByTestId('remote-dispatcher-details')).toHaveTextContent('hasn’t shared a Dispatcher chat identity');
    expect(screen.getByTestId('details-card-settings-summary')).toHaveTextContent('On · host snapshot');
    expect(screen.getByTestId('details-card-settings')).toHaveTextContent('Detailed settings, Connections and Actions are unavailable');
    expect(screen.getByTestId('details-card-connections')).toHaveTextContent('Link active');
    expect(screen.getByTestId('details-card-connections')).toHaveTextContent('not the selected host’s connection inventory');
    expect(screen.getByTestId('other-machine-HOST_PRIVATE_PEER')).toBeInTheDocument();
    expect(screen.queryByTestId('other-machine-LOCAL_ONLY_PEER')).not.toBeInTheDocument();
    expect(cards().innerHTML).not.toContain('published-controller');
    expect(screen.getByTestId('details-card-actions')).toHaveTextContent('No host Action inventory has been read');
    for (const id of ['session', 'changes', 'orchestrate', 'dispatcher', 'subagents', 'skills-mcp', 'canvases']) expect(screen.queryByTestId(`details-card-${id}`)).not.toBeInTheDocument();
    expect(within(cards()).queryByRole('switch')).not.toBeInTheDocument();
    expect(within(cards()).queryByRole('combobox')).not.toBeInTheDocument();
    expect(within(cards()).queryByRole('button')).not.toBeInTheDocument();
  });

  it('reports an explicit off flag without fabricating a created or sleeping agent', () => {
    setHost({ snapshot: snapshot({ dispatcher: { enabled: false, agent: null } }) });
    render(<RemoteDispatcherDetails machineId="target" />);
    expect(screen.getByTestId('details-card-settings-summary')).toHaveTextContent('Turned off · host snapshot');
    expect(screen.getByTestId('details-card-settings')).toHaveTextContent('does not say whether a Dispatcher was previously created');
    expect(cards()).not.toHaveTextContent('Sleeping');
  });

  it.each([undefined, null])('keeps absent/old-host/unbound role settings and peers unknown (%s)', (dispatcher) => {
    setHost({ snapshot: snapshot({ dispatcher, dispatcherPresence: undefined }) });
    render(<RemoteDispatcherDetails machineId="target" />);
    expect(screen.getByTestId('details-card-settings-summary')).toHaveTextContent('unavailable');
    expect(screen.getByTestId('details-card-settings')).toHaveTextContent('version or role state may not support');
    expect(screen.getByTestId('details-card-other-machines')).toHaveTextContent('An absent list is not an empty network');
    expect(screen.queryByTestId('other-machines-empty')).not.toBeInTheDocument();
  });

  it('distinguishes a host-reported empty peer list from an absent one', () => {
    setHost({ snapshot: snapshot({ dispatcherPresence: { remotes: [] } }) });
    render(<RemoteDispatcherDetails machineId="target" />);
    expect(screen.getByTestId('details-card-other-machines-summary')).toHaveTextContent('0 of 0 online');
    expect(screen.getByTestId('other-machines-empty')).toBeInTheDocument();
  });

  it.each([
    [{ state: 'disconnected' }, 'no connected read'],
    [{ snapshotUnavailable: true }, 'host snapshot is unavailable'],
    [{ needsPairing: true, lastError: '403 Forbidden PRIVATE_DENIAL' }, 'Access must be renewed'],
    [{ snapshot: snapshot({ sessionPaused: true }) }, 'Host sharing is paused'],
  ] as const)('withholds retained private fields on access/currentness loss %j', async (extra, limitation) => {
    const view = render(<RemoteDispatcherDetails machineId="target" />);
    await screen.findByText('Dispatcher on target');
    expect(screen.getByTestId('other-machine-HOST_PRIVATE_PEER')).toBeInTheDocument();
    act(() => setHost(extra));
    for (const id of ['settings', 'connections', 'actions', 'other-machines']) expect(screen.getByTestId(`details-card-${id}`)).toHaveTextContent(limitation);
    expect(screen.getByTestId('details-card-settings-summary')).toHaveTextContent('unavailable');
    expect(screen.queryByTestId('other-machine-HOST_PRIVATE_PEER')).not.toBeInTheDocument();
    expect(view.container.innerHTML).not.toContain('PRIVATE_DENIAL');
    // Local published presence remains a separately labelled observation.
    expect(screen.getByTestId('details-card-connections')).toHaveTextContent('published controller-link observation');
  });

  it('waits for a new snapshot after access returns instead of reviving the retained private list', () => {
    const retained = snapshot();
    setHost({ snapshot: retained });
    render(<RemoteDispatcherDetails machineId="target" />);
    expect(screen.getByTestId('other-machine-HOST_PRIVATE_PEER')).toBeInTheDocument();
    act(() => setHost({ snapshot: retained, needsPairing: true }));
    expect(screen.queryByTestId('other-machine-HOST_PRIVATE_PEER')).not.toBeInTheDocument();
    act(() => setHost({ snapshot: retained }));
    expect(screen.queryByTestId('other-machine-HOST_PRIVATE_PEER')).not.toBeInTheDocument();
    expect(screen.getByTestId('details-card-other-machines')).toHaveTextContent('Waiting for a new host snapshot');
    act(() => setHost({ snapshot: snapshot({ dispatcherPresence: { remotes: [remote('NEW_HOST_PEER')] } }) }));
    expect(screen.getByTestId('other-machine-NEW_HOST_PEER')).toBeInTheDocument();
    expect(screen.queryByTestId('other-machine-HOST_PRIVATE_PEER')).not.toBeInTheDocument();
  });

  it('does not reuse copied fields marked omitted in the host snapshot', () => {
    setHost({ snapshot: snapshot({ snapshotTruncated: { version: 1, reason: 'frame_limit', omitted: ['dispatcher', 'dispatcherPresence'] } }) });
    render(<RemoteDispatcherDetails machineId="target" />);
    expect(screen.getByTestId('details-card-settings')).toHaveTextContent('settings were omitted');
    expect(screen.getByTestId('details-card-other-machines')).toHaveTextContent('Other machines were omitted');
    expect(screen.queryByTestId('other-machine-HOST_PRIVATE_PEER')).not.toBeInTheDocument();
  });

  it('replaces observations when selection changes with the same unbound role shape', () => {
    const view = render(<RemoteDispatcherDetails machineId="target" />);
    expect(screen.getByTestId('other-machine-HOST_PRIVATE_PEER')).toBeInTheDocument();
    act(() => useAnnexClientStore.setState({ satellites: [satellite(), satellite({ id: 'different-connection', fingerprint: 'OTHER', snapshot: snapshot({ dispatcher: { enabled: false }, dispatcherPresence: { remotes: [remote('OTHER_HOST_PEER')] } }) })] }));
    view.rerender(<RemoteDispatcherDetails machineId="other" />);
    expect(screen.getByTestId('details-card-settings-summary')).toHaveTextContent('Turned off');
    expect(screen.queryByTestId('other-machine-HOST_PRIVATE_PEER')).not.toBeInTheDocument();
    expect(screen.getByTestId('other-machine-OTHER_HOST_PEER')).toBeInTheDocument();
  });
});
