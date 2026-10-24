import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as pty from 'node-pty';
import { IPC } from '../../shared/ipc-channels';
import { getShellEnvironment, getDefaultShell, cleanSpawnEnv } from '../util/shell';
import { buildWindowsCmdLine } from '../util/windows-launcher';
import { broadcastToAllWindows, flushPendingFor } from '../util/ipc-broadcast';
import * as annexEventBus from './annex-event-bus';
import * as headlessTerminal from './pty-headless-terminal';
import { detectWindowsPty } from '../util/windows-pty';
import { broadcastAgentExit } from './agent-exit-broadcast';
import { StaleSweeper } from './stale-sweeper';
import { validateCommandPrefix } from './command-prefix-validation';
import { agentKillRequested, agentKillStage, agentOutput, agentRunKilled, agentRunStarted, agentShellReady, agentSwept, ptyWriteRejected } from '../telemetry/agent-telemetry';
import { diag, redactDiagText } from '../telemetry/diag';
import { tagError, type ErrorType } from '../telemetry/types';
import { stripTerminalEscapes } from '../../shared/terminal-text';
import * as renderDiag from './pty-render-diagnostics';
import { altScreenAfter, resyncOffset, type PtyBufferSnapshot, type PtySnapshotSize } from '../../shared/pty-snapshot';

/** Pattern matching common API key environment variable names. */
const API_KEY_ENV_PATTERN = /^(ANTHROPIC_API_KEY|OPENAI_API_KEY|GOOGLE_API_KEY|AWS_SECRET_ACCESS_KEY|AWS_ACCESS_KEY_ID|AZURE_OPENAI_API_KEY|MISTRAL_API_KEY|COHERE_API_KEY|HUGGING_FACE_TOKEN|HF_TOKEN)$/;

/** Strip API key environment variables from an env object. */
function stripApiKeyEnvVars(env: Record<string, string>): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!API_KEY_ENV_PATTERN.test(key)) {
      filtered[key] = value;
    }
  }
  return filtered;
}

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
  /**
   * Running count of UTF-16 code units ever appended to this session's
   * output (never decremented by eviction).  Each PTY.DATA broadcast carries
   * the value at the end of its chunk and buffer snapshots report the value
   * they include, so a renderer can drop live data already in its snapshot.
   */
  outputSeq: number;
  /**
   * PTY size changes keyed by the output seq they took effect at, oldest
   * first.  Entries before the buffer head are pruned except the last one,
   * which gives the size the kept history starts at.
   */
  sizeLog: Array<{ seq: number; cols: number; rows: number }>;
  /** Whether the alt screen was active at the buffer head (evicted history). */
  headAltScreen: boolean;
  /** Last few evicted chars, so a toggle split across chunks is still seen. */
  evictedTail: string;
  /** Current PTY size, to skip resizes that change nothing. */
  cols: number;
  rows: number;
  /** UTF-16 code units evicted from the head of the buffer so far. */
  evictedChars: number;
  pendingCommand?: string;
  /** Present only for a plain shell terminal owned by this PTY manager. */
  shellCwd?: string;
  eofTimer?: ReturnType<typeof setTimeout>;
  termTimer?: ReturnType<typeof setTimeout>;
  killTimer?: ReturnType<typeof setTimeout>;
  /** Stored so stale sweeper and kill-timeout paths can invoke it. */
  /** `killed`: the exit followed a kill request rather than the CLI quitting on its own. */
  onExitCallback?: (agentId: string, exitCode: number, buffer?: string, killed?: boolean) => void;
}

const MAX_BUFFER_SIZE = 2 * 1024 * 1024; // 2MB per agent

/** Longer than any alt-screen toggle sequence ("ESC[?1049h" is 8). */
const EVICT_TAIL_CHARS = 16;

