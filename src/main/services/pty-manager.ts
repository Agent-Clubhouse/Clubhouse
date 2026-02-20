import * as pty from 'node-pty';
import { BrowserWindow } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import { getShellEnvironment, getDefaultShell } from '../util/shell';
import { appLog } from './log-service';

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

/**
 * Quote a single argument for use in a Windows cmd.exe command line.
 * Wraps in double quotes and escapes embedded double quotes by doubling them.
 */
function winQuoteArg(arg: string): string {
  if (arg.length === 0) return '""';
  // If no special characters, return as-is
  if (!/[\s"&|<>^%!()]/.test(arg)) return arg;
  // Escape embedded double quotes and wrap
  return '"' + arg.replace(/"/g, '""') + '"';
}
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

export function spawn(agentId: string, cwd: string, binary: string, args: string[] = [], extraEnv?: Record<string, string>, onExit?: (agentId: string, exitCode: number) => void): void {
  if (sessions.has(agentId)) {
    const existing = sessions.get(agentId)!;
    try { existing.process.kill(); } catch {}
    cleanupSession(agentId);
  }

  const isWin = process.platform === 'win32';

  const spawnEnv = extraEnv
    ? { ...getShellEnvironment(), ...extraEnv }
    : { ...getShellEnvironment() };
  // Remove markers that prevent nested Claude Code sessions
  delete spawnEnv.CLAUDECODE;
  delete spawnEnv.CLAUDE_CODE_ENTRYPOINT;

  let proc: pty.IPty;
  let pendingCommand: string | undefined;

  try {
    if (isWin) {
      // On Windows, spawn cmd.exe interactively and use the pendingCommand
      // mechanism (like macOS/Linux) to write the command on first resize.
      // This avoids cmd.exe /c argument-quoting issues that cause the mission
      // text to be mangled or lost when passed directly in the args array.
      const shellCmd = [binary, ...args].map(a => winQuoteArg(a)).join(' ');
      pendingCommand = shellCmd;

      proc = pty.spawn('cmd.exe', [], {
        name: 'xterm-256color',
        cwd,
        env: spawnEnv,
        cols: 120,
        rows: 30,
      });
    } else {
      const shellCmd = [binary, ...args].map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
      const shell = process.env.SHELL || '/bin/zsh';
      pendingCommand = shellCmd;

      proc = pty.spawn(shell, ['-il'], {
        name: 'xterm-256color',
        cwd,
        env: spawnEnv,
        cols: 120,
        rows: 30,
      });
    }
  } catch (err) {
    appLog('core:pty', 'error', 'Failed to spawn PTY process', {
      meta: { agentId, binary, cwd, error: err instanceof Error ? err.message : String(err) },
    });
    throw err;
  }

  const session: ManagedSession = {
    process: proc,
    agentId,
    lastActivity: Date.now(),
    killing: false,
    outputChunks: [],
    outputSize: 0,
    pendingCommand,
  };
  sessions.set(agentId, session);

  proc.onData((data: string) => {
    const current = sessions.get(agentId);
    if (!current || current.process !== proc) return;
    // Shell emitted data while a command is pending — it's ready for input.
    // Fire the command immediately so agents start without waiting for a
    // terminal UI resize (which only happens when the hub pane is visible).
    if (current.pendingCommand) {
      const cmd = current.pendingCommand;
      current.pendingCommand = undefined;
      if (process.platform === 'win32') {
        current.process.write(`${cmd} & exit\r\n`);
      } else {
        current.process.write(`exec ${cmd}\n`);
      }
      return; // suppress shell startup output
    }

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

    const ptyBuffer = current.outputChunks.join('').slice(-500);
    appLog('core:pty', exitCode !== 0 && !current.killing ? 'error' : 'info', `PTY exited`, {
      meta: { agentId, exitCode, binary, lastOutput: ptyBuffer },
    });
    console.error(`[pty-exit] agentId=${agentId} exitCode=${exitCode} binary=${binary} lastOutput=${ptyBuffer.slice(-200)}`);

    cleanupSession(agentId);
    onExit?.(agentId, exitCode);
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

  const isWin = process.platform === 'win32';
  const shellPath = getDefaultShell();
  const shellArgs = isWin ? [] : ['-il'];

  let proc: pty.IPty;
  try {
    proc = pty.spawn(shellPath, shellArgs, {
      name: 'xterm-256color',
      cwd: projectPath,
      env: getShellEnvironment(),
      cols: 120,
      rows: 30,
    });
  } catch (err) {
    appLog('core:pty', 'error', 'Failed to spawn shell PTY', {
      meta: { sessionId: id, cwd: projectPath, error: err instanceof Error ? err.message : String(err) },
    });
    throw err;
  }

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
    appendToBuffer(session, data);
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
    if (process.platform === 'win32') {
      // On Windows cmd.exe: run the command and exit the shell when done.
      // "& exit" ensures cmd.exe closes after the agent process exits,
      // so the PTY exits cleanly and triggers the onExit handler (ghost creation).
      session.process.write(`${cmd} & exit\r\n`);
    } else {
      session.process.write(`exec ${cmd}\n`);
    }
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
