import React, { useEffect, useRef, useState } from 'react';
import { generateMonacoTheme } from '../files/monaco-theme';
import { useThemeStore } from '../../../stores/themeStore';
import { languageFromPath } from './ReadOnlyMonacoEditor';

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

interface MonacoDiffEditorProps {
  original: string;
  modified: string;
  filePath: string;
}

export function MonacoDiffEditor({ original, modified, filePath }: MonacoDiffEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<any>(null);
  const monacoRef = useRef<any>(null);
  const themeId = useThemeStore((s) => s.themeId);
  const [loading, setLoading] = useState(true);

  // Create diff editor once on mount
  useEffect(() => {
    if (!containerRef.current) return;
    let disposed = false;

    loadMonaco().then(async (m) => {
      if (disposed || !containerRef.current) return;
      monacoRef.current = m;
      await ensureThemes(m);

      const language = languageFromPath(filePath);
      const originalModel = m.editor.createModel(original, language);
      const modifiedModel = m.editor.createModel(modified, language);

      const editor = m.editor.createDiffEditor(containerRef.current, {
        theme: `clubhouse-${themeId}`,
        readOnly: true,
        fontSize: 12,
        fontFamily: 'SF Mono, Fira Code, JetBrains Mono, monospace',
        automaticLayout: true,
        scrollBeyondLastLine: false,
        padding: { top: 4 },
        fixedOverflowWidgets: true,
        renderSideBySide: true,
        ignoreTrimWhitespace: false,
        renderIndicators: true,
        originalEditable: false,
        domReadOnly: true,
        minimap: { enabled: false },
      });

      editor.setModel({
        original: originalModel,
        modified: modifiedModel,
      });

      editorRef.current = editor;
      setLoading(false);
    });

    return () => {
      disposed = true;
      if (editorRef.current) {
        const model = editorRef.current.getModel();
        editorRef.current.dispose();
        model?.original?.dispose();
        model?.modified?.dispose();
        editorRef.current = null;
      }
    };
  }, []);

  // Update models when content or filePath changes
  useEffect(() => {
    if (!editorRef.current || !monacoRef.current) return;
    const m = monacoRef.current;
    const editor = editorRef.current;
    const oldModel = editor.getModel();

    const language = languageFromPath(filePath);
    const originalModel = m.editor.createModel(original, language);
    const modifiedModel = m.editor.createModel(modified, language);

    editor.setModel({
      original: originalModel,
      modified: modifiedModel,
    });

    oldModel?.original?.dispose();
    oldModel?.modified?.dispose();
  }, [filePath, original, modified]);

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
        }, 'Loading diff\u2026')
      : null,
  );
}
