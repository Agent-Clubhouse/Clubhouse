import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AnnexPeerListing, AnnexSettings, AnnexStatus } from '../../shared/types';

// ---------- IPC mock ----------
const mockAnnex = {
  getSettings: vi.fn<() => Promise<AnnexSettings>>(),
  saveSettings: vi.fn().mockResolvedValue(undefined),
  getStatus: vi.fn<() => Promise<AnnexStatus>>(),
  regeneratePin: vi.fn<() => Promise<AnnexStatus>>(),
  onStatusChanged: vi.fn<(cb: (status: AnnexStatus) => void) => () => void>(),
  listPeers: vi.fn<() => Promise<AnnexPeerListing[]>>(),
  removePeer: vi.fn<(fingerprint: string) => Promise<boolean>>(),
  onPeersChanged: vi.fn<(cb: (peers: AnnexPeerListing[]) => void) => () => void>(),
};

Object.defineProperty(globalThis, 'window', {
  value: { clubhouse: { annex: mockAnnex, annexClient: {} } },
  writable: true,
});

import { useAnnexStore, initAnnexListener, subscribeAnnexPeers } from './annexStore';

// ---------- helpers ----------
function getState() {
  return useAnnexStore.getState();
}

const DEFAULT_SETTINGS: AnnexSettings = { enableServer: false, enableClient: false, loopbackOnly: false, deviceName: '', alias: '', icon: 'computer', color: 'indigo', autoReconnect: true };
const DEFAULT_STATUS: AnnexStatus = { advertising: false, port: 0, pin: '', connectedCount: 0, fingerprint: '', alias: '', icon: 'computer', color: 'indigo' };

