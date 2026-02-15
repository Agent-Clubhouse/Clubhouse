import type { ThemeDefinition } from '../../../../shared/types';

function stripHash(hex: string): string {
  return hex.replace(/^#/, '');
}

interface IStandaloneThemeData {
  base: 'vs' | 'vs-dark' | 'hc-black';
  inherit: boolean;
  rules: Array<{ token: string; foreground?: string; fontStyle?: string }>;
  colors: Record<string, string>;
}

export function generateMonacoTheme(theme: ThemeDefinition): IStandaloneThemeData {
  const base = theme.type === 'light' ? 'vs' : 'vs-dark';

  return {
    base,
    inherit: true,
    rules: [
      { token: 'keyword', foreground: stripHash(theme.hljs.keyword) },
      { token: 'keyword.control', foreground: stripHash(theme.hljs.keyword) },
      { token: 'string', foreground: stripHash(theme.hljs.string) },
      { token: 'string.escape', foreground: stripHash(theme.hljs.string) },
      { token: 'number', foreground: stripHash(theme.hljs.number) },
      { token: 'number.float', foreground: stripHash(theme.hljs.number) },
      { token: 'comment', foreground: stripHash(theme.hljs.comment), fontStyle: 'italic' },
      { token: 'comment.line', foreground: stripHash(theme.hljs.comment), fontStyle: 'italic' },
      { token: 'comment.block', foreground: stripHash(theme.hljs.comment), fontStyle: 'italic' },
      { token: 'type', foreground: stripHash(theme.hljs.type) },
      { token: 'type.identifier', foreground: stripHash(theme.hljs.type) },
      { token: 'identifier', foreground: stripHash(theme.hljs.variable) },
      { token: 'variable', foreground: stripHash(theme.hljs.variable) },
      { token: 'regexp', foreground: stripHash(theme.hljs.regexp) },
      { token: 'tag', foreground: stripHash(theme.hljs.tag) },
      { token: 'attribute.name', foreground: stripHash(theme.hljs.attribute) },
      { token: 'attribute.value', foreground: stripHash(theme.hljs.string) },
      { token: 'metatag', foreground: stripHash(theme.hljs.meta) },
      { token: 'annotation', foreground: stripHash(theme.hljs.meta) },
      { token: 'delimiter', foreground: stripHash(theme.hljs.punctuation) },
      { token: 'delimiter.bracket', foreground: stripHash(theme.hljs.punctuation) },
      { token: 'operator', foreground: stripHash(theme.hljs.keyword) },
      { token: '', foreground: stripHash(theme.colors.text) },
    ],
    colors: {
      'editor.background': theme.colors.base,
      'editor.foreground': theme.colors.text,
      'editor.selectionBackground': theme.colors.surface2,
      'editor.lineHighlightBackground': theme.colors.surface0,
      'editorCursor.foreground': theme.colors.accent,
      'editorLineNumber.foreground': theme.colors.subtext0,
      'editorLineNumber.activeForeground': theme.colors.text,
      'editorIndentGuide.background': theme.colors.surface0,
      'editorIndentGuide.activeBackground': theme.colors.surface1,
      'editor.selectionHighlightBackground': theme.colors.surface1,
      'editorBracketMatch.background': theme.colors.surface1,
      'editorBracketMatch.border': theme.colors.surface2,
      'editorWidget.background': theme.colors.mantle,
      'editorWidget.border': theme.colors.surface0,
      'input.background': theme.colors.surface0,
      'input.foreground': theme.colors.text,
      'input.border': theme.colors.surface1,
      'focusBorder': theme.colors.accent,
      'list.highlightForeground': theme.colors.accent,
      'scrollbarSlider.background': theme.colors.surface1 + '80',
      'scrollbarSlider.hoverBackground': theme.colors.surface2 + '80',
      'scrollbarSlider.activeBackground': theme.colors.surface2,
    },
  };
}
