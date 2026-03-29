import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as pty from 'node-pty';
import { IPC } from '../../shared/ipc-channels';
import { getShellEnvironment, getDefaultShell, cleanSpawnEnv, winQuoteArg } from '../util/shell';
import { appLog } from './log-service';
import { broadcastToAllWindows } from '../util/ipc-broadcast';
import * as annexEventBus from './annex-event-bus';
import * as headlessTerminal from './pty-headless-terminal';
import { broadcastAgentExit } from './agent-exit-broadcast';
import { StaleSweeper } from './stale-sweeper';

/** Monotonically increasing counter to detect stale session handlers. */
let sessionGeneration = 0;

interface ManagedSession {
  process: pty.IPty;
  agentId: string;
  generation: number;
  lastActivity: number;
  killing: boolean;
  outputChunks: string[];
  outputHead: number;
  outputSize: number;
  bufferCache: string;
  bufferCacheDirty: boolean;
  pendingCommand?: string;
  eofTimer?: ReturnType<typeof setTimeout>;
  termTimer?: ReturnType<typeof setTimeout>;
  killTimer?: ReturnType<typeof setTimeout>;
  /** Stored so stale sweeper and kill-timeout paths can invoke it. */
  onExitCallback?: (agentId: string, exitCode: number, buffer?: string) => void;
}

const MAX_BUFFER_SIZE = 2 * 1024 * 1024; // 2MB per agent

/**
 * Sensitive directory prefixes that should never be used as a PTY cwd.
 * Checked against the resolved real path (symlinks and ".." already resolved).
 */
const SENSITIVE_PREFIXES_UNIX = [
  '/etc',
  '/sbin',
  '/usr/sbin',
  '/var/root',
  '/private/etc',
  '/private/var',
  '/System',
  '/Library',
];
const SENSITIVE_PREFIXES_WIN = [
  'C:\\Windows',
  'C:\\WINDOWS',
];

/**
 * Validate that a directory path is safe to use as a PTY working directory.
 * Throws if the path is relative, does not exist, is not a directory,
 * or resolves to a sensitive system location.
 */
export async function validateSpawnCwd(cwd: string): Promise<string> {
  if (!path.isAbsolute(cwd)) {
    throw new Error(`PTY cwd must be an absolute path, received: ${cwd}`);
  }

  let realCwd: string;
  try {
    realCwd = await fsp.realpath(cwd);
  } catch {
    throw new Error(`PTY cwd does not exist or is not accessible: ${cwd}`);
  }

  let stat: fs.Stats;
  try {
    stat = await fsp.stat(realCwd);
  } catch {
    throw new Error(`PTY cwd does not exist or is not accessible: ${cwd}`);
  }

  if (!stat.isDirectory()) {
    throw new Error(`PTY cwd is not a directory: ${cwd}`);
  }

  const prefixes = process.platform === 'win32' ? SENSITIVE_PREFIXES_WIN : SENSITIVE_PREFIXES_UNIX;
  const normalizedCwd = realCwd.toLowerCase();
  for (const prefix of prefixes) {
    const normalizedPrefix = prefix.toLowerCase();
    if (normalizedCwd === normalizedPrefix || normalizedCwd.startsWith(normalizedPrefix + path.sep)) {
      throw new Error(`PTY cwd points to a restricted system directory: ${cwd}`);
    }
  }

  return realCwd;
}

const sessions = new Map<string, ManagedSession>();

/**
 * Flush a pending command to the PTY. Used in both onData (shell startup) and
 * resize (terminal got its real size) paths.
 */
function flushPendingCommand(session: ManagedSession): boolean {
  if (!session.pendingCommand) return false;
  const cmd = session.pendingCommand;
  session.pendingCommand = undefined;
  if (process.platform === 'win32') {
    session.process.write(`${cmd} & exit\r\n`);
  } else {
    // printf clears the screen so the terminal driver echo and shell
    // prompt echo of the exec command are wiped before the agent starts.
    session.process.write(`printf '\\033[2J\\033[H'; ${cmd}\n`);
  }
  return true;
}

const staleSweeper = new StaleSweeper<ManagedSession>(sessions, {
  isStale: (_agentId, session) => {
    try {
      // Signal 0 checks process liveness without sending a real signal
      process.kill(session.process.pid, 0);
      return false;
    } catch {
      return true;
    }
  },
  onStale: (agentId, session) => {
    appLog('core:pty', 'warn', 'Stale PTY session detected, cleaning up', {
      meta: { agentId, pid: session.process.pid },
    });
    const { onExitCallback } = session;
    cleanupSession(agentId);
    broadcastAgentExit(agentId, 1, '');
    // Invoke onExit so the agent registry is cleaned up (prevents memory leak)
    onExitCallback?.(agentId, 1, '');
  },
});

export function startStaleSweep(): void {
  staleSweeper.start();
}

export function stopStaleSweep(): void {
  staleSweeper.stop();
}

