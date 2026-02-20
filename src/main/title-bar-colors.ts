/**
 * Maps theme IDs to their native window chrome colors.
 * - bg: BrowserWindow background color (prevents flash on startup)
 * - mantle: title bar overlay background (matches the custom title bar)
 * - text: title bar overlay symbol/icon color (min/max/close buttons)
 */
export const THEME_TITLE_BAR_COLORS: Record<string, { bg: string; mantle: string; text: string }> = {
  'catppuccin-mocha': { bg: '#1e1e2e', mantle: '#181825', text: '#cdd6f4' },
  'catppuccin-latte': { bg: '#eff1f5', mantle: '#e6e9ef', text: '#4c4f69' },
  'solarized-dark':   { bg: '#002b36', mantle: '#001f27', text: '#839496' },
  'terminal':         { bg: '#0a0a0a', mantle: '#050505', text: '#00ff00' },
  'nord':             { bg: '#2e3440', mantle: '#272c36', text: '#d8dee9' },
  'dracula':          { bg: '#282a36', mantle: '#1e1f29', text: '#f8f8f2' },
  'tokyo-night':      { bg: '#1a1b26', mantle: '#16161e', text: '#a9b1d6' },
  'gruvbox-dark':     { bg: '#282828', mantle: '#1d2021', text: '#ebdbb2' },
};

const DEFAULT_COLORS = THEME_TITLE_BAR_COLORS['catppuccin-mocha'];

export function getThemeColorsForTitleBar(themeId: string): { bg: string; mantle: string; text: string } {
  return THEME_TITLE_BAR_COLORS[themeId] || DEFAULT_COLORS;
}
