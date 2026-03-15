import { spawn as cpSpawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import { createInterface } from 'readline';
import { app } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import { JsonlParser, StreamJsonEvent } from './jsonl-parser';
import { getShellEnvironment, cleanSpawnEnv, winQuoteArg } from '../util/shell';
import { appLog } from './log-service';
import { broadcastToAllWindows } from '../util/ipc-broadcast';
import * as annexEventBus from './annex-event-bus';
import { broadcastAgentExit } from './agent-exit-broadcast';
import { HeadlessOutputKind } from '../orchestrators/types';
import { StaleSweeper } from './stale-sweeper';

/** Maximum in-memory transcript size in bytes before old events are evicted to reclaim memory. */
let maxTranscriptBytes = 10 * 1024 * 1024; // 10 MB

/** Maximum in-memory stderr buffer in bytes before old chunks are evicted. */
let maxStderrBytes = 64 * 1024; // 64 KB

/** Change the in-memory transcript cap. Primarily for testing. */
export function setMaxTranscriptBytes(bytes: number): void {
  maxTranscriptBytes = bytes;
}

/** Change the in-memory stderr cap. Primarily for testing. */
export function setMaxStderrBytes(bytes: number): void {
  maxStderrBytes = bytes;
}

interface HeadlessSession {
  process: ChildProcess;
  agentId: string;
  outputKind: HeadlessOutputKind;
  parser: JsonlParser | null;
  transcript: StreamJsonEvent[];
  /** Pre-serialized JSON string for each event, parallel to `transcript`. */
  transcriptLines: string[];
  /** Byte size of each serialized event, parallel to `transcript`. */
  transcriptEventSizes: number[];
  /** Total in-memory transcript size in bytes. */
  transcriptBytes: number;
  /** True once events have been evicted from the in-memory transcript. */
  transcriptEvicted: boolean;
  /** Total events ever written (including evicted). Used for O(1) metadata lookups. */
  totalTranscriptEvents: number;
  /** Total bytes written to the transcript file on disk. */
  totalTranscriptBytesWritten: number;
  transcriptPath: string;
  startedAt: number;
  textBuffer?: string;
  /** Timer for force-kill escalation in kill(). */
  killTimer?: ReturnType<typeof setTimeout>;
  /** Stored so stale sweeper can invoke it when exit events are missed. */
  onExitCallback?: (agentId: string, exitCode: number) => void;
}

const sessions = new Map<string, HeadlessSession>();

function cleanupHeadlessSession(agentId: string): void {
  const session = sessions.get(agentId);
  if (session?.killTimer) {
    clearTimeout(session.killTimer);
  }
  sessions.delete(agentId);
}

const staleSweeper = new StaleSweeper<HeadlessSession>(sessions, {
  isStale: (_agentId, session) => {
    // ChildProcess.exitCode is non-null once the process has exited
    return session.process.exitCode !== null;
  },
  onStale: (agentId, session) => {
    appLog('core:headless', 'warn', 'Stale headless session detected, cleaning up', {
      meta: { agentId, exitCode: session.process.exitCode },
    });
    const exitCode = session.process.exitCode ?? 1;
    const { onExitCallback } = session;
    cleanupHeadlessSession(agentId);
    broadcastAgentExit(agentId, exitCode);
    // Invoke onExit so the agent registry is cleaned up (prevents memory leak)
    onExitCallback?.(agentId, exitCode);
  },
});

export function startStaleSweep(): void {
  staleSweeper.start();
}

export function stopStaleSweep(): void {
  staleSweeper.stop();
}

const LOGS_DIR = path.join(app.getPath('userData'), 'agent-logs');

async function ensureLogsDir(): Promise<void> {
  await fsPromises.mkdir(LOGS_DIR, { recursive: true });
}

/**
 * Evict oldest events from the in-memory transcript to stay under the memory cap.
 * Events are already persisted to disk via the log stream, so no data is lost.
 */
function evictOldEvents(session: HeadlessSession): void {
  const target = Math.floor(maxTranscriptBytes * 0.75);
  let removeBytes = 0;
  let removeCount = 0;

  while (
    removeCount < session.transcriptEventSizes.length &&
    (session.transcriptBytes - removeBytes) > target
  ) {
    removeBytes += session.transcriptEventSizes[removeCount];
    removeCount++;
  }

  if (removeCount > 0) {
    // Use splice (in-place) instead of slice — the spawnHeadless closure
    // captures local references to these arrays, so replacing them would
    // cause new events to be pushed to a stale reference.
    session.transcript.splice(0, removeCount);
    session.transcriptLines.splice(0, removeCount);
    session.transcriptEventSizes.splice(0, removeCount);
    session.transcriptBytes -= removeBytes;

    if (!session.transcriptEvicted) {
      session.transcriptEvicted = true;
      appLog('core:headless', 'warn', `Transcript memory cap reached, evicting old events`, {
        meta: {
          agentId: session.agentId,
          evictedCount: removeCount,
          remaining: session.transcript.length,
          bytesFreed: removeBytes,
        },
      });
    }
  }
}

/**
 * Evict oldest stderr chunks from the in-memory buffer to stay under the cap.
 * stderr is only retained for exit diagnostics, so keeping a recent window is sufficient.
 */
function evictOldStderrChunks(
  stderrChunks: string[],
  stderrChunkSizes: number[],
  stderrBytes: number,
): number {
  const target = Math.floor(maxStderrBytes * 0.75);
  let removeBytes = 0;
  let removeCount = 0;

  while (
    removeCount < stderrChunkSizes.length &&
    (stderrBytes - removeBytes) > target
  ) {
    removeBytes += stderrChunkSizes[removeCount];
    removeCount++;
  }

  if (removeCount > 0) {
    stderrChunks.splice(0, removeCount);
    stderrChunkSizes.splice(0, removeCount);
    return stderrBytes - removeBytes;
  }

  return stderrBytes;
}

export function isHeadless(agentId: string): boolean {
  return sessions.has(agentId);
}

// ── Spawn Helpers ───────────────────────────────────────────────────────────

/** Mutable I/O state shared between stdout, stderr, and exit handlers. */
interface IOState {
  stdoutBytes: number;
  stderrChunks: string[];
  stderrChunkSizes: number[];
  stderrBytes: number;
}

/** Build the cleaned environment for the spawned process. */
function prepareSpawnEnv(extraEnv?: Record<string, string>): Record<string, string> {
  return cleanSpawnEnv({ ...getShellEnvironment(), ...extraEnv });
}

/**
 * Spawn the child process with the correct platform-specific strategy.
 *
 * On Windows, .cmd/.ps1 shims need to be run through cmd.exe.
 * Using windowsVerbatimArguments avoids Node.js double-escaping the
 * arguments which can mangle mission text and long system prompts.
 *
 * When a commandPrefix is provided on non-Windows, it is run in a shell
 * so the prefix (e.g. ". ./init.sh") runs first, then exec replaces the
 * shell with the agent binary.
 */
function spawnProcess(
  binary: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
  commandPrefix?: string,
): ChildProcess {
  const isWin = process.platform === 'win32';

  if (isWin) {
    const cmdLine = [binary, ...args].map(a => winQuoteArg(a)).join(' ');
    const fullCmd = commandPrefix ? `${commandPrefix} & ${cmdLine}` : cmdLine;
    return cpSpawn('cmd.exe', ['/d', '/s', '/c', `"${fullCmd}"`], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsVerbatimArguments: true,
    });
  }

  if (commandPrefix) {
    return cpSpawn('sh', ['-c', `${commandPrefix} && exec "$@"`, '_', binary, ...args], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  return cpSpawn(binary, args, {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/** Create and initialize a HeadlessSession record. */
function createSessionRecord(
  agentId: string,
  proc: ChildProcess,
  outputKind: HeadlessOutputKind,
  transcriptPath: string,
  onExit?: (agentId: string, exitCode: number) => void,
): HeadlessSession {
  const parser = outputKind === 'stream-json' ? new JsonlParser() : null;
  return {
    process: proc,
    agentId,
    outputKind,
    parser,
    transcript: [],
    transcriptLines: [],
    transcriptEventSizes: [],
    transcriptBytes: 0,
    transcriptEvicted: false,
    totalTranscriptEvents: 0,
    totalTranscriptBytesWritten: 0,
    transcriptPath,
    startedAt: Date.now(),
    onExitCallback: onExit,
  };
}

/** Append a single event to the session transcript and persist it to disk. */
function appendTranscriptEvent(
  session: HeadlessSession,
  event: StreamJsonEvent,
  logStream: fs.WriteStream,
): void {
  const serialized = JSON.stringify(event);
  const eventBytes = Buffer.byteLength(serialized, 'utf-8');

  session.transcript.push(event);
  session.transcriptLines.push(serialized);
  session.transcriptEventSizes.push(eventBytes);
  session.transcriptBytes += eventBytes;
  session.totalTranscriptEvents++;
  // Disk write is serialized + newline
  session.totalTranscriptBytesWritten += eventBytes + 1;

  logStream.write(serialized + '\n');
}

/**
 * Wire the JSONL parser to the transcript, disk log, and hook event broadcast.
 * Only attaches listeners when the session has a parser (stream-json mode).
 */
function setupTranscriptPipeline(
  session: HeadlessSession,
  logStream: fs.WriteStream,
  agentId: string,
): void {
  if (!session.parser) return;

  // Track which content_block indices are tool_use (for matching content_block_stop)
  const activeToolBlocks = new Map<number, string>();

  session.parser.on('line', (event: StreamJsonEvent) => {
    appendTranscriptEvent(session, event, logStream);

    // Log first event for diagnostics
    if (session.transcript.length === 1) {
      appLog('core:headless', 'info', `First JSONL event received`, {
        meta: { agentId, type: event.type },
      });
    }

    // Evict old events if in-memory transcript exceeds the cap
    if (session.transcriptBytes > maxTranscriptBytes) {
      evictOldEvents(session);
    }

    // Emit hook events to renderer + annex event bus for status tracking
    const hookEvents = mapToHookEvent(event, activeToolBlocks);
    for (const hookEvent of hookEvents) {
      broadcastToAllWindows(IPC.AGENT.HOOK_EVENT, agentId, hookEvent);
      annexEventBus.emitHookEvent(agentId, hookEvent as any);
    }
  });
}

/** Emit initial notification for text mode so HeadlessAgentView shows activity. */
function emitTextModeNotification(agentId: string, outputKind: HeadlessOutputKind): void {
  if (outputKind !== 'text') return;

  const textNotification = {
    kind: 'notification' as const,
    message: 'Agent running (text output — live events unavailable)',
    timestamp: Date.now(),
  };
  broadcastToAllWindows(IPC.AGENT.HOOK_EVENT, agentId, textNotification);
  annexEventBus.emitHookEvent(agentId, textNotification);
}

/** Wire stdout data to the JSONL parser or text buffer. */
function setupStdoutHandler(
  proc: ChildProcess,
  session: HeadlessSession,
  agentId: string,
  io: IOState,
): void {
  proc.stdout?.on('data', (chunk: Buffer) => {
    const str = chunk.toString();
    io.stdoutBytes += str.length;
    if (io.stdoutBytes === str.length) {
      // First stdout chunk — log it for diagnostics
      appLog('core:headless', 'info', `First stdout data`, {
        meta: { agentId, bytes: str.length, preview: str.slice(0, 200) },
      });
    }
    if (session.parser) {
      session.parser.feed(str);
    } else {
      session.textBuffer = (session.textBuffer || '') + str;
    }
  });
}

/** Wire stderr data to a bounded buffer and broadcast as notifications. */
function setupStderrHandler(
  proc: ChildProcess,
  agentId: string,
  io: IOState,
): void {
  proc.stderr?.on('data', (chunk: Buffer) => {
    const msg = chunk.toString().trim();
    if (!msg) return;

    const msgBytes = Buffer.byteLength(msg, 'utf-8');
    io.stderrChunks.push(msg);
    io.stderrChunkSizes.push(msgBytes);
    io.stderrBytes += msgBytes;

    if (io.stderrBytes > maxStderrBytes) {
      io.stderrBytes = evictOldStderrChunks(io.stderrChunks, io.stderrChunkSizes, io.stderrBytes);
    }

    appLog('core:headless', 'warn', `stderr`, { meta: { agentId, message: msg } });

    // Forward stderr to renderer + annex so headless view can show errors
    const stderrNotification = {
      kind: 'notification' as const,
      message: msg,
      timestamp: Date.now(),
    };
    broadcastToAllWindows(IPC.AGENT.HOOK_EVENT, agentId, stderrNotification);
    annexEventBus.emitHookEvent(agentId, stderrNotification);
  });
}

/**
 * Wire the process close and error handlers.
 *
 * Handles parser flushing, text-mode result synthesis, session cleanup,
 * and exit broadcasting. Guards against the CQ-2 race condition where an
 * old process's close handler fires after a replacement session is stored.
 */
function setupExitHandlers(
  proc: ChildProcess,
  session: HeadlessSession,
  logStream: fs.WriteStream,
  agentId: string,
  outputKind: HeadlessOutputKind,
  io: IOState,
  onExit?: (agentId: string, exitCode: number) => void,
): void {
  let exited = false;

  proc.on('close', (code) => {
    if (exited) return;
    exited = true;

    if (session.parser) {
      session.parser.flush();
    }

    // For text mode, synthesize a result transcript entry from buffered output
    if (outputKind === 'text' && session.textBuffer) {
      const resultEvent: StreamJsonEvent = {
        type: 'result',
        result: session.textBuffer.trim(),
        duration_ms: Date.now() - session.startedAt,
        cost_usd: 0,
      };
      appendTranscriptEvent(session, resultEvent, logStream);

      const stopEvent = {
        kind: 'stop' as const,
        message: session.textBuffer.trim().slice(0, 500),
        timestamp: Date.now(),
      };
      broadcastToAllWindows(IPC.AGENT.HOOK_EVENT, agentId, stopEvent);
      annexEventBus.emitHookEvent(agentId, stopEvent);
    }

    logStream.end();

    // Only clean up and broadcast exit if this session has not been replaced.
    // When spawnHeadless replaces a session, the old process's close handler
    // fires after the new session is already stored — without this guard the
    // handler would delete the NEW session (CQ-2 race condition).
    const currentSession = sessions.get(agentId);
    if (!currentSession || currentSession.process === proc) {
      cleanupHeadlessSession(agentId);

      appLog('core:headless', 'info', `Process exited`, {
        meta: { agentId, exitCode: code, stdoutBytes: io.stdoutBytes, events: session.transcript.length, stderr: io.stderrChunks.join('\n').slice(0, 500) },
      });

      onExit?.(agentId, code ?? 0);

      broadcastAgentExit(agentId, code ?? 0);
    } else {
      appLog('core:headless', 'info', `Old process exited after session replacement — skipping cleanup`, {
        meta: { agentId, exitCode: code },
      });
    }
  });

  proc.on('error', (err) => {
    if (exited) return;
    exited = true;

    appLog('core:headless', 'error', `Process error`, { meta: { agentId, error: err.message } });
    logStream.end();

    // Only clean up and broadcast exit if this session has not been replaced (CQ-2).
    const currentSession = sessions.get(agentId);
    if (!currentSession || currentSession.process === proc) {
      cleanupHeadlessSession(agentId);

      onExit?.(agentId, 1);

      broadcastAgentExit(agentId, 1);
    }
  });
}

// ── Main Entry Point ────────────────────────────────────────────────────────

export async function spawnHeadless(
  agentId: string,
  cwd: string,
  binary: string,
  args: string[],
  extraEnv?: Record<string, string>,
  outputKind: HeadlessOutputKind = 'stream-json',
  onExit?: (agentId: string, exitCode: number) => void,
  commandPrefix?: string,
): Promise<void> {
  // Clean up any existing session
  if (sessions.has(agentId)) {
    kill(agentId);
  }

  await ensureLogsDir();
  const transcriptPath = path.join(LOGS_DIR, `${agentId}.jsonl`);
  const env = prepareSpawnEnv(extraEnv);

  appLog('core:headless', 'info', `Spawning headless agent`, {
    meta: { agentId, binary, args: args.join(' '), cwd, hasAnthropicKey: !!env.ANTHROPIC_API_KEY },
  });

  const proc = spawnProcess(binary, args, cwd, env, commandPrefix);

  // Close stdin immediately — `-p` mode uses the CLI argument, not stdin.
  // An open stdin pipe can cause Claude Code to wait for input.
  proc.stdin?.end();

  if (!proc.pid) {
    appLog('core:headless', 'error', `Failed to spawn — no PID (binary may not exist)`, {
      meta: { agentId, binary },
    });
  } else {
    appLog('core:headless', 'info', `Process spawned`, { meta: { agentId, pid: proc.pid } });
  }

  const session = createSessionRecord(agentId, proc, outputKind, transcriptPath, onExit);
  sessions.set(agentId, session);

  const logStream = fs.createWriteStream(transcriptPath, { flags: 'w' });
  const io: IOState = { stdoutBytes: 0, stderrChunks: [], stderrChunkSizes: [], stderrBytes: 0 };

  setupTranscriptPipeline(session, logStream, agentId);
  emitTextModeNotification(agentId, outputKind);
  setupStdoutHandler(proc, session, agentId, io);
  setupStderrHandler(proc, agentId, io);
  setupExitHandlers(proc, session, logStream, agentId, outputKind, io, onExit);
}

/** @internal — exported for testing only */
export const _internal = {
  prepareSpawnEnv,
  spawnProcess,
  createSessionRecord,
  appendTranscriptEvent,
  emitTextModeNotification,
  setupTranscriptPipeline,
  setupStdoutHandler,
  setupStderrHandler,
  setupExitHandlers,
};

export function kill(agentId: string): void {
  const session = sessions.get(agentId);
  if (!session) return;

  // Clear any existing kill timer to prevent leaks on double-call
  if (session.killTimer) clearTimeout(session.killTimer);

  const proc = session.process;

  try {
    proc.kill('SIGTERM');
  } catch { /* already dead */ }

  // Force kill after 5 seconds, guarded by process identity so a
  // replacement session spawned with the same agentId is not affected.
  session.killTimer = setTimeout(() => {
    const current = sessions.get(agentId);
    if (current && current.process === proc) {
      try { proc.kill('SIGKILL'); } catch { /* dead */ }
      cleanupHeadlessSession(agentId);
    }
  }, 5000);
}

export async function readTranscript(agentId: string): Promise<string | null> {
  // First check in-memory session
  const session = sessions.get(agentId);
  if (session) {
    // When old events have been evicted, disk has the complete transcript
    if (session.transcriptEvicted) {
      try {
        return await fsPromises.readFile(session.transcriptPath, 'utf-8');
      } catch {
        // Fall through to partial in-memory transcript
      }
    }
    return session.transcriptLines.join('\n');
  }

  // Fall back to disk for completed sessions
  const transcriptPath = path.join(LOGS_DIR, `${agentId}.jsonl`);
  try {
    return await fsPromises.readFile(transcriptPath, 'utf-8');
  } catch {
    return null;
  }
}

export interface TranscriptInfo {
  totalEvents: number;
  fileSizeBytes: number;
}

export interface TranscriptPage {
  events: StreamJsonEvent[];
  totalEvents: number;
}

/**
 * Return metadata about a transcript without loading event data.
 * For active sessions, returns O(1) running counters maintained as events
 * are appended — no file I/O required even when old events have been evicted.
 * For completed sessions (no in-memory session), falls back to disk.
 */
export async function getTranscriptInfo(agentId: string): Promise<TranscriptInfo | null> {
  // Active session — use running counters (O(1), no file I/O)
  const session = sessions.get(agentId);
  if (session) {
    return {
      totalEvents: session.totalTranscriptEvents,
      fileSizeBytes: session.totalTranscriptBytesWritten,
    };
  }

  // Completed session — stream from disk
  const transcriptPath = path.join(LOGS_DIR, `${agentId}.jsonl`);
  try {
    const stat = await fsPromises.stat(transcriptPath);
    const stream = fs.createReadStream(transcriptPath, { encoding: 'utf-8' });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    let lineCount = 0;
    for await (const line of rl) {
      if (line.trim()) lineCount++;
    }

    return { totalEvents: lineCount, fileSizeBytes: stat.size };
  } catch {
    return null;
  }
}

/**
 * Return a page of parsed transcript events.
 * `offset` is the 0-based event index; `limit` is the max events to return.
 * Events are returned in chronological order.
 *
 * Streams the JSONL file line-by-line so that only the lines within the
 * requested page window are JSON-parsed. Lines before `offset` and after
 * `offset + limit` are counted but not parsed, avoiding the O(N) parse cost
 * of the previous read-everything-then-slice approach.
 */
export async function readTranscriptPage(
  agentId: string,
  offset: number,
  limit: number,
): Promise<TranscriptPage | null> {
  // In-memory session (not evicted)
  const session = sessions.get(agentId);
  if (session && !session.transcriptEvicted) {
    const total = session.transcript.length;
    const events = session.transcript.slice(offset, offset + limit);
    return { events, totalEvents: total };
  }

  // Disk: stream lines to avoid loading the entire file into memory and
  // only JSON.parse the lines within the requested page window.
  const transcriptPath = session?.transcriptPath ?? path.join(LOGS_DIR, `${agentId}.jsonl`);
  try {
    const stream = fs.createReadStream(transcriptPath, { encoding: 'utf-8' });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    let lineIndex = 0;
    const events: StreamJsonEvent[] = [];

    for await (const line of rl) {
      if (!line.trim()) continue;

      // Only parse lines within the requested page window
      if (lineIndex >= offset && events.length < limit) {
        try { events.push(JSON.parse(line) as StreamJsonEvent); } catch { /* skip malformed */ }
      }

      lineIndex++;
    }

    return { events, totalEvents: lineIndex };
  } catch {
    return null;
  }
}


/**
 * Map stream-json events to normalized hook events for the renderer.
 *
 * With --verbose, Claude Code emits conversation-level events:
 *   { type: "assistant", message: { content: [{ type: "tool_use", name, input }, ...] } }
 *   { type: "user", message: { content: [{ type: "tool_result", ... }] } }
 *   { type: "result", result: "...", cost_usd, duration_ms }
 *
 * Without --verbose (legacy streaming format):
 *   content_block_start, content_block_delta, content_block_stop, result
 */
function mapToHookEvent(
  event: StreamJsonEvent,
  activeToolBlocks: Map<number, string>,
): Array<{
  kind: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  message?: string;
  timestamp: number;
}> {
  const timestamp = Date.now();
  const results: Array<{
    kind: string;
    toolName?: string;
    toolInput?: Record<string, unknown>;
    message?: string;
    timestamp: number;
  }> = [];

  // --verbose format: assistant messages contain tool_use blocks
  if (event.type === 'assistant' && event.message) {
    const msg = event.message as { content?: Array<{ type: string; name?: string; input?: Record<string, unknown>; text?: string }> };
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'tool_use' && block.name) {
          results.push({ kind: 'pre_tool', toolName: block.name, toolInput: block.input, timestamp });
        }
      }
    }
  }

  // --verbose format: user messages contain tool_result blocks (tool completed)
  if (event.type === 'user' && event.message) {
    const msg = event.message as { content?: Array<{ type: string; tool_use_id?: string }> };
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'tool_result') {
          results.push({ kind: 'post_tool', timestamp });
        }
      }
    }
  }

  // result event (same in both formats)
  if (event.type === 'result') {
    results.push({
      kind: 'stop',
      message: typeof event.result === 'string' ? event.result : undefined,
      timestamp,
    });
  }

  // Legacy streaming format fallback
  const index = typeof event.index === 'number' ? event.index : -1;
  if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
    const name = event.content_block.name || 'unknown';
    if (index >= 0) activeToolBlocks.set(index, name);
    results.push({ kind: 'pre_tool', toolName: name, timestamp });
  }
  if (event.type === 'content_block_stop' && index >= 0 && activeToolBlocks.has(index)) {
    const toolName = activeToolBlocks.get(index)!;
    activeToolBlocks.delete(index);
    results.push({ kind: 'post_tool', toolName, timestamp });
  }

  return results;
}
