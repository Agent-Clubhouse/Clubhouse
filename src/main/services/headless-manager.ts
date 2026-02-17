import { spawn as cpSpawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { app, BrowserWindow } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import { JsonlParser, StreamJsonEvent } from './jsonl-parser';
import { parseTranscript, TranscriptSummary } from './transcript-parser';
import { getShellEnvironment } from '../util/shell';
import { appLog } from './log-service';
import { HeadlessOutputKind } from '../orchestrators/types';

interface HeadlessSession {
  process: ChildProcess;
  agentId: string;
  outputKind: HeadlessOutputKind;
  parser: JsonlParser | null;
  transcript: StreamJsonEvent[];
  transcriptPath: string;
  startedAt: number;
  textBuffer?: string;
}

const sessions = new Map<string, HeadlessSession>();

const LOGS_DIR = path.join(app.getPath('userData'), 'agent-logs');

function ensureLogsDir(): void {
  if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  }
}

function getMainWindow(): BrowserWindow | null {
  const windows = BrowserWindow.getAllWindows();
  return windows[0] || null;
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

  const proc = cpSpawn(binary, args, {
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
  let stdoutBytes = 0;
  let stderrChunks: string[] = [];

  const session: HeadlessSession = {
    process: proc,
    agentId,
    outputKind,
    parser,
    transcript,
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
      transcript.push(event);

      // Log first event for diagnostics
      if (transcript.length === 1) {
        appLog('core:headless', 'info', `First JSONL event received`, {
          meta: { agentId, type: event.type },
        });
      }

      // Persist to disk
      logStream.write(JSON.stringify(event) + '\n');

      // Emit hook events to renderer for status tracking
      const hookEvents = mapToHookEvent(event, activeToolBlocks);
      if (hookEvents.length > 0) {
        const win = getMainWindow();
        if (win && !win.isDestroyed()) {
          for (const hookEvent of hookEvents) {
            win.webContents.send(IPC.AGENT.HOOK_EVENT, agentId, hookEvent);
          }
        }
      }
    });
  }

  // Emit initial notification for text mode so HeadlessAgentView shows activity
  if (outputKind === 'text') {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC.AGENT.HOOK_EVENT, agentId, {
        kind: 'notification',
        message: 'Agent running (text output — live events unavailable)',
        timestamp: Date.now(),
      });
    }
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

    // Forward stderr to renderer so headless view can show errors
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC.AGENT.HOOK_EVENT, agentId, {
        kind: 'notification',
        message: msg,
        timestamp: Date.now(),
      });
    }
  });

  proc.on('close', (code) => {
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
      transcript.push(resultEvent);
      logStream.write(JSON.stringify(resultEvent) + '\n');

      const win = getMainWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send(IPC.AGENT.HOOK_EVENT, agentId, {
          kind: 'stop',
          message: session.textBuffer.trim().slice(0, 500),
          timestamp: Date.now(),
        });
      }
    }

    logStream.end();
    sessions.delete(agentId);

    appLog('core:headless', 'info', `Process exited`, {
      meta: { agentId, exitCode: code, stdoutBytes, events: transcript.length, stderr: stderrChunks.join('\n').slice(0, 500) },
    });

    onExit?.(agentId, code ?? 0);

    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC.PTY.EXIT, agentId, code ?? 0);
    }
  });

  proc.on('error', (err) => {
    appLog('core:headless', 'error', `Process error`, { meta: { agentId, error: err.message } });
    logStream.end();
    sessions.delete(agentId);

    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC.PTY.EXIT, agentId, 1);
    }
  });
}

export function kill(agentId: string): void {
  const session = sessions.get(agentId);
  if (!session) return;

  try {
    session.process.kill('SIGTERM');
  } catch { /* already dead */ }

  // Force kill after 5 seconds
  setTimeout(() => {
    if (sessions.has(agentId)) {
      try { session.process.kill('SIGKILL'); } catch { /* dead */ }
      sessions.delete(agentId);
    }
  }, 5000);
}

export function readTranscript(agentId: string): string | null {
  // First check in-memory session
  const session = sessions.get(agentId);
  if (session) {
    return session.transcript.map((e) => JSON.stringify(e)).join('\n');
  }

  // Fall back to disk
  const transcriptPath = path.join(LOGS_DIR, `${agentId}.jsonl`);
  try {
    return fs.readFileSync(transcriptPath, 'utf-8');
  } catch {
    return null;
  }
}

export function getTranscriptSummary(agentId: string): TranscriptSummary | null {
  const session = sessions.get(agentId);
  if (session) {
    return parseTranscript(session.transcript);
  }

  // Fall back to disk
  const transcriptPath = path.join(LOGS_DIR, `${agentId}.jsonl`);
  try {
    const raw = fs.readFileSync(transcriptPath, 'utf-8');
    const events = raw.split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as StreamJsonEvent);
    return parseTranscript(events);
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