/** Size every PTY is spawned at, before a terminal reports its own. */
const SPAWN_COLS = 120;
const SPAWN_ROWS = 30;

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
    throw tagError(new Error(`PTY cwd must be an absolute path, received: ${cwd}`), 'cwd_invalid');
  }

  let realCwd: string;
  try {
    realCwd = await fsp.realpath(cwd);
  } catch {
    throw tagError(new Error(`PTY cwd does not exist or is not accessible: ${cwd}`), 'cwd_invalid');
  }

  let stat: fs.Stats;
  try {
    stat = await fsp.stat(realCwd);
  } catch {
    throw tagError(new Error(`PTY cwd does not exist or is not accessible: ${cwd}`), 'cwd_invalid');
  }

  if (!stat.isDirectory()) {
    throw tagError(new Error(`PTY cwd is not a directory: ${cwd}`), 'cwd_invalid');
  }

  const prefixes = process.platform === 'win32' ? SENSITIVE_PREFIXES_WIN : SENSITIVE_PREFIXES_UNIX;
  const normalizedCwd = realCwd.toLowerCase();
  for (const prefix of prefixes) {
    const normalizedPrefix = prefix.toLowerCase();
    if (normalizedCwd === normalizedPrefix || normalizedCwd.startsWith(normalizedPrefix + path.sep)) {
      throw tagError(new Error(`PTY cwd points to a restricted system directory: ${cwd}`), 'cwd_invalid');
    }
  }

  return realCwd;
}

const sessions = new Map<string, ManagedSession>();

/** Raw output scanned for an exit's last output; wider than the kept tail since escapes are stripped from it. */
const EXIT_SCAN_CHARS = 4000;
/** Plain-text characters of output kept with a failed exit (diag line and the renderer's launch error). */
export const EXIT_TAIL_CHARS = 500;

/** The binary's file name: diag lines name the CLI, not where it is installed. */
function binaryName(binary: string): string {
  return binary.split(/[\\/]/).pop() || binary;
}

/** Plain text redacted for an exit's diag line: under the redactor's own cut, which keeps the head. */
const EXIT_REDACT_CHARS = EXIT_TAIL_CHARS * 2;

/**
 * The last output of a failed exit for its diag line: escapes stripped,
 * redacted, then cut, so a cut never leaves part of a secret the redaction
 * would have caught. When the redacted window starts mid-output, its first
 * line may hold a value cut off from its key (`password: x`) and is dropped.
 */
function exitTailForDiag(buffer: string): string {
  let text = stripTerminalEscapes(buffer.slice(-EXIT_SCAN_CHARS));
  const truncated = buffer.length > EXIT_SCAN_CHARS || text.length > EXIT_REDACT_CHARS;
  text = text.slice(-EXIT_REDACT_CHARS);
  if (truncated) text = text.replace(/^[^\n]*\n?/, '');
  return redactDiagText(text).slice(-EXIT_TAIL_CHARS);
}

/** Errno codes a PTY spawn can fail with that the registry's error types name. */
const SPAWN_ERRNO_TYPES: ReadonlySet<string> = new Set<ErrorType>(['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR', 'EISDIR', 'EMFILE', 'ENOSPC']);

/** The errno a spawn error carries, from its `code` or its message. */
function spawnErrno(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string') return code;
  return err instanceof Error ? /\b(E[A-Z]{3,})\b/.exec(err.message)?.[1] : undefined;
}

/**
 * Record a failed `pty.spawn` call: the full message in a diag line, and the
 * errno, when the registry names it, as the error type of the step it
 * escapes (else the caller's `pty_spawn_failed`).
 */
function reportSpawnFailure(err: unknown, msg: string, meta: Record<string, unknown>): void {
  const errno = spawnErrno(err);
  if (errno && SPAWN_ERRNO_TYPES.has(errno)) tagError(err, errno as ErrorType);
  diag('core:pty', 'error', msg, { ...meta, code: errno, error: err instanceof Error ? err.message : String(err) });
}

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
    const capturedGeneration = session.generation;
    const current = sessions.get(agentId);
    if (!current || current.generation !== capturedGeneration) return;
    diag('core:pty', 'warn', 'Stale PTY session detected, cleaning up', { agentId, pid: session.process.pid });
    agentSwept(agentId);
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

/**
 * High-water mark of every session's `outputSeq`.  New sessions start here so
 * sequence numbers for a given id never go backwards across respawns — a
 * renderer holding a snapshot seq from the previous session must not drop
 * the new session's output as "already seen".
 */
let outputSeqHighWater = 0;

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
    outputSeq: outputSeqHighWater,
    sizeLog: [{ seq: outputSeqHighWater, cols: SPAWN_COLS, rows: SPAWN_ROWS }],
    headAltScreen: false,
    evictedTail: '',
    cols: SPAWN_COLS,
    rows: SPAWN_ROWS,
    evictedChars: 0,
    pendingCommand,
  };
}

