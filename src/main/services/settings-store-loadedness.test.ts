import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { app } from 'electron';
vi.mock('fs', async (original) => { const real = await original<typeof import('fs')>(); return { ...real, readFileSync: vi.fn(real.readFileSync) }; });
import { createSettingsStore, resetAllSettingsStoresForTests, type SettingsStore } from './settings-store';
let root: string;
const filename = 'loadedness.json';
const disk = async () => Object.fromEntries(await Promise.all((await fs.promises.readdir(root)).sort().map(async (name) => { const f = path.join(root, name), s = await fs.promises.stat(f); return [name, { bytes: (await fs.promises.readFile(f)).toString('base64'), ino: s.ino, mtimeMs: s.mtimeMs }]; })));
const put = (value: unknown) => fs.promises.writeFile(path.join(root, filename), JSON.stringify(value));
function selectedFields(store: SettingsStore<{ enabled: boolean; count: number; privateCredential?: string }>) {
  // A representative synchronous OWNER projection, not a production endpoint.
  // No yield/callback between the loadedness check and get. Never return cache objects.
  if (!store.hasLoaded?.()) return undefined;
  const value = store.get(); return { enabled: value.enabled, count: value.count };
}
beforeEach(async () => { root = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'clubhouse-loadedness-'))); vi.spyOn(app, 'getPath').mockReturnValue(root); });
afterEach(async () => { resetAllSettingsStoresForTests(); vi.restoreAllMocks(); await fs.promises.rm(root, { recursive: true, force: true }); });
it.each(['valid', 'corrupt', 'missing', 'backup-only'])('checks cold %s state without read, recovery, temp cleanup or callbacks', async (kind) => {
  if (kind === 'valid') await put({ enabled: false, count: 0, privateCredential: 'PRIVATE_CREDENTIAL' });
  if (kind === 'corrupt') await fs.promises.writeFile(path.join(root, filename), '{broken');
  if (kind === 'backup-only') await fs.promises.writeFile(path.join(root, filename + '.bak'), '{"enabled":false,"count":0}');
  const temp = path.join(root, `.${filename}.tmp-${process.pid + 100000}-1`); await fs.promises.writeFile(temp, 'keep'); const old = new Date(Date.now() - 3 * 86400000); await fs.promises.utimes(temp, old, old);
  const migrate = vi.fn((value) => value), onLoad = vi.fn();
  const store = createSettingsStore(filename, { enabled: true, count: 10 }, migrate, { onLoad });
  const before = await disk(), read = vi.mocked(fs.readFileSync).mockClear(), get = vi.spyOn(store, 'get');
  expect.soft(store.hasLoaded?.()).toBe(false); expect.soft(selectedFields(store)).toBeUndefined();
  expect.soft(get).not.toHaveBeenCalled(); expect.soft(read).not.toHaveBeenCalled(); expect.soft(migrate).not.toHaveBeenCalled(); expect.soft(onLoad).not.toHaveBeenCalled(); expect.soft(store.peekLoaded?.()).toBeUndefined(); expect.soft(await disk()).toEqual(before);
});
it('permits synchronous selected projection of deliberately warmed memory without raw display snapshots or later disk reads', async () => {
  await put({ enabled: false, count: 0, privateCredential: 'PRIVATE_CREDENTIAL' });
  const store = createSettingsStore(filename, { enabled: true, count: 10 }); store.get();
  await put({ enabled: true, count: 99, privateCredential: 'PRIVATE_NEW_PRIMARY' });
  const before = await disk(), read = vi.mocked(fs.readFileSync).mockClear();
  expect.soft(store.hasLoaded?.()).toBe(true); expect.soft(selectedFields(store)).toEqual({ enabled: false, count: 0 });
  expect.soft(store.peekLoaded?.()).toBeUndefined(); expect.soft(read).not.toHaveBeenCalled(); expect.soft(JSON.stringify(store.hasLoaded?.())).toBe('true'); expect.soft(await disk()).toEqual(before);
});
it('becomes cold on the actual store reset instead of allowing a guarded get to reinitialize changed files', async () => {
  await put({ enabled: false, count: 0 }); const store = createSettingsStore(filename, { enabled: true, count: 10 }, undefined, { displaySnapshot: true }); store.get(); expect(store.hasLoaded?.()).toBe(true);
  resetAllSettingsStoresForTests(); await fs.promises.writeFile(path.join(root, filename), '{broken'); const before = await disk();
  const read = vi.mocked(fs.readFileSync).mockClear(), get = vi.spyOn(store, 'get');
  expect.soft(store.hasLoaded?.()).toBe(false); expect.soft(selectedFields(store)).toBeUndefined(); expect.soft(get).not.toHaveBeenCalled(); expect.soft(read).not.toHaveBeenCalled(); expect.soft(await disk()).toEqual(before);
});
it('tracks actual accepted-save memory and rollback without adding display provenance or claiming disk commitment', async () => {
  await put({ enabled: false, count: 0 }); const store = createSettingsStore(filename, { enabled: true, count: 10 }, undefined, { rollBackFailedSaves: true });
  let checks = 0; const writing = store.save({ enabled: true, count: 7 }, { prepare: async () => {}, check: () => { if (++checks > 1) throw new Error('controlled refusal'); } });
  expect(store.hasLoaded?.()).toBe(true); expect(selectedFields(store)).toEqual({ enabled: true, count: 7 });
  await expect(writing).rejects.toThrow('controlled refusal');
  expect(store.hasLoaded?.()).toBe(true); expect(selectedFields(store)).toEqual({ enabled: false, count: 0 }); expect(store.peekLoaded?.()).toBeUndefined();
  expect(JSON.parse(await fs.promises.readFile(path.join(root, filename), 'utf8'))).toEqual({ enabled: false, count: 0 });
});
it('loadedness says nothing about recovery, schema validity or source provenance', async () => {
  await fs.promises.writeFile(path.join(root, filename), '{broken');
  const store = createSettingsStore(filename, { enabled: true, count: 10 });
  expect(store.hasLoaded?.()).toBe(false); store.get(); const before = await disk();
  expect(store.hasLoaded?.()).toBe(true); expect(store.peekLoaded?.()).toBeUndefined(); expect(await disk()).toEqual(before);
  // Intentional ordinary get above may recover. A later OWNER adapter must
  // validate its selected runtime/saved evidence, never infer validity from this boolean.
});
it('old/custom store implementations without this optional capability remain unavailable to guarded readers', () => {
  const get = vi.fn(() => ({ enabled: true, count: 1 }));
  expect(selectedFields({ get, save: vi.fn(), update: vi.fn() })).toBeUndefined(); expect(get).not.toHaveBeenCalled();
});
