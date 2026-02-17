import React, { useEffect, useState, useCallback, useRef, useSyncExternalStore } from 'react';
import type { PluginContext, PluginAPI, PluginModule } from '../../../../shared/plugin-types';
import { terminalState, makeSessionId } from './state';
import type { TerminalTarget } from './state';

type TerminalStatus = 'starting' | 'running' | 'exited';

export function activate(ctx: PluginContext, api: PluginAPI): void {
  const disposable = api.commands.register('restart', () => {
    // Fired from the header button — the MainPanel listens via a shared ref
  });
  ctx.subscriptions.push(disposable);
}

export function deactivate(): void {
  terminalState.reset();
}

// ── Sidebar Panel ───────────────────────────────────────────────────────

function useTerminalState() {
  const subscribe = useCallback((cb: () => void) => terminalState.subscribe(cb), []);
  const getActiveTarget = useCallback(() => terminalState.activeTarget, []);
  const getTargets = useCallback(() => terminalState.targets, []);
  const activeTarget = useSyncExternalStore(subscribe, getActiveTarget);
  const targets = useSyncExternalStore(subscribe, getTargets);
  return { activeTarget, targets };
}

export function SidebarPanel({ api }: { api: PluginAPI }) {
  const { activeTarget, targets } = useTerminalState();
  const [noWorktreeAgents, setNoWorktreeAgents] = useState<string[]>([]);

  // Build and refresh target list
  const refreshTargets = useCallback(() => {
    const projectId = api.context.projectId || 'default';
    const projectPath = api.context.projectPath || '';

    const projectTarget: TerminalTarget = {
      sessionId: makeSessionId(projectId, 'project'),
      label: 'Project',
      cwd: projectPath,
      kind: 'project',
    };

    const allDurable = api.agents.list().filter((a) => a.kind === 'durable');

    const agentTargets: TerminalTarget[] = allDurable
      .filter((a) => a.worktreePath)
      .map((a) => ({
        sessionId: makeSessionId(projectId, 'agent', a.name),
        label: a.name,
        cwd: a.worktreePath!,
        kind: 'agent' as const,
      }));

    const allTargets = [projectTarget, ...agentTargets];
    terminalState.setTargets(allTargets);

    // Track non-worktree agents for greyed-out display
    setNoWorktreeAgents(allDurable.filter((a) => !a.worktreePath).map((a) => a.name));

    // Auto-select project target if nothing is active
    if (!terminalState.activeTarget) {
      terminalState.setActiveTarget(projectTarget);
    }
  }, [api]);

  // Initial build + subscribe to agent changes
  useEffect(() => {
    refreshTargets();
    const sub = api.agents.onAnyChange(refreshTargets);
    return () => sub.dispose();
  }, [api, refreshTargets]);

  const handleClick = useCallback((target: TerminalTarget) => {
    terminalState.setActiveTarget(target);
  }, []);

  return React.createElement('div', { className: 'flex flex-col h-full bg-ctp-mantle' },
    // Header
    React.createElement('div', {
      className: 'px-3 py-2 text-xs font-semibold text-ctp-subtext0 uppercase tracking-wider border-b border-ctp-surface0',
    }, 'Targets'),
    // Scrollable list
    React.createElement('div', { className: 'flex-1 overflow-y-auto py-1' },
      targets.map((target) =>
        React.createElement('button', {
          key: target.sessionId,
          className: `w-full text-left px-3 py-3 text-sm cursor-pointer transition-colors ${
            activeTarget?.sessionId === target.sessionId
              ? 'bg-surface-1 text-ctp-text font-medium'
              : 'text-ctp-subtext1 hover:bg-surface-0 hover:text-ctp-text'
          }`,
          onClick: () => handleClick(target),
        },
          React.createElement('div', { className: 'flex items-center gap-3' },
            React.createElement('span', {
              className: `w-2 h-2 rounded-full flex-shrink-0 ${
                target.kind === 'project' ? 'bg-ctp-blue' : 'bg-ctp-green'
              }`,
            }),
            React.createElement('span', { className: 'truncate' }, target.label),
          ),
        ),
      ),
      // Non-worktree agents section
      noWorktreeAgents.length > 0 && React.createElement(React.Fragment, null,
        React.createElement('div', {
          className: 'mx-3 my-2 border-t border-ctp-surface0',
        }),
        React.createElement('div', {
          className: 'px-3 py-1 text-[10px] text-ctp-subtext0 uppercase tracking-wider',
        }, 'No worktree'),
        noWorktreeAgents.map((name) =>
          React.createElement('div', {
            key: `no-wt-${name}`,
            className: 'w-full text-left px-3 py-2 text-sm text-ctp-overlay0 cursor-default',
            title: 'Create agent with "Use git worktree" to enable terminal',
          },
            React.createElement('div', { className: 'flex items-center gap-3' },
              React.createElement('span', {
                className: 'w-2 h-2 rounded-full flex-shrink-0 bg-ctp-overlay0 opacity-40',
              }),
              React.createElement('span', { className: 'truncate' }, name),
            ),
          ),
        ),
      ),
    ),
  );
}

