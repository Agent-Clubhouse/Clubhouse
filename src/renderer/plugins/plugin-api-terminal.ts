import React from 'react';
import type { PluginContext, TerminalAPI, Disposable } from '../../shared/plugin-types';
import { isRemoteProjectId, parseNamespacedId } from '../stores/remoteProjectStore';
import { satellitePtyDataBus, satellitePtyExitBus } from '../stores/annexClientStore';

export function createTerminalAPI(ctx: PluginContext): TerminalAPI {
  const prefix = `plugin:${ctx.pluginId}:`;
  const isRemote = ctx.projectId ? isRemoteProjectId(ctx.projectId) : false;
  const remoteParts = isRemote && ctx.projectId ? parseNamespacedId(ctx.projectId) : null;

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
      if (isRemote && remoteParts) {
        // Spawn shell on the satellite via annex client
        await window.clubhouse.annexClient.ptySpawnShell(
          remoteParts.satelliteId,
          fullId(sessionId),
          remoteParts.agentId, // original project ID on satellite
        );
        return;
      }
      const dir = cwd || ctx.projectPath;
      if (!dir) throw new Error('terminal.spawn requires a working directory (cwd or project context)');
      await window.clubhouse.pty.spawnShell(fullId(sessionId), dir);
    },
    write(sessionId: string, data: string): void {
      if (isRemote && remoteParts) {
        window.clubhouse.annexClient.ptyInput(remoteParts.satelliteId, fullId(sessionId), data);
        return;
      }
      window.clubhouse.pty.write(fullId(sessionId), data);
    },
    resize(sessionId: string, cols: number, rows: number): void {
      if (isRemote && remoteParts) {
        window.clubhouse.annexClient.ptyResize(remoteParts.satelliteId, fullId(sessionId), cols, rows);
        return;
      }
      window.clubhouse.pty.resize(fullId(sessionId), cols, rows);
    },
    async kill(sessionId: string): Promise<void> {
      if (isRemote && remoteParts) {
        // No dedicated kill message for shell terminals over annex yet;
        // send Ctrl+C + exit as a best-effort teardown.
        window.clubhouse.annexClient.ptyInput(remoteParts.satelliteId, fullId(sessionId), '\x03\nexit\n');
        return;
      }
      await window.clubhouse.pty.kill(fullId(sessionId));
    },
    async getBuffer(sessionId: string): Promise<string> {
      if (isRemote && remoteParts) {
        return window.clubhouse.annexClient.ptyGetBuffer(remoteParts.satelliteId, fullId(sessionId));
      }
      return window.clubhouse.pty.getBuffer(fullId(sessionId));
    },
    onData(sessionId: string, callback: (data: string) => void): Disposable {
      const fid = fullId(sessionId);
      if (isRemote && remoteParts) {
        const satId = remoteParts.satelliteId;
        const remove = satellitePtyDataBus.on((sid, agentId, data) => {
          if (sid === satId && agentId === fid) callback(data);
        });
        return { dispose: remove };
      }
      const remove = window.clubhouse.pty.onData((id: string, data: string) => {
        if (id === fid) callback(data);
      });
      return { dispose: remove };
    },
    onExit(sessionId: string, callback: (exitCode: number) => void): Disposable {
      const fid = fullId(sessionId);
      if (isRemote && remoteParts) {
        const satId = remoteParts.satelliteId;
        const remove = satellitePtyExitBus.on((sid, agentId, exitCode) => {
          if (sid === satId && agentId === fid) callback(exitCode);
        });
        return { dispose: remove };
      }
      const remove = window.clubhouse.pty.onExit((id: string, exitCode: number) => {
        if (id === fid) callback(exitCode);
      });
      return { dispose: remove };
    },
    ShellTerminal: ShellTerminalWidget,
  };
}