/** Compact threshold: reclaim array memory once the dead-head region grows large. */
const COMPACT_THRESHOLD = 1000;

function createSession(process: pty.IPty, agentId: string, pendingCommand?: string): ManagedSession {
  return {
    process,
    agentId,
    generation: ++sessionGeneration,
    lastActivity: Date.now(),
    killing: false,
    outputChunks: [],
    outputHead: 0,
    outputSize: 0,
    bufferCache: '',
    bufferCacheDirty: false,
    pendingCommand,
  };
}

function appendToBuffer(session: ManagedSession, data: string): void {
  session.outputChunks.push(data);
  session.outputSize += data.length;
  session.bufferCacheDirty = true;
  // Evict oldest chunks using a head pointer — O(1) per eviction step.
  while (session.outputSize > MAX_BUFFER_SIZE && session.outputHead < session.outputChunks.length - 1) {
    session.outputSize -= session.outputChunks[session.outputHead]!.length;
    session.outputHead++;
  }
  // Periodically compact the array to reclaim memory from the evicted prefix.
  if (session.outputHead >= COMPACT_THRESHOLD) {
    session.outputChunks = session.outputChunks.slice(session.outputHead);
    session.outputHead = 0;
  }
}

function getSessionBuffer(session: ManagedSession): string {
  if (session.bufferCacheDirty) {
    session.bufferCache = session.outputChunks.slice(session.outputHead).join('');
    session.bufferCacheDirty = false;
  }

  return session.bufferCache;
}

export function getBuffer(agentId: string): string {
  const session = sessions.get(agentId);
  return session ? getSessionBuffer(session) : '';
}

/** Get the last activity timestamp for an agent's PTY session, or null if no session exists. */
export function getLastActivity(agentId: string): number | null {
  const session = sessions.get(agentId);
  return session ? session.lastActivity : null;
}

/**
 * Get the serialized terminal state for a PTY session.
 * Returns processed output (escape sequences applied) suitable for
 * writing directly into a fresh xterm to reproduce the visual state.
 * Falls back to the raw buffer if no headless terminal is available.
 */
export function getSerializedBuffer(agentId: string): string {
  const serialized = headlessTerminal.serialize(agentId);
  if (serialized) return serialized;
  return getBuffer(agentId);
}

/** Check whether an agent has an active PTY session. */
export function isRunning(agentId: string): boolean {
  return sessions.has(agentId);
}

function cleanupSession(agentId: string): void {
  const session = sessions.get(agentId);
  if (session) {
    if (session.eofTimer) clearTimeout(session.eofTimer);
    if (session.termTimer) clearTimeout(session.termTimer);
    if (session.killTimer) clearTimeout(session.killTimer);
  }
  sessions.delete(agentId);
}

