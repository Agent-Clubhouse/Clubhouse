import { beforeEach, expect, it, vi } from 'vitest';
import * as path from 'path';
import * as os from 'os';

const state = vi.hoisted(() => ({
  settings: { enableServer: true, networkEnabled: true, acceptHandoffs: true },
  projects: [] as Array<{ path: string }>, agents: [] as Array<{ id: string }>,
  runtimes: new Map<string, { isRunning(): boolean; getState(): string; hasPendingWork?(): boolean }>(),
  quota: 'unknown', allowed: true, devices: [] as unknown[], post: vi.fn(),
}));
const machine = Array(32).fill('aa').join(':');
vi.mock('./annex-identity', () => ({ getOrCreateIdentity: () => ({ fingerprint: Array(32).fill('aa').join(':') }) }));
vi.mock('./annex-settings', () => ({ getSettings: () => state.settings, networkEnabled: () => state.settings.networkEnabled }));
vi.mock('./annex-devices', () => ({ listDevices: () => state.devices }));
vi.mock('./annex-client', () => ({ isMachineConnected: () => true, postToMachine: (...args: unknown[]) => state.post(...args) }));
vi.mock('./project-store', () => ({ peekProjects: async () => state.projects }));
vi.mock('./agent-config', () => ({ peekDurableConfigs: async () => state.agents }));
vi.mock('./agent-registry', () => ({ agentRegistry: { getAllRegistrations: () => new Map([...state.runtimes.keys()].map((id) => [id, {}])) } }));
vi.mock('./headless-manager', () => ({ isHeadless: (id: string) => id === 'headless' }));
vi.mock('./agent-runtime', () => ({ getAgentRuntime: (id: string) => state.runtimes.get(id) }));
vi.mock('./provider-quota', () => ({ peekProviderQuota: () => ({ state: state.quota }) }));
vi.mock('./clubhouse-mcp/grant-check', () => ({ holdsGrant: () => state.allowed }));
import { acceptingRemoteHandoffs, capacityAgentCounts, capacityProviders, handoffCapacityService, receiveCapacityProbe } from './handoff-capacity-host';

beforeEach(() => {
  state.settings = { enableServer: true, networkEnabled: true, acceptHandoffs: true };
  state.projects = [{ path: path.join(os.tmpdir(), 'capacity-project') }];
  state.agents = [];
  state.runtimes.clear();
  state.allowed = true;
  state.quota = 'unknown';
});

it('defaults acceptance to the active Annex setting, and honors either off switch', () => {
  expect(acceptingRemoteHandoffs()).toBe(true);
  state.settings.acceptHandoffs = false;
  expect(acceptingRemoteHandoffs()).toBe(false);
  state.settings.acceptHandoffs = true;
  state.settings.networkEnabled = false;
  expect(acceptingRemoteHandoffs()).toBe(false);
});

it.each([
  ['unknown', 'unknown'], ['known', 'available'], ['low', 'limited'], ['near_limit', 'limited'], ['exhausted', 'unavailable'],
])('maps cached quota %s to %s without querying a provider', (quota, expected) => {
  state.quota = quota;
  expect(Object.values(capacityProviders())).toEqual([expected, expected, expected]);
});

it('counts idle durable, sleeping, busy and quick agents once across duplicate project entries', async () => {
  state.projects.push(state.projects[0]);
  state.agents = [{ id: 'idle' }, { id: 'sleeping' }, { id: 'busy' }, { id: 'queued' }, { id: 'headless' }];
  state.runtimes.set('idle', { isRunning: () => true, getState: () => 'idle' });
  state.runtimes.set('busy', { isRunning: () => true, getState: () => 'running' });
  state.runtimes.set('queued', { isRunning: () => true, getState: () => 'idle', hasPendingWork: () => true });
  state.runtimes.set('quick', { isRunning: () => true, getState: () => 'idle' });
  expect(await capacityAgentCounts()).toEqual({ running: 4, sleeping: 1, idleDurable: 1 });
});

it('checks device.read before sampling, including an agent holding a stale tool list', async () => {
  state.allowed = false;
  await expect(handoffCapacityService().probe('caller', machine)).rejects.toThrow('not authorized');
  expect(state.post).not.toHaveBeenCalled();
});

it('refuses additional peer fields before any resource sampling', async () => {
  await expect(receiveCapacityProbe(machine, { path: os.tmpdir() })).rejects.toThrow('Invalid capacity request');
});

it('carries the sample cancellation signal and a bounded response size to the pinned HTTP transport', async () => {
  const other = Array(32).fill('be').join(':');
  state.devices = [{ fingerprint: other, role: 'member', kind: 'desktop', lastSeen: '' }];
  state.post.mockResolvedValue({ status: 200, body: {
    machine: other, online: true, sampledAt: 100, lastSeen: 100,
    agents: { running: 0, sleeping: 0, idleDurable: 0 }, load: 'low', disk: 'ample', providers: capacityProviders(), accepting_handoffs: true,
  } });
  expect((await handoffCapacityService().probe('caller', other))[0].online).toBe(true);
  expect(state.post).toHaveBeenCalledWith(other, '/api/v1/network/handoff-capacity', {}, {
    signal: expect.any(AbortSignal), maxResponseBytes: 16 * 1024,
  });
});
