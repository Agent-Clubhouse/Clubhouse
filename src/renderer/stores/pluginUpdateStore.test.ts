import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the hot-reload import
vi.mock('../plugins/plugin-loader', () => ({
  hotReloadPlugin: vi.fn().mockResolvedValue(undefined),
}));

const mockCheckPluginUpdates = vi.fn();
const mockUpdatePlugin = vi.fn();
const mockOnPluginUpdatesChanged = vi.fn();

Object.defineProperty(globalThis, 'window', {
  value: {
    clubhouse: {
      marketplace: {
        checkPluginUpdates: mockCheckPluginUpdates,
        updatePlugin: mockUpdatePlugin,
        onPluginUpdatesChanged: mockOnPluginUpdatesChanged,
      },
    },
  },
  writable: true,
});

import { usePluginUpdateStore, initPluginUpdateListener, DISMISS_DURATION_MS } from './pluginUpdateStore';
import { hotReloadPlugin } from '../plugins/plugin-loader';

describe('pluginUpdateStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    usePluginUpdateStore.setState({
      updates: [],
      checking: false,
      lastCheck: null,
      updating: {},
      error: null,
      dismissed: false,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('checkForUpdates', () => {
    it('fetches and stores updates', async () => {
      mockCheckPluginUpdates.mockResolvedValue({
        updates: [
          {
            pluginId: 'my-plugin',
            pluginName: 'My Plugin',
            currentVersion: '1.0.0',
            latestVersion: '2.0.0',
            assetUrl: 'https://example.com/my-plugin-2.0.0.zip',
            sha256: 'abc',
            size: 1024,
          },
        ],
        checkedAt: '2025-01-01T00:00:00Z',
      });

      await usePluginUpdateStore.getState().checkForUpdates();

      const state = usePluginUpdateStore.getState();
      expect(state.updates).toHaveLength(1);
      expect(state.updates[0].pluginId).toBe('my-plugin');
      expect(state.checking).toBe(false);
      expect(state.lastCheck).toBe('2025-01-01T00:00:00Z');
      expect(state.dismissed).toBe(false);
    });

    it('sets checking flag during check', async () => {
      let resolveCheck: (value: any) => void;
      const checkPromise = new Promise((resolve) => { resolveCheck = resolve; });
      mockCheckPluginUpdates.mockReturnValue(checkPromise);

      const promise = usePluginUpdateStore.getState().checkForUpdates();
      expect(usePluginUpdateStore.getState().checking).toBe(true);

      resolveCheck!({ updates: [], checkedAt: '2025-01-01T00:00:00Z' });
      await promise;
      expect(usePluginUpdateStore.getState().checking).toBe(false);
    });

    it('handles fetch failure gracefully', async () => {
      mockCheckPluginUpdates.mockRejectedValue(new Error('fail'));

      await usePluginUpdateStore.getState().checkForUpdates();
      expect(usePluginUpdateStore.getState().checking).toBe(false);
    });
  });

  describe('updatePlugin', () => {
    beforeEach(() => {
      usePluginUpdateStore.setState({
        updates: [
          {
            pluginId: 'my-plugin',
            pluginName: 'My Plugin',
            currentVersion: '1.0.0',
            latestVersion: '2.0.0',
            assetUrl: 'https://example.com/my-plugin-2.0.0.zip',
            sha256: 'abc',
            size: 1024,
          },
        ],
      });
    });

    it('calls main process update and hot-reloads on success', async () => {
      mockUpdatePlugin.mockResolvedValue({ success: true, pluginId: 'my-plugin', newVersion: '2.0.0' });

      const result = await usePluginUpdateStore.getState().updatePlugin('my-plugin');

      expect(result.success).toBe(true);
      expect(hotReloadPlugin).toHaveBeenCalledWith('my-plugin');

      // Plugin should be removed from updates
      expect(usePluginUpdateStore.getState().updates).toHaveLength(0);
      expect(usePluginUpdateStore.getState().updating).toEqual({});
    });

    it('does not hot-reload on failure', async () => {
      mockUpdatePlugin.mockResolvedValue({ success: false, pluginId: 'my-plugin', error: 'Download failed' });

      const result = await usePluginUpdateStore.getState().updatePlugin('my-plugin');

      expect(result.success).toBe(false);
      expect(hotReloadPlugin).not.toHaveBeenCalled();

      // Plugin should still be in updates
      expect(usePluginUpdateStore.getState().updates).toHaveLength(1);
    });

    it('handles exception during update', async () => {
      mockUpdatePlugin.mockRejectedValue(new Error('Network error'));

      const result = await usePluginUpdateStore.getState().updatePlugin('my-plugin');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Network error');
      expect(usePluginUpdateStore.getState().updating).toEqual({});
    });

    it('sets updating phase during update', async () => {
      let resolveUpdate: (value: any) => void;
      const updatePromise = new Promise((resolve) => { resolveUpdate = resolve; });
      mockUpdatePlugin.mockReturnValue(updatePromise);

      const promise = usePluginUpdateStore.getState().updatePlugin('my-plugin');
      expect(usePluginUpdateStore.getState().updating['my-plugin']).toBe('downloading');

      resolveUpdate!({ success: true, pluginId: 'my-plugin', newVersion: '2.0.0' });
      await promise;
      expect(usePluginUpdateStore.getState().updating['my-plugin']).toBeUndefined();
    });
  });

  describe('updateAll', () => {
    it('updates all plugins sequentially', async () => {
      usePluginUpdateStore.setState({
        updates: [
          {
            pluginId: 'plugin-a',
            pluginName: 'Plugin A',
            currentVersion: '1.0.0',
            latestVersion: '2.0.0',
            assetUrl: 'url-a',
            sha256: 'a',
            size: 100,
          },
          {
            pluginId: 'plugin-b',
            pluginName: 'Plugin B',
            currentVersion: '1.0.0',
            latestVersion: '3.0.0',
            assetUrl: 'url-b',
            sha256: 'b',
            size: 200,
          },
        ],
      });

      mockUpdatePlugin
        .mockResolvedValueOnce({ success: true, pluginId: 'plugin-a', newVersion: '2.0.0' })
        .mockResolvedValueOnce({ success: true, pluginId: 'plugin-b', newVersion: '3.0.0' });

      await usePluginUpdateStore.getState().updateAll();

      expect(mockUpdatePlugin).toHaveBeenCalledTimes(2);
      expect(usePluginUpdateStore.getState().updates).toHaveLength(0);
    });
  });

  describe('dismiss', () => {
    it('sets dismissed flag', () => {
      usePluginUpdateStore.getState().dismiss();
      expect(usePluginUpdateStore.getState().dismissed).toBe(true);
    });

    it('un-dismisses after timeout', () => {
      usePluginUpdateStore.getState().dismiss();
      expect(usePluginUpdateStore.getState().dismissed).toBe(true);

      vi.advanceTimersByTime(DISMISS_DURATION_MS);
      expect(usePluginUpdateStore.getState().dismissed).toBe(false);
    });

    it('resets timer on re-dismiss', () => {
      usePluginUpdateStore.getState().dismiss();
      vi.advanceTimersByTime(DISMISS_DURATION_MS / 2);

      // Re-dismiss
      usePluginUpdateStore.getState().dismiss();
      vi.advanceTimersByTime(DISMISS_DURATION_MS / 2);

      // Should still be dismissed (timer was reset)
      expect(usePluginUpdateStore.getState().dismissed).toBe(true);

      vi.advanceTimersByTime(DISMISS_DURATION_MS / 2);
      expect(usePluginUpdateStore.getState().dismissed).toBe(false);
    });
  });

  describe('initPluginUpdateListener', () => {
    it('subscribes to status changes', () => {
      mockOnPluginUpdatesChanged.mockReturnValue(() => {});
      initPluginUpdateListener();
      expect(mockOnPluginUpdatesChanged).toHaveBeenCalledTimes(1);
    });

    it('updates store when status changes arrive', () => {
      let callback: (status: any) => void;
      mockOnPluginUpdatesChanged.mockImplementation((cb: any) => {
        callback = cb;
        return () => {};
      });

      initPluginUpdateListener();

      callback!({
        updates: [
          {
            pluginId: 'test',
            pluginName: 'Test',
            currentVersion: '1.0.0',
            latestVersion: '2.0.0',
            assetUrl: 'url',
            sha256: 'hash',
            size: 100,
          },
        ],
        checking: false,
        lastCheck: '2025-06-01T00:00:00Z',
        updating: {},
        error: null,
      });

      const state = usePluginUpdateStore.getState();
      expect(state.updates).toHaveLength(1);
      expect(state.lastCheck).toBe('2025-06-01T00:00:00Z');
    });

    it('un-dismisses when new updates arrive', () => {
      usePluginUpdateStore.setState({ dismissed: true });

      let callback: (status: any) => void;
      mockOnPluginUpdatesChanged.mockImplementation((cb: any) => {
        callback = cb;
        return () => {};
      });

      initPluginUpdateListener();

      callback!({
        updates: [{ pluginId: 'test', pluginName: 'Test', currentVersion: '1.0.0', latestVersion: '2.0.0', assetUrl: '', sha256: '', size: 0 }],
        checking: false,
        lastCheck: null,
        updating: {},
        error: null,
      });

      expect(usePluginUpdateStore.getState().dismissed).toBe(false);
    });
  });
});