export async function spawn(agentId: string, cwd: string, binary: string, args: string[] = [], extraEnv?: Record<string, string>, onExit?: (agentId: string, exitCode: number, buffer?: string) => void, commandPrefix?: string): Promise<void> {
  await validateSpawnCwd(cwd);

  if (sessions.has(agentId)) {
    const existing = sessions.get(agentId)!;
    try { existing.process.kill(); } catch {}
    cleanupSession(agentId);
  }

  const isWin = process.platform === 'win32';

  const spawnEnv = cleanSpawnEnv(
    extraEnv
      ? { ...getShellEnvironment(), ...extraEnv }
      : { ...getShellEnvironment() },
  );

  let proc: pty.IPty;
  let pendingCommand: string | undefined;

  try {
    if (isWin) {
      // On Windows, spawn cmd.exe interactively and use the pendingCommand
      // mechanism (like macOS/Linux) to write the command on first resize.
      // This avoids cmd.exe /c argument-quoting issues that cause the mission
      // text to be mangled or lost when passed directly in the args array.
      const shellCmd = [binary, ...args].map(a => winQuoteArg(a)).join(' ');
      pendingCommand = commandPrefix ? `${commandPrefix} & ${shellCmd}` : shellCmd;

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
      pendingCommand = commandPrefix
        ? `${commandPrefix} && exec ${shellCmd}`
        : `exec ${shellCmd}`;

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

  const session = createSession(proc, agentId, pendingCommand);
  session.onExitCallback = onExit;
  sessions.set(agentId, session);
  const expectedGeneration = session.generation;

  proc.onData((data: string) => {
    const current = sessions.get(agentId);
    if (!current || current.generation !== expectedGeneration) return;
    // Shell emitted data while a command is pending — it's ready for input.
    // Fire the command immediately so agents start without waiting for a
    // terminal UI resize (which only happens when the hub pane is visible).
    if (flushPendingCommand(current)) {
      return; // suppress shell startup output
    }

    current.lastActivity = Date.now();
    appendToBuffer(current, data);
    headlessTerminal.feedData(agentId, data);
    broadcastToAllWindows(IPC.PTY.DATA, agentId, data);
    annexEventBus.emitPtyData(agentId, data);
  });

  proc.onExit(({ exitCode }) => {
    const current = sessions.get(agentId);
    if (!current || current.generation !== expectedGeneration) return;

    const fullBuffer = getSessionBuffer(current);
    const ptyBuffer = fullBuffer.slice(-500);
    appLog('core:pty', exitCode !== 0 && !current.killing ? 'error' : 'info', `PTY exited`, {
      meta: { agentId, exitCode, binary, lastOutput: ptyBuffer },
    });

    headlessTerminal.dispose(agentId);
    cleanupSession(agentId);
    onExit?.(agentId, exitCode, fullBuffer);
    // Include last PTY output so the renderer can show diagnostics on early exit
    broadcastAgentExit(agentId, exitCode, ptyBuffer);
  });
}

export async function spawnShell(id: string, projectPath: string): Promise<void> {
  await validateSpawnCwd(projectPath);

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

  const session = createSession(proc, id);
  sessions.set(id, session);
  const expectedGeneration = session.generation;

  proc.onData((data: string) => {
    const current = sessions.get(id);
    if (!current || current.generation !== expectedGeneration) return;

    current.lastActivity = Date.now();
    appendToBuffer(current, data);
    headlessTerminal.feedData(id, data);
    broadcastToAllWindows(IPC.PTY.DATA, id, data);
    annexEventBus.emitPtyData(id, data);
  });

  proc.onExit(({ exitCode }) => {
    const current = sessions.get(id);
    if (!current || current.generation !== expectedGeneration) return;

    headlessTerminal.dispose(id);
    cleanupSession(id);
    broadcastToAllWindows(IPC.PTY.EXIT, id, exitCode);
  });
}

/** Defense-in-depth ceiling for a single write() call (64 KB). */
const MAX_WRITE_LENGTH = 64 * 1024;

export function write(agentId: string, data: string): void {
  const session = sessions.get(agentId);
  if (!session) return;

  if (data.length > MAX_WRITE_LENGTH) {
    appLog('core:pty', 'warn', 'Oversized PTY write rejected', {
      meta: { agentId, length: data.length, limit: MAX_WRITE_LENGTH },
    });
    return;
  }

  session.process.write(data);
}

export function resize(agentId: string, cols: number, rows: number): void {
  const session = sessions.get(agentId);
  if (session) {
    session.process.resize(cols, rows);
    headlessTerminal.resize(agentId, cols, rows);
  }
  // If there's a pending command, the terminal just sent its real size — fire it now.
  if (session) {
    flushPendingCommand(session);
  }
}

export function gracefulKill(agentId: string, exitCommand: string = '/exit\r'): void {
  const session = sessions.get(agentId);
  if (!session) return;

  // If a graceful kill is already in progress, no-op to prevent timer
  // overwrite races where concurrent calls orphan timer references.
  if (session.killing) return;

  session.killing = true;

  try {
    session.process.write(exitCommand);
  } catch {
    // already dead
  }

  // Capture the process reference so timer callbacks target the correct
  // instance even if the session is replaced by a new spawn.
  const proc = session.process;

  session.eofTimer = setTimeout(() => {
    const current = sessions.get(agentId);
    if (!current || current.process !== proc) return;
    try { proc.write('\x04'); } catch { /* dead */ }
  }, 3000);

  session.termTimer = setTimeout(() => {
    const current = sessions.get(agentId);
    if (!current || current.process !== proc) return;
    try { proc.kill('SIGTERM'); } catch { /* dead */ }
  }, 6000);

  session.killTimer = setTimeout(() => {
    const current = sessions.get(agentId);
    if (current && current.process === proc) {
      try { proc.kill(); } catch { /* dead */ }
      const { onExitCallback } = current;
      cleanupSession(agentId);
      broadcastAgentExit(agentId, 1, '');
      // Invoke onExit so the agent registry is cleaned up (prevents memory leak)
      onExitCallback?.(agentId, 1, '');
    } else {
      cleanupSession(agentId);
    }
  }, 9000);
}

export function kill(agentId: string): void {
  const session = sessions.get(agentId);
  if (session) {
    try { session.process.kill(); } catch { /* dead */ }
    headlessTerminal.dispose(agentId);
    cleanupSession(agentId);
  }
}

export function killAll(exitCommand: string = '/exit\r'): Promise<void> {
  const ids = [...sessions.keys()];
  if (ids.length === 0) return Promise.resolve();

  for (const id of ids) {
    const session = sessions.get(id);
    if (!session) continue;
    try {
      session.process.write(exitCommand);
    } catch {
      // ignore
    }
  }

  return new Promise<void>((resolve) => {
    setTimeout(() => {
      for (const id of ids) {
        const session = sessions.get(id);
        if (session) {
          try { session.process.kill(); } catch { /* dead */ }
        }
        cleanupSession(id);
      }
      resolve();
    }, 2000);
  });
}
