// Canvas widget for terminal — registered as plugin:terminal:shell.
// Provides the same project/worktree picker + shell terminal experience as
// the built-in canvas TerminalCanvasView, but delivered through the v0.8
// widget API so 1p widgets go through the same registration/validation path as 3p.

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import type { CanvasWidgetComponentProps } from '../../../../shared/plugin-types';
import type { GitWorktreeEntry } from '../../../../shared/types';
import { ShellTerminal } from '../../../features/terminal/ShellTerminal';

type TerminalStatus = 'starting' | 'running' | 'exited';

function projectColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 55%, 55%)`;
}

export function TerminalCanvasWidget({ widgetId, api, metadata, onUpdateMetadata, size: _size }: CanvasWidgetComponentProps) {
  const isAppMode = api.context.mode === 'app';
  const projects = useMemo(() => api.projects.list(), [api]);

  const projectId = (metadata.projectId as string) || (isAppMode ? undefined : api.context.projectId);
  const cwd = metadata.cwd as string | undefined;

  const activeProject = useMemo(
    () => projectId ? projects.find((p) => p.id === projectId) : null,
    [projects, projectId],
  );

  const [worktrees, setWorktrees] = useState<GitWorktreeEntry[]>([]);
  const [loadingWorktrees, setLoadingWorktrees] = useState(true);
  const [status, setStatus] = useState<TerminalStatus>('starting');
  const [exitCode, setExitCode] = useState<number | null>(null);
  const spawnedRef = useRef(false);

  const sessionId = `canvas-widget-terminal:${widgetId}`;

  // Fetch worktrees when project is selected
  useEffect(() => {
    if (!activeProject?.path) {
      setWorktrees([]);
      return;
    }
    setLoadingWorktrees(true);
    window.clubhouse.git.listWorktrees(activeProject.path)
      .then((wts: GitWorktreeEntry[]) => {
        setWorktrees(wts);
        setLoadingWorktrees(false);
      })
      .catch(() => {
        setWorktrees([]);
        setLoadingWorktrees(false);
      });
  }, [activeProject?.path]);

  // Spawn or reconnect when cwd is set
  const spawnTerminal = useCallback(async (dir: string) => {
    setStatus('starting');
    setExitCode(null);
    try {
      await window.clubhouse.pty.spawnShell(sessionId, dir);
      setStatus('running');
    } catch {
      setStatus('exited');
    }
  }, [sessionId]);

  useEffect(() => {
    if (!cwd) return;
    if (spawnedRef.current) {
      setStatus('running');
      return;
    }
    window.clubhouse.pty.getBuffer(sessionId).then((buf: string) => {
      if (buf && buf.length > 0) {
        setStatus('running');
      } else {
        spawnTerminal(cwd);
      }
      spawnedRef.current = true;
    });
  }, [sessionId, cwd, spawnTerminal]);

  // Listen for exit
  useEffect(() => {
    if (!cwd) return;
    const removeListener = window.clubhouse.pty.onExit((id: string, code: number) => {
      if (id === sessionId) {
        setStatus('exited');
        setExitCode(code);
      }
    });
    return removeListener;
  }, [sessionId, cwd]);

  const handleRestart = useCallback(async () => {
    if (!cwd) return;
    spawnedRef.current = false;
    await window.clubhouse.pty.kill(sessionId);
    spawnTerminal(cwd);
  }, [sessionId, cwd, spawnTerminal]);

  const handleSelectProject = useCallback((pid: string) => {
    setWorktrees([]);
    setLoadingWorktrees(true);
    onUpdateMetadata({ projectId: pid, cwd: null });
  }, [onUpdateMetadata]);

  const handleSelectCwd = useCallback((path: string) => {
    onUpdateMetadata({ cwd: path, projectId: projectId ?? null });
  }, [onUpdateMetadata, projectId]);

  const handleBackToProjects = useCallback(() => {
    if (cwd) {
      window.clubhouse.pty.kill(sessionId).catch(() => {});
      spawnedRef.current = false;
    }
    onUpdateMetadata({ projectId: null, cwd: null });
  }, [cwd, sessionId, onUpdateMetadata]);

  const handleBackToWorktrees = useCallback(() => {
    if (cwd) {
      window.clubhouse.pty.kill(sessionId).catch(() => {});
      spawnedRef.current = false;
    }
    onUpdateMetadata({ cwd: null, projectId: projectId ?? null });
  }, [cwd, sessionId, projectId, onUpdateMetadata]);

  // Step 1: Project picker
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

  // Step 2: Worktree/root picker
  if (!cwd) {
    const hasMultipleWorktrees = worktrees.length > 1;

    if (!hasMultipleWorktrees && !loadingWorktrees && activeProject?.path) {
      Promise.resolve().then(() => {
        handleSelectCwd(activeProject.path);
      });
      return (
        <div className="flex items-center justify-center h-full text-ctp-subtext0 text-xs">
          Starting terminal...
        </div>
      );
    }

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
            Select a directory
          </div>
        </div>
        {loadingWorktrees ? (
          <div className="flex items-center justify-center flex-1 text-ctp-subtext0 text-xs">
            Loading worktrees&hellip;
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto space-y-1">
            {worktrees.map((wt) => (
              <button
                key={wt.path}
                className="w-full flex items-center gap-2.5 px-2 py-2 rounded-lg bg-surface-0 hover:bg-surface-1 text-left transition-colors"
                onClick={() => handleSelectCwd(wt.path)}
              >
                <div className={`w-5 h-5 rounded flex items-center justify-center text-[10px] font-mono flex-shrink-0 ${
                  wt.isBare ? 'text-ctp-green bg-ctp-green/10' : 'text-ctp-mauve bg-ctp-mauve/10'
                }`}>
                  {wt.isBare ? '*' : 'W'}
                </div>
                <div className="min-w-0">
                  <div className="text-[11px] text-ctp-text truncate">
                    {wt.isBare ? `${activeProject?.name ?? 'Project'} (main)` : wt.label}
                  </div>
                  {wt.branch && (
                    <div className="text-[9px] text-ctp-overlay0 truncate">{wt.branch}</div>
                  )}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  // Step 3: Terminal view
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-1 px-2 py-1 bg-ctp-surface0/50 border-b border-surface-0 text-[10px] text-ctp-subtext0 flex-shrink-0">
        <button
          className="flex items-center gap-1 px-1.5 py-0.5 rounded text-ctp-subtext0 hover:text-ctp-text hover:bg-surface-1 transition-colors"
          onClick={handleRestart}
          title="Restart terminal"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="23 4 23 10 17 10" />
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
          </svg>
        </button>
        <span className="text-ctp-overlay0 mx-0.5">|</span>
        {isAppMode && (
          <button
            className="hover:text-ctp-text transition-colors mr-1"
            onClick={handleBackToProjects}
            title="Back to projects"
          >
            &larr;
          </button>
        )}
        <button
          className="truncate font-medium text-ctp-subtext1 hover:text-ctp-text transition-colors"
          onClick={handleBackToWorktrees}
          title="Change directory"
        >
          {activeProject?.name || 'Terminal'}
        </button>
        <span className="flex-1" />
        <span className={`text-[9px] ${
          status === 'running' ? 'text-ctp-green' :
          status === 'exited' ? 'text-ctp-red' :
          'text-ctp-subtext0'
        }`}>
          {status === 'running' ? 'Running' :
           status === 'exited' ? `Exited${exitCode !== null ? ` (${exitCode})` : ''}` :
           'Starting...'}
        </span>
      </div>
      <div className="flex-1 min-h-0">
        {status !== 'starting' ? (
          <ShellTerminal sessionId={sessionId} focused={true} />
        ) : (
          <div className="flex items-center justify-center h-full text-ctp-subtext0 text-xs">
            Starting terminal...
          </div>
        )}
      </div>
    </div>
  );
}
