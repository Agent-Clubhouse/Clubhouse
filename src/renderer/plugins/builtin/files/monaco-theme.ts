import type { ThemeDefinition } from '../../../../shared/types';
import { getAllThemes, getTheme, onRegistryChange } from '../../../themes';

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

      // Find widget
      'editor.findMatchBackground': theme.colors.accent + '40',
      'editor.findMatchBorder': theme.colors.accent,
      'editor.findMatchHighlightBackground': theme.colors.surface2 + '80',
      'editor.findMatchHighlightBorder': theme.colors.surface2,
      'editor.findRangeHighlightBackground': theme.colors.surface1 + '40',
      'editorOverviewRuler.findMatchForeground': theme.colors.accent + 'A0',

      // Find widget input & buttons (inherit from editorWidget tokens above)
      'inputOption.activeBackground': theme.colors.accent + '40',
      'inputOption.activeForeground': theme.colors.text,
      'inputOption.activeBorder': theme.colors.accent,
      'inputOption.hoverBackground': theme.colors.surface1,
    },
  };
}

// ── Shared Monaco runtime ────────────────────────────────────────────
//
// Every Monaco surface (file editor, diff viewer, read-only viewer, settings
// editor) needs the same two things before it can render with a Clubhouse
// theme: the Monaco module loaded, and every Clubhouse theme defined inside
// Monaco. Centralising this here ensures all surfaces register the *full*
// theme registry — builtins AND plugin-contributed themes.
//
// Previously each surface only registered the builtin themes, so selecting a
// plugin theme left Monaco on its default light ('vs') theme, rendering the
// editor bright white in an otherwise dark app.

let monacoModule: any | null = null;
let themesRegistered = false;
let registryListenerAttached = false;

export async function loadMonaco(): Promise<any> {
  if (!monacoModule) {
    monacoModule = await import('monaco-editor');
  }
  return monacoModule;
}

/** Define every theme in the dynamic registry (builtins + plugin-contributed) with Monaco. */
export function registerAllMonacoThemes(m: any): void {
  for (const [id, theme] of Object.entries(getAllThemes())) {
    m.editor.defineTheme(`clubhouse-${id}`, generateMonacoTheme(theme as ThemeDefinition) as any);
  }
}

/**
 * Ensure all known themes are registered with Monaco and stay in sync with the
 * registry. Idempotent: the heavy registration runs once, but a registry
 * listener re-registers whenever plugin themes are added/removed/updated so a
 * later-contributed theme is always defined before it can be selected.
 */
export async function ensureThemes(m: any): Promise<void> {
  if (!registryListenerAttached) {
    registryListenerAttached = true;
    onRegistryChange(() => {
      if (monacoModule) registerAllMonacoThemes(monacoModule);
    });
  }
  if (themesRegistered) return;
  registerAllMonacoThemes(m);
  themesRegistered = true;
}

/**
 * Apply a Clubhouse theme by id. Defines the theme just-in-time (so a plugin
 * theme that wasn't registered at editor-creation time still resolves) and then
 * sets it. Falls back to a plain setTheme if the id is unknown.
 */
export function applyMonacoTheme(m: any, themeId: string): void {
  const theme = getTheme(themeId);
  if (theme) {
    m.editor.defineTheme(`clubhouse-${themeId}`, generateMonacoTheme(theme) as any);
  }
  m.editor.setTheme(`clubhouse-${themeId}`);
}
