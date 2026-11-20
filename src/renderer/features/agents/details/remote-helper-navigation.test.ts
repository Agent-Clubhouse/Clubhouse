import { beforeEach, expect, it, vi } from 'vitest';
import type { Agent } from '../../../../shared/types';
import type { RemoteHelperRow } from '../../../../shared/remote-helper-page';
const m = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('../helpers/orchestration-hooks', () => ({ openAgent: m.open }));
import { useAnnexClientStore } from '../../../stores/annexClientStore';
import { useRemoteProjectStore } from '../../../stores/remoteProjectStore';
import { useUIStore } from '../../../stores/uiStore';
import { openRemoteHelper, remoteHelperOpenUnavailable } from './remote-helper-navigation';
const parent = { id: 'remote||sat||parent', projectId: 'remote||sat||p', name: 'Parent' } as Agent;
const row: RemoteHelperRow = { key: 'opaque', name: 'Helper', projectName: 'Other host project', status: 'running', statusSource: 'current-run', branch: null, failure: null, disposedAt: null, work: { state: 'recorded', text: 'clean' }, target: { agentId: 'helper', projectId: 'q' } };
beforeEach(() => {
  m.open.mockClear(); useUIStore.setState({ activeHostId: null });
  useAnnexClientStore.setState({ satellites: [{ id: 'sat', state: 'connected', snapshot: { projects: [{ id: 'p' }, { id: 'q' }], agents: { p: [{ id: 'parent', kind: 'durable' }], q: [{ id: 'helper', kind: 'durable', parentAgentId: 'parent' }] } } }] as never });
  useRemoteProjectStore.setState({ remoteAgents: { 'remote||sat||helper': { id: 'remote||sat||helper', projectId: 'remote||sat||q', kind: 'durable', parentAgentId: 'remote||sat||parent' } as Agent } });
});
it('opens only a current same-host project-qualified helper through existing navigation', () => {
  expect(remoteHelperOpenUnavailable(parent, row)).toBeNull(); openRemoteHelper(parent, row); expect(useUIStore.getState().activeHostId).toBe('sat'); expect(m.open).toHaveBeenCalledExactlyOnceWith('remote||sat||q', 'remote||sat||helper');
});
it.each(['offline', 'snapshot-unavailable', 'omitted', 'reparented', 'project-collision', 'missing-loaded', 'disposed', 'unbound'])('does not navigate with %s identity evidence', (mode) => {
  const host = structuredClone(useAnnexClientStore.getState().satellites[0]);
  if (mode === 'offline') host.state = 'disconnected'; if (mode === 'snapshot-unavailable') host.snapshotUnavailable = true; if (mode === 'omitted') host.snapshot.snapshotTruncated = { omitted: ['agents'] };
  if (mode === 'reparented') host.snapshot.agents.q[0].parentAgentId = 'other'; if (mode === 'project-collision') host.snapshot.projects.push({ id: 'q' });
  useAnnexClientStore.setState({ satellites: [host] }); if (mode === 'missing-loaded') useRemoteProjectStore.setState({ remoteAgents: {} });
  const candidate = { ...row, ...(mode === 'disposed' ? { status: 'disposed' as const } : {}), ...(mode === 'unbound' ? { target: undefined } : {}) };
  expect(remoteHelperOpenUnavailable(parent, candidate)).not.toBeNull(); openRemoteHelper(parent, candidate); expect(m.open).not.toHaveBeenCalled();
});
it('rechecks relationship on click after render and refuses a raw/local parent ID', () => {
  expect(remoteHelperOpenUnavailable(parent, row)).toBeNull(); const host = structuredClone(useAnnexClientStore.getState().satellites[0]); host.snapshot.agents.q = []; useAnnexClientStore.setState({ satellites: [host] });
  openRemoteHelper(parent, row); openRemoteHelper({ ...parent, id: 'parent' }, row); expect(m.open).not.toHaveBeenCalled();
});
