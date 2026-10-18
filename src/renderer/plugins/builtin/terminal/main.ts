import React, { useEffect, useState, useCallback, useRef, useSyncExternalStore } from 'react';
import type { PluginContext, PluginAPI, PluginModule } from '../../../../shared/plugin-types';
import { terminalState, makeSessionId, MAX_TERMINAL_SESSIONS } from './state';
import type { TerminalTarget } from './state';
import { TerminalCanvasWidget } from './TerminalCanvasWidget';
import { useChromeScope } from '../../../chrome/scope';

type TerminalStatus = 'starting' | 'running' | 'exited';

/** Set by the mounted MainPanel so the `restart` command restarts its session. */
let restartAction: (() => void) | null = null;

export function activate(ctx: PluginContext, api: PluginAPI): void {
  const disposable = api.commands.register('restart', () => restartAction?.());
  ctx.subscriptions.push(disposable);

  // Register canvas widget for terminal
  ctx.subscriptions.push(
    api.canvas.registerWidgetType({
      id: 'shell',
      component: TerminalCanvasWidget,
      generateDisplayName: (metadata) => {
        if (metadata.cwd && typeof metadata.cwd === 'string') {
          const segments = metadata.cwd.replace(/\/+$/, '').split('/');
          return segments[segments.length - 1] || 'Terminal';
        }
        return 'Terminal';
      },
    }),
  );
}

export function deactivate(): void {
  restartAction = null;
  terminalState.reset();
  overCapNoticeShown.clear();
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
  const [noWorktreeAgents, setNoWorktreeAgents] = useState<Array<{ id: string; name: string }>>([]);

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
        sessionId: makeSessionId(projectId, 'agent', a.id),
        label: a.name,
        cwd: a.worktreePath!,
        kind: 'agent' as const,
      }));

    const allTargets = [projectTarget, ...agentTargets];
    terminalState.setTargets(allTargets);

    // Track non-worktree agents for greyed-out display
    setNoWorktreeAgents(allDurable.filter((a) => !a.worktreePath).map((a) => ({ id: a.id, name: a.name })));

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

  const heading = (text: string) => React.createElement('div', {
    className: 'h-7 flex-shrink-0 flex items-center px-3.5 text-xs font-semibold text-ctp-overlay1',
  }, text);

  return React.createElement('div', { className: 'flex flex-col h-full bg-ctp-mantle', 'data-testid': 'terminal-sidebar-panel' },
    heading('Targets'),
    // Scrollable list
    React.createElement('div', { className: 'flex-1 overflow-y-auto pb-1' },
      targets.map((target) => {
        const active = activeTarget?.sessionId === target.sessionId;
        return React.createElement('button', {
          key: target.sessionId,
          type: 'button',
          className: `mx-1.5 h-[30px] w-[calc(100%-12px)] flex items-center gap-2 px-2.5 rounded-md text-left text-[13px] cursor-pointer transition-colors focus-ring ${
            active ? 'bg-surface-0 text-ctp-text' : 'text-ctp-subtext1 hover:bg-surface-0 hover:text-ctp-text'
          }`,
          'aria-current': active || undefined,
          title: target.cwd,
          onClick: () => handleClick(target),
        },
          React.createElement('span', {
            className: `w-2 h-2 rounded-full flex-shrink-0 ${target.kind === 'project' ? 'bg-ctp-overlay1' : 'bg-ctp-green'}`,
          }),
          React.createElement('span', { className: 'truncate' }, target.label),
        );
      }),
      // Agents without a worktree share the project root, so they have no shell of their own
      noWorktreeAgents.length > 0 && React.createElement(React.Fragment, null,
        React.createElement('div', { className: 'mt-1.5' }, heading('No worktree')),
        noWorktreeAgents.map((agent) =>
          React.createElement('div', {
            key: `no-wt-${agent.id}`,
            className: 'mx-1.5 h-[30px] flex items-center gap-2 px-2.5 text-[13px] text-ctp-overlay1 cursor-default',
            title: 'Uses the project root. Create the agent with a git worktree to give it its own terminal.',
          },
            React.createElement('span', { className: 'w-2 h-2 rounded-full flex-shrink-0 bg-ctp-overlay0 opacity-40' }),
            React.createElement('span', { className: 'truncate' }, agent.name),
          ),
        ),
      ),
    ),
  );
}

// ── Main Panel ──────────────────────────────────────────────────────────

/** Projects already told that every open shell is busy, so the notice shows once. */
const overCapNoticeShown = new Set<string>();

