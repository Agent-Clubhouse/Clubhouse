/**
 * Complete palettes for plugin and custom themes (#2472).
 *
 * A theme never fails for a missing or malformed color: plugin packs predate
 * `accent2` and `overlay*`, and a hand-written theme may declare only a few
 * colors. Each missing or non-color value is derived from related keys the
 * theme supplies, else filled from the built-in base for its type (Catppuccin
 * Latte for light, Mocha for dark). The renderer completes themes at
 * registration and main completes what the renderer syncs, so the desktop and
 * phones see the same full palette. Built-in themes are already complete and
 * come back as the same objects.
 */
import type { HljsColors, TerminalColors, ThemeColors } from './types';
import { catppuccinMocha } from '../renderer/themes/catppuccin-mocha';
import { catppuccinLatte } from '../renderer/themes/catppuccin-latte';

/** Untrusted colors (a palette type, or a string map off IPC): any key may be missing, empty or not a color. */
export type ColorsInput = object | null | undefined;

export interface ThemePalette {
  colors: ThemeColors;
  terminal: TerminalColors;
  hljs: HljsColors;
}

/** `#rgb`, `#rrggbb` or `#rrggbbaa`, the forms the renderer and phones parse. */
const COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** `value` as a color, or undefined when it isn't one. `#rgb` is expanded to `#rrggbb`. */
function asColor(value: unknown): string | undefined {
  if (typeof value !== 'string' || !COLOR_RE.test(value.trim())) return undefined;
  const v = value.trim();
  return v.length === 4 ? v.replace(/[0-9a-f]/gi, '$&$&') : v;
}

