import { ThemeId, ThemeDefinition } from '../../shared/types';
import { catppuccinMocha } from './catppuccin-mocha';
import { catppuccinLatte } from './catppuccin-latte';
import { solarizedDark } from './solarized-dark';
import { terminalTheme } from './terminal';
import { nord } from './nord';
import { dracula } from './dracula';
import { tokyoNight } from './tokyo-night';
import { gruvboxDark } from './gruvbox-dark';

export const THEMES: Record<ThemeId, ThemeDefinition> = {
  'catppuccin-mocha': catppuccinMocha,
  'catppuccin-latte': catppuccinLatte,
  'solarized-dark': solarizedDark,
  'terminal': terminalTheme,
  'nord': nord,
  'dracula': dracula,
  'tokyo-night': tokyoNight,
  'gruvbox-dark': gruvboxDark,
};

export const THEME_IDS = Object.keys(THEMES) as ThemeId[];
