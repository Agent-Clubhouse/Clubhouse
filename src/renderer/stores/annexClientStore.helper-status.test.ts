import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent, AgentStatus, SatelliteSnapshot } from '../../shared/types';
import { ANNEX_PROTOCOL_VERSION } from '../../shared/types';
import { agentDot } from '../features/agents/agent-status';
import { initAnnexClientListener, useAnnexClientStore, type SatelliteConnection } from './annexClientStore';
import { namespacedAgentId, useRemoteProjectStore } from './remoteProjectStore';
import { usePendingPermissionStore } from './pendingPermissionStore';

const host = 'synthetic-host';
const helperIds = ['helper-one', 'helper-two', 'helper-three'];
const controlId = 'awake-idle';
function snapshot(helperStatus: AgentStatus, lastSeq = 1): SatelliteSnapshot {
  const agents: Agent[] = [...helperIds, controlId].map((id) => ({
    id, projectId: 'project', name: id, kind: 'durable', color: '',
    status: id === controlId ? 'running' : helperStatus,
    parentAgentId: 'parent',
  }));
  return {
    protocolVersion: ANNEX_PROTOCOL_VERSION,
    agentRunStateVersion: 1,
    projects: [{ id: 'project', name: 'Synthetic', path: '/synthetic' }],
    agents: { project: agents }, quickAgents: {}, theme: {}, orchestrators: {},
    pendingPermissions: [], lastSeq,
    agentsMeta: Object.fromEntries(agents.filter((a) => a.status === 'running').map((a) => [a.id, {
      executionMode: 'chat', detailedStatus: { state: 'idle', message: 'Idle', timestamp: 1 },
    }])),
  };
}
const satellite: SatelliteConnection = {
  id: host, fingerprint: host, alias: 'Synthetic', icon: '', color: '',
  state: 'connected', host: 'synthetic.invalid', mainPort: 1, pairingPort: 2,
  snapshot: null, lastError: null,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('Annex helper sleep and awake-idle state (#3784)', () => {
  let changed: (rows: SatelliteConnection[]) => void;
  let receive: (event: { satelliteId: string; type: string; payload: unknown }) => void;
  let read: ReturnType<typeof vi.fn<() => Promise<SatelliteConnection[]>>>;
  let cleanups: Array<() => void>;
  const list = (value: SatelliteSnapshot, state: SatelliteConnection['state'] = 'connected') => [{ ...satellite, state, snapshot: value }];
  const send = (type: string, payload: unknown) => receive({ satelliteId: host, type, payload });
  const start = () => { const cleanup = initAnnexClientListener(); cleanups.push(cleanup); return cleanup; };
  const tick = async () => { await Promise.resolve(); await Promise.resolve(); };
  const status = (id: string) => {
    const state = useRemoteProjectStore.getState(), nsId = namespacedAgentId(host, id);
    return { run: state.remoteAgents[nsId]?.status, dot: state.remoteAgents[nsId]
      && agentDot(state.remoteAgents[nsId], state.remoteAgentDetailedStatus[nsId]) };
  };
  const expectSleeping = () => {
    for (const id of helperIds) expect(status(id)).toEqual({ run: 'sleeping', dot: 'sleeping' });
    expect(status(controlId)).toEqual({ run: 'running', dot: 'idle' });
  };
  beforeEach(() => {
    cleanups = [];
    read = vi.fn(async () => [] as SatelliteConnection[]);
    Object.assign(window.clubhouse.annexClient, {
      getSatellites: read,
      onSatellitesChanged: vi.fn((cb) => { changed = cb; return vi.fn(); }),
      onDiscoveredChanged: vi.fn(() => vi.fn()),
      onSatelliteEvent: vi.fn((cb) => { receive = cb; return vi.fn(); }),
    });
    useAnnexClientStore.setState({ satellites: [], satellitePaused: {} });
    useRemoteProjectStore.setState({ satelliteProjects: {}, remoteAgents: {}, remoteAgentDetailedStatus: {}, remoteProjectIcons: {}, remoteAgentIcons: {}, remoteCanvasState: {}, remoteAppCanvasState: {}, remoteGroupProjects: {}, pluginMatchState: {} });
    usePendingPermissionStore.setState({ byRequestId: {} });
  });
  afterEach(() => { for (const cleanup of cleanups) cleanup(); });

  it('distinguishes sleeping helpers from an awake-idle helper on the initial read', async () => {
    read.mockResolvedValueOnce(list(snapshot('sleeping')));
    start(); await tick();
    expectSleeping();
  });

  it('takes sleeping run states from a fresh host snapshot in an already-open view', () => {
    start(); changed(list(snapshot('running', 1)));
    send('snapshot', snapshot('sleeping', 2));
    expectSleeping();
  });

  it('takes the first fresh reconnect snapshot even when the old catalog said running', () => {
    start(); changed(list(snapshot('running', 20)));
    changed(list(snapshot('running', 20), 'disconnected'));
    changed(list(snapshot('running', 20)));
    send('snapshot', snapshot('sleeping', 0)); // Main admits the replacement stream's first snapshot.
    expectSleeping();
  });

  it.each(['pty:exit', 'agent:status'])('applies a live %s sleep transition without changing the awake-idle control', (type) => {
    start(); changed(list(snapshot('running')));
    for (const agentId of helperIds) send(type, type === 'pty:exit'
      ? { agentId, exitCode: 0 } : { agentId, status: 'sleeping', detailedStatus: null });
    expectSleeping();
    send('snapshot', snapshot('sleeping', 2));
    expectSleeping();
  });

  it('replays a newer wake over an initial cached sleeping snapshot', async () => {
    const pending = deferred<SatelliteConnection[]>();
    read.mockReturnValueOnce(pending.promise);
    start();
    send('agent:woken', { agentId: helperIds[0] });
    pending.resolve(list(snapshot('sleeping')));
    await tick();
    expect(status(helperIds[0]).run).toBe('running');
    expect(status(helperIds[1]).run).toBe('sleeping');
    expect(status(controlId)).toEqual({ run: 'running', dot: 'idle' });
  });

  it('does not turn transport disconnection into helper sleep', () => {
    start(); changed(list(snapshot('running')));
    changed(list(snapshot('running'), 'disconnected'));
    send('snapshot', snapshot('sleeping', 2)); // A retired/disconnected view cannot accept a live snapshot.
    expect(status(helperIds[0]).run).toBe('running');
    expect(useAnnexClientStore.getState().satellites[0].state).toBe('disconnected');
  });

  it.each([
    ['absent', undefined], ['unknown', 2], ['string', '1'], ['null', null],
    ['boolean', true], ['NaN', NaN], ['infinite', Infinity],
  ])('keeps legacy wake protection for a %s declaration', (_label, marker) => {
    start(); changed(list(snapshot('running')));
    const old = snapshot('sleeping', 2);
    delete old.agentRunStateVersion;
    if (marker !== undefined) Object.defineProperty(old, 'agentRunStateVersion', { value: marker, enumerable: true });
    send('snapshot', old);
    expect(status(helperIds[0]).run).toBe('running');
    expect(status(controlId)).toEqual({ run: 'running', dot: 'idle' });
  });

  it('requires an own numeric declaration even at the direct projection boundary', () => {
    const store = useRemoteProjectStore.getState();
    store.applySatelliteSnapshot(host, 'Synthetic', snapshot('running'));
    const inherited = snapshot('sleeping', 2);
    delete inherited.agentRunStateVersion;
    Object.setPrototypeOf(inherited, { agentRunStateVersion: 1 });
    store.applySatelliteSnapshot(host, 'Synthetic', inherited);
    expect(status(helperIds[0]).run).toBe('running');
  });

  it('judges every frame independently instead of remembering that a host was marked', () => {
    start(); changed(list(snapshot('running')));
    const unmarked = snapshot('sleeping', 2);
    delete unmarked.agentRunStateVersion;
    send('snapshot', unmarked);
    expect(status(helperIds[0]).run).toBe('running');
    send('snapshot', snapshot('sleeping', 3));
    expectSleeping();
  });

  it('keeps legacy wake protection on an unmarked first reconnect snapshot', () => {
    start(); changed(list(snapshot('running', 20)));
    changed(list(snapshot('running', 20), 'disconnected'));
    changed(list(snapshot('running', 20)));
    const unmarked = snapshot('sleeping', 0);
    delete unmarked.agentRunStateVersion;
    send('snapshot', unmarked);
    expect(status(helperIds[0]).run).toBe('running');
    send('snapshot', snapshot('sleeping', 1));
    expectSleeping();
  });

  it('retains the declaration through the real truncated-frame projection', () => {
    start(); changed(list(snapshot('running')));
    send('snapshot', { ...snapshot('sleeping', 2), snapshotTruncated: {
      version: 1, reason: 'frame_limit', omitted: ['canvasState', 'appCanvasState', 'agentIcons'],
    } });
    expectSleeping();
  });

  it('handles a beta.12-style build captured before a wake and completed after it', async () => {
    const olderBuild = deferred<SatelliteSnapshot>();
    const captured = snapshot('sleeping', 0);
    delete captured.agentRunStateVersion;
    start(); changed(list(snapshot('sleeping', 0)));
    const completion = olderBuild.promise.then((payload) => send('snapshot', payload));
    send('agent:woken', { agentId: helperIds[0] });
    olderBuild.resolve({ ...captured, lastSeq: 2 });
    await completion;
    expect(status(helperIds[0]).run).toBe('running');
    send('snapshot', snapshot('sleeping', 3));
    expectSleeping();
  });
});
