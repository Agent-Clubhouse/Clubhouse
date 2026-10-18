// Canvas widget for file viewing — registered as plugin:files:file-viewer.
// Provides the same file browsing + Monaco editor experience as the
// built-in canvas FileCanvasView, but delivered through the v0.8 widget API
// so 1p widgets go through the same registration/validation path as 3p.

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import type { CanvasWidgetComponentProps, PluginAPI } from '../../../../shared/plugin-types';
import type { GitWorktreeEntry, FileNode } from '../../../../shared/types';
import { useEditorSettingsStore } from '../../../../renderer/stores/editorSettingsStore';
import { CanvasFileTree } from '../canvas/CanvasFileTree';
import { ReadOnlyMonacoEditor } from '../canvas/ReadOnlyMonacoEditor';
import { MarkdownPreview } from './MarkdownPreview';
import { ResizableSidebar } from '../canvas/ResizableSidebar';
import { useRemoteProject } from '../../../hooks/useRemoteProject';
import { EmptyState } from '../../../components/EmptyState';
import { WidgetPicker, projectRows } from '../canvas/WidgetPicker';

function isMarkdownFile(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith('.md') || lower.endsWith('.mdx');
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

  // Loaded content is tagged with the file it was read from, so a late response
  // for a previously selected file can never be shown, edited or saved as another.
  const [loadedFile, setLoadedFile] = useState<{ key: string; content: string; error?: boolean } | null>(null);
  const [showHidden, setShowHidden] = useState(() => api.settings.get<boolean>('showHiddenFiles') ?? true);
  const [readOnly, setReadOnly] = useState(true);
  const [previewMode, setPreviewMode] = useState<'preview' | 'source'>('preview');
  const [worktrees, setWorktrees] = useState<GitWorktreeEntry[]>([]);

  const projectId = (metadata.projectId as string) || (isAppMode ? undefined : api.context.projectId);
  const filePath = metadata.filePath as string | undefined;

  const remote = useRemoteProject(projectId);

  const activeProject = useMemo(
    () => projectId ? projects.find((p) => p.id === projectId) : null,
    [projects, projectId],
  );

  // Root path: worktree path from metadata, falling back to project path
  const rootPath = (metadata.rootPath as string) || activeProject?.path || '';
  const hasMultipleWorktrees = worktrees.length > 1;

  // Fetch git worktrees when project is selected (skip for remote)
  useEffect(() => {
    if (!activeProject?.path || remote.isRemote) {
      setWorktrees([]);
      return;
    }
    window.clubhouse.git.listWorktrees(activeProject.path)
      .then((wts: GitWorktreeEntry[]) => setWorktrees(wts))
      .catch(() => setWorktrees([]));
  }, [activeProject?.path, remote.isRemote]);

  useEffect(() => {
    const sub = api.settings.onChange((key: string) => {
      if (key === 'showHiddenFiles') {
        setShowHidden(api.settings.get<boolean>('showHiddenFiles') ?? true);
      }
    });
    return () => sub.dispose();
  }, [api]);

  const fileKey = filePath && projectId
    ? `${projectId}\u0000${remote.isRemote ? 'remote' : rootPath}\u0000${filePath}`
    : null;
  const currentFile = loadedFile && loadedFile.key === fileKey ? loadedFile : null;
  const fileContent = currentFile && !currentFile.error ? currentFile.content : null;

  useEffect(() => {
    if (!filePath || !fileKey || (!activeProject && !remote.isRemote)) {
      setLoadedFile(null);
      return;
    }
    setLoadedFile(null);
    let cancelled = false;
    const read = remote.isRemote && remote.satelliteId && remote.originalProjectId
      ? api.annex.fileRead(remote.satelliteId, remote.originalProjectId, filePath)
      : readProjectFile(api, isAppMode, rootPath, filePath);
    read
      .then((content) => { if (!cancelled) setLoadedFile({ key: fileKey, content }); })
      .catch(() => { if (!cancelled) setLoadedFile({ key: fileKey, content: 'Error reading file', error: true }); });
    return () => { cancelled = true; };
  }, [api, filePath, fileKey, activeProject, isAppMode, rootPath, remote]);

  // Create remote file loader for CanvasFileTree
  const remoteFileLoader = useMemo(() => {
    if (!remote.isRemote || !remote.satelliteId || !remote.originalProjectId) return undefined;
    const { satelliteId, originalProjectId } = remote;
    return async (dirPath: string): Promise<FileNode[]> => {
      const items = await api.annex.fileTree(
        satelliteId, originalProjectId, { path: dirPath || undefined },
      ) as Array<{ name: string; path: string; isDirectory: boolean }>;
      return items.map((item) => ({
        name: item.name,
        path: item.path,
        isDirectory: item.isDirectory,
      }));
    };
  }, [remote, api.annex]);

  const handleSelectProject = useCallback((pid: string) => {
    onUpdateMetadata({ projectId: pid, filePath: null, rootPath: null });
    setLoadedFile(null);
  }, [onUpdateMetadata]);

  const handleSelectFile = useCallback((fp: string) => {
    onUpdateMetadata({ filePath: fp, projectId: projectId ?? null });
    // Default markdown files to preview mode
    if (isMarkdownFile(fp)) {
      setPreviewMode('preview');
    }
  }, [onUpdateMetadata, projectId]);

  const handleSave = useCallback(async (content: string) => {
    // Only save over the file whose content is actually loaded
    if (!filePath || !fileKey || !activeProject || remote.isRemote || !currentFile || currentFile.error) return;
    try {
      if (isAppMode) {
        await window.clubhouse.file.write(`${rootPath}/${filePath}`, content);
      } else {
        await api.project.writeFile(filePath, content);
      }
    } catch (err) {
      api.ui.showError(`Failed to save: ${err}`);
      return;
    }
    setLoadedFile((prev) => (prev && prev.key === fileKey ? { key: fileKey, content } : prev));
  }, [api, isAppMode, rootPath, activeProject, filePath, fileKey, currentFile, remote.isRemote]);

  const handleBackToProjects = useCallback(() => {
    onUpdateMetadata({ projectId: null, filePath: null, rootPath: null });
    setLoadedFile(null);
  }, [onUpdateMetadata]);

  const handleSelectWorktree = useCallback((wtPath: string) => {
    onUpdateMetadata({ rootPath: wtPath, filePath: null });
    setLoadedFile(null);
  }, [onUpdateMetadata]);

  const fullFilePath = rootPath && filePath
    ? `${rootPath}/${filePath}`
    : null;

  const handleShowInFolder = useCallback(() => {
    if (fullFilePath && !remote.isRemote) window.clubhouse.file.showInFolder(fullFilePath);
  }, [fullFilePath, remote.isRemote]);

  const handleOpenInEditor = useCallback(() => {
    if (fullFilePath && !remote.isRemote) window.clubhouse.file.openInEditor(fullFilePath);
  }, [fullFilePath, remote.isRemote]);

  // No project selected — show project picker
  if (!projectId) {
    return (
      <WidgetPicker
        searchPlaceholder="Find a project"
        emptyText="No projects open"
        sections={[{ id: 'projects', rows: projectRows(projects, handleSelectProject) }]}
      />
    );
  }

  // Split layout: tree sidebar + file content
  return (
    <div className="flex flex-col h-full">
      {/* Header bar */}
      <div className="flex items-center gap-1 px-2 py-1 bg-surface-0/50 border-b border-surface-0 text-xs text-ctp-subtext0 flex-shrink-0">
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
        {remote.isRemote && (
          <span className="text-[8px] text-ctp-peach bg-ctp-peach/10 px-1.5 py-0.5 rounded ml-1">
            remote
          </span>
        )}
        {hasMultipleWorktrees && !remote.isRemote && (
          <>
            <span className="text-ctp-overlay0 mx-0.5">/</span>
            <select
              className="text-xs bg-surface-0 text-ctp-subtext1 border-none rounded px-1 py-0.5 cursor-pointer truncate outline-none max-w-[120px]"
              value={rootPath}
              onChange={(e) => handleSelectWorktree(e.target.value)}
              title="Switch worktree root"
            >
              {worktrees.map((wt) => (
                <option key={wt.path} value={wt.path}>
                  {wt.isBare ? '/ (main)' : wt.label}
                  {wt.branch ? ` [${wt.branch}]` : ''}
                </option>
              ))}
            </select>
          </>
        )}
        {filePath && (
          <>
            <span className="text-ctp-overlay0 mx-0.5">/</span>
            <span className="truncate">{filePath}</span>
          </>
        )}
        <span className="flex-1" />
        {fullFilePath && !remote.isRemote && (
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
        {filePath && isMarkdownFile(filePath) && fileContent !== null && (
          <div className="flex items-center bg-surface-0 rounded text-xs ml-2">
            <button
              className={`px-2 py-0.5 rounded cursor-pointer ${previewMode === 'preview' ? 'bg-surface-1 text-ctp-text' : 'text-ctp-subtext0'}`}
              onClick={() => setPreviewMode('preview')}
            >
              Preview
            </button>
            <button
              className={`px-2 py-0.5 rounded cursor-pointer ${previewMode === 'source' ? 'bg-surface-1 text-ctp-text' : 'text-ctp-subtext0'}`}
              onClick={() => setPreviewMode('source')}
            >
              Source
            </button>
          </div>
        )}
        <label
          className="flex items-center gap-1 cursor-pointer select-none ml-2"
          title={remote.isRemote ? 'Read-only (remote)' : readOnly ? 'Read-only mode' : 'Edit mode'}
        >
          <input
            type="checkbox"
            checked={remote.isRemote || readOnly}
            onChange={(e) => { if (!remote.isRemote) setReadOnly(e.target.checked); }}
            className="accent-ctp-accent w-3 h-3"
            disabled={remote.isRemote}
          />
          <span className={remote.isRemote ? 'text-ctp-overlay0' : readOnly ? 'text-ctp-subtext0' : 'text-ctp-peach'}>
            {remote.isRemote ? 'Read-only' : readOnly ? 'Read-only' : 'Editing'}
          </span>
        </label>
      </div>

      {/* Split panel: tree + content */}
      <div className="flex flex-1 min-h-0">
        <ResizableSidebar defaultWidth={180} minWidth={120} maxWidth={400} className="overflow-hidden flex flex-col bg-ctp-mantle/30">
          <CanvasFileTree
            api={api}
            projectPath={rootPath}
            isAppMode={isAppMode}
            selectedPath={filePath || null}
            showHidden={showHidden}
            onSelectFile={handleSelectFile}
            fileLoader={remoteFileLoader}
          />
        </ResizableSidebar>

        <div className="flex-1 min-w-0 flex flex-col">
          {filePath && fileContent !== null && isMarkdownFile(filePath) && previewMode === 'preview' ? (
            <MarkdownPreview content={fileContent} />
          ) : filePath && fileContent !== null ? (
            <ReadOnlyMonacoEditor
              value={fileContent}
              filePath={filePath}
              readOnly={remote.isRemote || readOnly}
              onSave={handleSave}
            />
          ) : filePath && currentFile?.error ? (
            <div className="flex-1 flex items-center justify-center text-ctp-error text-xs">
              {currentFile.content}
            </div>
          ) : filePath && fileContent === null ? (
            <div className="flex-1 flex items-center justify-center text-ctp-subtext0 text-xs">
              Loading&hellip;
            </div>
          ) : (
            <EmptyState title="Select a file to view" compact />
          )}
        </div>
      </div>
    </div>
  );
}