function appendToBuffer(session: ManagedSession, data: string): void {
  session.outputChunks.push(data);
  session.outputSize += data.length;
  session.outputSeq += data.length;
  if (session.outputSeq > outputSeqHighWater) outputSeqHighWater = session.outputSeq;
  session.bufferCacheDirty = true;
  // Evict oldest chunks using a head pointer — O(1) per eviction step.
  let evicted = false;
  while (session.outputSize > MAX_BUFFER_SIZE && session.outputHead < session.outputChunks.length - 1) {
    const chunk = session.outputChunks[session.outputHead]!;
    const scanned = session.evictedTail + chunk;
    session.headAltScreen = altScreenAfter(scanned, session.headAltScreen);
    session.evictedTail = scanned.slice(-EVICT_TAIL_CHARS);
    session.outputSize -= chunk.length;
    session.evictedChars += chunk.length;
    session.outputHead++;
    evicted = true;
  }
  if (evicted) {
    const headSeq = session.outputSeq - session.outputSize;
    while (session.sizeLog.length > 1 && session.sizeLog[1]!.seq <= headSeq) session.sizeLog.shift();
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

/**
 * Get the raw buffer together with the output sequence number it includes and
 * the PTY size each part of it was written at.  Live PTY.DATA events whose seq
 * is <= `seq` are already in `data`.
 *
 * Once the head has been evicted, the data starts at a safe point past any cut
 * escape sequence, and re-enters the alt screen if it was active there.
 */
export function getBufferSnapshot(agentId: string): PtyBufferSnapshot {
  const session = sessions.get(agentId);
  if (!session) return { data: '', seq: outputSeqHighWater };
  const raw = getSessionBuffer(session);
  const startSeq = session.outputSeq - raw.length;
  const truncated = session.evictedChars > 0;
  const skip = truncated ? resyncOffset(raw) : 0;
  const prefix = truncated && session.headAltScreen ? '\x1b[?1049h' : '';
  const sizes: PtySnapshotSize[] = [];
  for (const entry of session.sizeLog) {
    // Sizes set before the replay start all apply at offset 0; the last wins.
    const offset = entry.seq <= startSeq + skip ? 0 : entry.seq - startSeq - skip + prefix.length;
    if (sizes.length > 0 && sizes[sizes.length - 1]!.offset === offset) sizes.pop();
    sizes.push({ offset, cols: entry.cols, rows: entry.rows });
  }
  const data = skip > 0 || prefix ? prefix + raw.slice(skip) : raw;
  renderDiag.recordSnapshot(agentId, data.length, session.outputSeq, session.evictedChars, sizes.length);
  return { data, seq: session.outputSeq, sizes };
}

annexEventBus.onActiveChange((active) => {
  if (!active) {
    // Only this machine's mirrors: the Annex client keeps its remote caches
    // in the same module.
    for (const id of sessions.keys()) headlessTerminal.dispose(id);
    return;
  }

  for (const session of sessions.values()) {
    const buffer = getSessionBuffer(session);
    if (buffer) mirrorOutput(session, buffer);
  }
});

/** The backend node-pty uses here; fixed for the process. */
const localWindowsPty = detectWindowsPty();

/**
 * Feed output to the session's Annex headless mirror, creating it at the
 * PTY's current size so the replay served to controllers wraps like the PTY
 * (#2325).
 */
function currentSize(session: ManagedSession): { cols: number; rows: number } {
  const { cols, rows } = session.sizeLog[session.sizeLog.length - 1]!;
  return { cols, rows };
}

function mirrorOutput(session: ManagedSession, data: string): void {
  headlessTerminal.ensure(session.agentId, { ...currentSize(session), windowsPty: localWindowsPty });
  headlessTerminal.feedData(session.agentId, data, session.outputSeq);
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

/**
 * `getSerializedBuffer` for Annex controllers, with the output seq it
 * includes (live `pty:data` up to `seq` is already in `data`) and the PTY's
 * size. Waits for the headless mirror to parse everything fed so far.
 */
export async function getSerializedBufferSnapshot(
  agentId: string,
): Promise<{ data: string; seq: number; cols?: number; rows?: number }> {
  const mirrored = await headlessTerminal.snapshot(agentId);
  const session = sessions.get(agentId);
  const size = session ? currentSize(session) : {};
  if (mirrored?.data && mirrored.seq !== undefined) return { data: mirrored.data, seq: mirrored.seq, ...size };
  const { data, seq } = getBufferSnapshot(agentId);
  return { data, seq, ...size };
}

/** Check whether an agent has an active PTY session. */
export function isRunning(agentId: string): boolean {
  return sessions.has(agentId);
}

/** Whether an agent's PTY is still alive after a graceful kill began. */
export function isStopping(agentId: string): boolean {
  return sessions.get(agentId)?.killing === true;
}

function cleanupSession(agentId: string): void {
  const session = sessions.get(agentId);
  if (session) {
    if (session.eofTimer) clearTimeout(session.eofTimer);
    if (session.termTimer) clearTimeout(session.termTimer);
    if (session.killTimer) clearTimeout(session.killTimer);
  }
  sessions.delete(agentId);
  renderDiag.forget(agentId);
}

export async function spawn(agentId: string, cwd: string, binary: string, args: string[] = [], extraEnv?: Record<string, string>, onExit?: (agentId: string, exitCode: number, buffer?: string, killed?: boolean) => void, commandPrefix?: string): Promise<void> {
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
      const shellCmd = buildWindowsCmdLine(binary, args);
      pendingCommand = commandPrefix ? `${validateCommandPrefix(commandPrefix)} & ${shellCmd}` : shellCmd;

      proc = pty.spawn('cmd.exe', ['/v:off'], {
        name: 'xterm-256color',
        cwd,
        env: spawnEnv,
        cols: SPAWN_COLS,
        rows: SPAWN_ROWS,
      });
    } else {
      const shellCmd = [binary, ...args].map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
      const shell = process.env.SHELL || '/bin/zsh';
      pendingCommand = commandPrefix
        ? `${validateCommandPrefix(commandPrefix)} && exec ${shellCmd}`
        : `exec ${shellCmd}`;

      proc = pty.spawn(shell, ['-il'], {
        name: 'xterm-256color',
        cwd,
        env: spawnEnv,
        cols: SPAWN_COLS,
        rows: SPAWN_ROWS,
      });
    }
  } catch (err) {
    reportSpawnFailure(err, 'Failed to spawn PTY process', { agentId, binary: binaryName(binary), cwd });
    throw err;
  }

  const session = createSession(proc, agentId, pendingCommand);
  session.onExitCallback = onExit;
  sessions.set(agentId, session);
  // A respawn under the same id starts at the spawn size; views still
  // following the previous PTY's size must hear about it.
  broadcastToAllWindows(IPC.PTY.RESIZED, agentId, SPAWN_COLS, SPAWN_ROWS);
  renderDiag.recordSpawn(agentId, 'agent', SPAWN_COLS, SPAWN_ROWS);
  agentRunStarted(agentId, 'pty');
  const expectedGeneration = session.generation;

  proc.onData((data: string) => {
    const current = sessions.get(agentId);
    if (!current || current.generation !== expectedGeneration) return;
    // Shell emitted data while a command is pending — it's ready for input.
    // Fire the command immediately so agents start without waiting for a
    // terminal UI resize (which only happens when the terminal is visible).
    if (flushPendingCommand(current)) {
      agentShellReady(agentId);
      return; // suppress shell startup output
    }

    current.lastActivity = Date.now();
    appendToBuffer(current, data);
    renderDiag.recordOutput(agentId, data.length);
    agentOutput(agentId, data.length);
    if (annexEventBus.isActive()) {
      mirrorOutput(current, data);
    }
    broadcastToAllWindows(IPC.PTY.DATA, agentId, data, current.outputSeq);
    annexEventBus.emitPtyData(agentId, data, current.outputSeq);
  });

  proc.onExit(({ exitCode }) => {
    const current = sessions.get(agentId);
    if (!current || current.generation !== expectedGeneration) return;

    const fullBuffer = getSessionBuffer(current);
    // Plain text for the renderer's launch error (#2088); the raw slice can
    // start mid escape sequence, so strip a wider window first.
    const ptyBuffer = stripTerminalEscapes(fullBuffer.slice(-EXIT_SCAN_CHARS)).slice(-EXIT_TAIL_CHARS);
    // The last output is the clue on an exit nobody asked for (#2306), so
    // only a failed one keeps it; it stays in the local diag line.
    const failed = exitCode !== 0 && !current.killing;
    diag('core:pty', failed ? 'error' : 'info', 'PTY exited', {
      agentId, exitCode, binary: binaryName(binary), ...(failed ? { lastOutput: exitTailForDiag(fullBuffer) } : {}),
    });

    if (annexEventBus.isActive()) {
      headlessTerminal.dispose(agentId);
    }
    const killed = current.killing;
    cleanupSession(agentId);
    onExit?.(agentId, exitCode, fullBuffer, killed);
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
      env: stripApiKeyEnvVars(getShellEnvironment()),
      cols: SPAWN_COLS,
      rows: SPAWN_ROWS,
    });
  } catch (err) {
    reportSpawnFailure(err, 'Failed to spawn shell PTY', { sessionId: id, cwd: projectPath });
    throw err;
  }

  const session = createSession(proc, id);
  session.shellCwd = projectPath;
  sessions.set(id, session);
  broadcastToAllWindows(IPC.PTY.RESIZED, id, SPAWN_COLS, SPAWN_ROWS);
  renderDiag.recordSpawn(id, 'shell', SPAWN_COLS, SPAWN_ROWS);
  const expectedGeneration = session.generation;

  proc.onData((data: string) => {
    const current = sessions.get(id);
    if (!current || current.generation !== expectedGeneration) return;

    current.lastActivity = Date.now();
    appendToBuffer(current, data);
    renderDiag.recordOutput(id, data.length);
    if (annexEventBus.isActive()) {
      mirrorOutput(current, data);
    }
    broadcastToAllWindows(IPC.PTY.DATA, id, data, current.outputSeq);
    annexEventBus.emitPtyData(id, data, current.outputSeq);
  });

  proc.onExit(({ exitCode }) => {
    const current = sessions.get(id);
    if (!current || current.generation !== expectedGeneration) return;

    if (annexEventBus.isActive()) {
      headlessTerminal.dispose(id);
    }
    cleanupSession(id);
    broadcastAgentExit(id, exitCode);
  });
}

