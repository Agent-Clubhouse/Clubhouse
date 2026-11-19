/** In-process peers, using real peer persistence, device signals and federation
 * watchers. The transport models the authenticated connections route's lastSeen
 * refresh and controller learning; TLS/HTTP authorization has its own suites. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnnexPeer } from '../../shared/types';

vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./annex-network-profile', () => ({ annexEphemeralSession: () => false }));
vi.mock('./annex-network-membership', () => ({ ownPairing: () => ({ id: 'pairing' }) }));
vi.mock('./dispatcher/dispatcher-service', () => ({
  getDispatcherAgentId: () => 'controller', isDispatcherEnabled: () => true,
  getDispatcherState: () => ({ workRunning: true, requestsUnderWay: 0 }),
  dispatcherDisplayName: () => 'Dispatcher', onDispatcherChanged: () => () => {},
}));
const controller = { agentId: 'controller', name: 'Dispatcher controller', enabled: true };
const member = (id: string): AnnexPeer => ({ fingerprint: id, alias: id, role: 'member', kind: 'desktop',
  publicKey: id, icon: 'computer', color: 'indigo', pairedAt: '2026-11-01T00:00:00.000Z', lastSeen: '2026-11-01T00:00:00.000Z' });
let base: string;
let cleanups: Array<() => void>;
let queue: Array<() => Promise<void>>;
beforeEach(() => {
  vi.useFakeTimers();
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'annex-sync-feedback-'));
  cleanups = []; queue = [];
});
afterEach(() => {
  for (const stop of cleanups) stop();
  vi.useRealTimers();
  fs.rmSync(base, { recursive: true, force: true });
});
async function endpoint(id: string, other: string, legacy = false) {
  const userData = path.join(base, id);
  fs.mkdirSync(userData);
  vi.resetModules();
  vi.doMock('electron', () => ({ app: { getPath: () => userData, isPackaged: false } }));
  const peers = await import('./annex-peers');
  const signal = await import('./annex-device-signal');
  const federation = await import('./dispatcher-federation');
  peers.addPeer(member(other));
  await federation.learnFederationController(other, controller);
  const ui = vi.fn(); const presence = vi.fn();
  signal.onDevicesChanged(ui); signal.onDevicePresenceChanged(presence);
  let send: () => Promise<void> = async () => {};
  const resync = vi.fn(() => { queue.push(send); });
  // Older peers resync on every device notification, including lastSeen.
  const stop = legacy ? signal.onDevicesChanged(resync) : federation.watchFederation(resync);
  cleanups.push(stop, signal.resetDeviceSignalForTests);
  return { peers, signal, federation, ui, presence, resync,
    sendTo(receive: () => Promise<void>) { send = receive; },
    async receive() {
      peers.updateLastSeen(other);
      await federation.learnFederationController(other, controller);
    },
  };
}
async function drain() {
  // Bound the run: the old feedback loop would keep adding work forever.
  for (let round = 0; round < 8; round++) {
    const pending = queue.splice(0);
    for (const receive of pending) await receive();
    await vi.advanceTimersByTimeAsync(60);
  }
  expect(queue).toHaveLength(0);
}
describe('Annex connection sync feedback', () => {
  it.each([false, true])('an incoming sync settles with legacy remote=%s while presence and timestamps still update', async (legacy) => {
    const a = await endpoint('a', 'b'); const b = await endpoint('b', 'a', legacy);
    a.sendTo(b.receive); b.sendTo(a.receive);
    const receivedAt = new Date().toISOString();
    await a.receive();
    await drain();
    expect(a.resync).not.toHaveBeenCalled();
    expect(b.resync).not.toHaveBeenCalled();
    expect(a.ui).toHaveBeenCalledWith('last-seen');
    expect(a.presence).toHaveBeenCalled();
    a.peers.resetForTests();
    expect(a.peers.getPeer('b')?.lastSeen).toBe(receivedAt);
    // A genuine local change reaches the other machine. Its old implementation
    // may echo once, but the upgraded endpoint ends that echo.
    const changedAt = new Date().toISOString();
    a.peers.setTypedHost('b', 'new-host');
    await drain();
    expect(a.resync).toHaveBeenCalledTimes(1);
    expect(b.resync).toHaveBeenCalledTimes(legacy ? 1 : 0);
    expect(b.peers.getPeer('a')?.lastSeen).toBe(new Date(Date.parse(changedAt) + 60).toISOString());
  });

  it('propagates controller changes while confirmed-contact timestamps alone stay quiet', async () => {
    const a = await endpoint('a', 'b'); const b = await endpoint('b', 'a');
    a.sendTo(b.receive); b.sendTo(a.receive);
    a.peers.recordLastSeen('B', new Date());
    b.peers.recordLastSeen('A', new Date());
    await drain();
    expect(a.resync).not.toHaveBeenCalled(); expect(b.resync).not.toHaveBeenCalled();
    await a.federation.learnFederationController('b', { ...controller, state: 'working' });
    await drain();
    expect(a.resync).toHaveBeenCalledTimes(1);
    expect(b.resync).not.toHaveBeenCalled();
  });

  it('retains peer, pairing, removal and socket changes even when timestamps share the burst', async () => {
    const a = await endpoint('a', 'b'); const b = await endpoint('b', 'a');
    a.sendTo(b.receive); b.sendTo(a.receive);
    for (const change of [
      () => a.peers.addPeer(member('c')),
      () => a.peers.addPeer({ ...member('b'), pairingId: 'new-pairing', role: 'satellite' }),
      () => a.peers.removePeer('c'),
      () => a.signal.devicesChanged(), // existing socket/connect notifications
    ]) {
      a.resync.mockClear();
      a.peers.recordLastSeen('b', new Date());
      change();
      a.peers.updateLastSeen('b');
      await drain();
      expect(a.resync).toHaveBeenCalledTimes(1);
    }
  });
});
