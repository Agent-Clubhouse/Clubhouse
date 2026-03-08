import { generateMonacoTheme } from './monaco-theme';
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
