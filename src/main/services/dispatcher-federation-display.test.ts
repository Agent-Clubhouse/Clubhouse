import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { app } from 'electron';
const owners = vi.hoisted(() => ({ store: undefined as { get(): { controllers: Record<string, Record<string, unknown>> } } | undefined, peers: vi.fn(() => [{ fingerprint: 'selected-machine', role: 'member', kind: 'desktop', pairingId: 'peer-pairing' }]), own: vi.fn(() => ({ id: 'own-pairing' })) }));
vi.mock('fs', async (original) => { const real = await original<typeof import('fs')>(); return { ...real, readFileSync: vi.fn(real.readFileSync), readSync: vi.fn(real.readSync), writeFileSync: vi.fn(real.writeFileSync), renameSync: vi.fn(real.renameSync) }; });
vi.mock('./settings-store', async (original) => { const actual = await original<typeof import('./settings-store')>(); return { ...actual, createSettingsStore: (...args: Parameters<typeof actual.createSettingsStore>) => { const store = actual.createSettingsStore(...args); if (args[0] === 'dispatcher-federation.json') owners.store = store as never; return store; } }; });
vi.mock('./annex-peers', () => ({ listPeers: owners.peers }));
vi.mock('./annex-network-membership', () => ({ ownPairing: owners.own }));
vi.mock('./dispatcher/dispatcher-service', () => ({ getDispatcherAgentId: vi.fn(), dispatcherDisplayName: vi.fn(), getDispatcherState: vi.fn(), isDispatcherEnabled: vi.fn(), onDispatcherChanged: vi.fn() }));
vi.mock('./annex-device-signal', () => ({ onDevicesChanged: vi.fn(), devicesChanged: vi.fn() }));
import { readFederationControllerForDisplay, remoteFederationController, federationDisplayName } from './dispatcher-federation';
import { resetAllSettingsStoresForTests } from './settings-store';
let root: string;
const filename = 'dispatcher-federation.json';
const controller = (extra: Record<string, unknown> = {}) => ({ agentId: 'selected-controller', name: 'Dispatcher controller', displayName: 'Selected controller', enabled: false, state: 'asleep', ownPairingId: 'own-pairing', pairingId: 'peer-pairing', PRIVATE_CONFIGURATION: 'PRIVATE_SELECTED_CONFIG', ...extra });
const put = (selected: unknown = controller()) => fs.promises.writeFile(path.join(root, filename), JSON.stringify({ controllers: { 'selected-machine': selected, 'other-machine': controller({ name: 'PRIVATE_OTHER_NAME', agentId: 'PRIVATE_OTHER_ID' }) }, privateRoot: 'PRIVATE_ROOT' }));
const disk = async () => Object.fromEntries(await Promise.all((await fs.promises.readdir(root)).sort().map(async (name) => { const f = path.join(root, name), stat = await fs.promises.stat(f); return [name, { bytes: (await fs.promises.readFile(f)).toString('base64'), ino: stat.ino, mtimeMs: stat.mtimeMs }]; })));
const match = (id: string) => ({ matches: vi.fn((v: unknown): boolean | undefined => v === id) });
const read = (machine = 'selected-machine', own = match('own-pairing'), peer = match('peer-pairing')) => { const receipts: Array<{ current(): boolean }> = []; return { value: readFederationControllerForDisplay(machine, { own, peer, receipts }), receipts, own, peer }; };
const clear = () => { owners.peers.mockClear(); owners.own.mockClear(); vi.mocked(fs.readFileSync).mockClear(); vi.mocked(fs.readSync).mockClear(); vi.mocked(fs.writeFileSync).mockClear(); vi.mocked(fs.renameSync).mockClear(); };
const passive = () => { expect.soft(owners.peers).not.toHaveBeenCalled(); expect.soft(owners.own).not.toHaveBeenCalled(); expect.soft(fs.writeFileSync).not.toHaveBeenCalled(); expect.soft(fs.renameSync).not.toHaveBeenCalled(); };
beforeEach(async () => { root = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'clubhouse-controller-display-'))); vi.spyOn(app, 'getPath').mockReturnValue(root); resetAllSettingsStoresForTests(); clear(); });
afterEach(async () => { resetAllSettingsStoresForTests(); vi.restoreAllMocks(); await fs.promises.rm(root, { recursive: true, force: true }); });
it('reads only bounded selected primary fields without initializing controller, membership or credential services', async () => {
  await put(); const before = await disk(), { value, receipts } = read('SELECTED-MACHINE');
  expect.soft(value).toMatchObject({ state: 'ok', inputs: [{ source: 'primary' }], value: { agentId: { value: 'selected-controller' }, name: { value: 'Selected controller' }, enabled: { value: false }, presence: { value: 'asleep' }, association: 'matched-retained' } });
  expect.soft(JSON.stringify(value)).not.toMatch(/PRIVATE_|own-pairing|peer-pairing|receipts|current|tls|publicKey/); expect.soft(receipts[0].current()).toBe(true); passive(); expect.soft(await disk()).toEqual(before);
  await put(controller({ displayName: 'Changed primary' })); expect(read().value).toMatchObject({ value: { name: { value: 'Changed primary' } } }); // Prior display did not warm the ordinary cache.
});
it.each(['corrupt', 'missing', 'backup-only', 'oversized', 'invalid-root', 'invalid-controllers', 'invalid-selected', 'absent'])('preserves unknown %s metadata and actual disk without recovery or temp sweep', async (kind) => {
  if (kind === 'corrupt') await fs.promises.writeFile(path.join(root, filename), '{broken');
  if (kind === 'oversized') await fs.promises.writeFile(path.join(root, filename), JSON.stringify({ controllers: { 'selected-machine': controller() }, padding: 'x'.repeat(256 * 1024) }));
  if (kind.startsWith('invalid') || kind === 'absent') await fs.promises.writeFile(path.join(root, filename), JSON.stringify(kind === 'invalid-root' ? [] : kind === 'invalid-controllers' ? { controllers: [] } : kind === 'absent' ? { controllers: { 'other-machine': controller({ agentId: 'PRIVATE_OTHER_ID', displayName: 'PRIVATE_OTHER_NAME' }) } } : { controllers: { 'selected-machine': [] } }));
  await fs.promises.writeFile(path.join(root, filename + '.bak'), JSON.stringify({ controllers: { 'selected-machine': controller() } }));
  const temp = path.join(root, `.${filename}.tmp-${process.pid + 100000}-1`); await fs.promises.writeFile(temp, 'keep'); const old = new Date(Date.now() - 3 * 86400000); await fs.promises.utimes(temp, old, old);
  const before = await disk(), { value, receipts } = read(); expect.soft(value.state).toBe('unavailable'); expect.soft(receipts[0].current()).toBe(true); expect.soft(JSON.stringify(value)).not.toMatch(/PRIVATE_|selected-controller|Selected controller/); passive(); expect.soft(await disk()).toEqual(before);
  if (kind === 'oversized') expect.soft(fs.readSync).not.toHaveBeenCalled();
});
it('keeps warmed memory provenance distinct from changed primary evidence without another read or credential lookup', async () => {
  await put(); expect(remoteFederationController('selected-machine')?.displayName).toBe('Selected controller'); await put(controller({ enabled: true, displayName: 'New on disk' })); clear(); const before = await disk(), { value, receipts } = read();
  expect.soft(value).toMatchObject({ state: 'ok', inputs: [{ source: 'host-cache' }], value: { name: { value: 'Selected controller' }, enabled: { value: false } } }); expect.soft(receipts[0].current()).toBe(true); expect.soft(fs.readSync).not.toHaveBeenCalled(); expect.soft(fs.readFileSync).not.toHaveBeenCalled(); passive(); expect.soft(await disk()).toEqual(before);
});
it.each(['agent', 'name', 'enabled', 'presence', 'own-epoch', 'peer-epoch', 'remove', 'unrelated', 'private-only'])('retains selected publication receipt through later %s edits', async (change) => {
  await put(); const { value, receipts } = read(); expect(value.state).toBe('ok'); expect(receipts[0].current()).toBe(true);
  const selected = controller(change === 'agent' ? { agentId: 'replacement-controller' } : change === 'name' ? { displayName: 'Replacement' } : change === 'enabled' ? { enabled: true } : change === 'presence' ? { state: 'working' } : change === 'own-epoch' ? { ownPairingId: 'own-replaced' } : change === 'peer-epoch' ? { pairingId: 'peer-replaced' } : change === 'private-only' ? { PRIVATE_CONFIGURATION: 'PRIVATE_CHANGED' } : {});
  if (change === 'remove') await fs.promises.unlink(path.join(root, filename)); else await put(selected);
  if (change === 'unrelated') { const raw = JSON.parse(await fs.promises.readFile(path.join(root, filename), 'utf8')); raw.controllers['other-machine'].displayName = 'PRIVATE_OTHER_CHANGED'; await fs.promises.writeFile(path.join(root, filename), JSON.stringify(raw)); }
  expect.soft(receipts[0].current()).toBe(change === 'unrelated' || change === 'private-only'); passive();
});
it.each(['own-missing', 'peer-missing', 'legacy', 'own-unknown', 'peer-unknown', 'mismatch'])('distinguishes %s association without default legacy/current inference', async (kind) => {
  await put(controller(kind === 'own-missing' ? { ownPairingId: undefined } : kind === 'peer-missing' ? { pairingId: undefined } : kind === 'legacy' ? { ownPairingId: 'legacy', pairingId: 'legacy' } : {}));
  const own = kind === 'own-unknown' ? { matches: vi.fn(() => undefined) } : match(kind === 'mismatch' ? 'different-own' : 'own-pairing'); const peer = kind === 'peer-unknown' ? { matches: vi.fn(() => undefined) } : match('peer-pairing');
  const result = read('selected-machine', own, peer); expect(result.value).toMatchObject({ state: 'ok', value: { enabled: { value: false }, association: kind === 'mismatch' ? 'mismatch' : 'unavailable' } });
  if (kind.endsWith('missing') || kind === 'legacy') { expect(own.matches).not.toHaveBeenCalled(); expect(peer.matches).not.toHaveBeenCalled(); } passive();
});
it('refuses a changed publication during private association callbacks', async () => {
  await put(); const own = { matches: vi.fn(() => { fs.writeFileSync(path.join(root, filename), JSON.stringify({ controllers: { 'selected-machine': controller({ agentId: 'replacement-controller' }) } })); return true; }) };
  const result = read('selected-machine', own); expect(result.value).toMatchObject({ state: 'unavailable', reason: 'changed' }); expect(result.receipts[0].current()).toBe(false);
});
it('does not fabricate old-host presence or hide independent false/null values when fields are malformed', async () => {
  await put(controller({ agentId: null, displayName: {}, state: undefined })); const { value } = read(); expect(value).toMatchObject({ state: 'ok', value: { agentId: { state: 'ok', value: null }, name: { state: 'unavailable' }, enabled: { state: 'ok', value: false }, presence: { state: 'unavailable' } } });
});
it('uses the same pure local name fallback and detaches returned field objects', async () => {
  const selected = controller({ displayName: undefined }); await put(selected); const { value } = read(); expect(value).toMatchObject({ value: { name: { value: federationDisplayName(selected) } } });
  if (value.state === 'ok' && value.value.name.state === 'ok') value.value.name.value = 'Caller edit'; expect(read().value).toMatchObject({ value: { name: { value: federationDisplayName(selected) } } }); passive();
});
it.each(['', 'x'.repeat(257), null])('does not read or retain invalid selected key %s', (key) => {
  const { value, receipts } = read(key as string); expect(value.state).toBe('unavailable'); expect(receipts).toHaveLength(0); expect(fs.readSync).not.toHaveBeenCalled(); expect(fs.readFileSync).not.toHaveBeenCalled(); passive();
});

