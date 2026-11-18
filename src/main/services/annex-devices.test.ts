import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AnnexPeer } from '../../shared/types';

vi.mock('./annex-peers', () => ({
  controlsThisMachine: (p?: { role?: string } | null) => p?.role === 'controller' || p?.role === 'member',
  controlledFromHere: (p?: { role?: string; kind?: string } | null) => p?.role === 'satellite' || (p?.role === 'member' && p.kind !== 'phone'),
  listPeers: vi.fn(() => []),
  getPeer: vi.fn(),
  peerNeedsPairing: vi.fn((peer: AnnexPeer) => !peer.role || !peer.tlsCertificateFingerprint),
}));
vi.mock('./annex-client', () => ({
  getSatellites: vi.fn(() => []),
  getSatellite: vi.fn(() => null),
  forgetSatellite: vi.fn(),
  satelliteAddress: vi.fn(() => undefined),
  isMachineDirectConnected: vi.fn(() => false),
}));
vi.mock('./annex-settings', () => ({ networkEnabled: (s?: { networkEnabled?: boolean }) => s?.networkEnabled !== false, getSettings: vi.fn(() => ({ enableClient: true })) }));
vi.mock('./annex-network-membership', () => ({
  joinConfirmation: vi.fn(() => null),
  pendingRemovals: vi.fn(() => []),
  noteLocalRemoval: vi.fn(),
}));
vi.mock('./annex-server', () => ({
  sessionOnlyPeers: vi.fn(() => []),
  connectedPeerFingerprints: vi.fn(() => new Set()),
  revokePeer: vi.fn(() => false),
  getStatus: vi.fn(() => ({ port: 7443 })),
}));
vi.mock('./annex-network-channel', () => ({ inboundMembers: vi.fn(() => new Set()) }));
vi.mock('./annex-device-signal', () => ({ devicesChanged: vi.fn() }));
vi.mock('./annex-control', () => ({ getLinkReadiness: vi.fn(() => ({ acceptedHere: false, openedHere: false })) }));

import * as annexPeers from './annex-peers';
import * as annexClient from './annex-client';
import * as annexControl from './annex-control';
import * as annexServer from './annex-server';
import { buildDeviceList, listDevices, removeDevice, ReachTracker, REACH_SETTLE_MS, resetReachForTests } from './annex-devices';
import * as networkChannel from './annex-network-channel';
import { describeAnnexProblem } from '../../shared/annex-problems';

function peer(overrides: Partial<AnnexPeer>): AnnexPeer {
  return {
    fingerprint: 'fp',
    publicKey: 'pk',
    alias: 'Device',
    icon: 'computer',
    color: 'indigo',
    pairedAt: '2026-11-01T00:00:00.000Z',
    lastSeen: '2026-11-02T00:00:00.000Z',
    role: 'controller',
    tlsCertificateFingerprint: 'AB:CD',
    ...overrides,
  };
}

function satellite(overrides: Partial<annexClient.SatelliteConnection>): annexClient.SatelliteConnection {
  return {
    id: 'fp-sat', fingerprint: 'fp-sat', alias: 'Studio', icon: 'computer', color: 'indigo', state: 'connected',
    host: '10.0.0.2', mainPort: 9000, pairingPort: 9001, snapshot: null, lastError: null, ...overrides,
  };
}

const empty = { peers: [], sessionPeers: [], satellites: [], connected: new Set<string>(), clientOn: true, addressOf: () => undefined };

