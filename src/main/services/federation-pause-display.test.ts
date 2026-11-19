import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { app } from 'electron';
vi.mock('fs', async (original) => { const real = await original<typeof import('fs')>(); return { ...real, readFileSync: vi.fn(real.readFileSync) }; });
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./dispatcher-federation-policy', () => ({ federationStatusChanged: vi.fn() }));
import { appLog } from './log-service';
import { federationStatusChanged } from './dispatcher-federation-policy';
import { createFederationRequestStore, LEGACY_RATE_PAUSE } from './dispatcher-federation-requests';
import { PAUSE_DISPLAY_SCAN_TEXT } from './federation-pause-display';
import { resetAllSettingsStoresForTests } from './settings-store';
let root: string;
const filename = 'dispatcher-federation-requests.json', machine = 'selected-machine', epoch = { sender: 'own-pairing-1111', receiver: 'peer-pairing-2222' };
const privateRequest = { id: 'PRIVATE_OTHER_REQUEST', machineId: 'other-machine', callerId: 'other', targetId: 'elsewhere', text: 'PRIVATE_REQUEST_BODY', originRequestId: 'PRIVATE_ORIGIN', origin: { agentId: 'other', machineId: 'other-machine' }, epoch, cause: { rootId: 'PRIVATE_CAUSE', depth: 0 }, createdAt: 1, expiresAt: 2, direction: 'incoming', delivery: 'accepted', outcome: 'under_way' };
const put = (paused: unknown = { [machine]: 'Wait for the operator' }, pauseEpochs: unknown = { [machine]: epoch }) => fs.promises.writeFile(path.join(root, filename), JSON.stringify({ version: 1, requests: [privateRequest], paused, pauseEpochs, crossings: {}, PRIVATE_CONFIG: 'PRIVATE_CREDENTIAL' }));
const disk = async () => Object.fromEntries(await Promise.all((await fs.promises.readdir(root)).sort().map(async (name) => { const f = path.join(root, name), s = await fs.promises.stat(f); return [name, { bytes: (await fs.promises.readFile(f)).toString('base64'), ino: s.ino, mtimeMs: s.mtimeMs }]; })));
const selected = (store: ReturnType<typeof createFederationRequestStore>, key = machine) => { const receipts: Array<{ current(): boolean }> = []; return { value: store.readPauseForDisplay!(key, { receipts }), receipts }; };
const match = (expected: string) => ({ matches: (value: unknown) => value === expected });
const unknown = { matches: () => undefined };
beforeEach(async () => { root = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'clubhouse-pause-display-'))); vi.spyOn(app, 'getPath').mockReturnValue(root); resetAllSettingsStoresForTests(); vi.mocked(fs.readFileSync).mockClear(); vi.mocked(appLog).mockClear(); vi.mocked(federationStatusChanged).mockClear(); });
afterEach(async () => { resetAllSettingsStoresForTests(); vi.restoreAllMocks(); await fs.promises.rm(root, { recursive: true, force: true }); });
it.each(['valid', 'corrupt', 'missing', 'backup-only'])('does not initialize/repair/clone requests or touch cold %s files for selected pause display', async (kind) => {
  if (kind === 'valid') await put(); if (kind === 'corrupt') await fs.promises.writeFile(path.join(root, filename), '{broken');
  if (kind === 'backup-only') await fs.promises.writeFile(path.join(root, filename + '.bak'), '{"version":1,"requests":[],"paused":{},"crossings":{}}');
  const temp = path.join(root, `.${filename}.tmp-${process.pid + 100000}-1`); await fs.promises.writeFile(temp, 'retain'); const old = new Date(Date.now() - 3 * 86400000); await fs.promises.utimes(temp, old, old);
  const store = createFederationRequestStore(), before = await disk(), get = vi.spyOn(store, 'get'), ready = vi.spyOn(store, 'ready'), update = vi.spyOn(store, 'update'), clone = vi.spyOn(globalThis, 'structuredClone');
  const result = selected(store);
  expect.soft(result.value.state).toBe('unavailable'); expect.soft(result.receipts[0].current()).toBe(true);
  expect.soft(get).not.toHaveBeenCalled(); expect.soft(ready).not.toHaveBeenCalled(); expect.soft(update).not.toHaveBeenCalled(); expect.soft(clone).not.toHaveBeenCalled(); expect.soft(fs.readFileSync).not.toHaveBeenCalled(); expect.soft(appLog).not.toHaveBeenCalled(); expect.soft(federationStatusChanged).not.toHaveBeenCalled(); expect.soft(await disk()).toEqual(before);
});
it('keeps only selected bounded pause fields from an established logical cache, without raw request/root/epoch exposure or cloning', async () => {
  await put({ [machine]: 'Wait for the operator', other: 'PRIVATE_OTHER_PAUSE' }); const store = createFederationRequestStore(); store.get(); vi.mocked(fs.readFileSync).mockClear();
  const before = await disk(), get = vi.spyOn(store, 'get'), clone = vi.spyOn(globalThis, 'structuredClone'), result = selected(store);
  expect(result.value.state).toBe('ok');
  if (result.value.state === 'ok') {
    expect(result.value.value).toMatchObject({ recorded: true, reason: { state: 'ok', text: 'Wait for the operator', truncated: false }, scope: 'pairing' });
    expect(result.value.value.appliesToEpoch(match(epoch.sender), match(epoch.receiver))).toBe(true);
    expect(result.value.value.appliesToEpoch(match('different'), unknown)).toBe(false); expect(result.value.value.appliesToEpoch(unknown, match(epoch.receiver))).toBeUndefined();
  }
  expect.soft(JSON.stringify(result.value)).not.toMatch(/PRIVATE_|pairing-1111|pairing-2222|sender|receiver|requests|paused|crossings|raw/);
  expect.soft(result.receipts[0].current()).toBe(true); expect.soft(get).not.toHaveBeenCalled(); expect.soft(clone).not.toHaveBeenCalled(); expect.soft(fs.readFileSync).not.toHaveBeenCalled(); expect.soft(await disk()).toEqual(before);
});
it.each(['none', 'unscoped', 'invalid-epoch', 'extra-epoch-field', 'invalid-pause', 'invalid-map'])('preserves no-pause/unknown/scope semantics for %s', async (kind) => {
  await put(kind === 'none' ? {} : kind === 'invalid-pause' ? { [machine]: 42 } : kind === 'invalid-map' ? [] : { [machine]: 'Wait' }, kind === 'unscoped' ? undefined : { [machine]: kind === 'invalid-epoch' ? { sender: 'bad' } : kind === 'extra-epoch-field' ? { ...epoch, PRIVATE_EXTRA: 'PRIVATE_SECRET' } : epoch });
  if (kind === 'unscoped') await fs.promises.writeFile(path.join(root, filename), JSON.stringify({ version: 1, requests: [], paused: { [machine]: 'Wait' }, crossings: {} }));
  const store = createFederationRequestStore(); store.get(); const result = selected(store);
  expect(result.value.state).toBe(kind === 'invalid-pause' || kind === 'invalid-map' ? 'unavailable' : 'ok');
  if (result.value.state === 'ok') {
    expect.soft(result.value.value.appliesToEpoch(unknown, unknown)).toBe(kind === 'none' ? false : kind === 'unscoped' ? true : undefined);
    expect.soft(result.value.value.appliesToEpoch(match(epoch.sender), match(epoch.receiver))).toBe(kind === 'none' ? false : kind === 'unscoped' ? true : undefined);
  }
  expect(JSON.stringify(result.value)).not.toContain('PRIVATE_');
});
it.each(['safe', 'withheld', 'truncated', 'oversized'])('reuses the reviewed selected-text policy for %s reason before truncation', async (kind) => {
  const reason = kind === 'safe' ? 'Wait for selected review' : kind === 'withheld' ? 'const apiKey = ("PRIVATE_VALUE");' : kind === 'truncated' ? 'x'.repeat(3000) : ' '.repeat(PAUSE_DISPLAY_SCAN_TEXT + 1);
  await put({ [machine]: reason }); const store = createFederationRequestStore(); store.get(); const trim = vi.spyOn(String.prototype, 'trim'), result = selected(store); const trimCallsBeforeAssertions = trim.mock.calls.length;
  expect(result.value.state).toBe('ok');
  if (result.value.state === 'ok') expect.soft(result.value.value.reason).toMatchObject(kind === 'safe' ? { state: 'ok', text: reason, truncated: false } : kind === 'truncated' ? { state: 'ok', truncated: true } : { state: 'withheld', reason: kind === 'oversized' ? 'read-limit' : 'safety' });
  expect.soft(JSON.stringify(result.value)).not.toContain('PRIVATE_'); if (kind === 'oversized') expect.soft(trimCallsBeforeAssertions).toBe(0);
});
it.each(['reason', 'epoch', 'cleared', 'hidden-source', 'unrelated'])('retains private selected logical-cache receipts through explicit %s updates', async (kind) => {
  await put({ [machine]: 'apiKey="PRIVATE_FIRST"' }); const store = createFederationRequestStore(); store.get(); const result = selected(store); expect(result.value.state).toBe('ok'); expect(result.receipts[0].current()).toBe(true);
  await store.update((file) => { if (kind === 'reason') file.paused[machine] = 'Different reason'; if (kind === 'hidden-source') file.paused[machine] = 'apiKey="PRIVATE_OTHER"'; if (kind === 'epoch') file.pauseEpochs![machine] = { ...epoch, receiver: 'peer-pairing-3333' }; if (kind === 'cleared') delete file.paused[machine]; file.paused.other = 'PRIVATE_UNRELATED_UPDATE'; });
  expect.soft(result.receipts[0].current()).toBe(kind === 'unrelated');
  if (result.value.state === 'ok') expect.soft(result.value.value.appliesToEpoch(match(epoch.sender), match(epoch.receiver))).toBe(kind === 'unrelated' ? true : undefined);
  expect.soft(JSON.stringify(result.value)).not.toMatch(/PRIVATE_|pairing-1111|pairing-2222/);
});
it('does not consume pending legacy-repair state or change its ordinary later ready behavior', async () => {
  await put({ [machine]: LEGACY_RATE_PAUSE }); const store = createFederationRequestStore(); store.get(); const before = await disk();
  expect(selected(store).value).toMatchObject({ state: 'ok', value: { recorded: false, reason: null, scope: 'none' } }); expect(await disk()).toEqual(before); expect(federationStatusChanged).not.toHaveBeenCalled();
  await store.ready?.(); expect(JSON.parse(await fs.promises.readFile(path.join(root, filename), 'utf8')).paused).toEqual({}); expect(federationStatusChanged).toHaveBeenCalled();
});
it.each(['empty', 'oversized'])('does not capture invalid selected machine keys: %s', (kind) => {
  const store = createFederationRequestStore(), receipts: Array<{ current(): boolean }> = [], result = store.readPauseForDisplay!(kind === 'empty' ? '' : 'x'.repeat(201), { receipts });
  expect(result.state).toBe('unavailable'); expect(receipts).toHaveLength(0);
});

it('detaches returned display fields while preserving private epoch matching and fresh selected-cache projections', async () => {
  await put(); const store = createFederationRequestStore(); store.get(); const result = selected(store);
  expect(result.value.state).toBe('ok');
  if (result.value.state === 'ok') {
    result.value.value.scope = 'all-pairings'; result.value.value.recorded = false;
    if (result.value.value.reason?.state === 'ok') result.value.value.reason.text = 'Changed caller copy';
    expect(result.value.value.appliesToEpoch(unknown, unknown)).toBeUndefined();
  }
  expect(selected(store).value).toMatchObject({ state: 'ok', value: { recorded: true, scope: 'pairing', reason: { state: 'ok', text: 'Wait for the operator' } } });
});
