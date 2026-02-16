import { describe, it, expect } from 'vitest';
import { THEMES, THEME_IDS } from './index';
import { ThemeId } from '../../shared/types';

describe('theme registry', () => {
  it('exports all 8 themes', () => {
    expect(THEME_IDS).toHaveLength(8);
    expect(Object.keys(THEMES)).toHaveLength(8);
  });

  it('contains all expected theme IDs', () => {
    const expected: ThemeId[] = [
      'catppuccin-mocha',
      'catppuccin-latte',
      'solarized-dark',
      'terminal',
      'nord',
      'dracula',
      'tokyo-night',
      'gruvbox-dark',
    ];
    for (const id of expected) {
      expect(THEMES[id]).toBeDefined();
    }
  });

  it('each theme has required properties', () => {
    for (const [id, theme] of Object.entries(THEMES)) {
      expect(theme.id).toBe(id);
      expect(theme.name).toBeTruthy();
      expect(theme.type).toMatch(/^(dark|light)$/);
    }
  });

  it('catppuccin-latte is the only light theme', () => {
    const lightThemes = THEME_IDS.filter((id) => THEMES[id].type === 'light');
    expect(lightThemes).toEqual(['catppuccin-latte']);
  });

  it('terminal theme has a fontOverride', () => {
    expect(THEMES['terminal'].fontOverride).toBeTruthy();
  });

  it('non-terminal themes do not have fontOverride', () => {
    for (const id of THEME_IDS) {
      if (id !== 'terminal') {
        expect(THEMES[id].fontOverride).toBeUndefined();
      }
    }
  });

  describe('theme colors', () => {
    const requiredColorKeys = [
      'base', 'mantle', 'crust', 'text', 'subtext0', 'subtext1',
      'surface0', 'surface1', 'surface2', 'accent', 'link',
    ];

    for (const id of ['catppuccin-mocha', 'catppuccin-latte', 'solarized-dark', 'terminal', 'nord', 'dracula', 'tokyo-night', 'gruvbox-dark'] as ThemeId[]) {
      it(`${id} has all required color keys`, () => {
        const colors = THEMES[id].colors;
        for (const key of requiredColorKeys) {
          expect(colors).toHaveProperty(key);
          expect((colors as any)[key]).toMatch(/^#[0-9a-fA-F]{6}$/);
        }
      });
    }
  });

  describe('theme hljs', () => {
    const requiredHljsKeys = [
      'keyword', 'string', 'number', 'comment', 'function', 'type',
      'variable', 'regexp', 'tag', 'attribute', 'symbol', 'meta',
      'addition', 'deletion', 'property', 'punctuation',
    ];

    for (const id of THEME_IDS) {
      it(`${id} has all required hljs keys`, () => {
        const hljs = THEMES[id].hljs;
        for (const key of requiredHljsKeys) {
          expect(hljs).toHaveProperty(key);
          expect((hljs as any)[key]).toMatch(/^#[0-9a-fA-F]{6}$/);
        }
      });
    }
  });

  describe('theme terminal', () => {
    const requiredTerminalKeys = [
      'background', 'foreground', 'cursor', 'cursorAccent',
      'selectionBackground', 'selectionForeground',
      'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
      'brightBlack', 'brightRed', 'brightGreen', 'brightYellow',
      'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
    ];

    for (const id of THEME_IDS) {
      it(`${id} has all required terminal keys`, () => {
        const terminal = THEMES[id].terminal;
        for (const key of requiredTerminalKeys) {
          expect(terminal).toHaveProperty(key);
          // Terminal colors can include alpha (e.g. selectionBackground: '#585b7066')
          expect((terminal as any)[key]).toMatch(/^#[0-9a-fA-F]{6,8}$/);
        }
      });
    }
  });

  describe('catppuccin-mocha default values match original hardcoded values', () => {
    const mocha = THEMES['catppuccin-mocha'];

    it('base colors match original CSS values', () => {
      expect(mocha.colors.base).toBe('#1e1e2e');
      expect(mocha.colors.mantle).toBe('#181825');
      expect(mocha.colors.crust).toBe('#11111b');
      expect(mocha.colors.text).toBe('#cdd6f4');
      expect(mocha.colors.subtext0).toBe('#a6adc8');
      expect(mocha.colors.subtext1).toBe('#bac2de');
      expect(mocha.colors.surface0).toBe('#313244');
      expect(mocha.colors.surface1).toBe('#45475a');
      expect(mocha.colors.surface2).toBe('#585b70');
    });

    it('terminal colors match original CATPPUCCIN_THEME constant', () => {
      expect(mocha.terminal.background).toBe('#1e1e2e');
      expect(mocha.terminal.foreground).toBe('#cdd6f4');
      expect(mocha.terminal.cursor).toBe('#f5e0dc');
      expect(mocha.terminal.red).toBe('#f38ba8');
      expect(mocha.terminal.green).toBe('#a6e3a1');
      expect(mocha.terminal.blue).toBe('#89b4fa');
    });
  });
});
