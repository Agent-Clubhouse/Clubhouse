import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ base: '', machine: Array(16).fill('ab').join(':'), quick: false, onAuth: undefined as ((id: string) => void) | undefined }));
vi.mock('electron', () => ({ app: { getPath: () => state.base } }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./project-store', () => ({ list: vi.fn(async () => [{ id: 'p', path: 'project', name: 'Project' }]) }));
vi.mock('./agent-registry', () => ({ agentRegistry: { getAllRegistrations: () => new Map(state.quick ? [['quick', {}]] : []), get: (id: string) => id === 'quick' && state.quick ? {} : undefined, onAuthChange: (listener: (id: string) => void) => { state.onAuth = listener; return () => { state.onAuth = undefined; }; } } }));
vi.mock('./clubhouse-mcp/mcp-call-gate', () => ({ mcpCallerKind: (id: string) => id === 'quick' && state.quick ? 'quick' : undefined }));
vi.mock('./agent-config', () => ({ listDurable: vi.fn(async () => [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }]) }));
vi.mock('./dispatcher/dispatcher-service', () => ({ getDispatcherState: () => ({ config: { id: 'd', name: 'Dispatcher' } }) }));
vi.mock('./annex-peers', () => ({ listPeers: () => [{ fingerprint: state.machine, role: 'member', kind: 'desktop', alias: 'Studio', pairingId: 'pair' }] }));
vi.mock('./annex-identity', () => ({ getIdentity: () => null }));
vi.mock('./annex-agent-calls', () => ({ rememberRemoteAgentName: vi.fn() }));
vi.mock('./annex-client', () => ({ isMachineConnected: () => false }));
vi.mock('./group-project-registry', () => ({ groupProjectRegistry: { list: async () => [{ id: 'g', name: 'Group' }] } }));
vi.mock('./group-project-admin-service', () => ({ bootstrapGroupProjectAdmin: vi.fn() }));
vi.mock('./clubhouse-mcp/binding-manager', () => ({ bindingManager: { getBindingsForAgent: () => [], getAllBindings: () => [] } }));
vi.mock('./connection-grants', () => ({ bindingTargetOf: (end: { agentId: string; machineId?: string }) => end.machineId ? `${end.agentId}@${end.machineId}` : end.agentId, connectionEnd: (id: string) => { const [agentId, machineId] = id.split('@'); return { agentId, ...(machineId && { machineId }) }; } }));
vi.mock('./persisted-bindings', () => ({ claimSourceBinding: () => 'created', clearBindingRemovedByUser: vi.fn(), collectSourcesByPair: async () => ({ bySource: new Map(), failed: [] }), registerPersistedBindingSource: vi.fn(() => () => {}), onBindingRemovedByUser: () => () => {}, rebuildPersistedBindings: vi.fn() }));

import { addCardConnection, cardConnectionSource, listConnectionPickerTargets, rememberConnectionSnapshot, removeCardConnection, startCardConnections } from './connection-card';
import { getConnectionDirection } from './connection-grants-store';
import { resetAllSettingsStoresForTests } from './settings-store';

beforeEach(() => { state.quick = false; state.onAuth = undefined; state.base = fs.mkdtempSync(path.join(os.tmpdir(), 'connection-card-')); resetAllSettingsStoresForTests(); });
afterEach(() => { fs.rmSync(state.base, { recursive: true, force: true }); });

it('remembers authenticated remote agents offline, and restores card connections and group membership', async () => {
  await rememberConnectionSnapshot(state.machine, { projects: [{ id: 'remote', name: 'Remote project' }], agents: { remote: [{ id: 'c', name: 'Gamma', kind: 'durable' }] }, dispatcher: { agent: { id: 'rd', name: 'Remote dispatcher' } } });
  expect((await listConnectionPickerTargets('a')).targets).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'c', online: false, project: 'Remote project' }), expect.objectContaining({ id: 'rd', kind: 'dispatcher' })]));
  await addCardConnection({ agentId: 'a', targetId: 'b', targetKind: 'agent', twoWay: true, allow: ['wake_agent'], allowBack: [] });
  await addCardConnection({ agentId: 'a', targetId: 'g', targetKind: 'group-project', twoWay: false, allow: [], allowBack: [] });
  resetAllSettingsStoresForTests();
  expect(getConnectionDirection({ agentId: 'a' }, { agentId: 'b' })?.cardLink).toBeDefined();
  expect(await cardConnectionSource.collect()).toEqual(expect.arrayContaining([expect.objectContaining({ agentId: 'a', targetId: 'b' }), expect.objectContaining({ agentId: 'b', targetId: 'a' }), expect.objectContaining({ agentId: 'a', targetId: 'g', targetKind: 'group-project' })]));
  await removeCardConnection('a', 'g');
  expect(await cardConnectionSource.collect()).not.toEqual(expect.arrayContaining([expect.objectContaining({ targetId: 'g' })]));
});

it('creates Dispatcher and offline remote directions with the requested switches and refuses unknown targets', async () => {
  await rememberConnectionSnapshot(state.machine, { projects: [{ id: 'p', name: 'Remote' }], agents: { p: [{ id: 'c', name: 'Gamma', kind: 'durable' }] }, dispatcher: { agent: { id: 'rd', name: 'Remote dispatcher' } } });
  await addCardConnection({ agentId: 'a', targetId: 'd', targetKind: 'dispatcher', twoWay: false, allow: ['wake_agent'], allowBack: [] });
  expect(getConnectionDirection({ agentId: 'a' }, { agentId: 'd' })).toMatchObject({ cardLink: expect.anything(), enabledTools: ['wake_agent'] });
  expect(getConnectionDirection({ agentId: 'd' }, { agentId: 'a' })).toBeUndefined();
  await addCardConnection({ agentId: 'a', targetId: 'rd', targetKind: 'dispatcher', machineId: state.machine, twoWay: true, allow: ['send_message'], allowBack: ['wake_agent'] });
  expect(getConnectionDirection({ agentId: 'a' }, { agentId: 'rd', machineId: state.machine })).toMatchObject({ cardLink: expect.anything(), disabledTools: expect.arrayContaining(['clear_agent', 'wake_agent']) });
  expect(getConnectionDirection({ agentId: 'rd', machineId: state.machine }, { agentId: 'a' })).toMatchObject({ cardLink: expect.anything(), disabledTools: expect.not.arrayContaining(['wake_agent']) });
  await expect(addCardConnection({ agentId: 'a', targetId: 'missing', targetKind: 'agent', machineId: state.machine, twoWay: false, allow: [], allowBack: [] })).rejects.toThrow('directory');
});


it('lets a live quick agent start a connection and removes it when the agent ends', async () => {
  state.quick = true;
  const stop = startCardConnections();
  try {
    expect((await listConnectionPickerTargets('a')).targets.some((target) => target.id === 'quick')).toBe(false);
    await addCardConnection({ agentId: 'quick', targetId: 'b', targetKind: 'agent', twoWay: true, allow: ['wake_agent'], allowBack: [] });
    expect(await cardConnectionSource.collect()).toEqual(expect.arrayContaining([expect.objectContaining({ agentId: 'quick', targetId: 'b' })]));
    state.quick = false;
    state.onAuth?.('quick');
    await vi.waitFor(() => {
      expect(getConnectionDirection({ agentId: 'quick' }, { agentId: 'b' })?.cardLink).toBeUndefined();
      expect(getConnectionDirection({ agentId: 'b' }, { agentId: 'quick' })?.cardLink).toBeUndefined();
    });
  } finally { stop(); }
});
