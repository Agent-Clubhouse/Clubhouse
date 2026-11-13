import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnnexPeer } from '../../shared/types';
const state = vi.hoisted(() => ({ base: '', selfPairing: 'self', local: 'controller-here', enabled: true, peers: [] as AnnexPeer[], changed: undefined as (() => void) | undefined }));
vi.mock('electron', () => ({ app: { getPath: () => state.base, isPackaged: false } }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./annex-network-membership', () => ({ ownPairing: () => ({ id: state.selfPairing }) }));
vi.mock('./annex-peers', () => ({ listPeers: () => state.peers }));
vi.mock('./dispatcher/dispatcher-service', () => ({
  getDispatcherAgentId: () => state.local, isDispatcherEnabled: () => state.enabled,
  dispatcherDisplayName: () => 'Dispatcher controller',
  onDispatcherChanged: (listener: () => void) => { state.changed = listener; return () => { state.changed = undefined; }; },
}));
state.base = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatcher-federation-'));
import { controllerDirection, federationBindingSource, learnFederationController, localFederationController, watchFederation } from './dispatcher-federation';
import { federationStatus } from './dispatcher-federation-policy';
import { getConnectionDirection, linkConnectionDirections, setConnectionDirections, setConnectionLink, setConnectionTools } from './connection-grants-store';
import { devicesChanged, resetDeviceSignalForTests } from './annex-device-signal';
const peer = (id: string, kind: 'desktop' | 'phone' = 'desktop', role = 'member') => ({ fingerprint: id, kind, role, alias: id } as AnnexPeer);
let stop = () => {};
beforeEach(() => {
  state.selfPairing = 'self'; state.enabled = true; state.peers = [peer('desk'), peer('laptop'), peer('phone', 'phone'), peer('paired', 'desktop', 'satellite')];
  stop = watchFederation(() => {});
});
afterEach(() => { stop(); resetDeviceSignalForTests(); });
afterAll(() => { fs.rmSync(state.base, { recursive: true, force: true }); });
const info = (agentId: string, enabled = true) => ({ agentId, enabled, name: 'Dispatcher controller' });
const local = { agentId: 'controller-here' };
const remote = { agentId: 'controller-desk', machineId: 'desk' };

describe('membership-owned controller links (#3345)', () => {
  it('makes one two-way link for each other computer, with no duplicates and no phone or one-to-one peer', async () => {
    for (const p of state.peers) await learnFederationController(p.fingerprint, info(`controller-${p.fingerprint}`));
    const first = await federationBindingSource.collect();
    expect(first).toHaveLength(4);
    expect(await federationBindingSource.collect()).toEqual(first);
    expect(controllerDirection(local, remote)?.link).toBeDefined();
    expect(controllerDirection(remote, local)?.link).toBeDefined();
    expect(controllerDirection(local, { agentId: 'controller-phone', machineId: 'phone' })).toBeUndefined();
    expect(controllerDirection(local, { agentId: 'controller-paired', machineId: 'paired' })).toBeUndefined();
  });
  it('learns a member missed during a join on the next authenticated exchange', async () => {
    state.peers = [];
    await learnFederationController('new', info('new-controller'));
    state.peers = [peer('new')];
    expect(await federationBindingSource.collect()).toEqual([]);
    await learnFederationController('new', info('new-controller'));
    expect(await federationBindingSource.collect()).toHaveLength(2);
  });
  it('revokes both directions immediately when membership ends', async () => {
    await learnFederationController('desk', info('controller-desk'));
    expect(getConnectionDirection(remote, local)?.link).toBeDefined();
    state.peers = [];
    expect(getConnectionDirection(remote, local)).toBeUndefined();
    expect(getConnectionDirection(local, remote)).toBeUndefined();
    expect(await federationBindingSource.collect()).toEqual([]);
  });
  it('retains remote off metadata but removes outgoing bindings when this Dispatcher is off', async () => {
    state.peers = [peer('desk')];
    await learnFederationController('desk', info('controller-desk', false));
    expect(await federationBindingSource.collect()).toHaveLength(2);
    state.enabled = false;
    expect(localFederationController().enabled).toBe(false);
    expect(await federationBindingSource.collect()).toEqual([]);
  });
  it('shows unavailable when the remote Dispatcher is off, and paused while offline, resuming on reconnect', async () => {
    state.peers = [peer('desk')];
    await learnFederationController('desk', info('controller-desk', false));
    expect(federationStatus(local, remote)).toMatchObject({ state: 'unavailable', reason: expect.stringContaining('Dispatcher is off') });
    await learnFederationController('desk', info('controller-desk'));
    stop(); let online = false; stop = watchFederation(() => {}, () => online);
    expect(federationStatus(local, remote)).toMatchObject({ state: 'paused' });
    expect(await federationBindingSource.collect()).toHaveLength(2);
    online = true;
    expect(federationStatus(local, remote)).toBeUndefined();
  });
  it('does not restore a controller learned under an earlier network pairing', async () => {
    state.peers = [{ ...peer('desk'), pairingId: 'first-pairing' }];
    await learnFederationController('desk', info('controller-desk'));
    expect(controllerDirection(local, remote)).toBeDefined();
    state.peers = [{ ...peer('desk'), pairingId: 'second-pairing' }];
    expect(controllerDirection(local, remote)).toBeUndefined();
    await learnFederationController('desk', info('controller-desk'));
    expect(controllerDirection(local, remote)).toBeDefined();
  });
  it('requires fresh publication after this computer gets a new pairing too', async () => {
    state.peers = [peer('desk')];
    await learnFederationController('desk', info('controller-desk'));
    expect(controllerDirection(local, remote)).toBeDefined();
    state.selfPairing = 'new-self-pairing';
    expect(controllerDirection(local, remote)).toBeUndefined();
    await learnFederationController('desk', info('controller-desk'));
    expect(controllerDirection(local, remote)).toBeDefined();
  });
  it('checks the captured pairing again at the atomic metadata commit', async () => {
    state.peers = [{ ...peer('commit-peer'), pairingId: 'pairing-A' }];
    let written!: () => void;
    const atWrite = new Promise<void>((resolve) => { written = resolve; });
    let release!: () => void;
    const continueWrite = new Promise<void>((resolve) => { release = resolve; });
    const open = fs.promises.open.bind(fs.promises);
    const spy = vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (String(args[0]).includes('dispatcher-federation.json.tmp-')) { written(); await continueWrite; }
      return handle;
    });
    const pending = learnFederationController('commit-peer', info('old-controller'), {
      epoch: { sender: 'self', receiver: 'pairing-A' },
      current: () => state.peers[0]?.pairingId === 'pairing-A',
    });
    await atWrite;
    state.peers = [{ ...peer('commit-peer'), pairingId: 'pairing-B' }];
    release(); await pending; spy.mockRestore();
    expect(await federationBindingSource.collect()).toEqual([]);
    // The rejected attempt must not poison the cache or disk for the new pairing.
    await learnFederationController('commit-peer', info('new-controller'));
    expect(controllerDirection(local, { agentId: 'new-controller', machineId: 'commit-peer' })).toBeDefined();
    expect(controllerDirection(local, { agentId: 'old-controller', machineId: 'commit-peer' })).toBeUndefined();
  });
  it('rejects malformed endpoint publication and never links a visible chat by text alone', async () => {
    state.peers = [peer('unseen')];
    for (const raw of [{ agentId: 'spoof@machine', enabled: true, name: 'chat' }, { agentId: 'chat', name: 'chat' }, { agentId: 5, enabled: true, name: 'chat' }]) {
      await learnFederationController('unseen', raw);
    }
    expect(await federationBindingSource.collect()).toEqual([]);
  });
  it('keeps the fixed-off tools despite any attempted switch or link write', async () => {
    await learnFederationController('desk', info('controller-desk'));
    for (const [from, to] of [[local, remote], [remote, local]]) {
      expect(getConnectionDirection(from, to)?.disabledTools).toEqual(['read_output', 'clear_agent', 'compact_agent', 'wake_agent']);
      await expect(setConnectionTools(from, to, [])).rejects.toThrow('membership');
      await expect(setConnectionDirections([{ from, to, disabledTools: [], enabledTools: ['wake_agent'] }], () => {})).rejects.toThrow('membership');
      await expect(linkConnectionDirections([{ from, to }])).rejects.toThrow('membership');
      await expect(setConnectionLink(from, to, false)).rejects.toThrow('membership');
    }
  });
  it('observes membership and Dispatcher changes and unsubscribes cleanly', async () => {
    stop();
    const changed = vi.fn(); stop = watchFederation(changed);
    devicesChanged(); state.changed?.();
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(2));
    stop(); devicesChanged(); state.changed?.();
    expect(changed).toHaveBeenCalledTimes(2);
  });
});
