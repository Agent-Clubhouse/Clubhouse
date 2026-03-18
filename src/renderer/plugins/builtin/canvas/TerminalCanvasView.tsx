import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import type { TerminalCanvasView as TerminalCanvasViewType, CanvasView } from './canvas-types';
import type { PluginAPI } from '../../../../shared/plugin-types';
import type { GitWorktreeEntry } from '../../../../shared/types';
import { ShellTerminal } from '../../../features/terminal/ShellTerminal';

interface TerminalCanvasViewProps {
  view: TerminalCanvasViewType;
  api: PluginAPI;
  onUpdate: (updates: Partial<CanvasView>) => void;
}

type TerminalStatus = 'starting' | 'running' | 'exited';

/** Deterministic session ID for a canvas terminal. */
function makeCanvasTerminalSessionId(viewId: string): string {
  return `canvas-terminal:${viewId}`;
}

function projectColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 55%, 55%)`;
}

export function TerminalCanvasView({ view, api, onUpdate }: TerminalCanvasViewProps) {
  const isAppMode = api.context.mode === 'app';
  const projects = useMemo(() => api.projects.list(), [api]);

  const activeProjectId = view.projectId || (isAppMode ? undefined : api.context.projectId);
  const activeProject = useMemo(
    () => activeProjectId ? projects.find((p) => p.id === activeProjectId) : null,
    [projects, activeProjectId],
  );

  // Worktree state
  const [worktrees, setWorktrees] = useState<GitWorktreeEntry[]>([]);
  const [loadingWorktrees, setLoadingWorktrees] = useState(false);

  // Terminal state
  const [status, setStatus] = useState<TerminalStatus>('starting');
  const [exitCode, setExitCode] = useState<number | null>(null);
  const spawnedRef = useRef(false);

  const sessionId = makeCanvasTerminalSessionId(view.id);

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
    if (!view.cwd) return;

    if (spawnedRef.current) {
      setStatus('running');
      return;
    }

    // Check for existing buffer (session alive from previous visit)
    window.clubhouse.pty.getBuffer(sessionId).then((buf: string) => {
      if (buf && buf.length > 0) {
        setStatus('running');
      } else {
        spawnTerminal(view.cwd!);
      }
      spawnedRef.current = true;
    });
  }, [sessionId, view.cwd, spawnTerminal]);

  // Listen for exit
  useEffect(() => {
    if (!view.cwd) return;
    const removeListener = window.clubhouse.pty.onExit((id: string, code: number) => {
      if (id === sessionId) {
        setStatus('exited');
        setExitCode(code);
      }
    });
    return removeListener;
  }, [sessionId, view.cwd]);

  // Restart handler
  const handleRestart = useCallback(async () => {
    if (!view.cwd) return;
    spawnedRef.current = false;
    await window.clubhouse.pty.kill(sessionId);
    spawnTerminal(view.cwd);
  }, [sessionId, view.cwd, spawnTerminal]);

  // ── Callbacks ───────────────────────────────────────────────────

  const handleSelectProject = useCallback((projectId: string) => {
    const project = projects.find((p) => p.id === projectId);
    onUpdate({
      projectId,
      cwd: undefined,
      title: project?.name || 'Terminal',
      metadata: { projectId },
    } as Partial<TerminalCanvasViewType>);
  }, [projects, onUpdate]);

  const handleSelectCwd = useCallback((path: string, label: string) => {
    onUpdate({
      cwd: path,
      title: label,
      metadata: { projectId: activeProjectId ?? null, cwd: path },
    } as Partial<TerminalCanvasViewType>);
  }, [activeProjectId, onUpdate]);

  const handleBackToProjects = useCallback(() => {
    // Kill existing terminal if any
    if (view.cwd) {
      window.clubhouse.pty.kill(sessionId).catch(() => {});
      spawnedRef.current = false;
    }
    onUpdate({
      projectId: undefined,
      cwd: undefined,
      title: 'Terminal',
      metadata: { projectId: null, cwd: null },
    } as Partial<TerminalCanvasViewType>);
  }, [view.cwd, sessionId, onUpdate]);

  const handleBackToWorktrees = useCallback(() => {
    // Kill existing terminal if any
    if (view.cwd) {
      window.clubhouse.pty.kill(sessionId).catch(() => {});
      spawnedRef.current = false;
    }
    onUpdate({
      cwd: undefined,
      title: activeProject?.name || 'Terminal',
      metadata: { projectId: activeProjectId ?? null, cwd: null },
    } as Partial<TerminalCanvasViewType>);
  }, [view.cwd, sessionId, activeProject, activeProjectId, onUpdate]);

  // ── Step 1: Project picker ──────────────────────────────────────

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
                  data-testid={`terminal-project-${p.id}`}
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

  // ── Step 2: Worktree / root picker ──────────────────────────────

  if (!view.cwd) {
    // If only one worktree (the main repo) and no linked worktrees, skip picker
    const hasMultipleWorktrees = worktrees.length > 1;

    if (!hasMultipleWorktrees && !loadingWorktrees && activeProject?.path) {
      // Auto-select project root when there are no additional worktrees
      // Use a microtask to avoid updating during render
      Promise.resolve().then(() => {
        handleSelectCwd(activeProject.path, activeProject.name);
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
                onClick={() => handleSelectCwd(wt.path, wt.isBare ? `${activeProject?.name ?? 'Project'} (main)` : wt.label)}
                data-testid={`terminal-worktree-${wt.label}`}
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

  // ── Step 3: Terminal view ───────────────────────────────────────

  return (
    <div className="flex flex-col h-full">
      {/* Header bar with restart button */}
      <div className="flex items-center gap-1 px-2 py-1 bg-ctp-surface0/50 border-b border-surface-0 text-[10px] text-ctp-subtext0 flex-shrink-0">
        {/* Restart button — top left */}
        <button
          className="flex items-center gap-1 px-1.5 py-0.5 rounded text-ctp-subtext0 hover:text-ctp-text hover:bg-surface-1 transition-colors"
          onClick={handleRestart}
          title="Restart terminal"
          data-testid="canvas-terminal-restart"
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
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
          {view.title || 'Terminal'}
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

      {/* Terminal body */}
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