it.each(['name', 'enabled', 'epoch', 'reset'])('rechecks real selected warm owner cache after late %s mutation', async (change) => {
  await put(); remoteFederationController('selected-machine'); clear(); const { receipts } = read(); expect(receipts[0].current()).toBe(true);
  const selected = owners.store!.get().controllers['selected-machine'];
  if (change === 'name') selected.displayName = 'Warm replacement';
  if (change === 'enabled') selected.enabled = true;
  if (change === 'epoch') selected.ownPairingId = 'own-replaced';
  if (change === 'reset') { resetAllSettingsStoresForTests(); await fs.promises.unlink(path.join(root, filename)); }
  expect.soft(receipts[0].current()).toBe(false); passive();
});
it.each(['name', 'agent', 'presence', 'epoch'])('withholds malformed oversized selected %s field without adopting unrelated values', async (field) => {
  await put(controller(field === 'name' ? { displayName: 'x'.repeat(201) } : field === 'agent' ? { agentId: 'x'.repeat(201) } : field === 'presence' ? { state: 'unexpected' } : { ownPairingId: 'x'.repeat(65) }));
  const { value, own } = read(); expect(value.state).toBe('ok');
  if (value.state === 'ok') { if (field === 'epoch') { expect(value.value.association).toBe('unavailable'); expect(own.matches).not.toHaveBeenCalled(); } else expect(value.value[field === 'agent' ? 'agentId' : field].state).toBe('unavailable'); expect(value.value.enabled).toMatchObject({ state: 'ok', value: false }); }
  passive();
});
