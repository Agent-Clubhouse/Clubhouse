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
  clipboardImage: vi.fn(),
  ptyResize: vi.fn(),
  ptyGetBuffer: vi.fn(async () => ''),
  ptySpawnShell: vi.fn(async () => {}),
  agentSpawn: vi.fn(),
  agentKill: vi.fn(),
  agentWake: vi.fn(),
  agentCreateDurable: vi.fn(async () => ({})),
  agentDeleteDurable: vi.fn(async () => ({})),
  agentWorktreeStatus: vi.fn(async () => ({})),
  agentReorder: vi.fn(),
  fileTree: vi.fn(async () => []),
  fileRead: vi.fn(async () => ''),
  gitOperation: vi.fn(async () => ({})),
  sessionList: vi.fn(async () => ({})),
  sessionTranscript: vi.fn(async () => ({})),
  sessionSummary: vi.fn(async () => ({})),
  canvasMutation: vi.fn(async () => {}),
  forgetSatellite: vi.fn(),
  forgetAllSatellites: vi.fn(),
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

    it('forwards pty:data events to satellitePtyDataBus', async () => {
      const { satellitePtyDataBus } = await import('./annexClientStore');
      let eventCallback: ((event: any) => void) | undefined;
      mockAnnexClient.onSatelliteEvent.mockImplementationOnce((cb: any) => {
        eventCallback = cb;
        return vi.fn();
      });

      initAnnexClientListener();

      const received: any[] = [];
      const unsub = satellitePtyDataBus.on((satId, agentId, data) => {
        received.push({ satId, agentId, data });
      });

      eventCallback!({ satelliteId: 'sat-1', type: 'pty:data', payload: { agentId: 'agent-1', data: 'hello world' } });

      expect(received).toHaveLength(1);
      expect(received[0]).toEqual({ satId: 'sat-1', agentId: 'agent-1', data: 'hello world' });
      unsub();
    });

    it('forwards agent:woken events to updateRemoteAgentRunState', async () => {
      const { useRemoteProjectStore } = await import('./remoteProjectStore');
      const spy = vi.spyOn(useRemoteProjectStore.getState(), 'updateRemoteAgentRunState');

      let eventCallback: ((event: any) => void) | undefined;
      mockAnnexClient.onSatelliteEvent.mockImplementationOnce((cb: any) => {
        eventCallback = cb;
        return vi.fn();
      });

      initAnnexClientListener();
      eventCallback!({ satelliteId: 'sat-1', type: 'agent:woken', payload: { agentId: 'agent-1' } });

      expect(spy).toHaveBeenCalledWith('sat-1', 'agent-1', 'running');
      spy.mockRestore();
    });

    it('forwards pty:exit events to updateRemoteAgentRunState as sleeping', async () => {
      const { useRemoteProjectStore } = await import('./remoteProjectStore');
      const spy = vi.spyOn(useRemoteProjectStore.getState(), 'updateRemoteAgentRunState');

      let eventCallback: ((event: any) => void) | undefined;
      mockAnnexClient.onSatelliteEvent.mockImplementationOnce((cb: any) => {
        eventCallback = cb;
        return vi.fn();
      });

      initAnnexClientListener();
      eventCallback!({ satelliteId: 'sat-1', type: 'pty:exit', payload: { agentId: 'agent-1', exitCode: 0 } });

      expect(spy).toHaveBeenCalledWith('sat-1', 'agent-1', 'sleeping');
      spy.mockRestore();
    });

    it('forwards hook:event detailedStatus to updateRemoteAgentStatus', async () => {
      const { useRemoteProjectStore } = await import('./remoteProjectStore');
      const spy = vi.spyOn(useRemoteProjectStore.getState(), 'updateRemoteAgentStatus');

      let eventCallback: ((event: any) => void) | undefined;
      mockAnnexClient.onSatelliteEvent.mockImplementationOnce((cb: any) => {
        eventCallback = cb;
        return vi.fn();
      });

      initAnnexClientListener();
      const detailedStatus = { state: 'working', message: 'Running Bash', timestamp: 1000 };
      eventCallback!({ satelliteId: 'sat-1', type: 'hook:event', payload: { agentId: 'agent-1', event: {}, detailedStatus } });

      expect(spy).toHaveBeenCalledWith('sat-1', 'agent-1', detailedStatus);
      spy.mockRestore();
    });

    it('ignores hook:event without detailedStatus', async () => {
      const { useRemoteProjectStore } = await import('./remoteProjectStore');
      const spy = vi.spyOn(useRemoteProjectStore.getState(), 'updateRemoteAgentStatus');

      let eventCallback: ((event: any) => void) | undefined;
      mockAnnexClient.onSatelliteEvent.mockImplementationOnce((cb: any) => {
        eventCallback = cb;
        return vi.fn();
      });

      initAnnexClientListener();
      eventCallback!({ satelliteId: 'sat-1', type: 'hook:event', payload: { agentId: 'agent-1', event: {} } });

      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it('forwards structured:event detailedStatus to updateRemoteAgentStatus', async () => {
      const { useRemoteProjectStore } = await import('./remoteProjectStore');
      const spy = vi.spyOn(useRemoteProjectStore.getState(), 'updateRemoteAgentStatus');

      let eventCallback: ((event: any) => void) | undefined;
      mockAnnexClient.onSatelliteEvent.mockImplementationOnce((cb: any) => {
        eventCallback = cb;
        return vi.fn();
      });

      initAnnexClientListener();
      const detailedStatus = { state: 'working', message: 'Editing file', toolName: 'Edit', timestamp: 2000 };
      eventCallback!({ satelliteId: 'sat-1', type: 'structured:event', payload: { agentId: 'agent-1', event: {}, detailedStatus } });

      expect(spy).toHaveBeenCalledWith('sat-1', 'agent-1', detailedStatus);
      spy.mockRestore();
    });
  });

  // -------------------------------------------------------------------------
  // session:paused / session:resumed events
  // -------------------------------------------------------------------------

  describe('session pause/resume events', () => {
    it('sets satellitePaused to true on session:paused', () => {
      let eventCallback: ((event: any) => void) | undefined;
      mockAnnexClient.onSatelliteEvent.mockImplementationOnce((cb: any) => {
        eventCallback = cb;
        return vi.fn();
      });

      initAnnexClientListener();
      eventCallback!({ satelliteId: 'sat-1', type: 'session:paused', payload: { paused: true } });

      expect(getState().satellitePaused['sat-1']).toBe(true);
    });

    it('sets satellitePaused to false on session:resumed', () => {
      useAnnexClientStore.setState({ satellitePaused: { 'sat-1': true } });

      let eventCallback: ((event: any) => void) | undefined;
      mockAnnexClient.onSatelliteEvent.mockImplementationOnce((cb: any) => {
        eventCallback = cb;
        return vi.fn();
      });

      initAnnexClientListener();
      eventCallback!({ satelliteId: 'sat-1', type: 'session:resumed', payload: { paused: false } });

      expect(getState().satellitePaused['sat-1']).toBe(false);
    });

    it('clears stale paused state when snapshot arrives with sessionPaused=false', () => {
      // Simulate stale paused state from a previous connection
      useAnnexClientStore.setState({
        satellitePaused: { 'sat-1': true },
        satellites: [SATELLITE],
      });

      let eventCallback: ((event: any) => void) | undefined;
      mockAnnexClient.onSatelliteEvent.mockImplementationOnce((cb: any) => {
        eventCallback = cb;
        return vi.fn();
      });

      initAnnexClientListener();
      eventCallback!({
        satelliteId: 'sat-1',
        type: 'snapshot',
        payload: { projects: [], agents: {}, quickAgents: {}, theme: {}, orchestrators: {}, pendingPermissions: [], lastSeq: 0, sessionPaused: false },
      });

      expect(getState().satellitePaused['sat-1']).toBe(false);
    });

    it('preserves paused state when snapshot arrives with sessionPaused=true', () => {
      useAnnexClientStore.setState({
        satellitePaused: {},
        satellites: [SATELLITE],
      });

      let eventCallback: ((event: any) => void) | undefined;
      mockAnnexClient.onSatelliteEvent.mockImplementationOnce((cb: any) => {
        eventCallback = cb;
        return vi.fn();
      });

      initAnnexClientListener();
      eventCallback!({
        satelliteId: 'sat-1',
        type: 'snapshot',
        payload: { projects: [], agents: {}, quickAgents: {}, theme: {}, orchestrators: {}, pendingPermissions: [], lastSeq: 0, sessionPaused: true },
      });

      expect(getState().satellitePaused['sat-1']).toBe(true);
    });

    it('defaults to unpaused when snapshot has no sessionPaused field', () => {
      useAnnexClientStore.setState({
        satellitePaused: { 'sat-1': true },
        satellites: [SATELLITE],
      });

      let eventCallback: ((event: any) => void) | undefined;
      mockAnnexClient.onSatelliteEvent.mockImplementationOnce((cb: any) => {
        eventCallback = cb;
        return vi.fn();
      });

      initAnnexClientListener();
      eventCallback!({
        satelliteId: 'sat-1',
        type: 'snapshot',
        payload: { projects: [], agents: {}, quickAgents: {}, theme: {}, orchestrators: {}, pendingPermissions: [], lastSeq: 0 },
      });

      expect(getState().satellitePaused['sat-1']).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // sendAgentWake
  // -------------------------------------------------------------------------

  describe('sendAgentWake', () => {
    it('delegates to IPC agentWake with no options', async () => {
      await getState().sendAgentWake('sat-1', 'agent-1');
      expect(mockAnnexClient.agentWake).toHaveBeenCalledWith('sat-1', 'agent-1', undefined);
    });

    it('delegates to IPC agentWake with resume option', async () => {
      await getState().sendAgentWake('sat-1', 'agent-1', { resume: true });
      expect(mockAnnexClient.agentWake).toHaveBeenCalledWith('sat-1', 'agent-1', { resume: true });
    });

    it('delegates to IPC agentWake with mission option', async () => {
      await getState().sendAgentWake('sat-1', 'agent-1', { mission: 'do something' });
      expect(mockAnnexClient.agentWake).toHaveBeenCalledWith('sat-1', 'agent-1', { mission: 'do something' });
    });

    it('swallows IPC errors', async () => {
      mockAnnexClient.agentWake.mockRejectedValueOnce(new Error('IPC failed'));
      await expect(getState().sendAgentWake('sat-1', 'agent-1')).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // satellitePtyDataBus
  // -------------------------------------------------------------------------

  describe('satellitePtyDataBus', () => {
    it('emits to all registered listeners', async () => {
      const { satellitePtyDataBus } = await import('./annexClientStore');
      const listener1 = vi.fn();
      const listener2 = vi.fn();

      const unsub1 = satellitePtyDataBus.on(listener1);
      const unsub2 = satellitePtyDataBus.on(listener2);

      satellitePtyDataBus.emit('sat-1', 'agent-1', 'hello');

      expect(listener1).toHaveBeenCalledWith('sat-1', 'agent-1', 'hello');
      expect(listener2).toHaveBeenCalledWith('sat-1', 'agent-1', 'hello');

      unsub1();
      unsub2();
    });

    it('unsubscribe stops listener from receiving', async () => {
      const { satellitePtyDataBus } = await import('./annexClientStore');
      const listener = vi.fn();
      const unsub = satellitePtyDataBus.on(listener);

      unsub();
      satellitePtyDataBus.emit('sat-1', 'agent-1', 'hello');

      expect(listener).not.toHaveBeenCalled();
    });
  });
});
