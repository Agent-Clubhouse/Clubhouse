import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useUpdateStore, initUpdateListener, DISMISS_DURATION_MS } from './updateStore';

// Mock window.clubhouse API
const mockGetUpdateSettings = vi.fn();
const mockSaveUpdateSettings = vi.fn();
const mockCheckForUpdates = vi.fn();
const mockGetUpdateStatus = vi.fn();
const mockApplyUpdate = vi.fn();
const mockOnUpdateStatusChanged = vi.fn();
const mockGetVersion = vi.fn();
const mockGetPendingReleaseNotes = vi.fn();
const mockClearPendingReleaseNotes = vi.fn();

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
        getVersion: mockGetVersion,
        getPendingReleaseNotes: mockGetPendingReleaseNotes,
        clearPendingReleaseNotes: mockClearPendingReleaseNotes,
      },
    },
  },
  writable: true,
});

describe('updateStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetVersion.mockResolvedValue('0.27.0');
    mockGetPendingReleaseNotes.mockResolvedValue(null);
    mockClearPendingReleaseNotes.mockResolvedValue(undefined);
    useUpdateStore.setState({
      status: {
        state: 'idle',
        availableVersion: null,
        releaseNotes: null,
        releaseMessage: null,
        downloadProgress: 0,
        error: null,
        downloadPath: null,
      },
      settings: {
        autoUpdate: true,
        lastCheck: null,
        dismissedVersion: null,
        lastSeenVersion: null,
      },
      dismissed: false,
      whatsNew: null,
      showWhatsNew: false,
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

    it('defaults whatsNew to null', () => {
      const { whatsNew, showWhatsNew } = useUpdateStore.getState();
      expect(whatsNew).toBeNull();
      expect(showWhatsNew).toBe(false);
    });
  });

  describe('loadSettings', () => {
    it('loads settings and status from IPC', async () => {
      mockGetUpdateSettings.mockResolvedValue({
        autoUpdate: false,
        lastCheck: '2026-02-17T00:00:00Z',
        dismissedVersion: '0.26.0',
        lastSeenVersion: '0.25.0',
      });
      mockGetUpdateStatus.mockResolvedValue({
        state: 'ready',
        availableVersion: '0.27.0',
        releaseNotes: 'Bug fixes',
        releaseMessage: 'Bug Fixes & More',
        downloadProgress: 100,
        error: null,
        downloadPath: '/tmp/update.zip',
      });

      await useUpdateStore.getState().loadSettings();

      const state = useUpdateStore.getState();
      expect(state.settings.autoUpdate).toBe(false);
      expect(state.settings.lastCheck).toBe('2026-02-17T00:00:00Z');
      expect(state.settings.lastSeenVersion).toBe('0.25.0');
      expect(state.status.state).toBe('ready');
      expect(state.status.availableVersion).toBe('0.27.0');
      expect(state.status.releaseMessage).toBe('Bug Fixes & More');
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
        lastSeenVersion: '0.26.0',
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
        releaseMessage: 'New Features',
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
        releaseMessage: null,
        downloadProgress: 0,
        error: null,
        downloadPath: null,
      });

      await useUpdateStore.getState().checkForUpdates();

      expect(useUpdateStore.getState().dismissed).toBe(false);
    });
  });

  describe('dismiss', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('sets dismissed to true', () => {
      useUpdateStore.getState().dismiss();
      expect(useUpdateStore.getState().dismissed).toBe(true);
    });

    it('re-shows banner after 4 hours', () => {
      useUpdateStore.getState().dismiss();
      expect(useUpdateStore.getState().dismissed).toBe(true);

      // Advance just under 4 hours — should still be dismissed
      vi.advanceTimersByTime(DISMISS_DURATION_MS - 1000);
      expect(useUpdateStore.getState().dismissed).toBe(true);

      // Advance past 4 hours — should be un-dismissed
      vi.advanceTimersByTime(1000);
      expect(useUpdateStore.getState().dismissed).toBe(false);
    });

    it('resets timer on re-dismiss', () => {
      useUpdateStore.getState().dismiss();

      // Advance 2 hours
      vi.advanceTimersByTime(DISMISS_DURATION_MS / 2);
      expect(useUpdateStore.getState().dismissed).toBe(true);

      // Dismiss again — should restart the 4-hour timer
      useUpdateStore.getState().dismiss();

      // Advance another 2 hours (would have expired with original timer)
      vi.advanceTimersByTime(DISMISS_DURATION_MS / 2);
      expect(useUpdateStore.getState().dismissed).toBe(true);

      // Advance the remaining 2 hours to hit the new timer
      vi.advanceTimersByTime(DISMISS_DURATION_MS / 2);
      expect(useUpdateStore.getState().dismissed).toBe(false);
    });
  });

  describe('applyUpdate', () => {
    it('calls IPC applyUpdate', async () => {
      mockApplyUpdate.mockResolvedValue(undefined);

      await useUpdateStore.getState().applyUpdate();

      expect(mockApplyUpdate).toHaveBeenCalled();
    });
  });

  describe('checkWhatsNew', () => {
    it('shows dialog when pending release notes exist for an upgrade', async () => {
      mockGetPendingReleaseNotes.mockResolvedValue({
        version: '0.27.0',
        releaseNotes: '## New Features\n\n- Cool stuff',
      });
      mockGetVersion.mockResolvedValue('0.27.0');
      useUpdateStore.setState({
        settings: {
          autoUpdate: true,
          lastCheck: null,
          dismissedVersion: null,
          lastSeenVersion: '0.26.0', // different from current = upgrade
        },
      });

      await useUpdateStore.getState().checkWhatsNew();

      const state = useUpdateStore.getState();
      expect(state.showWhatsNew).toBe(true);
      expect(state.whatsNew).toEqual({
        version: '0.27.0',
        releaseNotes: '## New Features\n\n- Cool stuff',
      });
    });

    it('does not show dialog when no pending notes', async () => {
      mockGetPendingReleaseNotes.mockResolvedValue(null);

      await useUpdateStore.getState().checkWhatsNew();

      expect(useUpdateStore.getState().showWhatsNew).toBe(false);
    });

    it('cleans up stale file when lastSeenVersion matches current (not an upgrade)', async () => {
      mockGetPendingReleaseNotes.mockResolvedValue({
        version: '0.27.0',
        releaseNotes: 'Some notes',
      });
      mockGetVersion.mockResolvedValue('0.27.0');
      useUpdateStore.setState({
        settings: {
          autoUpdate: true,
          lastCheck: null,
          dismissedVersion: null,
          lastSeenVersion: '0.27.0', // same as current = not an upgrade
        },
      });

      await useUpdateStore.getState().checkWhatsNew();

      expect(useUpdateStore.getState().showWhatsNew).toBe(false);
      expect(mockClearPendingReleaseNotes).toHaveBeenCalled();
    });
  });

  describe('dismissWhatsNew', () => {
    it('clears dialog state and saves lastSeenVersion', async () => {
      mockSaveUpdateSettings.mockResolvedValue(undefined);
      mockGetVersion.mockResolvedValue('0.27.0');
      useUpdateStore.setState({
        showWhatsNew: true,
        whatsNew: { version: '0.27.0', releaseNotes: 'Notes' },
        settings: {
          autoUpdate: true,
          lastCheck: null,
          dismissedVersion: null,
          lastSeenVersion: '0.26.0',
        },
      });

      await useUpdateStore.getState().dismissWhatsNew();

      const state = useUpdateStore.getState();
      expect(state.showWhatsNew).toBe(false);
      expect(state.whatsNew).toBeNull();
      expect(state.settings.lastSeenVersion).toBe('0.27.0');
      expect(mockClearPendingReleaseNotes).toHaveBeenCalled();
      expect(mockSaveUpdateSettings).toHaveBeenCalledWith(
        expect.objectContaining({ lastSeenVersion: '0.27.0' }),
      );
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
        releaseMessage: 'Bug Fixes',
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
        releaseMessage: null,
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
