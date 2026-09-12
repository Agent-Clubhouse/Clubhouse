import { describe, it, expect, vi } from 'vitest';
import { generateMonacoTheme, registerAllMonacoThemes, applyMonacoTheme, monacoThemeName } from './monaco-theme';
import { registerTheme, unregisterTheme, BUILTIN_THEMES } from '../../../themes';
import type { ThemeDefinition } from '../../../../shared/types';

const mockTheme: ThemeDefinition = {
  id: 'test-dark' as any,
  name: 'Test Dark',
  type: 'dark',
  colors: {
    base: '#1e1e2e',
    mantle: '#181825',
    crust: '#11111b',
    text: '#cdd6f4',
    subtext0: '#a6adc8',
    subtext1: '#bac2de',
    surface0: '#313244',
    surface1: '#45475a',
    surface2: '#585b70',
    accent: '#89b4fa',
    link: '#89b4fa',
    warning: '#f9e2af',
    error: '#f38ba8',
    info: '#89b4fa',
    success: '#a6e3a1',
  },
  hljs: {
    keyword: '#cba6f7',
    string: '#a6e3a1',
    number: '#fab387',
    comment: '#6c7086',
    function: '#89b4fa',
    type: '#f9e2af',
    variable: '#cdd6f4',
    regexp: '#f5c2e7',
    tag: '#89b4fa',
    attribute: '#f9e2af',
    symbol: '#f2cdcd',
    meta: '#f5c2e7',
    punctuation: '#bac2de',
  },
  terminal: {} as any,
};

describe('generateMonacoTheme', () => {
  it('generates find widget colors from theme definition', () => {
    const result = generateMonacoTheme(mockTheme);

    // Find match highlight (current match)
    expect(result.colors['editor.findMatchBackground']).toBe('#89b4fa40');
    expect(result.colors['editor.findMatchBorder']).toBe('#89b4fa');

    // Find match highlight (other matches)
    expect(result.colors['editor.findMatchHighlightBackground']).toBe('#585b7080');
    expect(result.colors['editor.findMatchHighlightBorder']).toBe('#585b70');

    // Search in selection range highlight
    expect(result.colors['editor.findRangeHighlightBackground']).toBe('#45475a40');

    // Scrollbar gutter marks for find matches
    expect(result.colors['editorOverviewRuler.findMatchForeground']).toBe('#89b4faA0');

    // Toggle button colors (case sensitive, whole word, regex)
    expect(result.colors['inputOption.activeBackground']).toBe('#89b4fa40');
    expect(result.colors['inputOption.activeForeground']).toBe('#cdd6f4');
    expect(result.colors['inputOption.activeBorder']).toBe('#89b4fa');
    expect(result.colors['inputOption.hoverBackground']).toBe('#45475a');
  });

  it('uses vs-dark base for dark themes', () => {
    const result = generateMonacoTheme(mockTheme);
    expect(result.base).toBe('vs-dark');
  });

  it('uses vs base for light themes', () => {
    const lightTheme = { ...mockTheme, type: 'light' as const };
    const result = generateMonacoTheme(lightTheme);
    expect(result.base).toBe('vs');
  });
});

function mockMonaco() {
  return { editor: { defineTheme: vi.fn(), setTheme: vi.fn() } };
}

describe('registerAllMonacoThemes', () => {
  it('defines a Monaco theme for every builtin theme', () => {
    const m = mockMonaco();
    registerAllMonacoThemes(m);
    for (const id of Object.keys(BUILTIN_THEMES)) {
      expect(m.editor.defineTheme).toHaveBeenCalledWith(`clubhouse-${id}`, expect.anything());
    }
  });

  it('also defines plugin-contributed themes (the bug fix)', () => {
    const pluginTheme: ThemeDefinition = { ...mockTheme, id: 'plugin-dark' as any, name: 'Plugin Dark' };
    registerTheme(pluginTheme);
    try {
      const m = mockMonaco();
      registerAllMonacoThemes(m);
      // Without this, plugin themes were never defined in Monaco, so selecting
      // one fell back to Monaco's default light theme (white editor).
      expect(m.editor.defineTheme).toHaveBeenCalledWith('clubhouse-plugin-dark', expect.anything());
    } finally {
      unregisterTheme('plugin-dark' as any);
    }
  });
});

