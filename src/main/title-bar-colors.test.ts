import { describe, it, expect } from 'vitest';
import { THEME_TITLE_BAR_COLORS, getThemeColorsForTitleBar } from './title-bar-colors';

describe('THEME_TITLE_BAR_COLORS', () => {
  const expectedThemeIds = [
    'catppuccin-mocha',
    'catppuccin-latte',
    'solarized-dark',
    'terminal',
    'nord',
    'dracula',
    'tokyo-night',
    'gruvbox-dark',
  ];

  it('has an entry for every supported theme', () => {
    for (const id of expectedThemeIds) {
      expect(THEME_TITLE_BAR_COLORS[id]).toBeDefined();
    }
  });

  it('each entry has bg, mantle, and text as valid hex colors', () => {
    const hexPattern = /^#[0-9a-fA-F]{6}$/;
    for (const [id, colors] of Object.entries(THEME_TITLE_BAR_COLORS)) {
      expect(colors.bg, `${id}.bg`).toMatch(hexPattern);
      expect(colors.mantle, `${id}.mantle`).toMatch(hexPattern);
      expect(colors.text, `${id}.text`).toMatch(hexPattern);
    }
  });

  it('mantle color differs from bg for all themes', () => {
    for (const id of expectedThemeIds) {
      const { bg, mantle } = THEME_TITLE_BAR_COLORS[id];
      expect(mantle, `${id}: mantle should differ from bg`).not.toBe(bg);
    }
  });

  it('catppuccin-mocha colors match expected values', () => {
    const mocha = THEME_TITLE_BAR_COLORS['catppuccin-mocha'];
    expect(mocha.bg).toBe('#1e1e2e');
    expect(mocha.mantle).toBe('#181825');
    expect(mocha.text).toBe('#cdd6f4');
  });

  it('catppuccin-latte (light theme) has light bg and dark text', () => {
    const latte = THEME_TITLE_BAR_COLORS['catppuccin-latte'];
    // Light theme bg should have high RGB values
    const bgR = parseInt(latte.bg.slice(1, 3), 16);
    expect(bgR).toBeGreaterThan(200);
    // Light theme text should have lower RGB values (dark text)
    const textR = parseInt(latte.text.slice(1, 3), 16);
    expect(textR).toBeLessThan(128);
  });
});

describe('getThemeColorsForTitleBar', () => {
  it('returns colors for a known theme', () => {
    const colors = getThemeColorsForTitleBar('dracula');
    expect(colors.bg).toBe('#282a36');
    expect(colors.mantle).toBe('#1e1f29');
    expect(colors.text).toBe('#f8f8f2');
  });

  it('returns catppuccin-mocha colors for unknown theme id', () => {
    const colors = getThemeColorsForTitleBar('nonexistent-theme');
    expect(colors).toEqual(THEME_TITLE_BAR_COLORS['catppuccin-mocha']);
  });

  it('returns catppuccin-mocha colors for empty string', () => {
    const colors = getThemeColorsForTitleBar('');
    expect(colors).toEqual(THEME_TITLE_BAR_COLORS['catppuccin-mocha']);
  });
});
