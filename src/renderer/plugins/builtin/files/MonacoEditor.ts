import React, { useEffect, useRef, useCallback, useState } from 'react';
import { loadMonaco, ensureThemes, applyMonacoTheme, monacoThemeName } from './monaco-theme';
import { useThemeStore } from '../../../stores/themeStore';
import type { ScrollState } from './state';

// ── Model Cache ──────────────────────────────────────────────────────
// Maintain one ITextModel per file path for efficient tab switching.
// This is the VS Code approach: models persist in memory, editor swaps them.

interface CachedModel {
  model: any;           // monaco.editor.ITextModel
  savedContent: string; // Content at last save (for dirty detection)
  /** Last `value` prop applied to the model; a remount with the same value keeps unsaved edits. */
  syncedValue: string;
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

  // Files passes a checkout-qualified key (`<checkout>/<path>`), so models of
  // the same relative path in two checkouts get different URIs.
  const uri = monaco.Uri.parse(`file:///${filePath.replace(/^\/+/, '')}`);
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

  const cached: CachedModel = { model, savedContent: content, syncedValue: content, language };
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

/**
 * Dispose every model without unsaved edits. Files calls this when the scope
 * changes, since a worktree outside the project reuses the same relative paths
 * as the root and a cached model would show the other checkout's content.
 */
export function disposeCleanModels(): void {
  for (const [filePath, cached] of modelCache) {
    if (cached.model.getValue() !== cached.savedContent) continue;
    cached.model.dispose();
    modelCache.delete(filePath);
  }
}

export function updateSavedContent(filePath: string, content: string): void {
  const cached = modelCache.get(filePath);
  if (cached) {
    cached.savedContent = content;
  }
}

/** Commit a successful save as both the dirty baseline and the synced disk value. */
function commitSavedContent(filePath: string, content: string): void {
  const cached = modelCache.get(filePath);
  if (cached) {
    cached.savedContent = content;
    cached.syncedValue = content;
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
  /**
   * Persist the content. Resolve `false` (or reject) when the write failed —
   * the editor then keeps its dirty state so the draft is not lost.
   */
  onSave: (content: string) => boolean | void | Promise<boolean | void>;
  onDirtyChange: (dirty: boolean) => void;
  filePath: string;
  initialScrollState?: ScrollState | null;
  onScrollStateChange?: (state: ScrollState) => void;
  /** When set, scroll to this line and briefly highlight it */
  scrollToLine?: number | null;
  /** Called when the cursor position changes (line, column) */
  onCursorChange?: (line: number, column: number) => void;
}

export function MonacoEditor({
  value, language, onSave, onDirtyChange, filePath,
  initialScrollState, onScrollStateChange, scrollToLine, onCursorChange,
}: MonacoEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<any>(null);
  const monacoRef = useRef<any>(null);
  const onSaveRef = useRef(onSave);
  const onDirtyChangeRef = useRef(onDirtyChange);
  const onScrollStateChangeRef = useRef(onScrollStateChange);
  const onCursorChangeRef = useRef(onCursorChange);
  const filePathRef = useRef(filePath);
  // Latest props for the async editor creation — props can change while Monaco is loading
  const latestPropsRef = useRef({ filePath, value, language, initialScrollState });
  latestPropsRef.current = { filePath, value, language, initialScrollState };
  const wordWrapRef = useRef<'off' | 'on'>('off');
  // The applied theme, not the selection: they differ while a plugin theme is unregistered.
  const themeId = useThemeStore((s) => s.theme.id);
  const themeIdRef = useRef(themeId);
  themeIdRef.current = themeId;
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const contentChangeDisposableRef = useRef<any>(null);
  const cursorChangeDisposableRef = useRef<any>(null);

  onSaveRef.current = onSave;
  onDirtyChangeRef.current = onDirtyChange;
  onScrollStateChangeRef.current = onScrollStateChange;
  onCursorChangeRef.current = onCursorChange;

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

      const latest = latestPropsRef.current;
      filePathRef.current = latest.filePath;
      const cached = getOrCreateModel(m, latest.filePath, latest.value, latest.language);

      const editor = m.editor.create(containerRef.current, {
        model: cached.model,
        theme: monacoThemeName(themeIdRef.current),
        fontSize: 13,
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
        padding: { top: 8 },
        fixedOverflowWidgets: true,
        folding: true,
        showFoldingControls: 'mouseover',
        guides: {
          indentation: true,
          highlightActiveIndentation: true,
          bracketPairs: 'active',
        },
        renderWhitespace: 'selection',
        stickyScroll: { enabled: true, maxLineCount: 5 },
        cursorSmoothCaretAnimation: 'on',
        cursorBlinking: 'smooth',
        find: {
          addExtraSpaceOnTop: false,
          seedSearchStringFromSelection: 'selection',
          autoFindInSelection: 'multiline',
          loop: true,
        },
      });

      editorRef.current = editor;

      // Cmd+S / Ctrl+S keybinding — the saved baseline only moves once the
      // write succeeds, so a failed save leaves the tab dirty.
      editor.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.KeyS, () => {
        const path = filePathRef.current;
        const content = editor.getValue();
        Promise.resolve()
          .then(() => onSaveRef.current(content))
          .then((result) => {
            if (result === false) return;
            commitSavedContent(path, content);
            if (filePathRef.current === path) checkDirty();
          })
          .catch((err) => {
            console.error('[MonacoEditor] Save failed:', err);
          });
      });

      // Cmd+F — Open find widget
      editor.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.KeyF, () => {
        editor.trigger('keyboard', 'actions.find', null);
      });

