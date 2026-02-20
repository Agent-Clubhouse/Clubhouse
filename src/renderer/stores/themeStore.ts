import { create } from 'zustand';
import { ThemeId, ThemeDefinition } from '../../shared/types';
import { THEMES } from '../themes';
import { applyTheme } from '../themes/apply-theme';

/** Notify the main process to update the Windows title bar overlay colors. */
function syncTitleBarOverlay(theme: ThemeDefinition): void {
  window.clubhouse.app.updateTitleBarOverlay({
    color: theme.colors.mantle,
    symbolColor: theme.colors.text,
  }).catch(() => { /* not on Windows or window not available */ });
}

interface ThemeState {
  themeId: ThemeId;
  theme: ThemeDefinition;
  loadTheme: () => Promise<void>;
  setTheme: (id: ThemeId) => Promise<void>;
}

export const useThemeStore = create<ThemeState>((set) => ({
  themeId: 'catppuccin-mocha',
  theme: THEMES['catppuccin-mocha'],

  loadTheme: async () => {
    try {
      const settings = await window.clubhouse.app.getTheme();
      const id = (settings?.themeId || 'catppuccin-mocha') as ThemeId;
      const theme = THEMES[id] || THEMES['catppuccin-mocha'];
      applyTheme(theme);
      syncTitleBarOverlay(theme);
      set({ themeId: id, theme });
    } catch {
      // Use default on error
      applyTheme(THEMES['catppuccin-mocha']);
    }
  },

  setTheme: async (id) => {
    const theme = THEMES[id];
    if (!theme) return;
    applyTheme(theme);
    syncTitleBarOverlay(theme);
    set({ themeId: id, theme });
    await window.clubhouse.app.saveTheme({ themeId: id });
  },
}));
