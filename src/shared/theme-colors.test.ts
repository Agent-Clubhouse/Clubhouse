import { describe, it, expect } from 'vitest';
import { BUILTIN_THEMES } from '../renderer/themes';
import { completeThemePalette, mixColors } from './theme-colors';
import { NEON_CYBERPUNK_THEME } from './__fixtures__/neon-cyberpunk-theme';

const mocha = BUILTIN_THEMES['catppuccin-mocha'];
const latte = BUILTIN_THEMES['catppuccin-latte'];
const HEX = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i;

function expectFull(palette: object, keys: object): void {
  for (const key of Object.keys(keys)) expect((palette as Record<string, string>)[key], key).toMatch(HEX);
}

describe('completeThemePalette (#2472)', () => {
  it.each(Object.entries(BUILTIN_THEMES))('returns built-in %s unchanged', (_id, theme) => {
    const palette = completeThemePalette(theme);
    expect(palette.colors).toBe(theme.colors);
    expect(palette.terminal).toBe(theme.terminal);
    expect(palette.hljs).toBe(theme.hljs);
  });

  it('derives accent2 and overlay* for a pack theme that omits them, keeping the rest', () => {
    const palette = completeThemePalette(NEON_CYBERPUNK_THEME);
    expect(palette.colors).toEqual({
      ...NEON_CYBERPUNK_THEME.colors,
      accent2: '#ff2090',
      overlay: '#5d5d83',
      overlay0: '#434365',
      overlay1: '#5d5d83',
    });
    expect(palette.terminal).toBe(NEON_CYBERPUNK_THEME.terminal);
    expect(palette.hljs).toBe(NEON_CYBERPUNK_THEME.hljs);
  });

  it('derives a full palette from only base, text and accent', () => {
    const base = '#101820';
    const text = '#e0f0ff';
    const accent = '#ff8800';
    const { colors, terminal, hljs } = completeThemePalette({ type: 'dark', colors: { base, text, accent } });
    expectFull(colors, mocha.colors);
    expectFull(terminal, mocha.terminal);
    expectFull(hljs, mocha.hljs);
    expect(colors).toMatchObject({
      base, text, accent,
      mantle: mixColors(base, '#000000', 0.2),
      crust: mixColors(base, '#000000', 0.4),
      subtext0: mixColors(text, base, 0.2),
      surface0: mixColors(base, text, 0.1),
      link: accent, info: accent, accent2: accent,
      // No counterpart: from the dark base.
      success: mocha.colors.success, warning: mocha.colors.warning, error: mocha.colors.error,
    });
    expect(colors.overlay0).toBe(mixColors(colors.surface2, colors.subtext0, 1 / 3));
    expect(terminal).toMatchObject({ background: base, foreground: text, cursor: accent, red: mocha.terminal.red, magenta: mocha.terminal.magenta });
    expect(hljs).toMatchObject({ keyword: accent, variable: text, comment: colors.overlay0, string: mocha.hljs.string });
  });

  it.each([
    ['dark', mocha],
    ['light', latte],
  ] as const)('fills an empty %s theme with its base palette', (type, base) => {
    expect(completeThemePalette({ type, colors: {} })).toEqual({ colors: base.colors, terminal: base.terminal, hljs: base.hljs });
  });

  it('treats malformed values like missing ones', () => {
    const { colors, terminal } = completeThemePalette({
      type: 'dark',
      colors: { ...NEON_CYBERPUNK_THEME.colors, base: 'cyber-black', text: 42, accent: '', link: 'rgb(0, 216, 255)' },
      terminal: { ...NEON_CYBERPUNK_THEME.terminal, red: 'red' },
    });
    expect(colors).toMatchObject({ base: mocha.colors.base, text: mocha.colors.text, accent: mocha.colors.accent, link: mocha.colors.link });
    expect(colors.mantle).toBe(NEON_CYBERPUNK_THEME.colors.mantle);
    expect(terminal.red).toBe(NEON_CYBERPUNK_THEME.colors.error);
  });

  it('expands #rgb and keeps #rrggbbaa', () => {
    const { colors, terminal } = completeThemePalette({
      type: 'dark',
      colors: { ...NEON_CYBERPUNK_THEME.colors, accent: '#f09' },
      terminal: { ...NEON_CYBERPUNK_THEME.terminal, selectionBackground: '#28284866' },
    });
    expect(colors.accent).toBe('#ff0099');
    expect(terminal.selectionBackground).toBe('#28284866');
  });

  it('copes with no colors at all', () => {
    expect(completeThemePalette({}).colors).toEqual(mocha.colors);
  });
});

describe('mixColors', () => {
  it('mixes hex colors, ignoring alpha', () => {
    expect(mixColors('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(mixColors('#282848', '#7878A0', 1)).toBe('#7878a0');
    expect(mixColors('#28284866', '#7878a0', 0)).toBe('#282848');
  });
});