      // Cmd+H — Open find and replace widget
      editor.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.KeyH, () => {
        editor.trigger('keyboard', 'editor.action.startFindReplaceAction', null);
      });

      // Cmd+Option+F — Open find and replace widget (alternative)
      editor.addCommand(m.KeyMod.CtrlCmd | m.KeyMod.Alt | m.KeyCode.KeyF, () => {
        editor.trigger('keyboard', 'editor.action.startFindReplaceAction', null);
      });

      // Cmd+G — Next match
      editor.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.KeyG, () => {
        editor.trigger('keyboard', 'editor.action.nextMatchFindAction', null);
      });

      // Cmd+Shift+G — Previous match
      editor.addCommand(m.KeyMod.CtrlCmd | m.KeyMod.Shift | m.KeyCode.KeyG, () => {
        editor.trigger('keyboard', 'editor.action.previousMatchFindAction', null);
      });

      // Cmd+D — Add selection to next find match
      editor.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.KeyD, () => {
        editor.trigger('keyboard', 'editor.action.addSelectionToNextFindMatch', null);
      });

      // Cmd+Shift+L — Select all occurrences of find match
      editor.addCommand(m.KeyMod.CtrlCmd | m.KeyMod.Shift | m.KeyCode.KeyL, () => {
        editor.trigger('keyboard', 'editor.action.selectHighlights', null);
      });

      // Alt+Z — Toggle word wrap
      editor.addCommand(m.KeyMod.Alt | m.KeyCode.KeyZ, () => {
        wordWrapRef.current = wordWrapRef.current === 'off' ? 'on' : 'off';
        editor.updateOptions({ wordWrap: wordWrapRef.current });
      });

      // Track dirty state
      contentChangeDisposableRef.current = editor.onDidChangeModelContent(() => {
        checkDirty();
      });

      // Track cursor/scroll for state preservation and status bar
      cursorChangeDisposableRef.current = editor.onDidChangeCursorPosition(() => {
        saveScrollState();
        const pos = editor.getPosition();
        if (pos && onCursorChangeRef.current) {
          onCursorChangeRef.current(pos.lineNumber, pos.column);
        }
      });

      // Restore scroll state if provided
      const scrollState = latest.initialScrollState;
      if (scrollState) {
        editor.setScrollTop(scrollState.scrollTop);
        editor.setScrollLeft(scrollState.scrollLeft);
        editor.setPosition({
          lineNumber: scrollState.cursorLine,
          column: scrollState.cursorColumn,
        });
      }
      checkDirty();
      setLoading(false);
    }).catch((err) => {
      if (disposed) return;
      console.error('[MonacoEditor] Monaco failed to initialise:', err);
      setLoadError(err instanceof Error ? err.message : String(err));
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
    applyMonacoTheme(monacoRef.current, themeId);
  }, [themeId]);

  // When value prop changes externally (e.g., file reloaded from disk), update model.
  // A remount with the value the model was last synced to (e.g. switching back to
  // a tab) must not clobber unsaved edits.
  useEffect(() => {
    const cached = modelCache.get(filePath);
    if (!cached || cached.syncedValue === value) return;
    cached.syncedValue = value;
    if (cached.model.getValue() !== value) {
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
    loadError
      ? React.createElement('div', {
          className: 'absolute inset-0 flex items-center justify-center p-4 text-center text-ctp-error text-xs',
        }, `Could not load the editor: ${loadError}`)
      : null,
  );
}
