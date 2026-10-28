import { create } from 'zustand';
import { ThemeId, ThemeDefinition } from '../../shared/types';
import { getTheme, getAllThemeIds, getAllThemes, BUILTIN_THEMES, onRegistryChange } from '../themes';
import { applyTheme } from '../themes/apply-theme';
import { rendererLog } from '../plugins/renderer-logger';

/** Notify the main process to update the Windows title bar overlay colors. */
function syncTitleBarOverlay(theme: ThemeDefinition): void {
  window.clubhouse.app.updateTitleBarOverlay({
    color: theme.colors.mantle,
    symbolColor: theme.colors.text,
  }).catch(() => { /* not on Windows or window not available */ });
}

/**
 * Push the applied theme to main. Main can't look plugin or custom themes up
 * by id, and Annex sends these colors to phones.
 */
function syncActiveThemeToMain(theme: ThemeDefinition): void {
  try {
    Promise.resolve(window.clubhouse.app.syncActiveTheme({
      id: theme.id,
      type: theme.type,
      colors: theme.colors,
      terminal: theme.terminal,
      ...(theme.gradients ? { gradients: theme.gradients } : {}),
    })).catch((err: unknown) => {
      // Main rejected it (or isn't ready yet); phones keep the previous theme (#2472).
      rendererLog('core:theme', 'warn', 'Active theme sync failed', {
        meta: { themeId: theme.id, error: err instanceof Error ? err.message : String(err) },
      });
    });
  } catch {
    /* preload bridge not available yet — the next apply resyncs */
  }
}

/** Main-process side effects of applying a theme. */
function syncAppliedTheme(theme: ThemeDefinition): void {
  syncTitleBarOverlay(theme);
  syncActiveThemeToMain(theme);
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
      syncAppliedTheme(theme);
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
    syncAppliedTheme(theme);
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
    // themeId keeps the user's selection (same as loadTheme when a plugin theme isn't
    // registered yet): a pack refresh unregisters and re-registers its themes, and
    // overwriting themeId here would strand the user on the fallback (#2096).
    const fallback = BUILTIN_THEMES['catppuccin-mocha'];
    if (store.theme.id !== fallback.id) {
      try { localStorage.removeItem('clubhouse-theme-vars'); } catch { /* ignore */ }
      applyTheme(fallback, { experimentalGradients: store.experimentalGradients });
      syncAppliedTheme(fallback);
      useThemeStore.setState({ theme: fallback });
    }
  } else {
    // Theme is still registered — re-apply to pick up any variable changes from updated
    // plugin themes. applyTheme atomically re-writes the flash-prevention cache so it stays
    // consistent with the CSS variables that were just written to the document.
    applyTheme(currentTheme, { experimentalGradients: store.experimentalGradients });
    syncAppliedTheme(currentTheme);
    if (currentTheme !== store.theme) {
      // A previously unavailable theme is now registered, or the active one was
      // re-registered with new colours under the same id (a pack update, #2123):
      // update state to match the CSS, so getCurrent() and onDidChange follow.
      useThemeStore.setState({ theme: currentTheme });
    }
  }

  // Sync plugin themes to main process for MCP tool visibility
  syncPluginThemesToMain();
});
