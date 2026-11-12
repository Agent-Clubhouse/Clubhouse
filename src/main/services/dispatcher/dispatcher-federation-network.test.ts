import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnnexPeer } from '../../../shared/types';
import type { SatelliteConnection } from '../annex-client';
import { DISPATCHER_OFF } from '../../../shared/dispatcher-types';
import { DISPATCHER_FEDERATION_TOOLS } from '../../../shared/dispatcher-federation';

const h = vi.hoisted(() => ({
  peers: [] as AnnexPeer[], satellites: [] as SatelliteConnection[], enabled: true,
  deviceListeners: new Set<() => void>(), dispatcherListeners: new Set<() => void>(),
  savedPeerState: null as Record<string, unknown> | null,
}));
vi.mock('../settings-store', () => ({
  createSettingsStore: (_filename: string, defaults: unknown, normalize: (raw: Record<string, unknown>) => unknown) => ({
    get: () => h.savedPeerState ? normalize(h.savedPeerState) : defaults,
    save: async (value: Record<string, unknown>) => { h.savedPeerState = structuredClone(value); },
  }),
}));
vi.mock('../annex-identity', () => ({ getIdentity: () => ({ fingerprint: 'aa:'.repeat(15) + 'aa' }) }));
vi.mock('../annex-peers', () => ({ listPeers: () => h.peers }));
vi.mock('../annex-client', () => ({ getSatellites: () => h.satellites }));
vi.mock('../annex-device-signal', () => ({
  onDevicesChanged: (listener: () => void) => { h.deviceListeners.add(listener); return () => h.deviceListeners.delete(listener); },
}));
vi.mock('./dispatcher-service', () => ({
  getDispatcherState: () => ({ ...DISPATCHER_OFF, enabled: h.enabled, agentId: 'desk-controller' }),
  dispatcherDisplayName: () => 'Dispatch',
  onDispatcherChanged: (listener: () => void) => { h.dispatcherListeners.add(listener); return () => h.dispatcherListeners.delete(listener); },
}));

import { watchDispatcherFederationPresence } from './dispatcher-federation-network';
import {
  fixedDispatcherFederationTools, getDispatcherFederationPeers, remoteDispatcherFederationPeer,
} from './dispatcher-federation-presence';
import { dispatcherFederationBindingSource } from './dispatcher-federation-source';
import { FEDERATION_LINK_PAUSE_MS, tripDispatcherFederationLink } from './dispatcher-federation-peer-state';

const LAPTOP = 'bb:'.repeat(15) + 'bb';
const STUDIO = 'cc:'.repeat(15) + 'cc';
function peer(fingerprint = LAPTOP, extras: Partial<AnnexPeer> = {}): AnnexPeer {
  return {
    fingerprint, publicKey: 'key', alias: fingerprint === LAPTOP ? 'Laptop' : 'Studio', role: 'member', kind: 'desktop',
    icon: 'computer', color: 'indigo', pairedAt: '2026-11-01T00:00:00Z', lastSeen: '2026-11-11T00:00:00Z', ...extras,
  };
}
function satellite(fingerprint = LAPTOP): SatelliteConnection {
  return {
    id: fingerprint, fingerprint, alias: 'Laptop', icon: 'computer', color: 'indigo', state: 'connected',
    host: 'local.test', mainPort: 7443, pairingPort: 7444, lastError: null,
    snapshot: {
      projects: [], agents: {}, quickAgents: {}, theme: {}, orchestrators: {}, pendingPermissions: [], lastSeq: 1,
      dispatcherFederation: { controllerId: 'remote-controller', name: 'Dispatch', enabled: true, running: true, working: false },
    },
  };
}
let stop: (() => void) | null = null;
beforeEach(() => {
  h.enabled = true;
  h.savedPeerState = null;
  h.peers = [peer()];
  h.satellites = [satellite()];
  stop = watchDispatcherFederationPresence();
});
afterEach(() => { stop?.(); stop = null; vi.useRealTimers(); });
const deviceChanged = () => { for (const listener of h.deviceListeners) listener(); };

