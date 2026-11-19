import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { app } from 'electron';
vi.mock('fs', async (original) => { const real = await original<typeof import('fs')>(); return { ...real, readFileSync: vi.fn(real.readFileSync) }; });
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
import { readRegisteredFederationPauseForDisplay, setFederationRequestRouter, federationRequestRouter, type FederationRequestRouter } from './dispatcher-federation-policy';
import { createFederatedRequests, createFederationRequestStore, type FederationRequestStore } from './dispatcher-federation-requests';
import type { RequestPauseDisplayReader } from './federation-pause-display';
import { resetAllSettingsStoresForTests } from './settings-store';
let root: string;
const stops: Array<() => void> = [], stores = new Set<ReturnType<typeof createFederationRequestStore>>();
const fail = () => { throw new Error('legacy request operation invoked for display'); };
const fake = (reader?: RequestPauseDisplayReader): FederationRequestRouter => ({ offer: vi.fn(fail), allowed: vi.fn(fail), pauseReason: vi.fn(fail), before: vi.fn(fail), cause: vi.fn(fail), ...(reader && { readPauseForDisplay: reader }) });
const install = (router: FederationRequestRouter) => { const stop = setFederationRequestRouter(router); stops.push(stop); return stop; };
const read = (machine = 'selected-machine') => { const receipts: Array<{ current(): boolean }> = []; return { value: readRegisteredFederationPauseForDisplay(machine, { receipts }), receipts }; };
const unavailable: ReturnType<RequestPauseDisplayReader> = { state: 'unavailable', inputs: [] };
const service = (store: FederationRequestStore) => createFederatedRequests({ store } as never); // Other lifecycle/transport dependencies deliberately absent: this path must not call them.
const seed = () => fs.promises.writeFile(path.join(root, 'dispatcher-federation-requests.json'), JSON.stringify({ version: 1, requests: [], paused: { 'selected-machine': 'Wait for operator' }, pauseEpochs: {}, crossings: {}, PRIVATE_CONFIG: 'PRIVATE_CREDENTIAL' }));
const disk = async () => Object.fromEntries(await Promise.all((await fs.promises.readdir(root)).sort().map(async (name) => [name, (await fs.promises.readFile(path.join(root, name))).toString('base64')])));
beforeEach(async () => { root = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'clubhouse-pause-router-'))); vi.spyOn(app, 'getPath').mockReturnValue(root); resetAllSettingsStoresForTests(); vi.mocked(fs.readFileSync).mockClear(); });
afterEach(async () => { for (const stop of stops.splice(0)) stop(); stores.clear(); resetAllSettingsStoresForTests(); vi.restoreAllMocks(); await fs.promises.rm(root, { recursive: true, force: true }); });
it('keeps absent or old-capability routers unknown and never falls back to permission or pauseReason', () => {
  expect(read().value.state).toBe('unavailable'); const router = fake(); install(router); const result = read(); expect(result.value.state).toBe('unavailable'); expect(result.receipts[0].current()).toBe(true); expect(router.allowed).not.toHaveBeenCalled(); expect(router.pauseReason).not.toHaveBeenCalled(); expect(router.offer).not.toHaveBeenCalled();
});
it('forwards only the installed passive callback and preserves ordinary router identity', () => {
  const reader = vi.fn(() => unavailable), router = fake(reader); install(router); expect(federationRequestRouter()).toBe(router); const result = read(); expect(result.value).toBe(unavailable); expect(reader).toHaveBeenCalledOnce(); expect(reader.mock.calls[0][0]).toBe('selected-machine'); expect(result.receipts[0].current()).toBe(true); expect(router.allowed).not.toHaveBeenCalled(); expect(router.pauseReason).not.toHaveBeenCalled();
});
it.each(['replacement', 'stop', 'same-callback-new-router', 'property-replacement'])('keeps an independent installation receipt through %s', (change) => {
  const reader = vi.fn(() => unavailable), router = fake(reader), stop = install(router), result = read(); expect(result.receipts[0].current()).toBe(true);
  if (change === 'stop') stop(); else if (change === 'property-replacement') router.readPauseForDisplay = vi.fn(() => unavailable); else install(fake(change === 'same-callback-new-router' ? reader : vi.fn(() => unavailable)));
  expect(result.receipts[0].current()).toBe(false);
  if (change === 'property-replacement') { expect(read().value).toMatchObject({ state: 'unavailable', reason: 'changed' }); expect(router.readPauseForDisplay).not.toHaveBeenCalled(); }
});
it('withholds a callback result if the router changes inside that callback', () => {
  const reader = vi.fn(() => { install(fake()); return { state: 'ok' as const, inputs: [], value: { recorded: true, reason: { state: 'ok' as const, text: 'PRIVATE_STALE_RESULT', truncated: false }, scope: 'all-pairings' as const, appliesToEpoch: () => true } }; });
  install(fake(reader)); const result = read(); expect.soft(result.value).toMatchObject({ state: 'unavailable', reason: 'changed' }); expect.soft(JSON.stringify(result.value)).not.toContain('PRIVATE_'); expect(result.receipts[0].current()).toBe(false);
});
it('returns explicit unavailable error without leaking callback errors or consulting legacy controls', () => {
  const router = fake(() => { throw new Error('PRIVATE_CALLBACK_ERROR'); }); install(router); const result = read(); expect(result.value).toMatchObject({ state: 'unavailable', reason: 'unreadable' }); expect(JSON.stringify(result.value)).not.toContain('PRIVATE_'); expect(router.allowed).not.toHaveBeenCalled();
});
it('does not execute an accessor when looking for optional router display support', () => {
  const getter = vi.fn(fail), router = fake(); Object.defineProperty(router, 'readPauseForDisplay', { configurable: true, get: getter }); install(router); expect(read().value.state).toBe('unavailable'); expect(getter).not.toHaveBeenCalled();
});
it('stopping an earlier distinct registration does not invalidate the current source', () => { const oldStop = install(fake()), current = fake(vi.fn(() => unavailable)); install(current); const result = read(); oldStop(); expect(federationRequestRouter()).toBe(current); expect(result.receipts[0].current()).toBe(true); });
it.each(['', 'x'.repeat(201), null])('does not invoke a reader or retain invalid selected key %s', (key) => { const reader = vi.fn(() => unavailable); install(fake(reader)); const result = read(key as string); expect(result.value).toMatchObject({ state: 'unavailable', reason: 'invalid' }); expect(result.receipts).toHaveLength(0); expect(reader).not.toHaveBeenCalled(); });
it('leaves old/custom store service metadata unknown without get/ready/update or later adapter adoption', () => {
  const store = { get: vi.fn(fail), ready: vi.fn(fail), update: vi.fn(fail) }, instance = service(store); const reader = vi.fn(() => unavailable); Object.assign(store, { readPauseForDisplay: reader }); install(fake(instance.readPauseForDisplay)); expect(read().value.state).toBe('unavailable'); expect(store.get).not.toHaveBeenCalled(); expect(store.ready).not.toHaveBeenCalled(); expect(store.update).not.toHaveBeenCalled(); expect(reader).not.toHaveBeenCalled();
});
it('captures optional service adapter without invoking store accessors', () => { const getter = vi.fn(fail), store = { get: vi.fn(fail), ready: vi.fn(fail), update: vi.fn(fail) }; Object.defineProperty(store, 'readPauseForDisplay', { get: getter }); const instance = service(store); install(fake(instance.readPauseForDisplay)); expect(read().value.state).toBe('unavailable'); expect(getter).not.toHaveBeenCalled(); expect(store.get).not.toHaveBeenCalled(); });
it('uses the actual cold store adapter without triggering reads, initialization or repair', async () => { await seed(); const store = createFederationRequestStore(); stores.add(store); const before = await disk(), instance = service(store); install(fake(instance.readPauseForDisplay)); const result = read(); expect(result.value.state).toBe('unavailable'); expect(result.receipts.every((r) => r.current())).toBe(true); expect(fs.readFileSync).not.toHaveBeenCalled(); expect(await disk()).toEqual(before); });
it('retains both actual selected logical-cache and router receipts through a later pause update', async () => {
  await seed(); const store = createFederationRequestStore(); stores.add(store); store.get(); const instance = service(store); install(fake(instance.readPauseForDisplay)); vi.mocked(fs.readFileSync).mockClear(); const before = await disk(), result = read();
  expect(result.value).toMatchObject({ state: 'ok', value: { recorded: true, reason: { text: 'Wait for operator' } } }); expect(result.receipts).toHaveLength(2); expect(result.receipts.every((r) => r.current())).toBe(true); expect(JSON.stringify(result.value)).not.toMatch(/PRIVATE_|receipts|requests|raw/); expect(fs.readFileSync).not.toHaveBeenCalled(); expect(await disk()).toEqual(before);
  await store.update((file) => { file.paused['selected-machine'] = 'Changed selected reason'; });
  expect(result.receipts[0].current()).toBe(true); expect(result.receipts[1].current()).toBe(false); if (result.value.state === 'ok') expect(result.value.value.appliesToEpoch({ matches: () => true }, { matches: () => true })).toBeUndefined();
});
