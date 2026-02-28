import React, { useEffect, useRef, useState } from 'react';
import { useThemeStore } from '../stores/themeStore';

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
  const { THEMES } = await import('../themes/index');
  const { generateMonacoTheme } = await import('../plugins/builtin/files/monaco-theme');
  for (const [id, theme] of Object.entries(THEMES)) {
    m.editor.defineTheme(`clubhouse-${id}`, generateMonacoTheme(theme as any) as any);
  }
  themesRegistered = true;
}

interface SettingsMonacoEditorProps {
  value: string;
  language: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
  height?: string;
  /** Unique key to force editor re-creation */
  editorKey?: string;
}

export function SettingsMonacoEditor({
  value,
  language,
  onChange,
  readOnly = false,
  height = '240px',
  editorKey,
}: SettingsMonacoEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<any>(null);
  const monacoRef = useRef<any>(null);
  const onChangeRef = useRef(onChange);
  const themeId = useThemeStore((s) => s.themeId);
  const [loading, setLoading] = useState(true);

  onChangeRef.current = onChange;

  useEffect(() => {
    if (!containerRef.current) return;

    let disposed = false;

    loadMonaco().then(async (m) => {
      if (disposed || !containerRef.current) return;
      monacoRef.current = m;
      await ensureThemes(m);

      const editor = m.editor.create(containerRef.current, {
        value,
        language,
        theme: `clubhouse-${themeId}`,
        fontSize: 12,
        fontFamily: 'SF Mono, Fira Code, JetBrains Mono, monospace',
        minimap: { enabled: false },
        wordWrap: 'on',
        automaticLayout: true,
        scrollBeyondLastLine: false,
        padding: { top: 6, bottom: 6 },
        lineNumbers: 'off',
        glyphMargin: false,
        folding: false,
        lineDecorationsWidth: 8,
        lineNumbersMinChars: 0,
        renderLineHighlight: 'none',
        overviewRulerBorder: false,
        scrollbar: {
          vertical: 'auto',
          horizontal: 'auto',
          verticalScrollbarSize: 6,
        },
        readOnly,
      });

      editorRef.current = editor;

      editor.onDidChangeModelContent(() => {
        onChangeRef.current(editor.getValue());
      });

      setLoading(false);
    });

    return () => {
      disposed = true;
      if (editorRef.current) {
        editorRef.current.dispose();
        editorRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorKey, language]);

  // React to theme changes
  useEffect(() => {
    if (!editorRef.current || !monacoRef.current) return;
    monacoRef.current.editor.setTheme(`clubhouse-${themeId}`);
  }, [themeId]);

  // Sync value changes from outside
  useEffect(() => {
    if (editorRef.current && editorRef.current.getValue() !== value) {
      editorRef.current.setValue(value);
    }
  }, [value]);

  // Sync readOnly changes
  useEffect(() => {
    if (editorRef.current) {
      editorRef.current.updateOptions({ readOnly });
    }
  }, [readOnly]);

  return (
    <div
      ref={containerRef}
      className="w-full rounded-lg border border-surface-1 overflow-hidden"
      style={{ height, position: 'relative' }}
    >
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center text-ctp-subtext0 text-xs">
          Loading editor…
        </div>
      )}
    </div>
  );
}
