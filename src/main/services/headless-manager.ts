import { spawn as cpSpawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import { app } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import { JsonlParser, StreamJsonEvent } from './jsonl-parser';
import { getShellEnvironment } from '../util/shell';
import { appLog } from './log-service';
import { broadcastToAllWindows } from '../util/ipc-broadcast';
import * as annexEventBus from './annex-event-bus';
import { HeadlessOutputKind } from '../orchestrators/types';

/**
 * Quote a single argument for a Windows cmd.exe /s /c command line.
 * Always wraps in double quotes to safely handle spaces, special chars,
 * and long argument values (e.g. mission text, system prompts).
 * Embedded double quotes are escaped by doubling them ("").
 */
function winQuoteHeadlessArg(arg: string): string {
  if (arg.length === 0) return '""';
  return '"' + arg.replace(/"/g, '""') + '"';
}

/** Maximum in-memory transcript size in bytes before old events are evicted to reclaim memory. */
let maxTranscriptBytes = 10 * 1024 * 1024; // 10 MB

/** Change the in-memory transcript cap. Primarily for testing. */
export function setMaxTranscriptBytes(bytes: number): void {
  maxTranscriptBytes = bytes;
}

interface HeadlessSession {
  process: ChildProcess;
  agentId: string;
  outputKind: HeadlessOutputKind;
  parser: JsonlParser | null;
  transcript: StreamJsonEvent[];
  /** Byte size of each serialized event, parallel to `transcript`. */
  transcriptEventSizes: number[];
  /** Total in-memory transcript size in bytes. */
  transcriptBytes: number;
  /** True once events have been evicted from the in-memory transcript. */
  transcriptEvicted: boolean;
  transcriptPath: string;
  startedAt: number;
  textBuffer?: string;
  /** Timer for force-kill escalation in kill(). */
  killTimer?: ReturnType<typeof setTimeout>;
}

const sessions = new Map<string, HeadlessSession>();

function cleanupHeadlessSession(agentId: string): void {
  const session = sessions.get(agentId);
  if (session?.killTimer) {
    clearTimeout(session.killTimer);
  }
  sessions.delete(agentId);
}

/** Interval (ms) between stale session sweep checks. */
const STALE_SWEEP_INTERVAL = 30_000;

let sweepTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start a periodic sweep that detects headless sessions whose processes have
 * died without triggering the close/error handler. Safety net for edge cases.
 */
export function startStaleSweep(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    for (const [agentId, session] of sessions) {
      // ChildProcess.exitCode is non-null once the process has exited
      if (session.process.exitCode !== null) {
        appLog('core:headless', 'warn', 'Stale headless session detected, cleaning up', {
          meta: { agentId, exitCode: session.process.exitCode },
        });
        cleanupHeadlessSession(agentId);
        broadcastToAllWindows(IPC.PTY.EXIT, agentId, session.process.exitCode ?? 1);
        annexEventBus.emitPtyExit(agentId, session.process.exitCode ?? 1);
      }
    }
  }, STALE_SWEEP_INTERVAL);
  sweepTimer.unref();
}

