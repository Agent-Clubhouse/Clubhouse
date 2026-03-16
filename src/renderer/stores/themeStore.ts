import { create } from 'zustand';
import { ThemeId, ThemeDefinition } from '../../shared/types';
import { getTheme, getAllThemeIds, BUILTIN_THEMES, onRegistryChange } from '../themes';
import { applyTheme } from '../themes/apply-theme';

/** Notify the main process to update the Windows title bar overlay colors. */
function syncTitleBarOverlay(theme: ThemeDefinition): void {
  window.clubhouse.app.updateTitleBarOverlay({
    color: theme.colors.mantle,
    symbolColor: theme.colors.text,
  }).catch(() => { /* not on Windows or window not available */ });
}

function resolveTheme(id: ThemeId): ThemeDefinition {
  return getTheme(id) || BUILTIN_THEMES['catppuccin-mocha'];
}

interface ThemeState {
  themeId: ThemeId;
  theme: ThemeDefinition;
  /** All available theme IDs (builtins + plugin-contributed). */
  availableThemeIds: ThemeId[];
  /** Whether the experimental themeGradients flag is enabled. */
  experimentalGradients: boolean;
  loadTheme: () => Promise<void>;
  setTheme: (id: ThemeId) => Promise<void>;
  /** Refresh the available themes list from the registry. */
  refreshAvailable: () => void;
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  themeId: 'catppuccin-mocha',
  theme: BUILTIN_THEMES['catppuccin-mocha'],
  availableThemeIds: getAllThemeIds(),
  experimentalGradients: false,

  loadTheme: async () => {
    try {
      const [settings, experimental] = await Promise.all([
        window.clubhouse.app.getTheme(),
        window.clubhouse.app.getExperimentalSettings().catch(() => ({} as Record<string, boolean>)),
      ]);
      const id = (settings?.themeId || 'catppuccin-mocha') as ThemeId;
      const theme = resolveTheme(id);
      const experimentalGradients = !!experimental?.themeGradients;
      applyTheme(theme, { experimentalGradients });
      syncTitleBarOverlay(theme);
      set({ themeId: id, theme, experimentalGradients, availableThemeIds: getAllThemeIds() });
    } catch {
      // Use default on error
      applyTheme(BUILTIN_THEMES['catppuccin-mocha']);
    }
  },

  setTheme: async (id) => {
    const theme = getTheme(id);
    if (!theme) return;
    const { experimentalGradients } = get();
    applyTheme(theme, { experimentalGradients });
    syncTitleBarOverlay(theme);
    set({ themeId: id, theme });
    await window.clubhouse.app.saveTheme({ themeId: id });
  },

  refreshAvailable: () => {
    set({ availableThemeIds: getAllThemeIds() });
  },
}));

// Auto-refresh available themes when the registry changes
onRegistryChange(() => {
  const store = useThemeStore.getState();
  store.refreshAvailable();

  // If the active theme was unregistered, fall back to default
  const currentTheme = getTheme(store.themeId);
  if (!currentTheme) {
    const fallback = BUILTIN_THEMES['catppuccin-mocha'];
    applyTheme(fallback, { experimentalGradients: store.experimentalGradients });
    syncTitleBarOverlay(fallback);
    useThemeStore.setState({ themeId: 'catppuccin-mocha', theme: fallback });
  }
});
