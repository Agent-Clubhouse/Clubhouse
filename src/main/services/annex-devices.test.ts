import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AnnexPeer } from '../../shared/types';

vi.mock('./annex-peers', () => ({
  listPeers: vi.fn(() => []),
  getPeer: vi.fn(),
  peerNeedsPairing: vi.fn((peer: AnnexPeer) => !peer.role || !peer.tlsCertificateFingerprint),
}));
vi.mock('./annex-client', () => ({
  getSatellites: vi.fn(() => []),
  getSatellite: vi.fn(() => null),
  forgetSatellite: vi.fn(),
}));
vi.mock('./annex-server', () => ({
  sessionOnlyPeers: vi.fn(() => []),
  connectedPeerFingerprints: vi.fn(() => new Set()),
  revokePeer: vi.fn(() => false),
}));

import * as annexPeers from './annex-peers';
import * as annexClient from './annex-client';
import * as annexServer from './annex-server';
import { buildDeviceList, listDevices, removeDevice } from './annex-devices';
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

const empty = { peers: [], sessionPeers: [], satellites: [], connected: new Set<string>() };

describe('annex device list', () => {
  beforeEach(() => vi.clearAllMocks());

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