/** Plain terminals have no agent registration, but remain valid Annex targets. */
export function getShellCwd(id: string): string | undefined {
  return sessions.get(id)?.shellCwd;
}

/**
 * Whether a shell session is running something other than the shell itself
 * (a dev server, an editor, a build), so closing it would interrupt work.
 * Unknown answers are true: Windows does not report the foreground process,
 * and a caller deciding whether to close a shell should keep it then.
 */
export function isShellBusy(id: string): boolean {
  const session = sessions.get(id);
  if (!session) return false;
  if (process.platform === 'win32') return true;
  let foreground: string | undefined;
  try {
    foreground = session.process.process;
  } catch {
    return true;
  }
  if (!foreground) return true;
  const name = (p: string) => p.replace(/^-/, '').split(/[\\/]/).pop() ?? p;
  return name(foreground) !== name(getDefaultShell());
}

/** Defense-in-depth ceiling for a single write() call (64 KB). */
const MAX_WRITE_LENGTH = 64 * 1024;

export function write(agentId: string, data: string): void {
  const session = sessions.get(agentId);
  if (!session) return;

  if (data.length > MAX_WRITE_LENGTH) {
    diag('core:pty', 'warn', 'Oversized PTY write rejected', { agentId, length: data.length, limit: MAX_WRITE_LENGTH });
    ptyWriteRejected('text');
    return;
  }

  session.process.write(data);
}

