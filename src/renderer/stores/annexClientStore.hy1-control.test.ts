import { describe, expect, it, vi } from 'vitest';
import { initAnnexClientListener, useAnnexClientStore, type SatelliteConnection } from './annexClientStore';
import { namespacedAgentId, useRemoteProjectStore } from './remoteProjectStore';
import { usePendingPermissionStore } from './pendingPermissionStore';
import type { Agent, SatelliteSnapshot } from '../../shared/types';

// Historical ae565 control, deliberately seeded after initial startup: isolates
// the post-hydration cached-list behavior rather than the separate startup gap.
describe('HY1 historical attribution at ae565', () => {
  it.each(['list', 'read'])('cached canvas change through %s preserves run/pause but resurrects permissions', async (source) => {
    const permission = { requestId: 'request', agentId: 'agent', toolName: 'Bash', createdAt: 1, timeoutMs: 1000 };
    const cached: SatelliteSnapshot = {
      projects: [{ id: 'project', name: 'Synthetic', path: '/synthetic' }],
      agents: { project: [{ id: 'agent', projectId: 'project', name: 'Synthetic', color: '', kind: 'durable', status: 'running' } as Agent] },
      quickAgents: {}, theme: {}, orchestrators: {}, lastSeq: 42,
      pendingPermissions: [permission], sessionPaused: true,
    };
    const satellite: SatelliteConnection = { id: 'synthetic', fingerprint: 'synthetic', alias: 'Synthetic', state: 'connected', host: 'synthetic.invalid', icon: '', color: '', mainPort: 1, pairingPort: 2, snapshot: cached, lastError: null };
    let changed!: (satellites: SatelliteConnection[]) => void;
    let receive!: (event: { satelliteId: string; type: string; payload: unknown }) => void;
    let latest = satellite;
    Object.assign(window.clubhouse.annexClient, {
      getSatellites: vi.fn(async () => [latest]),
      onSatellitesChanged: (cb: typeof changed) => { changed = cb; return () => {}; },
      onSatelliteEvent: (cb: typeof receive) => { receive = cb; return () => {}; },
      onDiscoveredChanged: () => () => {},
    });
    useAnnexClientStore.setState({ satellites: [satellite], satellitePaused: { synthetic: true } });
    useRemoteProjectStore.setState({ satelliteProjects: {}, remoteAgents: {} });
    usePendingPermissionStore.setState({ byRequestId: {} });
    useRemoteProjectStore.getState().applySatelliteSnapshot('synthetic', 'Synthetic', cached);
    await useAnnexClientStore.getState().loadSatellites();
    const off = initAnnexClientListener();
    const send = (type: string, payload: unknown) => receive({ satelliteId: 'synthetic', type, payload });
    const observed = () => ({
      status: useRemoteProjectStore.getState().remoteAgents[namespacedAgentId('synthetic', 'agent')].status,
      permission: !!usePendingPermissionStore.getState().byRequestId[namespacedAgentId('synthetic', 'request')],
      paused: useAnnexClientStore.getState().satellitePaused.synthetic,
    });
    try {
      send('pty:exit', { agentId: 'agent', exitCode: 0 });
      send('permission:response', { requestId: 'request' });
      send('session:resumed', {});
      expect(observed()).toEqual({ status: 'sleeping', permission: false, paused: false });
      latest = { ...satellite, snapshot: { ...cached, canvasState: { project: { canvases: [], activeCanvasId: '' } } } };
      if (source === 'list') changed([latest]);
      else await useAnnexClientStore.getState().loadSatellites();
      expect(observed()).toEqual({ status: 'sleeping', permission: true, paused: false });
    } finally { off(); }
  });
});
