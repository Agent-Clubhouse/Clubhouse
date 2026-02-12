import { useRef, useCallback } from 'react';
import Editor, { type OnMount, type BeforeMount, loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import { THEMES } from '../../themes';
import { useThemeStore } from '../../stores/themeStore';

// Use locally bundled monaco-editor instead of CDN (which fails in Electron)
loader.config({ monaco });

const EXT_TO_MONACO_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  json: 'json',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  htm: 'html',
  svg: 'xml',
  xml: 'xml',
  md: 'markdown',
  mdx: 'markdown',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  yml: 'yaml',
  yaml: 'yaml',
  rs: 'rust',
  go: 'go',
  java: 'java',
  sql: 'sql',
  diff: 'diff',
  patch: 'diff',
  toml: 'ini',
  ini: 'ini',
  dockerfile: 'dockerfile',
  graphql: 'graphql',
  gql: 'graphql',
};

function getLanguageFromPath(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  const basename = filePath.split('/').pop()?.toLowerCase() || '';
  if (basename === 'dockerfile') return 'dockerfile';
  if (basename === 'makefile') return 'makefile';
  return EXT_TO_MONACO_LANG[ext] || 'plaintext';
}

interface MonacoCodeEditorProps {
  filePath: string;
  initialContent: string;
  onDirtyChange: (dirty: boolean) => void;
  onSave: (content: string) => void;
}

export function MonacoCodeEditor({
  filePath,
  initialContent,
  onDirtyChange,
  onSave,
}: MonacoCodeEditorProps) {
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const savedContentRef = useRef(initialContent);
  const themeId = useThemeStore((s) => s.themeId);

  const language = getLanguageFromPath(filePath);

  const handleBeforeMount: BeforeMount = useCallback((mon) => {
    // Register all themes upfront
    for (const [id, theme] of Object.entries(THEMES)) {
      mon.editor.defineTheme(id, theme.monaco as unknown as monaco.editor.IStandaloneThemeData);
    }
  }, []);

  const handleMount: OnMount = useCallback(
    (editor, mon) => {
      editorRef.current = editor;

      // Cmd/Ctrl+S → save
      editor.addCommand(mon.KeyMod.CtrlCmd | mon.KeyCode.KeyS, () => {
        const content = editor.getValue();
        onSave(content);
        savedContentRef.current = content;
        onDirtyChange(false);
      });

      // Track dirty state
      editor.onDidChangeModelContent(() => {
        const current = editor.getValue();
        const dirty = current !== savedContentRef.current;
        onDirtyChange(dirty);
      });

      editor.focus();
    },
    [onSave, onDirtyChange]
  );

  return (
    <Editor
      language={language}
      defaultValue={initialContent}
      theme={themeId}
      beforeMount={handleBeforeMount}
      onMount={handleMount}
      options={{
        fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', 'JetBrains Mono', monospace",
        fontSize: 13,
        lineHeight: 20,
        minimap: { enabled: false },
        automaticLayout: true,
        scrollbar: {
          verticalScrollbarSize: 6,
          horizontalScrollbarSize: 6,
          useShadows: false,
        },
        cursorBlinking: 'smooth',
        cursorSmoothCaretAnimation: 'on',
        smoothScrolling: true,
        renderLineHighlight: 'line',
        padding: { top: 8, bottom: 8 },
        overviewRulerLanes: 0,
        hideCursorInOverviewRuler: true,
        overviewRulerBorder: false,
        scrollBeyondLastLine: false,
        contextmenu: true,
        wordWrap: 'off',
        tabSize: 2,
        insertSpaces: true,
        bracketPairColorization: { enabled: true },
        guides: {
          indentation: true,
          bracketPairs: true,
        },
      }}
    />
  );
}
