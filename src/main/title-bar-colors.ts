import { BUILTIN_THEMES } from '../renderer/themes';

/**
 * Maps theme IDs to their native window chrome colors.
 * - bg: BrowserWindow background color (prevents flash on startup)
 * - mantle: title bar overlay background (matches the custom title bar)
 * - text: title bar overlay symbol/icon color (min/max/close buttons)
 */
export const THEME_TITLE_BAR_COLORS: Record<string, { bg: string; mantle: string; text: string }> = Object.fromEntries(
  // Read from the built-in themes, so a new built-in (#2753) can't start with the wrong chrome.
  Object.values(BUILTIN_THEMES).map((t) => [t.id, { bg: t.colors.base, mantle: t.colors.mantle, text: t.colors.text }]),
);

const DEFAULT_COLORS = THEME_TITLE_BAR_COLORS['catppuccin-mocha'];

export function getThemeColorsForTitleBar(themeId: string): { bg: string; mantle: string; text: string } {
  return THEME_TITLE_BAR_COLORS[themeId] || DEFAULT_COLORS;
}
