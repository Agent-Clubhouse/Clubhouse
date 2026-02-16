import React, { useEffect, useRef, useCallback } from 'react';
import * as monaco from 'monaco-editor';
import { generateMonacoTheme } from './monaco-theme';
import { useThemeStore } from '../../../stores/themeStore';

function getMonaco(): typeof monaco {
  return monaco;
}

let themesRegistered = false;

function ensureThemes(): void {
  if (themesRegistered) return;
  const m = getMonaco();
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
  const savedContentRef = useRef(value);
  const onSaveRef = useRef(onSave);
  const onDirtyChangeRef = useRef(onDirtyChange);
  const themeId = useThemeStore((s) => s.themeId);

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

    const m = getMonaco();
    ensureThemes();

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

    return () => {
      editor.dispose();
      editorRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath]);

  // React to theme changes
  useEffect(() => {
    if (!editorRef.current) return;
    monaco.editor.setTheme(`clubhouse-${themeId}`);
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
    if (editorRef.current) {
      const monaco = getMonaco();
      const model = editorRef.current.getModel();
      if (model) {
        monaco.editor.setModelLanguage(model, language);
      }
    }
  }, [language]);

  return React.createElement('div', {
    ref: containerRef,
    className: 'w-full h-full',
  });
}
