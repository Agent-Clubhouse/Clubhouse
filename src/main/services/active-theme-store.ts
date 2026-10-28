/**
 * Main-process copy of the theme the renderer has applied.
 *
 * Plugin and custom themes live only in the renderer's registry, so main
 * can't look their colors up by id. The renderer pushes the resolved theme
 * here whenever it applies one, and Annex sends phones those colors instead
 * of falling back to Catppuccin Mocha (the same pattern as plugin-theme-store).
 */
import type { TerminalColors, ThemeColors, ThemeDefinition, ThemeGradients } from '../../shared/types';
import { completeThemePalette, type ColorsInput } from '../../shared/theme-colors';

export interface ActiveThemeSnapshot {
  id: string;
  type: 'dark' | 'light';
  /** Any key may be missing or malformed: resolveAnnexTheme completes them (#2472). */
  colors: ColorsInput;
  terminal?: ColorsInput;
  gradients?: object;
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

const GRADIENT_KEYS: ReadonlyArray<keyof ThemeGradients> = ['background', 'surface', 'accent'];

/** The known, non-empty gradients, or undefined when there are none. */
function nonEmptyGradients(gradients: object | undefined): ThemeGradients | undefined {
  const g = (gradients ?? {}) as Record<string, unknown>;
  const known = GRADIENT_KEYS.filter((key) => typeof g[key] === 'string' && g[key]);
  return known.length ? Object.fromEntries(known.map((key) => [key, g[key]])) as ThemeGradients : undefined;
}

/**
 * The synced theme when it is the selected one, completed so a phone always
 * gets a full palette (#2472); else the built-in for the id (Mocha for an
 * unknown id). A synced theme that is not the selected one is stale or a
 * fallback the renderer applied while a plugin theme loads.
 */
export function resolveAnnexTheme(
  selectedId: string,
  synced: ActiveThemeSnapshot | null,
  builtins: Record<string, ThemeDefinition>,
): AnnexTheme {
  const theme = synced && synced.id === selectedId ? synced : builtins[selectedId] ?? builtins[FALLBACK_THEME_ID];
  const { colors, terminal } = completeThemePalette(theme);
  const gradients = nonEmptyGradients(theme.gradients);
  return { colors, terminal, ...(gradients ? { gradients } : {}) };
}

function assertObject(value: unknown, name: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
}

/**
 * IPC validation for SYNC_ACTIVE_THEME (withValidatedArgs' objectArg validate).
 * Checks only the shape: missing or malformed colors and gradients are
 * completed or dropped by resolveAnnexTheme, never refused (#2472).
 */
export function validateActiveThemeSnapshot(v: ActiveThemeSnapshot, name: string): void {
  if (typeof v.id !== 'string' || !v.id) throw new Error(`${name}.id must be a non-empty string`);
  if (v.type !== 'dark' && v.type !== 'light') throw new Error(`${name}.type must be 'dark' or 'light'`);
  assertObject(v.colors, `${name}.colors`);
  if (v.terminal !== undefined) assertObject(v.terminal, `${name}.terminal`);
  if (v.gradients !== undefined) assertObject(v.gradients, `${name}.gradients`);
}

/** Reset store state — useful for testing. */
export function _reset(): void {
  activeTheme = null;
}
