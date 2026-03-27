import React, { useState, useEffect, useMemo, useCallback } from 'react';
import type { CanvasWidgetComponentProps } from '../../../../shared/plugin-types';
import type { GitInfo, GitStatusFile } from '../../../../shared/types';
import { createGitOps } from './remote-git';

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

function statusInfo(code: string): StatusInfo {
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

  // Clear selection when file disappears from status
  useEffect(() => {
    if (!selectedFile || !gitInfo) return;
    const exists = gitInfo.status.some((f) => f.path === selectedFile);
    if (!exists) {
      setSelectedFile(null);
      setDiffData(null);
    }
  }, [gitInfo, selectedFile]);

  // Fetch diff when file selected
  useEffect(() => {
    if (!selectedFile || !git) {
      setDiffData(null);
      return;
    }
    const file = gitInfo?.status.find((f) => f.path === selectedFile);
    if (!file) return;
    setDiffLoading(true);
    git.diff(selectedFile, file.staged)
      .then((data: { original: string; modified: string }) => { setDiffData(data); setDiffLoading(false); })
      .catch(() => { setDiffData(null); setDiffLoading(false); });
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
      <div className="flex flex-col h-full p-2">
        <div className="text-xs font-medium text-ctp-subtext1 uppercase tracking-wider mb-2">
          Select a repo
        </div>
        <div className="flex-1 overflow-y-auto space-y-1">
          {projects.map((p) => {
            const color = projectColor(p.name);
            const initials = p.name.slice(0, 2).toUpperCase();
            return (
              <button
                key={p.id}
                className="w-full flex items-center gap-2.5 px-2 py-2 rounded-lg bg-surface-0 hover:bg-surface-1 text-left transition-colors"
                onClick={() => handleSelectProject(p.id)}
                data-testid={`project-picker-${p.id}`}
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
      </div>
    );
  }

  if (!gitInfo) {
    return (
      <div className="flex items-center justify-center h-full text-ctp-subtext0 text-xs">
        Loading git status…
      </div>
    );
  }

  if (!gitInfo.hasGit) {
    return (
      <div className="flex items-center justify-center h-full text-ctp-overlay0 text-xs p-4 text-center">
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
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-surface-0 bg-ctp-mantle/50 flex-shrink-0">
        <span className="text-xs font-medium text-ctp-text truncate">{gitInfo.branch}</span>
        {gitInfo.ahead > 0 && <span className="text-[9px] text-ctp-green">↑{gitInfo.ahead}</span>}
        {gitInfo.behind > 0 && <span className="text-[9px] text-ctp-red">↓{gitInfo.behind}</span>}
        <span className="flex-1" />
        {staged.length > 0 && <span className="text-[9px] text-ctp-green">{staged.length} staged</span>}
        {unstaged.length > 0 && <span className="text-[9px] text-ctp-yellow">{unstaged.length} changed</span>}
        {untracked.length > 0 && <span className="text-[9px] text-ctp-blue">{untracked.length} untracked</span>}
      </div>

      {totalChanges === 0 ? (
        <div className="flex-1 flex items-center justify-center text-ctp-overlay0 text-xs">
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
          <div className="w-52 flex-shrink-0 overflow-y-auto border-r border-surface-0 bg-ctp-mantle/30" data-testid="file-list">
            <FileSection title="Staged" sectionKey="staged" files={staged} collapsed={collapsedSections} selectedFile={selectedFile} onSelect={setSelectedFile} onToggle={toggleSection} />
            <FileSection title="Changes" sectionKey="changes" files={unstaged} collapsed={collapsedSections} selectedFile={selectedFile} onSelect={setSelectedFile} onToggle={toggleSection} />
            <FileSection title="Untracked" sectionKey="untracked" files={untracked} collapsed={collapsedSections} selectedFile={selectedFile} onSelect={setSelectedFile} onToggle={toggleSection} />
          </div>

          {/* Diff pane */}
          <div className="flex-1 min-w-0" data-testid="diff-pane">
            {diffLoading ? (
              <div className="flex items-center justify-center h-full text-ctp-subtext0 text-xs">
                Loading diff…
              </div>
            ) : diffData ? (
              <React.Suspense fallback={<div className="flex items-center justify-center h-full text-ctp-subtext0 text-xs">Loading editor…</div>}>
                <MonacoDiffEditorLazy original={diffData.original} modified={diffData.modified} filePath={selectedFile || ''} />
              </React.Suspense>
            ) : (
              <div className="flex items-center justify-center h-full text-ctp-overlay0 text-xs">
                {selectedFile ? 'Loading…' : 'Select a file to view diff'}
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
    <>
      <button
        className="w-full flex items-center gap-1 px-3 py-1.5 text-[10px] font-semibold text-ctp-subtext0 uppercase tracking-wider border-b border-surface-0 hover:bg-surface-0"
        onClick={() => onToggle(sectionKey)}
        data-testid={`section-${sectionKey}`}
      >
        <span className={`transition-transform ${isCollapsed ? '' : 'rotate-90'}`}>▸</span>
        {title} ({files.length})
      </button>
      {!isCollapsed && (
        <div className="border-b border-surface-0">
          {files.map((file) => {
            const info = statusInfo(file.status);
            const name = file.path.split('/').pop() || file.path;
            const dir = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '';
            return (
              <div
                key={file.path}
                className={`flex items-center gap-1 px-3 py-1 cursor-pointer transition-colors ${
                  selectedFile === file.path ? 'bg-surface-1' : 'hover:bg-surface-0'
                }`}
                onClick={() => onSelect(file.path)}
                data-testid={`file-${file.path}`}
              >
                <span className={`w-3 text-center text-[9px] font-bold flex-shrink-0 ${info.color}`}>{info.short}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-[11px] text-ctp-text truncate">{name}</div>
                  {dir && <div className="text-[8px] text-ctp-overlay0 truncate">{dir}</div>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
