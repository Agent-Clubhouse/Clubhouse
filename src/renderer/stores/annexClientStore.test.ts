/**
 * Tests for the Annex V2 Client Zustand store — discovered services, pairing,
 * satellites, and IPC listener wiring.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---------- IPC mock ----------
const mockAnnexClient = {
  getSatellites: vi.fn(async () => []),
  getDiscovered: vi.fn(async () => []),
  pairWith: vi.fn(async () => ({ success: true })),
  connect: vi.fn(),
  disconnect: vi.fn(),
  retry: vi.fn(),
  scan: vi.fn(),
  ptyInput: vi.fn(),
  ptyResize: vi.fn(),
  agentSpawn: vi.fn(),
  agentKill: vi.fn(),
  onSatellitesChanged: vi.fn(() => vi.fn()),
  onDiscoveredChanged: vi.fn(() => vi.fn()),
  onSatelliteEvent: vi.fn(() => vi.fn()),
};

Object.defineProperty(globalThis, 'window', {
  value: {
    clubhouse: {
      annex: {},
      annexClient: mockAnnexClient,
    },
  },
  writable: true,
});

import {
  useAnnexClientStore,
  initAnnexClientListener,
  type DiscoveredService,
  type SatelliteConnection,
} from './annexClientStore';

// ---------- helpers ----------
function getState() {
  return useAnnexClientStore.getState();
}

const DISCOVERED_SERVICE: DiscoveredService = {
  fingerprint: 'XX:YY:ZZ:11',
  alias: 'Remote Mac',
  icon: 'laptop',
  color: 'blue',
  host: 'remote.local',
  mainPort: 9000,
  pairingPort: 9001,
  publicKey: 'remote-pub-key',
};

const SATELLITE: SatelliteConnection = {
  id: 'PP:QQ:RR:SS',
  alias: 'Paired Mac',
  icon: 'server',
  color: 'green',
  fingerprint: 'PP:QQ:RR:SS',
  state: 'connected',
  host: 'paired.local',
  mainPort: 8000,
  pairingPort: 8001,
  snapshot: null,
  lastError: null,
};

// ---------- tests ----------
describe('annexClientStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAnnexClientStore.setState({
      satellites: [],
      discoveredServices: [],
    });
  });

  describe('initialization', () => {
    it('has empty satellites and discoveredServices by default', () => {
      expect(getState().satellites).toEqual([]);
      expect(getState().discoveredServices).toEqual([]);
    });
  });

  describe('loadSatellites', () => {
    it('loads satellites from IPC', async () => {
      mockAnnexClient.getSatellites.mockResolvedValueOnce([SATELLITE]);
      await getState().loadSatellites();
      expect(getState().satellites).toEqual([SATELLITE]);
    });

    it('keeps empty on error', async () => {
      mockAnnexClient.getSatellites.mockRejectedValueOnce(new Error('ipc failed'));
      await getState().loadSatellites();
      expect(getState().satellites).toEqual([]);
    });
  });

  describe('loadDiscovered', () => {
    it('loads discovered services from IPC', async () => {
      mockAnnexClient.getDiscovered.mockResolvedValueOnce([DISCOVERED_SERVICE]);
      await getState().loadDiscovered();
      expect(getState().discoveredServices).toEqual([DISCOVERED_SERVICE]);
    });

    it('keeps empty on error', async () => {
      mockAnnexClient.getDiscovered.mockRejectedValueOnce(new Error('ipc failed'));
      await getState().loadDiscovered();
      expect(getState().discoveredServices).toEqual([]);
    });
  });

  describe('pairWith', () => {
    it('delegates to IPC and returns result', async () => {
      mockAnnexClient.pairWith.mockResolvedValueOnce({ success: true });
      const result = await getState().pairWith('XX:YY:ZZ:11', '123456');
      expect(mockAnnexClient.pairWith).toHaveBeenCalledWith('XX:YY:ZZ:11', '123456');
      expect(result).toEqual({ success: true });
    });

    it('returns error on IPC failure', async () => {
      mockAnnexClient.pairWith.mockRejectedValueOnce(new Error('boom'));
      const result = await getState().pairWith('XX:YY:ZZ:11', '123456');
      expect(result).toEqual({ success: false, error: 'IPC error' });
    });
  });

  describe('scan', () => {
    it('delegates to IPC', async () => {
      await getState().scan();
      expect(mockAnnexClient.scan).toHaveBeenCalled();
    });
  });

  describe('initAnnexClientListener', () => {
    it('registers satellite, discovered, and event listeners', () => {
      initAnnexClientListener();

      expect(mockAnnexClient.onSatellitesChanged).toHaveBeenCalledTimes(1);
      expect(mockAnnexClient.onDiscoveredChanged).toHaveBeenCalledTimes(1);
      expect(mockAnnexClient.onSatelliteEvent).toHaveBeenCalledTimes(1);
    });

    it('updates satellites state when satellites change', () => {
      let callback: ((sats: SatelliteConnection[]) => void) | undefined;
      mockAnnexClient.onSatellitesChanged.mockImplementationOnce((cb: any) => {
        callback = cb;
        return vi.fn();
      });

      initAnnexClientListener();
      callback!([SATELLITE]);

      expect(getState().satellites).toEqual([SATELLITE]);
    });

    it('updates discoveredServices state when discovered changes', () => {
      let callback: ((services: DiscoveredService[]) => void) | undefined;
      mockAnnexClient.onDiscoveredChanged.mockImplementationOnce((cb: any) => {
        callback = cb;
        return vi.fn();
      });

      initAnnexClientListener();
      callback!([DISCOVERED_SERVICE]);

      expect(getState().discoveredServices).toEqual([DISCOVERED_SERVICE]);
    });

    it('returns a cleanup function that unsubscribes all listeners', () => {
      const unsubSatellites = vi.fn();
      const unsubDiscovered = vi.fn();
      const unsubEvents = vi.fn();
      mockAnnexClient.onSatellitesChanged.mockReturnValueOnce(unsubSatellites);
      mockAnnexClient.onDiscoveredChanged.mockReturnValueOnce(unsubDiscovered);
      mockAnnexClient.onSatelliteEvent.mockReturnValueOnce(unsubEvents);

      const cleanup = initAnnexClientListener();
      cleanup();

      expect(unsubSatellites).toHaveBeenCalled();
      expect(unsubDiscovered).toHaveBeenCalled();
      expect(unsubEvents).toHaveBeenCalled();
    });
  });
});
