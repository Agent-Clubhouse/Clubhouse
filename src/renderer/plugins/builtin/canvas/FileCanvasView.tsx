import React, { useState, useEffect, useMemo, useCallback } from 'react';
import type { FileCanvasView as FileCanvasViewType, CanvasView } from './canvas-types';
import type { PluginAPI } from '../../../../shared/plugin-types';
import { CanvasFileTree } from './CanvasFileTree';
import { ReadOnlyMonacoEditor } from './ReadOnlyMonacoEditor';
import { ResizableSidebar } from './ResizableSidebar';

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
  const [showHidden, setShowHidden] = useState(() => api.settings.get<boolean>('showHiddenFiles') ?? true);
  const [readOnly, setReadOnly] = useState(true);

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

  // Load file content when a file is selected
  useEffect(() => {
    if (!view.filePath || !activeProjectId || !activeProject) {
      setFileContent(null);
      return;
    }
    setFileContent(null); // Clear while loading
    readProjectFile(api, isAppMode, activeProject.path, view.filePath)
      .then(setFileContent)
      .catch(() => setFileContent('Error reading file'));
  }, [api, view.filePath, activeProjectId, activeProject, isAppMode]);

  const handleSelectProject = useCallback((projectId: string) => {
    const project = projects.find((p) => p.id === projectId);
    onUpdate({ projectId, filePath: undefined, title: project?.name || 'Files', metadata: { projectId, filePath: null } } as Partial<FileCanvasViewType>);
    setFileContent(null);
  }, [projects, onUpdate]);

  const handleSelectFile = useCallback((filePath: string) => {
    const fileName = filePath.split('/').pop() || filePath;
    onUpdate({ filePath, title: fileName, metadata: { filePath, projectId: activeProjectId ?? null } } as Partial<FileCanvasViewType>);
  }, [onUpdate]);

  const handleSave = useCallback(async (content: string) => {
    if (!view.filePath || !activeProject) return;
    if (isAppMode) {
      await window.clubhouse.file.write(`${activeProject.path}/${view.filePath}`, content);
    } else {
      await api.project.writeFile(view.filePath, content);
    }
    setFileContent(content);
  }, [api, isAppMode, activeProject, view.filePath]);

  const handleBackToProjects = useCallback(() => {
    onUpdate({ projectId: undefined, filePath: undefined, title: 'Files' } as Partial<FileCanvasViewType>);
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

  // Split layout: tree sidebar + file content
  return (
    <div className="flex flex-col h-full">
      {/* Header bar */}
      <div className="flex items-center gap-1 px-2 py-1 bg-ctp-surface0/50 border-b border-surface-0 text-[10px] text-ctp-subtext0 flex-shrink-0">
        {isAppMode && (
          <button
            className="hover:text-ctp-text transition-colors mr-1"
            onClick={handleBackToProjects}
            title="Back to projects"
          >
            &larr;
          </button>
        )}
        <span className="truncate font-medium text-ctp-subtext1">
          {activeProject?.name || 'Project'}
        </span>
        {view.filePath && (
          <>
            <span className="text-ctp-overlay0 mx-0.5">/</span>
            <span className="truncate">{view.filePath}</span>
          </>
        )}
        <span className="flex-1" />
        <label
          className="flex items-center gap-1 cursor-pointer select-none ml-2"
          title={readOnly ? 'Read-only mode' : 'Edit mode'}
        >
          <input
            type="checkbox"
            checked={readOnly}
            onChange={(e) => setReadOnly(e.target.checked)}
            className="accent-ctp-blue w-3 h-3"
            data-testid="file-readonly-toggle"
          />
          <span className={readOnly ? 'text-ctp-subtext0' : 'text-ctp-peach'}>
            {readOnly ? 'Read-only' : 'Editing'}
          </span>
        </label>
      </div>

      {/* Split panel: tree + content */}
      <div className="flex flex-1 min-h-0">
        {/* File tree sidebar */}
        <ResizableSidebar defaultWidth={180} minWidth={120} maxWidth={400} className="overflow-hidden flex flex-col bg-ctp-mantle/30">
          <CanvasFileTree
            api={api}
            projectPath={activeProject?.path || ''}
            isAppMode={isAppMode}
            selectedPath={view.filePath || null}
            showHidden={showHidden}
            onSelectFile={handleSelectFile}
          />
        </ResizableSidebar>

        {/* File content area */}
        <div className="flex-1 min-w-0 flex flex-col">
          {view.filePath && fileContent !== null ? (
            <ReadOnlyMonacoEditor
              value={fileContent}
              filePath={view.filePath}
              readOnly={readOnly}
              onSave={handleSave}
            />
          ) : view.filePath && fileContent === null ? (
            <div className="flex-1 flex items-center justify-center text-ctp-subtext0 text-xs">
              Loading&hellip;
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center text-ctp-overlay0 text-xs">
              Select a file to view
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
