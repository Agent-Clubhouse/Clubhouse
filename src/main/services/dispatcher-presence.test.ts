import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnnexPeer } from '../../shared/types';

const state = vi.hoisted(() => ({
  base: '', local: 'controller-here' as string | null, enabled: true, peers: [] as AnnexPeer[],
  workRunning: true, requestsUnderWay: 0, online: new Set<string>(),
  dispatcherListeners: new Set<() => void>(),
}));
vi.mock('electron', () => ({ app: { getPath: () => state.base, isPackaged: false } }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./annex-network-membership', () => ({ ownPairing: () => ({ id: 'self' }) }));
vi.mock('./annex-peers', () => ({ listPeers: () => state.peers }));
vi.mock('./dispatcher/dispatcher-service', () => ({
  getDispatcherAgentId: () => state.local, isDispatcherEnabled: () => state.enabled,
  getDispatcherState: () => ({ workRunning: state.workRunning, requestsUnderWay: state.requestsUnderWay }),
  dispatcherDisplayName: () => 'Dispatcher',
  onDispatcherChanged: (listener: () => void) => { state.dispatcherListeners.add(listener); return () => { state.dispatcherListeners.delete(listener); }; },
}));
state.base = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatcher-presence-'));

import { learnFederationController, localFederationController, watchFederation } from './dispatcher-federation';
import { _resetDispatcherPresenceForTesting, getDispatcherPresence, onDispatcherPresenceChanged, remoteDispatcherLabelFor, watchDispatcherPresence } from './dispatcher-presence';
import { devicesChanged, resetDeviceSignalForTests } from './annex-device-signal';
import { createFederatedRequests, createFederationRequestStore, FEDERATED_REQUEST_LIMITS } from './dispatcher-federation-requests';
import { setFederationRequestRouter } from './dispatcher-federation-policy';

const peer = (id: string, alias: string, extra: Partial<AnnexPeer> = {}) =>
  ({ fingerprint: id.toUpperCase(), alias, kind: 'desktop', role: 'member', lastSeen: '2026-11-13T10:00:00.000Z', ...extra } as AnnexPeer);
const controller = (agentId: string, extra: Record<string, unknown> = {}) => ({ agentId, name: 'Studio Dispatcher', enabled: true, ...extra });
const connected = (machine: string) => state.online.has(machine.toLowerCase());
let stops: Array<() => void> = [];

beforeEach(() => {
  state.local = 'controller-here'; state.enabled = true; state.workRunning = true; state.requestsUnderWay = 0;
  state.online = new Set(['desk', 'laptop']);
  state.peers = [peer('desk', 'Desk'), peer('laptop', 'Laptop'), peer('phone', 'Phone', { kind: 'phone' }), peer('paired', 'Paired', { role: 'satellite' })];
  stops = [watchFederation(() => {}, connected), watchDispatcherPresence(connected)];
});
afterEach(() => {
  for (const stop of stops) stop();
  _resetDispatcherPresenceForTesting();
  resetDeviceSignalForTests();
});
afterAll(() => { fs.rmSync(state.base, { recursive: true, force: true }); });

describe('remote Dispatcher presence (#3349)', () => {
  it('lists each other computer member\'s Dispatcher with machine label and state, never phones or one-to-one peers', async () => {
    await learnFederationController('desk', controller('controller-desk', { state: 'working' }));
    await learnFederationController('laptop', controller('controller-laptop', { state: 'asleep', name: 'Travel' }));
    expect(getDispatcherPresence().remotes).toEqual([
      { machineId: 'desk', machineName: 'Desk', address: 'controller-desk@desk', dispatcherName: 'Studio Dispatcher', label: 'Studio Dispatcher on Desk', state: 'working', link: { state: 'active' } },
      { machineId: 'laptop', machineName: 'Laptop', address: 'controller-laptop@laptop', dispatcherName: 'Travel', label: 'Travel on Laptop', state: 'asleep', link: { state: 'active' } },
    ]);
    expect(remoteDispatcherLabelFor('DESK')).toBe('Studio Dispatcher on Desk');
    expect(remoteDispatcherLabelFor('phone')).toBeUndefined();
  });

  it('shows an offline member with last seen and a paused link, and the others online', async () => {
    await learnFederationController('desk', controller('controller-desk'));
    await learnFederationController('laptop', controller('controller-laptop'));
    state.online.delete('laptop');
    const [desk, laptop] = getDispatcherPresence().remotes;
    expect(desk).toMatchObject({ state: 'online', link: { state: 'active' } });
    expect(laptop).toMatchObject({ state: 'offline', lastSeen: '2026-11-13T10:00:00.000Z', link: { state: 'paused', reason: expect.stringContaining('offline') } });
  });

  it('reports last seen as the later of the stored time and the last confirmed heartbeat of a long-lived connection', async () => {
    for (const stop of stops) stop();
    let confirmed: string | undefined = '2026-11-13T15:30:00.000Z';
    stops = [watchFederation(() => {}, connected), watchDispatcherPresence(connected, () => confirmed)];
    await learnFederationController('laptop', controller('controller-laptop'));
    state.online.delete('laptop');
    expect(getDispatcherPresence().remotes.find((r) => r.machineId === 'laptop')?.lastSeen).toBe('2026-11-13T15:30:00.000Z');
    // Before any heartbeat this run, the stored time is what's known.
    confirmed = undefined;
    expect(getDispatcherPresence().remotes.find((r) => r.machineId === 'laptop')?.lastSeen).toBe('2026-11-13T10:00:00.000Z');
    // An older live value never moves it backwards.
    confirmed = '2026-11-12T00:00:00.000Z';
    expect(getDispatcherPresence().remotes.find((r) => r.machineId === 'laptop')?.lastSeen).toBe('2026-11-13T10:00:00.000Z');
  });

  it('shows a turned-off remote Dispatcher and an unavailable link with the reason, and this one off makes every link unavailable', async () => {
    await learnFederationController('desk', controller('controller-desk', { enabled: false }));
    expect(getDispatcherPresence().remotes[0]).toMatchObject({ state: 'off', link: { state: 'unavailable', reason: expect.stringContaining('other Dispatcher is off') } });
    state.enabled = false;
    expect(getDispatcherPresence().remotes.every((r) => r.link.state === 'unavailable')).toBe(true);
  });

  it('names a member that hasn\'t shared its Dispatcher by machine, never a bare id', () => {
    state.peers = [peer('studio', 'Studio')];
    state.online.add('studio');
    expect(getDispatcherPresence().remotes).toEqual([{ machineId: 'studio', machineName: 'Studio', address: null, dispatcherName: null,
      label: 'Dispatcher on Studio', state: 'unknown', link: { state: 'unavailable', reason: expect.stringContaining('hasn\'t shared') } }]);
  });

  it('accepts an older computer that publishes no state as online, and refuses a malformed state', async () => {
    await learnFederationController('desk', controller('controller-desk'));
    expect(getDispatcherPresence().remotes[0].state).toBe('online');
    await learnFederationController('desk', controller('controller-desk', { state: 'busy-ish' }));
    expect(getDispatcherPresence().remotes[0]).toMatchObject({ state: 'online', dispatcherName: 'Studio Dispatcher' });
  });

  it('publishes this Dispatcher as asleep, working or online, and nothing while it is off', () => {
    state.workRunning = false;
    expect(localFederationController()).toMatchObject({ enabled: true, state: 'asleep' });
    state.workRunning = true; state.requestsUnderWay = 2;
    expect(localFederationController().state).toBe('working');
    state.requestsUnderWay = 0;
    expect(localFederationController().state).toBe('online');
    state.enabled = false;
    expect(localFederationController()).not.toHaveProperty('state');
  });

  it('tells listeners only on a real change, from membership, connectivity and published controllers', async () => {
    state.peers = [peer('attic', 'Attic')];
    state.online.add('attic');
    devicesChanged();
    await new Promise((resolve) => setTimeout(resolve, 80));
    const heard = vi.fn();
    onDispatcherPresenceChanged(heard);
    await learnFederationController('attic', controller('controller-attic'));
    expect(heard).toHaveBeenCalledTimes(1);
    for (const listener of state.dispatcherListeners) listener();
    expect(heard).toHaveBeenCalledTimes(1);
    state.online.delete('attic');
    devicesChanged();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(heard).toHaveBeenCalledTimes(2);
  });

  it('shows a link tripped by a real fixed limit as tripped with the limit, and tells listeners (#3347)', async () => {
    await learnFederationController('laptop', controller('controller-laptop'));
    const store = createFederationRequestStore(`federation-requests-${Date.now()}.json`);
    const requests = createFederatedRequests({
      store, now: () => Date.parse('2026-11-13T12:00:00.000Z'),
      self: () => ({ machineId: 'here', machineName: 'Here', agentId: 'controller-here', agentName: 'Dispatcher' }),
      authorized: () => true, epoch: () => ({ sender: 'pair-a', receiver: 'pair-b' }),
      send: vi.fn(async (_caller: string, _machine: string, _target: string, _envelope: unknown, _cause: unknown, key: string) => ({ deliveryId: key })),
      delivery: () => undefined, createLocal: vi.fn(async () => {}), present: vi.fn(async () => {}), record: vi.fn(),
    });
    const stopRouter = setFederationRequestRouter({
      offer: async () => ({ content: [] }), before: async () => {}, cause: () => undefined,
      allowed: (machine, args, tool) => requests.allowed(machine, args, tool),
      pauseReason: (machine) => requests.pauseReason(machine),
    });
    try {
      expect(getDispatcherPresence().remotes.find((r) => r.machineId === 'laptop')?.link).toEqual({ state: 'active' });
      const heard = vi.fn();
      const off = onDispatcherPresenceChanged(heard);
      for (let i = 0; i < FEDERATED_REQUEST_LIMITS.perMinute; i++) await requests.offer('controller-here', 'laptop', 'controller-laptop', `r-${i}`, 'Work');
      await expect(requests.offer('controller-here', 'laptop', 'controller-laptop', 'over', 'Work')).rejects.toThrow('rate limit');
      // The trip itself is the change signal: no device, Dispatcher or publication event happened.
      expect(heard).toHaveBeenCalled();
      expect(getDispatcherPresence().remotes.find((r) => r.machineId === 'laptop')).toMatchObject({
        state: 'online', link: { state: 'tripped', reason: 'The controller link rate limit was reached.' },
      });
      off();
    } finally { stopRouter(); }
  });
});
