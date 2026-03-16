import React, { useState, useEffect, useMemo, useCallback } from 'react';
import type { FileCanvasView as FileCanvasViewType, CanvasView } from './canvas-types';
import type { PluginAPI } from '../../../../shared/plugin-types';

interface FileCanvasViewProps {
  view: FileCanvasViewType;
  api: PluginAPI;
  onUpdate: (updates: Partial<CanvasView>) => void;
}

function projectColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 55%, 55%)`;
}

/**
 * List directory entries for a project path.
 * In project mode, uses api.project.listDirectory.
 * In app mode, uses window.clubhouse.file.readTree directly since
 * api.project is not available outside a project context.
 */
async function listProjectDir(
  api: PluginAPI,
  isAppMode: boolean,
  projectPath: string,
  relativePath: string,
): Promise<Array<{ name: string; path: string; isDirectory: boolean }>> {
  if (isAppMode) {
    const fullPath = relativePath ? `${projectPath}/${relativePath}` : projectPath;
    const tree = await window.clubhouse.file.readTree(fullPath);
    return tree.map((node: { name: string; path: string; isDirectory: boolean }) => ({
      name: node.name,
      path: relativePath ? `${relativePath}/${node.name}` : node.name,
      isDirectory: node.isDirectory,
    }));
  } else {
    const entries = await api.project.listDirectory(relativePath || '.');
    // listDirectory returns absolute paths — construct relative paths ourselves
    return entries.map((e) => ({
      name: e.name,
      path: relativePath ? `${relativePath}/${e.name}` : e.name,
      isDirectory: e.isDirectory,
    }));
  }
}

/**
 * Read file content for a project.
 */
async function readProjectFile(
  api: PluginAPI,
  isAppMode: boolean,
  projectPath: string,
  relativePath: string,
): Promise<string> {
  if (isAppMode) {
    return window.clubhouse.file.read(`${projectPath}/${relativePath}`);
  } else {
    return api.project.readFile(relativePath);
  }
}

export function FileCanvasView({ view, api, onUpdate }: FileCanvasViewProps) {
  const isAppMode = api.context.mode === 'app';
  const projects = useMemo(() => api.projects.list(), [api]);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [fileTree, setFileTree] = useState<Array<{ name: string; path: string; isDirectory: boolean }>>([]);
  const [currentDir, setCurrentDir] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [showHidden, setShowHidden] = useState(() => api.settings.get<boolean>('showHiddenFiles') ?? true);

  const activeProjectId = view.projectId || (isAppMode ? undefined : api.context.projectId);
  const activeProject = useMemo(
    () => activeProjectId ? projects.find((p) => p.id === activeProjectId) : null,
    [projects, activeProjectId],
  );

  // Subscribe to showHiddenFiles setting changes
  useEffect(() => {
    const sub = api.settings.onChange((key: string) => {
      if (key === 'showHiddenFiles') {
        setShowHidden(api.settings.get<boolean>('showHiddenFiles') ?? true);
      }
    });
    return () => sub.dispose();
  }, [api]);

  // Load directory listing
  useEffect(() => {
    if (!activeProjectId || !activeProject) return;
    setLoading(true);
    listProjectDir(api, isAppMode, activeProject.path, currentDir)
      .then(setFileTree)
      .catch(() => setFileTree([]))
      .finally(() => setLoading(false));
  }, [api, activeProjectId, activeProject, currentDir, isAppMode]);

  // Load file content when a file is selected
  useEffect(() => {
    if (!view.filePath || !activeProjectId || !activeProject) {
      setFileContent(null);
      return;
    }
    readProjectFile(api, isAppMode, activeProject.path, view.filePath)
      .then(setFileContent)
      .catch(() => setFileContent('Error reading file'));
  }, [api, view.filePath, activeProjectId, activeProject, isAppMode]);

  // Filter hidden files based on setting
  const filteredTree = useMemo(() => {
    if (showHidden) return fileTree;
    return fileTree.filter((entry) => !entry.name.startsWith('.'));
  }, [fileTree, showHidden]);

  const handleSelectProject = useCallback((projectId: string) => {
    const project = projects.find((p) => p.id === projectId);
    onUpdate({ projectId, filePath: undefined, title: project?.name || 'Files' } as Partial<FileCanvasViewType>);
    setCurrentDir('');
    setFileContent(null);
  }, [projects, onUpdate]);

  const handleNavigate = useCallback((entry: { name: string; path: string; isDirectory: boolean }) => {
    if (entry.isDirectory) {
      setCurrentDir(entry.path);
      setFileContent(null);
      onUpdate({ filePath: undefined } as Partial<FileCanvasViewType>);
    } else {
      onUpdate({ filePath: entry.path, title: entry.name } as Partial<FileCanvasViewType>);
    }
  }, [onUpdate]);

  const handleGoUp = useCallback(() => {
    const parent = currentDir.split('/').slice(0, -1).join('/');
    setCurrentDir(parent);
    setFileContent(null);
    onUpdate({ filePath: undefined } as Partial<FileCanvasViewType>);
  }, [currentDir, onUpdate]);

  const handleBackToProjects = useCallback(() => {
    onUpdate({ projectId: undefined, filePath: undefined, title: 'Files' } as Partial<FileCanvasViewType>);
    setCurrentDir('');
    setFileContent(null);
  }, [onUpdate]);

  // No project selected — show project picker
  if (!activeProjectId) {
    return (
      <div className="flex flex-col h-full p-2">
        <div className="text-xs font-medium text-ctp-subtext1 uppercase tracking-wider mb-2">
          Select a project
        </div>
        {projects.length === 0 ? (
          <div className="text-xs text-ctp-overlay0 italic">No projects open</div>
        ) : (
          <div className="flex-1 overflow-y-auto space-y-1">
            {projects.map((p) => {
              const color = projectColor(p.name);
              const initials = p.name.slice(0, 2).toUpperCase();
              return (
                <button
                  key={p.id}
                  className="w-full flex items-center gap-2.5 px-2 py-2 rounded-lg bg-surface-0 hover:bg-surface-1 text-left transition-colors"
                  onClick={() => handleSelectProject(p.id)}
                >
                  <div
                    className="w-6 h-6 rounded-md flex items-center justify-center text-[9px] font-bold text-white flex-shrink-0"
                    style={{ backgroundColor: color }}
                  >
                    {initials}
                  </div>
                  <span className="text-[11px] text-ctp-text truncate">{p.name}</span>
                </button>
              );
            })}
          </div>
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
            onClick={() => onUpdate({ filePath: undefined, title: activeProject?.name || 'Files' } as Partial<FileCanvasViewType>)}
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
        {isAppMode && (
          <button
            className="hover:text-ctp-text transition-colors mr-1"
            onClick={handleBackToProjects}
            title="Back to projects"
          >
            &larr;
          </button>
        )}
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
          filteredTree.map((entry) => (
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
