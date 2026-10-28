/**
 * Fallbacks for the ThemeColors a theme may leave out (#2472).
 *
 * Plugin theme packs predate `accent2` and `overlay*`, and declare only the
 * essential colors. Registration fills the rest so the renderer's CSS vars,
 * the main-process sync and Annex phones all see a complete palette. Built-in
 * themes declare every key, so they pass through unchanged.
 */
import type { ThemeColors } from './types';

/** The ThemeColors keys a theme must declare: nothing derives them. */
export const ESSENTIAL_THEME_COLOR_KEYS = [
  'base', 'mantle', 'crust', 'text', 'subtext0', 'subtext1', 'surface0', 'surface1', 'surface2',
  'accent', 'link', 'warning', 'error', 'info', 'success',
] as const satisfies ReadonlyArray<keyof ThemeColors>;

type EssentialKey = (typeof ESSENTIAL_THEME_COLOR_KEYS)[number];

/** A palette with the essential keys; the derivable ones may be missing. */
export type ThemeColorsInput = Pick<ThemeColors, EssentialKey> & Partial<ThemeColors>;

/** The essential keys `colors` lacks (missing or empty). */
export function missingEssentialColors(colors: Partial<Record<keyof ThemeColors, unknown>>): EssentialKey[] {
  return ESSENTIAL_THEME_COLOR_KEYS.filter((key) => typeof colors[key] !== 'string' || !colors[key]);
}

function parseHex(color: string | undefined): [number, number, number] | null {
  const m = typeof color === 'string' ? /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim()) : null;
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].replace(/./g, '$&$&') : m[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

/** `from` moved `t` (0–1) of the way to `to`. Falls back to `from` when either isn't hex. */
export function mixHex(from: string, to: string, t: number): string {
  const a = parseHex(from);
  const b = parseHex(to);
  if (!a || !b) return from;
  return `#${a.map((c, i) => Math.round(c + (b[i] - c) * t).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * `colors` with any missing derivable key filled in, following Catppuccin's
 * ramp (surface2 → overlay0 → overlay1 → subtext0):
 * - `accent2` ← `accent`
 * - `overlay0` ← a third of the way from `surface2` to `subtext0`
 * - `overlay1` ← two thirds of the way
 * - `overlay` ← `overlay1` (as in the built-ins)
 * Declared keys are kept as they are; a complete palette is returned as is.
 */
export function withColorFallbacks(colors: ThemeColorsInput): ThemeColors {
  if (colors.accent2 && colors.overlay && colors.overlay0 && colors.overlay1) return colors as ThemeColors;
  const overlay0 = colors.overlay0 || mixHex(colors.surface2, colors.subtext0, 1 / 3);
  const overlay1 = colors.overlay1 || mixHex(colors.surface2, colors.subtext0, 2 / 3);
  return {
    ...colors,
    accent2: colors.accent2 || colors.accent,
    overlay: colors.overlay || overlay1,
    overlay0,
    overlay1,
  };
}
