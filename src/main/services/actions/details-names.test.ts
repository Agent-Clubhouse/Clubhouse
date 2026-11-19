import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { app } from 'electron';
import type { Action } from '../../../shared/actions';
const m = vi.hoisted(() => ({ machine: Array(32).fill('aa').join(':'), satellite: null as unknown, actions: [] as Action[], local: new Map<string, string>(), groups: new Map<string, { name: string }>() }));
vi.mock('../log-service', () => ({ appLog: vi.fn() }));
vi.mock('../../telemetry/persist', () => ({ persist: { recovery: vi.fn(), timed: async (_kind: string, work: () => Promise<void>) => work() } }));
vi.mock('../annex-client', async (original) => ({ ...await original<typeof import('../annex-client')>(), getSatellite: (id: string) => id === m.machine ? m.satellite : null }));
vi.mock('../annex-peers', async (original) => ({ ...await original<typeof import('../annex-peers')>(), listPeers: () => [{ fingerprint: m.machine, role: 'member', kind: 'desktop', pairingId: 'pair', alias: 'Desk' }] }));
vi.mock('../app-event-sources', async (original) => ({ ...await original<typeof import('../app-event-sources')>(), peekKnownAgentName: (id: string) => m.local.get(id) }));
vi.mock('../group-project-registry', async (original) => { const actual = await original<typeof import('../group-project-registry')>(); return { ...actual, groupProjectRegistry: new Proxy(actual.groupProjectRegistry, { get: (target, key) => key === 'getSync' ? (id: string) => m.groups.get(id) ?? null : typeof Reflect.get(target, key) === 'function' ? Reflect.get(target, key).bind(target) : Reflect.get(target, key) }) }; });
vi.mock('./index', async (original) => ({ ...await original<typeof import('./index')>(), readActionDetailsForAgent: (id: string, project: string, dispatcher: boolean, names: import('../../../shared/actions').ActionNames) => projectActionDetails({ list: () => m.actions, lastRunForDisplay: () => undefined }, id, project, dispatcher, names), peekActionProjectName: () => 'Project' }));
import { projectActionDetails } from './details-read';
import { actionDetailsNames } from './details-names';
import { readActionCard } from '../remote-details-cards';
import { card } from '../remote-details-presentation';
import { remoteFederationController } from '../dispatcher-federation';
import { resetAllSettingsStoresForTests } from '../settings-store';
let root: string;
async function snapshot() {
  const out: Record<string, { bytes: string; mtimeMs: number; ino: number }> = {};
  for (const name of await fs.readdir(root)) { const file = path.join(root, name); const stat = await fs.stat(file); out[name] = { bytes: (await fs.readFile(file)).toString('base64'), mtimeMs: stat.mtimeMs, ino: stat.ino }; }
  return out;
}
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'clubhouse-actions-cold-names-')); vi.spyOn(app, 'getPath').mockReturnValue(root); resetAllSettingsStoresForTests();
  m.local.clear(); m.local.set('selected', 'Selected'); m.groups.clear(); m.groups.set('group', { name: 'Retained Group' });
  m.satellite = { alias: 'Desk', state: 'connected', snapshot: { machine: { fingerprint: m.machine, name: 'Desk' }, agents: { p: [{ id: 'remote-agent', kind: 'durable', projectId: 'p', name: 'Retained Remote' }] }, quickAgents: {} } };
  m.actions = [{ id: 'own', name: 'Reminder', owner: { kind: 'agent', agentId: 'selected' }, enabled: false, createdAt: 1, updatedAt: 1, overlap: 'skip', trigger: { kind: 'once', at: 1000 }, steps: [{ kind: 'message', agentId: 'selected', text: 'PRIVATE_LOCAL_PROMPT' }, { kind: 'message', agentId: `remote-agent@${m.machine}`, text: 'PRIVATE_REMOTE_PROMPT' }] }];
});
afterEach(async () => { resetAllSettingsStoresForTests(); await fs.rm(root, { recursive: true, force: true }); });
it.each(['cold-federation', 'cold-membership', 'warm'] as const)('preserves real federation/membership files and stale temp artifacts while resolving selected cached names: %s', async (mode) => {
  const valid = JSON.stringify({ controllers: { [m.machine]: { agentId: 'controller-other', name: 'Dispatcher controller', enabled: true, pairingId: 'pair' } } });
  await fs.writeFile(path.join(root, 'dispatcher-federation.json'), mode === 'cold-federation' ? 'broken federation' : valid);
  await fs.writeFile(path.join(root, 'annex-network.json'), mode === 'cold-membership' ? 'broken membership' : JSON.stringify({ removals: [], confirmations: {}, renamedAt: {}, removedNames: {} }));
  if (mode === 'warm') expect(remoteFederationController(m.machine)?.agentId).toBe('controller-other');
  for (const store of ['dispatcher-federation.json', 'annex-network.json']) {
    const file = path.join(root, `.${store}.tmp-${process.pid + 100000}-1`); await fs.writeFile(file, 'PRIVATE_STALE_TEMP'); const old = new Date(Date.now() - 3 * 86400000); await fs.utimes(file, old, old);
  }
  const before = await snapshot(); const c = card('actions', 'Actions'); readActionCard(c, 'selected', 'p');
  expect.soft(c.summary).toBe('1 related'); expect.soft(c.rows[0].action?.description).toContain('Retained Remote on Desk');
  expect.soft(c.notes.join(' ')).toContain('retained host snapshots'); expect.soft(JSON.stringify(c)).not.toContain('PRIVATE_');
  expect.soft(await snapshot()).toEqual(before);
});
it('uses passive local/project/group/device callbacks and reports missing or ambiguous cached names without fallback discovery', () => {
  const resolver = actionDetailsNames((id) => id === 'p' ? 'Retained Project' : undefined);
  expect(resolver.names.agent('selected')).toBe('Selected'); expect(resolver.names.project('p')).toBe('Retained Project'); expect(resolver.names.groupProject?.('group')).toBe('Retained Group'); expect(resolver.names.device?.(m.machine)).toBe('Desk');
  expect(resolver.names.agent(`missing@${m.machine}`)).toBeUndefined(); expect(resolver.names.agent('remote||||selected')).toBeUndefined();
  m.satellite = { alias: 'Desk', state: 'connected', snapshot: { agents: { a: [{ id: 'ambiguous', name: 'First' }], b: [{ id: 'ambiguous', name: 'Other' }] } } };
  const other = actionDetailsNames(() => undefined); expect(other.names.agent(`ambiguous@${m.machine}`)).toBeUndefined();
  expect(other.names.project('missing')).toBeUndefined(); expect(other.notices().join(' ')).toContain('unavailable');
});
it('reports reference-name scan limits and malformed snapshots as unknown without throwing', () => {
  m.satellite = { alias: 'Desk', state: 'connected', snapshot: { agents: { p: Array.from({ length: 4100 }, (_, i) => ({ id: `other${i}`, name: 'Other' })) } } };
  const resolver = actionDetailsNames(() => undefined); expect(resolver.names.agent(`remote-agent@${m.machine}`)).toBeUndefined(); expect(resolver.notices().join(' ')).toContain('read limit');
  m.satellite = { alias: 'Desk', snapshot: { agents: null, quickAgents: { p: {} } } };
  expect(actionDetailsNames(() => undefined).names.agent(`remote-agent@${m.machine}`)).toBeUndefined();
});
