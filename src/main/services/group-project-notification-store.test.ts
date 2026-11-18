import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
const fx = vi.hoisted(() => ({ home: '', agents: ['dev', 'other'], groups: ['gp', 'other'] }));
vi.mock('./group-project-host', () => ({ groupProjectHost: { list: async () => fx.groups.map((id) => ({id, seq: 40})), resolveMembers: async () => fx.agents.map((address) => ({address})), localAgentId: (_g: unknown, a: string) => a } }));
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => fx.home } }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
beforeEach(async () => { fx.home = await fsp.mkdtemp(path.join(os.tmpdir(), 'gp-receipts-')); });
afterEach(async () => { await fsp.rm(fx.home, { recursive: true, force: true }); });
it('persists monotonic receipts and per-recipient wake budget across module reload', async () => {
  let store = await import('./group-project-notification-store');
  await Promise.all([store.markNotified('gp', 'dev', 4), store.markNotified('gp', 'dev', 2)]);
  expect(await store.lastNotified('gp', 'dev')).toBe(4);
  const now = Date.now();
  const reservations = await Promise.all(Array.from({ length: 5 }, () => store.reserveWake('dev', now)));
  expect(reservations.filter(Boolean)).toHaveLength(store.WAKE_LIMIT_MAX);
  vi.resetModules(); store = await import('./group-project-notification-store');
  expect(await store.lastNotified('gp', 'dev')).toBe(4);
  expect(await store.lastNotified('other', 'dev')).toBeUndefined();
  expect(await store.reserveWake('dev', now + 1)).toBe(false);
  expect(await store.reserveWake('other', now + 1)).toBe(true);
  expect(await store.reserveWake('dev', now + store.WAKE_LIMIT_WINDOW_MS)).toBe(true);
});

it.each(['{broken', '{"notified":false,"wakes":{}}'])('quarantines corrupt receipts and baselines every current group: %s', async (raw) => {
  const dir = path.join(fx.home, '.clubhouse-dev/group-projects');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'notification-receipts.json'), raw);
  vi.resetModules();
  const store = await import('./group-project-notification-store');
  expect(await store.lastNotified('gp', 'dev')).toBe(40);
  expect(await store.lastNotified('other', 'dev')).toBe(40);
  const quarantined = (await fsp.readdir(dir)).find((n) => n.startsWith('notification-receipts.json.corrupt-'));
  expect(quarantined).toBeTruthy();
  expect(await fsp.readFile(path.join(dir, quarantined!), 'utf8')).toBe(raw);
});

it('prunes deleted groups, departed members and orphan wake budgets on load', async () => {
  const store = await import('./group-project-notification-store');
  await store.markNotified('deleted', 'dev', 5);
  await store.markNotified('gp', 'departed', 6);
  await store.markNotified('gp', 'dev', 7);
  await store.reserveWake('departed');
  vi.resetModules();
  const restarted = await import('./group-project-notification-store');
  expect(await restarted.lastNotified('gp', 'dev')).toBe(7);
  const raw = JSON.parse(await fsp.readFile(path.join(fx.home, '.clubhouse-dev/group-projects/notification-receipts.json'), 'utf8'));
  expect(Object.keys(raw.notified)).toEqual([JSON.stringify(['gp', 'dev'])]);
  expect(raw.wakes.departed).toBeUndefined();
});

it('persists the urgent allowance per sender and recipient, including across restart', async () => {
  let store = await import('./group-project-notification-store');
  const now = Date.now();
  const accepted = await Promise.all(Array.from({ length: store.URGENT_LIMIT_MAX + 1 }, () => store.reserveUrgent('sender', 'dev', now)));
  expect(accepted.filter(Boolean)).toHaveLength(20);
  vi.resetModules(); store = await import('./group-project-notification-store');
  expect(await store.reserveUrgent('sender', 'dev', now + 1)).toBe(false);
  expect(await store.reserveUrgent('other-sender', 'dev', now + 1)).toBe(true);
  expect(await store.reserveUrgent('sender', 'other', now + 1)).toBe(true);
  expect(await store.reserveUrgent('sender', 'dev', now + store.URGENT_LIMIT_WINDOW_MS)).toBe(true);
});

it('prunes live departures and deletion without waiting for another process restart', async () => {
  const store = await import('./group-project-notification-store');
  await store.markNotified('gp', 'dev', 4);
  await store.markNotified('other', 'other', 5);
  fx.groups = ['gp']; fx.agents = ['other'];
  try {
    await store.pruneNotificationReceipts();
    expect(await store.lastNotified('gp', 'dev')).toBeUndefined();
    expect(await store.lastNotified('other', 'other')).toBeUndefined();
  } finally { fx.groups = ['gp', 'other']; fx.agents = ['dev', 'other']; }
});
