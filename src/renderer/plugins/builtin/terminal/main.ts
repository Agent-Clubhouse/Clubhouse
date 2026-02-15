import React, { useEffect, useState, useCallback, useRef } from 'react';
import type { PluginContext, PluginAPI, PluginModule } from '../../../../shared/plugin-types';

type TerminalStatus = 'starting' | 'running' | 'exited';

export function activate(ctx: PluginContext, api: PluginAPI): void {
  const disposable = api.commands.register('restart', () => {
    // Fired from the header button — the MainPanel listens via a shared ref
  });
  ctx.subscriptions.push(disposable);
}

export function deactivate(): void {
  // subscriptions auto-disposed
}

export function MainPanel({ api }: { api: PluginAPI }) {
  const sessionId = api.context.projectId || 'default';
  const projectPath = api.context.projectPath || '';
  const [status, setStatus] = useState<TerminalStatus>('starting');
  const [exitCode, setExitCode] = useState<number | null>(null);
  const spawnedRef = useRef(false);

  const spawnTerminal = useCallback(async () => {
    setStatus('starting');
    setExitCode(null);
    try {
      await api.terminal.spawn(sessionId, projectPath);
      setStatus('running');
    } catch {
      setStatus('exited');
    }
  }, [api, sessionId, projectPath]);

  // Spawn on mount (only if not already running)
  useEffect(() => {
    if (spawnedRef.current) return;
    spawnedRef.current = true;

    // Check if there's already a buffer (session is alive from a previous visit)
    api.terminal.getBuffer(sessionId).then((buf) => {
      if (buf && buf.length > 0) {
        // Session already exists — just connect
        setStatus('running');
      } else {
        spawnTerminal();
      }
    });
  }, [api, sessionId, spawnTerminal]);

  // Listen for exit
  useEffect(() => {
    const sub = api.terminal.onExit(sessionId, (code) => {
      setStatus('exited');
      setExitCode(code);
    });
    return () => sub.dispose();
  }, [api, sessionId]);

  const handleRestart = useCallback(async () => {
    await api.terminal.kill(sessionId);
    spawnTerminal();
  }, [api, sessionId, spawnTerminal]);

  const ShellTerminal = api.terminal.ShellTerminal;

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
        React.createElement('span', { className: 'text-xs font-medium text-ctp-text' }, 'Terminal'),
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
const _: PluginModule = { activate, deactivate, MainPanel };
void _;
