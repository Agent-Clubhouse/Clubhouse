import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AnnexSettings, AnnexStatus } from '../../shared/types';

// ---------- IPC mock ----------
const mockAnnex = {
  getSettings: vi.fn<() => Promise<AnnexSettings>>(),
  saveSettings: vi.fn().mockResolvedValue(undefined),
  getStatus: vi.fn<() => Promise<AnnexStatus>>(),
  regeneratePin: vi.fn<() => Promise<AnnexStatus>>(),
  onStatusChanged: vi.fn<(cb: (status: AnnexStatus) => void) => () => void>(),
};

Object.defineProperty(globalThis, 'window', {
  value: { clubhouse: { annex: mockAnnex } },
  writable: true,
});

import { useAnnexStore, initAnnexListener } from './annexStore';

// ---------- helpers ----------
function getState() {
  return useAnnexStore.getState();
}

const DEFAULT_SETTINGS: AnnexSettings = { enabled: false, deviceName: '' };
const DEFAULT_STATUS: AnnexStatus = { advertising: false, port: 0, pin: '', connectedCount: 0 };

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
      const settings: AnnexSettings = { enabled: true, deviceName: 'laptop' };
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
      const settings: AnnexSettings = { enabled: true, deviceName: 'tablet' };

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
});
