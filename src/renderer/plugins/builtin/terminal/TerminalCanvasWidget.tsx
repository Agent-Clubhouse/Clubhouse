// Canvas widget for terminal — registered as plugin:terminal:shell.
// Provides the same project/worktree picker + shell terminal experience as
// the built-in canvas TerminalCanvasView, but delivered through the v0.8
// widget API so 1p widgets go through the same registration/validation path as 3p.

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import type { CanvasWidgetComponentProps } from '../../../../shared/plugin-types';
import type { GitWorktreeEntry } from '../../../../shared/types';
import type { TerminalIO } from '../../../features/terminal/ShellTerminal';
import { ShellTerminal } from '../../../features/terminal/ShellTerminal';
import { useRemoteProject } from '../../../hooks/useRemoteProject';
import { satellitePtyDataBus, satellitePtyExitBus } from '../../../stores/annexClientStore';

type TerminalStatus = 'starting' | 'running' | 'exited';

function projectColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 55%, 55%)`;
}

/**
 * Create a TerminalIO adapter that routes PTY operations through the
 * annex client to a satellite machine.
 */
function createRemoteTerminalIO(satelliteId: string): TerminalIO {
  return {
    write(sessionId: string, data: string) {
      window.clubhouse.annexClient.ptyInput(satelliteId, sessionId, data);
    },
    resize(sessionId: string, cols: number, rows: number) {
      window.clubhouse.annexClient.ptyResize(satelliteId, sessionId, cols, rows);
    },
    getBuffer(sessionId: string): Promise<string> {
      return window.clubhouse.annexClient.ptyGetBuffer(satelliteId, sessionId);
    },
    onData(callback: (id: string, data: string) => void): () => void {
      return satellitePtyDataBus.on((sid, agentId, data) => {
        if (sid === satelliteId) callback(agentId, data);
      });
    },
    onExit(callback: (id: string, exitCode: number) => void): () => void {
      return satellitePtyExitBus.on((sid, agentId, exitCode) => {
        if (sid === satelliteId) callback(agentId, exitCode);
      });
    },
  };
}

export function TerminalCanvasWidget({ widgetId, api, metadata, onUpdateMetadata, size: _size }: CanvasWidgetComponentProps) {
  const isAppMode = api.context.mode === 'app';
  const projects = useMemo(() => api.projects.list(), [api]);

  const projectId = (metadata.projectId as string) || (isAppMode ? undefined : api.context.projectId);
  const cwd = metadata.cwd as string | undefined;

  const remote = useRemoteProject(projectId);

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

  // Create remote TerminalIO if rendering in a remote context
  const remoteIO = useMemo(() => {
    if (!remote.isRemote || !remote.satelliteId) return undefined;
    return createRemoteTerminalIO(remote.satelliteId);
  }, [remote.isRemote, remote.satelliteId]);

  // Fetch worktrees when project is selected (skip for remote — no worktree listing over annex)
  useEffect(() => {
    if (!activeProject?.path) {
      setWorktrees([]);
      return;
    }
    if (remote.isRemote) {
      // Remote projects don't support worktree listing; auto-select project root
      setWorktrees([]);
      setLoadingWorktrees(false);
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
  }, [activeProject?.path, remote.isRemote]);

  // Spawn or reconnect when cwd is set
  const spawnTerminal = useCallback(async (dir: string) => {
    setStatus('starting');
    setExitCode(null);
    try {
      if (remote.isRemote && remote.satelliteId && remote.originalProjectId) {
        await window.clubhouse.annexClient.ptySpawnShell(
          remote.satelliteId, sessionId, remote.originalProjectId,
        );
      } else {
        await window.clubhouse.pty.spawnShell(sessionId, dir);
      }
      setStatus('running');
    } catch {
      setStatus('exited');
    }
  }, [sessionId, remote]);

  useEffect(() => {
    if (!cwd) return;
    if (spawnedRef.current) {
      setStatus('running');
      return;
    }
    const io = remoteIO ?? window.clubhouse.pty;
    io.getBuffer(sessionId).then((buf: string) => {
      if (buf && buf.length > 0) {
        setStatus('running');
      } else {
        spawnTerminal(cwd);
      }
      spawnedRef.current = true;
    });
  }, [sessionId, cwd, spawnTerminal, remoteIO]);

  // Listen for exit
  useEffect(() => {
    if (!cwd) return;
    const io = remoteIO ?? window.clubhouse.pty;
    const removeListener = io.onExit((id: string, code: number) => {
      if (id === sessionId) {
        setStatus('exited');
        setExitCode(code);
      }
    });
    return removeListener;
  }, [sessionId, cwd, remoteIO]);

  const handleRestart = useCallback(async () => {
    if (!cwd) return;
    spawnedRef.current = false;
    if (!remote.isRemote) {
      await window.clubhouse.pty.kill(sessionId);
    }
    spawnTerminal(cwd);
  }, [sessionId, cwd, spawnTerminal, remote.isRemote]);

  const handleSelectProject = useCallback((pid: string) => {
    setWorktrees([]);
    setLoadingWorktrees(true);
    onUpdateMetadata({ projectId: pid, cwd: null });
  }, [onUpdateMetadata]);

  const handleSelectCwd = useCallback((path: string) => {
    onUpdateMetadata({ cwd: path, projectId: projectId ?? null });
  }, [onUpdateMetadata, projectId]);

  const handleBackToProjects = useCallback(() => {
    if (cwd && !remote.isRemote) {
      window.clubhouse.pty.kill(sessionId).catch(() => {});
      spawnedRef.current = false;
    }
    onUpdateMetadata({ projectId: null, cwd: null });
  }, [cwd, sessionId, onUpdateMetadata, remote.isRemote]);

  const handleBackToWorktrees = useCallback(() => {
    if (cwd && !remote.isRemote) {
      window.clubhouse.pty.kill(sessionId).catch(() => {});
      spawnedRef.current = false;
    }
    onUpdateMetadata({ cwd: null, projectId: projectId ?? null });
  }, [cwd, sessionId, projectId, onUpdateMetadata, remote.isRemote]);

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

  // Step 2: Worktree/root picker (skipped for remote — auto-selects project root)
  if (!cwd) {
    const hasMultipleWorktrees = worktrees.length > 1;

    if ((!hasMultipleWorktrees && !loadingWorktrees && activeProject?.path) || remote.isRemote) {
      const rootPath = remote.isRemote ? '__remote__' : activeProject?.path;
      if (rootPath) {
        Promise.resolve().then(() => {
          handleSelectCwd(rootPath);
        });
      }
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
      <div className="flex items-center gap-1 px-2 py-1 bg-surface-0/50 border-b border-surface-0 text-[10px] text-ctp-subtext0 flex-shrink-0">
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
        {remote.isRemote && (
          <span className="text-[8px] text-ctp-peach bg-ctp-peach/10 px-1.5 py-0.5 rounded ml-1">
            remote
          </span>
        )}
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
          <ShellTerminal sessionId={sessionId} focused={true} io={remoteIO} />
        ) : (
          <div className="flex items-center justify-center h-full text-ctp-subtext0 text-xs">
            Starting terminal...
          </div>
        )}
      </div>
    </div>
  );
}
