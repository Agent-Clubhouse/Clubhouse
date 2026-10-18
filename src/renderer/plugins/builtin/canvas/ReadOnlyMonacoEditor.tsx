import React, { useEffect, useRef, useState } from 'react';
import { loadMonaco, ensureThemes, applyMonacoTheme, monacoThemeName } from '../files/monaco-theme';
import { EXT_TO_LANG } from '../files/file-icons';
import { useThemeStore } from '../../../stores/themeStore';

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
  onSave?: (content: string) => void | Promise<void>;
}

export function ReadOnlyMonacoEditor({ value, filePath, readOnly = true, onSave }: ReadOnlyMonacoEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<any>(null);
  const monacoRef = useRef<any>(null);
  // The applied theme, not the selection: they differ while a plugin theme is unregistered.
  const themeId = useThemeStore((s) => s.theme.id);
  const themeIdRef = useRef(themeId);
  // Latest props for the async editor creation and the Cmd+S handler — props can
  // change while Monaco is loading, and the keybinding outlives the mount render.
  const latestPropsRef = useRef({ value, filePath, readOnly, onSave });
  latestPropsRef.current = { value, filePath, readOnly, onSave };
  /** File the editor's current model was created for. */
  const modelPathRef = useRef<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Keep ref in sync so the async creation effect always uses the latest theme
  useEffect(() => {
    themeIdRef.current = themeId;
  }, [themeId]);

  // Create editor once on mount
  useEffect(() => {
    if (!containerRef.current) return;
    let disposed = false;

    loadMonaco().then(async (m) => {
      if (disposed || !containerRef.current) return;
      monacoRef.current = m;
      await ensureThemes(m);

      const latest = latestPropsRef.current;
      const language = languageFromPath(latest.filePath);
      const model = m.editor.createModel(latest.value, language);
      modelPathRef.current = latest.filePath;

      const editor = m.editor.create(containerRef.current, {
        model,
        theme: monacoThemeName(themeIdRef.current),
        readOnly: latest.readOnly,
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
        domReadOnly: latest.readOnly,
      });

      // Ctrl/Cmd+S to save when editable
      editor.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.KeyS, () => {
        const { onSave: save, filePath: currentPath, readOnly: isReadOnly } = latestPropsRef.current;
        // Never write a model's content to a different file than it was loaded from
        if (!save || isReadOnly || modelPathRef.current !== currentPath) return;
        const content = editor.getModel()?.getValue() ?? '';
        Promise.resolve(save(content)).catch((err) => {
          console.error('[ReadOnlyMonacoEditor] Save failed:', err);
        });
      });

      editorRef.current = editor;
      setLoading(false);
    }).catch((err) => {
      if (disposed) return;
      console.error('[ReadOnlyMonacoEditor] Monaco failed to initialise:', err);
      setLoadError(err instanceof Error ? err.message : String(err));
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
    modelPathRef.current = filePath;
    oldModel?.dispose();

    // Reset scroll position for new file
    editor.setScrollTop(0);
    editor.setScrollLeft(0);
  }, [filePath, value]);

  // React to theme changes
  useEffect(() => {
    if (!monacoRef.current) return;
    applyMonacoTheme(monacoRef.current, themeId);
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
    loadError
      ? React.createElement('div', {
          className: 'absolute inset-0 flex items-center justify-center p-4 text-center text-ctp-error text-xs',
        }, `Could not load the editor: ${loadError}`)
      : null,
  );
}
