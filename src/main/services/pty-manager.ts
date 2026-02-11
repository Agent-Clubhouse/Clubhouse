import * as pty from 'node-pty';
import { BrowserWindow } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import { findClaudeBinary } from '../util/shell';

interface ManagedPty {
  process: pty.IPty;
  agentId: string;
  lastActivity: number;
}

const ptys = new Map<string, ManagedPty>();

function getMainWindow(): BrowserWindow | null {
  const windows = BrowserWindow.getAllWindows();
  return windows[0] || null;
}

export function spawn(agentId: string, projectPath: string, claudeArgs: string[] = []): void {
  if (ptys.has(agentId)) {
    throw new Error(`Agent ${agentId} already has a running PTY`);
  }

  const claudePath = findClaudeBinary();

  const proc = pty.spawn(claudePath, claudeArgs, {
    name: 'xterm-256color',
    cwd: projectPath,
    env: { ...process.env } as Record<string, string>,
    cols: 120,
    rows: 30,
  });

  const managed: ManagedPty = { process: proc, agentId, lastActivity: Date.now() };
  ptys.set(agentId, managed);

  proc.onData((data: string) => {
    managed.lastActivity = Date.now();
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC.PTY.DATA, agentId, data);
    }
  });

  proc.onExit(({ exitCode }) => {
    ptys.delete(agentId);
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC.PTY.EXIT, agentId, exitCode);
    }
  });
}

export function write(agentId: string, data: string): void {
  const managed = ptys.get(agentId);
  if (managed) {
    managed.process.write(data);
  }
}

export function resize(agentId: string, cols: number, rows: number): void {
  const managed = ptys.get(agentId);
  if (managed) {
    managed.process.resize(cols, rows);
  }
}

export function kill(agentId: string): void {
  const managed = ptys.get(agentId);
  if (managed) {
    managed.process.kill();
    ptys.delete(agentId);
  }
}

export function isActive(agentId: string): boolean {
  const managed = ptys.get(agentId);
  if (!managed) return false;
  return Date.now() - managed.lastActivity < 3000;
}

export function killAll(): void {
  for (const [id, managed] of ptys) {
    try {
      managed.process.kill();
    } catch {
      // Process may already be dead
    }
    ptys.delete(id);
  }
}
