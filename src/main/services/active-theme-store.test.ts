import { describe, it, expect, beforeEach } from 'vitest';
import { THEMES } from '../../renderer/themes';
import { _reset, getActiveTheme, resolveAnnexTheme, syncActiveTheme, validateActiveThemeSnapshot, type ActiveThemeSnapshot } from './active-theme-store';
import { NEON_CYBERPUNK_THEME } from '../../shared/__fixtures__/neon-cyberpunk-theme';

const mocha = THEMES['catppuccin-mocha'];
const workshop: ActiveThemeSnapshot = {
  id: 'plugin:workshop:forge',
  type: 'dark',
  colors: { ...mocha.colors, base: '#1a1410', accent: '#ff8800' },
  terminal: { ...mocha.terminal, background: '#1a1410' },
  gradients: { accent: 'linear-gradient(90deg, #ff8800, #ffcc00)' },
};

describe('active-theme-store', () => {
  beforeEach(() => _reset());

  it('starts empty', () => {
    expect(getActiveTheme()).toBeNull();
  });

  it('reports a change only when the synced theme differs', () => {
    expect(syncActiveTheme(workshop)).toBe(true);
    expect(syncActiveTheme({ ...workshop })).toBe(false);
    expect(syncActiveTheme({ ...workshop, colors: { ...workshop.colors, accent: '#00ff00' } })).toBe(true);
    expect(getActiveTheme()?.colors.accent).toBe('#00ff00');
  });
});

describe('resolveAnnexTheme', () => {
  it('uses the synced colors, terminal and gradients for the selected plugin theme', () => {
    expect(resolveAnnexTheme(workshop.id, workshop, THEMES)).toEqual({
      colors: workshop.colors,
      terminal: workshop.terminal,
      gradients: workshop.gradients,
    });
  });

  it('falls back to Mocha for a plugin theme the renderer has not synced', () => {
    expect(resolveAnnexTheme(workshop.id, null, THEMES)).toMatchObject({ colors: mocha.colors, terminal: mocha.terminal });
  });

  it('ignores a synced theme that is not the selected one', () => {
    const resolved = resolveAnnexTheme('catppuccin-latte', workshop, THEMES);
    expect(resolved.colors).toEqual(THEMES['catppuccin-latte'].colors);
    expect(resolved.terminal).toEqual(THEMES['catppuccin-latte'].terminal);
  });

  it('derives a missing synced terminal palette from the theme, the rest from the built-in', () => {
    const { terminal: _omit, ...noTerminal } = workshop;
    expect(resolveAnnexTheme(workshop.id, noTerminal, THEMES).terminal).toEqual({
      ...mocha.terminal,
      background: workshop.colors.base,
      cursor: workshop.colors.accent,
      cursorAccent: workshop.colors.base,
      foreground: mocha.colors.text,
      selectionBackground: mocha.colors.surface2,
      selectionForeground: mocha.colors.text,
      red: mocha.colors.error,
      green: mocha.colors.success,
      yellow: mocha.colors.warning,
      blue: mocha.colors.info,
    });
  });

  it('drops unknown and empty gradients', () => {
    expect(resolveAnnexTheme(workshop.id, { ...workshop, gradients: { glow: 'x', surface: '', accent: 'a' } }, THEMES).gradients)
      .toEqual({ accent: 'a' });
  });

  it('omits gradients when the theme defines none', () => {
    expect(resolveAnnexTheme(workshop.id, { ...workshop, gradients: {} }, THEMES)).not.toHaveProperty('gradients');
    expect(resolveAnnexTheme('catppuccin-mocha', null, THEMES).gradients).toEqual(mocha.gradients);
  });
});

describe('plugin pack themes without accent2/overlay* (#2472)', () => {
  const cyberpunk: ActiveThemeSnapshot = {
    id: 'plugin:neon-themes:cyberpunk',
    type: 'dark',
    colors: NEON_CYBERPUNK_THEME.colors,
    terminal: NEON_CYBERPUNK_THEME.terminal,
    gradients: NEON_CYBERPUNK_THEME.gradients,
  };

  it('passes validation', () => {
    expect(() => validateActiveThemeSnapshot(cyberpunk, 'theme')).not.toThrow();
  });

  it.each([
    ['colors with only base, text and accent', { base: '#101820', text: '#e0f0ff', accent: '#ff8800' }],
    ['empty colors', {}],
    ['malformed colors', { base: 'black', text: 3, accent: null }],
  ])('accepts %s', (_label, colors) => {
    expect(() => validateActiveThemeSnapshot({ ...cyberpunk, colors }, 'theme')).not.toThrow();
  });

  it.each([
    ['a missing id', { ...cyberpunk, id: '' }],
    ['an unknown type', { ...cyberpunk, type: 'sepia' }],
    ['colors that are not an object', { ...cyberpunk, colors: 'neon' }],
  ])('refuses a payload with %s', (_label, theme) => {
    expect(() => validateActiveThemeSnapshot(theme as ActiveThemeSnapshot, 'theme')).toThrow();
  });

  it('resolves a theme with only base, text and accent to a full palette', () => {
    const resolved = resolveAnnexTheme(cyberpunk.id, { ...cyberpunk, colors: { base: '#101820', text: '#e0f0ff', accent: '#ff8800' }, terminal: undefined }, THEMES);
    expect(Object.keys(resolved.colors).sort()).toEqual(Object.keys(mocha.colors).sort());
    expect(Object.keys(resolved.terminal).sort()).toEqual(Object.keys(mocha.terminal).sort());
    expect(resolved.colors).toMatchObject({ base: '#101820', text: '#e0f0ff', accent: '#ff8800', accent2: '#ff8800' });
  });

  it('resolves empty light colors to Latte', () => {
    const resolved = resolveAnnexTheme(cyberpunk.id, { id: cyberpunk.id, type: 'light', colors: {} }, THEMES);
    expect(resolved.colors).toEqual(THEMES['catppuccin-latte'].colors);
    expect(resolved.terminal).toEqual(THEMES['catppuccin-latte'].terminal);
  });

  it.each(Object.keys(THEMES))('resolves built-in %s unchanged', (id) => {
    const resolved = resolveAnnexTheme(id, null, THEMES);
    expect(resolved.colors).toBe(THEMES[id].colors);
    expect(resolved.terminal).toBe(THEMES[id].terminal);
  });

  it('resolves with the derived colors', () => {
    expect(resolveAnnexTheme(cyberpunk.id, cyberpunk, THEMES).colors).toEqual({
      ...NEON_CYBERPUNK_THEME.colors,
      accent2: '#ff2090',
      overlay: '#5d5d83',
      overlay0: '#434365',
      overlay1: '#5d5d83',
    });
  });
});
