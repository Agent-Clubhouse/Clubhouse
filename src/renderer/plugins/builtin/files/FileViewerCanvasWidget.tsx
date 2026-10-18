// Canvas widget for file viewing — registered as plugin:files:file-viewer.
// Provides the same file browsing + Monaco editor experience as the
// built-in canvas FileCanvasView, but delivered through the v0.8 widget API
// so 1p widgets go through the same registration/validation path as 3p.

import React, { useState, useEffect, useMemo, useCallback, useId } from 'react';
import type { CanvasWidgetComponentProps, PluginAPI } from '../../../../shared/plugin-types';
import type { GitWorktreeEntry, FileNode } from '../../../../shared/types';
import { useEditorSettingsStore } from '../../../../renderer/stores/editorSettingsStore';
import { CanvasFileTree } from '../canvas/CanvasFileTree';
import { ReadOnlyMonacoEditor } from '../canvas/ReadOnlyMonacoEditor';
import { MarkdownPreview } from './MarkdownPreview';
import { ResizableSidebar } from '../canvas/ResizableSidebar';
import { useRemoteProject } from '../../../hooks/useRemoteProject';
import { EmptyState } from '../../../components/EmptyState';
import { Button } from '../../../components/Button';
import { Toggle } from '../../../components/Toggle';
import { Tooltip } from '../../../components/Tooltip';
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
  const editLabelId = useId();
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
      <div className="h-[30px] flex items-center gap-1 pl-1 pr-1.5 border-b border-surface-0 flex-shrink-0 min-w-0">
        {isAppMode && (
          <Tooltip content="Back to projects">
            <Button kind="quiet" aria-label="Back to projects" icon={<ToolbarIcon d="M15 6l-6 6 6 6" />} onClick={handleBackToProjects} />
          </Tooltip>
        )}
        <span className={`truncate text-[13px] font-medium text-ctp-text flex-shrink-0 max-w-[40%] ${isAppMode ? '' : 'pl-1.5'}`}>
          {activeProject?.name || 'Project'}
        </span>
        {remote.isRemote && <span className="text-xs text-ctp-overlay1 flex-shrink-0">Remote</span>}
        {hasMultipleWorktrees && !remote.isRemote && (
          <select
            className="h-7 max-w-[140px] px-1.5 text-xs bg-ctp-base text-ctp-subtext1 border border-surface-1 rounded-md cursor-pointer truncate focus-ring"
            value={rootPath}
            onChange={(e) => handleSelectWorktree(e.target.value)}
            aria-label="Switch worktree root"
          >
            {worktrees.map((wt) => (
              <option key={wt.path} value={wt.path}>
                {wt.isBare ? '/ (main)' : wt.label}
                {wt.branch ? ` [${wt.branch}]` : ''}
              </option>
            ))}
          </select>
        )}
        {filePath && (
          <Tooltip content={filePath} onlyWhenTruncated>
            <span className="truncate text-xs text-ctp-overlay1 min-w-0 pl-1">{filePath}</span>
          </Tooltip>
        )}
        <span className="flex-1" />
        {fullFilePath && !remote.isRemote && (
          <>
            <Tooltip content="Reveal in Finder">
              <Button kind="quiet" aria-label="Reveal in Finder" icon={<ToolbarIcon d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />} onClick={handleShowInFolder} />
            </Tooltip>
            <Tooltip content={`Open in ${editorName}`}>
              <Button kind="quiet" aria-label={`Open in ${editorName}`} icon={<ToolbarIcon d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3" />} onClick={handleOpenInEditor} />
            </Tooltip>
          </>
        )}
        {filePath && isMarkdownFile(filePath) && fileContent !== null && (
          <span className="flex items-center gap-0.5 flex-shrink-0" role="group" aria-label="Markdown view">
            {(['preview', 'source'] as const).map((mode) => (
              <button
                key={mode}
                className={`h-7 px-2 rounded-md text-xs ${previewMode === mode ? 'bg-surface-0 text-ctp-text' : 'text-ctp-subtext1 hover:bg-surface-0'}`}
                aria-pressed={previewMode === mode}
                onClick={() => setPreviewMode(mode)}
              >
                {mode === 'preview' ? 'Preview' : 'Source'}
              </button>
            ))}
          </span>
        )}
        {remote.isRemote ? (
          <span className="text-xs text-ctp-overlay1 flex-shrink-0 pl-1.5">Read-only</span>
        ) : (
          <span className="flex items-center gap-2 flex-shrink-0 pl-1.5">
            <span id={editLabelId} className="text-xs text-ctp-subtext1">Edit</span>
            <Toggle checked={!readOnly} onChange={() => setReadOnly((v) => !v)} aria-labelledby={editLabelId} />
          </span>
        )}
      </div>

      {/* Split panel: tree + content */}
      <div className="flex flex-1 min-h-0">
        <ResizableSidebar defaultWidth={180} minWidth={120} maxWidth={400} className="overflow-hidden flex flex-col border-r border-surface-0">
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

/** A 14px stroke icon for the header buttons. */
function ToolbarIcon({ d }: { d: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}
