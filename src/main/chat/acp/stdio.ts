/**
 * ACP over stdio: newline-delimited JSON-RPC on the agent's stdin/stdout
 * (https://agentclientprotocol.com/protocol/v1/transports). The launch command
 * comes from the provider's AcpLaunchSpec; nothing here knows which agent runs.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { LogRedactor } from '../../../shared/log-redaction';
import { cleanInheritedEnv, cleanSpawnEnv } from '../../util/shell';
import { killStructuredChild, type StructuredSpawnCommand } from '../../orchestrators/adapters/structured-spawn';
import type { AcpConnector, AcpLog, JsonRpcMessage } from './connection';

/** A line longer than this ends the session (it may have been an answer a turn waits for). */
export const MAX_ACP_LINE_CHARS = 32 * 1024 * 1024;
/** Stderr kept for diagnostics, from the end. */
const STDERR_TAIL_CHARS = 8 * 1024;
/** How long close() waits after SIGTERM before SIGKILL. */
const KILL_GRACE_MS = 5_000;

export interface AcpStdioOpts {
  command: StructuredSpawnCommand;
  cwd?: string;
  /** The agent's whole environment; Clubhouse's own is used (cleaned) when absent. */
  env?: Record<string, string>;
  log?: AcpLog;
  /** Called with the tail of stderr when the process ends, for an error message. */
  onStderrTail?(tail: string): void;
}

export function stdioConnector(opts: AcpStdioOpts): AcpConnector {
  return ({ onMessage, onEnd }) => {
    const log = opts.log ?? (() => undefined);
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(opts.command.binary, opts.command.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: opts.cwd,
        // Never hand the agent a host session's markers or an inherited agent nonce.
        env: cleanSpawnEnv({ ...(opts.env ?? cleanInheritedEnv({ ...process.env })) }),
        windowsHide: true,
        ...(opts.command.windowsVerbatimArguments && { windowsVerbatimArguments: true }),
      });
    } catch (err) {
      // spawn can throw synchronously (EINVAL on Windows): report it as the transport ending.
      const error = err instanceof Error ? err : new Error(String(err));
      log('error', 'ACP agent spawn error', { error: error.message });
      queueMicrotask(() => onEnd({ code: null, signal: null, error }));
      return { send() { /* never started */ }, async close() { /* nothing to stop */ } };
    }
    const redactor = new LogRedactor(opts.command.args).startRun();

    let ended = false;
    let spawnFailed = false;
    let buffer = '';
    let dropping = false;
    let stderrTail = '';
    const exited = new Promise<void>((resolve) => child.once('close', () => resolve()));

    const end = (code: number | null, signal: string | null, error?: Error) => {
      if (ended) return;
      ended = true;
      redactor.endRun();
      if (stderrTail.trim()) opts.onStderrTail?.(stderrTail);
      onEnd({ code, signal, ...(error && { error }) });
    };

    const handleLine = (line: string) => {
      const text = line.trim();
      if (!text) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        log('warn', 'Malformed JSON line from ACP agent', { length: text.length });
        return;
      }
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) onMessage(parsed as JsonRpcMessage);
      else log('warn', 'ACP line is not a JSON-RPC object', { length: text.length });
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (ended) return;
      let start = 0;
      let idx: number;
      while ((idx = chunk.indexOf('\n', start)) !== -1) {
        const piece = chunk.slice(start, idx);
        start = idx + 1;
        handleLine(buffer + piece);
        buffer = '';
      }
      buffer += chunk.slice(start);
      if (buffer.length > MAX_ACP_LINE_CHARS) {
        // The dropped line may have been the answer a turn waits for, so the
        // session can't go on: end it rather than hang.
        log('error', 'ACP line over the size limit; ending the session', { limit: MAX_ACP_LINE_CHARS });
        buffer = '';
        dropping = true;
        end(null, null, new Error(`ACP agent sent a line over ${MAX_ACP_LINE_CHARS} characters`));
        void killStructuredChild(child);
      }
    });

    const stderrLog = redactor.stream();
    const logStderr = (text: string) => { if (text.trim()) log('warn', 'ACP agent stderr', { text: text.trim() }); };
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
      logStderr(stderrLog.feed(chunk));
    });

    child.on('error', (err) => {
      spawnFailed = true;
      log('error', 'ACP agent spawn error', { error: err.message });
      end(null, null, err);
    });
    child.on('close', (code, signal) => {
      logStderr(stderrLog.flush());
      if (buffer.trim() && !dropping && !ended) handleLine(buffer);
      buffer = '';
      log(code === 0 ? 'info' : 'warn', 'ACP agent exited', { code, signal });
      end(code, signal);
    });
    child.stdin.on('error', (err) => log('warn', 'ACP agent stdin error', { error: err.message }));

    return {
      send(message: JsonRpcMessage) {
        if (ended || !child.stdin.writable) return;
        child.stdin.write(`${JSON.stringify(message)}\n`);
      },
      async close() {
        if (spawnFailed || child.exitCode !== null || child.signalCode !== null) return;
        await killStructuredChild(child);
        const timer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }, KILL_GRACE_MS);
        await exited;
        clearTimeout(timer);
      },
    };
  };
}
