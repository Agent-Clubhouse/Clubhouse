import { BuiltinThemeId, ThemeId, ThemeDefinition } from '../../shared/types';
import { catppuccinMocha } from './catppuccin-mocha';
import { catppuccinLatte } from './catppuccin-latte';
import { solarizedDark } from './solarized-dark';
import { terminalTheme } from './terminal';
import { nord } from './nord';
import { dracula } from './dracula';
import { tokyoNight } from './tokyo-night';
import { gruvboxDark } from './gruvbox-dark';

/** Built-in themes — static, never mutated. */
export const BUILTIN_THEMES: Record<BuiltinThemeId, ThemeDefinition> = {
  'catppuccin-mocha': catppuccinMocha,
  'catppuccin-latte': catppuccinLatte,
  'solarized-dark': solarizedDark,
  'terminal': terminalTheme,
  'nord': nord,
  'dracula': dracula,
  'tokyo-night': tokyoNight,
  'gruvbox-dark': gruvboxDark,
};

/** Dynamic theme registry — includes builtins plus plugin-contributed themes. */
const themeRegistry = new Map<ThemeId, ThemeDefinition>(
  Object.entries(BUILTIN_THEMES) as [ThemeId, ThemeDefinition][],
);

/** Callbacks notified when the registry changes. */
const registryListeners = new Set<() => void>();

/** Subscribe to registry changes (theme added/removed). */
export function onRegistryChange(callback: () => void): { dispose: () => void } {
  registryListeners.add(callback);
  return { dispose: () => registryListeners.delete(callback) };
}

function notifyListeners(): void {
  for (const listener of registryListeners) {
    listener();
  }
}

/** Register a plugin-contributed theme. */
export function registerTheme(theme: ThemeDefinition): void {
  themeRegistry.set(theme.id, theme);
  notifyListeners();
}

/** Unregister a plugin-contributed theme. */
export function unregisterTheme(themeId: ThemeId): void {
  // Never remove builtin themes
  if (themeId in BUILTIN_THEMES) return;
  themeRegistry.delete(themeId);
  notifyListeners();
}

/** Get a theme by ID from the registry. */
export function getTheme(id: ThemeId): ThemeDefinition | undefined {
  return themeRegistry.get(id);
}

/** Get all registered theme IDs (builtins + plugins). */
export function getAllThemeIds(): ThemeId[] {
  return Array.from(themeRegistry.keys());
}

/** Get all registered themes as a record. */
export function getAllThemes(): Record<ThemeId, ThemeDefinition> {
  return Object.fromEntries(themeRegistry) as Record<ThemeId, ThemeDefinition>;
}

// ── Backward compatibility ─────────────────────────────────────────────
// Existing code imports THEMES and THEME_IDS — keep them as getters.

/** @deprecated Use getAllThemes() or getTheme() for dynamic registry. */
export const THEMES = BUILTIN_THEMES as Record<ThemeId, ThemeDefinition>;

/** @deprecated Use getAllThemeIds() for dynamic registry. */
export const THEME_IDS = Object.keys(BUILTIN_THEMES) as ThemeId[];
