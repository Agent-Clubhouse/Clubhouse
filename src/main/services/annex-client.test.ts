/**
 * Tests for the Annex V2 Client — discovery, pairing, and connection management.
 *
 * These tests exercise the public API surface of annex-client.ts with mocked
 * Bonjour, HTTP, and peer dependencies. The three root-cause bugs (startClient
 * never called, unpaired services dropped, no pairing flow) are each covered.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { networkInterfaces } from 'node:os';

// ---------------------------------------------------------------------------
// Mocks — set up before importing the module under test
// ---------------------------------------------------------------------------

const { mockBrowser, mockBonjourInstance, BonjourConstructor, WebSocketMock } = vi.hoisted(() => {
  const mockBrowser = { stop: vi.fn() };
  const mockBonjourInstance = {
    find: vi.fn(),
    destroy: vi.fn(),
  };
  const BonjourConstructor = vi.fn();
  const WebSocketMock = Object.assign(vi.fn(), { OPEN: 1 });
  return { mockBrowser, mockBonjourInstance, BonjourConstructor, WebSocketMock };
});

let bonjourFindCallback: ((service: any) => void) | null = null;

// Re-wire all Bonjour mock implementations (safe to call after clearAllMocks)
function resetBonjourMocks() {
  // Must use function() not arrow for constructor compatibility
  BonjourConstructor.mockImplementation(function (this: any) {
    return mockBonjourInstance;
  });
  mockBonjourInstance.find.mockImplementation((_opts: any, cb: any) => {
    bonjourFindCallback = cb;
    return mockBrowser;
  });
}

vi.mock('bonjour-service', () => ({
  default: BonjourConstructor,
}));

vi.mock('node:os', async (original) => {
  const actual = await original<typeof import('node:os')>();
  return { ...actual, networkInterfaces: vi.fn(actual.networkInterfaces) };
});

// The membership channel has its own tests (annex-network-channel.test.ts).
vi.mock('./annex-network-channel', () => ({ connectTo: vi.fn(), closeFor: vi.fn(), closeAll: vi.fn() }));
vi.mock('./annex-network-membership', () => ({
  noteLocalJoin: vi.fn(),
  noteLocalRemoval: vi.fn(),
  // Pairing ids (#3107): fixed, so answers and fixtures don't change from run to run.
  ownPairing: vi.fn(() => undefined),
  readPairing: (v: { id?: unknown; joinedAt?: unknown } | null | undefined) => (v && typeof v.id === 'string' && typeof v.joinedAt === 'string' ? { id: v.id, joinedAt: v.joinedAt } : undefined),
  pairingForJoiner: vi.fn((_fp: string, offered?: { id: string; joinedAt: string }) => offered ?? { id: '6f1c2a3e-0000-4000-8000-00000000a001', joinedAt: '2026-11-08T10:00:00.000Z' }),
  ensureOwnPairing: vi.fn(() => ({ id: '6f1c2a3e-0000-4000-8000-00000000aaaa', joinedAt: '2026-11-01T09:00:00.000Z' })),
  adoptOwnPairing: vi.fn(),
}));

vi.mock('ws', () => ({
  WebSocket: WebSocketMock,
}));

const LOCAL_IDENTITY = {
  publicKey: 'local-pub-key',
  privateKey: 'local-priv-key',
  fingerprint: 'AA:BB:CC:DD',
  createdAt: '2024-01-01',
};

vi.mock('./annex-identity', () => ({
  getOrCreateIdentity: vi.fn(),
  getIdentity: vi.fn(),
  computeFingerprint: vi.fn(),
}));

vi.mock('./annex-tls', () => ({
  PIN_MISMATCH_CODE: 'ERR_ANNEX_PIN_MISMATCH',
  createPinnedTlsClientOptions: vi.fn().mockReturnValue({ pinned: true }),
  probePeerCertificate: vi.fn(),
  signCertBinding: vi.fn().mockReturnValue('cert-binding'),
  sameCertificateFingerprint: (a?: string, b?: string) => !!a && a.replace(/:/g, '').toLowerCase() === b?.replace(/:/g, '').toLowerCase(),
}));

vi.mock('./annex-peers', () => ({
  controlsThisMachine: (p?: { role?: string } | null) => p?.role === 'controller' || p?.role === 'member',
  controlledFromHere: (p?: { role?: string; kind?: string } | null) => p?.role === 'satellite' || (p?.role === 'member' && p.kind !== 'phone'),
  noteReached: vi.fn(),
  setTypedHost: vi.fn(() => true),
  getPeer: vi.fn().mockReturnValue(undefined),
  addPeer: vi.fn(),
  updateLastSeen: vi.fn(),
  recordLastSeen: vi.fn(),
  removePeer: vi.fn(),
  removeAllPeers: vi.fn(),
  listPeers: vi.fn().mockReturnValue([]),
  // Peers in these tests are pinned unless a test says otherwise.
  peerNeedsPairing: vi.fn().mockReturnValue(false),
}));

vi.mock('./annex-settings', () => ({
  networkEnabled: (s?: { networkEnabled?: boolean }) => s?.networkEnabled !== false,
  getSettings: vi.fn().mockReturnValue({
    enableServer: true,
    enableClient: true,
    deviceName: 'Test Mac',
    alias: 'Test Mac',
    icon: 'computer',
    color: 'indigo',
    autoReconnect: true,
  }),
}));

vi.mock('./log-service', () => ({
  appLog: vi.fn(),
}));

vi.mock('../util/ipc-broadcast', () => ({
  broadcastToAllWindows: vi.fn(),
}));

// Mock http module for httpGet/httpPost — must match `import * as http` in SUT
vi.mock('http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('http')>();
  return {
    ...actual,
    get: vi.fn(),
    request: vi.fn(),
  };
});

// Mock https module for REST endpoints (requestFileTree, requestBulletinDigest, etc.)
vi.mock('https', async (importOriginal) => {
  const actual = await importOriginal<typeof import('https')>();
  return { ...actual, get: vi.fn(), request: vi.fn(actual.request) };
});

import * as annexClient from './annex-client';
import { CAPACITY_SAMPLE_TIMEOUT_MS, withCapacityDeadline } from './handoff-capacity';
import { setProducingRuntime } from '../telemetry/__test-utils__/producing-runtime';
import type { TelemetryRuntime } from '../telemetry/types';
import * as annexPeers from './annex-peers';
import * as annexIdentity from './annex-identity';
import * as annexTls from './annex-tls';
import * as annexSettings from './annex-settings';
import { broadcastToAllWindows } from '../util/ipc-broadcast';
import { IPC } from '../../shared/ipc-channels';
import { EventEmitter } from 'events';
import * as http from 'http';
import * as https from 'https';

describe('bracketHost', () => {
  it('passes through IPv4 addresses', () => {
    expect(annexClient.bracketHost('192.168.1.50')).toBe('192.168.1.50');
  });

  it('passes through hostnames', () => {
    expect(annexClient.bracketHost('satellite.local')).toBe('satellite.local');
  });

  it('brackets IPv6 addresses', () => {
    expect(annexClient.bracketHost('2001:db8::1')).toBe('[2001:db8::1]');
  });

  it('does not double-bracket an already-bracketed IPv6 address', () => {
    expect(annexClient.bracketHost('[2001:db8::1]')).toBe('[2001:db8::1]');
  });
});

/** Reset all mock implementations after vi.clearAllMocks() */
function resetAllMocks() {
  vi.mocked(networkInterfaces).mockReset();
  resetBonjourMocks();
  vi.mocked(annexIdentity.getOrCreateIdentity).mockReturnValue(LOCAL_IDENTITY);
  vi.mocked(annexIdentity.getIdentity).mockReturnValue(LOCAL_IDENTITY);
  vi.mocked(annexPeers.getPeer).mockReturnValue(undefined);
  vi.mocked(annexSettings.getSettings).mockReturnValue({
    enableServer: true,
    enableClient: true,
    deviceName: 'Test Mac',
    alias: 'Test Mac',
    icon: 'computer',
    color: 'indigo',
    autoReconnect: true,
  });
  vi.mocked(annexPeers.peerNeedsPairing).mockReturnValue(false);
  vi.mocked(annexPeers.listPeers).mockReturnValue([]);
  vi.mocked(annexTls.createPinnedTlsClientOptions).mockReturnValue({ pinned: true } as any);
  vi.mocked(annexTls.signCertBinding).mockReturnValue('cert-binding');
  WebSocketMock.mockImplementation(function (this: any, _url?: string, _opts?: Record<string, any>) {
    this.readyState = WebSocketMock.OPEN;
    this.socket = {
      getPeerCertificate: () => ({ subject: { CN: 'PP:QQ:RR:SS' } }),
    };
    this.on = vi.fn().mockImplementation((event: string, cb: any) => {
      if (event === 'open') setTimeout(cb, 0);
      return this;
    });
    this.send = vi.fn();
    this.ping = vi.fn();
    this.close = vi.fn();
    this.terminate = vi.fn();
    this.removeListener = vi.fn();
    return this;
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeService(overrides: Record<string, any> = {}) {
  return {
    host: 'satellite.local',
    port: 9000,
    addresses: ['192.168.1.50'],
    txt: { pairingPort: '9001' },
    referer: { address: '192.168.1.50' },
    ...overrides,
  };
}

function makeMockSocket(peerFingerprint: string = LOCAL_IDENTITY.fingerprint) {
  return {
    getPeerCertificate: () => ({ subject: { CN: peerFingerprint } }),
  };
}

/** Simulate httpGet returning an identity JSON */
function mockHttpGetIdentity(identity: Record<string, any>) {
  vi.mocked(http.get).mockImplementation((_url: any, _options: any, cb: any) => {
    const res = {
      statusCode: 200,
      on: vi.fn().mockImplementation((event: string, handler: any) => {
        if (event === 'data') handler(JSON.stringify(identity));
        if (event === 'end') handler();
      }),
    };
    cb(res);
    return { on: vi.fn(), setTimeout: vi.fn() } as any;
  });
}


// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('annex-client', () => {
  beforeEach(() => {
    bonjourFindCallback = null;
    // Reset internal state by stopping client first (uses existing mocks)
    annexClient.stopClient();
    // Now reset all mocks (call counts, implementations) and re-wire
    vi.clearAllMocks();
    resetAllMocks();
  });

  afterEach(async () => {
    // Let scheduled mock socket-open callbacks finish before stopping the client;
    // otherwise they can restart a heartbeat or overwrite the next test's socket.
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
    else await new Promise((resolve) => setTimeout(resolve, 0));
    annexClient.stopClient();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  // ---- startClient / stopClient ----

  describe('startClient', () => {
    it.each([
      ['loopback', 'CLUBHOUSE_ANNEX_LOOPBACK_ONLY', '1'],
      ['selected interface', 'CLUBHOUSE_ANNEX_BIND_ADDRESS', '192.0.2.10'],
    ])('does not browse in an environment-selected %s profile, including scan and wake', (_profile, variable, value) => {
      vi.mocked(networkInterfaces).mockReturnValue({
        en0: [{ address: '192.0.2.10', internal: false, family: 'IPv4', netmask: '255.255.255.0', mac: '00:00:00:00:00:01', cidr: '192.0.2.10/24' }],
      });
      vi.stubEnv(variable, value);
      annexClient.startClient();
      annexClient.scan();
      annexClient.resumeAllConnections();
      expect(BonjourConstructor).not.toHaveBeenCalled();
      expect(mockBonjourInstance.find).not.toHaveBeenCalled();
    });

    it('does not identify a service after an environment isolation profile is enabled', async () => {
      mockHttpGetIdentity({ fingerprint: 'remote', alias: 'Remote', publicKey: 'key' });
      annexClient.startClient();
      vi.stubEnv('CLUBHOUSE_ANNEX_LOOPBACK_ONLY', '1');
      await bonjourFindCallback!(makeService());
      expect(http.get).not.toHaveBeenCalled();
      expect(annexClient.getDiscoveredServices()).toEqual([]);
    });

    it('ignores an identity response when the environment becomes isolated while it is pending', async () => {
      mockHttpGetIdentity({ fingerprint: 'remote', alias: 'Remote', publicKey: 'key' });
      annexClient.startClient();
      const pending = bonjourFindCallback!(makeService());
      vi.stubEnv('CLUBHOUSE_ANNEX_LOOPBACK_ONLY', '1');
      await pending;
      expect(annexClient.getDiscoveredServices()).toEqual([]);
    });

    it('aborts in-flight discovery identity requests when loopback mode is enabled', async () => {
      const actualHttp = await vi.importActual<typeof import('http')>('http');
      const sockets = new Set<import('net').Socket>();
      let sawRequest!: () => void;
      const requested = new Promise<void>((resolve) => { sawRequest = resolve; });
      const server = actualHttp.createServer(() => sawRequest());
      server.on('connection', (socket) => sockets.add(socket));
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected TCP address');
      try {
        await vi.mocked(http.get).withImplementation(actualHttp.get, async () => {
          annexClient.startClient();
          const discover = bonjourFindCallback!;
          const pending = discover(makeService({
            addresses: [], referer: { address: '127.0.0.1' }, txt: { pairingPort: String(address.port) },
          }));
          await requested;
          vi.mocked(annexSettings.getSettings).mockReturnValue({ ...annexSettings.getSettings(), loopbackOnly: true });
          annexClient.scan();
          await vi.waitFor(() => expect([...sockets].every((socket) => socket.destroyed)).toBe(true));
          await pending;
          await discover(makeService());
          annexClient.resumeAllConnections();
          expect(http.get).toHaveBeenCalledTimes(1);
          expect(annexClient.getDiscoveredServices()).toEqual([]);
          expect(mockBrowser.stop).toHaveBeenCalledOnce();
          expect(mockBonjourInstance.destroy).toHaveBeenCalledOnce();
          expect(mockBonjourInstance.find).toHaveBeenCalledTimes(1);
        });
      } finally {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('does not browse in loopback mode, even after a manual scan or wake', () => {
      vi.mocked(annexSettings.getSettings).mockReturnValue({ ...annexSettings.getSettings(), loopbackOnly: true });
      annexClient.startClient();
      annexClient.scan();
      annexClient.resumeAllConnections();
      expect(BonjourConstructor).not.toHaveBeenCalled();
      expect(mockBonjourInstance.find).not.toHaveBeenCalled();
    });

    it('stops browsing when loopback is enabled and resumes when disabled without forgetting a paired connection', () => {
      annexClient.startClient();
      annexClient._addConnectedSatelliteForTesting('paired');
      vi.mocked(annexSettings.getSettings).mockReturnValue({ ...annexSettings.getSettings(), loopbackOnly: true });
      annexClient.scan();
      expect(mockBrowser.stop).toHaveBeenCalledOnce();
      expect(mockBonjourInstance.destroy).toHaveBeenCalledOnce();
      expect(mockBonjourInstance.find).toHaveBeenCalledTimes(1);
      expect(annexClient.getSatellite('paired')?.state).toBe('connected');
      vi.mocked(annexSettings.getSettings).mockReturnValue({ ...annexSettings.getSettings(), loopbackOnly: false });
      annexClient.scan();
      expect(mockBonjourInstance.find).toHaveBeenCalledTimes(2);
      expect(annexClient.getSatellite('paired')?.state).toBe('connected');
      expect(annexPeers.removePeer).not.toHaveBeenCalled();
    });

    it('ignores a discovery result that finishes after loopback mode is enabled', async () => {
      mockHttpGetIdentity({ fingerprint: 'remote', alias: 'Remote', publicKey: 'key' });
      annexClient.startClient();
      const pending = bonjourFindCallback!(makeService());
      vi.mocked(annexSettings.getSettings).mockReturnValue({ ...annexSettings.getSettings(), loopbackOnly: true });
      annexClient.scan();
      await pending;
      expect(annexClient.getDiscoveredServices()).toEqual([]);
    });

    it('starts Bonjour discovery', () => {
      annexClient.startClient();
      expect(mockBonjourInstance.find).toHaveBeenCalledWith(
        { type: 'clubhouse-annex' },
        expect.any(Function),
      );
    });

    it('does not start twice when called again', () => {
      annexClient.startClient();
      annexClient.startClient();
      // find should only be called once because bonjourBrowser is already set
      expect(mockBonjourInstance.find).toHaveBeenCalledTimes(1);
    });
  });

  describe('stopClient', () => {
    it('stops Bonjour and clears state', () => {
      annexClient.startClient();
      annexClient.stopClient();
      expect(mockBrowser.stop).toHaveBeenCalled();
      expect(annexClient.getSatellites()).toEqual([]);
      expect(annexClient.getDiscoveredServices()).toEqual([]);
    });
  });

  // ---- Discovery — the core bug fix ----

  describe('discovery — unpaired services', () => {
    it('adds unpaired services to discoveredServices instead of dropping them', async () => {
      mockHttpGetIdentity({
        fingerprint: 'XX:YY:ZZ:11',
        alias: 'Remote Mac',
        icon: 'laptop',
        color: 'blue',
        publicKey: 'remote-pub-key',
      });

      annexClient.startClient();
      expect(bonjourFindCallback).not.toBeNull();

      // Simulate Bonjour finding a service
      await bonjourFindCallback!(makeService());

      const discovered = annexClient.getDiscoveredServices();
      expect(discovered).toHaveLength(1);
      expect(discovered[0]).toMatchObject({
        fingerprint: 'XX:YY:ZZ:11',
        alias: 'Remote Mac',
        icon: 'laptop',
        color: 'blue',
        host: '192.168.1.50',
        publicKey: 'remote-pub-key',
      });

      // Should NOT appear in satellites
      expect(annexClient.getSatellites()).toHaveLength(0);

      // Should broadcast discovered change
      expect(broadcastToAllWindows).toHaveBeenCalledWith(
        IPC.ANNEX_CLIENT.DISCOVERED_CHANGED,
        expect.any(Array),
      );
    });

    it('skips our own identity', async () => {
      mockHttpGetIdentity({
        fingerprint: 'AA:BB:CC:DD', // Same as local identity
        alias: 'Self',
        icon: 'computer',
        color: 'indigo',
        publicKey: 'local-pub-key',
      });

      annexClient.startClient();
      await bonjourFindCallback!(makeService());

      expect(annexClient.getDiscoveredServices()).toHaveLength(0);
      expect(annexClient.getSatellites()).toHaveLength(0);
    });

    it('updates host/port for already-discovered services', async () => {
      mockHttpGetIdentity({
        fingerprint: 'XX:YY:ZZ:11',
        alias: 'Remote Mac',
        icon: 'laptop',
        color: 'blue',
        publicKey: 'remote-pub-key',
      });

      annexClient.startClient();
      await bonjourFindCallback!(makeService());
      expect(annexClient.getDiscoveredServices()[0].host).toBe('192.168.1.50');

      // Same fingerprint, different host/address
      await bonjourFindCallback!(makeService({ host: 'new-host.local', port: 9999, addresses: ['10.0.0.5'] }));
      const discovered = annexClient.getDiscoveredServices();
      expect(discovered).toHaveLength(1);
      expect(discovered[0].host).toBe('10.0.0.5');
      expect(discovered[0].mainPort).toBe(9999);
    });
  });

  describe('discovery — paired services', () => {
    it('adds paired services to satellites and auto-connects', async () => {
      mockHttpGetIdentity({
        fingerprint: 'PP:QQ:RR:SS',
        alias: 'Paired Mac',
        icon: 'server',
        color: 'green',
        publicKey: 'paired-pub-key',
      });

      vi.mocked(annexPeers.getPeer).mockReturnValue({
        fingerprint: 'PP:QQ:RR:SS',
        alias: 'Paired Mac',
        icon: 'server',
        color: 'green',
        publicKey: 'paired-pub-key',
        pairedAt: '2024-01-01',
        lastSeen: '2024-01-01',
      });

      annexClient.startClient();
      await bonjourFindCallback!(makeService());

      expect(annexClient.getSatellites()).toHaveLength(1);
      expect(annexClient.getSatellites()[0]).toMatchObject({
        fingerprint: 'PP:QQ:RR:SS',
        alias: 'Paired Mac',
      });
      // State is 'connecting' or 'disconnected' (mock WS error fires synchronously)
      // The key assertion is that it's no longer stuck in 'discovering'
      expect(['connecting', 'disconnected']).toContain(annexClient.getSatellites()[0].state);
      expect(annexClient.getDiscoveredServices()).toHaveLength(0);
    });

    it('moves a service from discovered to satellites when it becomes paired', async () => {
      mockHttpGetIdentity({
        fingerprint: 'XX:YY:ZZ:11',
        alias: 'Remote Mac',
        icon: 'laptop',
        color: 'blue',
        publicKey: 'remote-pub-key',
      });

      // First discovery: unpaired

      annexClient.startClient();
      await bonjourFindCallback!(makeService());
      expect(annexClient.getDiscoveredServices()).toHaveLength(1);

      // Second discovery: now paired

      vi.mocked(annexPeers.getPeer).mockReturnValue({
        fingerprint: 'XX:YY:ZZ:11',
        alias: 'Remote Mac',
        icon: 'laptop',
        color: 'blue',
        publicKey: 'remote-pub-key',
        pairedAt: '2024-01-01',
        lastSeen: '2024-01-01',
      });
      await bonjourFindCallback!(makeService());

      expect(annexClient.getDiscoveredServices()).toHaveLength(0);
      expect(annexClient.getSatellites()).toHaveLength(1);
    });
  });

  // ---- scan ----

  describe('scan', () => {
    it('clears discovered services and restarts discovery', async () => {
      mockHttpGetIdentity({
        fingerprint: 'XX:YY:ZZ:11',
        alias: 'Remote Mac',
        icon: 'laptop',
        color: 'blue',
        publicKey: 'remote-pub-key',
      });

      annexClient.startClient();
      await bonjourFindCallback!(makeService());
      expect(annexClient.getDiscoveredServices()).toHaveLength(1);

      annexClient.scan();
      // Discovered should be cleared
      expect(annexClient.getDiscoveredServices()).toHaveLength(0);
      // Discovery should be restarted (find called again)
      expect(mockBonjourInstance.find).toHaveBeenCalledTimes(2);
    });
  });

  // ---- pairWithService ----

  // ---- getDiscoveredServices / getSatellites ----

  describe('getDiscoveredServices', () => {
    it('returns empty array initially', () => {
      expect(annexClient.getDiscoveredServices()).toEqual([]);
    });
  });

  describe('getSatellites', () => {
    it('returns empty array initially', () => {
      expect(annexClient.getSatellites()).toEqual([]);
    });
  });

  // ---- forgetSatellite ----

  describe('forgetSatellite', () => {
    it('disconnects, removes peer, and clears satellite from state', async () => {
      // Set up a paired satellite via discovery
      mockHttpGetIdentity({
        fingerprint: 'PP:QQ:RR:SS',
        alias: 'Paired Mac',
        icon: 'server',
        color: 'green',
        publicKey: 'paired-pub-key',
      });

      vi.mocked(annexPeers.getPeer).mockReturnValue({
        fingerprint: 'PP:QQ:RR:SS',
        alias: 'Paired Mac',
        icon: 'server',
        color: 'green',
        publicKey: 'paired-pub-key',
        pairedAt: '2024-01-01',
        lastSeen: '2024-01-01',
      });

      annexClient.startClient();
      await bonjourFindCallback!(makeService());
      expect(annexClient.getSatellites()).toHaveLength(1);

      // Now forget
      annexClient.forgetSatellite('PP:QQ:RR:SS');

      expect(annexClient.getSatellites()).toHaveLength(0);
      expect(annexPeers.removePeer).toHaveBeenCalledWith('PP:QQ:RR:SS');
    });

    it('is a no-op for unknown fingerprints', () => {
      annexClient.forgetSatellite('unknown:fingerprint');
      expect(annexPeers.removePeer).toHaveBeenCalledWith('unknown:fingerprint');
      expect(annexClient.getSatellites()).toHaveLength(0);
    });
  });

  // ---- forgetAllSatellites ----

  describe('forgetAllSatellites', () => {
    it('disconnects all, removes the satellite pairings, and clears all state', async () => {
      mockHttpGetIdentity({
        fingerprint: 'PP:QQ:RR:SS',
        alias: 'Paired Mac',
        icon: 'server',
        color: 'green',
        publicKey: 'paired-pub-key',
      });

      vi.mocked(annexPeers.getPeer).mockReturnValue({
        fingerprint: 'PP:QQ:RR:SS',
        alias: 'Paired Mac',
        icon: 'server',
        color: 'green',
        publicKey: 'paired-pub-key',
        pairedAt: '2024-01-01',
        lastSeen: '2024-01-01',
      });

      annexClient.startClient();
      await bonjourFindCallback!(makeService());
      expect(annexClient.getSatellites()).toHaveLength(1);

      vi.mocked(annexPeers.listPeers).mockReturnValue([
        { fingerprint: 'PP:QQ:RR:SS', role: 'satellite' },
        { fingerprint: 'PHONE:01', role: 'controller' },
        { fingerprint: 'OLD:01' },
      ] as any);
      annexClient.forgetAllSatellites();

      expect(annexClient.getSatellites()).toHaveLength(0);
      expect(annexClient.getDiscoveredServices()).toHaveLength(0);
      // Devices that control this machine are left alone; they're managed in Annex settings.
      expect(vi.mocked(annexPeers.removePeer).mock.calls.map(([fp]) => fp)).toEqual(['PP:QQ:RR:SS', 'OLD:01']);
      expect(annexPeers.removeAllPeers).not.toHaveBeenCalled();
    });
  });

  // ---- protocol version rejection ----

  describe('snapshot protocol version validation', () => {
    it('rejects mismatched protocolVersion and keeps the last accepted snapshot intact', async () => {
      const { WebSocket: WsMock } = await import('ws');
      const FINGERPRINT = 'PROT:V1:MISMATCH';
      let messageHandler: ((data: any) => void) | null = null;

      mockHttpGetIdentity({
        fingerprint: FINGERPRINT,
        alias: 'Protocol Mismatch',
        icon: 'server',
        color: 'green',
        publicKey: 'protocol-mismatch-key',
      });

      vi.mocked(annexPeers.getPeer).mockReturnValue({
        fingerprint: FINGERPRINT,
        alias: 'Protocol Mismatch',
        icon: 'server',
        color: 'green',
        publicKey: 'protocol-mismatch-key',
        pairedAt: '2024-01-01',
        lastSeen: '2024-01-01',
      });

      vi.mocked(WsMock).mockImplementation(function (this: any) {
        this.readyState = 1;
        this.socket = makeMockSocket(FINGERPRINT);
        this.on = vi.fn().mockImplementation((event: string, cb: any) => {
          if (event === 'open') setTimeout(cb, 0);
          if (event === 'message') messageHandler = cb;
          return this;
        });
        this.send = vi.fn();
        this.ping = vi.fn();
        this.close = vi.fn();
        this.terminate = vi.fn();
        this.removeListener = vi.fn();
        return this;
      });

      annexClient.startClient();
      await bonjourFindCallback!(makeService());
      await new Promise((resolve) => setTimeout(resolve, 0));

      const accepted = {
        projects: [],
        agents: {},
        quickAgents: {},
        theme: null,
        orchestrators: null,
        pendingPermissions: [],
        lastSeq: 7,
        protocolVersion: 2,
      };
      messageHandler!(JSON.stringify({ type: 'snapshot', payload: accepted }));

      const mismatched = {
        ...accepted,
        lastSeq: 8,
        protocolVersion: 99,
      };
      messageHandler!(JSON.stringify({ type: 'snapshot', payload: mismatched }));

      const sat = annexClient.getSatellites().find((s) => s.id === FINGERPRINT);
      expect(sat?.snapshot?.lastSeq).toBe(7);
      expect(sat?.state).toBe('disconnected');
      expect(sat?.lastError).toMatch(/can't connect to this one\. Update Clubhouse on both computers\./);
      expect(sat?.problem?.code).toBe('incompatible');
    });
  });

  // ---- mTLS reconnection ----

  describe('snapshot order', () => {
    const FINGERPRINT = 'SNAP:ORDER';
    const snapshot = (lastSeq: number, name: string) => Buffer.from(JSON.stringify({ type: 'snapshot', payload: {
      protocolVersion: 2, projects: [{ id: name }], agents: {}, quickAgents: {}, theme: null, orchestrators: null, pendingPermissions: [], lastSeq,
    } }));

    it('drops an older snapshot on one connection, but always takes a new connection\'s first', async () => {
      const { WebSocket: WsMock } = await import('ws');
      let messageHandler: ((data: any) => void) | null = null;
      mockHttpGetIdentity({ fingerprint: FINGERPRINT, alias: 'Order', icon: 'server', color: 'green', publicKey: 'order-key' });
      vi.mocked(annexPeers.getPeer).mockReturnValue({ fingerprint: FINGERPRINT, alias: 'Order', icon: 'server', color: 'green', publicKey: 'order-key', pairedAt: '2024-01-01', lastSeen: '2024-01-01' });
      vi.mocked(WsMock).mockImplementation(function (this: any) {
        this.readyState = 1;
        this.socket = makeMockSocket(FINGERPRINT);
        this.on = vi.fn().mockImplementation((event: string, cb: any) => {
          if (event === 'open') setTimeout(cb, 0);
          if (event === 'message') messageHandler = cb;
          return this;
        });
        this.send = vi.fn(); this.ping = vi.fn(); this.close = vi.fn(); this.terminate = vi.fn(); this.removeListener = vi.fn();
        return this;
      });
      annexClient.startClient();
      await bonjourFindCallback!(makeService());
      await vi.waitFor(() => expect(messageHandler).not.toBeNull());
      const shown = () => (annexClient.getSatellite(FINGERPRINT)!.snapshot!.projects[0] as { id: string }).id;

      messageHandler!(snapshot(100, 'first'));
      expect(shown()).toBe('first');
      messageHandler!(snapshot(50, 'stale'));
      expect(shown()).toBe('first');

      // The satellite restarted, so its seq began again.
      const before = messageHandler;
      annexClient.disconnect(FINGERPRINT);
      annexClient.connect(FINGERPRINT);
      await vi.waitFor(() => expect(messageHandler).not.toBe(before));
      messageHandler!(snapshot(0, 'after restart'));
      expect(shown()).toBe('after restart');
    });
  });

  describe('a satellite that cannot build a snapshot', () => {
    const FINGERPRINT = 'SNAP:FAILED';
    const frame = (value: object) => Buffer.from(JSON.stringify(value));
    const snapshot = { type: 'snapshot', payload: { protocolVersion: 2, projects: [], agents: {}, quickAgents: {}, theme: null, orchestrators: null, pendingPermissions: [], lastSeq: 1 } };

    async function connected() {
      const { WebSocket: WsMock } = await import('ws');
      let messageHandler: ((data: any) => void) | null = null;
      mockHttpGetIdentity({ fingerprint: FINGERPRINT, alias: 'Failed', icon: 'server', color: 'green', publicKey: 'failed-key' });
      vi.mocked(annexPeers.getPeer).mockReturnValue({ fingerprint: FINGERPRINT, alias: 'Failed', icon: 'server', color: 'green', publicKey: 'failed-key', pairedAt: '2024-01-01', lastSeen: '2024-01-01' });
      vi.mocked(WsMock).mockImplementation(function (this: any) {
        this.readyState = 1;
        this.socket = makeMockSocket(FINGERPRINT);
        this.on = vi.fn().mockImplementation((event: string, cb: any) => {
          if (event === 'open') setTimeout(cb, 0);
          if (event === 'message') messageHandler = cb;
          return this;
        });
        this.send = vi.fn(); this.ping = vi.fn(); this.close = vi.fn(); this.terminate = vi.fn(); this.removeListener = vi.fn();
        return this;
      });
      annexClient.startClient();
      await bonjourFindCallback!(makeService());
      await vi.waitFor(() => expect(messageHandler).not.toBeNull());
      return () => messageHandler!;
    }
    const sat = () => annexClient.getSatellite(FINGERPRINT)!;

    it('says so until a snapshot arrives, and stays connected', async () => {
      const handler = await connected();
      await vi.waitFor(() => expect(sat().state).toBe('connected'));
      handler()(frame({ type: 'error', payload: { message: 'snapshot_failed' } }));
      expect(sat().snapshotUnavailable).toBe(true);
      expect(sat().state).toBe('connected');

      handler()(frame(snapshot));
      expect(sat().snapshotUnavailable).toBeUndefined();
    });

    it('is not set by any other error', async () => {
      const handler = await connected();
      handler()(frame({ type: 'error', payload: { message: 'project_not_found' } }));
      expect(sat().snapshotUnavailable).toBeUndefined();
    });

    it('starts clear on a new connection', async () => {
      const handler = await connected();
      await vi.waitFor(() => expect(sat().state).toBe('connected'));
      handler()(frame({ type: 'error', payload: { message: 'snapshot_failed' } }));
      annexClient.disconnect(FINGERPRINT);
      annexClient.connect(FINGERPRINT);
      expect(sat().snapshotUnavailable).toBeUndefined();
    });
  });

  describe('canvases a satellite left out of its snapshot', () => {
    const FINGERPRINT = 'CANVAS:OMITTED';
    const STATE = { canvases: [{ id: 'canvas_1', name: 'Main', views: [] }], activeCanvasId: 'canvas_1' };
    let send: (frame: object) => void;
    let routes: Record<string, { status: number; body: unknown }>;

    async function connectedSatellite() {
      const { WebSocket: WsMock } = await import('ws');
      let messageHandler: ((data: any) => void) | null = null;
      mockHttpGetIdentity({ fingerprint: FINGERPRINT, alias: 'Canvas', icon: 'server', color: 'green', publicKey: 'canvas-key' });
      vi.mocked(annexPeers.getPeer).mockReturnValue({
        fingerprint: FINGERPRINT, alias: 'Canvas', icon: 'server', color: 'green', publicKey: 'canvas-key', pairedAt: '2024-01-01', lastSeen: '2024-01-01',
      });
      vi.mocked(WsMock).mockImplementation(function (this: any) {
        this.readyState = 1;
        this.socket = makeMockSocket(FINGERPRINT);
        this.on = vi.fn().mockImplementation((event: string, cb: any) => {
          if (event === 'open') setTimeout(cb, 0);
          if (event === 'message') messageHandler = cb;
          return this;
        });
        this.send = vi.fn(); this.ping = vi.fn(); this.close = vi.fn(); this.terminate = vi.fn(); this.removeListener = vi.fn();
        return this;
      });
      vi.mocked(https.request).mockImplementation(((url: string, _options: unknown, cb: (res: unknown) => void) => {
        const { status, body } = routes[new URL(url).pathname] ?? { status: 404, body: {} };
        const req = new EventEmitter() as any;
        req.write = vi.fn();
        req.destroy = vi.fn();
        req.end = () => {
          const res = new EventEmitter() as any;
          res.statusCode = status;
          cb(res);
          res.emit('data', Buffer.from(JSON.stringify(body)));
          res.emit('end');
        };
        return req;
      }) as never);
      annexClient.startClient();
      await bonjourFindCallback!(makeService());
      await vi.waitFor(() => expect(messageHandler).not.toBeNull());
      send = (frame) => messageHandler!(Buffer.from(JSON.stringify(frame)));
      await vi.waitFor(() => expect(annexClient.getSatellites()[0]?.state).toBe('connected'));
    }

    const truncated = (lastSeq: number) => ({
      type: 'snapshot',
      payload: {
        protocolVersion: 2, projects: [{ id: 'proj_1' }], agents: {}, quickAgents: {}, theme: {}, orchestrators: {}, pendingPermissions: [], lastSeq,
        snapshotTruncated: { version: 1, reason: 'frame_limit', omitted: ['canvasState', 'appCanvasState'], bytes: 9_000_000 },
      },
    });
    const snapshotEvents = () => vi.mocked(broadcastToAllWindows).mock.calls
      .filter(([channel, event]) => channel === IPC.ANNEX_CLIENT.SATELLITE_EVENT && (event as { type: string }).type === 'snapshot')
      .map(([, event]) => (event as { payload: any }).payload);
    const requested = () => vi.mocked(https.request).mock.calls.map(([url]) => new URL(url as string).pathname);

    beforeEach(() => {
      vi.mocked(https.request).mockClear();
      routes = {
        '/api/v1/mobile/canvas/proj_1': { status: 200, body: { projectId: 'proj_1', state: STATE } },
        '/api/v1/mobile/canvas': { status: 200, body: { state: { ...STATE, activeCanvasId: 'app' } } },
      };
    });

    it('a controller connecting fresh still gets them, through the routes, as a snapshot', async () => {
      await connectedSatellite();
      send(truncated(5));

      await vi.waitFor(() => expect(snapshotEvents().at(-1)?.canvasState).toEqual({ proj_1: STATE }));
      expect(snapshotEvents().at(-1).appCanvasState.activeCanvasId).toBe('app');
      expect(annexClient.getSatellites().find((s) => s.fingerprint === FINGERPRINT)?.snapshot).toMatchObject({ canvasState: { proj_1: STATE } });
    });

    it('fetches once per connection, and keeps them through later truncated snapshots', async () => {
      await connectedSatellite();
      send(truncated(5));
      await vi.waitFor(() => expect(snapshotEvents().at(-1)?.canvasState).toBeDefined());
      const fetches = requested().length;

      send(truncated(6));
      await new Promise((r) => setTimeout(r, 10));

      expect(requested()).toHaveLength(fetches);
      expect(snapshotEvents().at(-1).lastSeq).toBe(6);
      expect(snapshotEvents().at(-1).canvasState).toEqual({ proj_1: STATE });
    });

    it('does not fetch when nothing was left out', async () => {
      await connectedSatellite();
      send({ type: 'snapshot', payload: { ...truncated(5).payload, snapshotTruncated: undefined, canvasState: { proj_1: STATE }, appCanvasState: null } });
      await new Promise((r) => setTimeout(r, 10));
      expect(requested()).toEqual([]);
      expect(snapshotEvents().at(-1).canvasState).toEqual({ proj_1: STATE });
    });

    it('stays connected if a satellite can not serve them, and tries on the next snapshot', async () => {
      routes = {};
      await connectedSatellite();
      send(truncated(5));
      await vi.waitFor(() => expect(requested().length).toBeGreaterThan(0));
      await new Promise((r) => setTimeout(r, 10));
      expect(annexClient.getSatellites().find((s) => s.fingerprint === FINGERPRINT)?.state).toBe('connected');

      routes = { '/api/v1/mobile/canvas/proj_1': { status: 200, body: { state: STATE } }, '/api/v1/mobile/canvas': { status: 200, body: { state: null } } };
      send(truncated(6));
      await vi.waitFor(() => expect(snapshotEvents().at(-1)?.canvasState).toEqual({ proj_1: STATE }));
    });

    describe('with a canvas changed after it was known', () => {
      const edit = (name: string) => ({
        type: 'canvas:state',
        payload: { projectId: 'proj_1', state: { canvasId: 'canvas_1', name, views: [{ id: 'v' }], viewport: { panX: 0, panY: 0, zoom: 1 }, nextZIndex: 1, zoomedViewId: null, allCanvasTabs: [{ id: 'canvas_1', name }], activeCanvasId: 'canvas_1' } },
      });
      const canvasNames = (payload: any) => payload.canvasState.proj_1.canvases.map((c: { name: string }) => c.name);

      it('a later truncated snapshot does not put the old canvas back', async () => {
        await connectedSatellite();
        send(truncated(5));
        await vi.waitFor(() => expect(snapshotEvents().at(-1)?.canvasState).toBeDefined());

        send(edit('Edited'));
        send(truncated(6));

        expect(canvasNames(snapshotEvents().at(-1))).toEqual(['Edited']);
        expect(canvasNames(annexClient.getSatellite(FINGERPRINT)!.snapshot)).toEqual(['Edited']);
      });

      it('keeps the other canvases and wires when one changes', async () => {
        const other = { id: 'canvas_2', name: 'Other', views: [{ id: 'kept' }] };
        const wireDefinitions = [{ agentId: 'a', targetId: 'b' }];
        routes['/api/v1/mobile/canvas/proj_1'] = { status: 200, body: { state: { canvases: [{ id: 'canvas_1', name: 'Main' }, other], activeCanvasId: 'canvas_1', wireDefinitions } } };
        await connectedSatellite();
        send(truncated(5));
        await vi.waitFor(() => expect(snapshotEvents().at(-1)?.canvasState).toBeDefined());

        send({ type: 'canvas:state', payload: { projectId: 'proj_1', state: { canvasId: 'canvas_1', name: 'Edited', views: [], viewport: {}, nextZIndex: 0, zoomedViewId: null } } });
        send(truncated(6));

        const state = snapshotEvents().at(-1).canvasState.proj_1;
        expect(state.canvases).toHaveLength(2);
        expect(state.canvases[0].name).toBe('Edited');
        expect(state.canvases[1]).toEqual(other);
        expect(state.wireDefinitions).toEqual(wireDefinitions);
      });

      it('keeps a change made while the fetch was running', async () => {
        await connectedSatellite();
        send(truncated(5));
        send(edit('During'));
        await vi.waitFor(() => expect(snapshotEvents().at(-1)?.canvasState).toBeDefined());
        expect(canvasNames(snapshotEvents().at(-1))).toEqual(['During']);
      });

      it('updates a full snapshot too, and app canvases by scope', async () => {
        await connectedSatellite();
        send({ type: 'snapshot', payload: { ...truncated(5).payload, snapshotTruncated: undefined, canvasState: { proj_1: STATE }, appCanvasState: STATE } });
        send(edit('Edited'));
        send({ type: 'canvas:state', payload: { projectId: null, scope: 'global', state: { ...edit('App').payload.state } } });
        const kept = annexClient.getSatellite(FINGERPRINT)!.snapshot as any;
        expect(canvasNames(kept)).toEqual(['Edited']);
        expect(kept.appCanvasState.canvases[0].name).toBe('App');
      });

      it('does not make up a whole project from one canvas it knows nothing else about', async () => {
        await connectedSatellite();
        send({ type: 'snapshot', payload: { ...truncated(5).payload, snapshotTruncated: undefined, canvasState: {} } });
        send(edit('Lonely'));
        expect((annexClient.getSatellite(FINGERPRINT)!.snapshot as any).canvasState).toEqual({});
        expect(vi.mocked(broadcastToAllWindows).mock.calls.some(([, e]) => (e as { type?: string })?.type === 'canvas:state')).toBe(true);
      });
    });

    describe('with a project that appears after the fetch', () => {
      const NEW_ROUTE = '/api/v1/mobile/canvas/proj_new';
      const NEW_STATE = { canvases: [{ id: 'new_canvas', name: 'New', views: [] }], activeCanvasId: 'new_canvas' };
      const withNew = (lastSeq: number) => {
        const frame = truncated(lastSeq);
        return { ...frame, payload: { ...frame.payload, projects: [{ id: 'proj_1' }, { id: 'proj_new' }] } };
      };
      const fetched = async () => {
        await connectedSatellite();
        send(truncated(5));
        await vi.waitFor(() => expect(snapshotEvents().at(-1)?.canvasState).toBeDefined());
        vi.mocked(https.request).mockClear();
      };

      beforeEach(() => { routes[NEW_ROUTE] = { status: 200, body: { projectId: 'proj_new', state: NEW_STATE } }; });

      it('fetches only that project, and sends it on as a snapshot', async () => {
        await fetched();
        send(withNew(6));

        await vi.waitFor(() => expect(snapshotEvents().at(-1)?.canvasState.proj_new).toEqual(NEW_STATE));
        expect(snapshotEvents().at(-1).canvasState.proj_1).toEqual(STATE);
        expect(requested()).toEqual([NEW_ROUTE]);
      });

      it('asks once, however many truncated snapshots follow, even when it has no canvases', async () => {
        routes[NEW_ROUTE] = { status: 200, body: { projectId: 'proj_new', state: null } };
        await fetched();
        for (let seq = 6; seq < 12; seq++) send(withNew(seq));
        await new Promise((r) => setTimeout(r, 20));
        send(withNew(12));
        await new Promise((r) => setTimeout(r, 20));

        expect(requested()).toEqual([NEW_ROUTE]);
      });

      it('fetches each of several, one at a time, including one that appears during the first', async () => {
        routes['/api/v1/mobile/canvas/proj_other'] = { status: 200, body: { state: STATE } };
        await fetched();
        send(withNew(6));
        const frame = withNew(7);
        send({ ...frame, payload: { ...frame.payload, projects: [...frame.payload.projects, { id: 'proj_other' }] } });

        await vi.waitFor(() => expect(snapshotEvents().at(-1)?.canvasState.proj_other).toEqual(STATE));
        expect(snapshotEvents().at(-1).canvasState.proj_new).toEqual(NEW_STATE);
        expect(requested()).toEqual([NEW_ROUTE, '/api/v1/mobile/canvas/proj_other']);
      });

      it('picks up one that appeared while the first fetch was running', async () => {
        await connectedSatellite();
        send(truncated(5));
        send(withNew(6));

        await vi.waitFor(() => expect(snapshotEvents().at(-1)?.canvasState?.proj_new).toEqual(NEW_STATE));
        expect(snapshotEvents().at(-1).canvasState.proj_1).toEqual(STATE);
        expect(requested().filter((path) => path === NEW_ROUTE)).toHaveLength(1);
      });

      it('tries again on the next snapshot if the fetch fails, one request each time', async () => {
        routes[NEW_ROUTE] = { status: 500, body: {} };
        await fetched();
        send(withNew(6));
        await vi.waitFor(() => expect(requested()).toEqual([NEW_ROUTE]));
        await new Promise((r) => setTimeout(r, 10));
        expect(requested()).toEqual([NEW_ROUTE]);

        routes[NEW_ROUTE] = { status: 200, body: { state: NEW_STATE } };
        send(withNew(7));
        await vi.waitFor(() => expect(snapshotEvents().at(-1)?.canvasState.proj_new).toEqual(NEW_STATE));
        expect(requested()).toEqual([NEW_ROUTE, NEW_ROUTE]);
      });

      it('keeps a change made to it during its fetch', async () => {
        await fetched();
        send(withNew(6));
        send({ type: 'canvas:state', payload: { projectId: 'proj_new', state: { canvasId: 'new_canvas', name: 'During', views: [], viewport: {}, nextZIndex: 0, zoomedViewId: null } } });

        await vi.waitFor(() => expect(snapshotEvents().at(-1)?.canvasState.proj_new).toBeDefined());
        expect(snapshotEvents().at(-1).canvasState.proj_new.canvases[0].name).toBe('During');
      });

      it('does not fetch one a snapshot already gave it', async () => {
        await fetched();
        const frame = withNew(6);
        send({ type: 'snapshot', payload: { ...frame.payload, snapshotTruncated: undefined, canvasState: { proj_1: STATE, proj_new: NEW_STATE } } });
        send(withNew(7));
        await new Promise((r) => setTimeout(r, 20));

        expect(requested()).toEqual([]);
        expect(snapshotEvents().at(-1).canvasState.proj_new).toEqual(NEW_STATE);
      });
    });

    describe('with a canvas too large for a frame', () => {
      const full = () => ({ type: 'snapshot', payload: { ...truncated(5).payload, snapshotTruncated: undefined, canvasState: { proj_1: STATE }, appCanvasState: STATE } });
      const marker = { type: 'canvas:state', payload: { projectId: 'proj_1', stateOmitted: { version: 1, reason: 'frame_limit', bytes: 9_000_000 } } };
      const edit = (name: string) => ({ type: 'canvas:state', payload: { projectId: 'proj_1', state: { canvasId: 'canvas_1', name, views: [], viewport: {}, nextZIndex: 0, zoomedViewId: null } } });
      const big = (name: string) => ({ canvases: [{ id: 'canvas_1', name }], activeCanvasId: 'canvas_1' });
      const held = () => {
        const release: Array<() => void> = [];
        vi.mocked(https.request).mockImplementation(((url: string, _options: unknown, cb: (res: unknown) => void) => {
          const { status, body } = routes[new URL(url).pathname] ?? { status: 404, body: {} };
          const req = new EventEmitter() as any;
          req.write = vi.fn();
          req.destroy = vi.fn();
          req.end = () => release.push(() => {
            const res = new EventEmitter() as any;
            res.statusCode = status;
            cb(res);
            res.emit('data', Buffer.from(JSON.stringify(body)));
            res.emit('end');
          });
          return req;
        }) as never);
        return release;
      };

      it('fetches that one project, and sends it on as a snapshot', async () => {
        await connectedSatellite();
        send(full());
        routes['/api/v1/mobile/canvas/proj_1'] = { status: 200, body: { state: big('Fetched') } };
        send(marker);
        await vi.waitFor(() => expect(snapshotEvents().at(-1).canvasState.proj_1.canvases[0].name).toBe('Fetched'));
        expect(requested()).toEqual(['/api/v1/mobile/canvas/proj_1']);
        expect(vi.mocked(broadcastToAllWindows).mock.calls.some(([, e]) => (e as any)?.type === 'canvas:state' && (e as any)?.payload?.stateOmitted)).toBe(false);
      });

      it('fetches the app\'s for a global one', async () => {
        await connectedSatellite();
        send(full());
        routes['/api/v1/mobile/canvas'] = { status: 200, body: { state: big('App') } };
        send({ type: 'canvas:state', payload: { projectId: null, scope: 'global', stateOmitted: { version: 1, bytes: 1 } } });
        await vi.waitFor(() => expect(snapshotEvents().at(-1).appCanvasState.canvases[0].name).toBe('App'));
      });

      it('keeps a change made during the fetch on top of what it returns', async () => {
        await connectedSatellite();
        send(full());
        routes['/api/v1/mobile/canvas/proj_1'] = { status: 200, body: { state: big('Fetched') } };
        const release = held();
        send(marker);
        send(edit('During'));
        await vi.waitFor(() => expect(release.length).toBe(1));
        release[0]();
        await vi.waitFor(() => expect(snapshotEvents().at(-1).canvasState.proj_1.canvases[0].name).toBe('During'));
      });

      it('fetches once more for a marker during a fetch, not once each', async () => {
        await connectedSatellite();
        send(full());
        routes['/api/v1/mobile/canvas/proj_1'] = { status: 200, body: { state: big('First') } };
        const release = held();
        send(marker);
        send(marker);
        send(marker);
        await vi.waitFor(() => expect(release.length).toBe(1));
        routes['/api/v1/mobile/canvas/proj_1'] = { status: 200, body: { state: big('Second') } };
        release[0]();
        await vi.waitFor(() => expect(release.length).toBe(2));
        release[1]();
        await vi.waitFor(() => expect(snapshotEvents().at(-1).canvasState.proj_1.canvases[0].name).toBe('Second'));
        expect(release).toHaveLength(2);
      });

      it('does not put a fetch over a full snapshot that came meanwhile', async () => {
        await connectedSatellite();
        send(full());
        routes['/api/v1/mobile/canvas/proj_1'] = { status: 200, body: { state: big('Older') } };
        const release = held();
        send(marker);
        await vi.waitFor(() => expect(release.length).toBe(1));
        send({ type: 'snapshot', payload: { ...full().payload, lastSeq: 6, canvasState: { proj_1: big('Newer') } } });
        release[0]();
        await new Promise((r) => setTimeout(r, 20));
        expect(snapshotEvents().at(-1).canvasState.proj_1.canvases[0].name).toBe('Newer');
      });

      it('keeps what it has and stays connected when the fetch fails, and tries on the next marker', async () => {
        await connectedSatellite();
        send(full());
        routes = {};
        send(marker);
        await vi.waitFor(() => expect(requested().length).toBeGreaterThan(0));
        await new Promise((r) => setTimeout(r, 10));
        const satellite = annexClient.getSatellites().find((s) => s.fingerprint === FINGERPRINT);
        expect(satellite?.state).toBe('connected');
        expect((satellite?.snapshot as any).canvasState).toEqual({ proj_1: STATE });

        routes = { '/api/v1/mobile/canvas/proj_1': { status: 200, body: { state: big('Later') } } };
        send(marker);
        await vi.waitFor(() => expect(snapshotEvents().at(-1).canvasState.proj_1.canvases[0].name).toBe('Later'));
      });

      it('fetches again after the first fetch, if a marker came during it', async () => {
        await connectedSatellite();
        const release = held();
        send(truncated(5));
        await vi.waitFor(() => expect(release.length).toBe(1));
        send(marker);
        await vi.waitFor(() => expect(release.length).toBe(2));
        routes['/api/v1/mobile/canvas/proj_1'] = { status: 200, body: { state: big('After') } };
        for (let i = 0; i < 4; i++) {
          await new Promise((r) => setTimeout(r, 5));
          for (const go of release.splice(0)) go();
        }
        await vi.waitFor(() => expect(snapshotEvents().at(-1)?.canvasState?.proj_1?.canvases[0].name).toBe('After'));
      });
    });

    it('does not put an older fetch over a full snapshot that came meanwhile', async () => {
      await connectedSatellite();
      send(truncated(5));
      const newer = { canvases: [], activeCanvasId: 'newer' };
      send({ type: 'snapshot', payload: { ...truncated(6).payload, snapshotTruncated: undefined, canvasState: { proj_1: newer } } });
      await new Promise((r) => setTimeout(r, 20));
      expect(snapshotEvents().at(-1).canvasState).toEqual({ proj_1: newer });
    });
  });

  describe('a socket a newer connection has replaced', () => {
    const FINGERPRINT = 'OLD:SOCKET';
    type Handlers = Record<string, (...args: any[]) => void>;
    let sockets: Array<{ handlers: Handlers; send: ReturnType<typeof vi.fn> }>;

    /** Connected on a second socket, with the first's disconnect not yet finished. */
    async function replacedSocket() {
      const { WebSocket: WsMock } = await import('ws');
      sockets = [];
      mockHttpGetIdentity({ fingerprint: FINGERPRINT, alias: 'Old', icon: 'server', color: 'green', publicKey: 'old-key' });
      vi.mocked(annexPeers.getPeer).mockReturnValue({
        fingerprint: FINGERPRINT, alias: 'Old', icon: 'server', color: 'green', publicKey: 'old-key', pairedAt: '2024-01-01', lastSeen: '2024-01-01',
      });
      vi.mocked(WsMock).mockImplementation(function (this: any) {
        const handlers: Handlers = {};
        this.readyState = 1;
        this.socket = makeMockSocket(FINGERPRINT);
        this.on = vi.fn().mockImplementation((event: string, cb: any) => {
          handlers[event] = cb;
          if (event === 'open') setTimeout(cb, 0);
          return this;
        });
        this.send = vi.fn(); this.ping = vi.fn(); this.close = vi.fn(); this.terminate = vi.fn(); this.removeListener = vi.fn();
        sockets.push({ handlers, send: this.send });
        return this;
      });
      annexClient.startClient();
      await bonjourFindCallback!(makeService());
      const connected = () => vi.waitFor(() => expect(annexClient.getSatellite(FINGERPRINT)?.state).toBe('connected'));
      await connected();
      annexClient.disconnect(FINGERPRINT);
      annexClient.connect(FINGERPRINT);
      await connected();
      expect(sockets).toHaveLength(2);
    }

    const snapshot = (lastSeq: number, name: string) => Buffer.from(JSON.stringify({
      type: 'snapshot',
      payload: { protocolVersion: 2, projects: [{ id: name }], agents: {}, quickAgents: {}, theme: {}, orchestrators: {}, pendingPermissions: [], lastSeq },
    }));

    it('its late close leaves the new connection able to send', async () => {
      await replacedSocket();
      sockets[0].handlers.close();

      expect(annexClient.getSatellite(FINGERPRINT)?.state).toBe('connected');
      expect(annexClient.sendToSatellite(FINGERPRINT, { type: 'probe' })).toEqual({ sent: true });
      expect(sockets[1].send).toHaveBeenCalledTimes(1);
    });

    it('its late error does not bring the new connection down or start another', async () => {
      await replacedSocket();
      sockets[0].handlers.error(new Error('closed before the connection was established'));
      await new Promise((r) => setTimeout(r, 10));

      expect(annexClient.getSatellite(FINGERPRINT)?.state).toBe('connected');
      expect(annexClient.getSatellite(FINGERPRINT)?.lastError).toBeFalsy();
      expect(sockets).toHaveLength(2);
    });

    it('its last frames are not taken as the new connection\'s', async () => {
      await replacedSocket();
      sockets[0].handlers.message(snapshot(5, 'from_old'));
      expect(annexClient.getSatellite(FINGERPRINT)?.snapshot).toBeNull();

      sockets[1].handlers.message(snapshot(1, 'from_new'));
      expect((annexClient.getSatellite(FINGERPRINT)?.snapshot as any).projects).toEqual([{ id: 'from_new' }]);
    });

    it('the current socket closing still reconnects', async () => {
      await replacedSocket();
      sockets[1].handlers.close();
      expect(annexClient.getSatellite(FINGERPRINT)?.state).toBe('disconnected');
    });
  });

  describe('mTLS reconnection', () => {
    it('attempts connection for discovered paired satellite without bearer token', async () => {
      const { WebSocket: WsMock } = await import('ws');

      mockHttpGetIdentity({
        fingerprint: 'PP:QQ:RR:SS',
        alias: 'Paired Mac',
        icon: 'server',
        color: 'green',
        publicKey: 'paired-pub-key',
      });

      vi.mocked(annexPeers.getPeer).mockReturnValue({
        fingerprint: 'PP:QQ:RR:SS',
        alias: 'Paired Mac',
        icon: 'server',
        color: 'green',
        publicKey: 'paired-pub-key',
        pairedAt: '2024-01-01',
        lastSeen: '2024-01-01',
      });

      vi.mocked(WsMock).mockClear();
      annexClient.startClient();
      await bonjourFindCallback!(makeService());

      expect(WsMock).toHaveBeenCalled();
      const wsUrl = vi.mocked(WsMock).mock.calls[0][0] as string;
      expect(wsUrl).not.toContain('token=');
      expect(wsUrl).toContain('wss://');
    });

    it('retry works without bearer token', async () => {
      const { WebSocket: WsMock } = await import('ws');

      mockHttpGetIdentity({
        fingerprint: 'PP:QQ:RR:SS',
        alias: 'Paired Mac',
        icon: 'server',
        color: 'green',
        publicKey: 'paired-pub-key',
      });

      vi.mocked(annexPeers.getPeer).mockReturnValue({
        fingerprint: 'PP:QQ:RR:SS',
        alias: 'Paired Mac',
        icon: 'server',
        color: 'green',
        publicKey: 'paired-pub-key',
        pairedAt: '2024-01-01',
        lastSeen: '2024-01-01',
      });

      annexClient.startClient();
      await bonjourFindCallback!(makeService());

      annexClient.disconnect('PP:QQ:RR:SS');
      expect(annexClient.getSatellites()[0].state).toBe('disconnected');

      vi.mocked(WsMock).mockClear();
      annexClient.retry('PP:QQ:RR:SS');
      expect(WsMock).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Directional peer role filtering
  // -------------------------------------------------------------------------

  describe('directional peer roles', () => {
    it('does not auto-connect to peers with role "controller"', async () => {
      const { WebSocket: WsMock } = await import('ws');

      mockHttpGetIdentity({
        fingerprint: 'CC:CC:CC:CC',
        alias: 'Controller Machine',
        icon: 'laptop',
        color: 'blue',
        publicKey: 'controller-pub-key',
      });

      // This peer paired with us as a controller (we are their satellite)
      vi.mocked(annexPeers.getPeer).mockReturnValue({
        fingerprint: 'CC:CC:CC:CC',
        alias: 'Controller Machine',
        icon: 'laptop',
        color: 'blue',
        publicKey: 'controller-pub-key',
        pairedAt: '2024-01-01',
        lastSeen: '2024-01-01',
        role: 'controller', // This peer controls us, we should NOT connect to it as a satellite
      });

      annexClient.startClient();
      await bonjourFindCallback!(makeService());

      // Should NOT create a satellite entry or connect
      expect(annexClient.getSatellites()).toHaveLength(0);
      expect(WsMock).not.toHaveBeenCalled();
    });

    it('auto-connects to peers with role "satellite"', async () => {
      const { WebSocket: WsMock } = await import('ws');

      mockHttpGetIdentity({
        fingerprint: 'SS:SS:SS:SS',
        alias: 'Satellite Machine',
        icon: 'server',
        color: 'green',
        publicKey: 'satellite-pub-key',
      });

      vi.mocked(annexPeers.getPeer).mockReturnValue({
        fingerprint: 'SS:SS:SS:SS',
        alias: 'Satellite Machine',
        icon: 'server',
        color: 'green',
        publicKey: 'satellite-pub-key',
        pairedAt: '2024-01-01',
        lastSeen: '2024-01-01',
        role: 'satellite',
      });

      annexClient.startClient();
      await bonjourFindCallback!(makeService());

      // Should create satellite and attempt connection
      expect(annexClient.getSatellites()).toHaveLength(1);
      expect(WsMock).toHaveBeenCalled();
    });

    it('lists a legacy peer without a role as a satellite that needs pairing again, and never dials it', async () => {
      const { WebSocket: WsMock } = await import('ws');

      mockHttpGetIdentity({
        fingerprint: 'LL:LL:LL:LL',
        alias: 'Legacy Machine',
        icon: 'computer',
        color: 'indigo',
        publicKey: 'legacy-pub-key',
      });

      vi.mocked(annexPeers.getPeer).mockReturnValue({
        fingerprint: 'LL:LL:LL:LL',
        alias: 'Legacy Machine',
        icon: 'computer',
        color: 'indigo',
        publicKey: 'legacy-pub-key',
        pairedAt: '2024-01-01',
        lastSeen: '2024-01-01',
        // No role field — legacy peer
      });

      // The real rule: an entry with no role (or no pin) needs pairing again.
      const { peerNeedsPairing } = await vi.importActual<typeof import('./annex-peers')>('./annex-peers');
      vi.mocked(annexPeers.peerNeedsPairing).mockImplementation(peerNeedsPairing);
      vi.mocked(WsMock).mockClear();
      annexClient.startClient();
      await bonjourFindCallback!(makeService());

      expect(annexClient.getSatellites()).toHaveLength(1);
      expect(annexClient.getSatellite('LL:LL:LL:LL')).toMatchObject({ needsPairing: true, state: 'disconnected' });
      expect(WsMock).not.toHaveBeenCalled();
    });

  });

  // -------------------------------------------------------------------------
  // Bug fix: sendToSatellite returns { sent, error } (1c)
  // -------------------------------------------------------------------------

  describe('sendToSatellite error reporting', () => {
    it('returns { sent: false, error: "not_connected" } when WS is not open', () => {
      // No satellites connected
      const result = annexClient.sendToSatellite('nonexistent', { type: 'test' });
      expect(result).toEqual({ sent: false, error: 'not_connected' });
    });

    it('returns { sent: false, error } when ws.send() throws', async () => {
      const { WebSocket: WsMock } = await import('ws');

      // Set up a paired satellite
      mockHttpGetIdentity({
        fingerprint: 'PP:QQ:RR:SS',
        alias: 'Paired Mac',
        icon: 'server',
        color: 'green',
        publicKey: 'paired-pub-key',
      });

      vi.mocked(annexPeers.getPeer).mockReturnValue({
        fingerprint: 'PP:QQ:RR:SS',
        alias: 'Paired Mac',
        icon: 'server',
        color: 'green',
        publicKey: 'paired-pub-key',
        pairedAt: '2024-01-01',
        lastSeen: '2024-01-01',
      });

      // Mock WebSocket instance to have OPEN state but throw on send
      vi.mocked(WsMock).mockImplementation(function (this: any) {
        this.readyState = 1; // WebSocket.OPEN
        this.socket = makeMockSocket('PP:QQ:RR:SS');
        this.on = vi.fn().mockImplementation((event: string, cb: any) => {
          if (event === 'open') setTimeout(cb, 0);
          return this;
        });
        this.send = vi.fn().mockImplementation(() => { throw new Error('connection reset'); });
        this.ping = vi.fn();
        this.close = vi.fn();
        this.terminate = vi.fn();
        this.removeListener = vi.fn();
        return this;
      } as any);

      annexClient.startClient();
      await bonjourFindCallback!(makeService());
      await new Promise((r) => setTimeout(r, 50));

      const result = annexClient.sendToSatellite('PP:QQ:RR:SS', { type: 'pty:input', payload: { data: 'test' } });
      expect(result.sent).toBe(false);
      expect(result.error).toContain('send_failed');
      expect(result.error).toContain('connection reset');
    });

    it('returns { sent: true } on successful send (backward-compat truthy check)', async () => {
      const { WebSocket: WsMock } = await import('ws');

      mockHttpGetIdentity({
        fingerprint: 'PP:QQ:RR:SS',
        alias: 'Paired Mac',
        icon: 'server',
        color: 'green',
        publicKey: 'paired-pub-key',
      });

      vi.mocked(annexPeers.getPeer).mockReturnValue({
        fingerprint: 'PP:QQ:RR:SS',
        alias: 'Paired Mac',
        icon: 'server',
        color: 'green',
        publicKey: 'paired-pub-key',
        pairedAt: '2024-01-01',
        lastSeen: '2024-01-01',
      });

      vi.mocked(WsMock).mockImplementation(function (this: any) {
        this.readyState = 1;
        this.socket = makeMockSocket('PP:QQ:RR:SS');
        this.on = vi.fn().mockImplementation((event: string, cb: any) => {
          if (event === 'open') setTimeout(cb, 0);
          return this;
        });
        this.send = vi.fn();
        this.ping = vi.fn();
        this.close = vi.fn();
        this.terminate = vi.fn();
        this.removeListener = vi.fn();
        return this;
      } as any);

      annexClient.startClient();
      await bonjourFindCallback!(makeService());
      await new Promise((r) => setTimeout(r, 50));

      const result = annexClient.sendToSatellite('PP:QQ:RR:SS', { type: 'test' });
      expect(result.sent).toBe(true);
      expect(result.error).toBeUndefined();
      // Backward compat: truthy check still works
      expect(!!result).toBe(true);
    });

    it('adds a traceparent (tc) to agent:spawn and agent:wake only while telemetry is on', async () => {
      const { WebSocket: WsMock } = await import('ws');
      mockHttpGetIdentity({ fingerprint: 'PP:QQ:RR:SS', alias: 'Paired Mac', icon: 'server', color: 'green', publicKey: 'paired-pub-key' });
      vi.mocked(annexPeers.getPeer).mockReturnValue({
        fingerprint: 'PP:QQ:RR:SS', alias: 'Paired Mac', icon: 'server', color: 'green',
        publicKey: 'paired-pub-key', pairedAt: '2024-01-01', lastSeen: '2024-01-01',
      });
      const sent: string[] = [];
      vi.mocked(WsMock).mockImplementation(function (this: any) {
        this.readyState = 1;
        this.socket = makeMockSocket('PP:QQ:RR:SS');
        this.on = vi.fn().mockImplementation((event: string, cb: any) => {
          if (event === 'open') setTimeout(cb, 0);
          return this;
        });
        this.send = vi.fn((d: string) => { sent.push(d); });
        this.ping = vi.fn();
        this.close = vi.fn();
        this.terminate = vi.fn();
        this.removeListener = vi.fn();
        return this;
      } as any);
      annexClient.startClient();
      await bonjourFindCallback!(makeService());
      await new Promise((r) => setTimeout(r, 50));

      const tc = '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01';
      const flows: string[] = [];
      setProducingRuntime({
        level: 'standard',
        flow: (name: string, _o: unknown, fn: () => unknown) => { flows.push(name); return fn(); },
        traceparent: () => tc,
        replaySpan: vi.fn(),
        count: vi.fn(),
      } as unknown as TelemetryRuntime);
      try {
        annexClient.sendToSatellite('PP:QQ:RR:SS', { type: 'agent:spawn', payload: { projectId: 'p', prompt: 'x' } });
        annexClient.sendToSatellite('PP:QQ:RR:SS', { type: 'pty:input', payload: { data: 'y' } });
      } finally {
        setProducingRuntime(null);
      }
      annexClient.sendToSatellite('PP:QQ:RR:SS', { type: 'agent:wake', payload: { agentId: 'a' } });

      const last3 = sent.slice(-3).map((d) => JSON.parse(d));
      expect(last3[0]).toMatchObject({ type: 'agent:spawn', tc });
      expect(last3[1].tc).toBeUndefined();
      expect(last3[2].tc).toBeUndefined();
      expect(flows).toEqual(['clubhouse.annex.remote_spawn']);
    });
  });

  // -------------------------------------------------------------------------
  // Bug fix: malformed JSON from satellite logs warning (1d client)
  // -------------------------------------------------------------------------

  describe('malformed JSON from satellite', () => {
    it('logs warning with preview when satellite sends invalid JSON', async () => {
      const { WebSocket: WsMock } = await import('ws');
      const { appLog } = await import('./log-service');

      mockHttpGetIdentity({
        fingerprint: 'PP:QQ:RR:SS',
        alias: 'Paired Mac',
        icon: 'server',
        color: 'green',
        publicKey: 'paired-pub-key',
      });

      vi.mocked(annexPeers.getPeer).mockReturnValue({
        fingerprint: 'PP:QQ:RR:SS',
        alias: 'Paired Mac',
        icon: 'server',
        color: 'green',
        publicKey: 'paired-pub-key',
        pairedAt: '2024-01-01',
        lastSeen: '2024-01-01',
      });

      let messageHandler: ((data: any) => void) | null = null;
      vi.mocked(WsMock).mockImplementation(function (this: any) {
        this.readyState = 1;
        this.socket = makeMockSocket('PP:QQ:RR:SS');
        this.on = vi.fn().mockImplementation((event: string, cb: any) => {
          if (event === 'open') setTimeout(cb, 0);
          if (event === 'message') messageHandler = cb;
          return this;
        });
        this.send = vi.fn();
        this.ping = vi.fn();
        this.close = vi.fn();
        this.terminate = vi.fn();
        this.removeListener = vi.fn();
        return this;
      } as any);

      annexClient.startClient();
      await bonjourFindCallback!(makeService());
      await new Promise((r) => setTimeout(r, 50));

      vi.mocked(appLog).mockClear();

      // Simulate receiving malformed JSON
      if (messageHandler) {
        messageHandler(Buffer.from('not valid json!!!'));
      }

      expect(appLog).toHaveBeenCalledWith(
        'core:annex-client', 'warn', 'Malformed JSON from satellite',
        expect.objectContaining({
          meta: expect.objectContaining({
            fingerprint: 'PP:QQ:RR:SS',
            preview: expect.stringContaining('not valid json'),
          }),
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Bug fix: heartbeat ping failure transitions state (1e)
  // -------------------------------------------------------------------------

  describe('heartbeat ping failure', () => {
    it('transitions to disconnected and schedules reconnect on ping throw', async () => {
      const { WebSocket: WsMock } = await import('ws');

      mockHttpGetIdentity({
        fingerprint: 'PP:QQ:RR:SS',
        alias: 'Paired Mac',
        icon: 'server',
        color: 'green',
        publicKey: 'paired-pub-key',
      });

      vi.mocked(annexPeers.getPeer).mockReturnValue({
        fingerprint: 'PP:QQ:RR:SS',
        alias: 'Paired Mac',
        icon: 'server',
        color: 'green',
        publicKey: 'paired-pub-key',
        pairedAt: '2024-01-01',
        lastSeen: '2024-01-01',
      });

      let openCb: (() => void) | null = null;
      let wsInstance: any = null;

      vi.mocked(WsMock).mockImplementation(function (this: any) {
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        wsInstance = this;
        this.readyState = 1;
        this.socket = makeMockSocket('PP:QQ:RR:SS');
        this.on = vi.fn().mockImplementation((event: string, cb: any) => {
          if (event === 'open') openCb = cb;
          return this;
        });
        this.send = vi.fn();
        this.ping = vi.fn();
        this.close = vi.fn();
        this.terminate = vi.fn();
        this.removeListener = vi.fn();
        return this;
      } as any);

      // Use fake timers from the start so the heartbeat interval is faked
      vi.useFakeTimers();

      annexClient.startClient();
      // bonjourFindCallback is set synchronously by startClient's Bonjour mock
      await bonjourFindCallback!(makeService());

      // Flush microtasks to let async discovery complete
      await vi.advanceTimersByTimeAsync(0);

      // Trigger open callback to transition to 'connected' and start heartbeat
      expect(openCb).not.toBeNull();
      openCb!();

      // Verify state is now 'connected'
      const stateAfterOpen = annexClient.getSatellites()[0]?.state;
      expect(stateAfterOpen).toBe('connected');

      // Now make ping throw
      wsInstance.ping = vi.fn().mockImplementation(() => { throw new Error('socket closed'); });

      // Advance timers to trigger exactly one heartbeat (30s interval)
      // Don't advance further — reconnect timer (1s) would transition back to 'connecting'
      vi.advanceTimersByTime(30_000);

      const satsAfter = annexClient.getSatellites();
      expect(satsAfter[0].state).toBe('disconnected');
      expect(satsAfter[0].lastError).toMatch(/stopped answering\. Clubhouse is reconnecting/);

      vi.useRealTimers();
    });

    it('keeps last seen at the last confirmed heartbeat of a long-lived connection, written once at disconnect (#3349)', async () => {
      const { WebSocket: WsMock } = await import('ws');
      mockHttpGetIdentity({ fingerprint: 'LL:MM:NN:OO', alias: 'Long Mac', icon: 'server', color: 'green', publicKey: 'long-pub-key' });
      vi.mocked(annexPeers.getPeer).mockReturnValue({
        fingerprint: 'LL:MM:NN:OO', alias: 'Long Mac', icon: 'server', color: 'green', publicKey: 'long-pub-key', pairedAt: '2024-01-01', lastSeen: '2024-01-01',
      });
      let openCb: (() => void) | null = null;
      let pongCb: (() => void) | null = null;
      const sockets: any[] = [];
      vi.mocked(WsMock).mockImplementation(function (this: any) {
        sockets.push(this);
        this.readyState = 1;
        this.socket = makeMockSocket('LL:MM:NN:OO');
        this.on = vi.fn().mockImplementation((event: string, cb: any) => {
          if (event === 'open') openCb = cb;
          if (event === 'pong') pongCb = cb;
          return this;
        });
        this.send = vi.fn(); this.ping = vi.fn(); this.close = vi.fn(); this.terminate = vi.fn(); this.removeListener = vi.fn();
        return this;
      } as any);
      vi.useFakeTimers();
      vi.setSystemTime(Date.parse('2026-11-13T08:00:00.000Z'));
      annexClient.startClient();
      await bonjourFindCallback!(makeService());
      await vi.advanceTimersByTimeAsync(0);
      openCb!();
      vi.mocked(annexPeers.recordLastSeen).mockClear();
      // Three hours of heartbeats, each answered.
      for (let i = 0; i < 360; i++) {
        vi.advanceTimersByTime(30_000);
        pongCb!();
      }
      expect(annexClient.lastConfirmedConnectivity('ll:mm:nn:oo')).toBe('2026-11-13T11:00:00.000Z');
      // A heartbeat costs no disk write.
      expect(annexPeers.recordLastSeen).not.toHaveBeenCalled();
      // Then it stops answering: last seen is the last answered heartbeat, not the open or the timeout.
      sockets[sockets.length - 1].ping = vi.fn().mockImplementation(() => { throw new Error('socket closed'); });
      vi.advanceTimersByTime(30_000);
      expect(annexClient.getSatellites()[0].state).toBe('disconnected');
      expect(annexPeers.recordLastSeen).toHaveBeenCalledExactlyOnceWith('LL:MM:NN:OO', new Date('2026-11-13T11:00:00.000Z'));
      vi.useRealTimers();
    });

    it('bridges a pong timeout to telemetry with no attributes', async () => {
      const { WebSocket: WsMock } = await import('ws');
      const { appLog } = await import('./log-service');

      mockHttpGetIdentity({
        fingerprint: 'PP:QQ:RR:SS',
        alias: 'Paired Mac',
        icon: 'server',
        color: 'green',
        publicKey: 'paired-pub-key',
      });
      vi.mocked(annexPeers.getPeer).mockReturnValue({
        fingerprint: 'PP:QQ:RR:SS',
        alias: 'Paired Mac',
        icon: 'server',
        color: 'green',
        publicKey: 'paired-pub-key',
        pairedAt: '2024-01-01',
        lastSeen: '2024-01-01',
      });

      let openCb: (() => void) | null = null;
      vi.mocked(WsMock).mockImplementation(function (this: any) {
        this.readyState = 1;
        this.socket = makeMockSocket('PP:QQ:RR:SS');
        this.on = vi.fn().mockImplementation((event: string, cb: any) => {
          if (event === 'open') openCb = cb;
          return this;
        });
        this.send = vi.fn();
        this.ping = vi.fn();
        this.close = vi.fn();
        this.terminate = vi.fn();
        this.removeListener = vi.fn();
        return this;
      } as any);

      vi.useFakeTimers();
      annexClient.startClient();
      await bonjourFindCallback!(makeService());
      await vi.advanceTimersByTimeAsync(0);
      openCb!();
      vi.mocked(appLog).mockClear();

      // One heartbeat ping, then no pong within the 10s timeout.
      vi.advanceTimersByTime(30_000 + 10_000);

      expect(annexClient.getSatellites()[0].problem?.code).toBe('stopped-answering');
      const call = vi.mocked(appLog).mock.calls.find((c) => c[2] === 'Heartbeat pong timeout — closing connection');
      expect(call?.[3]).toMatchObject({ telemetry: { event: 'clubhouse.annex.heartbeat_timeout' } });
      expect((call?.[3] as { telemetry: { attrs?: unknown } }).telemetry.attrs).toBeUndefined();

      vi.useRealTimers();
    });
  });

  // -------------------------------------------------------------------------
  // LB-AN-001: REST error handlers log warnings instead of swallowing errors
  // -------------------------------------------------------------------------

  describe('LB-AN-001: REST endpoint error logging', () => {
    const FINGERPRINT = 'AA:BB:CC:EE';

    async function connectSatellite() {
      const { WebSocket: WsMock } = await import('ws');

      mockHttpGetIdentity({
        fingerprint: FINGERPRINT,
        alias: 'Rest Satellite',
        icon: 'server',
        color: 'blue',
        publicKey: 'rest-pub-key',
      });

      vi.mocked(annexPeers.getPeer).mockReturnValue({
        fingerprint: FINGERPRINT,
        alias: 'Rest Satellite',
        icon: 'server',
        color: 'blue',
        publicKey: 'rest-pub-key',
        pairedAt: '2024-01-01',
        lastSeen: '2024-01-01',
      });

      let openCb: (() => void) | null = null;

      vi.mocked(WsMock).mockImplementation(function (this: any) {
        this.readyState = 1;
        this.socket = makeMockSocket(FINGERPRINT);
        this.on = vi.fn().mockImplementation((event: string, cb: any) => {
          if (event === 'open') openCb = cb;
          return this;
        });
        this.send = vi.fn();
        this.ping = vi.fn();
        this.close = vi.fn();
        this.terminate = vi.fn();
        this.removeListener = vi.fn();
        return this;
      } as any);

      vi.useFakeTimers();
      annexClient.startClient();
      await bonjourFindCallback!(makeService());
      await vi.advanceTimersByTimeAsync(0);
      openCb!();
      vi.useRealTimers();
    }

    function mockHttpsGetNetworkError() {
      vi.mocked(https.get).mockImplementation((_url: any, _opts: any, _cb: any) => {
        const req = {
          on: vi.fn().mockImplementation((event: string, cb: any) => {
            if (event === 'error') cb(new Error('ECONNREFUSED'));
            return req;
          }),
          setTimeout: vi.fn(),
          destroy: vi.fn(),
        };
        return req as any;
      });
    }

    function mockHttpsGetMalformedJson() {
      vi.mocked(https.get).mockImplementation((_url: any, _opts: any, cb: any) => {
        const res = {
          statusCode: 200,
          resume: vi.fn(),
          on: vi.fn().mockImplementation((event: string, handler: any) => {
            if (event === 'data') handler(Buffer.from('not json!!!'));
            if (event === 'end') handler();
            return res;
          }),
        };
        cb(res);
        const req = { on: vi.fn().mockReturnThis(), setTimeout: vi.fn(), destroy: vi.fn() };
        return req as any;
      });
    }

    it('requestFileTree logs warn on network error', async () => {
      await connectSatellite();
      const { appLog } = await import('./log-service');
      vi.mocked(appLog).mockClear();
      mockHttpsGetNetworkError();

      await annexClient.requestFileTree(FINGERPRINT, 'proj-1');

      expect(appLog).toHaveBeenCalledWith(
        'core:annex-client', 'warn', 'File tree request failed',
        expect.objectContaining({ meta: expect.objectContaining({ fingerprint: FINGERPRINT }) }),
      );
    });

    it('requestFileTree logs warn on JSON parse failure', async () => {
      await connectSatellite();
      const { appLog } = await import('./log-service');
      vi.mocked(appLog).mockClear();
      mockHttpsGetMalformedJson();

      await annexClient.requestFileTree(FINGERPRINT, 'proj-1');

      expect(appLog).toHaveBeenCalledWith(
        'core:annex-client', 'warn', 'File tree response JSON parse failed',
        expect.objectContaining({ meta: expect.objectContaining({ fingerprint: FINGERPRINT }) }),
      );
    });

    it('requestBulletinDigest logs warn on network error', async () => {
      await connectSatellite();
      const { appLog } = await import('./log-service');
      vi.mocked(appLog).mockClear();
      mockHttpsGetNetworkError();

      await annexClient.requestBulletinDigest(FINGERPRINT, 'gp-1');

      expect(appLog).toHaveBeenCalledWith(
        'core:annex-client', 'warn', 'Bulletin digest request failed',
        expect.objectContaining({ meta: expect.objectContaining({ fingerprint: FINGERPRINT }) }),
      );
    });

    it('requestBulletinTopicMessages logs warn on network error', async () => {
      await connectSatellite();
      const { appLog } = await import('./log-service');
      vi.mocked(appLog).mockClear();
      mockHttpsGetNetworkError();

      await annexClient.requestBulletinTopicMessages(FINGERPRINT, 'gp-1', 'progress');

      expect(appLog).toHaveBeenCalledWith(
        'core:annex-client', 'warn', 'Bulletin topic messages request failed',
        expect.objectContaining({ meta: expect.objectContaining({ fingerprint: FINGERPRINT }) }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Per-channel bulletin read state over the annex REST call (#1556)
  // -------------------------------------------------------------------------
  describe('requestBulletinDigest since encoding', () => {
    const ISO = '2026-07-25T10:00:00.000Z';
    const FINGERPRINT = 'AA:BB:CC:FF';

    async function connectSatellite() {
      const { WebSocket: WsMock } = await import('ws');

      mockHttpGetIdentity({
        fingerprint: FINGERPRINT,
        alias: 'Digest Satellite',
        icon: 'server',
        color: 'blue',
        publicKey: 'digest-pub-key',
      });

      vi.mocked(annexPeers.getPeer).mockReturnValue({
        fingerprint: FINGERPRINT,
        alias: 'Digest Satellite',
        icon: 'server',
        color: 'blue',
        publicKey: 'digest-pub-key',
        pairedAt: '2024-01-01',
        lastSeen: '2024-01-01',
      });

      let openCb: (() => void) | null = null;

      vi.mocked(WsMock).mockImplementation(function (this: any) {
        this.readyState = 1;
        this.socket = makeMockSocket(FINGERPRINT);
        this.on = vi.fn().mockImplementation((event: string, cb: any) => {
          if (event === 'open') openCb = cb;
          return this;
        });
        this.send = vi.fn();
        this.ping = vi.fn();
        this.close = vi.fn();
        this.terminate = vi.fn();
        this.removeListener = vi.fn();
        return this;
      } as any);

      vi.useFakeTimers();
      annexClient.startClient();
      await bonjourFindCallback!(makeService());
      await vi.advanceTimersByTimeAsync(0);
      openCb!();
      vi.useRealTimers();
    }

    /** Capture the URL the client builds and answer with an empty digest. */
    function captureUrl(): { get: () => string } {
      let captured = '';
      vi.mocked(https.get).mockImplementation((url: any, _opts: any, cb: any) => {
        captured = String(url);
        const res = {
          statusCode: 200,
          resume: vi.fn(),
          on: vi.fn().mockImplementation((event: string, handler: any) => {
            if (event === 'data') handler(Buffer.from('[]'));
            if (event === 'end') handler();
            return res;
          }),
        };
        cb(res);
        return { on: vi.fn().mockReturnThis(), setTimeout: vi.fn(), destroy: vi.fn() } as any;
      });
      return { get: () => captured };
    }

    function queryOf(url: string): URLSearchParams {
      return new URLSearchParams(url.slice(url.indexOf('?') + 1));
    }

    it('sends no cutoff params when since is omitted', async () => {
      await connectSatellite();
      const url = captureUrl();

      await annexClient.requestBulletinDigest(FINGERPRINT, 'gp-1');

      expect(url.get()).not.toContain('?');
    });

    it('sends a single timestamp as `since`', async () => {
      await connectSatellite();
      const url = captureUrl();

      await annexClient.requestBulletinDigest(FINGERPRINT, 'gp-1', ISO);

      expect(queryOf(url.get()).get('since')).toBe(ISO);
    });

    it('sends a per-channel map as JSON in `sinceChannels`, not `since`', async () => {
      await connectSatellite();
      const url = captureUrl();
      const map = { general: ISO, 'inbox-warm-alpaca': '2026-07-25T11:00:00.000Z' };

      await annexClient.requestBulletinDigest(FINGERPRINT, 'gp-1', map);

      const params = queryOf(url.get());
      expect(JSON.parse(params.get('sinceChannels')!)).toEqual(map);
      // Overloading `since` would make an older satellite parse JSON as a date.
      expect(params.get('since')).toBeNull();
    });

    it('omits the cutoff and warns when the map is too large for a URL', async () => {
      await connectSatellite();
      const { appLog } = await import('./log-service');
      vi.mocked(appLog).mockClear();
      const url = captureUrl();
      const huge: Record<string, string> = {};
      for (let i = 0; i < 400; i++) huge[`channel-with-a-long-name-${i}`] = ISO;

      await annexClient.requestBulletinDigest(FINGERPRINT, 'gp-1', huge);

      expect(url.get()).not.toContain('sinceChannels');
      expect(appLog).toHaveBeenCalledWith(
        'core:annex-client', 'warn',
        'Per-channel read map too large for digest request; requesting without a cutoff',
        expect.objectContaining({ meta: expect.objectContaining({ channels: 400 }) }),
      );
    });

    it('sends no params for an empty map', async () => {
      await connectSatellite();
      const url = captureUrl();

      await annexClient.requestBulletinDigest(FINGERPRINT, 'gp-1', {});

      expect(url.get()).not.toContain('?');
    });
  });

  // -------------------------------------------------------------------------
  // Bug fix LB-AN-003: pong timeout clears heartbeat interval before reconnect
  // -------------------------------------------------------------------------

  describe('heartbeat pong timeout clears interval (LB-AN-003)', () => {
    it('calls clearInterval on heartbeat before reconnecting after pong timeout', async () => {
      const { WebSocket: WsMock } = await import('ws');

      mockHttpGetIdentity({
        fingerprint: 'TT:UU:VV:WW',
        alias: 'Pong Test Mac',
        icon: 'server',
        color: 'blue',
        publicKey: 'pong-pub-key',
      });

      vi.mocked(annexPeers.getPeer).mockReturnValue({
        fingerprint: 'TT:UU:VV:WW',
        alias: 'Pong Test Mac',
        icon: 'server',
        color: 'blue',
        publicKey: 'pong-pub-key',
        pairedAt: '2024-01-01',
        lastSeen: '2024-01-01',
      });

      let openCb: (() => void) | null = null;

      vi.mocked(WsMock).mockImplementation(function (this: any) {
        this.readyState = 1;
        this.socket = makeMockSocket('TT:UU:VV:WW');
        this.on = vi.fn().mockImplementation((event: string, cb: any) => {
          if (event === 'open') openCb = cb;
          return this;
        });
        this.send = vi.fn();
        this.ping = vi.fn(); // ping succeeds — pong just never arrives
        this.close = vi.fn();
        this.terminate = vi.fn();
        this.removeListener = vi.fn();
        return this;
      } as any);

      vi.useFakeTimers();

      annexClient.startClient();
      await bonjourFindCallback!(makeService());
      await vi.advanceTimersByTimeAsync(0);

      expect(openCb).not.toBeNull();
      openCb!();

      expect(annexClient.getSatellites()[0]?.state).toBe('connected');

      // Spy on clearInterval AFTER connection is established so we only capture
      // the heartbeat-related call, not any setup calls.
      const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

      // Advance 30s: heartbeat fires, ping sent (no throw), pongTimeout armed
      vi.advanceTimersByTime(30_000);
      expect(annexClient.getSatellites()[0]?.state).toBe('connected');

      // Advance 10s more: pong timeout fires (no pong was received)
      vi.advanceTimersByTime(10_000);

      // After pong timeout, the heartbeat interval must have been cleared
      expect(clearIntervalSpy).toHaveBeenCalled();

      const satsAfter = annexClient.getSatellites();
      expect(satsAfter[0].state).toBe('disconnected');
      expect(satsAfter[0].problem?.code).toBe('stopped-answering');

      clearIntervalSpy.mockRestore();
      vi.useRealTimers();
    });
  });

  // -------------------------------------------------------------------------
  // LB-AN-002: Buffer fetch promise double-resolve prevention
  // -------------------------------------------------------------------------

  describe('LB-AN-002: buffer fetch timeout does not double-resolve promise', () => {
    const FINGERPRINT = 'AN002:AA:BB';

    async function connectAN002() {
      const { WebSocket: WsMock } = await import('ws');

      mockHttpGetIdentity({
        fingerprint: FINGERPRINT,
        alias: 'Timeout Sat',
        icon: 'server',
        color: 'red',
        publicKey: 'timeout-pub-key',
      });

      vi.mocked(annexPeers.getPeer).mockReturnValue({
        fingerprint: FINGERPRINT,
        alias: 'Timeout Sat',
        icon: 'server',
        color: 'red',
        publicKey: 'timeout-pub-key',
        pairedAt: '2024-01-01',
        lastSeen: '2024-01-01',
      });

      let openCb: (() => void) | null = null;

      vi.mocked(WsMock).mockImplementation(function (this: any) {
        this.readyState = 1;
        this.socket = makeMockSocket(FINGERPRINT);
        this.on = vi.fn().mockImplementation((event: string, cb: any) => {
          if (event === 'open') openCb = cb;
          return this;
        });
        this.send = vi.fn();
        this.ping = vi.fn();
        this.close = vi.fn();
        this.terminate = vi.fn();
        this.removeListener = vi.fn();
        return this;
      } as any);

      vi.useFakeTimers();
      annexClient.startClient();
      await bonjourFindCallback!(makeService());
      await vi.advanceTimersByTimeAsync(0);
      openCb!();
      vi.useRealTimers();
    }

    it('resolves cleanly when timeout fires and then error fires (req.destroy side-effect)', async () => {
      await connectAN002();

      let timeoutCb: (() => void) | null = null;
      let errorCb: ((err: Error) => void) | null = null;

      vi.mocked(https.get).mockImplementation((_url: any, _opts: any, _cb: any) => {
        const req = {
          on: vi.fn().mockImplementation((event: string, cb: any) => {
            if (event === 'timeout') timeoutCb = cb;
            if (event === 'error') errorCb = cb;
            return req;
          }),
          destroy: vi.fn(),
        };
        return req as any;
      });

      const bufferPromise = annexClient.requestPtyBuffer(FINGERPRINT, 'agent-1');

      expect(timeoutCb).not.toBeNull();
      expect(errorCb).not.toBeNull();

      // Fire timeout then error (the exact sequence that caused double-resolve before the fix)
      timeoutCb!();
      errorCb!(new Error('destroyed'));

      // Should settle to '' without hanging or rejecting
      await expect(bufferPromise).resolves.toBe('');
    });

    it('resolves cleanly when error fires before timeout is cancelled', async () => {
      await connectAN002();

      let errorCb: ((err: Error) => void) | null = null;
      let timeoutCb: (() => void) | null = null;

      vi.mocked(https.get).mockImplementation((_url: any, _opts: any, _cb: any) => {
        const req = {
          on: vi.fn().mockImplementation((event: string, cb: any) => {
            if (event === 'error') errorCb = cb;
            if (event === 'timeout') timeoutCb = cb;
            return req;
          }),
          destroy: vi.fn(),
        };
        return req as any;
      });

      const bufferPromise = annexClient.requestPtyBuffer(FINGERPRINT, 'agent-2');

      errorCb!(new Error('ECONNREFUSED'));
      // Firing timeout after error should not cause unhandled rejection
      timeoutCb!();

      await expect(bufferPromise).resolves.toBe('');
    });
  });

  // -------------------------------------------------------------------------
  // LB-AN-005: Stale snapshot sequence guard
  // -------------------------------------------------------------------------

  describe('LB-AN-005: stale snapshot sequences discarded on reconnect', () => {
    const FINGERPRINT = 'AN005:CC:DD';

    async function connectSatelliteAN005() {
      const { WebSocket: WsMock } = await import('ws');

      mockHttpGetIdentity({
        fingerprint: FINGERPRINT,
        alias: 'Seq Sat',
        icon: 'server',
        color: 'purple',
        publicKey: 'seq-pub-key',
      });

      vi.mocked(annexPeers.getPeer).mockReturnValue({
        fingerprint: FINGERPRINT,
        alias: 'Seq Sat',
        icon: 'server',
        color: 'purple',
        publicKey: 'seq-pub-key',
        pairedAt: '2024-01-01',
        lastSeen: '2024-01-01',
      });

      let openCb: (() => void) | null = null;
      let messageCb: ((data: any) => void) | null = null;

      vi.mocked(WsMock).mockImplementation(function (this: any) {
        this.readyState = 1;
        this.socket = makeMockSocket(FINGERPRINT);
        this.on = vi.fn().mockImplementation((event: string, cb: any) => {
          if (event === 'open') openCb = cb;
          if (event === 'message') messageCb = cb;
          return this;
        });
        this.send = vi.fn();
        this.ping = vi.fn();
        this.close = vi.fn();
        this.terminate = vi.fn();
        this.removeListener = vi.fn();
        return this;
      } as any);

      vi.useFakeTimers();
      annexClient.startClient();
      await bonjourFindCallback!(makeService());
      await vi.advanceTimersByTimeAsync(0);
      openCb!();
      vi.useRealTimers();

      return { messageCb: () => messageCb };
    }

    it('applies snapshot with higher sequence number', async () => {
      const { messageCb } = await connectSatelliteAN005();

      const snapshot1 = { projects: [], agents: {}, quickAgents: {}, theme: null, orchestrators: null, pendingPermissions: [], lastSeq: 5, protocolVersion: 2 };
      messageCb()!(JSON.stringify({ type: 'snapshot', payload: snapshot1 }));

      expect(annexClient.getSatellites().find((s) => s.id === FINGERPRINT)?.snapshot?.lastSeq).toBe(5);

      const snapshot2 = { ...snapshot1, lastSeq: 10 };
      messageCb()!(JSON.stringify({ type: 'snapshot', payload: snapshot2 }));

      expect(annexClient.getSatellites().find((s) => s.id === FINGERPRINT)?.snapshot?.lastSeq).toBe(10);
    });

    it('discards snapshot with lower sequence number (stale on reconnect)', async () => {
      const { messageCb } = await connectSatelliteAN005();

      const snapshot_new = { projects: [], agents: {}, quickAgents: {}, theme: null, orchestrators: null, pendingPermissions: [], lastSeq: 20, protocolVersion: 2 };
      messageCb()!(JSON.stringify({ type: 'snapshot', payload: snapshot_new }));

      expect(annexClient.getSatellites().find((s) => s.id === FINGERPRINT)?.snapshot?.lastSeq).toBe(20);

      // Stale snapshot from a reconnect — lower seq should be discarded
      const snapshot_stale = { ...snapshot_new, lastSeq: 5 };
      messageCb()!(JSON.stringify({ type: 'snapshot', payload: snapshot_stale }));

      // Still 20 — stale was discarded
      expect(annexClient.getSatellites().find((s) => s.id === FINGERPRINT)?.snapshot?.lastSeq).toBe(20);
    });

    it('applies first snapshot when no snapshot exists yet', async () => {
      const { messageCb } = await connectSatelliteAN005();

      expect(annexClient.getSatellites().find((s) => s.id === FINGERPRINT)?.snapshot).toBeNull();

      const snapshot = { projects: [], agents: {}, quickAgents: {}, theme: null, orchestrators: null, pendingPermissions: [], lastSeq: 1, protocolVersion: 2 };
      messageCb()!(JSON.stringify({ type: 'snapshot', payload: snapshot }));

      expect(annexClient.getSatellites().find((s) => s.id === FINGERPRINT)?.snapshot?.lastSeq).toBe(1);
    });

    it('does not broadcast when stale snapshot is discarded', async () => {
      const { messageCb } = await connectSatelliteAN005();
      const { broadcastToAllWindows: bcast } = await import('../util/ipc-broadcast');
      vi.mocked(bcast).mockClear();

      const snapshot_new = { projects: [], agents: {}, quickAgents: {}, theme: null, orchestrators: null, pendingPermissions: [], lastSeq: 15, protocolVersion: 2 };
      messageCb()!(JSON.stringify({ type: 'snapshot', payload: snapshot_new }));
      const broadcastCountAfterNew = vi.mocked(bcast).mock.calls.length;

      // Stale snapshot — should not trigger any broadcast
      const snapshot_stale = { ...snapshot_new, lastSeq: 3 };
      messageCb()!(JSON.stringify({ type: 'snapshot', payload: snapshot_stale }));

      expect(vi.mocked(bcast).mock.calls.length).toBe(broadcastCountAfterNew);
    });
  });

  // -------------------------------------------------------------------------
  // Pinned satellite connections and pairing over TLS
  // -------------------------------------------------------------------------

  describe('pinned satellite connections', () => {
    const FP = 'aa:01:aa:01';
    const peer = { fingerprint: FP, alias: 'Pinned Mac', icon: 'server', color: 'green', publicKey: 'sat-pk', pairedAt: '2026-01-01',
      lastSeen: '2026-01-01', role: 'satellite' as const, tlsCertificateFingerprint: 'AB:CD', tlsCertificatePem: 'SATELLITE-PEM' };
    let sockets: Array<{ handlers: Record<string, (...args: any[]) => void>; terminate: ReturnType<typeof vi.fn> }>;

    beforeEach(() => {
      sockets = [];
      WebSocketMock.mockImplementation(function (this: any) {
        const handlers: Record<string, (...args: any[]) => void> = {};
        Object.assign(this, { handlers, readyState: WebSocketMock.OPEN, send: vi.fn(), ping: vi.fn(), close: vi.fn(), terminate: vi.fn(),
          removeListener: vi.fn(), on: vi.fn((event: string, cb: any) => { handlers[event] = cb; return this; }) });
        sockets.push(this);
        return this;
      });
      vi.mocked(annexPeers.getPeer).mockImplementation((fp: string) => (fp === FP ? { ...peer } : undefined) as any);
      mockHttpGetIdentity({ fingerprint: FP, alias: 'Pinned Mac', icon: 'server', color: 'green', publicKey: 'sat-pk' });
    });

    async function discover(address = '192.168.1.50') {
      annexClient.startClient();
      await bonjourFindCallback!(makeService({ addresses: [address] }));
    }

    function refusal(status: number, body: object) {
      const res = Object.assign(new EventEmitter(), { statusCode: status });
      sockets.at(-1)!.handlers['unexpected-response']({ destroy: vi.fn() }, res);
      res.emit('data', Buffer.from(JSON.stringify(body)));
      res.emit('end');
    }

    it('opens the WebSocket with options pinned to the stored certificate, and no token', async () => {
      await discover();
      expect(annexTls.createPinnedTlsClientOptions).toHaveBeenCalledWith(LOCAL_IDENTITY, { certPem: 'SATELLITE-PEM', fingerprint: 'AB:CD' });
      const [url, options] = WebSocketMock.mock.calls.at(-1)!;
      expect(url).toBe('wss://192.168.1.50:9000/ws?client=desktop');
      expect(options).toMatchObject({ pinned: true });
      expect(options).not.toHaveProperty('headers');
    });

    it('never dials a pairing from before pinning, and shows it needs pairing again', async () => {
      vi.mocked(annexPeers.peerNeedsPairing).mockReturnValue(true);
      await discover();
      expect(WebSocketMock).not.toHaveBeenCalled();
      expect(annexClient.getSatellite(FP)).toMatchObject({ state: 'disconnected', needsPairing: true, lastError: expect.stringMatching(/older version/) });
    });

    it.each([
      ['needs_pairing', /older version/],
      ['peer_not_paired', /no longer paired/],
    ])('stops for good when the satellite answers 401 %s', async (error, message) => {
      await discover();
      vi.useFakeTimers();
      try {
        refusal(401, { error, message: 'from the satellite' });
        await vi.waitFor(() => expect(annexClient.getSatellite(FP)?.needsPairing).toBe(true));
        expect(annexClient.getSatellite(FP)).toMatchObject({ state: 'disconnected', lastError: expect.stringMatching(message) });
        vi.advanceTimersByTime(120_000);
        expect(WebSocketMock).toHaveBeenCalledTimes(1);
      } finally { vi.useRealTimers(); }
    });

    it.each([
      ['ECONNREFUSED', 'refused', "Pinned Mac isn't accepting connections. Check that Clubhouse is open there with Annex turned on."],
      ['EHOSTUNREACH', 'unreachable', "This computer can't reach Pinned Mac at its last address. Check this computer's network connection. Clubhouse tries again when it's back."],
      ['ETIMEDOUT', 'timeout', "Pinned Mac didn't answer in time. Check that it is awake and on the same network or tailnet."],
    ])('says what a socket error %s means and what to do', async (code, problem, text) => {
      await discover();
      vi.useFakeTimers();
      try {
        sockets[0].handlers.error(Object.assign(new Error(`connect ${code} 192.168.1.50:9000`), { code }));
        expect(annexClient.getSatellite(FP)).toMatchObject({ state: 'disconnected', lastError: text, problem: { code: problem } });
        expect(annexClient.getSatellite(FP)?.needsPairing).toBeUndefined();
      } finally { vi.useRealTimers(); }
    });

    it('clears the problem once a snapshot arrives', async () => {
      await discover();
      sockets[0].handlers.error(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
      expect(annexClient.getSatellite(FP)?.problem).toBeDefined();
      annexClient.retry(FP);
      sockets.at(-1)!.handlers.open();
      annexClient._receiveSatelliteMessageForTesting(FP, { type: 'snapshot', payload: { protocolVersion: 2, lastSeq: 1, projects: [], agents: {}, quickAgents: {} } });
      expect(annexClient.getSatellite(FP)).toMatchObject({ state: 'connected', lastError: null });
      expect(annexClient.getSatellite(FP)?.problem).toBeUndefined();
    });

    it('Retry on a paired satellite not seen since startup starts looking for it, and connects once it is found', async () => {
      expect(annexClient.getSatellite(FP)).toBeNull();
      annexClient.retry(FP);
      expect(annexClient.getSatellite(FP)).toMatchObject({ state: 'discovering', alias: 'Pinned Mac' });
      expect(WebSocketMock).not.toHaveBeenCalled();
      await discover();
      expect(WebSocketMock).toHaveBeenCalledTimes(1);
      expect(annexClient.getSatellite(FP)).toMatchObject({ state: 'connecting', host: '192.168.1.50' });
    });

    it('says what a 403 for the wrong role means, and keeps retrying', async () => {
      await discover();
      vi.useFakeTimers();
      try {
        refusal(403, { error: 'peer_role_not_allowed' });
        await vi.waitFor(() => expect(annexClient.getSatellite(FP)?.problem?.code).toBe('wrong-role'));
        expect(annexClient.getSatellite(FP)?.problem?.action).toBe('Pair again from this computer to control it.');
      } finally { vi.useRealTimers(); }
    });

    it('retries after any other refusal', async () => {
      await discover();
      vi.useFakeTimers();
      try {
        refusal(503, { error: 'busy' });
        await vi.waitFor(() => expect(annexClient.getSatellite(FP)?.problem?.code).toBe('tls-unavailable'));
        expect(annexClient.getSatellite(FP)?.lastError).toMatch(/couldn't start its secure connection\. Turn Annex off and on there/);
        expect(annexClient.getSatellite(FP)?.needsPairing).toBeUndefined();
        vi.advanceTimersByTime(120_000);
        expect(WebSocketMock.mock.calls.length).toBeGreaterThan(1);
      } finally { vi.useRealTimers(); }
    });

    it('stops reconnecting when the satellite closes the socket because the pairing was removed', async () => {
      await discover();
      const socket = sockets[0];
      socket.handlers.open();
      vi.useFakeTimers();
      try {
        socket.handlers.close(4401, Buffer.from('peer_not_paired'));
        expect(annexClient.getSatellite(FP)).toMatchObject({ needsPairing: true, lastError: expect.stringMatching(/no longer paired/) });
        vi.advanceTimersByTime(120_000);
        expect(WebSocketMock).toHaveBeenCalledTimes(1);
      } finally { vi.useRealTimers(); }
    });

    it('treats an expired satellite certificate as needing pairing again', async () => {
      await discover();
      sockets[0].handlers.error(Object.assign(new Error('certificate has expired'), { code: 'CERT_HAS_EXPIRED' }));
      expect(annexClient.getSatellite(FP)).toMatchObject({ needsPairing: true, lastError: expect.stringMatching(/expired/) });
    });

    it('stops on another certificate at the address, and tries once more only at a newly announced address', async () => {
      await discover('192.168.1.50');
      vi.useFakeTimers();
      try {
        sockets[0].handlers.error(Object.assign(new Error('Peer certificate does not match the pinned certificate'), { code: 'ERR_ANNEX_PIN_MISMATCH' }));
        expect(annexClient.getSatellite(FP)).toMatchObject({ state: 'disconnected', needsPairing: true, lastError: expect.stringMatching(/different certificate/) });
        vi.advanceTimersByTime(120_000);
        expect(WebSocketMock).toHaveBeenCalledTimes(1);
      } finally { vi.useRealTimers(); }
      await bonjourFindCallback!(makeService({ addresses: ['192.168.1.50'] }));
      expect(WebSocketMock).toHaveBeenCalledTimes(1);
      await bonjourFindCallback!(makeService({ addresses: ['10.9.9.9'] }));
      expect(WebSocketMock).toHaveBeenCalledTimes(2);
      expect(WebSocketMock.mock.calls.at(-1)![0]).toBe('wss://10.9.9.9:9000/ws?client=desktop');
    });

    it('waits for a retry when the satellite certificate is not valid yet (a clock difference)', async () => {
      await discover();
      vi.useFakeTimers();
      try {
        sockets[0].handlers.error(Object.assign(new Error('certificate is not yet valid'), { code: 'CERT_NOT_YET_VALID' }));
        expect(annexClient.getSatellite(FP)).toMatchObject({ state: 'disconnected', lastError: expect.stringMatching(/date and time/) });
        expect(annexClient.getSatellite(FP)?.needsPairing).toBeUndefined();
        vi.advanceTimersByTime(120_000);
        expect(WebSocketMock).toHaveBeenCalledTimes(1);
      } finally { vi.useRealTimers(); }
      annexClient.retry(FP);
      expect(WebSocketMock).toHaveBeenCalledTimes(2);
    });

    it('treats a REST 401 needs_pairing or peer_not_paired like the same refusal on the WebSocket', async () => {
      await discover();
      sockets[0].handlers.open();
      vi.mocked(https.request).mockImplementationOnce(((_url: string, _options: unknown, cb: any) => {
        const req = Object.assign(new EventEmitter(), { setTimeout: vi.fn(), destroy: vi.fn(), write: vi.fn(), end: () => {
          const res = Object.assign(new EventEmitter(), { statusCode: 401 });
          cb(res);
          res.emit('data', Buffer.from(JSON.stringify({ error: 'peer_not_paired', message: 'x' })));
          res.emit('end');
        } });
        return req;
      }) as any);
      await expect(annexClient.requestGroupProjectGet(FP, 'gp_1')).rejects.toThrow(/401/);
      expect(annexClient.getSatellite(FP)).toMatchObject({ needsPairing: true, lastError: expect.stringMatching(/no longer paired/) });
    });

    it('never moves a connected satellite to an address discovery announces', async () => {
      await discover('192.168.1.50');
      sockets[0].handlers.open();
      expect(annexClient.getSatellite(FP)?.state).toBe('connected');
      await bonjourFindCallback!(makeService({ addresses: ['10.9.9.9'] }));
      expect(annexClient.getSatellite(FP)?.host).toBe('192.168.1.50');
      expect(WebSocketMock).toHaveBeenCalledTimes(1);
    });

    it('tries an announced address while disconnected, through the same pin', async () => {
      await discover('192.168.1.50');
      sockets[0].handlers.error(new Error('ECONNREFUSED'));
      await bonjourFindCallback!(makeService({ addresses: ['10.9.9.9'] }));
      expect(WebSocketMock.mock.calls.at(-1)![0]).toBe('wss://10.9.9.9:9000/ws?client=desktop');
      expect(WebSocketMock.mock.calls.at(-1)![1]).toMatchObject({ pinned: true });
    });

    it('builds every outbound connection from pinned options (source check)', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const source = fs.readFileSync(path.join(__dirname, 'annex-client.ts'), 'utf8');
      expect(source).not.toMatch(/rejectUnauthorized:\s*false/);
      expect(source).not.toMatch(/createTlsClientOptions/);
      const isComment = (index: number) => /^\s*(\*|\/\/)/.test(source.slice(source.lastIndexOf('\n', index) + 1, index));
      const calls = [...source.matchAll(/(https\.(get|request)|new WebSocket)\(/g)].filter((m) => !isComment(m.index!));
      expect(calls.length).toBeGreaterThanOrEqual(9);
      for (const call of calls) {
        expect(source.slice(Math.max(0, call.index! - 700), call.index! + 200)).toContain('...tlsOptions');
      }
      const assignments = [...source.matchAll(/const tlsOptions = ([^;]+);/g)].map((m) => m[1]);
      expect(assignments.length).toBeGreaterThan(0);
      for (const value of assignments) expect(value).toMatch(/^(pinnedTlsOptionsFor|annexTls\.createPinnedTlsClientOptions)\(/);
      expect(source).toMatch(/function pinnedJsonPost\(host: string, port: number, urlPath: string, tlsOptions: tls\.ConnectionOptions/);
    });
  });

  describe('reachability (#3058)', () => {
    const FP = 'cc:03:cc:03';
    const base = { fingerprint: FP, alias: 'Studio', icon: 'server', color: 'green', publicKey: 'sat-pk', pairedAt: '2026-01-01',
      lastSeen: '2026-01-01', role: 'satellite' as const, tlsCertificateFingerprint: 'AB:CD', tlsCertificatePem: 'SATELLITE-PEM' };
    let sockets: Array<{ url: string; handlers: Record<string, (...args: any[]) => void> }>;
    let peer: Record<string, unknown>;

    beforeEach(() => {
      sockets = [];
      peer = { ...base, knownHosts: ['10.0.0.4', '10.0.0.5'], mainPort: 9443 };
      WebSocketMock.mockImplementation(function (this: any, url: string) {
        const handlers: Record<string, (...args: any[]) => void> = {};
        Object.assign(this, { url, handlers, readyState: WebSocketMock.OPEN, send: vi.fn(), ping: vi.fn(), close: vi.fn(), terminate: vi.fn(),
          removeListener: vi.fn(), on: vi.fn((event: string, cb: any) => { handlers[event] = cb; return this; }) });
        sockets.push(this);
        return this;
      });
      vi.mocked(annexPeers.getPeer).mockImplementation((fp: string) => (fp === FP ? { ...peer } : undefined) as any);
      vi.mocked(annexPeers.listPeers).mockImplementation(() => [{ ...peer }] as any);
    });

    const refused = () => Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });

    it('connects to a paired satellite at its remembered address at startup, without waiting for discovery', () => {
      annexClient.startClient();
      expect(sockets.map((x) => x.url)).toEqual(['wss://10.0.0.4:9443/ws?client=desktop']);
      expect(annexClient.getSatellite(FP)).toMatchObject({ state: 'connecting', host: '10.0.0.4', mainPort: 9443 });
    });

    it('connects to a satellite reachable only by a typed host', () => {
      peer = { ...base, typedHost: 'studio.tail1234.ts.net', mainPort: 9443 };
      annexClient.startClient();
      expect(sockets.map((x) => x.url)).toEqual(['wss://studio.tail1234.ts.net:9443/ws?client=desktop']);
    });

    it('leaves a satellite with no address at all to discovery, and one that needs pairing alone', () => {
      peer = { ...base };
      annexClient.startClient();
      vi.mocked(annexPeers.peerNeedsPairing).mockReturnValue(true);
      peer = { ...base, knownHosts: ['10.0.0.4'], mainPort: 9443 };
      annexClient.startClient();
      expect(sockets).toHaveLength(0);
    });

    it('remembers where it was reached', () => {
      annexClient.startClient();
      sockets[0].handlers.open();
      expect(annexPeers.noteReached).toHaveBeenCalledWith(FP, '10.0.0.4', 9443);
    });

    it('tries each address in turn, then backs off and keeps retrying', async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, 'random').mockReturnValue(0.5);
      annexClient.startClient();
      sockets[0].handlers.error(refused());
      await vi.advanceTimersByTimeAsync(300);
      expect(sockets.map((x) => x.url)).toEqual(['wss://10.0.0.4:9443/ws?client=desktop', 'wss://10.0.0.5:9443/ws?client=desktop']);
      // Both failed: wait for the backoff (1s at attempt one), then start over at the first.
      sockets[1].handlers.error(refused());
      await vi.advanceTimersByTimeAsync(300);
      expect(sockets).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(sockets[2].url).toBe('wss://10.0.0.4:9443/ws?client=desktop');
      // And it doesn't stop after one round.
      sockets[2].handlers.error(refused());
      await vi.advanceTimersByTimeAsync(300);
      sockets[3].handlers.error(refused());
      await vi.advanceTimersByTimeAsync(5_000);
      expect(sockets.length).toBeGreaterThanOrEqual(5);
    });

    it('reconnects through a saved forward without borrowing its port for direct hosts', async () => {
      vi.useFakeTimers();
      peer = { ...base, knownHosts: ['127.0.0.1', '10.0.0.4'], hostPorts: { '127.0.0.1': 7443, '10.0.0.4': 9443 }, mainPort: 9443 };
      annexClient.startClient();
      expect(sockets[0].url).toBe('wss://127.0.0.1:7443/ws?client=desktop');
      sockets[0].handlers.error(refused());
      expect(annexClient.getSatellite(FP)?.lastError).toMatch(/local forward is running/);
      expect(annexClient.getSatellite(FP)?.problem?.action).toMatch(/local forward is running/);
      await vi.advanceTimersByTimeAsync(250);
      expect(sockets[1].url).toBe('wss://10.0.0.4:9443/ws?client=desktop');
    });

    it('reaches the legacy direct port after an older build leaves a stale per-host port', async () => {
      vi.useFakeTimers();
      peer = {
        ...base, knownHosts: ['10.0.0.4', '127.0.0.1'],
        hostPorts: { '10.0.0.4': 9443, '127.0.0.1': 7443 }, mainPort: 9000,
      };
      annexClient.startClient();
      expect(sockets[0].url).toBe('wss://10.0.0.4:9443/ws?client=desktop');
      sockets[0].handlers.error(refused());
      await vi.advanceTimersByTimeAsync(250);
      expect(sockets[1].url).toBe('wss://10.0.0.4:9000/ws?client=desktop');
      sockets[1].handlers.open();
      expect(annexPeers.noteReached).toHaveBeenLastCalledWith(FP, '10.0.0.4', 9000);
    });

    it('picks a routable address from an announcement, IPv6 when that is all there is, never link-local', async () => {
      peer = { ...base };
      mockHttpGetIdentity({ fingerprint: FP, alias: 'Studio', icon: 'server', color: 'green', publicKey: 'sat-pk' });
      annexClient.startClient();
      await bonjourFindCallback!(makeService({ addresses: ['fe80::1', '2001:db8::5'], referer: { address: 'fe80::1' } }));
      expect(sockets.map((x) => x.url)).toEqual(['wss://[2001:db8::5]:9000/ws?client=desktop']);
    });

    it('takes a typed host, refuses one that is not a host, and tries it at once', () => {
      peer = { ...base, mainPort: 9443 };
      annexClient.startClient();
      expect(annexClient.setSatelliteHost(FP, 'https://studio')).toEqual({ ok: false, error: expect.stringMatching(/name or address/) });
      expect(annexPeers.setTypedHost).not.toHaveBeenCalled();
      vi.mocked(annexPeers.setTypedHost).mockImplementation((_fp, host) => { peer = { ...peer, typedHost: host }; return true; });
      expect(annexClient.setSatelliteHost(FP, 'studio.tail1234.ts.net')).toEqual({ ok: true });
      expect(annexPeers.setTypedHost).toHaveBeenCalledWith(FP, 'studio.tail1234.ts.net');
      expect(sockets.at(-1)!.url).toBe('wss://studio.tail1234.ts.net:9443/ws?client=desktop');
      expect(annexClient.satelliteAddress(FP)).toBe('studio.tail1234.ts.net:9443');
      expect(annexClient.setSatelliteHost(FP, '')).toEqual({ ok: true });
      expect(annexPeers.setTypedHost).toHaveBeenLastCalledWith(FP, undefined);
    });

    it('can reuse a remembered address-specific port when no legacy default is stored', () => {
      peer = { ...base, knownHosts: ['127.0.0.1'], hostPorts: { '127.0.0.1': 7443 } };
      expect(annexClient.setSatelliteHost(FP, '127.0.0.1')).toEqual({ ok: true });
    });

    const mismatch = () => Object.assign(new Error('pin'), { code: 'ERR_ANNEX_PIN_MISMATCH' });

    it('goes to an address announced during an attempt next, at once, instead of the stale one again', async () => {
      vi.useFakeTimers();
      mockHttpGetIdentity({ fingerprint: FP, alias: 'Studio', icon: 'server', color: 'green', publicKey: 'sat-pk' });
      annexClient.startClient();
      expect(sockets[0].url).toBe('wss://10.0.0.4:9443/ws?client=desktop');
      await bonjourFindCallback!(makeService({ addresses: ['192.168.1.77'], port: 9443 }));
      sockets[0].handlers.error(refused());
      await vi.advanceTimersByTimeAsync(300);
      expect(sockets.map((x) => x.url)).toEqual(['wss://10.0.0.4:9443/ws?client=desktop', 'wss://192.168.1.77:9443/ws?client=desktop']);
    });

    it('moves on when one of several addresses shows another certificate, and stops only when all do', async () => {
      vi.useFakeTimers();
      annexClient.startClient();
      sockets[0].handlers.error(mismatch());
      expect(annexClient.getSatellite(FP)?.needsPairing).toBeUndefined();
      await vi.advanceTimersByTimeAsync(300);
      expect(sockets[1].url).toBe('wss://10.0.0.5:9443/ws?client=desktop');
      sockets[1].handlers.error(mismatch());
      expect(annexClient.getSatellite(FP)).toMatchObject({ needsPairing: true, problem: { code: 'cert-mismatch' } });
    });

    it('a new address clears "showed a different certificate" and tries again', () => {
      peer = { ...base, knownHosts: ['10.0.0.4'], mainPort: 9443 };
      annexClient.startClient();
      sockets[0].handlers.error(mismatch());
      expect(annexClient.getSatellite(FP)?.needsPairing).toBe(true);
      vi.mocked(annexPeers.setTypedHost).mockImplementation((_fp, host) => { peer = { ...peer, typedHost: host }; return true; });
      expect(annexClient.setSatelliteHost(FP, 'studio.tail1234.ts.net').ok).toBe(true);
      expect(sockets.at(-1)!.url).toBe('wss://studio.tail1234.ts.net:9443/ws?client=desktop');
    });

    it('asks for a port when it has never reached the satellite', () => {
      peer = { ...base };
      expect(annexClient.setSatelliteHost(FP, 'studio.local')).toEqual({ ok: false, error: expect.stringMatching(/add its port/) });
      expect(annexClient.setSatelliteHost(FP, 'studio.local:9443')).toEqual({ ok: true });
    });

    it('saves a typed host without connecting while Connect to satellites is off', () => {
      vi.mocked(annexSettings.getSettings).mockReturnValue({ enableServer: true, enableClient: false } as any);
      expect(annexClient.setSatelliteHost(FP, 'studio.local')).toEqual({ ok: true });
      expect(annexPeers.setTypedHost).toHaveBeenCalledWith(FP, 'studio.local');
      expect(sockets).toHaveLength(0);
    });

    it('keeps a typed address as typed: connecting through it is not remembered as a found address', () => {
      peer = { ...base, typedHost: 'studio:7000', mainPort: 9443 };
      annexClient.startClient();
      expect(sockets[0].url).toBe('wss://studio:7000/ws?client=desktop');
      sockets[0].handlers.open();
      expect(annexPeers.noteReached).not.toHaveBeenCalled();
      expect(annexPeers.updateLastSeen).toHaveBeenCalledWith(FP);
    });

    it('starts nothing more for a refusal that arrives after the client stopped', async () => {
      vi.useFakeTimers();
      annexClient.startClient();
      const res = Object.assign(new EventEmitter(), { statusCode: 503 });
      sockets[0].handlers['unexpected-response']({ destroy: vi.fn() }, res);
      annexClient.stopClient();
      res.emit('data', Buffer.from('{"error":"tls_unavailable"}'));
      res.emit('end');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(sockets).toHaveLength(1);
    });

    it('opens the membership channel with the main connection, and closes it when that drops (#3060)', async () => {
      const channelMod = await import('./annex-network-channel');
      annexClient.startClient();
      sockets[0].handlers.open();
      expect(channelMod.connectTo).toHaveBeenCalledWith(FP, '10.0.0.4', 9443, expect.objectContaining({ pinned: true }));
      annexClient.disconnect(FP);
      expect(channelMod.closeFor).toHaveBeenCalledWith(FP, 'out');
      annexClient.stopClient();
      expect(channelMod.closeAll).toHaveBeenCalledWith('out');
    });

    it('connects a member waiting to be found as soon as it has an address (#3061)', () => {
      peer = { ...base, role: 'member' };
      annexClient.connect(FP);
      expect(annexClient.getSatellite(FP)?.state).toBe('discovering');
      expect(sockets).toHaveLength(0);
      peer = { ...base, role: 'member', knownHosts: ['10.0.0.8'], mainPort: 9443 };
      annexClient.connect(FP);
      expect(sockets.map((x) => x.url)).toEqual(['wss://10.0.0.8:9443/ws?client=desktop']);
    });

    it('forgetting a network member removes it everywhere first (#3061)', async () => {
      const membershipMod = await import('./annex-network-membership');
      annexClient.forgetSatellite(FP);
      expect(membershipMod.noteLocalRemoval).toHaveBeenCalledWith(FP);
    });

    it('never sets a typed host on a device that controls this machine', () => {
      peer = { ...base, role: 'controller' };
      expect(annexClient.setSatelliteHost(FP, 'studio').ok).toBe(false);
    });

    it('does nothing on wake while Connect to satellites is off', () => {
      vi.mocked(annexSettings.getSettings).mockReturnValue({ enableServer: true, enableClient: false } as any);
      annexClient.resumeAllConnections();
      expect(sockets).toHaveLength(0);
      expect(mockBonjourInstance.find).not.toHaveBeenCalled();
    });
  });

  it.each([0, 1])('accepts exactly 16 KiB and rejects a response %i byte(s) beyond the cap', async (extra) => {
    const fingerprint = Array(16).fill('db').join(':');
    annexClient._addConnectedSatelliteForTesting(fingerprint);
    const limit = 16 * 1024;
    const value = 'é'.repeat((limit - 2) / 2);
    const bytes = Buffer.from(JSON.stringify(value) + ' '.repeat(extra));
    expect(bytes.byteLength).toBe(limit + extra);
    const response = Object.assign(new EventEmitter(), { statusCode: 200 });
    const request = Object.assign(new EventEmitter(), {
      write: vi.fn(), destroy: vi.fn((error: Error) => { request.emit('error', error); }), end: () => {},
    });
    vi.mocked(https.request).mockImplementation(((_url: string, _options: https.RequestOptions, callback: (res: unknown) => void) => {
      request.end = () => {
        callback(response);
        response.emit('data', bytes.subarray(0, limit - 1));
        response.emit('data', bytes.subarray(limit - 1));
        response.emit('end');
      };
      return request;
    }) as never);
    const result = annexClient.postToMachine(fingerprint, '/api/v1/network/handoff-capacity', {}, { maxResponseBytes: limit });
    if (extra) {
      await expect(result).rejects.toThrow('byte limit');
      expect(request.destroy).toHaveBeenCalledTimes(1);
    } else {
      expect(await result).toEqual({ status: 200, body: value });
      expect(request.destroy).not.toHaveBeenCalled();
    }
  });

  it('aborts a trickling capacity request at its total deadline even while response data keeps arriving', async () => {
    vi.useFakeTimers();
    const fingerprint = Array(16).fill('dc').join(':');
    annexClient._addConnectedSatelliteForTesting(fingerprint);
    let signal: AbortSignal | undefined;
    let chunks = 0;
    let interval: ReturnType<typeof setInterval>;
    const response = Object.assign(new EventEmitter(), { statusCode: 200 });
    const request = Object.assign(new EventEmitter(), {
      write: vi.fn(),
      destroy: vi.fn((error: Error) => { clearInterval(interval); request.emit('error', error); response.emit('error', error); }),
      end: () => {},
    });
    vi.mocked(https.request).mockImplementation(((_url: string, options: https.RequestOptions, callback: (res: unknown) => void) => {
      signal = options.signal;
      // Simulate Node's request AbortSignal behavior at the transport boundary.
      signal?.addEventListener('abort', () => request.destroy(new Error('request aborted')), { once: true });
      request.end = () => {
        callback(response);
        interval = setInterval(() => { chunks++; response.emit('data', Buffer.from(' ')); }, 100);
      };
      return request;
    }) as never);
    const pending = withCapacityDeadline((abortSignal) => annexClient.postToMachine(fingerprint,
      '/api/v1/network/handoff-capacity', {}, { signal: abortSignal }));
    const rejected = expect(pending).rejects.toThrow(/deadline|aborted/);
    await vi.advanceTimersByTimeAsync(CAPACITY_SAMPLE_TIMEOUT_MS - 1);
    expect(chunks).toBeGreaterThan(10);
    expect(request.destroy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(signal?.aborted).toBe(true);
    expect(request.destroy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  describe('chat across desktops (#2390)', () => {
    const FP = 'dd:04:dd:04';
    let requests: Array<{ url: string; method: string; body?: any }>;
    let answers: Array<{ status: number; body: object }>;

    beforeEach(() => {
      requests = [];
      answers = [];
      vi.mocked(https.request).mockImplementation(((url: string, options: any, cb: any) => {
        let body: any;
        const req = Object.assign(new EventEmitter(), {
          setTimeout: vi.fn(), destroy: vi.fn(),
          write: (chunk: string) => { body = JSON.parse(chunk); },
          end: () => {
            requests.push({ url, method: options.method, body });
            const answer = answers.shift() ?? { status: 200, body: {} };
            const res = Object.assign(new EventEmitter(), { statusCode: answer.status });
            cb(res);
            res.emit('data', Buffer.from(JSON.stringify(answer.body)));
            res.emit('end');
          },
        });
        return req;
      }) as any);
      annexClient._addConnectedSatelliteForTesting(FP);
    });

    it('reads a chat page through the satellite\'s phone route, and remembers its epoch', async () => {
      answers.push({ status: 200, body: { epoch: 'ep_1', events: [] } });
      expect(await annexClient.requestChatPage(FP, 'durable_chat', { limit: 50 })).toEqual({ epoch: 'ep_1', events: [] });
      expect(requests[0]).toMatchObject({ method: 'GET' });
      expect(requests[0].url).toMatch(/\/api\/v1\/mobile\/agents\/durable_chat\/chat\?limit=50$/);
      // The next command uses that epoch, with no capabilities read.
      answers.push({ status: 200, body: { status: 'completed', result: { interrupted: true } } });
      await annexClient.sendChatCommand(FP, { type: 'chat.interrupt', agentId: 'durable_chat', sessionId: 's1' });
      expect(requests[1]).toMatchObject({ method: 'POST', body: { type: 'chat.interrupt', agentId: 'durable_chat', sessionId: 's1', version: 1, epoch: 'ep_1' } });
      expect(requests[1].body.commandId).toEqual(expect.any(String));
    });

    it('reads the epoch from capabilities when it has none, and sends again once after a stale epoch', async () => {
      answers.push({ status: 200, body: { epoch: 'ep_old' } });
      answers.push({ status: 409, body: { status: 'rejected', error: { code: 'epoch_mismatch' } } });
      answers.push({ status: 200, body: { epoch: 'ep_new' } });
      answers.push({ status: 200, body: { status: 'completed', result: {} } });
      expect(await annexClient.sendChatCommand(FP, { type: 'chat.setLevel', agentId: 'a', sessionId: 's', level: 'plan' })).toEqual({ status: 'completed', result: {} });
      expect(requests.map((r) => `${r.method} ${r.url.replace(/^https:\/\/[^/]+/, '')}`)).toEqual([
        'GET /api/v1/mobile/capabilities', 'POST /api/v1/mobile/commands', 'GET /api/v1/mobile/capabilities', 'POST /api/v1/mobile/commands',
      ]);
      expect(requests[3].body.epoch).toBe('ep_new');
      expect(requests[3].body.commandId).not.toBe(requests[1].body.commandId);
    });

    it('answers a refusal as its receipt, and refuses anything but a chat command', async () => {
      answers.push({ status: 200, body: { epoch: 'ep' } });
      answers.push({ status: 409, body: { status: 'rejected', error: { code: 'session_mismatch' } } });
      expect(await annexClient.sendChatCommand(FP, { type: 'chat.send', agentId: 'a', sessionId: 's', text: 'x' })).toMatchObject({ status: 'rejected' });
      await expect(annexClient.sendChatCommand(FP, { type: 'agent.delete', agentId: 'a' })).rejects.toThrow(/Not a chat command/);
    });
  });

  describe('pairing over TLS', () => {
    const SAT_FP = 'bb:02:bb:02:bb:02:bb:02:bb:02:bb:02:bb:02:bb:02';
    const CERT = 'ab'.repeat(32);
    const CERT_COLONS = Array(32).fill('AB').join(':');
    let posted: Array<{ url: string; options: any; body: any }>;

    function answerPair(status: number, body: object) {
      vi.mocked(https.request).mockImplementation(((url: string, options: any, cb: any) => {
        const req = Object.assign(new EventEmitter(), {
          setTimeout: vi.fn(), destroy: vi.fn(),
          write: (chunk: string) => { posted.push({ url, options, body: JSON.parse(chunk) }); },
          end: () => {
            const res = Object.assign(new EventEmitter(), { statusCode: status });
            cb(res);
            res.emit('data', Buffer.from(JSON.stringify(body)));
            res.emit('end');
          },
        });
        return req;
      }) as any);
    }

    async function link(overrides: Partial<{ hosts: string[]; cert: string; pin: string }> = {}) {
      const { buildPairingUrl } = await import('./annex-pairing-url');
      return buildPairingUrl({ hosts: overrides.hosts ?? ['192.168.1.60'], port: 9443, fingerprint: SAT_FP, certFingerprint: overrides.cert ?? CERT, pin: overrides.pin ?? '123456', name: 'Mini' })!;
    }

    beforeEach(() => {
      posted = [];
      vi.mocked(annexIdentity.computeFingerprint).mockImplementation((key: string) => (key === 'sat-pk' ? SAT_FP : 'other'));
      vi.mocked(annexTls.probePeerCertificate).mockResolvedValue({ certPem: 'PROBED-PEM', fingerprint: CERT_COLONS });
      answerPair(200, { token: 't', fingerprint: SAT_FP, publicKey: 'sat-pk', alias: 'Mini', icon: 'server', color: 'teal', tlsCertificateFingerprint: CERT_COLONS });
    });

    it('pairs from a link: PIN only to the certificate it names, binding sent, answer checked, pin stored', async () => {
      const result = await annexClient.pairWithLink(await link());
      expect(result).toEqual({ success: true, alias: 'Mini', fingerprint: SAT_FP });
      expect(annexTls.probePeerCertificate).toHaveBeenCalledWith('192.168.1.60', 9443);
      expect(annexTls.createPinnedTlsClientOptions).toHaveBeenCalledWith(LOCAL_IDENTITY, { certPem: 'PROBED-PEM', fingerprint: CERT_COLONS });
      expect(posted).toHaveLength(1);
      expect(posted[0].url).toBe('https://192.168.1.60:9443/pair');
      expect(posted[0].options).toMatchObject({ pinned: true, method: 'POST' });
      // Annex Network is on by default, so it asks to join (#3061).
      expect(posted[0].body).toEqual({ pin: '123456', publicKey: 'local-pub-key', alias: 'Test Mac', icon: 'computer', color: 'indigo', certBinding: 'cert-binding', network: 1 });
      expect(annexPeers.addPeer).toHaveBeenCalledWith(expect.objectContaining({
        fingerprint: SAT_FP, publicKey: 'sat-pk', alias: 'Mini', role: 'satellite', tlsCertificateFingerprint: CERT_COLONS, tlsCertificatePem: 'PROBED-PEM',
        knownHosts: ['192.168.1.60'], mainPort: 9443,
        hostPorts: { '192.168.1.60': 9443 },
      }));
      // A satellite that didn't agree to join (older, or Annex Network off) stays a satellite.
      expect(vi.mocked(annexPeers.addPeer).mock.calls[0][0].role).toBe('satellite');
      expect(annexClient.getSatellite(SAT_FP)).toMatchObject({ host: '192.168.1.60', mainPort: 9443 });
    });

    it('pairs only through the override and saves both its port and the original link ports', async () => {
      expect(await annexClient.pairWithLink(await link(), ' 127.0.0.1:7443 ')).toMatchObject({ success: true });
      expect(annexTls.probePeerCertificate).toHaveBeenCalledExactlyOnceWith('127.0.0.1', 7443);
      expect(posted.map((p) => p.url)).toEqual(['https://127.0.0.1:7443/pair']);
      expect(annexPeers.addPeer).toHaveBeenCalledWith(expect.objectContaining({
        knownHosts: ['127.0.0.1', '192.168.1.60'], mainPort: 9443,
        hostPorts: { '127.0.0.1': 7443, '192.168.1.60': 9443 },
      }));
      expect(annexClient.getSatellite(SAT_FP)).toMatchObject({ host: '127.0.0.1', mainPort: 7443 });
    });

    it.each([CERT, CERT_COLONS, Array(32).fill('aB').join(' ')])('pairs without a link using a full fingerprint %j and the same pinned request', async (certificate) => {
      expect(await annexClient.pairWithEndpoint(' 127.0.0.1:7443 ', '123456', certificate)).toEqual({
        success: true, alias: 'Mini', fingerprint: SAT_FP,
      });
      expect(annexTls.createPinnedTlsClientOptions).toHaveBeenCalledWith(LOCAL_IDENTITY, { certPem: 'PROBED-PEM', fingerprint: CERT_COLONS });
      expect(posted[0]).toMatchObject({ url: 'https://127.0.0.1:7443/pair', body: { pin: '123456', network: 1 } });
      expect(annexPeers.addPeer).toHaveBeenCalledWith(expect.objectContaining({
        fingerprint: SAT_FP, knownHosts: ['127.0.0.1'], hostPorts: { '127.0.0.1': 7443 }, mainPort: 7443,
      }));
    });

    it('pairs manually using bracketed IPv6 and remembers the unbracketed host with its port', async () => {
      expect(await annexClient.pairWithEndpoint('[::1]:7443', '123456', CERT)).toMatchObject({ success: true });
      expect(annexTls.probePeerCertificate).toHaveBeenCalledExactlyOnceWith('::1', 7443);
      expect(posted[0].url).toBe('https://[::1]:7443/pair');
      expect(annexPeers.addPeer).toHaveBeenCalledWith(expect.objectContaining({
        knownHosts: ['::1'], hostPorts: { '::1': 7443 }, mainPort: 7443,
      }));
    });

    it('never sends a manual PIN when the presented certificate differs', async () => {
      vi.mocked(annexTls.probePeerCertificate).mockResolvedValue({ certPem: 'OTHER', fingerprint: 'cd'.repeat(32) });
      expect(await annexClient.pairWithEndpoint('[::1]:7443', '123456', CERT)).toMatchObject({
        success: false, error: expect.stringMatching(/doesn't match.*code was not sent/),
      });
      expect(posted).toHaveLength(0);
      expect(annexPeers.addPeer).not.toHaveBeenCalled();
    });

    it.each(['', 'AB12 CD34 EF56 7890', 'ab'.repeat(20), 'ab'.repeat(31), 'ab'.repeat(33), 'zz'.repeat(32)])('rejects malformed manual fingerprint %j before dialing', async (certificate) => {
      expect(await annexClient.pairWithEndpoint('localhost:7443', '123456', certificate)).toMatchObject({
        success: false, error: expect.stringMatching(/full certificate fingerprint/),
      });
      expect(annexTls.probePeerCertificate).not.toHaveBeenCalled();
      expect(posted).toHaveLength(0);
    });

    it.each([
      'localhost', 'localhost:', 'localhost:0', 'localhost:65536', 'localhost:1.5',
      'localhost:-1', 'https://localhost:7443', 'user@localhost:7443',
      'localhost:7443/pair', 'localhost:7443?pin=123456', 'localhost:7443#fragment',
      'localhost\\other:7443', '[::1]:0', '[::1]:65536',
    ])('rejects missing or invalid manual port %j', async (address) => {
      expect(await annexClient.pairWithEndpoint(address, '123456', CERT)).toMatchObject({
        success: false, error: expect.stringMatching(/main TLS port/),
      });
      expect(annexTls.probePeerCertificate).not.toHaveBeenCalled();
    });

    it('reports an invalid manual PIN before dialing, and a wrong PIN from the server', async () => {
      expect(await annexClient.pairWithEndpoint('localhost:7443', '12345', CERT)).toMatchObject({ success: false, error: expect.stringMatching(/six-digit/) });
      expect(annexTls.probePeerCertificate).not.toHaveBeenCalled();
      answerPair(401, { error: 'invalid_pin' });
      expect(await annexClient.pairWithEndpoint('localhost:7443', '123456', CERT)).toMatchObject({ success: false, error: expect.stringMatching(/code doesn't match/) });
      expect(annexPeers.addPeer).not.toHaveBeenCalled();
    });

    it('reports an unreachable manual endpoint without sending its PIN', async () => {
      vi.mocked(annexTls.probePeerCertificate).mockRejectedValue(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }));
      expect(await annexClient.pairWithEndpoint('localhost:7443', '123456', CERT)).toMatchObject({ success: false, error: expect.stringMatching(/local forward is running/) });
      expect(posted).toHaveLength(0);
    });

    it('uses the link TLS port when the override is just a host', async () => {
      expect(await annexClient.pairWithLink(await link(), '[::1]')).toMatchObject({ success: true });
      expect(annexTls.probePeerCertificate).toHaveBeenCalledExactlyOnceWith('::1', 9443);
      expect(posted[0].url).toBe('https://[::1]:9443/pair');
    });

    it.each(['https://127.0.0.1:7443', '127.0.0.1:0', '127.0.0.1:65536', 'localhost:', 'not a host'])('rejects invalid override %j before dialing', async (override) => {
      expect(await annexClient.pairWithLink(await link(), override)).toMatchObject({ success: false, error: expect.stringMatching(/TLS port/) });
      expect(annexTls.probePeerCertificate).not.toHaveBeenCalled();
      expect(posted).toHaveLength(0);
    });

    it('never sends the PIN or falls back to link hosts when the override presents another certificate', async () => {
      vi.mocked(annexTls.probePeerCertificate).mockResolvedValue({ certPem: 'PROXY-PEM', fingerprint: 'cd'.repeat(32) });
      expect(await annexClient.pairWithLink(await link(), '127.0.0.1:7443')).toMatchObject({
        success: false, error: expect.stringMatching(/not the one in the link/),
      });
      expect(annexTls.probePeerCertificate).toHaveBeenCalledExactlyOnceWith('127.0.0.1', 7443);
      expect(posted).toHaveLength(0);
      expect(annexPeers.addPeer).not.toHaveBeenCalled();
    });

    it('suggests checking the forward when a loopback override refuses the connection', async () => {
      vi.mocked(annexTls.probePeerCertificate).mockRejectedValue(Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' }));
      expect(await annexClient.pairWithLink(await link(), '127.0.0.1:7443')).toMatchObject({
        success: false, error: expect.stringMatching(/local forward is running/),
      });
      expect(posted).toHaveLength(0);
    });

    it('joins as a network member when the satellite agrees, and stays one-to-one when Annex Network is off (#3061)', async () => {
      const membershipMod = await import('./annex-network-membership');
      const mine = { id: 'pairing-mine-0001', joinedAt: '2026-11-01T09:00:00.000Z' };
      vi.mocked(membershipMod.ownPairing).mockReturnValue(mine);
      answerPair(200, {
        token: 't', fingerprint: SAT_FP, publicKey: 'sat-pk', alias: 'Mini', icon: 'server', color: 'teal', tlsCertificateFingerprint: CERT_COLONS, network: 1,
        pairing: mine, serverPairing: { id: 'pairing-sat-00001', joinedAt: '2026-10-01T09:00:00.000Z' },
      });
      await annexClient.pairWithLink(await link());
      // It offers the pairing it has (#3107), records the satellite by the satellite's own pairing, and keeps its answer.
      expect(posted[0].body.selfPairing).toEqual(mine);
      expect(annexPeers.addPeer).toHaveBeenLastCalledWith(expect.objectContaining({
        role: 'member', kind: 'desktop', addedBy: LOCAL_IDENTITY.fingerprint, pairingId: 'pairing-sat-00001', pairedAt: '2026-10-01T09:00:00.000Z',
      }));
      expect(membershipMod.adoptOwnPairing).toHaveBeenCalledWith(mine);
      expect(membershipMod.noteLocalJoin).toHaveBeenCalledWith(SAT_FP);
      vi.mocked(membershipMod.ownPairing).mockReturnValue(undefined);

      vi.mocked(annexSettings.getSettings).mockReturnValue({ enableClient: true, alias: 'Test Mac', icon: 'computer', color: 'indigo', networkEnabled: false } as any);
      posted = [];
      await annexClient.pairWithLink(await link());
      expect(posted[0].body).not.toHaveProperty('network');
      expect(annexPeers.addPeer).toHaveBeenLastCalledWith(expect.objectContaining({ role: 'satellite' }));
    });

    it('sends nothing to an address showing another certificate, and tries the next', async () => {
      vi.mocked(annexTls.probePeerCertificate)
        .mockResolvedValueOnce({ certPem: 'OTHER', fingerprint: 'CD'.repeat(32) })
        .mockResolvedValueOnce({ certPem: 'PROBED-PEM', fingerprint: CERT_COLONS });
      expect((await annexClient.pairWithLink(await link({ hosts: ['10.0.0.1', '10.0.0.2'] }))).success).toBe(true);
      expect(posted.map((p) => p.url)).toEqual(['https://10.0.0.2:9443/pair']);

      posted = [];
      vi.mocked(annexTls.probePeerCertificate).mockResolvedValue({ certPem: 'OTHER', fingerprint: 'CD'.repeat(32) });
      expect(await annexClient.pairWithLink(await link())).toEqual({ success: false, error: expect.stringMatching(/not the one in the link/) });
      expect(posted).toHaveLength(0);
    });

    it('refuses an answer whose identity does not check out, and saves nothing', async () => {
      answerPair(200, { fingerprint: SAT_FP, publicKey: 'impostor-pk', alias: 'Mini' });
      expect((await annexClient.pairWithLink(await link())).success).toBe(false);
      answerPair(200, { fingerprint: SAT_FP, publicKey: 'sat-pk', alias: 'Mini', tlsCertificateFingerprint: 'EF'.repeat(32) });
      expect((await annexClient.pairWithLink(await link())).success).toBe(false);
      expect(annexPeers.addPeer).not.toHaveBeenCalled();
    });

    it("shows the satellite's own message when it refuses", async () => {
      answerPair(410, { error: 'pin_used', message: 'That code was already used. Show a new code.' });
      expect(await annexClient.pairWithLink(await link())).toEqual({ success: false, error: 'That code was already used. Show a new code.' });
      answerPair(404, { error: 'not_found' });
      expect((await annexClient.pairWithLink(await link())).error).toMatch(/newer version/);
    });

    it('says the certificate changed, not to retry blindly, when it changes between the check and the pairing', async () => {
      vi.mocked(annexTls.createPinnedTlsClientOptions).mockReturnValueOnce({ pinned: true } as any);
      vi.mocked(https.request).mockImplementationOnce(((_url: string, _options: unknown, _cb: unknown) => {
        const req = Object.assign(new EventEmitter(), { setTimeout: vi.fn(), write: vi.fn(), end: () => req.emit('error', Object.assign(new Error('pin mismatch'), { code: 'ERR_ANNEX_PIN_MISMATCH' })), destroy: vi.fn() });
        return req;
      }) as any);
      expect(await annexClient.pairWithLink(await link())).toEqual({
        success: false,
        error: "Mini showed a different certificate. The computer at that address isn't the one you meant. Check the link or code, then try again.",
      });
    });

    it('says what happened and what to do when no address in the link answers', async () => {
      vi.mocked(annexTls.probePeerCertificate).mockRejectedValue(Object.assign(new Error('connect ECONNREFUSED 192.168.1.60:9443'), { code: 'ECONNREFUSED' }));
      expect(await annexClient.pairWithLink(await link())).toEqual({
        success: false,
        error: "Mini isn't accepting connections. Check that Clubhouse is open there with Annex turned on.",
      });
      expect(posted).toHaveLength(0);
    });

    it('rejects something that is not a pairing link without dialling anything', async () => {
      expect((await annexClient.pairWithLink('https://example.com/pair')).success).toBe(false);
      expect(annexTls.probePeerCertificate).not.toHaveBeenCalled();
    });

    it('pairs a discovered service only after its certificate was read, and only to that certificate', async () => {
      mockHttpGetIdentity({ fingerprint: SAT_FP, alias: 'Mini', icon: 'server', color: 'teal', publicKey: 'sat-pk' });
      annexClient.startClient();
      await bonjourFindCallback!(makeService({ addresses: ['192.168.1.60'], port: 9443 }));
      expect(await annexClient.pairWithService(SAT_FP, '123456')).toEqual({ success: false, error: expect.stringMatching(/certificate code first/) });
      expect(posted).toHaveLength(0);
      expect(await annexClient.probeService(SAT_FP)).toEqual({ success: true, certFingerprint: CERT_COLONS });
      expect((await annexClient.pairWithService(SAT_FP, '123456')).success).toBe(true);
      expect(posted[0].url).toBe('https://192.168.1.60:9443/pair');
      expect(annexTls.createPinnedTlsClientOptions).toHaveBeenCalledWith(LOCAL_IDENTITY, { certPem: 'PROBED-PEM', fingerprint: CERT_COLONS });
      expect(annexClient.getDiscoveredServices()).toHaveLength(0);
    });
  });

});
