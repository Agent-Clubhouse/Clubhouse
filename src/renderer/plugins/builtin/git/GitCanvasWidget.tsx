import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import type { CanvasWidgetComponentProps } from '../../../../shared/plugin-types';
import type { GitInfo, GitStatusFile } from '../../../../shared/types';
import { createGitOps } from './remote-git';
import { evaluateSelectionPersistence } from './selection';
import { Spinner } from '../../../components/Spinner';
import { WidgetPicker, projectRows } from '../canvas/WidgetPicker';

const GIT_POLL_INTERVAL_MS = 3000;

/** Lazily imported MonacoDiffEditor — avoids pulling Monaco into the bundle at parse time. */
const MonacoDiffEditorLazy = React.lazy(
  () => import('../canvas/MonacoDiffEditor').then((m) => ({ default: m.MonacoDiffEditor })),
);

// ── Status helpers ──────────────────────────────────────────────────

interface StatusInfo {
  label: string;
  color: string;
  short: string;
}

export function statusInfo(code: string): StatusInfo {
  const c = code.trim();
  if (c === '??' || c === '?') return { label: 'Untracked', color: 'text-ctp-accent', short: 'U' };
  if (c.startsWith('A') || c === 'A') return { label: 'Added', color: 'text-ctp-success', short: 'A' };
  if (c.startsWith('D') || c === 'D') return { label: 'Deleted', color: 'text-ctp-error', short: 'D' };
  if (c.startsWith('M') || c === 'M') return { label: 'Modified', color: 'text-ctp-warning', short: 'M' };
  if (c.startsWith('R')) return { label: 'Renamed', color: 'text-ctp-mauve', short: 'R' };
  if (c.startsWith('C')) return { label: 'Copied', color: 'text-ctp-info', short: 'C' };
  return { label: 'Changed', color: 'text-ctp-overlay0', short: '~' };
}

// ── Component ───────────────────────────────────────────────────────

