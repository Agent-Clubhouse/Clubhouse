import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ThemeId } from '../../shared/types';

// ---------- mock applyTheme before importing store ----------
vi.mock('../themes/apply-theme', () => ({
  applyTheme: vi.fn(),
}));

// ---------- IPC mock ----------
const mockApp = {
  getTheme: vi.fn<() => Promise<{ themeId: string } | null>>(),
  saveTheme: vi.fn().mockResolvedValue(undefined),
  updateTitleBarOverlay: vi.fn().mockResolvedValue(undefined),
  getExperimentalSettings: vi.fn().mockResolvedValue({} as Record<string, boolean>),
  syncPluginThemes: vi.fn().mockResolvedValue(undefined),
};

vi.stubGlobal('window', {
  clubhouse: { app: mockApp },
});

import { useThemeStore } from './themeStore';
import { THEMES, registerTheme, unregisterTheme } from '../themes';
import { applyTheme } from '../themes/apply-theme';
import type { ThemeDefinition } from '../../shared/types';

// ---------- helpers ----------
function getState() {
  return useThemeStore.getState();
}

// ---------- tests ----------
describe('themeStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApp.updateTitleBarOverlay.mockResolvedValue(undefined);
    mockApp.getExperimentalSettings.mockResolvedValue({} as Record<string, boolean>);
    useThemeStore.setState({
      themeId: 'catppuccin-mocha',
      theme: THEMES['catppuccin-mocha'],
      experimentalGradients: false,
    });
  });

  // ---- defaults ----
  describe('initialization', () => {
    it('defaults to catppuccin-mocha', () => {
      const s = getState();
      expect(s.themeId).toBe('catppuccin-mocha');
      expect(s.theme).toBe(THEMES['catppuccin-mocha']);
    });
  });

  // ---- loadTheme ----
  describe('loadTheme', () => {
    it('loads theme from IPC settings', async () => {
      mockApp.getTheme.mockResolvedValueOnce({ themeId: 'dracula' });

      await getState().loadTheme();

      expect(getState().themeId).toBe('dracula');
      expect(getState().theme).toBe(THEMES['dracula']);
      expect(applyTheme).toHaveBeenCalledWith(THEMES['dracula'], { experimentalGradients: false });
      expect(mockApp.updateTitleBarOverlay).toHaveBeenCalledWith({
        color: THEMES['dracula'].colors.mantle,
        symbolColor: THEMES['dracula'].colors.text,
      });
    });

    it('falls back to catppuccin-mocha when themeId is missing', async () => {
      mockApp.getTheme.mockResolvedValueOnce({ themeId: '' });

      await getState().loadTheme();

      expect(getState().themeId).toBe('catppuccin-mocha');
      expect(getState().theme).toBe(THEMES['catppuccin-mocha']);
    });

    it('falls back to catppuccin-mocha for unknown theme ID', async () => {
      mockApp.getTheme.mockResolvedValueOnce({ themeId: 'nonexistent-theme' });

      await getState().loadTheme();

      // The `||` fallback means both themeId and theme fall back to default
      // because THEMES['nonexistent-theme'] is undefined (falsy)
      // Code: const id = (settings?.themeId || 'catppuccin-mocha') — id stays as raw string
      // Code: const theme = THEMES[id] || THEMES['catppuccin-mocha'] — theme falls back
      // The raw id IS stored even if invalid; the theme object is the fallback
      expect(getState().themeId).toBe('nonexistent-theme');
      expect(getState().theme).toBe(THEMES['catppuccin-mocha']);
    });

    it('falls back to catppuccin-mocha when getTheme returns null', async () => {
      mockApp.getTheme.mockResolvedValueOnce(null);

      await getState().loadTheme();

      expect(getState().themeId).toBe('catppuccin-mocha');
      expect(getState().theme).toBe(THEMES['catppuccin-mocha']);
    });

    it('applies default theme on error', async () => {
      mockApp.getTheme.mockRejectedValueOnce(new Error('ipc failed'));

      await getState().loadTheme();

      expect(applyTheme).toHaveBeenCalledWith(THEMES['catppuccin-mocha']);
      // State remains at defaults
      expect(getState().themeId).toBe('catppuccin-mocha');
    });
  });

  // ---- setTheme ----
  describe('setTheme', () => {
    it('applies and persists a valid theme', async () => {
      await getState().setTheme('nord');

      expect(getState().themeId).toBe('nord');
      expect(getState().theme).toBe(THEMES['nord']);
      expect(applyTheme).toHaveBeenCalledWith(THEMES['nord'], { experimentalGradients: false });
      expect(mockApp.updateTitleBarOverlay).toHaveBeenCalledWith({
        color: THEMES['nord'].colors.mantle,
        symbolColor: THEMES['nord'].colors.text,
      });
      expect(mockApp.saveTheme).toHaveBeenCalledWith({ themeId: 'nord' });
    });

    it('does nothing for an unknown theme ID', async () => {
      useThemeStore.setState({ themeId: 'dracula', theme: THEMES['dracula'] });

      await getState().setTheme('nonexistent' as ThemeId);

      expect(getState().themeId).toBe('dracula');
      expect(applyTheme).not.toHaveBeenCalled();
      expect(mockApp.saveTheme).not.toHaveBeenCalled();
    });

    it('can switch through all available themes', async () => {
      for (const id of Object.keys(THEMES) as ThemeId[]) {
        await getState().setTheme(id);
        expect(getState().themeId).toBe(id);
        expect(getState().theme).toBe(THEMES[id]);
      }
    });
  });

  // ---- selector stability ----
  describe('selector stability', () => {
    it('theme reference is stable when themeId is unchanged', () => {
      const ref1 = getState().theme;
      const ref2 = getState().theme;
      expect(ref1).toBe(ref2);
    });

    it('theme reference from THEMES map is used directly (no copies)', async () => {
      await getState().setTheme('terminal');
      expect(getState().theme).toBe(THEMES['terminal']);
    });
  });

  // ---- onRegistryChange callbacks ----
  describe('onRegistryChange', () => {
    const fakePluginTheme: ThemeDefinition = {
      id: 'plugin:test:deferred',
      name: 'Deferred',
      type: 'dark',
      colors: THEMES['catppuccin-mocha'].colors,
      hljs: THEMES['catppuccin-mocha'].hljs,
      terminal: THEMES['catppuccin-mocha'].terminal,
    };

    afterEach(() => {
      unregisterTheme(fakePluginTheme.id);
    });

    it('re-applies preferred plugin theme when it registers after a fallback load', () => {
      // Simulate the race: user's saved preference is the plugin theme, but it wasn't
      // registered at startup so loadTheme fell back — themeId points to the plugin
      // but theme is still the mocha fallback.
      useThemeStore.setState({
        themeId: fakePluginTheme.id as ThemeId,
        theme: THEMES['catppuccin-mocha'],
      });
      vi.clearAllMocks();

      // Plugin registers — triggers onRegistryChange
      registerTheme(fakePluginTheme);

      expect(applyTheme).toHaveBeenCalledWith(fakePluginTheme, { experimentalGradients: false });
      expect(mockApp.updateTitleBarOverlay).toHaveBeenCalledWith({
        color: fakePluginTheme.colors.mantle,
        symbolColor: fakePluginTheme.colors.text,
      });
      expect(useThemeStore.getState().theme).toBe(fakePluginTheme);
      // themeId is unchanged — only the applied theme object is updated
      expect(useThemeStore.getState().themeId).toBe(fakePluginTheme.id);
    });

    it('does not re-apply when the active theme already matches themeId', () => {
      // Both themeId and theme are already the plugin theme — registry fires for a
      // different reason (another plugin registers), active state is untouched.
      registerTheme(fakePluginTheme);
      useThemeStore.setState({
        themeId: fakePluginTheme.id as ThemeId,
        theme: fakePluginTheme,
      });
      vi.clearAllMocks();

      const otherTheme: ThemeDefinition = {
        ...fakePluginTheme,
        id: 'plugin:test:other',
        name: 'Other',
      };
      registerTheme(otherTheme);
      unregisterTheme(otherTheme.id);

      expect(applyTheme).not.toHaveBeenCalled();
    });

    it('falls back to catppuccin-mocha when the active plugin theme is unregistered', async () => {
      registerTheme(fakePluginTheme);
      await getState().setTheme(fakePluginTheme.id as ThemeId);
      vi.clearAllMocks();

      unregisterTheme(fakePluginTheme.id);

      expect(applyTheme).toHaveBeenCalledWith(THEMES['catppuccin-mocha'], { experimentalGradients: false });
      expect(mockApp.updateTitleBarOverlay).toHaveBeenCalledWith({
        color: THEMES['catppuccin-mocha'].colors.mantle,
        symbolColor: THEMES['catppuccin-mocha'].colors.text,
      });
      expect(useThemeStore.getState().themeId).toBe('catppuccin-mocha');
      expect(useThemeStore.getState().theme).toBe(THEMES['catppuccin-mocha']);
    });

    it('respects experimentalGradients when re-applying deferred theme', () => {
      useThemeStore.setState({
        themeId: fakePluginTheme.id as ThemeId,
        theme: THEMES['catppuccin-mocha'],
        experimentalGradients: true,
      });
      vi.clearAllMocks();

      registerTheme(fakePluginTheme);

      expect(applyTheme).toHaveBeenCalledWith(fakePluginTheme, { experimentalGradients: true });
    });
  });

  // ---- plugin theme sync to main ----
  describe('plugin theme sync', () => {
    const fakePluginTheme: ThemeDefinition = {
      id: 'plugin:test:ocean',
      name: 'Ocean',
      type: 'dark',
      colors: THEMES['catppuccin-mocha'].colors,
      hljs: THEMES['catppuccin-mocha'].hljs,
      terminal: THEMES['catppuccin-mocha'].terminal,
    };

    afterEach(() => {
      unregisterTheme(fakePluginTheme.id);
    });

    it('syncs plugin themes to main when a theme is registered', () => {
      mockApp.syncPluginThemes.mockClear();
      registerTheme(fakePluginTheme);

      expect(mockApp.syncPluginThemes).toHaveBeenCalledTimes(1);
      const synced = mockApp.syncPluginThemes.mock.calls[0][0];
      const ids = synced.map((t: { id: string }) => t.id);
      expect(ids).toContain('plugin:test:ocean');
      // Builtins should NOT be in the synced list
      expect(ids).not.toContain('catppuccin-mocha');
    });

    it('syncs updated list when a plugin theme is unregistered', () => {
      registerTheme(fakePluginTheme);
      mockApp.syncPluginThemes.mockClear();
      unregisterTheme(fakePluginTheme.id);

      expect(mockApp.syncPluginThemes).toHaveBeenCalledTimes(1);
      const synced = mockApp.syncPluginThemes.mock.calls[0][0];
      const ids = synced.map((t: { id: string }) => t.id);
      expect(ids).not.toContain('plugin:test:ocean');
    });

    it('refreshes availableThemeIds when registry changes', () => {
      registerTheme(fakePluginTheme);
      expect(getState().availableThemeIds).toContain('plugin:test:ocean');

      unregisterTheme(fakePluginTheme.id);
      expect(getState().availableThemeIds).not.toContain('plugin:test:ocean');
    });
  });
});