// ── Main Panel ──────────────────────────────────────────────────────────

export function MainPanel({ api }: { api: PluginAPI }) {
  const { activeTarget } = useTerminalState();

  // Fall back to project root when no target is selected
  const projectId = api.context.projectId || 'default';
  const projectPath = api.context.projectPath || '';
  const defaultTarget: TerminalTarget = {
    sessionId: makeSessionId(projectId, 'project'),
    label: 'Project',
    cwd: projectPath,
    kind: 'project',
  };

  const target = activeTarget || defaultTarget;
  const sessionId = target.sessionId;
  const cwd = target.cwd;

  const [status, setStatus] = useState<TerminalStatus>('starting');
  const [exitCode, setExitCode] = useState<number | null>(null);
  const spawnedSessionsRef = useRef(new Set<string>());

  const spawnTerminal = useCallback(async (sid: string, dir: string) => {
    setStatus('starting');
    setExitCode(null);
    try {
      await api.terminal.spawn(sid, dir);
      setStatus('running');
    } catch {
      setStatus('exited');
    }
  }, [api]);

  // Spawn or reconnect when target changes
  useEffect(() => {
    if (spawnedSessionsRef.current.has(sessionId)) {
      // Already spawned in this lifecycle — just reconnect
      setStatus('running');
      return;
    }

    // Check for existing buffer (session alive from previous visit)
    api.terminal.getBuffer(sessionId).then((buf) => {
      if (buf && buf.length > 0) {
        setStatus('running');
      } else {
        spawnTerminal(sessionId, cwd);
      }
      spawnedSessionsRef.current.add(sessionId);
    });
  }, [api, sessionId, cwd, spawnTerminal]);

  // Listen for exit
  useEffect(() => {
    const sub = api.terminal.onExit(sessionId, (code) => {
      setStatus('exited');
      setExitCode(code);
    });
    return () => sub.dispose();
  }, [api, sessionId]);

  const handleRestart = useCallback(async () => {
    spawnedSessionsRef.current.delete(sessionId);
    await api.terminal.kill(sessionId);
    spawnTerminal(sessionId, cwd);
  }, [api, sessionId, cwd, spawnTerminal]);

  const ShellTerminal = api.terminal.ShellTerminal;

  const contextLabel = target.kind === 'project'
    ? 'Terminal \u2014 Project'
    : `Terminal \u2014 ${target.label}`;

  const statusLabel =
    status === 'starting' ? 'Starting...' :
    status === 'running' ? 'Running' :
    `Exited${exitCode !== null ? ` (${exitCode})` : ''}`;

  const statusColor =
    status === 'running' ? 'text-ctp-green' :
    status === 'exited' ? 'text-ctp-red' :
    'text-ctp-subtext0';

  return React.createElement('div', { className: 'flex flex-col h-full bg-ctp-base' },
    // Header bar
    React.createElement('div', {
      className: 'flex items-center justify-between px-3 py-1.5 border-b border-ctp-surface0 bg-ctp-mantle flex-shrink-0',
    },
      React.createElement('div', { className: 'flex items-center gap-2' },
        React.createElement('span', { className: 'text-xs font-medium text-ctp-text' }, contextLabel),
        React.createElement('span', { className: `text-xs ${statusColor}` }, statusLabel),
      ),
      React.createElement('button', {
        className: 'flex items-center gap-1 px-2 py-0.5 text-xs text-ctp-subtext0 hover:text-ctp-text hover:bg-ctp-surface0 rounded transition-colors',
        onClick: handleRestart,
        title: 'Restart terminal',
      },
        // Restart icon (circular arrow)
        React.createElement('svg', {
          width: 14,
          height: 14,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        },
          React.createElement('polyline', { points: '23 4 23 10 17 10' }),
          React.createElement('path', { d: 'M20.49 15a9 9 0 1 1-2.12-9.36L23 10' }),
        ),
        'Restart',
      ),
    ),
    // Terminal body
    React.createElement('div', { className: 'flex-1 min-h-0' },
      status !== 'starting'
        ? React.createElement(ShellTerminal, { sessionId, focused: true })
        : React.createElement('div', { className: 'flex items-center justify-center h-full text-ctp-subtext0 text-xs' }, 'Starting terminal...'),
    ),
  );
}

// Compile-time type assertion
const _: PluginModule = { activate, deactivate, MainPanel, SidebarPanel };
void _;
