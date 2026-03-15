import React from 'react';
import type { PluginContext, TerminalAPI, Disposable } from '../../shared/plugin-types';

export function createTerminalAPI(ctx: PluginContext): TerminalAPI {
  const prefix = `plugin:${ctx.pluginId}:`;

  function fullId(sessionId: string): string {
    return `${prefix}${sessionId}`;
  }

  let ShellTerminalComponent: React.ComponentType<any> | null = null;

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ShellTerminalComponent = require('../features/terminal/ShellTerminal').ShellTerminal;
  } catch {
    // Test environment — return stub
  }

  const ShellTerminalWidget = ({ sessionId, focused }: { sessionId: string; focused?: boolean }) => {
    if (!ShellTerminalComponent) return null;
    return React.createElement(ShellTerminalComponent, { sessionId: fullId(sessionId), focused });
  };

  return {
    async spawn(sessionId: string, cwd?: string): Promise<void> {
      const dir = cwd || ctx.projectPath;
      if (!dir) throw new Error('terminal.spawn requires a working directory (cwd or project context)');
      await window.clubhouse.pty.spawnShell(fullId(sessionId), dir);
    },
    write(sessionId: string, data: string): void {
      window.clubhouse.pty.write(fullId(sessionId), data);
    },
    resize(sessionId: string, cols: number, rows: number): void {
      window.clubhouse.pty.resize(fullId(sessionId), cols, rows);
    },
    async kill(sessionId: string): Promise<void> {
      await window.clubhouse.pty.kill(fullId(sessionId));
    },
    async getBuffer(sessionId: string): Promise<string> {
      return window.clubhouse.pty.getBuffer(fullId(sessionId));
    },
    onData(sessionId: string, callback: (data: string) => void): Disposable {
      const fid = fullId(sessionId);
      const remove = window.clubhouse.pty.onData((id: string, data: string) => {
        if (id === fid) callback(data);
      });
      return { dispose: remove };
    },
    onExit(sessionId: string, callback: (exitCode: number) => void): Disposable {
      const fid = fullId(sessionId);
      const remove = window.clubhouse.pty.onExit((id: string, exitCode: number) => {
        if (id === fid) callback(exitCode);
      });
      return { dispose: remove };
    },
    ShellTerminal: ShellTerminalWidget,
  };
}
