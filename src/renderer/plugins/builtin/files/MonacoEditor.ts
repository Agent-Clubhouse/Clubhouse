import React, { useEffect, useRef, useCallback, useState } from 'react';
import { generateMonacoTheme } from './monaco-theme';
import { useThemeStore } from '../../../stores/themeStore';

// Cached module reference — populated on first dynamic import
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let monacoModule: any | null = null;
let themesRegistered = false;

async function loadMonaco() {
  if (!monacoModule) {
    monacoModule = await import('monaco-editor');
  }
  return monacoModule;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ensureThemes(m: any): void {
  if (themesRegistered) return;
  // Lazy import themes to avoid circular issues in tests
  const { THEMES } = require('../../../themes/index');
  for (const [id, theme] of Object.entries(THEMES)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    m.editor.defineTheme(`clubhouse-${id}`, generateMonacoTheme(theme as any) as any);
  }
  themesRegistered = true;
}

interface MonacoEditorProps {
  value: string;
  language: string;
  onSave: (content: string) => void;
  onDirtyChange: (dirty: boolean) => void;
  filePath: string;
}

export function MonacoEditor({ value, language, onSave, onDirtyChange, filePath }: MonacoEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const editorRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const monacoRef = useRef<any>(null);
  const savedContentRef = useRef(value);
  const onSaveRef = useRef(onSave);
  const onDirtyChangeRef = useRef(onDirtyChange);
  const themeId = useThemeStore((s) => s.themeId);
  const [loading, setLoading] = useState(true);

  onSaveRef.current = onSave;
  onDirtyChangeRef.current = onDirtyChange;

  useEffect(() => {
    savedContentRef.current = value;
  }, [value]);

  const checkDirty = useCallback(() => {
    if (!editorRef.current) return;
    const currentContent = editorRef.current.getValue();
    const dirty = currentContent !== savedContentRef.current;
    onDirtyChangeRef.current(dirty);
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;

    let disposed = false;

    loadMonaco().then((m) => {
      if (disposed || !containerRef.current) return;
      monacoRef.current = m;
      ensureThemes(m);

      const editor = m.editor.create(containerRef.current, {
        value,
        language,
        theme: `clubhouse-${themeId}`,
        fontSize: 13,
        fontFamily: 'SF Mono, Fira Code, JetBrains Mono, monospace',
        bracketPairColorization: { enabled: true },
        minimap: { enabled: false },
        wordWrap: 'off',
        automaticLayout: true,
        scrollBeyondLastLine: false,
        padding: { top: 8 },
      });

      editorRef.current = editor;

      // Cmd+S / Ctrl+S keybinding
      editor.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.KeyS, () => {
        const content = editor.getValue();
        savedContentRef.current = content;
        onSaveRef.current(content);
        onDirtyChangeRef.current(false);
      });

      // Track dirty state
      editor.onDidChangeModelContent(() => {
        checkDirty();
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
  }, [filePath]);

  // React to theme changes
  useEffect(() => {
    if (!editorRef.current || !monacoRef.current) return;
    monacoRef.current.editor.setTheme(`clubhouse-${themeId}`);
  }, [themeId]);

  // When value prop changes (for the same filePath), update editor content
  useEffect(() => {
    if (editorRef.current && editorRef.current.getValue() !== value) {
      editorRef.current.setValue(value);
      savedContentRef.current = value;
      onDirtyChangeRef.current(false);
    }
  }, [value, onDirtyChangeRef]);

  // Update language when it changes
  useEffect(() => {
    if (editorRef.current && monacoRef.current) {
      const model = editorRef.current.getModel();
      if (model) {
        monacoRef.current.editor.setModelLanguage(model, language);
      }
    }
  }, [language]);

  return React.createElement('div', {
    ref: containerRef,
    className: 'w-full h-full',
    style: { position: 'relative' },
  },
    loading
      ? React.createElement('div', {
          className: 'absolute inset-0 flex items-center justify-center text-ctp-subtext0 text-xs',
        }, 'Loading editor…')
      : null,
  );
}
