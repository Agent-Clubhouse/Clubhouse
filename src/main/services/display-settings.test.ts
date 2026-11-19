import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { app } from 'electron';
import { createSettingsStore } from './settings-store';
import { DISPLAY_SETTINGS_MAX_BYTES, readDisplaySettings } from './display-settings';
let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'clubhouse-display-cache-')); vi.spyOn(app, 'getPath').mockReturnValue(root); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });
const filename = 'passive.json';
const primary = () => path.join(root, filename);
const disk = () => Object.fromEntries(fs.readdirSync(root).map((name) => { const file = path.join(root, name), stat = fs.statSync(file); return [name, { bytes: fs.readFileSync(file).toString('base64'), ino: stat.ino, mtimeMs: stat.mtimeMs }]; }));
function oldTemp() { const file = path.join(root, `.${filename}.tmp-${process.pid + 100000}-1`); fs.writeFileSync(file, 'leave this alone'); const old = new Date(Date.now() - 3 * 86400000); fs.utimesSync(file, old, old); }
it.each(['missing', 'empty', 'corrupt', 'array', 'large'])('cold inspection remains passive and does not populate the ordinary store cache: %s', (kind) => {
  if (kind === 'empty') fs.writeFileSync(primary(), '{}');
  if (kind === 'corrupt') fs.writeFileSync(primary(), '{broken');
  if (kind === 'array') fs.writeFileSync(primary(), '[]');
  if (kind === 'large') fs.writeFileSync(primary(), JSON.stringify({ content: 'x'.repeat(DISPLAY_SETTINGS_MAX_BYTES) }));
  oldTemp(); const migrate = vi.fn((raw) => raw), onLoad = vi.fn(); const store = createSettingsStore(filename, { enabled: true }, migrate, { onLoad, displaySnapshot: true });
  const before = disk(); expect(store.peekLoaded?.()).toBeUndefined();
  const result = readDisplaySettings(store, filename);
  expect.soft(result.state).toBe(kind === 'missing' || kind === 'empty' ? 'ok' : 'unavailable');
  if (result.state === 'ok') { expect(result.raw).toEqual({}); expect(result.missing).toBe(kind === 'missing'); }
  expect.soft(result.source).toBe('primary'); expect.soft(store.peekLoaded?.()).toBeUndefined();
  expect.soft(migrate).not.toHaveBeenCalled(); expect.soft(onLoad).not.toHaveBeenCalled(); expect.soft(disk()).toEqual(before);
});
it('preserves established host-cache provenance, explicit false and known zero without touching changed files or callbacks', () => {
  fs.writeFileSync(primary(), '{"enabled":false,"limit":0}'); const migrate = vi.fn((raw) => raw), onLoad = vi.fn();
  const store = createSettingsStore(filename, { enabled: true, limit: 10 }, migrate, { onLoad, displaySnapshot: true });
  expect(store.get()).toEqual({ enabled: false, limit: 0 }); oldTemp(); fs.writeFileSync(primary(), '{"enabled":true,"limit":20}');
  const before = disk(), result = readDisplaySettings(store, filename);
  expect(result).toMatchObject({ state: 'ok', source: 'host-cache', missing: false, raw: { enabled: false, limit: 0 } });
  expect(result.observedAt).toBeLessThanOrEqual(Date.now()); expect(migrate).toHaveBeenCalledTimes(1); expect(onLoad).toHaveBeenCalledTimes(1); expect(disk()).toEqual(before);
});
it.each(['corrupt', 'array'])('does not promote recovered/merged defaults from an already loaded %s primary into verified evidence', (kind) => {
  fs.writeFileSync(primary(), kind === 'array' ? '[]' : '{broken');
  const store = createSettingsStore(filename, { enabled: true }, undefined, { displaySnapshot: true }); expect(store.get()).toEqual({ enabled: true });
  oldTemp(); const before = disk(); expect(readDisplaySettings(store, filename)).toMatchObject({ state: 'unavailable', source: 'host-cache' }); expect(disk()).toEqual(before);
});
it('retains explicit accepted-save memory provenance and restores the prior receipt with an ordinary rollback', async () => {
  fs.writeFileSync(primary(), '{"enabled":false}'); const store = createSettingsStore(filename, { enabled: true }, undefined, { rollBackFailedSaves: true, displaySnapshot: true });
  expect(store.get()).toEqual({ enabled: false }); const previous = store.peekLoaded?.();
  let checks = 0;
  const promise = store.save({ enabled: true }, { prepare: async () => {}, check: () => { if (++checks > 1) throw new Error('deliberate refusal before write'); } });
  expect(store.peekLoaded?.()).toMatchObject({ primary: { enabled: true }, origin: 'accepted-save' });
  await expect(promise).rejects.toThrow('deliberate refusal');
  expect.soft(store.peekLoaded?.()).toEqual(previous); expect.soft(readDisplaySettings(store, filename)).toMatchObject({ state: 'ok', source: 'host-cache', raw: { enabled: false } });
  expect(fs.readFileSync(primary(), 'utf8')).toBe('{"enabled":false}');
});

