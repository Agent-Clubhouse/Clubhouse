import { spawn, type ChildProcess } from 'child_process';

/** Default RPC request timeout (ms). Prevents indefinite hangs on init failures. */
export const DEFAULT_RPC_TIMEOUT_MS = 30_000;

export interface BaseRpcOpts {
  binary: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** RPC request timeout in milliseconds (default: 30000) */
  rpcTimeoutMs?: number;
  /** Called for notifications (method, no id) */
  onNotification?: (method: string, params: unknown) => void;
  /** Called for server-initiated requests (method + id) */
  onServerRequest?: (id: number | string, method: string, params: unknown) => void;
  /** Called when the process exits */
  onExit?: (code: number | null, signal: string | null) => void;
  /** Optional logger for diagnostic messages */
  onLog?: (level: 'info' | 'warn' | 'error', message: string, meta?: Record<string, unknown>) => void;
}

/**
 * Shared base for JSON-RPC-over-stdio clients that communicate via NDJSON.
 *
 * Provides: process lifecycle, NDJSON line-buffered parsing, request/response
 * dispatching, pending-map management, and cleanup. Subclasses supply the
 * protocol-specific message formatting and initialization handshake.
 *
 * Log strings are parameterized via three abstract label properties so that
 * each subclass can preserve its exact existing log output.
 */
export abstract class NdjsonRpcBase<TOpts extends BaseRpcOpts> {
  protected proc: ChildProcess | null = null;
  protected nextId = 1;
  protected pending = new Map<
    number | string,
    { resolve: (result: unknown) => void; reject: (err: Error) => void }
  >();
  protected opts: TOpts;
  protected killed = false;
  protected stderrBuffer: string[] = [];
  private chunks: string[] = [];

  /**
   * Label used in stderr and spawn-error log messages.
   * e.g. 'ACP process' → "ACP process stderr"
   */
  protected abstract readonly processLabel: string;

  /**
   * Label used in process-exit log messages.
   * e.g. 'ACP process' → "ACP process exited"
   */
  protected abstract readonly exitLabel: string;

  /**
   * Label used in malformed-JSON log messages.
   * e.g. 'ACP' → "Malformed JSON line from ACP stdout"
   */
  protected abstract readonly malformedLabel: string;

  constructor(opts: TOpts) {
    this.opts = opts;
  }

  protected log(level: 'info' | 'warn' | 'error', message: string, meta?: Record<string, unknown>): void {
    this.opts.onLog?.(level, message, meta);
  }

  getStderr(): string {
    return this.stderrBuffer.join('');
  }

  kill(): void {
    if (this.killed) return;
    this.killed = true;
    this.flush();
    this.proc?.kill('SIGTERM');
  }

  get alive(): boolean {
    return this.proc !== null && !this.killed && this.proc.exitCode === null;
  }

  protected spawnProcess(): void {
    this.proc = spawn(this.opts.binary, this.opts.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: this.opts.cwd,
      env: this.opts.env,
    });

    this.proc.stdout?.setEncoding('utf8');
    this.proc.stdout?.on('data', (chunk: string) => this.feed(chunk));

    this.proc.stderr?.setEncoding('utf8');
    this.proc.stderr?.on('data', (chunk: string) => {
      this.stderrBuffer.push(chunk);
      this.log('warn', `${this.processLabel} stderr`, { text: chunk.trim() });
    });

    this.proc.on('exit', (code, signal) => this.handleProcessExit(code, signal));
    this.proc.on('error', (err) => {
      this.log('error', `${this.processLabel} spawn error`, { error: err.message });
      this.rejectAllPending(err);
      this.opts.onExit?.(null, null);
    });
  }

  protected send(msg: Record<string, unknown>): void {
    if (!this.proc?.stdin?.writable) return;
    this.proc.stdin.write(JSON.stringify(msg) + '\n');
  }

  private feed(chunk: string): void {
    this.chunks.push(chunk);

    if (chunk.indexOf('\n') === -1) return;

    const buffer = this.chunks.join('');
    let start = 0;
    let idx: number;

    while ((idx = buffer.indexOf('\n', start)) !== -1) {
      const line = buffer.substring(start, idx).trim();
      start = idx + 1;
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        this.dispatch(parsed);
      } catch {
        this.log('warn', `Malformed JSON line from ${this.malformedLabel} stdout`, {
          line: line.length > 500 ? line.substring(0, 500) + '…' : line,
        });
      }
    }

    const remainder = start < buffer.length ? buffer.substring(start) : '';
    this.chunks = remainder ? [remainder] : [];
  }

  protected flush(): void {
    const buffer = this.chunks.join('').trim();
    if (buffer) {
      try {
        const parsed = JSON.parse(buffer);
        this.dispatch(parsed);
      } catch {
        // Skip
      }
    }
    this.chunks = [];
  }

  protected dispatch(msg: Record<string, unknown>): void {
    const hasId = 'id' in msg && msg.id !== undefined;
    const hasMethod = 'method' in msg && typeof msg.method === 'string';

    if (hasId && !hasMethod) {
      this.handleResponse(msg);
    } else if (hasId && hasMethod) {
      this.opts.onServerRequest?.(
        msg.id as number | string,
        msg.method as string,
        msg.params,
      );
    } else if (hasMethod) {
      this.opts.onNotification?.(msg.method as string, msg.params);
    } else {
      this.handleUnknownMessage(msg);
    }
  }

  /** Called for messages that have neither an `id` nor a `method`. Override to customize. */
  protected handleUnknownMessage(msg: Record<string, unknown>): void {
    this.log('warn', `${this.processLabel} message with neither id nor method`, {
      keys: Object.keys(msg),
    });
  }

  protected abstract handleResponse(msg: Record<string, unknown>): void;

  protected handleProcessExit(code: number | null, signal: string | null): void {
    const stderr = this.getStderr().trim();
    this.log(code === 0 ? 'info' : 'error', `${this.exitLabel} exited`, {
      code,
      signal,
      pendingRequests: this.pending.size,
      ...(stderr ? { stderr: stderr.length > 2000 ? stderr.substring(0, 2000) + '…' : stderr } : {}),
    });
    this.flush();
    this.rejectAllPending(new Error(`Process exited with code ${code}, signal ${signal}`));
    this.opts.onExit?.(code, signal);
  }

  protected rejectAllPending(err: Error): void {
    for (const [, { reject }] of this.pending) {
      reject(err);
    }
    this.pending.clear();
  }

  abstract request(method: string, params?: unknown): Promise<unknown>;
  abstract notify(method: string, params?: unknown): void;
  abstract respond(id: number | string, result: unknown): void;
  abstract start(): Promise<void>;
}
