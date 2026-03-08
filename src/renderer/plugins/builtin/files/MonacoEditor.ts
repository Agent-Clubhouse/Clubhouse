import React, { useEffect, useRef, useCallback, useState } from 'react';
import { generateMonacoTheme } from './monaco-theme';
import { useThemeStore } from '../../../stores/themeStore';
import type { ScrollState } from './state';

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

// ── Model Cache ──────────────────────────────────────────────────────
// Maintain one ITextModel per file path for efficient tab switching.
// This is the VS Code approach: models persist in memory, editor swaps them.

interface CachedModel {
  model: any;           // monaco.editor.ITextModel
  savedContent: string; // Content at last save (for dirty detection)
  language: string;
}

const modelCache = new Map<string, CachedModel>();

export function getOrCreateModel(
  monaco: any,
  filePath: string,
  content: string,
  language: string,
): CachedModel {
  const existing = modelCache.get(filePath);
  if (existing) {
    // Update language if changed
    if (existing.language !== language) {
      monaco.editor.setModelLanguage(existing.model, language);
      existing.language = language;
    }
    return existing;
  }

  const uri = monaco.Uri.parse(`file:///${filePath}`);
  // Check if a model already exists at this URI (e.g., from a previous session)
  let model = monaco.editor.getModel(uri);
  if (!model) {
    model = monaco.editor.createModel(content, language, uri);
  } else {
    // Model exists but might have stale content
    if (model.getValue() !== content) {
      model.setValue(content);
    }
    monaco.editor.setModelLanguage(model, language);
  }

  const cached: CachedModel = { model, savedContent: content, language };
  modelCache.set(filePath, cached);
  return cached;
}

export function disposeModel(filePath: string): void {
  const cached = modelCache.get(filePath);
  if (cached) {
    cached.model.dispose();
    modelCache.delete(filePath);
  }
}

export function disposeAllModels(): void {
  for (const [, cached] of modelCache) {
    cached.model.dispose();
  }
  modelCache.clear();
}

export function updateSavedContent(filePath: string, content: string): void {
  const cached = modelCache.get(filePath);
  if (cached) {
    cached.savedContent = content;
  }
}

export function getModelContent(filePath: string): string | null {
  const cached = modelCache.get(filePath);
  return cached ? cached.model.getValue() : null;
}

export function isModelDirty(filePath: string): boolean {
  const cached = modelCache.get(filePath);
  if (!cached) return false;
  return cached.model.getValue() !== cached.savedContent;
}

// ── Editor Component ─────────────────────────────────────────────────

interface MonacoEditorProps {
  value: string;
  language: string;
  onSave: (content: string) => void;
  onDirtyChange: (dirty: boolean) => void;
  filePath: string;
  initialScrollState?: ScrollState | null;
  onScrollStateChange?: (state: ScrollState) => void;
  /** When set, scroll to this line and briefly highlight it */
  scrollToLine?: number | null;
}