describe('existing Annex events drive controller discovery and presence', () => {
  it('creates both source directions with machine names and no wake/output tools', async () => {
    const bindings = await dispatcherFederationBindingSource.collect();
    expect(bindings).toMatchObject([
      { agentId: 'desk-controller', targetId: `remote-controller@${LAPTOP}`, targetName: 'Dispatch on Laptop', enabledTools: [] },
      { agentId: `remote-controller@${LAPTOP}`, targetId: 'desk-controller', agentName: 'Dispatch on Laptop', enabledTools: [] },
    ]);
    if (!Array.isArray(bindings)) throw new Error('Expected bindings');
    expect(bindings.every((binding) => ['read_output', 'wake_agent', 'clear_agent', 'compact_agent'].every((tool) => binding.disabledTools?.includes(tool)))).toBe(true);
    expect(fixedDispatcherFederationTools('desk-controller', `remote-controller@${LAPTOP}`)).toEqual(DISPATCHER_FEDERATION_TOOLS);
    expect(fixedDispatcherFederationTools(`remote-controller@${LAPTOP}`, 'desk-controller')).toEqual(DISPATCHER_FEDERATION_TOOLS);
    expect(fixedDispatcherFederationTools('other-agent', `remote-controller@${LAPTOP}`)).toBeUndefined();
    expect(remoteDispatcherFederationPeer(`remote-controller@${LAPTOP.toUpperCase()}`)?.machineName).toBe('Laptop');
  });

  it('adds an offline-join member without inventing its controller, then connects and removes it', async () => {
    h.peers.push(peer(STUDIO));
    deviceChanged();
    expect(getDispatcherFederationPeers()).toContainEqual(expect.objectContaining({ machineId: STUDIO, presence: 'offline', reason: 'status_unknown' }));
    h.satellites.push(satellite(STUDIO));
    deviceChanged();
    expect(getDispatcherFederationPeers()).toHaveLength(2);
    const connected = await dispatcherFederationBindingSource.collect();
    expect(connected).toHaveLength(4);
    h.peers = h.peers.filter((entry) => entry.fingerprint !== STUDIO);
    deviceChanged();
    expect(await dispatcherFederationBindingSource.collect()).toHaveLength(2);
    expect(remoteDispatcherFederationPeer(`remote-controller@${STUDIO}`)).toBeUndefined();
  });

  it('keeps offline links owned and fixed even if the snapshot had been working', async () => {
    h.satellites[0].snapshot!.dispatcherFederation!.working = true;
    h.satellites[0].state = 'disconnected';
    deviceChanged();
    expect(getDispatcherFederationPeers()[0]).toMatchObject({ presence: 'offline', link: 'paused', lastSeen: '2026-11-11T00:00:00Z' });
    expect(await dispatcherFederationBindingSource.collect()).toHaveLength(2);
    expect(fixedDispatcherFederationTools('desk-controller', `remote-controller@${LAPTOP}`)).toBeDefined();
  });

  it('restores only routing identity after a restart without claiming cached liveness', async () => {
    stop?.();
    h.satellites = [];
    stop = watchDispatcherFederationPresence();
    expect(getDispatcherFederationPeers()[0]).toMatchObject({
      address: `remote-controller@${LAPTOP}`, presence: 'offline', link: 'paused',
    });
    expect(await dispatcherFederationBindingSource.collect()).toHaveLength(2);
    h.peers = [];
    deviceChanged();
    h.peers = [peer()];
    deviceChanged();
    expect(getDispatcherFederationPeers()[0].address).toBeUndefined();
    expect(await dispatcherFederationBindingSource.collect()).toEqual([]);
  });

  it('retains a persisted safety pause across watcher restart and expires it without changing grants', async () => {
    vi.useFakeTimers();
    await tripDispatcherFederationLink(LAPTOP, 'causal_depth');
    expect(getDispatcherFederationPeers()[0]).toMatchObject({ link: 'tripped', reason: 'causal_depth' });
    stop?.();
    stop = watchDispatcherFederationPresence();
    expect(getDispatcherFederationPeers()[0].link).toBe('tripped');
    expect(fixedDispatcherFederationTools('desk-controller', `remote-controller@${LAPTOP}`)).toEqual(DISPATCHER_FEDERATION_TOOLS);
    await vi.advanceTimersByTimeAsync(FEDERATION_LINK_PAUSE_MS);
    expect(getDispatcherFederationPeers()[0]).toMatchObject({ link: 'active' });
    expect(getDispatcherFederationPeers()[0].reason).toBeUndefined();
  });

  it('never promotes an unknown or unvalidated remote identity to a link target', async () => {
    h.satellites[0].snapshot!.dispatcherFederation!.controllerId = `other-controller@${STUDIO}`;
    deviceChanged();
    expect(getDispatcherFederationPeers()[0]).toMatchObject({ presence: 'unavailable', link: 'unavailable', reason: 'status_unknown' });
    expect(await dispatcherFederationBindingSource.collect()).toHaveLength(2);
    expect(remoteDispatcherFederationPeer(`remote-controller@${LAPTOP}`)).toBeDefined();
    h.satellites[0].snapshot!.dispatcherFederation!.controllerId = 'remote-controller';
    h.satellites[0].snapshotUnavailable = true;
    deviceChanged();
    expect(await dispatcherFederationBindingSource.collect()).toHaveLength(2);
  });

  it('excludes phones and one-to-one pairings even when they claim a controller identity', () => {
    h.peers.push(peer(STUDIO, { kind: 'phone' }), peer('one-to-one', { role: 'satellite' }));
    h.satellites.push(satellite(STUDIO), satellite('one-to-one'));
    deviceChanged();
    expect(getDispatcherFederationPeers()).toHaveLength(1);
  });

  it('retains the fixed policy while either local or remote Dispatcher is off', () => {
    h.enabled = false;
    for (const listener of h.dispatcherListeners) listener();
    expect(getDispatcherFederationPeers()[0]).toMatchObject({ link: 'unavailable', reason: 'local_dispatcher_off' });
    expect(fixedDispatcherFederationTools('desk-controller', `remote-controller@${LAPTOP}`)).toBeDefined();
    h.enabled = true;
    h.satellites[0].snapshot!.dispatcherFederation!.enabled = false;
    deviceChanged();
    expect(getDispatcherFederationPeers()[0]).toMatchObject({ link: 'unavailable', presence: 'unavailable', reason: 'dispatcher_off' });
    expect(fixedDispatcherFederationTools('desk-controller', `remote-controller@${LAPTOP}`)).toBeDefined();
  });
});
