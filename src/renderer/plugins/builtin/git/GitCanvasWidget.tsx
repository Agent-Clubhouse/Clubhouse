import React, { useState, useEffect, useMemo, useCallback } from 'react';
import type { CanvasWidgetComponentProps } from '../../../../shared/plugin-types';
import type { GitInfo } from '../../../../shared/types';

const GIT_POLL_INTERVAL_MS = 3000;

function projectColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 55%, 55%)`;
}

export function GitCanvasWidget({ widgetId: _widgetId, api, metadata, onUpdateMetadata }: CanvasWidgetComponentProps) {
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

  // Poll git info
  useEffect(() => {
    if (!effectivePath) return;
    const fetch = () => {
      if (document.hidden) return;
      window.clubhouse.git.info(effectivePath).then((info: GitInfo) => setGitInfo(info)).catch(() => {});
    };
    fetch();
    const id = setInterval(fetch, GIT_POLL_INTERVAL_MS);
    const onVis = () => { if (!document.hidden) fetch(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVis); };
  }, [effectivePath]);

  const handleStageAll = useCallback(async () => {
    if (!effectivePath) return;
    await window.clubhouse.git.stageAll(effectivePath);
  }, [effectivePath]);

  const handleCommit = useCallback(async () => {
    if (!effectivePath || !gitInfo) return;
    // Quick commit only works if there are staged files
    const staged = gitInfo.status.filter((f) => f.staged);
    if (staged.length === 0) return;
    const message = `Update ${staged.length} file${staged.length > 1 ? 's' : ''}`;
    await window.clubhouse.git.commit(effectivePath, message);
  }, [effectivePath, gitInfo]);

  const handlePush = useCallback(async () => {
    if (!effectivePath) return;
    await window.clubhouse.git.push(effectivePath);
  }, [effectivePath]);

  const handleSelectProject = useCallback((pid: string) => {
    onUpdateMetadata({ projectId: pid, worktreePath: null });
  }, [onUpdateMetadata]);

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

  // Compact status view
  const branch = gitInfo?.branch || '...';
  const stagedCount = gitInfo?.status.filter((f) => f.staged).length ?? 0;
  const changedCount = gitInfo?.status.filter((f) => !f.staged).length ?? 0;
  const ahead = gitInfo?.ahead ?? 0;
  const behind = gitInfo?.behind ?? 0;

  return (
    <div className="flex flex-col h-full p-2 gap-2">
      {/* Branch + status */}
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-ctp-text truncate">{branch}</span>
        {ahead > 0 && <span className="text-[9px] text-ctp-green">↑{ahead}</span>}
        {behind > 0 && <span className="text-[9px] text-ctp-red">↓{behind}</span>}
      </div>

      {/* Change counts */}
      <div className="flex items-center gap-3 text-[10px]">
        <span className="text-ctp-green">{stagedCount} staged</span>
        <span className="text-ctp-yellow">{changedCount} changed</span>
      </div>

      {/* Actions */}
      <div className="flex gap-1 mt-auto">
        <button
          className="flex-1 text-[10px] px-2 py-1 rounded bg-ctp-surface0 text-ctp-subtext0 hover:text-ctp-text transition-colors"
          onClick={handleStageAll}
        >
          Stage All
        </button>
        <button
          className="flex-1 text-[10px] px-2 py-1 rounded bg-ctp-blue/20 text-ctp-blue hover:bg-ctp-blue/30 transition-colors disabled:opacity-40"
          onClick={handleCommit}
          disabled={stagedCount === 0}
        >
          Commit
        </button>
        <button
          className="flex-1 text-[10px] px-2 py-1 rounded bg-ctp-surface0 text-ctp-subtext0 hover:text-ctp-text transition-colors"
          onClick={handlePush}
        >
          Push
        </button>
      </div>
    </div>
  );
}
