/**
 * Main-process copy of the theme the renderer has applied.
 *
 * Plugin and custom themes live only in the renderer's registry, so main
 * can't look their colors up by id. The renderer pushes the resolved theme
 * here whenever it applies one, and Annex sends phones those colors instead
 * of falling back to Catppuccin Mocha (the same pattern as plugin-theme-store).
 */
import type { TerminalColors, ThemeColors, ThemeDefinition, ThemeGradients } from '../../shared/types';

export interface ActiveThemeSnapshot {
  id: string;
  type: 'dark' | 'light';
  colors: ThemeColors;
  terminal?: TerminalColors;
  gradients?: ThemeGradients;
}

/** What Annex sends phones for the selected theme. */
export interface AnnexTheme {
  colors: ThemeColors;
  terminal: TerminalColors;
  /** Only when the theme defines at least one gradient. */
  gradients?: ThemeGradients;
}

const FALLBACK_THEME_ID = 'catppuccin-mocha';

let activeTheme: ActiveThemeSnapshot | null = null;

/** Store the renderer's applied theme. Returns true when it differs from the last one. */
export function syncActiveTheme(theme: ActiveThemeSnapshot): boolean {
  const changed = JSON.stringify(theme) !== JSON.stringify(activeTheme);
  activeTheme = theme;
  return changed;
}

export function getActiveTheme(): ActiveThemeSnapshot | null {
  return activeTheme;
}

function nonEmptyGradients(gradients: ThemeGradients | undefined): ThemeGradients | undefined {
  return gradients && Object.values(gradients).some((g) => typeof g === 'string' && g) ? gradients : undefined;
}

/**
 * The synced theme when it is the selected one, else the built-in for the id
 * (Mocha for an unknown id). A synced theme that is not the selected one is
 * stale or a fallback the renderer applied while a plugin theme loads.
 */
export function resolveAnnexTheme(
  selectedId: string,
  synced: ActiveThemeSnapshot | null,
  builtins: Record<string, ThemeDefinition>,
): AnnexTheme {
  const builtin = builtins[selectedId] ?? builtins[FALLBACK_THEME_ID];
  if (synced && synced.id === selectedId) {
    const gradients = nonEmptyGradients(synced.gradients);
    return {
      colors: synced.colors,
      terminal: synced.terminal ?? builtin.terminal,
      ...(gradients ? { gradients } : {}),
    };
  }
  const gradients = nonEmptyGradients(builtin.gradients);
  return { colors: builtin.colors, terminal: builtin.terminal, ...(gradients ? { gradients } : {}) };
}

/** The ThemeColors keys a phone needs; the rest of ThemeColors is optional. */
const REQUIRED_COLOR_KEYS: ReadonlyArray<keyof ThemeColors> = [
  'base', 'mantle', 'crust', 'text', 'subtext0', 'subtext1', 'surface0', 'surface1', 'surface2',
  'accent', 'link', 'warning', 'error', 'info', 'success', 'accent2', 'overlay', 'overlay0', 'overlay1',
];
const GRADIENT_KEYS: ReadonlyArray<keyof ThemeGradients> = ['background', 'surface', 'accent'];

function assertStringRecord(value: unknown, name: string): asserts value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
  for (const [key, v] of Object.entries(value)) {
    if (typeof v !== 'string') throw new Error(`${name}.${key} must be a string`);
  }
}

/** IPC validation for SYNC_ACTIVE_THEME (withValidatedArgs' objectArg validate). */
export function validateActiveThemeSnapshot(v: ActiveThemeSnapshot, name: string): void {
  if (typeof v.id !== 'string' || !v.id) throw new Error(`${name}.id must be a non-empty string`);
  if (v.type !== 'dark' && v.type !== 'light') throw new Error(`${name}.type must be 'dark' or 'light'`);
  assertStringRecord(v.colors, `${name}.colors`);
  for (const key of REQUIRED_COLOR_KEYS) {
    if (!v.colors[key]) throw new Error(`${name}.colors.${key} must be a non-empty string`);
  }
  if (v.terminal !== undefined) assertStringRecord(v.terminal, `${name}.terminal`);
  if (v.gradients !== undefined) {
    assertStringRecord(v.gradients, `${name}.gradients`);
    for (const key of Object.keys(v.gradients)) {
      if (!GRADIENT_KEYS.includes(key as keyof ThemeGradients)) throw new Error(`${name}.gradients.${key} is not a known gradient`);
    }
  }
}

/** Reset store state — useful for testing. */
export function _reset(): void {
  activeTheme = null;
}
