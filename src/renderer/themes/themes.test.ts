import { describe, it, expect, afterEach } from 'vitest';
import { THEMES, THEME_IDS, registerTheme, unregisterTheme, getTheme, getAllThemeIds, onRegistryChange } from './index';
import { ThemeId, ThemeDefinition } from '../../shared/types';

/**
 * Convert a hex color (#rrggbb) to its WCAG relative luminance.
 * See https://www.w3.org/TR/WCAG20/#relativeluminancedef
 */
function relativeLuminance(hex: string): number {
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16) / 255;
  const g = parseInt(h.substring(2, 4), 16) / 255;
  const b = parseInt(h.substring(4, 6), 16) / 255;
  const toLinear = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/**
 * WCAG 2.0 contrast ratio between two colors.
 * Returns a value >= 1 (identical colors = 1).
 */
function contrastRatio(hex1: string, hex2: string): number {
  const l1 = relativeLuminance(hex1);
  const l2 = relativeLuminance(hex2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

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
      'warning', 'error', 'info', 'success',
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

  describe('WCAG AA contrast compliance', () => {
    // WCAG AA requires 4.5:1 for normal text, 3:1 for large text.
    // Notification text in banners and badges is normal-size, so we require 4.5:1.
    const WCAG_AA_NORMAL = 4.5;

    const notificationColorKeys = ['warning', 'error', 'info', 'success'] as const;

    for (const id of THEME_IDS) {
      describe(`${id}`, () => {
        const theme = THEMES[id];

        for (const key of notificationColorKeys) {
          it(`${key} text meets WCAG AA contrast (>= ${WCAG_AA_NORMAL}:1) against base`, () => {
            const fg = theme.colors[key];
            const bg = theme.colors.base;
            const ratio = contrastRatio(fg, bg);
            expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL);
          });
        }

        it('primary text meets WCAG AA contrast against base', () => {
          const ratio = contrastRatio(theme.colors.text, theme.colors.base);
          expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL);
        });
      });
    }
  });

  describe('dynamic theme registry', () => {
    const pluginTheme: ThemeDefinition = {
      id: 'plugin:test:cherry-blossom',
      name: 'Cherry Blossom',
      type: 'light',
      colors: { base: '#fef6f8', mantle: '#fceef2', crust: '#fae5ec', text: '#3d2233', subtext0: '#846b78', subtext1: '#6e5462', surface0: '#f5d5df', surface1: '#f0c5d2', surface2: '#e8b3c3', accent: '#d4728a', link: '#c4607a', warning: '#b8892e', error: '#c44d5e', info: '#6b8fb8', success: '#5d9068' },
      hljs: { keyword: '#b85e8a', string: '#5d9068', number: '#c07838', comment: '#b0a0a8', function: '#6b8fb8', type: '#b8892e', variable: '#3d2233', regexp: '#d4728a', tag: '#6b8fb8', attribute: '#4e9898', symbol: '#b85e8a', meta: '#8b6e9e', addition: '#5d9068', deletion: '#c44d5e', property: '#4e9898', punctuation: '#6e5462' },
      terminal: { background: '#fef6f8', foreground: '#3d2233', cursor: '#d4728a', cursorAccent: '#fef6f8', selectionBackground: '#f0c5d2', selectionForeground: '#3d2233', black: '#3d2233', red: '#c44d5e', green: '#5d9068', yellow: '#b8892e', blue: '#6b8fb8', magenta: '#b85e8a', cyan: '#4e9898', white: '#fae5ec', brightBlack: '#846b78', brightRed: '#d45e70', brightGreen: '#6ea078', brightYellow: '#c89a40', brightBlue: '#7ba0c8', brightMagenta: '#c86e9a', brightCyan: '#60a8a8', brightWhite: '#fef6f8' },
    };

    afterEach(() => {
      // Clean up any registered plugin themes
      unregisterTheme('plugin:test:cherry-blossom');
    });

    it('registerTheme adds a plugin theme to the registry', () => {
      registerTheme(pluginTheme);
      expect(getTheme('plugin:test:cherry-blossom')).toBeDefined();
      expect(getTheme('plugin:test:cherry-blossom')?.name).toBe('Cherry Blossom');
    });

    it('unregisterTheme removes a plugin theme', () => {
      registerTheme(pluginTheme);
      unregisterTheme('plugin:test:cherry-blossom');
      expect(getTheme('plugin:test:cherry-blossom')).toBeUndefined();
    });

    it('unregisterTheme does not remove builtin themes', () => {
      unregisterTheme('catppuccin-mocha');
      expect(getTheme('catppuccin-mocha')).toBeDefined();
    });

    it('getAllThemeIds includes plugin themes', () => {
      registerTheme(pluginTheme);
      const ids = getAllThemeIds();
      expect(ids).toContain('plugin:test:cherry-blossom');
      expect(ids).toContain('catppuccin-mocha');
    });

    it('onRegistryChange fires when a theme is registered', () => {
      let called = false;
      const sub = onRegistryChange(() => { called = true; });
      registerTheme(pluginTheme);
      expect(called).toBe(true);
      sub.dispose();
    });

    it('onRegistryChange fires when a theme is unregistered', () => {
      registerTheme(pluginTheme);
      let called = false;
      const sub = onRegistryChange(() => { called = true; });
      unregisterTheme('plugin:test:cherry-blossom');
      expect(called).toBe(true);
      sub.dispose();
    });
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
