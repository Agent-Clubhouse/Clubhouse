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

      expect(useMcpSettingsStore.getState().enabled).toBe(true);
      expect(useMcpSettingsStore.getState().loaded).toBe(true);
    });

    it('handles errors gracefully', async () => {
      (window.clubhouse.settings.get as any) = vi.fn().mockRejectedValue(new Error('fail'));

      await useMcpSettingsStore.getState().loadSettings();

      expect(useMcpSettingsStore.getState().enabled).toBe(true);
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

describe('project overrides, which have no default', () => {
  beforeEach(() => {
    window.clubhouse.settings.save = vi.fn(async () => {}) as never;
    window.clubhouse.settings.get = vi.fn(async () => ({ enabled: true, projectDefault: false, projectOverrides: { keep: true } })) as never;
  });
  const lastSaved = () => vi.mocked(window.clubhouse.settings.save).mock.calls.at(-1)?.[1];

  it('survive turning MCP off at app level, with every other saved key', async () => {
    await useMcpSettingsStore.getState().loadSettings();
    await useMcpSettingsStore.getState().saveSettings({ enabled: false });
    expect(lastSaved()).toEqual({ enabled: false, projectDefault: false, projectOverrides: { keep: true } });
  });

  it('are saved when set', async () => {
    await useMcpSettingsStore.getState().loadSettings();
    await useMcpSettingsStore.getState().saveSettings({ projectOverrides: { keep: true, other: false } } as never);
    expect(lastSaved()).toEqual({ enabled: true, projectDefault: false, projectOverrides: { keep: true, other: false } });
  });

  it('can be cleared', async () => {
    await useMcpSettingsStore.getState().loadSettings();
    await useMcpSettingsStore.getState().saveSettings({ projectOverrides: undefined } as never);
    expect((lastSaved() as { projectOverrides?: unknown }).projectOverrides).toBeUndefined();
  });

  it('sends no store internals', async () => {
    await useMcpSettingsStore.getState().loadSettings();
    await useMcpSettingsStore.getState().saveSettings({ enabled: false });
    expect(Object.keys(lastSaved() as object).sort()).toEqual(['enabled', 'projectDefault', 'projectOverrides']);
  });
});