/** `path` with the home directory shortened to `~`, for display. */
export function displayPath(path: string): string {
  const home = typeof process !== 'undefined' ? (process.env?.HOME || process.env?.USERPROFILE) : undefined;
  if (!home) return path;
  const norm = (p: string) => p.replace(/[\\/]+$/, '');
  const h = norm(home);
  if (path === h) return '~';
  return path.startsWith(`${h}/`) || path.startsWith(`${h}\\`) ? `~${path.slice(h.length)}` : path;
}

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

  // New chrome: the sidebar selection is the target (spec §4.5), so there is no
  // targets list. Agents without a worktree fall back to the project root.
  const scope = useChromeScope(api.context.projectId);
  const scopedTarget: TerminalTarget | null = scope
    ? {
        sessionId: scope.isWorktree ? makeSessionId(projectId, 'agent', scope.agentId) : makeSessionId(projectId, 'project'),
        label: scope.isWorktree ? scope.label : 'Project',
        cwd: scope.cwd,
        kind: scope.isWorktree ? 'agent' : 'project',
      }
    : null;

  const target = scopedTarget || activeTarget || defaultTarget;
  const sessionId = target.sessionId;
  const cwd = target.cwd;

  // What the cwd is, when the path alone does not say: the root, and why.
  const rootNote = scope && scope.kind === 'agent' && !scope.isWorktree
    ? `${scope.agentName} has no worktree, so this is the project root`
    : target.kind === 'project' ? 'project root' : null;

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

  // Keep at most MAX_TERMINAL_SESSIONS shells per project: close the least
  // recently shown idle ones. A shell running a command is never closed for
  // the cap; if only busy ones are left, the project goes over and says so.
  useEffect(() => {
    const candidates = terminalState.touchSession(projectId, sessionId);
    if (candidates.length === 0) return;
    let cancelled = false;
    (async () => {
      for (const candidate of candidates) {
        if (cancelled || terminalState.sessionCount(projectId) <= MAX_TERMINAL_SESSIONS) return;
        if (await api.terminal.isBusy(candidate).catch(() => true)) continue;
        terminalState.forgetSession(projectId, candidate);
        spawnedSessionsRef.current.delete(candidate);
        api.terminal.kill(candidate).catch(() => {});
      }
      if (!cancelled && terminalState.sessionCount(projectId) > MAX_TERMINAL_SESSIONS && !overCapNoticeShown.has(projectId)) {
        overCapNoticeShown.add(projectId);
        api.ui.showNotice(`${terminalState.sessionCount(projectId)} terminals are open in this project and all are running commands, so none were closed.`);
      }
    })();
    return () => { cancelled = true; };
  }, [api, projectId, sessionId]);

  // Close the shells of agents that were deleted (their worktree is gone),
  // unless a command is still running in one.
  useEffect(() => {
    let known = new Set(api.agents.list().map((a) => a.id));
    const sub = api.agents.onAnyChange(() => {
      const now = new Set(api.agents.list().map((a) => a.id));
      for (const id of known) {
        if (now.has(id)) continue;
        const sid = makeSessionId(projectId, 'agent', id);
        terminalState.forgetSession(projectId, sid);
        spawnedSessionsRef.current.delete(sid);
        api.terminal.isBusy(sid).then((busy) => { if (!busy) api.terminal.kill(sid).catch(() => {}); }, () => {});
      }
      known = now;
    });
    return () => sub.dispose();
  }, [api, projectId]);

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

  useEffect(() => {
    const restart = () => { void handleRestart(); };
    restartAction = restart;
    return () => { if (restartAction === restart) restartAction = null; };
  }, [handleRestart]);

  const ShellTerminal = api.terminal.ShellTerminal;

  // Dynamic title: show target context
  useEffect(() => {
    if (target.kind === 'project') {
      api.window.setTitle('Terminal');
    } else {
      api.window.setTitle(`Terminal \u2014 ${target.label}`);
    }
    return () => api.window.resetTitle();
  }, [api, target.kind, target.label]);

  const statusLabel =
    status === 'starting' ? 'Starting' :
    status === 'running' ? 'Running' :
    `Exited${exitCode !== null ? ` (${exitCode})` : ''}`;

  const statusColor = status === 'exited' ? 'text-ctp-red' : 'text-ctp-overlay1';

  return React.createElement('div', { className: 'flex flex-col h-full bg-ctp-base', 'data-testid': 'terminal-main-panel' },
    // Toolbar: the cwd, not the name the breadcrumb already shows
    React.createElement('div', {
      className: 'h-8 flex-shrink-0 flex items-center gap-2 pl-3.5 pr-2.5 border-b border-surface-0 text-xs text-ctp-overlay1 min-w-0',
    },
      React.createElement('span', {
        className: 'font-mono text-[11.5px] text-ctp-subtext1 truncate min-w-0',
        title: cwd,
        'data-testid': 'terminal-cwd',
      }, displayPath(cwd)),
      rootNote && React.createElement('span', { className: 'truncate flex-shrink min-w-0', 'data-testid': 'terminal-root-note' }, rootNote),
      React.createElement('span', { className: 'ml-auto flex items-center gap-1.5 flex-shrink-0' },
        React.createElement('span', { className: statusColor, 'data-testid': 'terminal-status' }, statusLabel),
        React.createElement('button', {
          type: 'button',
          className: 'h-7 flex items-center gap-1.5 px-2 rounded-md text-xs text-ctp-subtext1 hover:text-ctp-text hover:bg-surface-0 transition-colors focus-ring',
          onClick: handleRestart,
          title: 'Restart terminal',
          'data-testid': 'terminal-restart-btn',
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
    ),
    // Terminal body
    React.createElement('div', { className: 'flex-1 min-h-0' },
      status !== 'starting'
        ? React.createElement(ShellTerminal, { sessionId, focused: true })
        : React.createElement('div', { className: 'flex items-center justify-center h-full text-ctp-overlay1 text-xs' }, 'Starting terminal'),
    ),
  );
}

// Compile-time type assertion
const _: PluginModule = { activate, deactivate, MainPanel, SidebarPanel };
void _;
