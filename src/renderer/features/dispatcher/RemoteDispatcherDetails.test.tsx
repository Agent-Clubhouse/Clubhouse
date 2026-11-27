import { act, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SatelliteConnection, SatelliteSnapshot } from '../../../shared/types';
import type { RemoteDispatcherPresence } from '../../../shared/dispatcher-presence';
import { REMOTE_DETAILS_CARD_IDS } from '../../../shared/remote-agent-details';
import type { SelectedDispatcherDetails } from '../../../shared/selected-dispatcher-details';
import { useAnnexClientStore } from '../../stores/annexClientStore';
import { RemoteDispatcherDetails } from './RemoteDispatcherDetails';

const remote = (machineId: string, extra: Partial<RemoteDispatcherPresence> = {}): RemoteDispatcherPresence => ({ machineId, machineName: machineId,
  address: `published-controller@${machineId}`, dispatcherName: 'Selected Dispatcher', label: `Dispatcher on ${machineId}`, state: 'online', link: { state: 'active' }, ...extra });
const snapshot = (extra: Partial<SatelliteSnapshot> = {}): SatelliteSnapshot => ({ projects: [], agents: {}, quickAgents: {}, theme: null, orchestrators: [], pendingPermissions: [], lastSeq: 1,
  dispatcher: { enabled: true, agent: null }, dispatcherPresence: { remotes: [remote('HOST_PRIVATE_PEER')] }, ...extra });
const satellite = (extra: Partial<SatelliteConnection> = {}): SatelliteConnection => ({ id: 'sat', alias: 'Selected host', fingerprint: 'TARGET', state: 'connected', snapshot: snapshot(),
  snapshotReceipt: 'main-receipt-a', connectionGeneration: 0, icon: '', color: 'blue', host: 'target', mainPort: 1, pairingPort: 2, lastError: null, ...extra });
const setHost = (extra: Partial<SatelliteConnection> = {}) => useAnnexClientStore.setState({ satellites: [satellite(extra)] });
const role = (id = 'role1', model = 'HOST_MODEL'): SelectedDispatcherDetails => ({ version: 1, role: 'dispatcher', agentId: id, details: { version: 1, agentId: id, readOnly: true, readAt: 1,
  providerId: 'claude-code', running: false, status: 'sleeping', spawnedAt: null, sessionId: null, nativeSessionId: null,
  settings: { version: 1, agentId: id, readOnly: true, provider: 'HOST_CLI', model, runtime: 'chat', access: 'Ask first', executionPolicy: 'defaults', autoSleep: null, context: null,
    setup: { state: 'ok', managed: true, template: 'Host template', instructions: '2 blocks', skills: ['HOST_SKILL'], mcps: ['HOST_MCP'] } },
  cards: REMOTE_DETAILS_CARD_IDS.map((cardId) => ({ id: cardId, title: cardId, state: 'ok', summary: `HOST_${cardId}`, rows: [{ label: `${cardId} field`, value: `HOST_${cardId}_EVIDENCE` }], notes: [], omitted: 0, observedAt: 1 })),
} });
const api = vi.fn();
const forbiddenCalls: unknown[] = [];
beforeEach(() => {
  setHost(); useAnnexClientStore.setState({ satellitePaused: {} });
  api.mockResolvedValue({ status: 'ok', value: role() });
  Object.assign(window.clubhouse.annexClient, { dispatcherDetails: api });
  vi.spyOn(window.clubhouse.dispatcher, 'getPresence').mockResolvedValue({ remotes: [remote('target'), remote('LOCAL_ONLY_PEER')] });
  forbiddenCalls.length = 0;
  forbiddenCalls.push(vi.spyOn(window.clubhouse.agent, 'getDurableConfig'), vi.spyOn(window.clubhouse.agent, 'updateDurable'), vi.spyOn(window.clubhouse.actions, 'list'),
    vi.spyOn(window.clubhouse.managed, 'getSetup'), vi.spyOn(window.clubhouse.mcpBinding, 'getConnectionGrants'), vi.spyOn(window.clubhouse.dispatcher, 'wake'), vi.spyOn(window.clubhouse.dispatcher, 'get'),
    vi.spyOn(window.clubhouse.annexClient, 'agentSpawn'), vi.spyOn(window.clubhouse.annexClient, 'agentWake'), vi.spyOn(window.clubhouse.annexClient, 'agentKill'),
    vi.spyOn(window.clubhouse.annexClient, 'controllerChatPage'), vi.spyOn(window.clubhouse.annexClient, 'controllerChatSessions'));
  const details = vi.fn(), settings = vi.fn(); Object.assign(window.clubhouse.annexClient, { agentDetails: details, agentSettings: settings }); forbiddenCalls.push(details, settings);
});
afterEach(() => { for (const call of forbiddenCalls) expect(call).not.toHaveBeenCalled(); });
const cards = () => screen.getByRole('complementary', { name: 'Dispatcher host details' });
const loaded = () => screen.findByText('HOST_MODEL');

