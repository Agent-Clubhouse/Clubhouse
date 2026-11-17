import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ dir: '' }));
vi.mock('electron', () => ({ app: { getPath: () => fixture.dir, isPackaged: false } }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
import type { FederatedRequest } from '../../shared/dispatcher-federation-requests';
import { appLog } from './log-service';
import { createFederationRequestStore } from './dispatcher-federation-requests';
beforeEach(() => { vi.clearAllMocks(); fixture.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'federation-request-store-')); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(fixture.dir, { recursive: true, force: true }); });
describe('durable federation request records', () => {
  it('reloads committed pauses and rolls back a failed atomic save', async () => {
    const store = createFederationRequestStore();
    await store.update((f) => { f.paused.laptop = 'rate limit'; });
    expect(createFederationRequestStore().get().paused.laptop).toBe('rate limit');
    const write = vi.spyOn(fs.promises, 'rename').mockRejectedValue(new Error('disk unavailable'));
    await expect(store.update((f) => { f.paused.laptop = 'changed'; })).rejects.toThrow();
    expect(store.get().paused.laptop).toBe('rate limit');
    write.mockRestore();
    expect(createFederationRequestStore().get().paused.laptop).toBe('rate limit');
  });
  it('lifts only an exact legacy depth trip from a pre-fix store fixture and persists it once', async () => {
    const filename = path.join(fixture.dir, 'dispatcher-federation-requests.json');
    const before = JSON.parse(fs.readFileSync(path.resolve('test/fixtures/dispatcher-federation/legacy-depth-trip.json'), 'utf8'));
    fs.writeFileSync(filename, JSON.stringify(before));
    const store = createFederationRequestStore();
    expect(store.get().paused).toEqual({ human: 'Paused by the person', unknown: 'An unknown pause' });
    await store.ready?.(); await store.ready?.();
    const after = createFederationRequestStore().get();
    expect(after.requests).toEqual(before.requests); expect(after.news).toEqual(before.news);
    expect(after.crossings).toEqual(before.crossings);
    expect(after.pauseNotices?.laptop).toBeUndefined(); expect(after.pauseEpochs?.laptop).toBeUndefined();
    expect(after.pauseNotices?.human).toEqual(before.pauseNotices.human);
    expect(JSON.parse(fs.readFileSync(filename, 'utf8'))).toEqual(after);
    expect(vi.mocked(appLog).mock.calls.filter((call) => call[2] === 'Retired Dispatcher depth pause cleared')).toHaveLength(1);
  });
  it('loads and persists tracing depths beyond eight without changing history', async () => {
    const before = JSON.parse(fs.readFileSync(path.resolve('test/fixtures/dispatcher-federation/legacy-depth-trip.json'), 'utf8'));
    before.paused = {}; before.pauseNotices = {}; before.requests[0].cause.depth = 1000;
    fs.writeFileSync(path.join(fixture.dir, 'dispatcher-federation-requests.json'), JSON.stringify(before));
    const store = createFederationRequestStore(); expect(store.get().requests[0].cause.depth).toBe(1000);
    await store.update(() => {}); expect(createFederationRequestStore().get().requests).toEqual(before.requests);
  });
  it('rejects a changed authorization at the atomic commit barrier', async () => {
    const store = createFederationRequestStore();
    let current = true;
    const open = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => { const handle = await open(...args); current = false; return handle; });
    await expect(store.update((f) => { f.paused.laptop = 'old pairing'; }, () => current)).rejects.toThrow('authorization changed');
    expect(store.get().paused).toEqual({});
  });
  it('loads old v1 request, reply, news and paused records without changing saved depths or bytes', () => {
    const request: FederatedRequest = {
      id: 'old-request', direction: 'incoming', machineId: 'laptop', callerId: 'controller', targetId: 'controller',
      origin: { machineId: 'laptop', machineName: 'Laptop', agentId: 'peer-controller', agentName: 'Dispatcher' },
      originRequestId: 'old-local', localRequestId: 'remote-old', text: 'Old work',
      cause: { rootId: 'old-root', depth: 7, parentId: 'old-parent' }, epoch: { sender: 'self-pair', receiver: 'peer-pair' },
      createdAt: 1, expiresAt: 2, delivery: 'delivered', outcome: 'under_way', revision: 1, receivedRevision: 0, duplicates: 3,
      replies: [{ revision: 1, outcome: 'under_way', text: 'Old progress', deliveryId: 'old-reply', delivery: 'delivered' }],
    };
    const value = { version: 1, requests: [request], paused: { laptop: 'Paused by the person' }, crossings: {}, news: { laptop: { ...request, localRequestId: '', cause: { rootId: 'old-news', depth: 6 } } } };
    const raw = JSON.stringify(value, null, 2);
    const filename = path.join(fixture.dir, 'dispatcher-federation-requests.json'); fs.writeFileSync(filename, raw);
    expect(createFederationRequestStore().get()).toEqual(value);
    expect(fs.readFileSync(filename, 'utf8')).toBe(raw);
  });
  it.each(['null', '{"version":1}', '{"version":1,"requests":[{}],"paused":{},"crossings":{}}'])('fails closed for unreadable records: %s', async (raw) => {
    fs.writeFileSync(path.join(fixture.dir, 'dispatcher-federation-requests.json'), raw);
    const store = createFederationRequestStore();
    expect(() => store.get()).toThrow('unreadable');
    await expect(store.update(() => {})).rejects.toThrow('unreadable');
    expect(fs.readFileSync(path.join(fixture.dir, 'dispatcher-federation-requests.json'), 'utf8')).toBe(raw);
  });
});