/** Stop the periodic stale session sweep. */
export function stopStaleSweep(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

const LOGS_DIR = path.join(app.getPath('userData'), 'agent-logs');

function ensureLogsDir(): void {
  if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  }
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

export function isHeadless(agentId: string): boolean {
  return sessions.has(agentId);
}

export function spawnHeadless(
  agentId: string,
  cwd: string,
  binary: string,
  args: string[],
  extraEnv?: Record<string, string>,
  outputKind: HeadlessOutputKind = 'stream-json',
  onExit?: (agentId: string, exitCode: number) => void,
): void {
  // Clean up any existing session
  if (sessions.has(agentId)) {
    kill(agentId);
  }

  ensureLogsDir();
  const transcriptPath = path.join(LOGS_DIR, `${agentId}.jsonl`);

  const env = { ...getShellEnvironment(), ...extraEnv };
  // Remove markers that prevent nested Claude Code sessions
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;

  appLog('core:headless', 'info', `Spawning headless agent`, {
    meta: { agentId, binary, args: args.join(' '), cwd, hasAnthropicKey: !!env.ANTHROPIC_API_KEY },
  });

  const isWin = process.platform === 'win32';
  // On Windows, .cmd/.ps1 shims need to be run through cmd.exe.
  // Using windowsVerbatimArguments avoids Node.js double-escaping the
  // arguments which can mangle mission text and long system prompts.
  const proc = isWin
    ? cpSpawn('cmd.exe', ['/d', '/s', '/c', `"${[binary, ...args].map(a => winQuoteHeadlessArg(a)).join(' ')}"`], {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsVerbatimArguments: true,
      })
    : cpSpawn(binary, args, {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

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

  const parser = outputKind === 'stream-json' ? new JsonlParser() : null;
  const transcript: StreamJsonEvent[] = [];
  const transcriptEventSizes: number[] = [];
  let stdoutBytes = 0;
  let stderrChunks: string[] = [];

  const session: HeadlessSession = {
    process: proc,
    agentId,
    outputKind,
    parser,
    transcript,
    transcriptEventSizes,
    transcriptBytes: 0,
    transcriptEvicted: false,
    transcriptPath,
    startedAt: Date.now(),
  };
  sessions.set(agentId, session);

  // Open write stream for transcript persistence
  const logStream = fs.createWriteStream(transcriptPath, { flags: 'w' });
  // Track which content_block indices are tool_use (for matching content_block_stop)
  const activeToolBlocks = new Map<number, string>();

  if (parser) {
    parser.on('line', (event: StreamJsonEvent) => {
      const serialized = JSON.stringify(event);
      const eventBytes = Buffer.byteLength(serialized, 'utf-8');

      transcript.push(event);
      transcriptEventSizes.push(eventBytes);
      session.transcriptBytes += eventBytes;

      // Log first event for diagnostics
      if (transcript.length === 1) {
        appLog('core:headless', 'info', `First JSONL event received`, {
          meta: { agentId, type: event.type },
        });
      }

      // Persist to disk (always — disk is the source of truth)
      logStream.write(serialized + '\n');

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

  // Emit initial notification for text mode so HeadlessAgentView shows activity
  if (outputKind === 'text') {
    const textNotification = {
      kind: 'notification' as const,
      message: 'Agent running (text output — live events unavailable)',
      timestamp: Date.now(),
    };
    broadcastToAllWindows(IPC.AGENT.HOOK_EVENT, agentId, textNotification);
    annexEventBus.emitHookEvent(agentId, textNotification);
  }

  proc.stdout?.on('data', (chunk: Buffer) => {
    const str = chunk.toString();
    stdoutBytes += str.length;
    if (stdoutBytes === str.length) {
      // First stdout chunk — log it for diagnostics
      appLog('core:headless', 'info', `First stdout data`, {
        meta: { agentId, bytes: str.length, preview: str.slice(0, 200) },
      });
    }
    if (parser) {
      parser.feed(str);
    } else {
      session.textBuffer = (session.textBuffer || '') + str;
    }
  });

  proc.stderr?.on('data', (chunk: Buffer) => {
    const msg = chunk.toString().trim();
    stderrChunks.push(msg);
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

  let exited = false;

  proc.on('close', (code) => {
    if (exited) return;
    exited = true;

    if (parser) {
      parser.flush();
    }

    // For text mode, synthesize a result transcript entry from buffered output
    if (outputKind === 'text' && session.textBuffer) {
      const resultEvent: StreamJsonEvent = {
        type: 'result',
        result: session.textBuffer.trim(),
        duration_ms: Date.now() - session.startedAt,
        cost_usd: 0,
      };
      const serialized = JSON.stringify(resultEvent);
      const eventBytes = Buffer.byteLength(serialized, 'utf-8');
      transcript.push(resultEvent);
      transcriptEventSizes.push(eventBytes);
      session.transcriptBytes += eventBytes;
      logStream.write(serialized + '\n');

      const stopEvent = {
        kind: 'stop' as const,
        message: session.textBuffer.trim().slice(0, 500),
        timestamp: Date.now(),
      };
      broadcastToAllWindows(IPC.AGENT.HOOK_EVENT, agentId, stopEvent);
      annexEventBus.emitHookEvent(agentId, stopEvent);
    }

    logStream.end();
    cleanupHeadlessSession(agentId);

    appLog('core:headless', 'info', `Process exited`, {
      meta: { agentId, exitCode: code, stdoutBytes, events: transcript.length, stderr: stderrChunks.join('\n').slice(0, 500) },
    });

    onExit?.(agentId, code ?? 0);

    broadcastToAllWindows(IPC.PTY.EXIT, agentId, code ?? 0);
    annexEventBus.emitPtyExit(agentId, code ?? 0);
  });

  proc.on('error', (err) => {
    if (exited) return;
    exited = true;

    appLog('core:headless', 'error', `Process error`, { meta: { agentId, error: err.message } });
    logStream.end();
    cleanupHeadlessSession(agentId);

    onExit?.(agentId, 1);

    broadcastToAllWindows(IPC.PTY.EXIT, agentId, 1);
    annexEventBus.emitPtyExit(agentId, 1);
  });
}

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

export function readTranscript(agentId: string): string | null {
  // First check in-memory session
  const session = sessions.get(agentId);
  if (session) {
    // When old events have been evicted, disk has the complete transcript
    if (session.transcriptEvicted) {
      try {
        return fs.readFileSync(session.transcriptPath, 'utf-8');
      } catch {
        // Fall through to partial in-memory transcript
      }
    }
    return session.transcript.map((e) => JSON.stringify(e)).join('\n');
  }

  // Fall back to disk for completed sessions
  const transcriptPath = path.join(LOGS_DIR, `${agentId}.jsonl`);
  try {
    return fs.readFileSync(transcriptPath, 'utf-8');
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
 * Uses async fs to avoid blocking the main process for large files.
 */
export async function getTranscriptInfo(agentId: string): Promise<TranscriptInfo | null> {
  // Check in-memory session first
  const session = sessions.get(agentId);
  if (session && !session.transcriptEvicted) {
    return {
      totalEvents: session.transcript.length,
      fileSizeBytes: session.transcriptBytes,
    };
  }

  // Read from disk (evicted session or completed session)
  const transcriptPath = session?.transcriptPath ?? path.join(LOGS_DIR, `${agentId}.jsonl`);
  try {
    const stat = await fsPromises.stat(transcriptPath);
    const raw = await fsPromises.readFile(transcriptPath, 'utf-8');
    const lineCount = raw.split('\n').filter((l) => l.trim()).length;
    return { totalEvents: lineCount, fileSizeBytes: stat.size };
  } catch {
    return null;
  }
}

/**
 * Return a page of parsed transcript events.
 * `offset` is the 0-based event index; `limit` is the max events to return.
 * Events are returned in chronological order.
 * Uses async fs to avoid blocking the main process.
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

  // Disk: evicted session or completed session
  const transcriptPath = session?.transcriptPath ?? path.join(LOGS_DIR, `${agentId}.jsonl`);
  try {
    const raw = await fsPromises.readFile(transcriptPath, 'utf-8');
    const allEvents = raw
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => {
        try { return JSON.parse(line) as StreamJsonEvent; } catch { return null; }
      })
      .filter(Boolean) as StreamJsonEvent[];
    const total = allEvents.length;
    const events = allEvents.slice(offset, offset + limit);
    return { events, totalEvents: total };
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
