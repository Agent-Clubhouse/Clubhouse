import { describe, it, expect, beforeEach } from 'vitest';
import { THEMES } from '../../renderer/themes';
import { _reset, getActiveTheme, resolveAnnexTheme, syncActiveTheme, type ActiveThemeSnapshot } from './active-theme-store';

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

  it('fills a missing synced terminal palette from the built-in', () => {
    const { terminal: _omit, ...noTerminal } = workshop;
    expect(resolveAnnexTheme(workshop.id, noTerminal, THEMES).terminal).toEqual(mocha.terminal);
  });

  it('omits gradients when the theme defines none', () => {
    expect(resolveAnnexTheme(workshop.id, { ...workshop, gradients: {} }, THEMES)).not.toHaveProperty('gradients');
    expect(resolveAnnexTheme('catppuccin-mocha', null, THEMES).gradients).toEqual(mocha.gradients);
  });
});
