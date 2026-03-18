import React, { useEffect, useRef, useState } from 'react';
import { generateMonacoTheme } from '../files/monaco-theme';
import { EXT_TO_LANG } from '../files/file-icons';
import { useThemeStore } from '../../../stores/themeStore';

// Cached module reference — populated on first dynamic import
let monacoModule: any | null = null;
let themesRegistered = false;

async function loadMonaco() {
  if (!monacoModule) {
    monacoModule = await import('monaco-editor');
  }
  return monacoModule;
}

async function ensureThemes(m: any): Promise<void> {
  if (themesRegistered) return;
  const { THEMES } = await import('../../../themes/index');
  for (const [id, theme] of Object.entries(THEMES)) {
    m.editor.defineTheme(`clubhouse-${id}`, generateMonacoTheme(theme as any) as any);
  }
  themesRegistered = true;
}

/** Detect Monaco language from a file path's extension */
export function languageFromPath(filePath: string): string {
  const baseName = filePath.split('/').pop()?.toLowerCase() ?? '';
  const dot = baseName.lastIndexOf('.');
  const ext = dot > 0 ? baseName.slice(dot + 1) : '';
  // For dotfiles like .env or .gitignore, strip leading dot and check as extension
  const dotfileExt = baseName.startsWith('.') && dot === 0 ? baseName.slice(1) : '';
  return EXT_TO_LANG[ext] || EXT_TO_LANG[baseName] || EXT_TO_LANG[dotfileExt] || 'plaintext';
}

interface ReadOnlyMonacoEditorProps {
  value: string;
  filePath: string;
  readOnly?: boolean;
  onSave?: (content: string) => void;
}

export function ReadOnlyMonacoEditor({ value, filePath, readOnly = true, onSave }: ReadOnlyMonacoEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<any>(null);
  const monacoRef = useRef<any>(null);
  const themeId = useThemeStore((s) => s.themeId);
  const [loading, setLoading] = useState(true);

  // Create editor once on mount
  useEffect(() => {
    if (!containerRef.current) return;
    let disposed = false;

    loadMonaco().then(async (m) => {
      if (disposed || !containerRef.current) return;
      monacoRef.current = m;
      await ensureThemes(m);

      const language = languageFromPath(filePath);
      const model = m.editor.createModel(value, language);

      const editor = m.editor.create(containerRef.current, {
        model,
        theme: `clubhouse-${themeId}`,
        readOnly,
        fontSize: 12,
        fontFamily: 'SF Mono, Fira Code, JetBrains Mono, monospace',
        bracketPairColorization: { enabled: true },
        minimap: {
          enabled: true,
          renderCharacters: true,
          maxColumn: 80,
          showSlider: 'mouseover',
        },
        wordWrap: 'off',
        automaticLayout: true,
        scrollBeyondLastLine: false,
        padding: { top: 4 },
        fixedOverflowWidgets: false,
        folding: true,
        showFoldingControls: 'mouseover',
        guides: {
          indentation: true,
          highlightActiveIndentation: true,
          bracketPairs: 'active',
        },
        renderWhitespace: 'selection',
        stickyScroll: { enabled: true, maxLineCount: 3 },
        lineNumbers: 'on',
        lineNumbersMinChars: 3,
        domReadOnly: readOnly,
      });

      // Ctrl/Cmd+S to save when editable
      editor.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.KeyS, () => {
        if (onSave) {
          const content = editor.getModel()?.getValue() ?? '';
          onSave(content);
        }
      });

      editorRef.current = editor;
      setLoading(false);
    });

    return () => {
      disposed = true;
      if (editorRef.current) {
        const model = editorRef.current.getModel();
        editorRef.current.dispose();
        model?.dispose();
        editorRef.current = null;
      }
    };
  }, []);

  // Toggle readOnly when prop changes
  useEffect(() => {
    if (!editorRef.current) return;
    editorRef.current.updateOptions({ readOnly, domReadOnly: readOnly });
  }, [readOnly]);

  // Update content & language when filePath or value changes
  useEffect(() => {
    if (!editorRef.current || !monacoRef.current) return;
    const m = monacoRef.current;
    const editor = editorRef.current;
    const oldModel = editor.getModel();

    const language = languageFromPath(filePath);
    const newModel = m.editor.createModel(value, language);
    editor.setModel(newModel);
    oldModel?.dispose();

    // Reset scroll position for new file
    editor.setScrollTop(0);
    editor.setScrollLeft(0);
  }, [filePath, value]);

  // React to theme changes
  useEffect(() => {
    if (!monacoRef.current) return;
    monacoRef.current.editor.setTheme(`clubhouse-${themeId}`);
  }, [themeId]);

  return React.createElement('div', {
    ref: containerRef,
    className: 'w-full h-full',
    style: { position: 'relative' },
  },
    loading
      ? React.createElement('div', {
          className: 'absolute inset-0 flex items-center justify-center text-ctp-subtext0 text-xs',
        }, 'Loading\u2026')
      : null,
  );
}
