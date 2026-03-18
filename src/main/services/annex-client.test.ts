/**
 * Tests for the Annex V2 Client — discovery, pairing, and connection management.
 *
 * These tests exercise the public API surface of annex-client.ts with mocked
 * Bonjour, HTTP, and peer dependencies. The three root-cause bugs (startClient
 * never called, unpaired services dropped, no pairing flow) are each covered.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — set up before importing the module under test
// ---------------------------------------------------------------------------

const { mockBrowser, mockBonjourInstance, BonjourConstructor } = vi.hoisted(() => {
  const mockBrowser = { stop: vi.fn() };
  const mockBonjourInstance = {
    find: vi.fn(),
    destroy: vi.fn(),
  };
  const BonjourConstructor = vi.fn();
  return { mockBrowser, mockBonjourInstance, BonjourConstructor };
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

vi.mock('ws', () => ({
  WebSocket: Object.assign(vi.fn(), { OPEN: 1 }),
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
}));

vi.mock('./annex-tls', () => ({
  createTlsClientOptions: vi.fn().mockReturnValue({}),
}));

vi.mock('./annex-peers', () => ({
  isPairedPeer: vi.fn().mockReturnValue(false),
  getPeer: vi.fn().mockReturnValue(undefined),
  addPeer: vi.fn(),
  updateLastSeen: vi.fn(),
}));

vi.mock('./annex-settings', () => ({
  getSettings: vi.fn().mockReturnValue({
    enabled: true,
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

import * as annexClient from './annex-client';
import * as annexPeers from './annex-peers';
import * as annexIdentity from './annex-identity';
import * as annexSettings from './annex-settings';
import { broadcastToAllWindows } from '../util/ipc-broadcast';
import { IPC } from '../../shared/ipc-channels';
import * as http from 'http';

/** Reset all mock implementations after vi.clearAllMocks() */
function resetAllMocks() {
  resetBonjourMocks();
  vi.mocked(annexIdentity.getOrCreateIdentity).mockReturnValue(LOCAL_IDENTITY);
  vi.mocked(annexIdentity.getIdentity).mockReturnValue(LOCAL_IDENTITY);
  vi.mocked(annexPeers.isPairedPeer).mockReturnValue(false);
  vi.mocked(annexPeers.getPeer).mockReturnValue(undefined);
  vi.mocked(annexSettings.getSettings).mockReturnValue({
    enabled: true,
    deviceName: 'Test Mac',
    alias: 'Test Mac',
    icon: 'computer',
    color: 'indigo',
    autoReconnect: true,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeService(overrides: Record<string, any> = {}) {
  return {
    host: 'satellite.local',
    port: 9000,
    txt: { pairingPort: '9001' },
    referer: { address: '192.168.1.50' },
    ...overrides,
  };
}

/** Simulate httpGet returning an identity JSON */
function mockHttpGetIdentity(identity: Record<string, any>) {
  vi.mocked(http.get).mockImplementation((_url: any, cb: any) => {
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

/** Simulate httpPost returning a pairing response */
function mockHttpPostPairSuccess(token: string) {
  vi.mocked(http.request).mockImplementation((_opts: any, cb: any) => {
    const res = {
      statusCode: 200,
      on: vi.fn().mockImplementation((event: string, handler: any) => {
        if (event === 'data') handler(JSON.stringify({ token }));
        if (event === 'end') handler();
      }),
    };
    cb(res);
    return { on: vi.fn(), setTimeout: vi.fn(), write: vi.fn(), end: vi.fn() } as any;
  });
}

function mockHttpPostPairFailure(status: number, body: Record<string, any>) {
  vi.mocked(http.request).mockImplementation((_opts: any, cb: any) => {
    const res = {
      statusCode: status,
      on: vi.fn().mockImplementation((event: string, handler: any) => {
        if (event === 'data') handler(JSON.stringify(body));
        if (event === 'end') handler();
      }),
    };
    cb(res);
    return { on: vi.fn(), setTimeout: vi.fn(), write: vi.fn(), end: vi.fn() } as any;
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

  // ---- startClient / stopClient ----

  describe('startClient', () => {
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
      vi.mocked(annexPeers.isPairedPeer).mockReturnValue(false);

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
        host: 'satellite.local',
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
      vi.mocked(annexPeers.isPairedPeer).mockReturnValue(false);

      annexClient.startClient();
      await bonjourFindCallback!(makeService());
      expect(annexClient.getDiscoveredServices()[0].host).toBe('satellite.local');

      // Same fingerprint, different host
      await bonjourFindCallback!(makeService({ host: 'new-host.local', port: 9999 }));
      const discovered = annexClient.getDiscoveredServices();
      expect(discovered).toHaveLength(1);
      expect(discovered[0].host).toBe('new-host.local');
      expect(discovered[0].mainPort).toBe(9999);
    });
  });

  describe('discovery — paired services', () => {
    it('adds paired services to satellites', async () => {
      mockHttpGetIdentity({
        fingerprint: 'PP:QQ:RR:SS',
        alias: 'Paired Mac',
        icon: 'server',
        color: 'green',
        publicKey: 'paired-pub-key',
      });
      vi.mocked(annexPeers.isPairedPeer).mockReturnValue(true);
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
        state: 'discovering',
      });
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
      vi.mocked(annexPeers.isPairedPeer).mockReturnValue(false);
      annexClient.startClient();
      await bonjourFindCallback!(makeService());
      expect(annexClient.getDiscoveredServices()).toHaveLength(1);

      // Second discovery: now paired
      vi.mocked(annexPeers.isPairedPeer).mockReturnValue(true);
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
      vi.mocked(annexPeers.isPairedPeer).mockReturnValue(false);

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

  describe('pairWithService', () => {
    beforeEach(async () => {
      // Set up a discovered service first
      mockHttpGetIdentity({
        fingerprint: 'XX:YY:ZZ:11',
        alias: 'Remote Mac',
        icon: 'laptop',
        color: 'blue',
        publicKey: 'remote-pub-key',
      });
      vi.mocked(annexPeers.isPairedPeer).mockReturnValue(false);

      annexClient.startClient();
      await bonjourFindCallback!(makeService());
      expect(annexClient.getDiscoveredServices()).toHaveLength(1);
    });

    it('returns error when service is not found', async () => {
      const result = await annexClient.pairWithService('nonexistent', '123456');
      expect(result).toEqual({
        success: false,
        error: expect.stringContaining('not found'),
      });
    });

    it('POSTs to /pair with PIN and local identity, adds peer on success', async () => {
      mockHttpPostPairSuccess('bearer-token-123');

      const result = await annexClient.pairWithService('XX:YY:ZZ:11', '986136');

      expect(result).toEqual({ success: true });

      // Should have called addPeer
      expect(annexPeers.addPeer).toHaveBeenCalledWith(
        expect.objectContaining({
          fingerprint: 'XX:YY:ZZ:11',
          alias: 'Remote Mac',
          publicKey: 'remote-pub-key',
        }),
      );

      // Should remove from discovered
      expect(annexClient.getDiscoveredServices()).toHaveLength(0);

      // Should add to satellites
      const sats = annexClient.getSatellites();
      expect(sats).toHaveLength(1);
      expect(sats[0]).toMatchObject({
        fingerprint: 'XX:YY:ZZ:11',
        alias: 'Remote Mac',
      });
    });

    it('returns error on HTTP failure', async () => {
      mockHttpPostPairFailure(403, { error: 'Invalid PIN' });

      const result = await annexClient.pairWithService('XX:YY:ZZ:11', '000000');

      expect(result).toEqual({
        success: false,
        error: 'Invalid PIN',
      });

      // Should NOT add peer
      expect(annexPeers.addPeer).not.toHaveBeenCalled();

      // Service should still be in discovered
      expect(annexClient.getDiscoveredServices()).toHaveLength(1);
    });

    it('returns error on network failure', async () => {
      vi.mocked(http.request).mockImplementation((_opts: any, _cb: any) => {
        const req = {
          on: vi.fn().mockImplementation((event: string, handler: any) => {
            if (event === 'error') setTimeout(() => handler(new Error('ECONNREFUSED')), 0);
          }),
          setTimeout: vi.fn(),
          write: vi.fn(),
          end: vi.fn(),
        };
        return req as any;
      });

      const result = await annexClient.pairWithService('XX:YY:ZZ:11', '986136');

      expect(result).toEqual({
        success: false,
        error: 'ECONNREFUSED',
      });
    });

    it('broadcasts both DISCOVERED_CHANGED and SATELLITES_CHANGED on success', async () => {
      mockHttpPostPairSuccess('bearer-token-123');
      vi.mocked(broadcastToAllWindows).mockClear();

      await annexClient.pairWithService('XX:YY:ZZ:11', '986136');

      const channels = vi.mocked(broadcastToAllWindows).mock.calls.map((c) => c[0]);
      expect(channels).toContain(IPC.ANNEX_CLIENT.DISCOVERED_CHANGED);
      expect(channels).toContain(IPC.ANNEX_CLIENT.SATELLITES_CHANGED);
    });
  });

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
});
