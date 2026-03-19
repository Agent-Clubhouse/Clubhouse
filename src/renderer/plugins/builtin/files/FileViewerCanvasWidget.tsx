// Canvas widget for file viewing — registered as plugin:files:file-viewer.
// Provides the same file browsing + Monaco editor experience as the
// built-in canvas FileCanvasView, but delivered through the v0.8 widget API
// so 1p widgets go through the same registration/validation path as 3p.

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import type { CanvasWidgetComponentProps, PluginAPI } from '../../../../shared/plugin-types';
import { useEditorSettingsStore } from '../../../../renderer/stores/editorSettingsStore';
import { CanvasFileTree } from '../canvas/CanvasFileTree';
import { ReadOnlyMonacoEditor } from '../canvas/ReadOnlyMonacoEditor';
import { ResizableSidebar } from '../canvas/ResizableSidebar';

function projectColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 55%, 55%)`;
}

async function readProjectFile(
  api: PluginAPI,
  isAppMode: boolean,
  projectPath: string,
  relativePath: string,
): Promise<string> {
  if (isAppMode) {
    return window.clubhouse.file.read(`${projectPath}/${relativePath}`);
  }
  return api.project.readFile(relativePath);
}

export function FileViewerCanvasWidget({ widgetId: _widgetId, api, metadata, onUpdateMetadata, size: _size }: CanvasWidgetComponentProps) {
  const isAppMode = api.context.mode === 'app';
  const projects = useMemo(() => api.projects.list(), [api]);
  const editorName = useEditorSettingsStore((s) => s.editorName);
  const loadEditorSettings = useEditorSettingsStore((s) => s.loadSettings);

  useEffect(() => { loadEditorSettings(); }, [loadEditorSettings]);

  const [fileContent, setFileContent] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(() => api.settings.get<boolean>('showHiddenFiles') ?? true);
  const [readOnly, setReadOnly] = useState(true);

  const projectId = (metadata.projectId as string) || (isAppMode ? undefined : api.context.projectId);
  const filePath = metadata.filePath as string | undefined;

  const activeProject = useMemo(
    () => projectId ? projects.find((p) => p.id === projectId) : null,
    [projects, projectId],
  );

  useEffect(() => {
    const sub = api.settings.onChange((key: string) => {
      if (key === 'showHiddenFiles') {
        setShowHidden(api.settings.get<boolean>('showHiddenFiles') ?? true);
      }
    });
    return () => sub.dispose();
  }, [api]);

  useEffect(() => {
    if (!filePath || !projectId || !activeProject) {
      setFileContent(null);
      return;
    }
    setFileContent(null);
    readProjectFile(api, isAppMode, activeProject.path, filePath)
      .then(setFileContent)
      .catch(() => setFileContent('Error reading file'));
  }, [api, filePath, projectId, activeProject, isAppMode]);

  const handleSelectProject = useCallback((pid: string) => {
    onUpdateMetadata({ projectId: pid, filePath: null });
    setFileContent(null);
  }, [onUpdateMetadata]);

  const handleSelectFile = useCallback((fp: string) => {
    onUpdateMetadata({ filePath: fp, projectId: projectId ?? null });
  }, [onUpdateMetadata, projectId]);

  const handleSave = useCallback(async (content: string) => {
    if (!filePath || !activeProject) return;
    if (isAppMode) {
      await window.clubhouse.file.write(`${activeProject.path}/${filePath}`, content);
    } else {
      await api.project.writeFile(filePath, content);
    }
    setFileContent(content);
  }, [api, isAppMode, activeProject, filePath]);

  const handleBackToProjects = useCallback(() => {
    onUpdateMetadata({ projectId: null, filePath: null });
    setFileContent(null);
  }, [onUpdateMetadata]);

  const fullFilePath = activeProject && filePath
    ? `${activeProject.path}/${filePath}`
    : null;

  const handleShowInFolder = useCallback(() => {
    if (fullFilePath) window.clubhouse.file.showInFolder(fullFilePath);
  }, [fullFilePath]);

  const handleOpenInEditor = useCallback(() => {
    if (fullFilePath) window.clubhouse.file.openInEditor(fullFilePath);
  }, [fullFilePath]);

  // No project selected — show project picker
  if (!projectId) {
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
        {filePath && (
          <>
            <span className="text-ctp-overlay0 mx-0.5">/</span>
            <span className="truncate">{filePath}</span>
          </>
        )}
        <span className="flex-1" />
        {fullFilePath && (
          <>
            <button
              className="hover:text-ctp-text transition-colors px-1"
              onClick={handleShowInFolder}
              title="Reveal in Finder"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
            </button>
            <button
              className="hover:text-ctp-text transition-colors px-1"
              onClick={handleOpenInEditor}
              title={`Open in ${editorName}`}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                <polyline points="15 3 21 3 21 9" />
                <line x1="10" y1="14" x2="21" y2="3" />
              </svg>
            </button>
          </>
        )}
        <label
          className="flex items-center gap-1 cursor-pointer select-none ml-2"
          title={readOnly ? 'Read-only mode' : 'Edit mode'}
        >
          <input
            type="checkbox"
            checked={readOnly}
            onChange={(e) => setReadOnly(e.target.checked)}
            className="accent-ctp-blue w-3 h-3"
          />
          <span className={readOnly ? 'text-ctp-subtext0' : 'text-ctp-peach'}>
            {readOnly ? 'Read-only' : 'Editing'}
          </span>
        </label>
      </div>

      {/* Split panel: tree + content */}
      <div className="flex flex-1 min-h-0">
        <ResizableSidebar defaultWidth={180} minWidth={120} maxWidth={400} className="overflow-hidden flex flex-col bg-ctp-mantle/30">
          <CanvasFileTree
            api={api}
            projectPath={activeProject?.path || ''}
            isAppMode={isAppMode}
            selectedPath={filePath || null}
            showHidden={showHidden}
            onSelectFile={handleSelectFile}
          />
        </ResizableSidebar>

        <div className="flex-1 min-w-0 flex flex-col">
          {filePath && fileContent !== null ? (
            <ReadOnlyMonacoEditor
              value={fileContent}
              filePath={filePath}
              readOnly={readOnly}
              onSave={handleSave}
            />
          ) : filePath && fileContent === null ? (
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
