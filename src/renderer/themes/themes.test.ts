import { describe, it, expect, afterEach } from 'vitest';
import { GRADIENT_THEMES } from './gradient-themes';
import { THEMES, THEME_IDS, PACK_THEMES, registerTheme, unregisterTheme, getTheme, getAllThemeIds, onRegistryChange } from './index';
import {
  SYNTAX_COMMENT_FLOOR, SYNTAX_FLOOR, TERMINAL_COLOR_FLOOR, TERMINAL_COLOR_KEYS, TERMINAL_DARK_ONLY_KEYS,
  TERMINAL_FOREGROUND_FLOOR, UI_FLOORS, gradientStops, contrastRatio as floorRatio, onAccentColor,
} from './theme-contrast';
import { ThemeId, ThemeDefinition } from '../../shared/types';
import { NEON_CYBERPUNK_THEME } from '../../shared/__fixtures__/neon-cyberpunk-theme';

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
  it('exports all 48 themes: the original nine, four gradient themes (#2916) and 35 from the Workshop packs (#2753)', () => {
    expect(THEME_IDS).toHaveLength(48);
    expect(Object.keys(THEMES)).toHaveLength(48);
    expect(GRADIENT_THEMES).toHaveLength(4);
    expect(PACK_THEMES).toHaveLength(35);
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
      expect(theme.name).toBeDefined();
      expect(theme.type).toMatch(/^(dark|light)$/);
    }
  });

  it('catppuccin-latte is the only light theme among the original nine', () => {
    const lightThemes = THEME_IDS.filter((id) => THEMES[id].type === 'light' && !THEMES[id].collection);
    expect(lightThemes).toEqual(['catppuccin-latte']);
  });

  it('terminal theme has a fontOverride', () => {
    expect(THEMES['terminal'].fontOverride).toBeDefined();
  });

  it('non-terminal, non-cyberpunk themes do not have fontOverride', () => {
    const themesWithFontOverride = new Set(['terminal', 'cyberpunk']);
    for (const id of THEME_IDS) {
      if (!themesWithFontOverride.has(id)) {
        expect(THEMES[id].fontOverride).toBeUndefined();
      }
    }
  });

  describe('theme colors', () => {
    const requiredColorKeys = [
      'base', 'mantle', 'crust', 'text', 'subtext0', 'subtext1',
      'surface0', 'surface1', 'surface2', 'accent', 'link',
      'warning', 'error', 'info', 'success', 'accent2', 'overlay', 'overlay0', 'overlay1',
    ];

    for (const id of THEME_IDS) {
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

describe('Workshop pack themes (#2753)', () => {
  const COLLECTIONS = ['Fall', 'Winter', 'Spring', 'Summer', 'Ocean', 'Tech Modern', 'Neon'];

  it('are 35 new, unique ids in seven collections of five, none replacing an original', () => {
    const ids = PACK_THEMES.map((t) => t.id);
    expect(new Set(ids).size).toBe(35);
    expect(ids).not.toContain('cyberpunk');
    expect(THEMES['cyberpunk'].collection).toBeUndefined();
    for (const name of COLLECTIONS) expect(PACK_THEMES.filter((t) => t.collection === name)).toHaveLength(5);
    for (const t of PACK_THEMES) expect(THEMES[t.id]).toBe(t);
  });

  it('gives the Neon pack\'s Cyberpunk its own id and name', () => {
    const neon = THEMES['neon-cyberpunk'];
    expect(neon.name).toBe('Neon Cyberpunk');
    expect(neon.collection).toBe('Neon');
    expect(new Set(THEME_IDS.map((id) => THEMES[id].name)).size).toBe(48);
  });

  it('has no two themes with the same palette', () => {
    const palettes = THEME_IDS.map((id) => JSON.stringify([THEMES[id].colors, THEMES[id].hljs, THEMES[id].terminal]));
    expect(new Set(palettes).size).toBe(48);
  });

  it('keeps each dimmer step dimmer: overlay0 <= overlay1 <= subtext0 in contrast', () => {
    for (const t of [...GRADIENT_THEMES, ...PACK_THEMES]) {
      const c = t.colors;
      const r = (k: keyof typeof c) => floorRatio(c[k]!, c.base);
      expect(r('overlay0'), `${t.id} overlay0`).toBeLessThanOrEqual(r('overlay1') + 0.01);
      expect(r('overlay1'), `${t.id} overlay1`).toBeLessThanOrEqual(r('subtext0') + 0.01);
    }
  });

  // The gradient themes (#2916) are held to the same floors.
  for (const t of [...GRADIENT_THEMES, ...PACK_THEMES]) {
    describe(t.id, () => {
      // With gradients on (the default) the background gradient replaces base, so text must read on every stop.
      const backdrops = [t.colors.base, ...gradientStops(t.gradients?.background)];

      it('meets the UI floors against base and every background gradient stop', () => {
        for (const [key, floor] of Object.entries(UI_FLOORS)) {
          for (const bg of backdrops) {
            expect(floorRatio(t.colors[key as keyof typeof UI_FLOORS], bg), `${key} on ${bg}`).toBeGreaterThanOrEqual(floor);
          }
        }
      });

      // Code blocks and terminals go transparent over the gradient too, so they're checked on its stops as well.
      const stops = gradientStops(t.gradients?.background);

      it('meets the syntax floors against base, mantle and every background gradient stop', () => {
        for (const [key, color] of Object.entries(t.hljs)) {
          const floor = key === 'comment' ? SYNTAX_COMMENT_FLOOR : SYNTAX_FLOOR;
          for (const bg of [t.colors.base, t.colors.mantle, ...stops]) {
            expect(floorRatio(color, bg), `${key} on ${bg}`).toBeGreaterThanOrEqual(floor);
          }
        }
      });

      it('meets the terminal floors against the terminal background and every background gradient stop', () => {
        const keys = [...TERMINAL_COLOR_KEYS, ...(t.type === 'dark' ? TERMINAL_DARK_ONLY_KEYS : [])];
        for (const bg of [t.terminal.background, ...stops]) {
          expect(floorRatio(t.terminal.foreground, bg), `foreground on ${bg}`).toBeGreaterThanOrEqual(TERMINAL_FOREGROUND_FLOOR);
          for (const key of keys) expect(floorRatio(t.terminal[key], bg), `${key} on ${bg}`).toBeGreaterThanOrEqual(TERMINAL_COLOR_FLOOR);
        }
      });
    });
  }
});

describe('text on the accent (#3086)', () => {
  it('picks whichever of crust, text and white reads best on the accent', () => {
    expect(onAccentColor({ accent: '#5ee6a8', crust: '#050e14', text: '#e3f1ef' })).toBe('#050e14');
    expect(onAccentColor({ accent: '#1e66f5', crust: '#dce0e8', text: '#4c4f69' })).toBe('#ffffff');
    expect(onAccentColor({ accent: '#e0a060', crust: '#f2e8dc', text: '#3a2a2a' })).toBe('#3a2a2a');
  });

  it('reads at 3:1 or better on every built-in, never worse than the white it replaced', () => {
    for (const id of THEME_IDS) {
      const { colors } = THEMES[id];
      const onAccent = floorRatio(onAccentColor(colors), colors.accent);
      expect(onAccent, id).toBeGreaterThanOrEqual(3);
      expect(onAccent, id).toBeGreaterThanOrEqual(floorRatio('#ffffff', colors.accent));
    }
  });
});

describe('gradient themes (#2916)', () => {
  it('are four built-ins in their own collection, dark and light, after the originals', () => {
    expect(GRADIENT_THEMES.map((t) => t.id)).toEqual(['aurora', 'canyon', 'daybreak', 'mist']);
    for (const t of GRADIENT_THEMES) {
      expect(THEMES[t.id]).toBe(t);
      expect(t.collection).toBe('Gradients');
    }
    expect(GRADIENT_THEMES.filter((t) => t.type === 'dark').map((t) => t.id)).toEqual(['aurora', 'canyon']);
    expect(GRADIENT_THEMES.filter((t) => t.type === 'light').map((t) => t.id)).toEqual(['daybreak', 'mist']);
    expect(THEME_IDS.indexOf('aurora')).toBe(9);
  });

  it('are designed around a background gradient of at least three stops, and no font or glow', () => {
    for (const t of GRADIENT_THEMES) {
      expect(gradientStops(t.gradients?.background).length, t.id).toBeGreaterThanOrEqual(3);
      expect(t.fonts, t.id).toBeUndefined();
      expect(t.fontOverride, t.id).toBeUndefined();
      expect(JSON.stringify(t.gradients), t.id).not.toMatch(/shadow|blur|glow/);
    }
  });

  it('keep the gradient close to base, so turning gradients off changes the mood, not the reading', () => {
    // Every stop sits within a small lightness step of base, so a flat base reads like the gradient.
    // Readability itself is the floors above, which every color meets on every stop.
    for (const t of GRADIENT_THEMES) {
      for (const stop of gradientStops(t.gradients?.background)) {
        expect(floorRatio(stop, t.colors.base), `${t.id} ${stop}`).toBeLessThan(1.5);
      }
    }
  });
});

describe('registerTheme color fallbacks (#2472)', () => {
  const id = 'plugin:neon-themes:cyberpunk' as ThemeId;
  afterEach(() => unregisterTheme(id));

  it('derives the colors a pack theme omits', () => {
    registerTheme({ ...NEON_CYBERPUNK_THEME, id } as unknown as ThemeDefinition);
    expect(getTheme(id)?.colors).toMatchObject({
      ...NEON_CYBERPUNK_THEME.colors,
      accent2: '#ff2090',
      overlay: '#5d5d83',
      overlay0: '#434365',
      overlay1: '#5d5d83',
    });
  });

  it('completes a theme with only base, text and accent, and no terminal or syntax colors', () => {
    registerTheme({ id, name: 'Minimal', type: 'light', colors: { base: '#fafafa', text: '#202020', accent: '#0066cc' } } as unknown as ThemeDefinition);
    const theme = getTheme(id)!;
    expect(Object.keys(theme.colors).sort()).toEqual(Object.keys(THEMES['catppuccin-latte'].colors).sort());
    expect(theme.colors).toMatchObject({ base: '#fafafa', accent2: '#0066cc', error: THEMES['catppuccin-latte'].colors.error });
    expect(theme.terminal).toMatchObject({ background: '#fafafa', foreground: '#202020' });
    expect(theme.hljs).toMatchObject({ keyword: '#0066cc', variable: '#202020' });
  });

  it('stores a complete theme as is', () => {
    const complete = { ...THEMES.dracula, id };
    registerTheme(complete);
    expect(getTheme(id)).toBe(complete);
  });
});
