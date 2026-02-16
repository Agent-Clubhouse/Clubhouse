import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useLoggingStore } from './loggingStore';

const mockGetSettings = vi.fn();
const mockSaveSettings = vi.fn();
const mockGetNamespaces = vi.fn();
const mockGetPath = vi.fn();

Object.defineProperty(globalThis, 'window', {
  value: {
    clubhouse: {
      log: {
        getSettings: mockGetSettings,
        saveSettings: mockSaveSettings,
        getNamespaces: mockGetNamespaces,
        getPath: mockGetPath,
      },
    },
  },
  writable: true,
});

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
  });

  describe('loadSettings', () => {
    it('loads settings, namespaces, and log path from IPC', async () => {
      mockGetSettings.mockResolvedValue(DEFAULT_SETTINGS);
      mockGetNamespaces.mockResolvedValue(['app:ipc', 'plugin:terminal']);
      mockGetPath.mockResolvedValue('/home/user/.clubhouse/logs');

      await useLoggingStore.getState().loadSettings();

      const state = useLoggingStore.getState();
      expect(state.settings).toEqual(DEFAULT_SETTINGS);
      expect(state.namespaces).toEqual(['app:ipc', 'plugin:terminal']);
      expect(state.logPath).toBe('/home/user/.clubhouse/logs');
    });

    it('calls all three IPC methods in parallel', async () => {
      mockGetSettings.mockResolvedValue(DEFAULT_SETTINGS);
      mockGetNamespaces.mockResolvedValue([]);
      mockGetPath.mockResolvedValue('');

      await useLoggingStore.getState().loadSettings();

      expect(mockGetSettings).toHaveBeenCalledTimes(1);
      expect(mockGetNamespaces).toHaveBeenCalledTimes(1);
      expect(mockGetPath).toHaveBeenCalledTimes(1);
    });
  });

  describe('saveSettings', () => {
    it('merges partial settings and persists', async () => {
      useLoggingStore.setState({ settings: DEFAULT_SETTINGS });
      mockSaveSettings.mockResolvedValue(undefined);

      await useLoggingStore.getState().saveSettings({ enabled: false });

      const { settings } = useLoggingStore.getState();
      expect(settings?.enabled).toBe(false);
      expect(settings?.namespaces).toEqual({});
      expect(mockSaveSettings).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: false, namespaces: {}, retention: 'medium' }),
      );
    });

    it('merges namespace updates', async () => {
      useLoggingStore.setState({
        settings: { enabled: true, namespaces: { 'app:ipc': true } },
      });
      mockSaveSettings.mockResolvedValue(undefined);

      await useLoggingStore.getState().saveSettings({
        namespaces: { 'app:ipc': true, 'app:plugins': false },
      });

      const { settings } = useLoggingStore.getState();
      expect(settings?.namespaces).toEqual({ 'app:ipc': true, 'app:plugins': false });
    });

    it('merges retention updates', async () => {
      useLoggingStore.setState({ settings: DEFAULT_SETTINGS as any });
      mockSaveSettings.mockResolvedValue(undefined);

      await useLoggingStore.getState().saveSettings({ retention: 'high' } as any);

      const { settings } = useLoggingStore.getState();
      expect(settings?.retention).toBe('high');
      expect(settings?.enabled).toBe(true);
      expect(mockSaveSettings).toHaveBeenCalledWith(
        expect.objectContaining({ retention: 'high' }),
      );
    });

    it('merges minLogLevel updates', async () => {
      useLoggingStore.setState({ settings: DEFAULT_SETTINGS as any });
      mockSaveSettings.mockResolvedValue(undefined);

      await useLoggingStore.getState().saveSettings({ minLogLevel: 'warn' } as any);

      const { settings } = useLoggingStore.getState();
      expect(settings?.minLogLevel).toBe('warn');
      expect(settings?.enabled).toBe(true);
      expect(mockSaveSettings).toHaveBeenCalledWith(
        expect.objectContaining({ minLogLevel: 'warn' }),
      );
    });

    it('does nothing when settings not loaded', async () => {
      await useLoggingStore.getState().saveSettings({ enabled: false });
      expect(mockSaveSettings).not.toHaveBeenCalled();
    });
  });

  describe('loadNamespaces', () => {
    it('refreshes namespaces from IPC', async () => {
      mockGetNamespaces.mockResolvedValue(['app:git', 'plugin:hub']);

      await useLoggingStore.getState().loadNamespaces();

      expect(useLoggingStore.getState().namespaces).toEqual(['app:git', 'plugin:hub']);
    });
  });
});
