import { create } from 'zustand';
import { ThemeId, ThemeDefinition } from '../../shared/types';
import { getTheme, getAllThemeIds, getAllThemes, BUILTIN_THEMES, onRegistryChange } from '../themes';
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

/** Push non-builtin themes to the main process so MCP tools can see them. */
function syncPluginThemesToMain(): void {
  try {
    const builtinIds = new Set(Object.keys(BUILTIN_THEMES));
    const allThemes = getAllThemes();
    const pluginThemes = Object.values(allThemes)
      .filter((t) => !builtinIds.has(t.id))
      .map((t) => ({ id: t.id, name: t.name, type: t.type }));
    Promise.resolve(window.clubhouse.app.syncPluginThemes(pluginThemes)).catch(() => {
      /* main process not ready yet — safe to ignore */
    });
  } catch {
    /* preload bridge not available yet */
  }
}

// Auto-refresh available themes when the registry changes.
// Store unsubscribe handle for cleanup (e.g. hot-reload, tests).
export const unsubscribeThemeRegistryListener = onRegistryChange(() => {
  const store = useThemeStore.getState();
  store.refreshAvailable();

  const currentTheme = getTheme(store.themeId);
  if (!currentTheme) {
    // Active theme was unregistered — clear stale flash-prevention cache and fall back.
    // The cache is only removed here, atomically with applying the fallback that replaces it,
    // so we never leave the cache in a state that doesn't match the applied CSS.
    try { localStorage.removeItem('clubhouse-theme-vars'); } catch { /* ignore */ }
    const fallback = BUILTIN_THEMES['catppuccin-mocha'];
    applyTheme(fallback, { experimentalGradients: store.experimentalGradients });
    syncTitleBarOverlay(fallback);
    useThemeStore.setState({ themeId: 'catppuccin-mocha', theme: fallback });
  } else {
    // Theme is still registered — re-apply to pick up any variable changes from updated
    // plugin themes. applyTheme atomically re-writes the flash-prevention cache so it stays
    // consistent with the CSS variables that were just written to the document.
    applyTheme(currentTheme, { experimentalGradients: store.experimentalGradients });
    syncTitleBarOverlay(currentTheme);
    if (currentTheme.id !== store.theme.id) {
      // Previously unavailable theme is now registered — update state to match CSS.
      useThemeStore.setState({ theme: currentTheme });
    }
  }

  // Sync plugin themes to main process for MCP tool visibility
  syncPluginThemesToMain();
});