describe('annex device list', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(annexControl.getLinkReadiness).mockReturnValue({ acceptedHere: false, openedHere: false });
    vi.mocked(annexClient.isMachineDirectConnected).mockReturnValue(false);
  });

  it('lists devices both ways in one list, sorted by name', () => {
    const devices = buildDeviceList({
      ...empty,
      peers: [
        peer({ fingerprint: 'fp-sat', alias: 'Studio', role: 'satellite', tlsCertificatePem: 'PEM' }),
        peer({ fingerprint: 'fp-phone', alias: 'Phone' }),
      ],
      satellites: [satellite({})],
      connected: new Set(['fp-phone']),
    });
    expect(devices.map((d) => [d.alias, d.role, d.state])).toEqual([
      ['Phone', 'controller', 'connected'],
      ['Studio', 'satellite', 'connected'],
    ]);
    expect(devices[0]).toMatchObject({ pairedAt: '2026-11-01T00:00:00.000Z', lastSeen: '2026-11-02T00:00:00.000Z', problem: null });
  });

  it('shows a controller with no open socket as offline, with no problem to explain', () => {
    const [device] = buildDeviceList({ ...empty, peers: [peer({})] });
    expect(device).toMatchObject({ state: 'offline', problem: null });
  });

  it('maps satellite connection states', () => {
    const peers = ['a', 'b', 'c', 'd'].map((fp) => peer({ fingerprint: fp, alias: fp, role: 'satellite', tlsCertificatePem: 'PEM' }));
    const devices = buildDeviceList({
      ...empty,
      peers,
      satellites: [
        satellite({ fingerprint: 'a', state: 'connecting' }),
        satellite({ fingerprint: 'b', state: 'discovering' }),
        satellite({ fingerprint: 'c', state: 'disconnected', problem: describeAnnexProblem('refused', 'c'), lastError: 'x' }),
        satellite({ fingerprint: 'd', state: 'disconnected', needsPairing: true, problem: describeAnnexProblem('removed-there', 'd'), lastError: 'x' }),
      ],
    });
    expect(devices.map((d) => d.state)).toEqual(['connecting', 'connecting', 'offline', 'needs-pairing']);
    expect(devices[2].problem?.code).toBe('refused');
    expect(devices[3].problem?.code).toBe('removed-there');
  });

  it('lists a paired satellite this machine has not found since it started, and says so', () => {
    const [device] = buildDeviceList({ ...empty, peers: [peer({ alias: 'Studio', role: 'satellite', tlsCertificatePem: 'PEM' })] });
    expect(device.state).toBe('offline');
    expect(device.problem).toEqual(describeAnnexProblem('not-found-yet', 'Studio'));
  });

  it("says a satellite is offline because this machine's client is off, not because of the satellite", () => {
    const [device] = buildDeviceList({
      ...empty,
      clientOn: false,
      peers: [peer({ alias: 'Studio', role: 'satellite', tlsCertificatePem: 'PEM' })],
      satellites: [satellite({ fingerprint: 'fp', state: 'discovering', host: '' })],
    });
    expect(device).toMatchObject({ state: 'offline', problem: { code: 'client-off', action: 'Turn on Annex Network in Settings.' } });
  });

  it('says where a satellite is reached and what was typed for it (#3058)', () => {
    const [device] = buildDeviceList({
      ...empty,
      addressOf: (fp) => (fp === 'fp' ? 'studio.tail1234.ts.net:9443' : undefined),
      peers: [peer({ role: 'satellite', tlsCertificatePem: 'PEM', typedHost: 'studio.tail1234.ts.net' })],
      satellites: [satellite({ fingerprint: 'fp', host: 'studio.tail1234.ts.net', mainPort: 9443 })],
    });
    expect(device).toMatchObject({ address: 'studio.tail1234.ts.net:9443', typedHost: 'studio.tail1234.ts.net' });
  });

  describe('network members (#3061)', () => {
    it.each([true, false])('keeps a refused member needing pairing despite inbound presence (%s)', (inbound) => {
      const [device] = buildDeviceList({
        ...empty,
        peers: [peer({ fingerprint: 'fp', alias: 'Studio', role: 'member', tlsCertificatePem: 'PEM' })],
        satellites: [satellite({ fingerprint: 'fp', state: 'disconnected', needsPairing: true, problem: describeAnnexProblem('removed-there', 'Studio') })],
        connected: new Set(inbound ? ['fp'] : []),
      });
      expect(device).toMatchObject({ state: 'needs-pairing', problem: describeAnnexProblem('removed-there', 'Studio') });
    });

    it('shows an unconfirmed introduction as waiting even with inbound presence', () => {
      const [device] = buildDeviceList({
        ...empty,
        peers: [peer({ role: 'member', networkPending: true, tlsCertificatePem: 'PEM' })],
        connected: new Set(['fp']),
        satellites: [satellite({ fingerprint: 'fp' })],
      });
      expect(device.state).toBe('needs-pairing');
      expect(device.problem?.message).toContain('confirm');
    });

    it('counts a member connected either way, and says where its join is confirmed', () => {
      const devices = buildDeviceList({
        ...empty,
        peers: [
          peer({ fingerprint: 'm1', alias: 'Studio', role: 'member', tlsCertificatePem: 'PEM' }),
          peer({ fingerprint: 'm2', alias: 'Laptop', role: 'member', tlsCertificatePem: 'PEM' }),
          peer({ fingerprint: 'm3', alias: 'Mini', role: 'member', tlsCertificatePem: 'PEM' }),
        ],
        satellites: [satellite({ fingerprint: 'm2', state: 'connected' })],
        connected: new Set(['m1']),
        joinOf: (fp) => (fp === 'm3' ? { fingerprint: 'm3', confirmedBy: ['m1'], waitingOn: ['m2'] } : null),
      });
      expect(devices.map((d) => [d.alias, d.state])).toEqual([['Laptop', 'connected'], ['Mini', 'offline'], ['Studio', 'connected']]);
      expect(devices[1].confirmation).toEqual({ kind: 'join', confirmedBy: ['Studio'], waitingOn: ['Laptop'] });
    });

    it('lists a removed member as removing until every member has heard', () => {
      const devices = buildDeviceList({
        ...empty,
        peers: [peer({ fingerprint: 'm1', alias: 'Studio', role: 'member', tlsCertificatePem: 'PEM' })],
        removals: [{ fingerprint: 'gone', name: 'Old Mac', confirmedBy: [], waitingOn: ['m1'] }],
      });
      expect(devices.find((d) => d.fingerprint === 'gone')).toMatchObject({
        alias: 'Old Mac', state: 'removing', confirmation: { kind: 'removal', confirmedBy: [], waitingOn: ['Studio'] },
      });
    });

    it('removes a member everywhere: every member is told before it is cut off', async () => {
      const membership = await import('./annex-network-membership');
      vi.mocked(annexPeers.getPeer).mockReturnValue(peer({ role: 'member' }));
      expect(removeDevice('fp')).toBe(true);
      expect(membership.noteLocalRemoval).toHaveBeenCalledWith('fp');
      expect(vi.mocked(membership.noteLocalRemoval).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(annexServer.revokePeer).mock.invocationCallOrder[0]);
      expect(annexClient.forgetSatellite).toHaveBeenCalledWith('fp');
    });
  });

  it('marks pairings from before pinning as needing pairing again, whichever way', () => {
    const devices = buildDeviceList({
      ...empty,
      peers: [
        peer({ fingerprint: 'a', alias: 'A', role: undefined }),
        peer({ fingerprint: 'b', alias: 'B', tlsCertificateFingerprint: undefined }),
      ],
      connected: new Set(['b']),
    });
    expect(devices.map((d) => [d.role, d.state, d.problem?.code])).toEqual([
      [null, 'needs-pairing', 'old-pairing'],
      ['controller', 'needs-pairing', 'old-pairing'],
    ]);
  });

  it('includes phones paired for this session only, once', () => {
    const phone = peer({ fingerprint: 'fp-phone', alias: 'Phone' });
    const devices = buildDeviceList({ ...empty, peers: [phone], sessionPeers: [phone], connected: new Set(['fp-phone']) });
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({ sessionOnly: true, state: 'connected' });
  });

  it('reads the live sources', () => {
    vi.mocked(annexPeers.listPeers).mockReturnValue([peer({ fingerprint: 'fp-phone', alias: 'Phone' })]);
    vi.mocked(annexServer.connectedPeerFingerprints).mockReturnValue(new Set(['fp-phone']));
    expect(listDevices()).toEqual([expect.objectContaining({ fingerprint: 'fp-phone', state: 'connected' })]);
  });

  describe('each direction on its own (#3608)', () => {
    const studio = (overrides: Partial<AnnexPeer> = {}) => peer({ fingerprint: 'fp-sat', alias: 'Studio', role: 'member', kind: 'desktop', tlsCertificatePem: 'PEM', ...overrides });
    let onSettle: ReturnType<typeof vi.fn>;
    let reach: ReachTracker;
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-11-16T10:00:00.000Z'));
      onSettle = vi.fn();
      reach = new ReachTracker(onSettle);
    });
    afterEach(() => { reach.reset(); vi.useRealTimers(); });

    const list = (over: Partial<Parameters<typeof buildDeviceList>[0]> = {}) =>
      buildDeviceList({ ...empty, peers: [studio()], serverOn: true, ownPort: 7443, reach, now: Date.now(), ...over })[0];

    it.each(['acceptedHere', 'openedHere'] as const)('uses a negotiated %s control link for the missing direction, drops it and recovers', (direction) => {
      let ready = true;
      const controlOf = () => ({ acceptedHere: ready && direction === 'acceptedHere', openedHere: ready && direction === 'openedHere' });
      const sources = {
        controlOf,
        satellites: [satellite({ state: 'disconnected', host: '127.0.0.1', problem: describeAnnexProblem('refused', 'Studio', { host: '127.0.0.1' }) })],
      };
      const checkReady = () => {
        const device = list(sources);
        expect(device).toMatchObject({ state: 'connected', problem: null });
        expect(device.reach).toMatchObject({ outbound: { state: 'up' }, inbound: { state: 'up' } });
        expect(device.reach?.outbound.via).toBe(direction === 'acceptedHere' ? 'reverse' : undefined);
        expect(device.reach?.inbound.via).toBe(direction === 'openedHere' ? 'reverse' : undefined);
        expect(device.reach?.notice).toBeUndefined();
      };
      checkReady();
      ready = false;
      expect(list(sources).reach).toMatchObject({ outbound: { state: 'down' }, inbound: { state: 'unknown' } });
      expect(list(sources).reach?.outbound.via).toBeUndefined();
      expect(list(sources).reach?.inbound.via).toBeUndefined();
      vi.advanceTimersByTime(REACH_SETTLE_MS);
      expect(list(sources).reach).toMatchObject({ outbound: { state: 'down' }, inbound: { state: 'down' } });
      ready = true;
      checkReady();
    });

    it('prefers direct observations over a negotiated reverse connection in both directions', () => {
      const device = list({
        satellites: [satellite({ state: 'connected' })], connected: new Set(['fp-sat']),
        controlOf: () => ({ acceptedHere: true, openedHere: true }),
      });
      expect(device.reach).toMatchObject({ outbound: { state: 'up' }, inbound: { state: 'up' } });
      expect(device.reach?.outbound.via).toBeUndefined();
      expect(device.reach?.inbound.via).toBeUndefined();
    });

    it('does not mistake effective satellite connectivity for a direct observation', () => {
      const device = list({
        satellites: [satellite({ state: 'connected' })],
        directOf: () => false,
        controlOf: () => ({ acceptedHere: true, openedHere: false }),
      });
      expect(device.reach?.outbound).toMatchObject({ state: 'up', via: 'reverse' });
      expect(device.reach?.inbound.via).toBeUndefined();
    });

    it.each([
      { role: 'satellite' }, { role: 'controller' }, { kind: 'phone' }, { kind: undefined },
      { networkPending: true }, { tlsCertificateFingerprint: undefined },
    ] satisfies Partial<AnnexPeer>[])('does not add reverse readiness for an ineligible peer (%j)', (overrides) => {
      const controlOf = vi.fn(() => ({ acceptedHere: true, openedHere: true }));
      const device = list({ peers: [studio(overrides)], controlOf });
      expect(controlOf).not.toHaveBeenCalled();
      expect(device.state).not.toBe('connected');
      expect(device.reach?.outbound.via).toBeUndefined();
      expect(device.reach?.inbound.via).toBeUndefined();
    });

    it('does not use reverse readiness for session-only or removing devices', () => {
      const controlOf = vi.fn(() => ({ acceptedHere: true, openedHere: true }));
      const [session, removing] = buildDeviceList({
        ...empty, sessionPeers: [studio()], controlOf, reach, now: Date.now(),
        removals: [{ fingerprint: 'gone', name: 'Was here', confirmedBy: [], waitingOn: ['fp-sat'] }],
      });
      expect(controlOf).not.toHaveBeenCalled();
      expect(session.reach).toBeUndefined();
      expect(removing).toMatchObject({ state: 'removing' });
      expect(removing.reach).toBeUndefined();
    });

    it('preserves off directions even when a control socket has negotiated', () => {
      const device = list({ clientOn: false, serverOn: false, controlOf: () => ({ acceptedHere: true, openedHere: true }) });
      expect(device.reach).toEqual({ outbound: { state: 'off' }, inbound: { state: 'off' } });
    });

    it('keeps old-peer one-way advice exact when control has not negotiated request capability', () => {
      const sources = {
        satellites: [satellite({ state: 'connected' })],
        controlOf: () => ({ acceptedHere: false, openedHere: false }),
      };
      list(sources);
      vi.advanceTimersByTime(REACH_SETTLE_MS);
      expect(list(sources).reach?.notice).toEqual({
        message: "You can reach Studio, but it can't reach this computer.",
        action: 'On Studio, open Annex Network in Settings and add an address for this computer. A forward there must reach port 7443 on this computer.',
      });
    });

    it('reads negotiated control readiness through the existing live device status source', () => {
      resetReachForTests();
      vi.mocked(annexPeers.listPeers).mockReturnValue([studio()]);
      vi.mocked(annexClient.getSatellites).mockReturnValue([]);
      vi.mocked(annexServer.connectedPeerFingerprints).mockReturnValue(new Set());
      vi.mocked(networkChannel.inboundMembers).mockReturnValue(new Set());
      vi.mocked(annexControl.getLinkReadiness).mockReturnValue({ acceptedHere: false, openedHere: true });
      const device = listDevices()[0];
      expect(annexControl.getLinkReadiness).toHaveBeenCalledWith('fp-sat');
      expect(device).toMatchObject({
        state: 'connected', problem: null,
        reach: { outbound: { state: 'up' }, inbound: { state: 'up', via: 'reverse' } },
      });
      resetReachForTests();
    });

    it('reports outbound up and inbound not known yet, then down once the settle window passes', () => {
      const sources = { satellites: [satellite({ state: 'connected' })], connected: new Set<string>() };
      let device = list(sources);
      // Membership alone never counts: the device still shows as connected, and inbound is not known yet.
      expect(device.state).toBe('connected');
      expect(device.reach).toMatchObject({ outbound: { state: 'up' }, inbound: { state: 'unknown' } });
      expect(device.reach?.notice).toBeUndefined();

      vi.advanceTimersByTime(REACH_SETTLE_MS - 1);
      expect(onSettle).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(onSettle).toHaveBeenCalledTimes(1);

      device = list({ ...sources, now: Date.now() });
      expect(device.reach).toMatchObject({ outbound: { state: 'up' }, inbound: { state: 'down' } });
      expect(device.reach?.notice).toEqual({
        message: "You can reach Studio, but it can't reach this computer.",
        action: 'On Studio, open Annex Network in Settings and add an address for this computer. A forward there must reach port 7443 on this computer.',
      });
    });

    it('reports inbound only, with the forward advice when this computer reaches it through a local address', () => {
      const failing = satellite({ state: 'disconnected', host: '127.0.0.1', mainPort: 7555,
        problem: describeAnnexProblem('refused', 'Studio', { host: '127.0.0.1' }) });
      const device = list({ satellites: [failing], connected: new Set(['fp-sat']) });
      expect(device.reach).toMatchObject({ outbound: { state: 'down' }, inbound: { state: 'up' } });
      expect(device.reach?.notice?.message).toBe("Studio can reach this computer, but this computer can't reach it.");
      expect(device.reach?.notice?.action).toMatch(/local forward is running/);
    });

    it('counts an authenticated inbound network channel as inbound', () => {
      const device = list({ satellites: [satellite({ state: 'connected' })], inbound: new Set(['fp-sat']) });
      expect(device.reach).toMatchObject({ outbound: { state: 'up' }, inbound: { state: 'up' } });
      expect(device.reach?.notice).toBeUndefined();
    });

    it('dropping one direction affects only that one, and it recovers on its own', () => {
      const both = { satellites: [satellite({ state: 'connected' })], connected: new Set(['fp-sat']) };
      expect(list(both).reach).toMatchObject({ outbound: { state: 'up' }, inbound: { state: 'up' } });
      // The forward this computer uses drops: outbound goes down at once, inbound stays up.
      const dropped = { ...both, satellites: [satellite({ state: 'disconnected', problem: describeAnnexProblem('refused', 'Studio', { host: '127.0.0.1' }) })] };
      const down = list(dropped).reach!;
      expect(down.outbound).toMatchObject({ state: 'down', lastUp: '2026-11-16T10:00:00.000Z' });
      expect(down.inbound.state).toBe('up');
      vi.advanceTimersByTime(5_000);
      expect(list({ ...both, now: Date.now() }).reach).toMatchObject({ outbound: { state: 'up' }, inbound: { state: 'up' } });
      // The other forward drops: only inbound is affected.
      const inboundGone = list({ ...both, connected: new Set<string>(), now: Date.now() }).reach!;
      expect(inboundGone).toMatchObject({ outbound: { state: 'up' }, inbound: { state: 'unknown' } });
    });

    it('says off rather than down when this computer is not connecting out or not listening', () => {
      const device = list({ clientOn: false, serverOn: false });
      expect(device.reach).toMatchObject({ outbound: { state: 'off' }, inbound: { state: 'off' } });
      expect(device.reach?.notice).toBeUndefined();
    });

    it('marks the unused direction of a one-way pairing, and gives phones no reach', () => {
      const sat = buildDeviceList({ ...empty, peers: [studio({ role: 'satellite', kind: undefined })], satellites: [satellite({})], reach, now: Date.now() })[0];
      expect(sat.reach).toMatchObject({ outbound: { state: 'up' }, inbound: { state: 'not-used' } });
      const phone = buildDeviceList({ ...empty, peers: [peer({ fingerprint: 'fp-phone', role: 'member', kind: 'phone' })], reach, now: Date.now() })[0];
      expect(phone.reach).toBeUndefined();
    });

    it('starts fresh after needing pairing again, rather than reporting a gap from before', () => {
      const sources = { satellites: [satellite({ state: 'connected' })], connected: new Set<string>() };
      expect(list(sources).reach?.inbound.state).toBe('unknown');
      // It needs pairing for a long while: nothing is observed then.
      expect(buildDeviceList({ ...empty, peers: [studio({ tlsCertificateFingerprint: undefined })], reach, now: Date.now() })[0].reach).toBeUndefined();
      vi.advanceTimersByTime(REACH_SETTLE_MS * 4);
      expect(onSettle).not.toHaveBeenCalled();
      // Paired again: inbound is not known yet, not down from the old gap.
      expect(list({ ...sources, now: Date.now() }).reach?.inbound.state).toBe('unknown');
    });

    it.each([3, 5])('keeps each direction of each computer separate in a mesh of %i', (machines) => {
      const others = Array.from({ length: machines - 1 }, (_, i) => `fp-${i}`);
      const peers = others.map((f, i) => studio({ fingerprint: f, alias: `Target ${i + 1}` }));
      // Every other computer: this machine reaches the even ones, and the first half reach this machine.
      const satellites = others.map((f, i) => satellite({ fingerprint: f, id: f, state: i % 2 === 0 ? 'connected' : 'disconnected',
        ...(i % 2 === 0 ? {} : { problem: describeAnnexProblem('refused', `Target ${i + 1}`, { host: '127.0.0.1' }) }) }));
      const inbound = new Set(others.filter((_, i) => i < (machines - 1) / 2));
      const build = () => buildDeviceList({ ...empty, peers, satellites, connected: inbound, serverOn: true, ownPort: 7443, reach, now: Date.now() });
      build();
      vi.advanceTimersByTime(REACH_SETTLE_MS);
      const devices = new Map(build().map((d) => [d.fingerprint, d.reach!]));
      others.forEach((f, i) => {
        expect(devices.get(f)!.outbound.state).toBe(i % 2 === 0 ? 'up' : 'down');
        expect(devices.get(f)!.inbound.state).toBe(i < (machines - 1) / 2 ? 'up' : 'down');
      });
    });

    it('lists a held address so it can be checked again', () => {
      const device = buildDeviceList({ ...empty, peers: [studio({ heldRoutes: { heldAt: '', typedHost: '127.0.0.1:7555' } })], reach, now: Date.now() })[0];
      expect(device.heldTypedHost).toBe('127.0.0.1:7555');
    });

    it('reads inbound from authenticated sockets and channels in the live sources', () => {
      resetReachForTests();
      vi.mocked(annexPeers.listPeers).mockReturnValue([studio()]);
      vi.mocked(annexClient.getSatellites).mockReturnValue([satellite({ state: 'connected' })]);
      vi.mocked(annexClient.isMachineDirectConnected).mockReturnValue(true);
      vi.mocked(networkChannel.inboundMembers).mockReturnValue(new Set(['fp-sat']));
      expect(listDevices()[0].reach).toMatchObject({ outbound: { state: 'up' }, inbound: { state: 'up' } });
      resetReachForTests();
    });
  });

  describe('removing', () => {
    it('forgets a satellite and cuts any connection it has to this machine', () => {
      vi.mocked(annexPeers.getPeer).mockReturnValue(peer({ role: 'satellite' }));
      expect(removeDevice('fp')).toBe(true);
      expect(annexClient.forgetSatellite).toHaveBeenCalledWith('fp');
      expect(annexServer.revokePeer).toHaveBeenCalledWith('fp');
    });

    it('revokes a controller or phone, which closes its sockets', () => {
      vi.mocked(annexPeers.getPeer).mockReturnValue(peer({}));
      vi.mocked(annexServer.revokePeer).mockReturnValue(true);
      expect(removeDevice('fp')).toBe(true);
      expect(annexClient.forgetSatellite).not.toHaveBeenCalled();
      expect(annexServer.revokePeer).toHaveBeenCalledWith('fp');
    });

    it('forgets an older entry the client found as a satellite', () => {
      vi.mocked(annexPeers.getPeer).mockReturnValue(peer({ role: undefined }));
      vi.mocked(annexClient.getSatellite).mockReturnValue(satellite({ fingerprint: 'fp' }));
      expect(removeDevice('fp')).toBe(true);
      expect(annexClient.forgetSatellite).toHaveBeenCalledWith('fp');
    });

    it('says when there was nothing to remove', () => {
      vi.mocked(annexPeers.getPeer).mockReturnValue(undefined);
      expect(removeDevice('nope')).toBe(false);
    });
  });
});
