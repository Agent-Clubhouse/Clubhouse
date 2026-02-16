import * as pty from 'node-pty';
import { BrowserWindow } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import { getShellEnvironment } from '../util/shell';

interface ManagedSession {
  process: pty.IPty;
  agentId: string;
  lastActivity: number;
  killing: boolean;
  outputChunks: string[];
  outputSize: number;
  pendingCommand?: string;
  killTimer?: ReturnType<typeof setTimeout>;
}

const MAX_BUFFER_SIZE = 512 * 1024; // 512KB per agent
const sessions = new Map<string, ManagedSession>();

function appendToBuffer(session: ManagedSession, data: string): void {
  session.outputChunks.push(data);
  session.outputSize += data.length;
  while (session.outputSize > MAX_BUFFER_SIZE && session.outputChunks.length > 1) {
    session.outputSize -= session.outputChunks.shift()!.length;
  }
}

export function getBuffer(agentId: string): string {
  const session = sessions.get(agentId);
  return session ? session.outputChunks.join('') : '';
}

function getMainWindow(): BrowserWindow | null {
  const windows = BrowserWindow.getAllWindows();
  return windows[0] || null;
}

function cleanupSession(agentId: string): void {
  const session = sessions.get(agentId);
  if (session?.killTimer) clearTimeout(session.killTimer);
  sessions.delete(agentId);
}

export function spawn(agentId: string, cwd: string, binary: string, args: string[] = [], extraEnv?: Record<string, string>): void {
  if (sessions.has(agentId)) {
    const existing = sessions.get(agentId)!;
    try { existing.process.kill(); } catch {}
    cleanupSession(agentId);
  }

  const shellCmd = [binary, ...args].map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
  const shell = process.env.SHELL || '/bin/zsh';

  const spawnEnv = extraEnv
    ? { ...getShellEnvironment(), ...extraEnv }
    : getShellEnvironment();

  const proc = pty.spawn(shell, ['-il'], {
    name: 'xterm-256color',
    cwd,
    env: spawnEnv,
    cols: 120,
    rows: 30,
  });

  const session: ManagedSession = {
    process: proc,
    agentId,
    lastActivity: Date.now(),
    killing: false,
    outputChunks: [],
    outputSize: 0,
    pendingCommand: shellCmd,
  };
  sessions.set(agentId, session);

  proc.onData((data: string) => {
    const current = sessions.get(agentId);
    if (!current || current.process !== proc) return;
    if (current.pendingCommand) return; // suppress shell startup output

    session.lastActivity = Date.now();
    appendToBuffer(session, data);
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC.PTY.DATA, agentId, data);
    }
  });

  proc.onExit(({ exitCode }) => {
    const current = sessions.get(agentId);
    if (!current || current.process !== proc) return;

    cleanupSession(agentId);
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC.PTY.EXIT, agentId, exitCode);
    }
  });
}

export function spawnShell(id: string, projectPath: string): void {
  if (sessions.has(id)) {
    const existing = sessions.get(id)!;
    try { existing.process.kill(); } catch {}
    cleanupSession(id);
  }

  const shellPath = process.env.SHELL || '/bin/zsh';

  const proc = pty.spawn(shellPath, ['-il'], {
    name: 'xterm-256color',
    cwd: projectPath,
    env: getShellEnvironment(),
    cols: 120,
    rows: 30,
  });

  const session: ManagedSession = {
    process: proc,
    agentId: id,
    lastActivity: Date.now(),
    killing: false,
    outputChunks: [],
    outputSize: 0,
  };
  sessions.set(id, session);

  proc.onData((data: string) => {
    const current = sessions.get(id);
    if (!current || current.process !== proc) return;

    session.lastActivity = Date.now();
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC.PTY.DATA, id, data);
    }
  });

  proc.onExit(({ exitCode }) => {
    const current = sessions.get(id);
    if (!current || current.process !== proc) return;

    cleanupSession(id);
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC.PTY.EXIT, id, exitCode);
    }
  });
}

export function write(agentId: string, data: string): void {
  const session = sessions.get(agentId);
  if (session) {
    session.process.write(data);
  }
}

export function resize(agentId: string, cols: number, rows: number): void {
  const session = sessions.get(agentId);
  if (session) {
    session.process.resize(cols, rows);
  }
  // If there's a pending command, the terminal just sent its real size — fire it now.
  if (session?.pendingCommand) {
    const cmd = session.pendingCommand;
    session.pendingCommand = undefined;
    session.process.write(`exec ${cmd}\n`);
  }
}

export function gracefulKill(agentId: string, exitCommand: string = '/exit\r'): void {
  const session = sessions.get(agentId);
  if (!session) return;

  session.killing = true;

  try {
    session.process.write(exitCommand);
  } catch {
    // already dead
  }

  const eofTimer = setTimeout(() => {
    if (!sessions.has(agentId)) return;
    try { session.process.write('\x04'); } catch { /* dead */ }
  }, 3000);

  const termTimer = setTimeout(() => {
    if (!sessions.has(agentId)) return;
    try { session.process.kill('SIGTERM'); } catch { /* dead */ }
  }, 6000);

  session.killTimer = setTimeout(() => {
    if (sessions.has(agentId)) {
      try { session.process.kill(); } catch { /* dead */ }
    }
    clearTimeout(eofTimer);
    clearTimeout(termTimer);
    cleanupSession(agentId);
  }, 9000);
}

export function kill(agentId: string): void {
  const session = sessions.get(agentId);
  if (session) {
    try { session.process.kill(); } catch { /* dead */ }
    cleanupSession(agentId);
  }
}

export function killAll(exitCommand: string = '/exit\r'): void {
  for (const [id, session] of sessions) {
    try {
      session.process.write(exitCommand);
    } catch {
      // ignore
    }
    setTimeout(() => {
      try { session.process.kill(); } catch { /* dead */ }
    }, 2000);
    sessions.delete(id);
  }
}
