import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useNotificationStore } from './notificationStore';

// Mock window.clubhouse API
const mockGetNotificationSettings = vi.fn();
const mockSaveNotificationSettings = vi.fn();
const mockSendNotification = vi.fn();

Object.defineProperty(globalThis, 'window', {
  value: {
    clubhouse: {
      app: {
        getNotificationSettings: mockGetNotificationSettings,
        saveNotificationSettings: mockSaveNotificationSettings,
        sendNotification: mockSendNotification,
      },
    },
  },
  writable: true,
});

const ALL_ON_SETTINGS = {
  enabled: true,
  permissionNeeded: true,
  agentIdle: true,
  agentStopped: true,
  agentError: true,
  playSound: true,
};

describe('notificationStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useNotificationStore.setState({ settings: null });
  });

  describe('loadSettings', () => {
    it('loads settings from IPC', async () => {
      mockGetNotificationSettings.mockResolvedValue(ALL_ON_SETTINGS);

      await useNotificationStore.getState().loadSettings();

      expect(useNotificationStore.getState().settings).toEqual(ALL_ON_SETTINGS);
    });
  });

  describe('saveSettings', () => {
    it('merges partial settings and persists', async () => {
      useNotificationStore.setState({ settings: ALL_ON_SETTINGS });
      mockSaveNotificationSettings.mockResolvedValue(undefined);

      await useNotificationStore.getState().saveSettings({ playSound: false });

      const { settings } = useNotificationStore.getState();
      expect(settings?.playSound).toBe(false);
      expect(settings?.enabled).toBe(true); // unchanged
      expect(mockSaveNotificationSettings).toHaveBeenCalledWith(
        expect.objectContaining({ playSound: false, enabled: true })
      );
    });

    it('does nothing when settings not loaded', async () => {
      await useNotificationStore.getState().saveSettings({ playSound: false });
      expect(mockSaveNotificationSettings).not.toHaveBeenCalled();
    });
  });

  describe('checkAndNotify', () => {
    it('does nothing when settings not loaded', () => {
      useNotificationStore.getState().checkAndNotify('Agent 1', 'stop');
      expect(mockSendNotification).not.toHaveBeenCalled();
    });

    it('does nothing when notifications disabled', () => {
      useNotificationStore.setState({ settings: { ...ALL_ON_SETTINGS, enabled: false } });
      useNotificationStore.getState().checkAndNotify('Agent 1', 'stop');
      expect(mockSendNotification).not.toHaveBeenCalled();
    });

    describe('permission_request events', () => {
      it('sends notification when permissionNeeded is on', () => {
        useNotificationStore.setState({ settings: ALL_ON_SETTINGS });
        useNotificationStore.getState().checkAndNotify('Claude', 'permission_request', 'Bash');

        expect(mockSendNotification).toHaveBeenCalledWith(
          'Claude needs permission',
          'Wants to use Bash',
          false // playSound is true → silent is false
        );
      });

      it('uses default body when no detail', () => {
        useNotificationStore.setState({ settings: ALL_ON_SETTINGS });
        useNotificationStore.getState().checkAndNotify('Claude', 'permission_request');

        expect(mockSendNotification).toHaveBeenCalledWith(
          'Claude needs permission',
          'Agent is waiting for approval',
          false
        );
      });

      it('also triggers for notification events', () => {
        useNotificationStore.setState({ settings: ALL_ON_SETTINGS });
        useNotificationStore.getState().checkAndNotify('Claude', 'notification', 'Read');

        expect(mockSendNotification).toHaveBeenCalledWith(
          'Claude needs permission',
          'Wants to use Read',
          false
        );
      });

      it('skips when permissionNeeded is off', () => {
        useNotificationStore.setState({
          settings: { ...ALL_ON_SETTINGS, permissionNeeded: false },
        });
        useNotificationStore.getState().checkAndNotify('Claude', 'permission_request');
        expect(mockSendNotification).not.toHaveBeenCalled();
      });
    });

    describe('stop events', () => {
      it('sends notification when agentStopped is on', () => {
        useNotificationStore.setState({ settings: ALL_ON_SETTINGS });
        useNotificationStore.getState().checkAndNotify('Worker', 'stop');

        expect(mockSendNotification).toHaveBeenCalledWith(
          'Worker finished',
          'Agent has stopped',
          false
        );
      });

      it('falls through to agentIdle when agentStopped is off', () => {
        useNotificationStore.setState({
          settings: { ...ALL_ON_SETTINGS, agentStopped: false },
        });
        useNotificationStore.getState().checkAndNotify('Worker', 'stop');

        expect(mockSendNotification).toHaveBeenCalledWith(
          'Worker is idle',
          'Agent is waiting for input',
          false
        );
      });

      it('skips when both agentStopped and agentIdle are off', () => {
        useNotificationStore.setState({
          settings: { ...ALL_ON_SETTINGS, agentStopped: false, agentIdle: false },
        });
        useNotificationStore.getState().checkAndNotify('Worker', 'stop');
        expect(mockSendNotification).not.toHaveBeenCalled();
      });
    });

    describe('tool_error events', () => {
      it('sends notification when agentError is on', () => {
        useNotificationStore.setState({ settings: ALL_ON_SETTINGS });
        useNotificationStore.getState().checkAndNotify('Dev', 'tool_error', 'Bash');

        expect(mockSendNotification).toHaveBeenCalledWith(
          'Dev hit an error',
          'Bash failed',
          false
        );
      });

      it('uses default body when no detail', () => {
        useNotificationStore.setState({ settings: ALL_ON_SETTINGS });
        useNotificationStore.getState().checkAndNotify('Dev', 'tool_error');

        expect(mockSendNotification).toHaveBeenCalledWith(
          'Dev hit an error',
          'A tool call failed',
          false
        );
      });

      it('skips when agentError is off', () => {
        useNotificationStore.setState({
          settings: { ...ALL_ON_SETTINGS, agentError: false },
        });
        useNotificationStore.getState().checkAndNotify('Dev', 'tool_error');
        expect(mockSendNotification).not.toHaveBeenCalled();
      });
    });

    describe('sound behavior', () => {
      it('sends silent=true when playSound is off', () => {
        useNotificationStore.setState({
          settings: { ...ALL_ON_SETTINGS, playSound: false },
        });
        useNotificationStore.getState().checkAndNotify('Agent', 'stop');

        expect(mockSendNotification).toHaveBeenCalledWith(
          expect.any(String),
          expect.any(String),
          true // silent
        );
      });
    });

    describe('unmatched events', () => {
      it('ignores pre_tool events', () => {
        useNotificationStore.setState({ settings: ALL_ON_SETTINGS });
        useNotificationStore.getState().checkAndNotify('Agent', 'pre_tool');
        expect(mockSendNotification).not.toHaveBeenCalled();
      });

      it('ignores post_tool events', () => {
        useNotificationStore.setState({ settings: ALL_ON_SETTINGS });
        useNotificationStore.getState().checkAndNotify('Agent', 'post_tool');
        expect(mockSendNotification).not.toHaveBeenCalled();
      });
    });
  });
});
