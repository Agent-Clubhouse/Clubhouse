import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useUpdateStore, initUpdateListener } from './updateStore';

// Mock window.clubhouse API
const mockGetUpdateSettings = vi.fn();
const mockSaveUpdateSettings = vi.fn();
const mockCheckForUpdates = vi.fn();
const mockGetUpdateStatus = vi.fn();
const mockApplyUpdate = vi.fn();
const mockOnUpdateStatusChanged = vi.fn();

Object.defineProperty(globalThis, 'window', {
  value: {
    clubhouse: {
      app: {
        getUpdateSettings: mockGetUpdateSettings,
        saveUpdateSettings: mockSaveUpdateSettings,
        checkForUpdates: mockCheckForUpdates,
        getUpdateStatus: mockGetUpdateStatus,
        applyUpdate: mockApplyUpdate,
        onUpdateStatusChanged: mockOnUpdateStatusChanged,
      },
    },
  },
  writable: true,
});

describe('updateStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUpdateStore.setState({
      status: {
        state: 'idle',
        availableVersion: null,
        releaseNotes: null,
        downloadProgress: 0,
        error: null,
        downloadPath: null,
      },
      settings: {
        autoUpdate: true,
        lastCheck: null,
        dismissedVersion: null,
      },
      dismissed: false,
    });
  });

  describe('initial state', () => {
    it('defaults to idle state', () => {
      const { status } = useUpdateStore.getState();
      expect(status.state).toBe('idle');
    });

    it('defaults to auto-update enabled', () => {
      const { settings } = useUpdateStore.getState();
      expect(settings.autoUpdate).toBe(true);
    });

    it('defaults to not dismissed', () => {
      const { dismissed } = useUpdateStore.getState();
      expect(dismissed).toBe(false);
    });
  });

  describe('loadSettings', () => {
    it('loads settings and status from IPC', async () => {
      mockGetUpdateSettings.mockResolvedValue({
        autoUpdate: false,
        lastCheck: '2026-02-17T00:00:00Z',
        dismissedVersion: '0.26.0',
      });
      mockGetUpdateStatus.mockResolvedValue({
        state: 'ready',
        availableVersion: '0.27.0',
        releaseNotes: 'Bug fixes',
        downloadProgress: 100,
        error: null,
        downloadPath: '/tmp/update.zip',
      });

      await useUpdateStore.getState().loadSettings();

      const state = useUpdateStore.getState();
      expect(state.settings.autoUpdate).toBe(false);
      expect(state.settings.lastCheck).toBe('2026-02-17T00:00:00Z');
      expect(state.status.state).toBe('ready');
      expect(state.status.availableVersion).toBe('0.27.0');
    });

    it('keeps defaults on API error', async () => {
      mockGetUpdateSettings.mockRejectedValue(new Error('IPC failed'));
      mockGetUpdateStatus.mockRejectedValue(new Error('IPC failed'));

      await useUpdateStore.getState().loadSettings();

      const state = useUpdateStore.getState();
      expect(state.settings.autoUpdate).toBe(true);
      expect(state.status.state).toBe('idle');
    });

    it('handles null settings response', async () => {
      mockGetUpdateSettings.mockResolvedValue(null);
      mockGetUpdateStatus.mockResolvedValue(null);

      await useUpdateStore.getState().loadSettings();

      const state = useUpdateStore.getState();
      expect(state.settings.autoUpdate).toBe(true);
      expect(state.status.state).toBe('idle');
    });
  });

  describe('saveSettings', () => {
    it('updates local state and calls IPC', async () => {
      mockSaveUpdateSettings.mockResolvedValue(undefined);

      const newSettings = {
        autoUpdate: false,
        lastCheck: '2026-02-17T12:00:00Z',
        dismissedVersion: null,
      };

      await useUpdateStore.getState().saveSettings(newSettings);

      expect(useUpdateStore.getState().settings.autoUpdate).toBe(false);
      expect(mockSaveUpdateSettings).toHaveBeenCalledWith(newSettings);
    });
  });

  describe('checkForUpdates', () => {
    it('calls IPC and updates status', async () => {
      const newStatus = {
        state: 'ready' as const,
        availableVersion: '0.26.0',
        releaseNotes: 'New features',
        downloadProgress: 100,
        error: null,
        downloadPath: '/tmp/update.zip',
      };
      mockCheckForUpdates.mockResolvedValue(newStatus);

      await useUpdateStore.getState().checkForUpdates();

      const state = useUpdateStore.getState();
      expect(state.status.state).toBe('ready');
      expect(state.status.availableVersion).toBe('0.26.0');
      expect(state.dismissed).toBe(false);
    });

    it('resets dismissed flag on check', async () => {
      useUpdateStore.setState({ dismissed: true });
      mockCheckForUpdates.mockResolvedValue({
        state: 'idle',
        availableVersion: null,
        releaseNotes: null,
        downloadProgress: 0,
        error: null,
        downloadPath: null,
      });

      await useUpdateStore.getState().checkForUpdates();

      expect(useUpdateStore.getState().dismissed).toBe(false);
    });
  });

  describe('dismiss', () => {
    it('sets dismissed to true', () => {
      useUpdateStore.getState().dismiss();
      expect(useUpdateStore.getState().dismissed).toBe(true);
    });
  });

  describe('applyUpdate', () => {
    it('calls IPC applyUpdate', async () => {
      mockApplyUpdate.mockResolvedValue(undefined);

      await useUpdateStore.getState().applyUpdate();

      expect(mockApplyUpdate).toHaveBeenCalled();
    });
  });

  describe('initUpdateListener', () => {
    it('subscribes to status change events', () => {
      const unsubscribe = vi.fn();
      mockOnUpdateStatusChanged.mockReturnValue(unsubscribe);

      const cleanup = initUpdateListener();

      expect(mockOnUpdateStatusChanged).toHaveBeenCalledWith(expect.any(Function));
      expect(typeof cleanup).toBe('function');
    });

    it('updates store when status event fires', () => {
      let callback: ((status: any) => void) | null = null;
      mockOnUpdateStatusChanged.mockImplementation((cb: any) => {
        callback = cb;
        return vi.fn();
      });

      initUpdateListener();

      // Simulate a status change event
      callback!({
        state: 'ready',
        availableVersion: '0.26.0',
        releaseNotes: 'Bug fixes',
        downloadProgress: 100,
        error: null,
        downloadPath: '/tmp/update.zip',
      });

      const state = useUpdateStore.getState();
      expect(state.status.state).toBe('ready');
      expect(state.status.availableVersion).toBe('0.26.0');
    });

    it('un-dismisses when status becomes ready', () => {
      useUpdateStore.setState({ dismissed: true });

      let callback: ((status: any) => void) | null = null;
      mockOnUpdateStatusChanged.mockImplementation((cb: any) => {
        callback = cb;
        return vi.fn();
      });

      initUpdateListener();

      callback!({
        state: 'ready',
        availableVersion: '0.26.0',
        releaseNotes: null,
        downloadProgress: 100,
        error: null,
        downloadPath: '/tmp/update.zip',
      });

      expect(useUpdateStore.getState().dismissed).toBe(false);
    });

    it('returns cleanup function that is the IPC unsubscribe', () => {
      const unsubscribe = vi.fn();
      mockOnUpdateStatusChanged.mockReturnValue(unsubscribe);

      const cleanup = initUpdateListener();
      cleanup();

      // cleanup IS the unsubscribe function returned by onUpdateStatusChanged
      expect(unsubscribe).toHaveBeenCalledTimes(1);
    });
  });
});
