import { useEffect, useState, useCallback, useRef } from 'react';
import { DiffEditor, type BeforeMount, type DiffOnMount, loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import { THEMES } from '../../themes';
import { useThemeStore } from '../../stores/themeStore';
import { useUIStore } from '../../stores/uiStore';

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

export function GitDiffViewer() {
  const { selectedGitFile, setSelectedGitFile } = useUIStore();
  const themeId = useThemeStore((s) => s.themeId);

  const [original, setOriginal] = useState('');
  const [modified, setModified] = useState('');
  const [loading, setLoading] = useState(false);
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);

  useEffect(() => {
    if (!selectedGitFile) return;

    let cancelled = false;
    setLoading(true);

    window.clubhouse.git
      .diff(selectedGitFile.worktreePath, selectedGitFile.path, selectedGitFile.staged)
      .then((result: { original: string; modified: string }) => {
        if (cancelled) return;
        setOriginal(result.original);
        setModified(result.modified);
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedGitFile]);

  // Clean up the editor ref on unmount to avoid the TextModel disposal race
  useEffect(() => {
    return () => {
      editorRef.current = null;
    };
  }, []);

  const handleBeforeMount: BeforeMount = useCallback((mon) => {
    for (const [id, theme] of Object.entries(THEMES)) {
      mon.editor.defineTheme(id, theme.monaco as unknown as monaco.editor.IStandaloneThemeData);
    }
  }, []);

  const handleMount: DiffOnMount = useCallback((editor) => {
    editorRef.current = editor;
  }, []);

  if (!selectedGitFile) {
    return (
      <div className="flex items-center justify-center h-full bg-ctp-base">
        <p className="text-ctp-subtext0 text-sm">Select a file from the sidebar to view changes</p>
      </div>
    );
  }

  const language = getLanguageFromPath(selectedGitFile.path);
  const fileName = selectedGitFile.path.split('/').pop() || selectedGitFile.path;

  return (
    <div className="flex flex-col h-full bg-ctp-base">
      {/* Header bar */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-surface-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm text-ctp-text truncate" title={selectedGitFile.path}>
            {fileName}
          </span>
          <span className="text-xs text-ctp-subtext0 truncate hidden sm:inline">
            {selectedGitFile.path}
          </span>
          <span
            className={`text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded ${
              selectedGitFile.staged
                ? 'bg-green-500/20 text-green-300'
                : 'bg-yellow-500/20 text-yellow-300'
            }`}
          >
            {selectedGitFile.staged ? 'Staged' : 'Unstaged'}
          </span>
        </div>
        <button
          onClick={() => setSelectedGitFile(null)}
          className="text-ctp-subtext0 hover:text-ctp-text text-sm px-1.5 cursor-pointer"
          title="Close diff"
        >
          ✕
        </button>
      </div>

      {/* Diff editor */}
      <div className="flex-1 min-h-0">
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <p className="text-ctp-subtext0 text-sm">Loading diff...</p>
          </div>
        ) : (
          <DiffEditor
            key={`${selectedGitFile.path}:${selectedGitFile.staged}`}
            original={original}
            modified={modified}
            language={language}
            theme={themeId}
            beforeMount={handleBeforeMount}
            onMount={handleMount}
            keepCurrentOriginalModel
            keepCurrentModifiedModel
            options={{
              readOnly: true,
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
              renderLineHighlight: 'none',
              padding: { top: 8, bottom: 8 },
              overviewRulerLanes: 0,
              overviewRulerBorder: false,
              scrollBeyondLastLine: false,
              renderSideBySide: true,
            }}
          />
        )}
      </div>
    </div>
  );
}
