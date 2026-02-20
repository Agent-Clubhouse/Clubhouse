import React, { useEffect, useRef, useCallback } from 'react';
import * as monaco from 'monaco-editor';
import { useThemeStore } from '../stores/themeStore';

let themesRegistered = false;

function ensureThemes(): void {
  if (themesRegistered) return;
  const { THEMES } = require('../themes/index');
  const { generateMonacoTheme } = require('../plugins/builtin/files/monaco-theme');
  for (const [id, theme] of Object.entries(THEMES)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    monaco.editor.defineTheme(`clubhouse-${id}`, generateMonacoTheme(theme as any) as any);
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const editorRef = useRef<any>(null);
  const onChangeRef = useRef(onChange);
  const themeId = useThemeStore((s) => s.themeId);

  onChangeRef.current = onChange;

  useEffect(() => {
    if (!containerRef.current) return;

    ensureThemes();

    const editor = monaco.editor.create(containerRef.current, {
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

    return () => {
      editor.dispose();
      editorRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorKey, language]);

  // React to theme changes
  useEffect(() => {
    if (!editorRef.current) return;
    monaco.editor.setTheme(`clubhouse-${themeId}`);
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
      style={{ height }}
    />
  );
}