describe('no-chat selected-host Dispatcher role consumer', () => {
  it('renders actual role fields and separately admitted host peers without an Agent, address lookup or shared role cache', async () => {
    const before = JSON.stringify(useAnnexClientStore.getState().satellites);
    render(<RemoteDispatcherDetails machineId="TaRgEt" />); await loaded();
    expect(api).toHaveBeenCalledExactlyOnceWith('target');
    expect(screen.getByTestId('remote-dispatcher-details')).toHaveTextContent('hasn’t shared a Dispatcher chat identity');
    expect(screen.getByTestId('details-card-settings')).toHaveTextContent('On · host snapshot');
    for (const name of ['HOST_CLI', 'HOST_SKILL', 'HOST_MCP', 'Host template']) expect(screen.getByTestId('details-card-settings')).toHaveTextContent(name);
    expect(screen.getByTestId('details-card-connections')).toHaveTextContent('HOST_connections_EVIDENCE');
    expect(screen.getByTestId('details-card-actions')).toHaveTextContent('HOST_actions_EVIDENCE');
    expect(screen.getByTestId('details-card-connections')).toHaveTextContent('published controller-connection observation');
    expect(screen.getByTestId('other-machine-HOST_PRIVATE_PEER')).toBeInTheDocument();
    expect(screen.queryByTestId('other-machine-LOCAL_ONLY_PEER')).not.toBeInTheDocument();
    expect(cards().innerHTML).not.toContain('published-controller');
    expect(JSON.stringify(useAnnexClientStore.getState().satellites)).toBe(before);
    for (const id of ['session', 'changes', 'orchestrate', 'dispatcher', 'subagents', 'skills-mcp', 'canvases']) expect(screen.queryByTestId(`details-card-${id}`)).not.toBeInTheDocument();
    expect(within(cards()).queryByRole('switch')).not.toBeInTheDocument(); expect(within(cards()).queryByRole('combobox')).not.toBeInTheDocument();
    expect(within(cards()).getAllByRole('button').map((button) => button.textContent)).toEqual(['Refresh Dispatcher details']);
  });

  it('shows an off snapshot alongside an independently admitted existing role, without inventing live sleep state', async () => {
    setHost({ snapshot: snapshot({ dispatcher: { enabled: false, agent: null } }) });
    render(<RemoteDispatcherDetails machineId="target" />); await loaded();
    expect(screen.getByTestId('details-card-settings')).toHaveTextContent('Turned off · host snapshot');
    expect(screen.getByTestId('remote-dispatcher-role-status')).toHaveTextContent('Read-only Dispatcher metadata');
    expect(cards()).not.toHaveTextContent('Sleeping');
  });

  it.each([undefined, null])('keeps absent snapshot sections unknown despite an admitted role (%s)', async (dispatcher) => {
    setHost({ snapshot: snapshot({ dispatcher, dispatcherPresence: undefined }) });
    render(<RemoteDispatcherDetails machineId="target" />); await loaded();
    expect(screen.getByTestId('details-card-settings')).toHaveTextContent('on/off state is not included');
    expect(screen.getByTestId('details-card-other-machines')).toHaveTextContent('An absent list is not an empty network');
    expect(screen.queryByTestId('other-machines-empty')).not.toBeInTheDocument();
  });

  it('distinguishes a host-reported empty peer list from an absent one', async () => {
    setHost({ snapshot: snapshot({ dispatcherPresence: { remotes: [] } }) });
    render(<RemoteDispatcherDetails machineId="target" />); await loaded();
    expect(screen.getByTestId('details-card-other-machines-summary')).toHaveTextContent('0 of 0 online');
    expect(screen.getByTestId('other-machines-empty')).toBeInTheDocument();
  });

  it.each([
    [{ state: 'disconnected' }, 'no connected read'], [{ snapshotUnavailable: true }, 'host snapshot is unavailable'],
    [{ needsPairing: true, lastError: '403 Forbidden PRIVATE_DENIAL' }, 'Access must be renewed'], [{ snapshot: snapshot({ sessionPaused: true }) }, 'Host sharing is paused'],
  ] as const)('withholds all private role/snapshot fields immediately on loss %j', async (extra, limitation) => {
    const view = render(<RemoteDispatcherDetails machineId="target" />); await loaded();
    act(() => setHost(extra));
    for (const id of ['settings', 'connections', 'actions', 'other-machines']) expect(screen.getByTestId(`details-card-${id}`)).toHaveTextContent(limitation);
    expect(screen.queryByText('HOST_MODEL')).not.toBeInTheDocument(); expect(screen.queryByTestId('other-machine-HOST_PRIVATE_PEER')).not.toBeInTheDocument();
    expect(view.container.innerHTML).not.toContain('PRIVATE_DENIAL');
    expect(screen.getByTestId('details-card-connections')).toHaveTextContent('published controller-connection observation');
  });

  it.each(['forbidden', 'error', 'offline', 'rate_limited'] as const)('keeps role %s distinct from empty cards and never revives snapshot peers as a fallback', async (status) => {
    api.mockResolvedValue({ status, retryAfterMs: 1000 });
    render(<RemoteDispatcherDetails machineId="target" />);
    await screen.findByRole('button', { name: 'Refresh Dispatcher details' });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 190)); });
    expect(api).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('HOST_MODEL')).not.toBeInTheDocument(); expect(screen.queryByTestId('other-machine-HOST_PRIVATE_PEER')).not.toBeInTheDocument();
    expect(screen.queryByTestId('other-machines-empty')).not.toBeInTheDocument();
    expect(screen.getByTestId('details-card-settings-summary')).toHaveTextContent('unavailable');
  });

  it('shows only positive-receipt snapshot fields when an older host lacks the role read, and withholds them without that receipt', async () => {
    api.mockResolvedValue({ status: 'unavailable' });
    setHost({ snapshot: snapshot({ dispatcher: { enabled: false, agent: null } }) });
    render(<RemoteDispatcherDetails machineId="target" />);
    await screen.findByText('This host does not share this Dispatcher role read, or an existing role is unavailable.', { selector: 'p[role="status"]' });
    expect(screen.getByTestId('details-card-settings-summary')).toHaveTextContent('Turned off · host snapshot');
    expect(cards()).toHaveTextContent('The snapshot does not say whether a Dispatcher was previously created.');
    expect(screen.getByTestId('other-machine-HOST_PRIVATE_PEER')).toBeInTheDocument();
    expect(screen.queryByText('HOST_MODEL')).not.toBeInTheDocument(); expect(screen.getByTestId('details-card-connections-summary')).toHaveTextContent('unavailable');
    act(() => setHost({ snapshot: snapshot({ dispatcher: { enabled: false, agent: null } }), snapshotReceipt: undefined }));
    expect(screen.queryByTestId('other-machine-HOST_PRIVATE_PEER')).not.toBeInTheDocument();
    expect(screen.getByTestId('details-card-settings-summary')).toHaveTextContent('unavailable');
    act(() => setHost({ snapshot: snapshot({ sessionPaused: true }), snapshotReceipt: 'main-receipt-b' }));
    expect(screen.queryByTestId('other-machine-HOST_PRIVATE_PEER')).not.toBeInTheDocument();
  });

  it('does not show snapshot fields as a fallback for a forbidden role read, even with a positive receipt', async () => {
    api.mockResolvedValue({ status: 'forbidden' });
    render(<RemoteDispatcherDetails machineId="target" />);
    await screen.findByText('This host does not allow this desktop to read Dispatcher details.', { selector: 'p[role="status"]' });
    expect(screen.queryByTestId('other-machine-HOST_PRIVATE_PEER')).not.toBeInTheDocument();
    expect(screen.getByTestId('details-card-settings-summary')).toHaveTextContent('unavailable');
  });

  it('keeps retained clones hidden across denied read, remount and regrant until a fresh snapshot receipt arrives', async () => {
    let view = render(<RemoteDispatcherDetails machineId="target" />); await loaded();
    api.mockResolvedValue({ status: 'forbidden' });
    // The main denial path removes this receipt without changing cached snapshot contents.
    const clone = JSON.parse(JSON.stringify(snapshot()));
    act(() => setHost({ snapshot: clone, snapshotReceipt: undefined }));
    await screen.findByText('This host does not allow this desktop to read Dispatcher details.', { selector: 'p[role="status"]' });
    expect(screen.queryByTestId('other-machine-HOST_PRIVATE_PEER')).not.toBeInTheDocument();
    view.unmount(); view = render(<RemoteDispatcherDetails machineId="target" />);
    expect(screen.queryByTestId('other-machine-HOST_PRIVATE_PEER')).not.toBeInTheDocument();
    api.mockResolvedValue({ status: 'ok', value: role('role2', 'REGRANTED_MODEL') });
    act(() => setHost({ snapshot: JSON.parse(JSON.stringify(clone)), snapshotReceipt: undefined, connectionGeneration: 1 }));
    await screen.findByText('REGRANTED_MODEL');
    expect(screen.queryByTestId('other-machine-HOST_PRIVATE_PEER')).not.toBeInTheDocument();
    act(() => setHost({ connectionGeneration: 1, snapshotReceipt: 'fresh-snapshot', snapshot: snapshot({ dispatcherPresence: { remotes: [remote('FRESH_PEER')] } }) }));
    await screen.findByTestId('other-machine-FRESH_PEER');
    expect(screen.queryByTestId('other-machine-HOST_PRIVATE_PEER')).not.toBeInTheDocument();
  });

  it('does not infer snapshot provenance from fresh role metadata or a legacy missing connection generation', async () => {
    setHost({ snapshotReceipt: undefined });
    const view = render(<RemoteDispatcherDetails machineId="target" />); await loaded();
    expect(screen.queryByTestId('other-machine-HOST_PRIVATE_PEER')).not.toBeInTheDocument();
    expect(screen.getByTestId('details-card-other-machines')).toHaveTextContent('Waiting for a confirmed host snapshot');
    view.unmount(); api.mockClear(); setHost({ connectionGeneration: undefined });
    render(<RemoteDispatcherDetails machineId="target" />);
    expect(screen.getByTestId('remote-dispatcher-role-status')).toHaveTextContent('cannot attest its current generation');
    expect(api).not.toHaveBeenCalled();
  });

  it('does not reuse copied fields marked omitted in an admitted snapshot', async () => {
    setHost({ snapshot: snapshot({ snapshotTruncated: { version: 1, reason: 'frame_limit', omitted: ['dispatcher', 'dispatcherPresence'] } }) });
    render(<RemoteDispatcherDetails machineId="target" />); await loaded();
    expect(screen.getByTestId('details-card-settings')).toHaveTextContent('settings were omitted');
    expect(screen.getByTestId('details-card-other-machines')).toHaveTextContent('Other machines were omitted');
    expect(screen.queryByTestId('other-machine-HOST_PRIVATE_PEER')).not.toBeInTheDocument();
  });

  it('binds selection despite colliding raw role ids and ignores a late prior-host response', async () => {
    let finish!: (value: unknown) => void;
    api.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; })).mockResolvedValue({ status: 'ok', value: role('role1', 'OTHER_HOST_MODEL') });
    const view = render(<RemoteDispatcherDetails machineId="target" />);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 190)); });
    act(() => useAnnexClientStore.setState({ satellites: [satellite(), satellite({ id: 'other', fingerprint: 'OTHER', alias: 'Other host', snapshotReceipt: 'other-snapshot', snapshot: snapshot({ dispatcherPresence: { remotes: [remote('OTHER_PEER')] } }) })] }));
    view.rerender(<RemoteDispatcherDetails machineId="other" />); await screen.findByText('OTHER_HOST_MODEL');
    await act(async () => { finish({ status: 'ok', value: role('role1', 'STALE_HOST_MODEL') }); });
    expect(api).toHaveBeenLastCalledWith('other'); expect(screen.queryByText('STALE_HOST_MODEL')).not.toBeInTheDocument();
    expect(screen.queryByTestId('other-machine-HOST_PRIVATE_PEER')).not.toBeInTheDocument(); expect(screen.getByTestId('other-machine-OTHER_PEER')).toBeInTheDocument();
  });

  it('withholds the prior generation immediately and ignores its late reply after a batched reconnect', async () => {
    let finish!: (value: unknown) => void;
    api.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; })).mockResolvedValue({ status: 'ok', value: role('role2', 'CURRENT_MODEL') });
    render(<RemoteDispatcherDetails machineId="target" />);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 190)); });
    act(() => setHost({ connectionGeneration: 1, snapshotReceipt: undefined }));
    await screen.findByText('CURRENT_MODEL');
    await act(async () => { finish({ status: 'ok', value: role('role1', 'EXPIRED_MODEL') }); });
    expect(screen.queryByText('EXPIRED_MODEL')).not.toBeInTheDocument();
    expect(screen.queryByTestId('other-machine-HOST_PRIVATE_PEER')).not.toBeInTheDocument();
    expect(api).toHaveBeenCalledTimes(2);
  });

  it('invalidates role metadata on the selected host role event and ignores other hosts', async () => {
    let event!: (value: { satelliteId: string; type: string; payload: unknown }) => void;
    const unsubscribe = vi.fn();
    vi.spyOn(window.clubhouse.annexClient, 'onSatelliteEvent').mockImplementation((callback) => { event = callback; return unsubscribe; });
    const view = render(<RemoteDispatcherDetails machineId="target" />); await loaded();
    act(() => event({ satelliteId: 'other-host', type: 'dispatcher:changed', payload: {} }));
    expect(screen.getByText('HOST_MODEL')).toBeInTheDocument(); expect(api).toHaveBeenCalledTimes(1);
    api.mockResolvedValue({ status: 'unavailable' });
    act(() => event({ satelliteId: 'sat', type: 'dispatcher:changed', payload: { agentId: 'UNTRUSTED_EVENT_ID' } }));
    expect(screen.queryByText('HOST_MODEL')).not.toBeInTheDocument();
    await screen.findByText('This host does not share this Dispatcher role read, or an existing role is unavailable.', { selector: 'p[role="status"]' });
    expect(api).toHaveBeenLastCalledWith('target');
    expect(view.container.innerHTML).not.toContain('UNTRUSTED_EVENT_ID');
    view.unmount(); expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('pages role Connections by source with the overview role agent and resets on a role event', async () => {
    let event!: (value: { satelliteId: string; type: string; payload: unknown }) => void;
    vi.spyOn(window.clubhouse.annexClient, 'onSatelliteEvent').mockImplementation((callback) => { event = callback; return vi.fn(); });
    const overview = role(); Object.assign(overview.details, { connectionPages: 1, connectionPageSources: ['outgoing', 'incoming'] });
    const page = (offset: number, agentId = 'role1'): SelectedDispatcherDetails => ({ version: 1, role: 'dispatcher', agentId, details: { ...role(agentId).details, connectionPageEnvelope: 1, connectionPageOnly: true, connectionPages: 1,
      cards: role(agentId).details.cards.map((c) => c.id === 'connections' ? { ...c, rows: [{ label: `Incoming row ${offset}`, value: 'HOST_PAGE' }], connectionPage: { source: 'incoming', offset, projectOffset: 0, next: offset === 0 ? { offset: 25, projectOffset: 0 } : null, known: 1, complete: true } } : { ...c, requested: false }) } });
    let pageAgent = 'role1';
    api.mockImplementation(async (_machine: string, query?: { offset?: number }) => query ? { status: 'ok', value: page(query.offset ?? 0, pageAgent) } : { status: 'ok', value: overview });
    render(<RemoteDispatcherDetails machineId="target" />); await loaded();
    const connections = within(screen.getByTestId('details-card-connections'));
    act(() => connections.getByRole('button', { name: 'Incoming connections' }).click());
    await connections.findByText('Incoming row 0');
    expect(api).toHaveBeenLastCalledWith('target', { card: 'connections', source: 'incoming', offset: 0, projectOffset: 0 }, 'role1');
    act(() => connections.getByRole('button', { name: 'Next' }).click());
    await connections.findByText('Incoming row 25');
    expect(api).toHaveBeenLastCalledWith('target', { card: 'connections', source: 'incoming', offset: 25, projectOffset: 0 }, 'role1');
    act(() => connections.getByRole('button', { name: 'Previous' }).click());
    await connections.findByText('Incoming row 0');
    // A page claiming another role agent is never shown as this Dispatcher's page.
    pageAgent = 'role2';
    act(() => connections.getByRole('button', { name: 'Next' }).click());
    await connections.findByText('The host did not return the selected source page for this Dispatcher.');
    expect(connections.queryByText('Incoming row 25')).not.toBeInTheDocument();
    // A role event changes the role context: navigation returns to the overview.
    pageAgent = 'role1';
    act(() => event({ satelliteId: 'sat', type: 'dispatcher:changed', payload: {} }));
    await waitFor(() => expect(connections.getByRole('button', { name: 'Overview' })).toHaveAttribute('aria-pressed', 'true'));
    expect(connections.queryByText('Incoming row 0')).not.toBeInTheDocument();
  });

  it('shows the Connections summary only for an older host without role pages', async () => {
    render(<RemoteDispatcherDetails machineId="target" />); await loaded();
    const connections = within(screen.getByTestId('details-card-connections'));
    expect(connections.queryByRole('button', { name: 'Incoming connections' })).not.toBeInTheDocument();
    expect(connections.getByText('This host shares the Dispatcher Connections summary only. Source pages need a host update.')).toBeInTheDocument();
    expect(api).toHaveBeenCalledExactlyOnceWith('target');
  });

  it('pages role Actions relationships with the overview role agent, carries the selection and resets on a role event (#14)', async () => {
    let event!: (value: { satelliteId: string; type: string; payload: unknown }) => void;
    vi.spyOn(window.clubhouse.annexClient, 'onSatelliteEvent').mockImplementation((callback) => { event = callback; return vi.fn(); });
    const selection = 'a'.repeat(64), overview = role(); Object.assign(overview.details, { inventoryPages: 1, inventorySources: ['selected-action-relationships'] });
    const page = (offset: number, agentId = 'role1'): SelectedDispatcherDetails => ({ version: 1, role: 'dispatcher', agentId, details: { ...role(agentId).details, settings: null, inventoryPages: 1, inventorySources: ['selected-action-relationships'], inventoryPageOnly: true,
      cards: role(agentId).details.cards.map((c) => ({ ...c, rows: [], summary: '', ...(c.id !== 'actions' && { requested: false as const }) })),
      inventoryPage: { version: 1, source: 'selected-action-relationships', state: 'recorded', offset, selection, next: offset === 0 ? 25 : null, totalRelationships: 30, uniqueActions: 30, observedAt: 1, notes: [],
        rows: Array.from({ length: offset === 0 ? 25 : 5 }, (_, i) => ({ key: (offset + i).toString(16).padStart(64, '0'), name: `Dispatcher Action ${offset + i}`, group: 'dispatcher' as const, enabled: false, description: 'Once → Message Dispatcher' })) } } });
    let pageAgent = 'role1';
    api.mockImplementation(async (_machine: string, query?: { offset?: number }) => query ? { status: 'ok', value: page(query.offset ?? 0, pageAgent) } : { status: 'ok', value: overview });
    render(<RemoteDispatcherDetails machineId="target" />); await loaded();
    const actions = within(screen.getByTestId('details-card-actions'));
    expect(actions.queryByText(/Actions summary only/)).not.toBeInTheDocument();
    act(() => actions.getByRole('button', { name: 'Browse recorded Actions' }).click());
    await actions.findByText('Dispatcher Action 0');
    expect(actions.getByText('Made by the Dispatcher')).toBeInTheDocument();
    expect(api).toHaveBeenLastCalledWith('target', { card: 'actions', source: 'selected-action-relationships', offset: 0 }, 'role1');
    act(() => actions.getByRole('button', { name: 'Next Actions' }).click());
    await actions.findByText('Dispatcher Action 25');
    expect(api).toHaveBeenLastCalledWith('target', { card: 'actions', source: 'selected-action-relationships', offset: 25, selection }, 'role1');
    act(() => actions.getByRole('button', { name: 'Previous Actions' }).click());
    await actions.findByText('Dispatcher Action 0');
    expect(api).toHaveBeenLastCalledWith('target', { card: 'actions', source: 'selected-action-relationships', offset: 0, selection }, 'role1');
    // A page claiming another role agent is never shown as this Dispatcher's page.
    pageAgent = 'role2';
    act(() => actions.getByRole('button', { name: 'Next Actions' }).click());
    await actions.findByText('Couldn’t read this Actions page. Refresh to try again.');
    expect(actions.queryByText('Dispatcher Action 25')).not.toBeInTheDocument();
    // A role event changes the role context: navigation returns to the overview.
    pageAgent = 'role1';
    act(() => event({ satelliteId: 'sat', type: 'dispatcher:changed', payload: {} }));
    await waitFor(() => expect(actions.getByRole('button', { name: 'Overview' })).toHaveAttribute('aria-pressed', 'true'));
    expect(actions.queryByText(/Dispatcher Action \d/)).not.toBeInTheDocument();
  });

  it('shows the Actions summary only for an older host without role inventory pages', async () => {
    render(<RemoteDispatcherDetails machineId="target" />); await loaded();
    const actions = within(screen.getByTestId('details-card-actions'));
    expect(actions.queryByRole('button', { name: 'Browse recorded Actions' })).not.toBeInTheDocument();
    expect(actions.getByText('This host shares the Dispatcher Actions summary only. Relationship pages need a host update.')).toBeInTheDocument();
    expect(api).toHaveBeenCalledExactlyOnceWith('target');
  });

  it('cancels a deferred read on unmount and does not poll without events', async () => {
    vi.useFakeTimers();
    try {
      let view = render(<RemoteDispatcherDetails machineId="target" />); view.unmount();
      await act(async () => { await vi.advanceTimersByTimeAsync(300); });
      expect(api).not.toHaveBeenCalled();
      view = render(<RemoteDispatcherDetails machineId="target" />);
      await act(async () => { await vi.advanceTimersByTimeAsync(160); });
      expect(screen.getByText('HOST_MODEL')).toBeInTheDocument();
      await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
      expect(api).toHaveBeenCalledTimes(1); view.unmount();
    } finally { vi.useRealTimers(); }
  });

  it.each(['inventoryPageOnly', 'helperPageOnly', 'connectionPageOnly'] as const)('rejects malformed partial-envelope injection %s at the renderer boundary', async (flag) => {
    const value = role(); Object.assign(value.details, { [flag]: true }); api.mockResolvedValue({ status: 'ok', value });
    render(<RemoteDispatcherDetails machineId="target" />);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 190)); });
    expect(screen.queryByText('HOST_MODEL')).not.toBeInTheDocument(); expect(screen.queryByTestId('other-machine-HOST_PRIVATE_PEER')).not.toBeInTheDocument();
    expect(screen.getByTestId('remote-dispatcher-role-status')).toHaveTextContent('Couldn’t read current Dispatcher details');
  });
});