export function GitCanvasWidget({ widgetId: _widgetId, api, metadata, onUpdateMetadata, size }: CanvasWidgetComponentProps) {
  const isAppMode = api.context.mode === 'app';
  const projects = useMemo(() => api.projects.list(), [api]);

  const projectId = (metadata.projectId as string) || (isAppMode ? undefined : api.context.projectId);
  const worktreePath = metadata.worktreePath as string | undefined;

  const activeProject = useMemo(
    () => projectId ? projects.find((p) => p.id === projectId) : null,
    [projects, projectId],
  );

  const effectivePath = worktreePath || activeProject?.path;
  const [gitInfo, setGitInfo] = useState<GitInfo | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [diffData, setDiffData] = useState<{ original: string; modified: string } | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({});
  // Tracks which (file, staged) combo is currently displayed. Used to distinguish
  // a real file switch (show "Loading diff…") from a background poll refresh
  // (silently update so the diff doesn't flash).
  const diffFetchKeyRef = useRef<string | null>(null);
  // Consecutive polls in which the selected file was absent from a non-empty
  // status. Used to avoid dropping the selection on a single transient read.
  const selectionMissesRef = useRef(0);

  const git = useMemo(
    () => effectivePath ? createGitOps(effectivePath, projectId) : null,
    [effectivePath, projectId],
  );

  // Poll git info
  useEffect(() => {
    if (!git) return;
    const fetch = () => {
      if (document.hidden) return;
      git.info().then((info: GitInfo) => setGitInfo(info)).catch(() => {});
    };
    fetch();
    const id = setInterval(fetch, GIT_POLL_INTERVAL_MS);
    const onVis = () => { if (!document.hidden) fetch(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVis); };
  }, [git]);

  // Clear selection when the file genuinely disappears from status — but tolerate
  // transient/empty poll results so a flaky read doesn't reset the diff view.
  useEffect(() => {
    if (!selectedFile || !gitInfo) return;
    const { drop, misses } = evaluateSelectionPersistence(
      gitInfo.status,
      selectedFile,
      selectionMissesRef.current,
    );
    selectionMissesRef.current = misses;
    if (drop) {
      setSelectedFile(null);
      setDiffData(null);
    }
  }, [gitInfo, selectedFile]);

  // Fetch diff when file selected.
  //
  // Note: gitInfo is in the deps because we need the file's staged status.
  // Each git status poll creates a new gitInfo object and re-runs this effect.
  // To prevent the "Loading diff…" flash on every poll, we only show the
  // loading state when the (file, staged) combo actually changes — background
  // refreshes update diffData silently.
  useEffect(() => {
    if (!selectedFile || !git) {
      setDiffData(null);
      setDiffLoading(false);
      diffFetchKeyRef.current = null;
      return;
    }
    const file = gitInfo?.status.find((f) => f.path === selectedFile);
    if (!file) return;
    const fetchKey = `${selectedFile}|${file.staged}`;
    const isFileSwitch = diffFetchKeyRef.current !== fetchKey;
    diffFetchKeyRef.current = fetchKey;
    if (isFileSwitch) {
      setDiffLoading(true);
      setDiffData(null);
    }
    let cancelled = false;
    git.diff(selectedFile, file.staged)
      .then((data: { original: string; modified: string }) => {
        if (cancelled) return;
        setDiffData((prev) => (prev && prev.original === data.original && prev.modified === data.modified ? prev : data));
        setDiffLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        if (isFileSwitch) setDiffData(null);
        setDiffLoading(false);
      });
    return () => { cancelled = true; };
  }, [selectedFile, git, gitInfo]);

  const handleSelectProject = useCallback((pid: string) => {
    onUpdateMetadata({ projectId: pid, worktreePath: null });
  }, [onUpdateMetadata]);

  const toggleSection = useCallback((key: string) => {
    setCollapsedSections((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  // Step 1: Project picker
  if (!projectId) {
    return (
      <WidgetPicker
        searchPlaceholder="Find a project"
        emptyText="No projects open"
        sections={[{ id: 'projects', rows: projectRows(projects, handleSelectProject, { testIdPrefix: 'project-picker-' }) }]}
      />
    );
  }

  if (!gitInfo) {
    return (
      <div className="flex items-center justify-center h-full text-ctp-subtext0 text-xs">
        <div className="flex items-center gap-2">
          <Spinner size="sm" />
          Loading git status…
        </div>
      </div>
    );
  }

  if (!gitInfo.hasGit) {
    return (
      <div className="flex items-center justify-center h-full text-ctp-overlay1 text-xs p-4 text-center">
        Not a git repository
      </div>
    );
  }

  const staged = gitInfo.status.filter((f) => f.staged);
  const unstaged = gitInfo.status.filter((f) => !f.staged && f.status !== '??' && f.status !== '?');
  const untracked = gitInfo.status.filter((f) => f.status === '??' || f.status === '?');
  const totalChanges = staged.length + unstaged.length + untracked.length;

  // Compact mode: narrow width, just show the file list without diff pane
  const isCompact = size.width < 500;

  return (
    <div className="flex flex-col h-full" data-testid="git-diff-widget">
      {/* Header */}
      <div className="h-[30px] flex items-center gap-2 px-3 border-b border-surface-0 flex-shrink-0">
        <span className="text-[13px] font-medium text-ctp-text truncate">{gitInfo.branch}</span>
        {(gitInfo.ahead > 0 || gitInfo.behind > 0) && (
          <span className="text-xs text-ctp-overlay1 flex-shrink-0" data-testid="git-ahead-behind">
            {[gitInfo.ahead > 0 && `${gitInfo.ahead} ahead`, gitInfo.behind > 0 && `${gitInfo.behind} behind`].filter(Boolean).join(', ')}
          </span>
        )}
        <span className="flex-1" />
        {totalChanges > 0 && (
          <span className="text-xs text-ctp-overlay1 truncate" data-testid="git-change-summary">
            {[
              staged.length > 0 && `${staged.length} staged`,
              unstaged.length > 0 && `${unstaged.length} changed`,
              untracked.length > 0 && `${untracked.length} untracked`,
            ].filter(Boolean).join(' · ')}
          </span>
        )}
      </div>

      {totalChanges === 0 ? (
        <div className="flex-1 flex items-center justify-center text-ctp-overlay1 text-xs">
          Working tree clean
        </div>
      ) : isCompact ? (
        /* Compact: file list only */
        <div className="flex-1 overflow-y-auto min-h-0" data-testid="file-list">
          <FileSection title="Staged" sectionKey="staged" files={staged} collapsed={collapsedSections} selectedFile={selectedFile} onSelect={setSelectedFile} onToggle={toggleSection} />
          <FileSection title="Changes" sectionKey="changes" files={unstaged} collapsed={collapsedSections} selectedFile={selectedFile} onSelect={setSelectedFile} onToggle={toggleSection} />
          <FileSection title="Untracked" sectionKey="untracked" files={untracked} collapsed={collapsedSections} selectedFile={selectedFile} onSelect={setSelectedFile} onToggle={toggleSection} />
        </div>
      ) : (
        /* Full: file list + diff pane */
        <div className="flex flex-1 min-h-0">
          {/* File list */}
          <div className="w-52 flex-shrink-0 overflow-y-auto border-r border-surface-0" data-testid="file-list">
            <FileSection title="Staged" sectionKey="staged" files={staged} collapsed={collapsedSections} selectedFile={selectedFile} onSelect={setSelectedFile} onToggle={toggleSection} />
            <FileSection title="Changes" sectionKey="changes" files={unstaged} collapsed={collapsedSections} selectedFile={selectedFile} onSelect={setSelectedFile} onToggle={toggleSection} />
            <FileSection title="Untracked" sectionKey="untracked" files={untracked} collapsed={collapsedSections} selectedFile={selectedFile} onSelect={setSelectedFile} onToggle={toggleSection} />
          </div>

          {/* Diff pane */}
          <div className="flex-1 min-w-0" data-testid="diff-pane">
            {diffLoading ? (
              <div className="flex items-center justify-center h-full text-ctp-subtext0 text-xs">
                <div className="flex items-center gap-2">
                  <Spinner size="sm" />
                  Loading diff…
                </div>
              </div>
            ) : diffData ? (
              <React.Suspense fallback={<div className="flex items-center justify-center h-full text-ctp-subtext0 text-xs"><div className="flex items-center gap-2"><Spinner size="sm" />Loading editor…</div></div>}>
                <MonacoDiffEditorLazy original={diffData.original} modified={diffData.modified} filePath={selectedFile || ''} />
              </React.Suspense>
            ) : (
              <div className="flex items-center justify-center h-full text-ctp-overlay1 text-xs">
                {selectedFile ? 'Loading…' : 'Select a file to see its diff'}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── File Section ────────────────────────────────────────────────────

interface FileSectionProps {
  title: string;
  sectionKey: string;
  files: GitStatusFile[];
  collapsed: Record<string, boolean>;
  selectedFile: string | null;
  onSelect: (path: string) => void;
  onToggle: (key: string) => void;
}

function FileSection({ title, sectionKey, files, collapsed, selectedFile, onSelect, onToggle }: FileSectionProps) {
  if (files.length === 0) return null;
  const isCollapsed = collapsed[sectionKey] === true;

  return (
    <div className="px-1.5 py-1">
      <button
        className="w-full h-[30px] flex items-center gap-1.5 px-1.5 rounded-md text-xs text-ctp-overlay1 hover:bg-surface-0"
        onClick={() => onToggle(sectionKey)}
        aria-expanded={!isCollapsed}
        data-testid={`section-${sectionKey}`}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={`flex-shrink-0 transition-transform ${isCollapsed ? '' : 'rotate-90'}`}>
          <path d="M9 6l6 6-6 6" />
        </svg>
        <span>{title}</span>
        <span className="ml-auto">{files.length}</span>
      </button>
      {!isCollapsed && (
        <ul>
          {files.map((file) => {
            const info = statusInfo(file.status);
            const name = file.path.split('/').pop() || file.path;
            const dir = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '';
            return (
              <li key={file.path}>
                <button
                  className={`w-full h-[30px] flex items-center gap-2 px-1.5 rounded-md text-left ${
                    selectedFile === file.path ? 'bg-surface-0' : 'hover:bg-surface-0'
                  }`}
                  onClick={() => onSelect(file.path)}
                  aria-current={selectedFile === file.path || undefined}
                  data-testid={`file-${file.path}`}
                >
                  <span className={`w-3 text-center text-xs font-mono flex-shrink-0 ${info.color}`} aria-hidden="true">{info.short}</span>
                  <span className="sr-only">{info.label}</span>
                  <span className="text-[13px] text-ctp-text truncate min-w-0">{name}</span>
                  {dir && <span className="text-xs text-ctp-overlay1 truncate min-w-0">{dir}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