// ---------- tests ----------
describe('annexStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAnnexStore.setState({
      settings: { ...DEFAULT_SETTINGS },
      status: { ...DEFAULT_STATUS },
    });
  });

  // ---- defaults ----
  describe('initialization', () => {
    it('has correct default settings', () => {
      expect(getState().settings).toEqual(DEFAULT_SETTINGS);
    });

    it('has correct default status', () => {
      expect(getState().status).toEqual(DEFAULT_STATUS);
    });
  });

  // ---- loadSettings ----
  describe('loadSettings', () => {
    it('loads both settings and status from IPC', async () => {
      const settings: AnnexSettings = { enableServer: true, enableClient: false, deviceName: 'laptop' };
      const status: AnnexStatus = { advertising: true, port: 8080, pin: '1234', connectedCount: 2 };
      mockAnnex.getSettings.mockResolvedValueOnce(settings);
      mockAnnex.getStatus.mockResolvedValueOnce(status);

      await getState().loadSettings();

      expect(getState().settings).toEqual(settings);
      expect(getState().status).toEqual(status);
    });

    it('uses defaults when IPC returns null', async () => {
      mockAnnex.getSettings.mockResolvedValueOnce(null as unknown as AnnexSettings);
      mockAnnex.getStatus.mockResolvedValueOnce(null as unknown as AnnexStatus);

      await getState().loadSettings();

      expect(getState().settings).toEqual(DEFAULT_SETTINGS);
      expect(getState().status).toEqual(DEFAULT_STATUS);
    });

    it('keeps defaults on error', async () => {
      mockAnnex.getSettings.mockRejectedValueOnce(new Error('ipc failed'));

      await getState().loadSettings();

      expect(getState().settings).toEqual(DEFAULT_SETTINGS);
      expect(getState().status).toEqual(DEFAULT_STATUS);
    });
  });

  // ---- saveSettings ----
  describe('saveSettings', () => {
    it('optimistically updates settings in state', async () => {
      const settings: AnnexSettings = { enableServer: true, enableClient: false, deviceName: 'tablet' };

      await getState().saveSettings(settings);

      expect(getState().settings).toEqual(settings);
      expect(mockAnnex.saveSettings).toHaveBeenCalledWith(settings);
    });
  });

  // ---- loadStatus ----
  describe('loadStatus', () => {
    it('loads status from IPC', async () => {
      const status: AnnexStatus = { advertising: true, port: 9090, pin: 'abcd', connectedCount: 1 };
      mockAnnex.getStatus.mockResolvedValueOnce(status);

      await getState().loadStatus();

      expect(getState().status).toEqual(status);
    });

    it('uses defaults when IPC returns null', async () => {
      mockAnnex.getStatus.mockResolvedValueOnce(null as unknown as AnnexStatus);

      await getState().loadStatus();

      expect(getState().status).toEqual(DEFAULT_STATUS);
    });

    it('keeps defaults on error', async () => {
      mockAnnex.getStatus.mockRejectedValueOnce(new Error('ipc failed'));

      await getState().loadStatus();

      expect(getState().status).toEqual(DEFAULT_STATUS);
    });
  });

  // ---- regeneratePin ----
  describe('regeneratePin', () => {
    it('updates status from IPC response', async () => {
      const newStatus: AnnexStatus = { advertising: true, port: 8080, pin: 'new-pin', connectedCount: 0 };
      mockAnnex.regeneratePin.mockResolvedValueOnce(newStatus);

      await getState().regeneratePin();

      expect(getState().status).toEqual(newStatus);
    });

    it('uses defaults when IPC returns null', async () => {
      mockAnnex.regeneratePin.mockResolvedValueOnce(null as unknown as AnnexStatus);

      await getState().regeneratePin();

      expect(getState().status).toEqual(DEFAULT_STATUS);
    });

    it('keeps current state on error', async () => {
      const currentStatus: AnnexStatus = { advertising: true, port: 5000, pin: 'keep', connectedCount: 3 };
      useAnnexStore.setState({ status: currentStatus });
      mockAnnex.regeneratePin.mockRejectedValueOnce(new Error('failed'));

      await getState().regeneratePin();

      // Error is caught, state remains unchanged
      expect(getState().status).toEqual(currentStatus);
    });
  });

  // ---- initAnnexListener ----
  describe('initAnnexListener', () => {
    it('registers a status change callback', () => {
      const unsub = vi.fn();
      mockAnnex.onStatusChanged.mockReturnValueOnce(unsub);

      const cleanup = initAnnexListener();

      expect(mockAnnex.onStatusChanged).toHaveBeenCalledTimes(1);
      expect(cleanup).toBe(unsub);
    });

    it('updates store state when status changes arrive', () => {
      let callback: ((status: AnnexStatus) => void) | undefined;
      mockAnnex.onStatusChanged.mockImplementationOnce((cb) => {
        callback = cb;
        return () => {};
      });

      initAnnexListener();

      const pushed: AnnexStatus = { advertising: true, port: 7070, pin: 'pushed', connectedCount: 5 };
      callback!(pushed);

      expect(getState().status).toEqual(pushed);
    });
  });

  // ---- peers ----
  describe('peers', () => {
    const PHONE: AnnexPeerListing = {
      fingerprint: 'fp-phone', publicKey: 'pk', alias: 'Phone', icon: 'phone', color: 'indigo',
      pairedAt: '2026-11-01T00:00:00Z', lastSeen: '2026-11-07T00:00:00Z', role: 'controller', needsPairing: false,
    };
    const LAPTOP: AnnexPeerListing = { ...PHONE, fingerprint: 'fp-laptop', alias: 'Laptop', needsPairing: true };

    beforeEach(() => {
      useAnnexStore.setState({ peers: [] });
    });

    it('loadPeers fills the list', async () => {
      mockAnnex.listPeers.mockResolvedValueOnce([PHONE, LAPTOP]);
      await getState().loadPeers();
      expect(getState().peers).toEqual([PHONE, LAPTOP]);
    });

    it('loadPeers keeps the list when IPC fails', async () => {
      useAnnexStore.setState({ peers: [PHONE] });
      mockAnnex.listPeers.mockRejectedValueOnce(new Error('fail'));
      await getState().loadPeers();
      expect(getState().peers).toEqual([PHONE]);
    });

    it('removePeer calls IPC and drops the row', async () => {
      useAnnexStore.setState({ peers: [PHONE, LAPTOP] });
      mockAnnex.removePeer.mockResolvedValueOnce(true);
      await getState().removePeer('fp-phone');
      expect(mockAnnex.removePeer).toHaveBeenCalledWith('fp-phone');
      expect(getState().peers).toEqual([LAPTOP]);
    });

    it('removePeer keeps the row when IPC fails', async () => {
      useAnnexStore.setState({ peers: [PHONE] });
      mockAnnex.removePeer.mockRejectedValueOnce(new Error('fail'));
      await getState().removePeer('fp-phone');
      expect(getState().peers).toEqual([PHONE]);
    });

    it('subscribeAnnexPeers applies broadcasts and returns the unsubscribe', () => {
      let callback: ((peers: AnnexPeerListing[]) => void) | undefined;
      const unsub = vi.fn();
      mockAnnex.onPeersChanged.mockImplementationOnce((cb) => {
        callback = cb;
        return unsub;
      });
      const cleanup = subscribeAnnexPeers();
      callback!([LAPTOP]);
      expect(getState().peers).toEqual([LAPTOP]);
      expect(cleanup).toBe(unsub);
    });
  });
});