describe('applyMonacoTheme', () => {
  it('defines the theme before applying it so plugin themes resolve', () => {
    const pluginTheme: ThemeDefinition = { ...mockTheme, id: 'plugin-apply' as any, name: 'Plugin Apply' };
    registerTheme(pluginTheme);
    try {
      const m = mockMonaco();
      applyMonacoTheme(m, 'plugin-apply');
      expect(m.editor.defineTheme).toHaveBeenCalledWith('clubhouse-plugin-apply', expect.anything());
      expect(m.editor.setTheme).toHaveBeenCalledWith('clubhouse-plugin-apply');
    } finally {
      unregisterTheme('plugin-apply' as any);
    }
  });

  it('still applies a theme id that is not in the registry', () => {
    const m = mockMonaco();
    applyMonacoTheme(m, 'catppuccin-mocha');
    expect(m.editor.setTheme).toHaveBeenCalledWith('clubhouse-catppuccin-mocha');
  });
});

// ── Monaco theme-name legality ───────────────────────────────────────
//
// Regression coverage for the "Loading editor…" hang: Monaco rejects any theme
// name that is not /^[a-z0-9\-]+$/i, and plugin themes are namespaced
// `plugin:<pluginId>:<themeId>`. The old code passed that id straight to
// defineTheme, which threw, rejected ensureThemes(), and left every Monaco
// surface on its loading placeholder forever.

/** Mock that enforces Monaco's real theme-name validation. */
function strictMockMonaco() {
  const assertLegal = (name: string) => {
    if (!/^[a-z0-9-]+$/i.test(name)) throw new Error('Illegal theme name!');
  };
  return {
    editor: {
      defineTheme: vi.fn((name: string) => assertLegal(name)),
      setTheme: vi.fn((name: string) => assertLegal(name)),
    },
  };
}

describe('monacoThemeName', () => {
  it('leaves already-legal ids untouched', () => {
    expect(monacoThemeName('catppuccin-mocha')).toBe('clubhouse-catppuccin-mocha');
  });

  it('produces a Monaco-legal name for namespaced plugin theme ids', () => {
    const name = monacoThemeName('plugin:fall-themes:maple');
    expect(name).toMatch(/^[a-z0-9-]+$/i);
    expect(name.startsWith('clubhouse-plugin-fall-themes-maple-')).toBe(true);
  });

  it('is stable across calls', () => {
    const id = 'plugin:winter-themes:frost';
    expect(monacoThemeName(id)).toBe(monacoThemeName(id));
  });

  it('does not collide when two distinct ids sanitise to the same string', () => {
    expect(monacoThemeName('plugin:a:b')).not.toBe(monacoThemeName('plugin-a-b'));
  });
});

describe('plugin themes with namespaced ids', () => {
  const PLUGIN_ID = 'plugin:fall-themes:maple';

  it('registerAllMonacoThemes registers every builtin even with a namespaced plugin theme present', () => {
    registerTheme({ ...mockTheme, id: PLUGIN_ID as any, name: 'Maple' });
    try {
      const m = strictMockMonaco();
      expect(() => registerAllMonacoThemes(m)).not.toThrow();
      for (const id of Object.keys(BUILTIN_THEMES)) {
        expect(m.editor.defineTheme).toHaveBeenCalledWith(`clubhouse-${id}`, expect.anything());
      }
      expect(m.editor.defineTheme).toHaveBeenCalledWith(monacoThemeName(PLUGIN_ID), expect.anything());
    } finally {
      unregisterTheme(PLUGIN_ID as any);
    }
  });

  it('applyMonacoTheme applies a namespaced plugin theme without throwing', () => {
    registerTheme({ ...mockTheme, id: PLUGIN_ID as any, name: 'Maple' });
    try {
      const m = strictMockMonaco();
      expect(() => applyMonacoTheme(m, PLUGIN_ID)).not.toThrow();
      expect(m.editor.setTheme).toHaveBeenCalledWith(monacoThemeName(PLUGIN_ID));
    } finally {
      unregisterTheme(PLUGIN_ID as any);
    }
  });

  it('a theme that Monaco still rejects does not stop the other themes registering', () => {
    const m = strictMockMonaco();
    // Force a rejection for one specific name to simulate a future bad theme.
    m.editor.defineTheme = vi.fn((name: string) => {
      if (name === 'clubhouse-terminal') throw new Error('Illegal theme name!');
    });
    expect(() => registerAllMonacoThemes(m)).not.toThrow();
    expect(m.editor.defineTheme).toHaveBeenCalledWith('clubhouse-catppuccin-mocha', expect.anything());
  });
});
