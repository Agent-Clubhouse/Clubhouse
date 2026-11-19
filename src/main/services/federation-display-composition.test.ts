import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { app } from 'electron';
const side = vi.hoisted(() => ({ effect: vi.fn() }));
vi.mock('fs', async (original) => { const real = await original<typeof import('fs')>(); return { ...real, readFileSync: vi.fn(real.readFileSync) }; });
vi.mock('./annex-network-profile', () => ({ annexEphemeralSession: () => false }));
vi.mock('./annex-settings', () => ({ getSettings: side.effect, networkEnabled: side.effect }));
vi.mock('./annex-identity', () => ({ getIdentity: side.effect, computeFingerprint: side.effect }));
vi.mock('./annex-tls', () => ({ certificateFingerprint: side.effect, sameCertificateFingerprint: side.effect }));
vi.mock('./annex-device-signal', () => ({ devicesChanged: side.effect, onDevicesChanged: side.effect }));
vi.mock('./annex-network-channel', () => ({ broadcast: side.effect, localMember: side.effect, setMembersProvider: side.effect, setSelfPairingProvider: side.effect, setUnknownPeerReasonProvider: side.effect, onNetworkMessage: side.effect }));
vi.mock('./dispatcher/dispatcher-service', () => ({ getDispatcherAgentId: side.effect, dispatcherDisplayName: side.effect, getDispatcherState: side.effect, isDispatcherEnabled: side.effect, onDispatcherChanged: side.effect }));
vi.mock('./log-service', () => ({ appLog: side.effect }));
import { captureOwnPairingForDisplay, ownPairing } from './annex-network-membership';
import { capturePeerPairingForDisplay, readPeerMetadataForDisplay, getPeer, listPeers, resetForTests } from './annex-peers';
import { readFederationControllerForDisplay } from './dispatcher-federation';
import { createFederationRequestStore } from './dispatcher-federation-requests';
import { resetAllSettingsStoresForTests } from './settings-store';
let root: string;
const machine = 'selected-machine', ownID = 'own-pairing-1111', peerID = 'peer-pairing-2222', time = '2026-11-19T21:00:00Z';
const owners = new Set<ReturnType<typeof createFederationRequestStore>>();
const put = (file: string, value: unknown) => fs.promises.writeFile(path.join(root, file), JSON.stringify(value));
const publication = (extra: Record<string, unknown> = {}) => ({ controllers: { [machine]: { name: 'Dispatcher controller', displayName: 'Selected controller', agentId: 'selected-controller', enabled: false, state: 'asleep', ownPairingId: ownID, pairingId: peerID, ...extra } }, PRIVATE_CONFIG: 'PRIVATE_PUB_ROOT' });
const seed = async () => {
  await put('annex-network.json', { removals: [], confirmations: {}, renamedAt: {}, removedNames: {}, selfPairing: { id: ownID, joinedAt: time }, PRIVATE_CONFIG: 'PRIVATE_NETWORK' });
  await put('annex-peers.json', [{ fingerprint: machine, role: 'member', kind: 'desktop', pairingId: peerID, pairedAt: time, alias: 'Selected computer', tlsCertificateFingerprint: 'PRIVATE_PIN', tlsCertificatePem: 'PRIVATE_PEM' }, { fingerprint: 'other-machine', role: 'member', kind: 'desktop', pairingId: 'PRIVATE_OTHER_PAIRING', alias: 'PRIVATE_OTHER_ALIAS' }]);
  await put('dispatcher-federation.json', publication());
  await put('dispatcher-federation-requests.json', { version: 1, requests: [], paused: { [machine]: 'Wait for operator' }, pauseEpochs: { [machine]: { sender: ownID, receiver: peerID } }, crossings: {} });
};
const collect = (store: ReturnType<typeof createFederationRequestStore>) => {
  const receipts: Array<{ current(): boolean }> = [];
  const own = captureOwnPairingForDisplay({ receipts }), peer = capturePeerPairingForDisplay(machine, { receipts });
  const metadata = readPeerMetadataForDisplay(machine, { receipts });
  const controller = readFederationControllerForDisplay(machine, { own, peer, receipts });
  const pause = store.readPauseForDisplay!(machine, { receipts });
  return { own, peer, metadata, controller, pause, receipts };
};
const createStore = () => { const store = createFederationRequestStore(); owners.add(store); return store; };
const disk = async () => Object.fromEntries(await Promise.all((await fs.promises.readdir(root)).sort().map(async (name) => { const file = path.join(root, name), stat = await fs.promises.stat(file); return [name, { bytes: (await fs.promises.readFile(file)).toString('base64'), ino: stat.ino, mtimeMs: stat.mtimeMs }]; })));
beforeEach(async () => { root = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'clubhouse-federation-display-union-'))); vi.spyOn(app, 'getPath').mockReturnValue(root); resetAllSettingsStoresForTests(); resetForTests(); side.effect.mockClear(); vi.mocked(fs.readFileSync).mockClear(); });
afterEach(async () => { owners.clear(); resetAllSettingsStoresForTests(); resetForTests(); vi.restoreAllMocks(); await fs.promises.rm(root, { recursive: true, force: true }); });
it('composes cold actual owners without initializing credentials, membership or request state', async () => {
  await seed(); const store = createStore(), before = await disk(), data = collect(store);
  expect(data.own.state).toBe('unavailable'); expect(data.peer.state).toBe('unavailable'); expect(data.metadata.state).toBe('unavailable'); expect(data.pause.state).toBe('unavailable');
  expect(data.controller).toMatchObject({ state: 'ok', value: { enabled: { value: false }, association: 'unavailable' } });
  expect(data.receipts.every((r) => r.current())).toBe(true); expect(fs.readFileSync).not.toHaveBeenCalled(); expect(side.effect).not.toHaveBeenCalled(); expect(await disk()).toEqual(before);
});
it('composes actual warmed selected association, metadata and established pause without exposing private evidence or writing', async () => {
  await seed(); ownPairing(); listPeers(); const store = createStore(); store.get(); vi.mocked(fs.readFileSync).mockClear(); side.effect.mockClear(); const before = await disk(), data = collect(store);
  expect(data.controller).toMatchObject({ value: { association: 'matched-retained', enabled: { value: false } } });
  expect(data.pause.state).toBe('ok'); if (data.pause.state === 'ok') expect(data.pause.value.appliesToEpoch(data.own, data.peer)).toBe(true);
  expect(data.receipts.every((r) => r.current())).toBe(true); expect.soft(JSON.stringify({ own: data.own, peer: data.peer, metadata: data.metadata, controller: data.controller, pause: data.pause })).not.toMatch(/PRIVATE_|pairing-1111|pairing-2222|sender|receiver|receipts|raw|current/);
  expect(fs.readFileSync).not.toHaveBeenCalled(); expect(side.effect).not.toHaveBeenCalled(); expect(await disk()).toEqual(before);
});
it.each(['own', 'peer-pin', 'peer-epoch', 'selected-alias', 'publication', 'pause', 'reset', 'unrelated'])('retains all actual selected receipts across a later %s edit', async (change) => {
  await seed(); const own = ownPairing()!; listPeers(); const peer = getPeer(machine)!, other = getPeer('other-machine')!; const store = createStore(); store.get(); const data = collect(store);
  expect(data.controller).toMatchObject({ value: { association: 'matched-retained' } }); expect(data.receipts.every((r) => r.current())).toBe(true);
  await Promise.resolve();
  if (change === 'own') own.id = 'own-pairing-replaced';
  if (change === 'peer-pin') peer.tlsCertificateFingerprint = 'PRIVATE_REPLACEMENT_PIN';
  if (change === 'peer-epoch') peer.pairingId = 'peer-pairing-replaced';
  if (change === 'selected-alias') peer.alias = 'Selected renamed';
  if (change === 'publication') await put('dispatcher-federation.json', publication({ agentId: 'replacement-controller' }));
  if (change === 'pause') await store.update((file) => { file.paused[machine] = 'Different selected pause'; });
  if (change === 'reset') { resetAllSettingsStoresForTests(); resetForTests(); }
  if (change === 'unrelated') other.alias = 'PRIVATE_OTHER_CHANGED';
  expect.soft(data.receipts.every((r) => r.current())).toBe(change === 'unrelated');
  if (data.pause.state === 'ok') expect.soft(data.pause.value.appliesToEpoch(data.own, data.peer)).toBe(change === 'unrelated' || change === 'publication' || change === 'selected-alias' ? true : undefined);
  // These are real reader/cache contracts, not a wired endpoint/refusal or transport-authority test.
});
