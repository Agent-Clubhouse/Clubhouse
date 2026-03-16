import React, { useState, useEffect, useMemo } from 'react';
import type { FileCanvasView as FileCanvasViewType, CanvasView } from './canvas-types';
import type { PluginAPI } from '../../../../shared/plugin-types';

interface FileCanvasViewProps {
  view: FileCanvasViewType;
  api: PluginAPI;
  onUpdate: (updates: Partial<CanvasView>) => void;
}

export function FileCanvasView({ view, api, onUpdate }: FileCanvasViewProps) {
  const isAppMode = api.context.mode === 'app';
  const projects = useMemo(() => api.projects.list(), [api]);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [fileTree, setFileTree] = useState<Array<{ name: string; path: string; isDirectory: boolean }>>([]);
  const [currentDir, setCurrentDir] = useState<string>('');
  const [loading, setLoading] = useState(false);

  const activeProjectId = view.projectId || (isAppMode ? undefined : api.context.projectId);

  // In app mode, file browsing is not available (api.project is scoped per-project)
  if (isAppMode) {
    return (
      <div className="flex items-center justify-center h-full p-4">
        <div className="text-center">
          <div className="text-xs text-ctp-subtext0 mb-1">File browsing is available in project canvases.</div>
          <div className="text-[10px] text-ctp-overlay0">Open a project tab to browse files.</div>
        </div>
      </div>
    );
  }

  // Load directory listing (project mode only)
  useEffect(() => {
    if (!activeProjectId || isAppMode) return;
    setLoading(true);
    api.project.listDirectory(currentDir)
      .then((entries) => {
        setFileTree(entries.map((e) => ({
          name: typeof e === 'string' ? e : e.name,
          path: typeof e === 'string' ? (currentDir ? `${currentDir}/${e}` : e) : e.path ?? e.name,
          isDirectory: typeof e === 'string' ? false : !!e.isDirectory,
        })));
      })
      .catch(() => setFileTree([]))
      .finally(() => setLoading(false));
  }, [api, activeProjectId, currentDir, isAppMode]);

  // Load file content when a file is selected
  useEffect(() => {
    if (!view.filePath || isAppMode) {
      setFileContent(null);
      return;
    }
    api.project.readFile(view.filePath)
      .then(setFileContent)
      .catch(() => setFileContent('Error reading file'));
  }, [api, view.filePath, isAppMode]);

  const handleSelectProject = (projectId: string) => {
    const project = projects.find((p) => p.id === projectId);
    onUpdate({ projectId, filePath: undefined, title: project?.name || 'Files' } as Partial<FileCanvasViewType>);
    setCurrentDir('');
    setFileContent(null);
  };

  const handleNavigate = (entry: { name: string; path: string; isDirectory: boolean }) => {
    if (entry.isDirectory) {
      setCurrentDir(entry.path);
      setFileContent(null);
      onUpdate({ filePath: undefined } as Partial<FileCanvasViewType>);
    } else {
      onUpdate({ filePath: entry.path, title: entry.name } as Partial<FileCanvasViewType>);
    }
  };

  const handleGoUp = () => {
    const parent = currentDir.split('/').slice(0, -1).join('/');
    setCurrentDir(parent);
    setFileContent(null);
    onUpdate({ filePath: undefined } as Partial<FileCanvasViewType>);
  };

  // No project selected — show project picker
  if (!activeProjectId) {
    return (
      <div className="flex flex-col h-full p-2">
        <div className="text-xs text-ctp-subtext0 mb-2">Select a project:</div>
        {projects.length === 0 ? (
          <div className="text-xs text-ctp-overlay0 italic">No projects open</div>
        ) : (
          projects.map((p) => (
            <button
              key={p.id}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-[11px] text-ctp-text hover:bg-ctp-surface0 transition-colors text-left"
              onClick={() => handleSelectProject(p.id)}
            >
              {p.name || p.id}
            </button>
          ))
        )}
      </div>
    );
  }

  // File content view
  if (view.filePath && fileContent !== null) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center gap-1 px-2 py-1 bg-ctp-surface0/50 border-b border-surface-0 text-[10px] text-ctp-subtext0">
          <button
            className="hover:text-ctp-text transition-colors"
            onClick={() => onUpdate({ filePath: undefined, title: 'Files' } as Partial<FileCanvasViewType>)}
          >
            Back
          </button>
          <span className="text-ctp-overlay0">/</span>
          <span className="truncate">{view.filePath}</span>
        </div>
        <pre className="flex-1 overflow-auto p-2 text-[11px] text-ctp-text font-mono whitespace-pre-wrap">
          {fileContent}
        </pre>
      </div>
    );
  }

  // Directory listing
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-1 px-2 py-1 bg-ctp-surface0/50 border-b border-surface-0 text-[10px] text-ctp-subtext0">
        {currentDir && (
          <button
            className="hover:text-ctp-text transition-colors"
            onClick={handleGoUp}
          >
            ..
          </button>
        )}
        <span className="truncate">/{currentDir}</span>
      </div>
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="p-2 text-xs text-ctp-overlay0">Loading...</div>
        ) : (
          fileTree.map((entry) => (
            <button
              key={entry.path}
              className="w-full flex items-center gap-1.5 px-2 py-1 text-[11px] text-ctp-text hover:bg-ctp-surface0 transition-colors text-left"
              onClick={() => handleNavigate(entry)}
            >
              <span className="text-ctp-overlay0 text-[10px]">{entry.isDirectory ? '/' : '#'}</span>
              <span className="truncate">{entry.name}</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
