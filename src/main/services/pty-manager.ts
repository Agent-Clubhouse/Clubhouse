import * as pty from 'node-pty';
import { BrowserWindow } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import { findClaudeBinary, getShellEnvironment } from '../util/shell';

interface ManagedPty {
  process: pty.IPty;
  agentId: string;
  lastActivity: number;
  killing: boolean;
}

const MAX_BUFFER_SIZE = 512 * 1024; // 512KB per agent
const ptys = new Map<string, ManagedPty>();
const outputBuffers = new Map<string, string[]>();
const bufferSizes = new Map<string, number>();
const killTimers = new Map<string, ReturnType<typeof setTimeout>>();
// Pending commands: shell spawns first, command fires after terminal sends real size
const pendingCommands = new Map<string, string>();

function appendToBuffer(agentId: string, data: string): void {
  let chunks = outputBuffers.get(agentId);
  if (!chunks) {
    chunks = [];
    outputBuffers.set(agentId, chunks);
    bufferSizes.set(agentId, 0);
  }
  chunks.push(data);
  let size = (bufferSizes.get(agentId) || 0) + data.length;
  // Evict oldest chunks if over budget
  while (size > MAX_BUFFER_SIZE && chunks.length > 1) {
    size -= chunks.shift()!.length;
  }
  bufferSizes.set(agentId, size);
}

export function getBuffer(agentId: string): string {
  const chunks = outputBuffers.get(agentId);
  return chunks ? chunks.join('') : '';
}

function getMainWindow(): BrowserWindow | null {
  const windows = BrowserWindow.getAllWindows();
  return windows[0] || null;
}

export function spawn(agentId: string, projectPath: string, claudeArgs: string[] = []): void {
  if (ptys.has(agentId)) {
    const existing = ptys.get(agentId)!;
    try { existing.process.kill(); } catch {}
    ptys.delete(agentId);
    const timer = killTimers.get(agentId);
    if (timer) { clearTimeout(timer); killTimers.delete(agentId); }
  }
  // Clear any old buffer for a fresh session
  outputBuffers.delete(agentId);
  bufferSizes.delete(agentId);

  const claudePath = findClaudeBinary();
  const shellCmd = [claudePath, ...claudeArgs].map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
  const shell = process.env.SHELL || '/bin/zsh';

  // Spawn a bare interactive shell first. The claude command is written to stdin
  // after the terminal mounts and sends the real resize (see pendingCommands).
  const proc = pty.spawn(shell, ['-il'], {
    name: 'xterm-256color',
    cwd: projectPath,
    env: getShellEnvironment(),
    cols: 120,
    rows: 30,
  });

  pendingCommands.set(agentId, shellCmd);
  const managed: ManagedPty = { process: proc, agentId, lastActivity: Date.now(), killing: false };
  ptys.set(agentId, managed);

  proc.onData((data: string) => {
    // Ignore data from a stale process that was replaced
    const current = ptys.get(agentId);
    if (!current || current.process !== proc) return;

    managed.lastActivity = Date.now();
    appendToBuffer(agentId, data);
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC.PTY.DATA, agentId, data);
    }
  });

  proc.onExit(({ exitCode }) => {
    // Only handle if this process is still the current one for this agent.
    // A new PTY may have been spawned (e.g. wake after kill), in which case
    // the old exit should be silently ignored.
    const current = ptys.get(agentId);
    if (!current || current.process !== proc) return;

    ptys.delete(agentId);
    const timer = killTimers.get(agentId);
    if (timer) { clearTimeout(timer); killTimers.delete(agentId); }
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC.PTY.EXIT, agentId, exitCode);
    }
  });
}

export function spawnShell(id: string, projectPath: string): void {
  if (ptys.has(id)) {
    const existing = ptys.get(id)!;
    try { existing.process.kill(); } catch {}
    ptys.delete(id);
    const timer = killTimers.get(id);
    if (timer) { clearTimeout(timer); killTimers.delete(id); }
  }

  const shellPath = process.env.SHELL || '/bin/zsh';

  const proc = pty.spawn(shellPath, ['-il'], {
    name: 'xterm-256color',
    cwd: projectPath,
    env: getShellEnvironment(),
    cols: 120,
    rows: 30,
  });

  const managed: ManagedPty = { process: proc, agentId: id, lastActivity: Date.now(), killing: false };
  ptys.set(id, managed);

  proc.onData((data: string) => {
    const current = ptys.get(id);
    if (!current || current.process !== proc) return;

    managed.lastActivity = Date.now();
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC.PTY.DATA, id, data);
    }
  });

  proc.onExit(({ exitCode }) => {
    const current = ptys.get(id);
    if (!current || current.process !== proc) return;

    ptys.delete(id);
    const timer = killTimers.get(id);
    if (timer) { clearTimeout(timer); killTimers.delete(id); }
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC.PTY.EXIT, id, exitCode);
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
  // If there's a pending command, the terminal just sent its real size — fire it now.
  const cmd = pendingCommands.get(agentId);
  if (cmd && managed) {
    pendingCommands.delete(agentId);
    // exec replaces the shell so exit signals propagate cleanly
    managed.process.write(`exec ${cmd}\n`);
  }
}

export function gracefulKill(agentId: string): void {
  const managed = ptys.get(agentId);
  if (!managed) return;

  managed.killing = true;

  // Send /exit to Claude CLI
  try {
    managed.process.write('/exit\r');
  } catch {
    // already dead
  }

  // Force kill after 5 seconds if still alive
  const timeout = setTimeout(() => {
    killTimers.delete(agentId);
    if (ptys.has(agentId)) {
      try {
        managed.process.kill();
      } catch {
        // already dead
      }
    }
  }, 5000);

  killTimers.set(agentId, timeout);
}

export function kill(agentId: string): void {
  const managed = ptys.get(agentId);
  if (managed) {
    managed.process.kill();
    ptys.delete(agentId);
  }
  outputBuffers.delete(agentId);
  bufferSizes.delete(agentId);
}

export function killAll(): void {
  for (const [id, managed] of ptys) {
    try {
      managed.process.write('/exit\r');
    } catch {
      // ignore
    }
    setTimeout(() => {
      try {
        managed.process.kill();
      } catch {
        // already dead
      }
    }, 2000);
    ptys.delete(id);
  }
  for (const timer of killTimers.values()) {
    clearTimeout(timer);
  }
  killTimers.clear();
}
