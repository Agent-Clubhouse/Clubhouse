import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useLoggingStore } from './loggingStore';

// Uses the centralized window.clubhouse mock from test/setup-renderer.ts.
// Override log methods with spies for assertion.

const DEFAULT_SETTINGS = {
  enabled: true,
  namespaces: {},
  retention: 'medium',
  minLogLevel: 'info',
};

describe('loggingStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useLoggingStore.setState({ settings: null, namespaces: [], logPath: '' });
    // Set up spies on the centralized mock
    (window as any).clubhouse.log.getSettings = vi.fn();
    (window as any).clubhouse.log.saveSettings = vi.fn();
    (window as any).clubhouse.log.getNamespaces = vi.fn();
    (window as any).clubhouse.log.getPath = vi.fn();
  });

  describe('loadSettings', () => {
    it('loads settings, namespaces, and log path from IPC', async () => {
      (window as any).clubhouse.log.getSettings.mockResolvedValue(DEFAULT_SETTINGS);
      (window as any).clubhouse.log.getNamespaces.mockResolvedValue(['app:ipc', 'plugin:terminal']);
      (window as any).clubhouse.log.getPath.mockResolvedValue('/home/user/.clubhouse/logs');

      await useLoggingStore.getState().loadSettings();

      const state = useLoggingStore.getState();
      expect(state.settings).toEqual(DEFAULT_SETTINGS);
      expect(state.namespaces).toEqual(['app:ipc', 'plugin:terminal']);
      expect(state.logPath).toBe('/home/user/.clubhouse/logs');
    });

    it('calls all three IPC methods in parallel', async () => {
      (window as any).clubhouse.log.getSettings.mockResolvedValue(DEFAULT_SETTINGS);
      (window as any).clubhouse.log.getNamespaces.mockResolvedValue([]);
      (window as any).clubhouse.log.getPath.mockResolvedValue('');

      await useLoggingStore.getState().loadSettings();

      expect((window as any).clubhouse.log.getSettings).toHaveBeenCalledTimes(1);
      expect((window as any).clubhouse.log.getNamespaces).toHaveBeenCalledTimes(1);
      expect((window as any).clubhouse.log.getPath).toHaveBeenCalledTimes(1);
    });
  });

  describe('saveSettings', () => {
    it('merges partial settings and persists', async () => {
      useLoggingStore.setState({ settings: DEFAULT_SETTINGS });
      (window as any).clubhouse.log.saveSettings.mockResolvedValue(undefined);

      await useLoggingStore.getState().saveSettings({ enabled: false });

      const { settings } = useLoggingStore.getState();
      expect(settings?.enabled).toBe(false);
      expect(settings?.namespaces).toEqual({});
      expect((window as any).clubhouse.log.saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: false, namespaces: {}, retention: 'medium' }),
      );
    });

    it('merges namespace updates', async () => {
      useLoggingStore.setState({
        settings: { enabled: true, namespaces: { 'app:ipc': true } },
      });
      (window as any).clubhouse.log.saveSettings.mockResolvedValue(undefined);

      await useLoggingStore.getState().saveSettings({
        namespaces: { 'app:ipc': true, 'app:plugins': false },
      });

      const { settings } = useLoggingStore.getState();
      expect(settings?.namespaces).toEqual({ 'app:ipc': true, 'app:plugins': false });
    });

    it('merges retention updates', async () => {
      useLoggingStore.setState({ settings: DEFAULT_SETTINGS as any });
      (window as any).clubhouse.log.saveSettings.mockResolvedValue(undefined);

      await useLoggingStore.getState().saveSettings({ retention: 'high' } as any);

      const { settings } = useLoggingStore.getState();
      expect(settings?.retention).toBe('high');
      expect(settings?.enabled).toBe(true);
      expect((window as any).clubhouse.log.saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({ retention: 'high' }),
      );
    });

    it('merges minLogLevel updates', async () => {
      useLoggingStore.setState({ settings: DEFAULT_SETTINGS as any });
      (window as any).clubhouse.log.saveSettings.mockResolvedValue(undefined);

      await useLoggingStore.getState().saveSettings({ minLogLevel: 'warn' } as any);

      const { settings } = useLoggingStore.getState();
      expect(settings?.minLogLevel).toBe('warn');
      expect(settings?.enabled).toBe(true);
      expect((window as any).clubhouse.log.saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({ minLogLevel: 'warn' }),
      );
    });

    it('does nothing when settings not loaded', async () => {
      await useLoggingStore.getState().saveSettings({ enabled: false });
      expect((window as any).clubhouse.log.saveSettings).not.toHaveBeenCalled();
    });
  });

  describe('loadNamespaces', () => {
    it('refreshes namespaces from IPC', async () => {
      (window as any).clubhouse.log.getNamespaces.mockResolvedValue(['app:git', 'plugin:hub']);

      await useLoggingStore.getState().loadNamespaces();

      expect(useLoggingStore.getState().namespaces).toEqual(['app:git', 'plugin:hub']);
    });
  });
});
