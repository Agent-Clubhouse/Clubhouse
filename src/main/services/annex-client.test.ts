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
  getPeer: vi.fn().mockReturnValue(undefined),
  addPeer: vi.fn(),
  updateLastSeen: vi.fn(),
  removePeer: vi.fn(),
  removeAllPeers: vi.fn(),
}));

vi.mock('./annex-settings', () => ({
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
    it('disconnects all, removes all peers, and clears all state', async () => {
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

      annexClient.forgetAllSatellites();

      expect(annexClient.getSatellites()).toHaveLength(0);
      expect(annexClient.getDiscoveredServices()).toHaveLength(0);
      expect(annexPeers.removeAllPeers).toHaveBeenCalled();
    });
  });

  // ---- mTLS reconnection (no bearer token required) ----

  describe('mTLS reconnection', () => {
    it('attempts connection for discovered paired satellite without bearer token', async () => {
      // Track if WebSocket was constructed (= connection attempted)
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

      // Key assertion: WebSocket constructor was called (connection was attempted)
      // even though there's no bearer token — mTLS handles auth
      expect(WsMock).toHaveBeenCalled();
      const wsUrl = vi.mocked(WsMock).mock.calls[0][0] as string;
      // URL should NOT contain token param (no bearer token)
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

      // Force disconnect
      annexClient.disconnect('PP:QQ:RR:SS');
      expect(annexClient.getSatellites()[0].state).toBe('disconnected');

      // Retry should attempt connection again (WebSocket constructor called again)
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

    it('auto-connects to legacy peers without role (backward compat)', async () => {
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

      annexClient.startClient();
      await bonjourFindCallback!(makeService());

      // Should connect (backward compat: no role = satellite)
      expect(annexClient.getSatellites()).toHaveLength(1);
      expect(WsMock).toHaveBeenCalled();
    });

    it('pairWithService stores peer with role "satellite"', async () => {
      mockHttpGetIdentity({
        fingerprint: 'NEW:PEER',
        alias: 'New Satellite',
        icon: 'server',
        color: 'green',
        publicKey: 'new-pub-key',
      });

      // We need to first discover the service
      annexClient.startClient();
      await bonjourFindCallback!(makeService());

      // Now pair with the discovered service
      const discoveredAfter = annexClient.getDiscoveredServices();
      if (discoveredAfter.length > 0) {
        // Mock HTTP POST for pairing
        const http = await import('http');
        vi.spyOn(http, 'request').mockImplementation(((_opts: any, cb: any) => {
          const res = {
            statusCode: 200,
            on: (event: string, handler: any) => {
              if (event === 'data') handler(JSON.stringify({ token: 'test-token' }));
              if (event === 'end') handler();
            },
          };
          cb(res);
          return { on: vi.fn(), setTimeout: vi.fn(), write: vi.fn(), end: vi.fn() };
        }) as any);

        await annexClient.pairWithService(discoveredAfter[0].fingerprint, '123456');

        expect(annexPeers.addPeer).toHaveBeenCalledWith(
          expect.objectContaining({
            role: 'satellite',
          }),
        );
      }
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
      expect(satsAfter[0].lastError).toBe('Heartbeat ping failed');

      vi.useRealTimers();
    });
  });
});