it('does not retain additional raw display snapshots for stores without explicit metadata opt-in', async () => {
  fs.writeFileSync(primary(), '{"privateCredential":"not-display-metadata"}');
  const store = createSettingsStore(filename, {}); store.get(); expect(store.peekLoaded?.()).toBeUndefined();
  await store.save({ privateCredential: 'still-not-display-metadata' }); expect(store.peekLoaded?.()).toBeUndefined();
});

it.each(['value', 'primary', 'raw'] as const)('detaches nested %s objects from the live cache and every later display read', (through) => {
  fs.writeFileSync(primary(), '{"nested":{"enabled":true,"limit":0}}');
  const store = createSettingsStore(filename, { nested: { enabled: true, limit: 10 } }, undefined, { displaySnapshot: true }); store.get(); oldTemp(); const before = disk();
  const peeked = store.peekLoaded!()!; const displayed = readDisplaySettings(store, filename);
  expect(displayed.state).toBe('ok');
  const root = through === 'value' ? peeked.value : through === 'primary' ? peeked.primary : displayed.state === 'ok' ? displayed.raw : {};
  const nested = (root as { nested: { enabled: boolean; limit: number } }).nested; nested.enabled = false; nested.limit = 999;
  expect.soft(store.get()).toEqual({ nested: { enabled: true, limit: 0 } });
  expect.soft(store.peekLoaded?.()?.value).toEqual({ nested: { enabled: true, limit: 0 } });
  expect.soft(readDisplaySettings(store, filename)).toMatchObject({ state: 'ok', raw: { nested: { enabled: true, limit: 0 } } });
  expect.soft(disk()).toEqual(before);
});
it.each(['value', 'primary', 'raw'] as const)('detaches nested %s snapshots from accepted-save state and retained rollback provenance', async (through) => {
  fs.writeFileSync(primary(), '{"nested":{"enabled":true,"limit":0}}');
  const store = createSettingsStore(filename, { nested: { enabled: true, limit: 10 } }, undefined, { displaySnapshot: true, rollBackFailedSaves: true }); store.get();
  const original = store.peekLoaded!()!, originalRaw = readDisplaySettings(store, filename);
  let checks = 0;
  const saving = store.save({ nested: { enabled: false, limit: 1 } }, { prepare: async () => {}, check: () => { if (++checks > 1) throw new Error('deliberate queued refusal'); } });
  const accepted = store.peekLoaded!()!, acceptedRaw = readDisplaySettings(store, filename);
  const select = (snapshot: typeof original, displayed: typeof originalRaw) => through === 'value' ? snapshot.value : through === 'primary' ? snapshot.primary : displayed.state === 'ok' ? displayed.raw : {};
  (select(original, originalRaw) as { nested: { limit: number } }).nested.limit = 888;
  (select(accepted, acceptedRaw) as { nested: { limit: number } }).nested.limit = 999;
  expect.soft(store.get()).toEqual({ nested: { enabled: false, limit: 1 } });
  await expect(saving).rejects.toThrow('deliberate queued refusal');
  expect.soft(store.get()).toEqual({ nested: { enabled: true, limit: 0 } });
  expect.soft(readDisplaySettings(store, filename)).toMatchObject({ state: 'ok', raw: { nested: { enabled: true, limit: 0 } } });
  expect.soft(fs.readFileSync(primary(), 'utf8')).toBe('{"nested":{"enabled":true,"limit":0}}');
});
it('keeps an earlier detached value snapshot stable when ordinary code changes a nested live value', () => {
  fs.writeFileSync(primary(), '{"nested":{"enabled":true}}');
  const store = createSettingsStore(filename, { nested: { enabled: true } }, undefined, { displaySnapshot: true }); store.get();
  const previous = store.peekLoaded!()!; store.get().nested.enabled = false;
  expect(previous.value.nested.enabled).toBe(true);
});
