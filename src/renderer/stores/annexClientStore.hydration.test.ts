import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent, SatelliteSnapshot } from '../../shared/types';
import { initAnnexClientListener, useAnnexClientStore, type SatelliteConnection } from './annexClientStore';
import { useRemoteProjectStore, namespacedAgentId, namespacedProjectId } from './remoteProjectStore';
import { usePendingPermissionStore } from './pendingPermissionStore';

const satellite: SatelliteConnection = {
  id: 'synthetic', fingerprint: 'synthetic', alias: 'Synthetic', icon: '', color: '',
  state: 'connected', host: 'synthetic.invalid', mainPort: 1, pairingPort: 2,
  snapshot: null, lastError: null,
};
const permission = {
  requestId: 'request', agentId: 'agent', toolName: 'Bash', createdAt: 1, timeoutMs: 1000,
};
function snapshot(overrides: Partial<SatelliteSnapshot> = {}): SatelliteSnapshot {
  return {
    projects: [{ id: 'project', name: 'Synthetic project', path: '/synthetic' }],
    agents: { project: [{ id: 'agent', projectId: 'project', name: 'Synthetic agent', kind: 'durable', status: 'running', color: '' } as Agent] },
    quickAgents: {}, theme: {}, orchestrators: {}, pendingPermissions: [permission], lastSeq: 42,
    ...overrides,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const agentId = namespacedAgentId(satellite.id, 'agent');
const projectId = namespacedProjectId(satellite.id, 'project');
const requestId = namespacedAgentId(satellite.id, 'request');

// Use real projection stores: a connected Settings record is not a populated catalog.
describe('satellite catalog reconciliation (#3695)', () => {
  let changed: (satellites: SatelliteConnection[]) => void;
  let receive: (event: { satelliteId: string; type: string; payload: unknown }) => void;
  let read: ReturnType<typeof vi.fn<() => Promise<SatelliteConnection[]>>>;
  let cleanups: Array<() => void>;
  const catalog = () => useRemoteProjectStore.getState();
  const send = (type: string, payload: unknown) => receive({ satelliteId: satellite.id, type, payload });
  const list = (value: SatelliteSnapshot | null, state: SatelliteConnection['state'] = 'connected') => [{ ...satellite, state, snapshot: value }];
  const tick = async () => { await Promise.resolve(); await Promise.resolve(); };
  const start = () => { const off = initAnnexClientListener(); cleanups.push(off); return off; };

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
    useRemoteProjectStore.setState({ satelliteProjects: {}, remoteAgents: {}, remoteAgentDetailedStatus: {}, remoteProjectIcons: {}, remoteAgentIcons: {}, remoteCanvasState: {}, remoteAppCanvasState: {}, pluginMatchState: {} });
    usePendingPermissionStore.setState({ byRequestId: {} });
  });
  afterEach(() => { for (const off of cleanups) off(); });

  it('subscribes before reading and hydrates an initial cached snapshot without another event', async () => {
    read.mockImplementationOnce(async () => {
      expect(window.clubhouse.annexClient.onSatelliteEvent).toHaveBeenCalled();
      expect(window.clubhouse.annexClient.onSatellitesChanged).toHaveBeenCalled();
      return list(snapshot());
    });
    start();
    await tick();
    expect(read).toHaveBeenCalledTimes(1);
    expect(catalog().satelliteProjects[satellite.id][0].id).toBe(projectId);
    expect(catalog().remoteAgents[agentId].name).toBe('Synthetic agent');
    expect(usePendingPermissionStore.getState().byRequestId[requestId]).toBeDefined();
  });

  it('hydrates a connected list update after wake without a snapshot event', () => {
    start();
    changed(list(null, 'disconnected'));
    expect(catalog().satelliteProjects[satellite.id]).toBeUndefined();
    changed(list(snapshot()));
    expect(catalog().remoteAgents[agentId]).toBeDefined();
  });

  it('manual local reads hydrate and identical IPC clones preserve live agent, pause and permission updates', async () => {
    const cached = snapshot({ sessionPaused: true });
    read.mockResolvedValueOnce(list(cached));
    await useAnnexClientStore.getState().loadSatellites();
    start();
    send('pty:exit', { agentId: 'agent', exitCode: 0 });
    send('permission:response', { requestId: 'request' });
    send('session:resumed', {});
    const projects = catalog().satelliteProjects[satellite.id];
    const storedSnapshot = useAnnexClientStore.getState().satellites[0].snapshot;
    changed(structuredClone(list(cached)));
    expect(catalog().satelliteProjects[satellite.id]).toBe(projects);
    expect(useAnnexClientStore.getState().satellites[0].snapshot).toBe(storedSnapshot);
    expect(catalog().remoteAgents[agentId].status).toBe('sleeping');
    expect(usePendingPermissionStore.getState().byRequestId[requestId]).toBeUndefined();
    expect(useAnnexClientStore.getState().satellitePaused[satellite.id]).toBe(false);
  });

  it('applies changed same-seq canvas/icons and detects in-place mutation without mutating the input', () => {
    start();
    const cached = snapshot();
    changed(list(cached));
    cached.projectIcons = { project: 'data:image/png;base64,synthetic' };
    cached.canvasState = { project: { canvases: [{ id: 'canvas', views: [{ agentId: 'agent' }] }], activeCanvasId: 'canvas' } };
    changed(list(cached));
    expect(catalog().remoteProjectIcons[projectId]).toBe(cached.projectIcons.project);
    expect(catalog().remoteCanvasState[projectId].canvases).toMatchObject([{ views: [{ agentId }] }]);
    expect(cached.canvasState.project.canvases).toMatchObject([{ views: [{ agentId: 'agent' }] }]);
  });

  it.each(['snapshot', 'pty:exit', 'permission:response'])('rejects an initial read completing after a newer %s event', async (type) => {
    const pending = deferred<SatelliteConnection[]>();
    read.mockReturnValueOnce(pending.promise);
    start();
    changed(list(snapshot()));
    const pendingRefresh = deferred<SatelliteConnection[]>();
    read.mockReturnValueOnce(pendingRefresh.promise);
    const refresh = useAnnexClientStore.getState().loadSatellites();
    if (type === 'snapshot') send(type, snapshot({ projects: [], agents: {}, lastSeq: 43, pendingPermissions: [] }));
    if (type === 'pty:exit') send(type, { agentId: 'agent', exitCode: 0 });
    if (type === 'permission:response') send(type, { requestId: 'request' });
    pending.resolve(list(snapshot()));
    pendingRefresh.resolve(list(snapshot()));
    await refresh;
    await tick();
    if (type === 'snapshot') expect(catalog().satelliteProjects[satellite.id]).toEqual([]);
    if (type === 'pty:exit') expect(catalog().remoteAgents[agentId].status).toBe('sleeping');
    expect(usePendingPermissionStore.getState().byRequestId[requestId]).toBeUndefined();
  });

  it('keeps the newest overlapping read, and a failed read preserves the existing catalog', async () => {
    const first = deferred<SatelliteConnection[]>();
    read.mockReturnValueOnce(first.promise).mockResolvedValueOnce(list(snapshot({ lastSeq: 43, projects: [] })));
    const oldRead = useAnnexClientStore.getState().loadSatellites();
    await useAnnexClientStore.getState().loadSatellites();
    first.resolve(list(snapshot()));
    await oldRead;
    expect(catalog().satelliteProjects[satellite.id]).toEqual([]);
    read.mockRejectedValueOnce(new Error('synthetic read failure'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await useAnnexClientStore.getState().loadSatellites();
    expect(warn).toHaveBeenCalled();
    expect(useAnnexClientStore.getState().satellites[0].snapshot?.lastSeq).toBe(43);
    warn.mockRestore();
  });

  it('accepts a fresh lower sequence after reconnect without replaying the old cache at socket open', () => {
    start();
    const cached = snapshot({ sessionPaused: true });
    changed(list(cached));
    send('pty:exit', { agentId: 'agent' });
    changed(structuredClone(list(cached, 'disconnected')));
    expect(usePendingPermissionStore.getState().byRequestId[requestId]).toBeUndefined();
    expect(catalog().remoteAgents[agentId].status).toBe('sleeping');
    changed(structuredClone(list(cached)));
    expect(catalog().remoteAgents[agentId].status).toBe('sleeping');
    expect(usePendingPermissionStore.getState().byRequestId[requestId]).toBeUndefined();
    changed(list(snapshot({ lastSeq: 0, projects: [], agents: {}, pendingPermissions: [], sessionPaused: false })));
    send('snapshot', snapshot({ lastSeq: 0, projects: [], agents: {}, pendingPermissions: [] }));
    expect(catalog().satelliteProjects[satellite.id]).toEqual([]);
    expect(catalog().remoteAgents[agentId]).toBeUndefined();
    expect(useAnnexClientStore.getState().satellitePaused[satellite.id]).toBe(false);
  });

  it('an authoritative reconnect snapshot restores permissions even with identical contents', () => {
    start();
    const cached = snapshot();
    changed(list(cached));
    changed(list(cached, 'disconnected'));
    changed(structuredClone(list(cached)));
    expect(usePendingPermissionStore.getState().byRequestId[requestId]).toBeUndefined();
    send('snapshot', structuredClone(cached));
    expect(usePendingPermissionStore.getState().byRequestId[requestId]).toBeDefined();
  });

  it('does not hydrate disconnected or missing snapshots; forgetting removes only that host', () => {
    start();
    changed(list(snapshot(), 'disconnected'));
    expect(catalog().remoteAgents[agentId]).toBeUndefined();
    changed(list(null));
    expect(catalog().satelliteProjects[satellite.id]).toBeUndefined();
    changed([...list(snapshot()), { ...satellite, id: 'other', snapshot: snapshot() }]);
    changed([{ ...satellite, id: 'other', snapshot: snapshot() }]);
    send('snapshot', snapshot());
    expect(catalog().satelliteProjects[satellite.id]).toBeUndefined();
    expect(catalog().remoteAgents[agentId]).toBeUndefined();
    expect(catalog().satelliteProjects.other).toHaveLength(1);
    expect(usePendingPermissionStore.getState().byRequestId[requestId]).toBeUndefined();
  });

  it('old listener callbacks and reads cannot restore removed state across cleanup/reinitialization', async () => {
    const pending = deferred<SatelliteConnection[]>();
    read.mockReturnValueOnce(pending.promise);
    const off = start();
    changed(list(snapshot()));
    const oldChanged = changed;
    const oldReceive = receive;
    off();
    read.mockResolvedValueOnce([]);
    start();
    await tick();
    oldChanged(list(snapshot()));
    oldReceive({ satelliteId: satellite.id, type: 'snapshot', payload: snapshot() });
    pending.resolve(list(snapshot()));
    await tick();
    expect(useAnnexClientStore.getState().satellites).toEqual([]);
    expect(catalog().satelliteProjects[satellite.id]).toBeUndefined();
    expect(usePendingPermissionStore.getState().byRequestId[requestId]).toBeUndefined();
  });
  it('hydrates when exit and settlement cross the first read with no later list, preserving both newer updates', async () => {
    const pending = deferred<SatelliteConnection[]>();
    read.mockReturnValueOnce(pending.promise);
    start();
    send('pty:exit', { agentId: 'agent', exitCode: 0, data: 'must not retain output' });
    send('permission:response', { requestId: 'request' });
    pending.resolve(list(snapshot()));
    await tick();
    expect(catalog().satelliteProjects[satellite.id]).toHaveLength(1);
    expect(catalog().remoteAgents[agentId].status).toBe('sleeping');
    expect(usePendingPermissionStore.getState().byRequestId[requestId]).toBeUndefined();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('preserves validated permission requests, ordered settlement and status/pause operations before the first catalog', async () => {
    const pending = deferred<SatelliteConnection[]>();
    read.mockReturnValueOnce(pending.promise);
    start();
    send('permission:request', { ...permission, requestId: 'new', toolInput: { command: 'synthetic' } });
    send('permission:response', { requestId: 'request' });
    send('agent:status', { agentId: 'agent', status: 'sleeping', detailedStatus: { state: 'idle', message: 'Synthetic', timestamp: 2 } });
    send('session:paused', {});
    pending.resolve(list(snapshot()));
    await tick();
    expect(catalog().remoteAgents[agentId].status).toBe('sleeping');
    expect(catalog().remoteAgentDetailedStatus[agentId]).toMatchObject({ state: 'idle', timestamp: 2 });
    expect(usePendingPermissionStore.getState().byRequestId[requestId]).toBeUndefined();
    expect(usePendingPermissionStore.getState().byRequestId[namespacedAgentId(satellite.id, 'new')]).toMatchObject({ toolInput: { command: 'synthetic' } });
    expect(useAnnexClientStore.getState().satellitePaused[satellite.id]).toBe(true);
  });

  it('a later authoritative snapshot supersedes the journal, including same-seq changes', async () => {
    const pending = deferred<SatelliteConnection[]>();
    read.mockReturnValueOnce(pending.promise);
    useAnnexClientStore.setState({ satellites: list(null) });
    start();
    send('pty:exit', { agentId: 'agent' });
    send('permission:response', { requestId: 'request' });
    send('snapshot', snapshot({ projectIcons: { project: 'new-icon' } }));
    pending.resolve(list(snapshot()));
    await tick();
    expect(catalog().remoteAgents[agentId].status).toBe('running');
    expect(catalog().remoteProjectIcons[projectId]).toBe('new-icon');
    expect(usePendingPermissionStore.getState().byRequestId[requestId]).toBeDefined();
  });

  it('a list received during the first read seeds then replays, and a following snapshot supersedes the replay', async () => {
    const pending = deferred<SatelliteConnection[]>();
    read.mockReturnValueOnce(pending.promise);
    start();
    send('pty:exit', { agentId: 'agent' });
    changed(list(snapshot()));
    expect(catalog().remoteAgents[agentId].status).toBe('sleeping');
    send('snapshot', snapshot());
    pending.resolve(list(snapshot({ projects: [] })));
    await tick();
    expect(catalog().remoteAgents[agentId].status).toBe('running');
    expect(catalog().satelliteProjects[satellite.id]).toHaveLength(1);
  });

  it('uses at most one extra read for a snapshot preceding metadata, retaining later incremental operations', async () => {
    const first = deferred<SatelliteConnection[]>();
    const second = deferred<SatelliteConnection[]>();
    read.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    start();
    send('snapshot', snapshot({ lastSeq: 0 }));
    first.resolve(list(snapshot()));
    await tick();
    expect(read).toHaveBeenCalledTimes(2);
    send('pty:exit', { agentId: 'agent' });
    second.resolve(list(snapshot({ lastSeq: 0 })));
    await tick();
    expect(catalog().remoteAgents[agentId].status).toBe('sleeping');
    expect(useAnnexClientStore.getState().satellites[0].snapshot?.lastSeq).toBe(0);
  });

  it('defers after sustained snapshot invalidations without looping, then recovers on a live snapshot', async () => {
    const first = deferred<SatelliteConnection[]>();
    const second = deferred<SatelliteConnection[]>();
    read.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    start();
    send('snapshot', snapshot({ lastSeq: 1 }));
    first.resolve(list(snapshot()));
    await tick();
    send('snapshot', snapshot({ lastSeq: 2 }));
    second.resolve(list(snapshot({ lastSeq: 1 })));
    await tick();
    expect(read).toHaveBeenCalledTimes(2);
    expect(catalog().satelliteProjects[satellite.id]).toBeUndefined();
    expect(useAnnexClientStore.getState().satellites[0].catalogIncomplete).toBe(true);
    changed(list(snapshot({ lastSeq: 2 })));
    expect(catalog().satelliteProjects[satellite.id]).toBeUndefined();
    send('snapshot', snapshot({ lastSeq: 2 }));
    expect(catalog().satelliteProjects[satellite.id]).toHaveLength(1);
    expect(useAnnexClientStore.getState().satellites[0].catalogIncomplete).toBe(false);
  });

  it.each(['entries', 'payload', 'unsupported'])('defers %s overflow without replaying stale permissions and recovers only from a live snapshot', async (limit) => {
    const pending = deferred<SatelliteConnection[]>();
    read.mockReturnValueOnce(pending.promise);
    start();
    if (limit === 'entries') for (let i = 0; i < 33; i++) send('pty:exit', { agentId: 'agent' });
    if (limit === 'payload') send('permission:request', { ...permission, toolInput: { command: 'x'.repeat(2048) } });
    if (limit === 'unsupported') send('agent:spawned', { agentId: 'new-agent', projectId: 'project', name: 'Synthetic' });
    pending.resolve(list(snapshot()));
    await tick();
    expect(useAnnexClientStore.getState().satellites[0].catalogIncomplete).toBe(true);
    expect(catalog().satelliteProjects[satellite.id]).toBeUndefined();
    expect(usePendingPermissionStore.getState().byRequestId[requestId]).toBeUndefined();
    changed(list(snapshot({ lastSeq: 43 })));
    expect(catalog().satelliteProjects[satellite.id]).toBeUndefined();
    send('snapshot', snapshot({ lastSeq: 43, pendingPermissions: [] }));
    expect(useAnnexClientStore.getState().satellites[0].catalogIncomplete).toBe(false);
    expect(catalog().satelliteProjects[satellite.id]).toHaveLength(1);
  });

  it('caps hosts and ignores PTY/chat payloads while waiting for the first catalog', async () => {
    const pending = deferred<SatelliteConnection[]>();
    read.mockReturnValueOnce(pending.promise);
    start();
    for (let i = 0; i < 100; i++) {
      send('pty:data', { agentId: 'agent', data: 'x'.repeat(4096) });
      send('chat:event', { agentId: 'agent', event: { body: 'x'.repeat(4096) } });
    }
    for (let i = 0; i < 9; i++) receive({ satelliteId: `host-${i}`, type: 'pty:exit', payload: { agentId: 'agent' } });
    pending.resolve(Array.from({ length: 9 }, (_, i) => ({ ...satellite, id: `host-${i}`, snapshot: snapshot() })));
    await tick();
    expect(read).toHaveBeenCalledTimes(1);
    expect(useAnnexClientStore.getState().satellites.every((sat) => sat.catalogIncomplete)).toBe(true);
    expect(catalog().satelliteProjects).toEqual({});
  });

  it('cleanup cancels the bounded retry and drops journal operations', async () => {
    const first = deferred<SatelliteConnection[]>();
    const second = deferred<SatelliteConnection[]>();
    read.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const off = start();
    send('snapshot', snapshot());
    first.resolve(list(snapshot()));
    await tick();
    expect(read).toHaveBeenCalledTimes(2);
    send('pty:exit', { agentId: 'agent' });
    off();
    second.resolve(list(snapshot()));
    await tick();
    expect(useAnnexClientStore.getState().satellites).toEqual([]);
    expect(catalog().satelliteProjects).toEqual({});
  });

  it('coalesces a concurrent Settings load with startup instead of losing its overlay', async () => {
    const pending = deferred<SatelliteConnection[]>();
    read.mockReturnValueOnce(pending.promise);
    start();
    send('pty:exit', { agentId: 'agent' });
    const settingsRead = useAnnexClientStore.getState().loadSatellites();
    pending.resolve(list(snapshot()));
    await settingsRead;
    expect(read).toHaveBeenCalledTimes(1);
    expect(catalog().remoteAgents[agentId].status).toBe('sleeping');
  });

  it('clears the journal on disconnect/removal and waits for a fresh reconnect snapshot when only the old cache exists', async () => {
    const pending = deferred<SatelliteConnection[]>();
    const cached = snapshot();
    read.mockReturnValueOnce(pending.promise);
    start();
    send('pty:exit', { agentId: 'agent' });
    changed(list(cached, 'disconnected'));
    changed(structuredClone(list(cached)));
    expect(catalog().satelliteProjects[satellite.id]).toBeUndefined();
    expect(useAnnexClientStore.getState().satellites[0].catalogIncomplete).toBe(true);
    send('snapshot', cached);
    expect(catalog().remoteAgents[agentId].status).toBe('running');
    changed([]);
    pending.resolve(list(cached));
    await tick();
    expect(catalog().satelliteProjects[satellite.id]).toBeUndefined();
    expect(useAnnexClientStore.getState().satellites).toEqual([]);
  });

  it('caps aggregate retained size across hosts', async () => {
    const pending = deferred<SatelliteConnection[]>();
    read.mockReturnValueOnce(pending.promise);
    start();
    for (let host = 0; host < 8; host++) for (let operation = 0; operation < 24; operation++) {
      receive({ satelliteId: `host-${host}`, type: 'permission:request', payload: { ...permission, requestId: `request-${operation}`, message: 'x'.repeat(500) } });
    }
    pending.resolve(Array.from({ length: 8 }, (_, host) => ({ ...satellite, id: `host-${host}`, snapshot: snapshot() })));
    await tick();
    expect(useAnnexClientStore.getState().satellites.some((sat) => sat.catalogIncomplete)).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('does not clear deferred acceptance on cleanup/reinit; a fresh snapshot clears it', async () => {
    const pending = deferred<SatelliteConnection[]>();
    read.mockReturnValueOnce(pending.promise);
    const off = start();
    send('canvas:state', {});
    pending.resolve(list(snapshot()));
    await tick();
    expect(useAnnexClientStore.getState().satellites[0].catalogIncomplete).toBe(true);
    off();
    read.mockResolvedValueOnce(list(snapshot()));
    start();
    await tick();
    expect(catalog().satelliteProjects[satellite.id]).toBeUndefined();
    expect(useAnnexClientStore.getState().satellites[0].catalogIncomplete).toBe(true);
    send('snapshot', snapshot({ projects: [], agents: {}, pendingPermissions: [] }));
    expect(catalog().satelliteProjects[satellite.id]).toEqual([]);
    expect(useAnnexClientStore.getState().satellites[0].catalogIncomplete).toBe(false);
  });

  it('a live authoritative snapshot stays reconciled during host overflow and subsequent cloned lists', async () => {
    const pending = deferred<SatelliteConnection[]>();
    read.mockReturnValueOnce(pending.promise);
    start();
    for (let i = 0; i < 9; i++) receive({ satelliteId: `host-${i}`, type: 'pty:exit', payload: { agentId: 'agent' } });
    const satellites = Array.from({ length: 9 }, (_, i) => ({ ...satellite, id: `host-${i}`, snapshot: snapshot() }));
    changed(satellites);
    receive({ satelliteId: 'host-0', type: 'snapshot', payload: snapshot() });
    changed(structuredClone(satellites));
    expect(useAnnexClientStore.getState().satellites[0].catalogIncomplete).not.toBe(true);
    expect(catalog().satelliteProjects['host-0']).toHaveLength(1);
    pending.resolve(satellites);
    await tick();
  });

});
