import { describe, it, expect } from 'vitest';
import { BUILTIN_THEMES } from '../renderer/themes';
import { ESSENTIAL_THEME_COLOR_KEYS, missingEssentialColors, mixHex, withColorFallbacks } from './theme-colors';
import { NEON_CYBERPUNK_THEME } from './__fixtures__/neon-cyberpunk-theme';

const packColors = NEON_CYBERPUNK_THEME.colors;

describe('withColorFallbacks (#2472)', () => {
  it('derives accent2 and overlay* for a pack theme that omits them', () => {
    expect(withColorFallbacks(packColors)).toEqual({
      ...packColors,
      accent2: '#ff2090',
      overlay: '#5d5d83',
      overlay0: '#434365',
      overlay1: '#5d5d83',
    });
  });

  it('keeps the colors a theme declares', () => {
    const declared = { ...packColors, accent2: '#00ffff', overlay: '#111111', overlay0: '#222222', overlay1: '#333333' };
    expect(withColorFallbacks(declared)).toBe(declared);
  });

  it.each(Object.entries(BUILTIN_THEMES))('leaves built-in %s unchanged', (_id, theme) => {
    expect(withColorFallbacks(theme.colors)).toBe(theme.colors);
  });

  it("falls back to surface2 when a ramp color isn't hex", () => {
    const colors = withColorFallbacks({ ...packColors, surface2: 'rgb(40, 40, 72)' });
    expect(colors.overlay0).toBe('rgb(40, 40, 72)');
    expect(colors.overlay1).toBe('rgb(40, 40, 72)');
  });
});

describe('mixHex', () => {
  it('mixes 3- and 6-digit hex', () => {
    expect(mixHex('#000', '#ffffff', 0.5)).toBe('#808080');
    expect(mixHex('#282848', '#7878a0', 0)).toBe('#282848');
    expect(mixHex('#282848', '#7878A0', 1)).toBe('#7878a0');
  });
});

describe('missingEssentialColors', () => {
  it('is empty for a pack theme that lacks only derivable keys', () => {
    expect(missingEssentialColors(packColors)).toEqual([]);
  });

  it('lists missing, empty and non-string essential keys', () => {
    expect(missingEssentialColors({ ...packColors, base: undefined, text: '', accent: 3 })).toEqual(['base', 'text', 'accent']);
  });

  it('every built-in declares every essential key', () => {
    for (const theme of Object.values(BUILTIN_THEMES)) expect(missingEssentialColors(theme.colors)).toEqual([]);
    expect(ESSENTIAL_THEME_COLOR_KEYS).not.toContain('overlay0');
  });
});
