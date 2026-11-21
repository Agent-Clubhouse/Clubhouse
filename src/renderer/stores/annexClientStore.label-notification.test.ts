import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent, SatelliteSnapshot } from '../../shared/types';
import { initAnnexClientListener, useAnnexClientStore, type SatelliteConnection } from './annexClientStore';
import { useRemoteProjectStore, namespacedAgentId } from './remoteProjectStore';
import { usePendingPermissionStore } from './pendingPermissionStore';

const permission = { requestId: 'request', agentId: 'agent', toolName: 'Bash', createdAt: 1, timeoutMs: 1000 };
const cached: SatelliteSnapshot = {
  projects: [{ id: 'project', name: 'Synthetic', path: '/synthetic' }],
  agents: { project: [{ id: 'agent', projectId: 'project', name: 'Synthetic', kind: 'durable', status: 'running', color: '' } as Agent] },
  quickAgents: {}, theme: {}, orchestrators: {}, pendingPermissions: [permission], lastSeq: 42,
};
const connection: SatelliteConnection = {
  id: 'synthetic', fingerprint: 'synthetic', alias: 'Old name', icon: '', color: '',
  state: 'connected', host: 'synthetic.invalid', mainPort: 1, pairingPort: 2,
  snapshot: cached, lastError: null, connectionGeneration: 1,
};

// Test-only discriminator for the UNAPPLIED full-list name-notification proposal.
// A genuine host list is normally allowed to hydrate; this asks whether borrowing
// that same channel for a label-only signal can meet its stricter no-hydration goal.
describe('#3720 proposed label-only full-list notification', () => {
  let changed: (satellites: SatelliteConnection[]) => void;
  let receive: (event: { satelliteId: string; type: string; payload: unknown }) => void;
  let finishRead: (satellites: SatelliteConnection[]) => void;
  let cleanup: () => void;
  const agentId = namespacedAgentId(connection.id, 'agent');
  beforeEach(() => {
    const read = new Promise<SatelliteConnection[]>((resolve) => { finishRead = resolve; });
    Object.assign(window.clubhouse.annexClient, {
      getSatellites: vi.fn(() => read),
      onSatellitesChanged: vi.fn((callback) => { changed = callback; return vi.fn(); }),
      onDiscoveredChanged: vi.fn(() => vi.fn()),
      onSatelliteEvent: vi.fn((callback) => { receive = callback; return vi.fn(); }),
    });
    useAnnexClientStore.setState({ satellites: [], satellitePaused: {} });
    useRemoteProjectStore.setState({ satelliteProjects: {}, remoteAgents: {}, remoteAgentDetailedStatus: {}, remoteProjectIcons: {}, remoteAgentIcons: {}, remoteCanvasState: {}, remoteAppCanvasState: {}, pluginMatchState: {} });
    usePendingPermissionStore.setState({ byRequestId: {} });
    cleanup = initAnnexClientListener();
  });
  afterEach(async () => {
    cleanup(); finishRead([]);
    await Promise.resolve(); await Promise.resolve();
  });

  it.each([undefined, 'already-eligible-receipt'])('does not hydrate a missing catalog merely to publish a label (receipt: %s)', (snapshotReceipt) => {
    // This is exactly the proposed handler's getSatellites() list sent directly
    // while the real initial GET remains pending; no new main receipt is minted.
    changed([{ ...structuredClone(connection), alias: 'New name', ...(snapshotReceipt && { snapshotReceipt }) }]);
    expect(useAnnexClientStore.getState().satellites[0]?.alias).toBe('New name');
    expect(window.clubhouse.annexClient.getSatellites).toHaveBeenCalledTimes(1);
    expect(useRemoteProjectStore.getState().remoteAgents[agentId]).toBeUndefined();
    expect(usePendingPermissionStore.getState().byRequestId).toEqual({});
  });

  it('preserves a settled permission and retired run when an existing catalog receives an alias-only clone', () => {
    changed([structuredClone(connection)]); // Genuine original host observation.
    receive({ satelliteId: connection.id, type: 'pty:exit', payload: { agentId: 'agent', exitCode: 0 } });
    receive({ satelliteId: connection.id, type: 'permission:response', payload: { requestId: 'request' } });
    changed([{ ...structuredClone(connection), alias: 'New name' }]);
    expect(useAnnexClientStore.getState().satellites[0]?.alias).toBe('New name');
    expect(useRemoteProjectStore.getState().remoteAgents[agentId].status).toBe('sleeping');
    expect(usePendingPermissionStore.getState().byRequestId).toEqual({});
    expect(window.clubhouse.annexClient.getSatellites).toHaveBeenCalledTimes(1);
  });
});
