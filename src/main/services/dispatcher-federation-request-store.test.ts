import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ dir: '' }));
vi.mock('electron', () => ({ app: { getPath: () => fixture.dir, isPackaged: false } }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
import { createFederationRequestStore } from './dispatcher-federation-requests';
beforeEach(() => { fixture.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'federation-request-store-')); });
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
  it('rejects a changed authorization at the atomic commit barrier', async () => {
    const store = createFederationRequestStore();
    let current = true;
    const open = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => { const handle = await open(...args); current = false; return handle; });
    await expect(store.update((f) => { f.paused.laptop = 'old pairing'; }, () => current)).rejects.toThrow('authorization changed');
    expect(store.get().paused).toEqual({});
  });
  it.each(['null', '{"version":1}', '{"version":1,"requests":[{}],"paused":{},"crossings":{}}'])('fails closed for unreadable records: %s', async (raw) => {
    fs.writeFileSync(path.join(fixture.dir, 'dispatcher-federation-requests.json'), raw);
    const store = createFederationRequestStore();
    expect(() => store.get()).toThrow('unreadable');
    await expect(store.update(() => {})).rejects.toThrow('unreadable');
    expect(fs.readFileSync(path.join(fixture.dir, 'dispatcher-federation-requests.json'), 'utf8')).toBe(raw);
  });
});
