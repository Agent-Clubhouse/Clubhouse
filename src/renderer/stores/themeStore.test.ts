import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ThemeId, ThemeDefinition } from '../../shared/types';

// ---------- mock applyTheme before importing store ----------
vi.mock('../themes/apply-theme', () => ({
  applyTheme: vi.fn(),
}));

// ---------- IPC mock ----------
const mockApp = {
  getTheme: vi.fn<() => Promise<{ themeId: string } | null>>(),
  saveTheme: vi.fn().mockResolvedValue(undefined),
  updateTitleBarOverlay: vi.fn().mockResolvedValue(undefined),
};

Object.defineProperty(globalThis, 'window', {
  value: { clubhouse: { app: mockApp } },
  writable: true,
});

// Need localStorage for applyTheme internals (not called since mocked, but just in case)
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: vi.fn(() => null),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  },
  writable: true,
});

import { useThemeStore } from './themeStore';
import { THEMES } from '../themes';
import { applyTheme } from '../themes/apply-theme';

// ---------- helpers ----------
function getState() {
  return useThemeStore.getState();
}

// ---------- tests ----------
describe('themeStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useThemeStore.setState({
      themeId: 'catppuccin-mocha',
      theme: THEMES['catppuccin-mocha'],
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
      expect(applyTheme).toHaveBeenCalledWith(THEMES['dracula']);
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
      expect(applyTheme).toHaveBeenCalledWith(THEMES['nord']);
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
});