/**
 * Write raw bytes to the PTY.  `data` is a binary string (one char per byte,
 * code points 0-255) as produced by xterm's `onBinary` — e.g. legacy X10
 * mouse reports.  Converting via latin1 keeps each char as a single byte;
 * the plain `write()` path would UTF-8 encode chars >= 0x80 into two bytes.
 */
export function writeBinary(agentId: string, data: string): void {
  const session = sessions.get(agentId);
  if (!session) return;

  if (data.length > MAX_WRITE_LENGTH) {
    diag('core:pty', 'warn', 'Oversized PTY binary write rejected', { agentId, length: data.length, limit: MAX_WRITE_LENGTH });
    ptyWriteRejected('binary');
    return;
  }

  session.process.write(Buffer.from(data, 'latin1'));
}

/** Record a PTY size change at the current output position. */
function logSize(session: ManagedSession, cols: number, rows: number): void {
  const log = session.sizeLog;
  const last = log[log.length - 1]!;
  if (last.cols === cols && last.rows === rows) return;
  if (last.seq === session.outputSeq) {
    // No output since the last change, so nothing was drawn at that size.
    if (log.length === 1) {
      log[0] = { seq: last.seq, cols, rows };
      return;
    }
    log.pop();
    const prev = log[log.length - 1]!;
    if (prev.cols === cols && prev.rows === rows) return;
  }
  log.push({ seq: session.outputSeq, cols, rows });
}

