import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import type { GitDiffCanvasView as GitDiffCanvasViewType, CanvasView } from './canvas-types';
import type { PluginAPI } from '../../../../shared/plugin-types';
import type { GitInfo } from '../../../../shared/types';
import { useEditorSettingsStore } from '../../../../renderer/stores/editorSettingsStore';
import { MonacoDiffEditor } from './MonacoDiffEditor';
import { MenuPortal } from './MenuPortal';
import { ResizableSidebar } from './ResizableSidebar';

/** How often to poll git status (ms). */
export const GIT_POLL_INTERVAL_MS = 3000;

interface GitDiffCanvasViewProps {
  view: GitDiffCanvasViewType;
  api: PluginAPI;
  onUpdate: (updates: Partial<CanvasView>) => void;
}

// ── Status helpers ───────────────────────────────────────────────────

export interface StatusInfo {
  label: string;
  color: string;
  short: string;
}

/** Map a git porcelain status code to a human-readable label and color. */
export function statusInfo(code: string): StatusInfo {
  const c = code.trim();
  if (c === '??' || c === '?') return { label: 'Untracked', color: 'text-ctp-blue', short: 'U' };
  if (c.startsWith('A') || c === 'A') return { label: 'Added', color: 'text-ctp-green', short: 'A' };
  if (c.startsWith('D') || c === 'D') return { label: 'Deleted', color: 'text-ctp-red', short: 'D' };
  if (c.startsWith('M') || c === 'M') return { label: 'Modified', color: 'text-ctp-yellow', short: 'M' };
  if (c.startsWith('R')) return { label: 'Renamed', color: 'text-ctp-mauve', short: 'R' };
  if (c.startsWith('C')) return { label: 'Copied', color: 'text-ctp-teal', short: 'C' };
  return { label: 'Changed', color: 'text-ctp-overlay0', short: '~' };
}

function projectColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 55%, 55%)`;
}

// ── Worktree entry ───────────────────────────────────────────────────

interface WorktreeOption {
  label: string;
  path: string;
  agentName?: string;
}

// ── Component ────────────────────────────────────────────────────────

export function GitDiffCanvasView({ view, api, onUpdate }: GitDiffCanvasViewProps) {
  const isAppMode = api.context.mode === 'app';
  const projects = useMemo(() => api.projects.list(), [api]);
  const agents = useMemo(() => api.agents.list(), [api]);
  const editorName = useEditorSettingsStore((s) => s.editorName);
  const loadEditorSettings = useEditorSettingsStore((s) => s.loadSettings);

  useEffect(() => {
    loadEditorSettings();
  }, [loadEditorSettings]);

  const [gitInfo, setGitInfo] = useState<GitInfo | null>(null);
  const [diffData, setDiffData] = useState<{ original: string; modified: string } | null>(null);
  const [loading, setLoading] = useState(false);

  const activeProjectId = view.projectId || (isAppMode ? undefined : api.context.projectId);
  const activeProject = useMemo(
    () => activeProjectId ? projects.find((p) => p.id === activeProjectId) : null,
    [projects, activeProjectId],
  );

  // Worktrees for the selected project (from agents)
  const worktrees = useMemo((): WorktreeOption[] => {
    if (!activeProject) return [];
    const opts: WorktreeOption[] = [];
    for (const agent of agents) {
      if (agent.projectId === activeProjectId && agent.worktreePath) {
        opts.push({
          label: agent.name,
          path: agent.worktreePath,
          agentName: agent.name,
        });
      }
    }
    return opts;
  }, [agents, activeProjectId, activeProject]);

  // The effective directory to run git commands against
  const effectivePath = view.worktreePath || activeProject?.path;

  // Track whether initial load has completed (to avoid flicker on polls)
  const initialLoadDone = useRef(false);

  // Reset initial-load flag when the target path changes
  useEffect(() => {
    initialLoadDone.current = false;
  }, [effectivePath]);

  // ── Fetch helpers (reusable by initial load + poll) ─────────────

  const fetchGitInfo = useCallback((dir: string, isInitial: boolean) => {
    if (isInitial) {
      setGitInfo(null);
      setLoading(true);
    }
    window.clubhouse.git.info(dir)
      .then((info: GitInfo) => {
        setGitInfo(info);
        if (isInitial) setLoading(false);
        initialLoadDone.current = true;
      })
      .catch(() => {
        if (isInitial) { setGitInfo(null); setLoading(false); }
      });
  }, []);

  const fetchDiff = useCallback((dir: string, filePath: string, isInitial: boolean) => {
    if (isInitial) setDiffData(null);
    window.clubhouse.git.diff(dir, filePath, false)
      .then((data: { original: string; modified: string }) => setDiffData(data))
      .catch(() => { if (isInitial) setDiffData(null); });
  }, []);

  // ── Initial load when project/worktree changes ──────────────────

  useEffect(() => {
    if (!effectivePath) {
      setGitInfo(null);
      return;
    }
    fetchGitInfo(effectivePath, true);
  }, [effectivePath, fetchGitInfo]);

  // ── Initial diff load when file selection changes ───────────────

  useEffect(() => {
    if (!view.filePath || !effectivePath) {
      setDiffData(null);
      return;
    }
    fetchDiff(effectivePath, view.filePath, true);
  }, [view.filePath, effectivePath, fetchDiff]);

  // ── Periodic polling for auto-refresh ───────────────────────────

  useEffect(() => {
    if (!effectivePath) return;

    const poll = () => {
      if (document.hidden) return;
      fetchGitInfo(effectivePath, false);
      if (view.filePath) {
        fetchDiff(effectivePath, view.filePath, false);
      }
    };

    const intervalId = setInterval(poll, GIT_POLL_INTERVAL_MS);

    // Also refresh immediately when the tab becomes visible again
    const onVisibilityChange = () => {
      if (!document.hidden) poll();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      clearInterval(intervalId);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [effectivePath, view.filePath, fetchGitInfo, fetchDiff]);

  // ── Manual refresh ──────────────────────────────────────────────

  const handleRefresh = useCallback(() => {
    if (!effectivePath) return;
    fetchGitInfo(effectivePath, false);
    if (view.filePath) {
      fetchDiff(effectivePath, view.filePath, false);
    }
  }, [effectivePath, view.filePath, fetchGitInfo, fetchDiff]);

  // ── Context menu state ─────────────────────────────────────────
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; filePath: string; status: string; staged: boolean } | null>(null);
  const [confirmRevert, setConfirmRevert] = useState<string | null>(null);

  const handleFileContextMenu = useCallback((e: React.MouseEvent, filePath: string, status: string, staged: boolean) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, filePath, status, staged });
  }, []);

  const handleStageFile = useCallback(async (filePath: string) => {
    if (!effectivePath) return;
    await window.clubhouse.git.stage(effectivePath, filePath);
    setContextMenu(null);
    handleRefresh();
  }, [effectivePath, handleRefresh]);

  const handleUnstageFile = useCallback(async (filePath: string) => {
    if (!effectivePath) return;
    await window.clubhouse.git.unstage(effectivePath, filePath);
    setContextMenu(null);
    handleRefresh();
  }, [effectivePath, handleRefresh]);

  const handleRevertFile = useCallback(async (filePath: string, isUntracked: boolean) => {
    if (!effectivePath) return;
    await window.clubhouse.git.discard(effectivePath, filePath, isUntracked);
    setContextMenu(null);
    setConfirmRevert(null);
    handleRefresh();
    // If we were viewing the reverted file, clear the diff
    if (view.filePath === filePath) {
      onUpdate({ filePath: undefined, title: activeProject?.name || 'Git Diff', metadata: { filePath: null } } as Partial<GitDiffCanvasViewType>);
      setDiffData(null);
    }
  }, [effectivePath, view.filePath, activeProject, onUpdate, handleRefresh]);

  // Close context menu on outside click
  useEffect(() => {
    if (!contextMenu) return;
    const handleClickOutside = () => { setContextMenu(null); setConfirmRevert(null); };
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, [contextMenu]);

  // ── Callbacks ───────────────────────────────────────────────────

  const handleSelectProject = useCallback((projectId: string) => {
    const project = projects.find((p) => p.id === projectId);
    onUpdate({
      projectId,
      worktreePath: undefined,
      filePath: undefined,
      title: project?.name || 'Git Diff',
      metadata: { projectId, worktreePath: null, filePath: null },
    } as Partial<GitDiffCanvasViewType>);
  }, [projects, onUpdate]);

  const handleSelectWorktree = useCallback((wt: WorktreeOption) => {
    onUpdate({
      worktreePath: wt.path,
      filePath: undefined,
      title: wt.label,
      metadata: { worktreePath: wt.path, filePath: null, projectId: activeProjectId ?? null },
    } as Partial<GitDiffCanvasViewType>);
  }, [activeProjectId, onUpdate]);

  const handleSelectMainRepo = useCallback(() => {
    onUpdate({
      worktreePath: undefined,
      filePath: undefined,
      title: activeProject?.name || 'Git Diff',
      metadata: { worktreePath: null, filePath: null, projectId: activeProjectId ?? null },
    } as Partial<GitDiffCanvasViewType>);
  }, [activeProject, activeProjectId, onUpdate]);

  const handleSelectFile = useCallback((filePath: string) => {
    const fileName = filePath.split('/').pop() || filePath;
    onUpdate({
      filePath,
      title: fileName,
      metadata: { filePath, projectId: activeProjectId ?? null, worktreePath: view.worktreePath ?? null },
    } as Partial<GitDiffCanvasViewType>);
  }, [activeProjectId, view.worktreePath, onUpdate]);

  const handleBackToProjects = useCallback(() => {
    onUpdate({
      projectId: undefined,
      worktreePath: undefined,
      filePath: undefined,
      title: 'Git Diff',
      metadata: { projectId: null, worktreePath: null, filePath: null },
    } as Partial<GitDiffCanvasViewType>);
    setGitInfo(null);
    setDiffData(null);
  }, [onUpdate]);

  const handleBackToFiles = useCallback(() => {
    onUpdate({
      filePath: undefined,
      title: activeProject?.name || 'Git Diff',
      metadata: { filePath: null },
    } as Partial<GitDiffCanvasViewType>);
    setDiffData(null);
  }, [activeProject, onUpdate]);

  const fullFilePath = effectivePath && view.filePath
    ? `${effectivePath}/${view.filePath}`
    : null;

  const handleShowInFolder = useCallback(() => {
    if (fullFilePath) window.clubhouse.file.showInFolder(fullFilePath);
  }, [fullFilePath]);

  const handleOpenInEditor = useCallback(() => {
    if (fullFilePath) window.clubhouse.file.openInEditor(fullFilePath);
  }, [fullFilePath]);

  // ── Step 1: Project picker ──────────────────────────────────────

  if (!activeProjectId) {
    return (
      <div className="flex flex-col h-full p-2">
        <div className="text-xs font-medium text-ctp-subtext1 uppercase tracking-wider mb-2">
          Select a repo
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
                  data-testid={`git-diff-project-${p.id}`}
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

  // ── Step 2: Worktree picker (if worktrees exist and none selected) ──

  if (worktrees.length > 0 && !view.worktreePath && !view.filePath) {
    return (
      <div className="flex flex-col h-full p-2">
        <div className="flex items-center gap-1 mb-2">
          {isAppMode && (
            <button
              className="text-[10px] text-ctp-subtext0 hover:text-ctp-text transition-colors mr-1"
              onClick={handleBackToProjects}
              title="Back to projects"
            >
              &larr;
            </button>
          )}
          <div className="text-xs font-medium text-ctp-subtext1 uppercase tracking-wider">
            Select a worktree
          </div>
        </div>
        <div className="flex-1 overflow-y-auto space-y-1">
          {/* Main repo option */}
          <button
            className="w-full flex items-center gap-2.5 px-2 py-2 rounded-lg bg-surface-0 hover:bg-surface-1 text-left transition-colors"
            onClick={handleSelectMainRepo}
            data-testid="git-diff-main-repo"
          >
            <div className="w-5 h-5 rounded flex items-center justify-center text-[10px] font-mono text-ctp-green bg-ctp-green/10 flex-shrink-0">
              *
            </div>
            <div className="min-w-0">
              <div className="text-[11px] text-ctp-text truncate">{activeProject?.name} (main)</div>
              <div className="text-[9px] text-ctp-overlay0 truncate">{activeProject?.path}</div>
            </div>
          </button>
          {/* Agent worktrees */}
          {worktrees.map((wt) => (
            <button
              key={wt.path}
              className="w-full flex items-center gap-2.5 px-2 py-2 rounded-lg bg-surface-0 hover:bg-surface-1 text-left transition-colors"
              onClick={() => handleSelectWorktree(wt)}
              data-testid={`git-diff-worktree-${wt.agentName}`}
            >
              <div className="w-5 h-5 rounded flex items-center justify-center text-[10px] font-mono text-ctp-mauve bg-ctp-mauve/10 flex-shrink-0">
                W
              </div>
              <div className="min-w-0">
                <div className="text-[11px] text-ctp-text truncate">{wt.label}</div>
                <div className="text-[9px] text-ctp-overlay0 truncate">{wt.path}</div>
              </div>
            </button>
          ))}
        </div>
      </div>
    );
  }

  // ── Step 3 & 4: File list + diff view ──────────────────────────

  const changedFiles = gitInfo?.status ?? [];

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
          {activeProject?.name || 'Repo'}
        </span>
        {view.worktreePath && (
          <>
            <span className="text-ctp-overlay0 mx-0.5">/</span>
            <span className="text-ctp-mauve text-[9px]">worktree</span>
          </>
        )}
        {view.filePath && (
          <>
            <span className="text-ctp-overlay0 mx-0.5">/</span>
            <button
              className="truncate hover:text-ctp-text transition-colors"
              onClick={handleBackToFiles}
              title="Back to file list"
            >
              {view.filePath}
            </button>
          </>
        )}
        <span className="flex-1" />
        {fullFilePath && (
          <>
            <button
              className="hover:text-ctp-text transition-colors px-1"
              onClick={handleShowInFolder}
              title="Reveal in Finder"
              data-testid="git-diff-show-in-folder"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
            </button>
            <button
              className="hover:text-ctp-text transition-colors px-1"
              onClick={handleOpenInEditor}
              title={`Open in ${editorName}`}
              data-testid="git-diff-open-in-editor"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                <polyline points="15 3 21 3 21 9" />
                <line x1="10" y1="14" x2="21" y2="3" />
              </svg>
            </button>
          </>
        )}
        <button
          className="hover:text-ctp-text transition-colors px-1"
          onClick={handleRefresh}
          title="Refresh"
          data-testid="git-diff-refresh"
        >
          &#x21bb;
        </button>
      </div>

      {/* Split panel: file list + diff */}
      <div className="flex flex-1 min-h-0">
        {/* File list sidebar */}
        <ResizableSidebar defaultWidth={200} minWidth={120} maxWidth={400} className="overflow-y-auto bg-ctp-mantle/30">
          {loading ? (
            <div className="flex items-center justify-center h-full text-ctp-subtext0 text-xs">
              Loading&hellip;
            </div>
          ) : changedFiles.length === 0 ? (
            <div className="flex items-center justify-center h-full text-ctp-overlay0 text-xs p-2 text-center">
              No changes detected
            </div>
          ) : (
            <div className="py-1">
              {changedFiles.map((file) => {
                const info = statusInfo(file.status);
                const fileName = file.path.split('/').pop() || file.path;
                const dirPath = file.path.includes('/')
                  ? file.path.slice(0, file.path.lastIndexOf('/'))
                  : '';
                const isSelected = view.filePath === file.path;
                return (
                  <button
                    key={file.path}
                    className={`w-full flex items-center gap-1.5 px-2 py-1 text-left transition-colors ${
                      isSelected ? 'bg-ctp-surface1' : 'hover:bg-surface-0'
                    }`}
                    onClick={() => handleSelectFile(file.path)}
                    onContextMenu={(e) => handleFileContextMenu(e, file.path, file.status, file.staged)}
                    title={`${file.path} (${info.label})`}
                    data-testid={`git-diff-file-${file.path}`}
                  >
                    <span
                      className={`w-4 text-center text-[10px] font-bold flex-shrink-0 ${info.color}`}
                      title={info.label}
                    >
                      {info.short}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-[11px] text-ctp-text truncate">{fileName}</div>
                      {dirPath && (
                        <div className="text-[9px] text-ctp-overlay0 truncate">{dirPath}</div>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </ResizableSidebar>

        {/* Diff content area */}
        <div className="flex-1 min-w-0 flex flex-col">
          {view.filePath && diffData ? (
            <MonacoDiffEditor
              original={diffData.original}
              modified={diffData.modified}
              filePath={view.filePath}
            />
          ) : view.filePath && !diffData ? (
            <div className="flex-1 flex items-center justify-center text-ctp-subtext0 text-xs">
              Loading diff&hellip;
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center text-ctp-overlay0 text-xs">
              Select a file to view diff
            </div>
          )}
        </div>
      </div>

      {/* Right-click context menu — rendered in a portal to escape CSS transform containing blocks */}
      {contextMenu && !confirmRevert && (
        <MenuPortal>
          <div
            className="fixed z-[9999] bg-ctp-surface0 border border-ctp-surface2 rounded-lg shadow-lg py-1 min-w-[140px]"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onClick={(e) => e.stopPropagation()}
            data-testid="git-diff-context-menu"
          >
            {contextMenu.staged ? (
              <button
                className="w-full text-left px-3 py-1.5 text-[11px] text-ctp-text hover:bg-ctp-surface1 transition-colors"
                onClick={() => handleUnstageFile(contextMenu.filePath)}
                data-testid="git-diff-unstage"
              >
                Unstage
              </button>
            ) : (
              <button
                className="w-full text-left px-3 py-1.5 text-[11px] text-ctp-text hover:bg-ctp-surface1 transition-colors"
                onClick={() => handleStageFile(contextMenu.filePath)}
                data-testid="git-diff-stage"
              >
                Stage
              </button>
            )}
            <button
              className="w-full text-left px-3 py-1.5 text-[11px] text-red-400 hover:bg-ctp-surface1 transition-colors"
              onClick={() => setConfirmRevert(contextMenu.filePath)}
              data-testid="git-diff-revert"
            >
              Revert Changes
            </button>
          </div>
        </MenuPortal>
      )}

      {/* Revert confirmation dialog — also in a portal for the same reason */}
      {confirmRevert && (
        <MenuPortal>
          <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40" onClick={() => { setConfirmRevert(null); setContextMenu(null); }}>
            <div
              className="bg-ctp-surface0 border border-ctp-surface2 rounded-lg shadow-xl p-4 max-w-[320px]"
              onClick={(e) => e.stopPropagation()}
              data-testid="git-diff-revert-confirm"
            >
              <div className="text-sm text-ctp-text font-medium mb-2">Revert changes?</div>
              <div className="text-xs text-ctp-subtext0 mb-4">
                This will discard all changes to <span className="font-mono text-ctp-peach">{confirmRevert.split('/').pop()}</span>. This action cannot be undone.
              </div>
              <div className="flex justify-end gap-2">
                <button
                  className="text-[11px] px-3 py-1 rounded bg-ctp-surface1 text-ctp-subtext0 hover:bg-ctp-surface2 transition-colors"
                  onClick={() => { setConfirmRevert(null); setContextMenu(null); }}
                  data-testid="git-diff-revert-cancel"
                >
                  Cancel
                </button>
                <button
                  className="text-[11px] px-3 py-1 rounded bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors"
                  onClick={() => {
                    const isUntracked = contextMenu?.status.trim() === '??' || contextMenu?.status.trim() === '?';
                    handleRevertFile(confirmRevert, isUntracked);
                  }}
                  data-testid="git-diff-revert-confirm-btn"
                >
                  Revert
                </button>
              </div>
            </div>
          </div>
        </MenuPortal>
      )}
    </div>
  );
}