function channels(color: string): number[] {
  return [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
}

/** `from` moved `t` (0–1) of the way to `to`; both are colors (any alpha is dropped). */
export function mixColors(from: string, to: string, t: number): string {
  const a = channels(from);
  const b = channels(to);
  return `#${a.map((c, i) => Math.round(c + (b[i] - c) * t).toString(16).padStart(2, '0')).join('')}`;
}

/** Derive a key from `from`, which name ThemeColors keys. */
type Rule = readonly [from: readonly (keyof ThemeColors)[], derive: (c: ThemeColors) => string];

/** The UI colors rules derive from, and whether a key came from the theme (declared or derived). */
interface Source {
  colors: ThemeColors;
  fromTheme(key: keyof ThemeColors): boolean;
}

/**
 * The valid colors of `input`, plus every key of `base`: derived by its rule
 * when every source key came from the theme, else `base`'s value. Returns
 * `input` itself when it was already complete and valid. `source` is null
 * for the UI colors themselves, whose rules read the palette being built.
 */
function complete<T extends object>(
  input: ColorsInput,
  base: T,
  rules: Partial<Record<keyof T, Rule>>,
  source: Source | null,
): { value: T; source: Source } {
  const out: Record<string, string> = {};
  const fromTheme = new Set<string>();
  let changed = !input;
  for (const [key, value] of Object.entries(input ?? {})) {
    const color = asColor(value);
    if (color !== undefined) {
      out[key] = color;
      fromTheme.add(key);
    }
    if (color !== value) changed = true;
  }
  const self: Source = {
    colors: out as unknown as ThemeColors,
    fromTheme: (key) => (resolve(key), fromTheme.has(key)),
  };
  const src = source ?? self;
  function resolve(key: string): string {
    if (out[key] !== undefined) return out[key];
    changed = true;
    const rule = rules[key as keyof T];
    // fromTheme resolves each source first, so the rule can read them.
    if (rule && rule[0].every((k) => src.fromTheme(k))) {
      out[key] = rule[1](src.colors);
      fromTheme.add(key);
    } else {
      out[key] = (base as Record<string, string>)[key];
    }
    return out[key];
  }
  for (const key of Object.keys(base)) resolve(key);
  return { value: (changed ? out : input) as T, source: self };
}

const COLOR_RULES: Partial<Record<keyof ThemeColors, Rule>> = {
  subtext1: [['text', 'base'], (c) => mixColors(c.text, c.base, 0.1)],
  subtext0: [['text', 'base'], (c) => mixColors(c.text, c.base, 0.2)],
  surface0: [['base', 'text'], (c) => mixColors(c.base, c.text, 0.1)],
  surface1: [['surface0', 'text'], (c) => mixColors(c.surface0, c.text, 0.125)],
  surface2: [['surface0', 'text'], (c) => mixColors(c.surface0, c.text, 0.25)],
  link: [['accent'], (c) => c.accent],
  info: [['accent'], (c) => c.accent],
  accent2: [['accent'], (c) => c.accent],
  overlay0: [['surface2', 'subtext0'], (c) => mixColors(c.surface2, c.subtext0, 1 / 3)],
  overlay1: [['surface2', 'subtext0'], (c) => mixColors(c.surface2, c.subtext0, 2 / 3)],
  overlay: [['overlay1'], (c) => c.overlay1],
};

/** mantle and crust darken base: a lot on a dark theme, a little on a light one. */
function shadeRules(dark: boolean): Partial<Record<keyof ThemeColors, Rule>> {
  return {
    mantle: [['base'], (c) => mixColors(c.base, '#000000', dark ? 0.2 : 0.04)],
    crust: [['base'], (c) => mixColors(c.base, '#000000', dark ? 0.4 : 0.08)],
  };
}

/** Terminal keys with a UI color counterpart. */
const TERMINAL_RULES: Partial<Record<keyof TerminalColors, Rule>> = {
  background: [['base'], (c) => c.base],
  foreground: [['text'], (c) => c.text],
  cursor: [['accent'], (c) => c.accent],
  cursorAccent: [['base'], (c) => c.base],
  selectionBackground: [['surface2'], (c) => c.surface2],
  selectionForeground: [['text'], (c) => c.text],
  red: [['error'], (c) => c.error],
  green: [['success'], (c) => c.success],
  yellow: [['warning'], (c) => c.warning],
  blue: [['info'], (c) => c.info],
};

/** Syntax roles with a UI color counterpart. */
const HLJS_RULES: Partial<Record<keyof HljsColors, Rule>> = {
  keyword: [['accent2'], (c) => c.accent2],
  string: [['success'], (c) => c.success],
  number: [['warning'], (c) => c.warning],
  comment: [['overlay0'], (c) => c.overlay0],
  function: [['link'], (c) => c.link],
  variable: [['text'], (c) => c.text],
  addition: [['success'], (c) => c.success],
  deletion: [['error'], (c) => c.error],
  punctuation: [['overlay1'], (c) => c.overlay1],
};

/**
 * A full palette for a theme. Missing or malformed values are derived from
 * related keys the theme supplies, else taken from Latte (light) or Mocha:
 * - mantle, crust ← base, darkened
 * - subtext1, subtext0 ← text, stepping toward base
 * - surface0 ← base toward text; surface1, surface2 ← surface0 toward text
 * - link, info, accent2 ← accent
 * - overlay0, overlay1 ← a third and two thirds from surface2 to subtext0; overlay ← overlay1
 * - terminal and syntax colors ← their UI counterparts (background ← base, red ← error, comment ← overlay0, …)
 * success, warning and error have no counterpart and come from the base. Each
 * part that was already complete is returned as is.
 */
export function completeThemePalette(theme: {
  type?: string;
  colors?: ColorsInput;
  terminal?: ColorsInput;
  hljs?: ColorsInput;
}): ThemePalette {
  const dark = theme.type !== 'light';
  const base = dark ? catppuccinMocha : catppuccinLatte;
  const colors = complete(theme.colors, base.colors, { ...COLOR_RULES, ...shadeRules(dark) }, null);
  return {
    colors: colors.value,
    terminal: complete(theme.terminal, base.terminal, TERMINAL_RULES, colors.source).value,
    hljs: complete(theme.hljs, base.hljs, HLJS_RULES, colors.source).value,
  };
}
