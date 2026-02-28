import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ThemeDefinition } from '../../shared/types';

// Mock DOM environment
const mockSetProperty = vi.fn();
const mockClassList = { add: vi.fn(), remove: vi.fn() };
const mockLocalStorage = new Map<string, string>();

// Set up globals before importing
Object.defineProperty(globalThis, 'document', {
  value: {
    documentElement: {
      style: { setProperty: mockSetProperty },
      classList: mockClassList,
    },
  },
  writable: true,
});

Object.defineProperty(globalThis, 'localStorage', {
  value: {
    setItem: (key: string, value: string) => mockLocalStorage.set(key, value),
    getItem: (key: string) => mockLocalStorage.get(key) ?? null,
    removeItem: (key: string) => mockLocalStorage.delete(key),
  },
  writable: true,
});

import { applyTheme } from './apply-theme';

function makeTheme(overrides?: Partial<ThemeDefinition>): ThemeDefinition {
  return {
    id: 'mocha' as any,
    name: 'Mocha',
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
      accent: '#cba6f7',
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
      tag: '#f38ba8',
      attribute: '#89b4fa',
      symbol: '#f2cdcd',
      meta: '#f5c2e7',
      addition: '#a6e3a1',
      deletion: '#f38ba8',
      property: '#89dceb',
      punctuation: '#bac2de',
    },
    terminal: {
      background: '#1e1e2e',
      foreground: '#cdd6f4',
      cursor: '#f5e0dc',
      cursorAccent: '#1e1e2e',
      selectionBackground: '#585b70',
      selectionForeground: '#cdd6f4',
      black: '#45475a',
      red: '#f38ba8',
      green: '#a6e3a1',
      yellow: '#f9e2af',
      blue: '#89b4fa',
      magenta: '#f5c2e7',
      cyan: '#94e2d5',
      white: '#bac2de',
      brightBlack: '#585b70',
      brightRed: '#f38ba8',
      brightGreen: '#a6e3a1',
      brightYellow: '#f9e2af',
      brightBlue: '#89b4fa',
      brightMagenta: '#f5c2e7',
      brightCyan: '#94e2d5',
      brightWhite: '#a6adc8',
    },
    ...overrides,
  };
}

describe('applyTheme', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLocalStorage.clear();
  });

  describe('color CSS variables', () => {
    it('sets all 15 color CSS variables as space-separated RGB channels', () => {
      applyTheme(makeTheme());

      // --ctp-base = #1e1e2e → "30 30 46"
      expect(mockSetProperty).toHaveBeenCalledWith('--ctp-base', '30 30 46');
      // --ctp-text = #cdd6f4 → "205 214 244"
      expect(mockSetProperty).toHaveBeenCalledWith('--ctp-text', '205 214 244');
      // --ctp-accent = #cba6f7 → "203 166 247"
      expect(mockSetProperty).toHaveBeenCalledWith('--ctp-accent', '203 166 247');
    });

    it('converts pure white (#ffffff) correctly', () => {
      const theme = makeTheme();
      theme.colors.text = '#ffffff';
      applyTheme(theme);

      expect(mockSetProperty).toHaveBeenCalledWith('--ctp-text', '255 255 255');
    });

    it('converts pure black (#000000) correctly', () => {
      const theme = makeTheme();
      theme.colors.base = '#000000';
      applyTheme(theme);

      expect(mockSetProperty).toHaveBeenCalledWith('--ctp-base', '0 0 0');
    });
  });

  describe('hljs CSS variables', () => {
    it('sets all 16 hljs CSS variables as raw hex values', () => {
      applyTheme(makeTheme());

      // hljs vars should be set as hex, not RGB channels
      expect(mockSetProperty).toHaveBeenCalledWith('--hljs-keyword', '#cba6f7');
      expect(mockSetProperty).toHaveBeenCalledWith('--hljs-string', '#a6e3a1');
      expect(mockSetProperty).toHaveBeenCalledWith('--hljs-number', '#fab387');
      expect(mockSetProperty).toHaveBeenCalledWith('--hljs-comment', '#6c7086');
      expect(mockSetProperty).toHaveBeenCalledWith('--hljs-function', '#89b4fa');
      expect(mockSetProperty).toHaveBeenCalledWith('--hljs-punctuation', '#bac2de');
    });
  });

  describe('font override', () => {
    it('adds theme-mono class and stores font when fontOverride is set', () => {
      const theme = makeTheme({ fontOverride: 'JetBrains Mono' });
      applyTheme(theme);

      expect(mockClassList.add).toHaveBeenCalledWith('theme-mono');
      expect(mockLocalStorage.get('clubhouse-theme-font')).toBe('JetBrains Mono');
    });

    it('removes theme-mono class and clears font when no fontOverride', () => {
      applyTheme(makeTheme());

      expect(mockClassList.remove).toHaveBeenCalledWith('theme-mono');
      expect(mockLocalStorage.has('clubhouse-theme-font')).toBe(false);
    });

    it('clears previous font override when switching to theme without one', () => {
      // First apply with override
      applyTheme(makeTheme({ fontOverride: 'Fira Code' }));
      expect(mockLocalStorage.get('clubhouse-theme-font')).toBe('Fira Code');

      // Then apply without override
      applyTheme(makeTheme());
      expect(mockLocalStorage.has('clubhouse-theme-font')).toBe(false);
    });
  });

  describe('localStorage cache', () => {
    it('caches all CSS variables to localStorage for flash prevention', () => {
      applyTheme(makeTheme());

      const cached = JSON.parse(mockLocalStorage.get('clubhouse-theme-vars')!);
      // Should include both color (RGB) and hljs (hex) vars
      expect(cached['--ctp-base']).toBe('30 30 46');
      expect(cached['--hljs-keyword']).toBe('#cba6f7');
    });

    it('overwrites previous cache on theme change', () => {
      applyTheme(makeTheme());
      const first = mockLocalStorage.get('clubhouse-theme-vars');

      const theme2 = makeTheme();
      theme2.colors.base = '#ffffff';
      applyTheme(theme2);

      const second = mockLocalStorage.get('clubhouse-theme-vars');
      expect(second).not.toBe(first);
      const cached = JSON.parse(second!);
      expect(cached['--ctp-base']).toBe('255 255 255');
    });
  });

  describe('total variable count', () => {
    it('sets exactly 31 CSS variables (15 colors + 16 hljs)', () => {
      applyTheme(makeTheme());
      expect(mockSetProperty).toHaveBeenCalledTimes(31);
    });
  });
});