export function MonacoEditor({
  value, language, onSave, onDirtyChange, filePath,
  initialScrollState, onScrollStateChange, scrollToLine,
}: MonacoEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<any>(null);
  const monacoRef = useRef<any>(null);
  const onSaveRef = useRef(onSave);
  const onDirtyChangeRef = useRef(onDirtyChange);
  const onScrollStateChangeRef = useRef(onScrollStateChange);
  const filePathRef = useRef(filePath);
  const themeId = useThemeStore((s) => s.themeId);
  const [loading, setLoading] = useState(true);
  const contentChangeDisposableRef = useRef<any>(null);
  const cursorChangeDisposableRef = useRef<any>(null);

  onSaveRef.current = onSave;
  onDirtyChangeRef.current = onDirtyChange;
  onScrollStateChangeRef.current = onScrollStateChange;

  const checkDirty = useCallback(() => {
    const dirty = isModelDirty(filePathRef.current);
    onDirtyChangeRef.current(dirty);
  }, []);

  // Save scroll/cursor state for current file
  const saveScrollState = useCallback(() => {
    if (!editorRef.current || !onScrollStateChangeRef.current) return;
    const position = editorRef.current.getPosition();
    const scrollTop = editorRef.current.getScrollTop();
    const scrollLeft = editorRef.current.getScrollLeft();
    onScrollStateChangeRef.current({
      scrollTop,
      scrollLeft,
      cursorLine: position?.lineNumber ?? 1,
      cursorColumn: position?.column ?? 1,
    });
  }, []);

  // Create editor once, swap models on filePath change
  useEffect(() => {
    if (!containerRef.current) return;

    let disposed = false;

    loadMonaco().then(async (m) => {
      if (disposed || !containerRef.current) return;
      monacoRef.current = m;
      await ensureThemes(m);

      const cached = getOrCreateModel(m, filePath, value, language);

      const editor = m.editor.create(containerRef.current, {
        model: cached.model,
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
        updateSavedContent(filePathRef.current, content);
        onSaveRef.current(content);
        onDirtyChangeRef.current(false);
      });

      // Track dirty state
      contentChangeDisposableRef.current = editor.onDidChangeModelContent(() => {
        checkDirty();
      });

      // Track cursor/scroll for state preservation
      cursorChangeDisposableRef.current = editor.onDidChangeCursorPosition(() => {
        saveScrollState();
      });

      // Restore scroll state if provided
      if (initialScrollState) {
        editor.setScrollTop(initialScrollState.scrollTop);
        editor.setScrollLeft(initialScrollState.scrollLeft);
        editor.setPosition({
          lineNumber: initialScrollState.cursorLine,
          column: initialScrollState.cursorColumn,
        });
      }

      setLoading(false);
    });

    return () => {
      disposed = true;
      // Save scroll state before unmounting
      saveScrollState();
      contentChangeDisposableRef.current?.dispose();
      cursorChangeDisposableRef.current?.dispose();
      if (editorRef.current) {
        editorRef.current.dispose();
        editorRef.current = null;
      }
    };
  // Only recreate editor on mount/unmount — model swapping handles file changes
  }, []);

  // Swap model when filePath changes (tab switch)
  useEffect(() => {
    if (!editorRef.current || !monacoRef.current) return;

    // Save scroll state for the previous file
    saveScrollState();

    filePathRef.current = filePath;
    const m = monacoRef.current;
    const cached = getOrCreateModel(m, filePath, value, language);

    // Swap the model
    editorRef.current.setModel(cached.model);

    // Restore scroll state
    if (initialScrollState) {
      // Use requestAnimationFrame to ensure the model is fully loaded
      requestAnimationFrame(() => {
        if (!editorRef.current) return;
        editorRef.current.setScrollTop(initialScrollState.scrollTop);
        editorRef.current.setScrollLeft(initialScrollState.scrollLeft);
        editorRef.current.setPosition({
          lineNumber: initialScrollState.cursorLine,
          column: initialScrollState.cursorColumn,
        });
      });
    }

    // Re-attach content change listener for the new model
    contentChangeDisposableRef.current?.dispose();
    contentChangeDisposableRef.current = editorRef.current.onDidChangeModelContent(() => {
      checkDirty();
    });

    // Check initial dirty state
    checkDirty();
  }, [filePath, value, language, initialScrollState, checkDirty, saveScrollState]);

  // React to theme changes
  useEffect(() => {
    if (!editorRef.current || !monacoRef.current) return;
    monacoRef.current.editor.setTheme(`clubhouse-${themeId}`);
  }, [themeId]);

  // When value prop changes externally (e.g., file reloaded from disk), update model
  useEffect(() => {
    const cached = modelCache.get(filePath);
    if (cached && cached.model.getValue() !== value) {
      cached.model.setValue(value);
      cached.savedContent = value;
      onDirtyChangeRef.current(false);
    }
  }, [value, filePath]);

  // Scroll to line when requested (from search results)
  useEffect(() => {
    if (!scrollToLine || !editorRef.current) return;

    const editor = editorRef.current;
    editor.revealLineInCenter(scrollToLine);
    editor.setSelection({
      startLineNumber: scrollToLine,
      startColumn: 1,
      endLineNumber: scrollToLine,
      endColumn: 1000,
    });
    editor.focus();
  }, [scrollToLine]);

  return React.createElement('div', {
    ref: containerRef,
    className: 'w-full h-full',
    style: { position: 'relative' },
  },
    loading
      ? React.createElement('div', {
          className: 'absolute inset-0 flex items-center justify-center text-ctp-subtext0 text-xs',
        }, 'Loading editor\u2026')
      : null,
  );
}