export function resize(agentId: string, cols: number, rows: number): void {
  const session = sessions.get(agentId);
  // Before the same-size check, so repeated requests are counted.
  if (session) renderDiag.recordResize(agentId, cols, rows);
  if (session && (session.cols !== cols || session.rows !== rows)) {
    // Every real change makes the child repaint (SIGWINCH, or a ConPTY
    // reflow), so same-size requests from extra fits stop here (#2322).
    session.cols = cols;
    session.rows = rows;
    logSize(session, cols, rows);
    session.process.resize(cols, rows);
    if (annexEventBus.isActive()) {
      headlessTerminal.resize(agentId, cols, rows);
    }
    // Send output produced at the old size first: terminals that follow the
    // PTY size apply the change between the two (#2322).
    flushPendingFor(IPC.PTY.DATA, agentId);
    broadcastToAllWindows(IPC.PTY.RESIZED, agentId, cols, rows);
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
  agentKillRequested(agentId, 'other'); // no-op when the caller already named a trigger
  agentKillStage(agentId, 'exit_command');

  try {
    session.process.write(exitCommand);
  } catch {
    // already dead
  }

  // Capture the process reference so timer callbacks target the correct
  // instance even if the session is replaced by a new spawn.
  const proc = session.process;

  // Clear any existing kill timers from a prior rapid kill call
  if (session.eofTimer) { clearTimeout(session.eofTimer); session.eofTimer = undefined; }
  if (session.termTimer) { clearTimeout(session.termTimer); session.termTimer = undefined; }
  if (session.killTimer) { clearTimeout(session.killTimer); session.killTimer = undefined; }

  session.eofTimer = setTimeout(() => {
    const current = sessions.get(agentId);
    if (!current || current.process !== proc) return;
    agentKillStage(agentId, 'eof');
    try { proc.write('\x04'); } catch { /* dead */ }
  }, 3000);

  session.termTimer = setTimeout(() => {
    const current = sessions.get(agentId);
    if (!current || current.process !== proc) return;
    agentKillStage(agentId, 'sigterm');
    try { proc.kill('SIGTERM'); } catch { /* dead */ }
  }, 6000);

  session.killTimer = setTimeout(() => {
    const current = sessions.get(agentId);
    if (current && current.process === proc) {
      agentKillStage(agentId, 'sigkill');
      try { proc.kill(); } catch { /* dead */ }
      const { onExitCallback } = current;
      cleanupSession(agentId);
      broadcastAgentExit(agentId, 1, '');
      // Invoke onExit so the agent registry is cleaned up (prevents memory leak)
      onExitCallback?.(agentId, 1, '', true);
    } else {
      cleanupSession(agentId);
    }
  }, 9000);
}

export function kill(agentId: string): void {
  const session = sessions.get(agentId);
  if (session) {
    try { session.process.kill(); } catch { /* dead */ }
    if (annexEventBus.isActive()) {
      headlessTerminal.dispose(agentId);
    }
    // cleanupSession makes onExit skip this session, so no exit broadcast
    // follows: end the run here.
    agentKillRequested(agentId, 'other');
    agentRunKilled(agentId, 'sigkill');
    cleanupSession(agentId);
  }
}

export function killAll(exitCommand: string = '/exit\r'): Promise<void> {
  const ids = [...sessions.keys()];
  if (ids.length === 0) return Promise.resolve();

  for (const id of ids) {
    const session = sessions.get(id);
    if (!session) continue;
    agentKillRequested(id, 'shutdown');
    agentKillStage(id, 'exit_command');
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
          console.warn(`[pty-manager] killAll: process ${id} did not exit within grace period, sending SIGKILL`);
          try { session.process.kill(); } catch { /* dead */ }
          agentRunKilled(id, 'sigkill');
        }
        cleanupSession(id);
      }
      resolve();
    }, 2000);
  });
}
