/**
 * Contrast floors for built-in themes (#2753), as WCAG 2 contrast ratios.
 *
 * Every built-in theme meets the gate: primary text and the four notification
 * colors at 4.5:1 against `base` (WCAG AA for normal text).
 *
 * The Workshop pack themes (`./packs`) and the gradient themes
 * (`./gradient-themes.ts`, #2916) also meet the secondary, syntax and
 * terminal floors below. Each is checked against its usual background and
 * every color stop of the theme's background gradient: gradients are on by
 * default, and then the app's base, code blocks and terminals go transparent
 * over the gradient. The original nine built-ins aren't held to these: their
 * lowest values are Solarized Dark's link and accent (4.08), subtext0 (3.37),
 * and Catppuccin Latte's syntax colors (string 2.96, type 2.31).
 *
 * A pack color that missed a floor was moved in OKLCH lightness only, keeping
 * its hue (and chroma where sRGB allows), just far enough to pass with a 0.05
 * margin. Dimmer roles keep low floors on purpose: overlays and comments are
 * meant to recede.
 */

/** The gate every built-in theme meets, against `base`. */
export const TEXT_GATE = 4.5;

/** Secondary UI floors for pack themes, against `base` and the background gradient's stops. */
export const UI_FLOORS = {
  text: 4.5,
  warning: 4.5,
  error: 4.5,
  info: 4.5,
  success: 4.5,
  subtext1: 4.5,
  link: 4.5,
  subtext0: 3,
  accent: 3,
  accent2: 3,
  overlay1: 2.5,
  overlay: 2.5,
  overlay0: 1.8,
} as const;

/** Syntax colors for pack themes, against `base`, `mantle` (code blocks sit on either) and the gradient stops. */
export const SYNTAX_FLOOR = 3;
/** Comments are meant to recede; this is the original built-ins' lowest comment. */
export const SYNTAX_COMMENT_FLOOR = 2.3;

/**
 * Terminal colors for pack themes, against the terminal background and the
 * gradient stops (terminals are transparent over a gradient). Black and
 * bright black are background shades, and on light themes white and bright
 * white are too, so they have no floor.
 */
export const TERMINAL_FOREGROUND_FLOOR = 4.5;
export const TERMINAL_COLOR_FLOOR = 3;
export const TERMINAL_COLOR_KEYS = [
  'cursor', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan',
  'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan',
] as const;
export const TERMINAL_DARK_ONLY_KEYS = ['white', 'brightWhite'] as const;

function relativeLuminance(hex: string): number {
  const h = hex.replace('#', '').slice(0, 6);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2 contrast ratio of two `#rrggbb` colors (any alpha is ignored). */
export function contrastRatio(a: string, b: string): number {
  const x = relativeLuminance(a);
  const y = relativeLuminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** The `#rrggbb` color stops of a CSS gradient. */
export function gradientStops(gradient: string | undefined): string[] {
  return gradient ? (gradient.match(/#[0-9a-fA-F]{6}\b/g) ?? []) : [];
}
