import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useMcpSettingsStore } from './mcpSettingsStore';

describe('mcpSettingsStore', () => {
  beforeEach(() => {
    // Reset the store state between tests
    useMcpSettingsStore.setState({ enabled: false, projectOverrides: undefined, loaded: false });
    vi.clearAllMocks();
  });

  describe('loadSettings', () => {
    it('loads settings from the main process', async () => {
      (window.clubhouse.settings.get as any) = vi.fn().mockResolvedValue({ enabled: true, projectOverrides: { '/foo': false } });

      await useMcpSettingsStore.getState().loadSettings();

      expect(useMcpSettingsStore.getState().enabled).toBe(true);
      expect(useMcpSettingsStore.getState().projectOverrides).toEqual({ '/foo': false });
      expect(useMcpSettingsStore.getState().loaded).toBe(true);
    });

    it('handles null response gracefully', async () => {
      (window.clubhouse.settings.get as any) = vi.fn().mockResolvedValue(null);

      await useMcpSettingsStore.getState().loadSettings();

      expect(useMcpSettingsStore.getState().enabled).toBe(false);
      expect(useMcpSettingsStore.getState().loaded).toBe(true);
    });

    it('handles errors gracefully', async () => {
      (window.clubhouse.settings.get as any) = vi.fn().mockRejectedValue(new Error('fail'));

      await useMcpSettingsStore.getState().loadSettings();

      expect(useMcpSettingsStore.getState().enabled).toBe(false);
      expect(useMcpSettingsStore.getState().loaded).toBe(true);
    });
  });

  describe('saveSettings', () => {
    it('optimistically updates and persists', async () => {
      (window.clubhouse.settings.save as any) = vi.fn().mockResolvedValue(undefined);
      useMcpSettingsStore.setState({ enabled: false, loaded: true });

      await useMcpSettingsStore.getState().saveSettings({ enabled: true });

      expect(useMcpSettingsStore.getState().enabled).toBe(true);
      expect(window.clubhouse.settings.save).toHaveBeenCalledWith('mcp', expect.objectContaining({ enabled: true }));
    });

    it('reverts on save error', async () => {
      (window.clubhouse.settings.save as any) = vi.fn().mockRejectedValue(new Error('fail'));
      useMcpSettingsStore.setState({ enabled: false, loaded: true });

      await useMcpSettingsStore.getState().saveSettings({ enabled: true });

      // Should revert to false after error
      expect(useMcpSettingsStore.getState().enabled).toBe(false);
    });
  });
});
