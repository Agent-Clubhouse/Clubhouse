import { spawn, type ChildProcess } from 'child_process';

/** Default timeout for RPC requests (ms). Prevents indefinite hangs on init failures. */
const DEFAULT_RPC_TIMEOUT_MS = 30_000;

export interface CodexAppServerClientOpts {
  binary: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  clientInfo?: { name: string; title: string; version: string };
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
 * JSON-RPC 2.0 client for the Codex app-server protocol.
 *
 * Spawns `codex app-server` as a child process and communicates via
 * newline-delimited JSON over stdin/stdout. Handles the initialization
 * handshake (initialize → initialized) automatically.
 *
 * Key differences from AcpClient:
 * - Omits `jsonrpc: '2.0'` from outgoing messages (Codex convention)
 * - Supports sending notifications (fire-and-forget, no id/response)
 * - Performs initialization handshake in start()
 */
export class CodexAppServerClient {
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<
    number | string,
    { resolve: (result: unknown) => void; reject: (err: Error) => void }
  >();
  private chunks: string[] = [];
  private opts: CodexAppServerClientOpts;
  private killed = false;
  private stderrBuffer: string[] = [];

  constructor(opts: CodexAppServerClientOpts) {
    this.opts = opts;
  }

  private log(level: 'info' | 'warn' | 'error', message: string, meta?: Record<string, unknown>): void {
    this.opts.onLog?.(level, message, meta);
  }

  /** Spawn the child process, begin parsing stdout, and complete the init handshake. */
  async start(): Promise<void> {
    this.log('info', 'Spawning Codex app-server process', {
      binary: this.opts.binary,
      args: this.opts.args,
      cwd: this.opts.cwd,
    });

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
      this.log('warn', 'Codex app-server stderr', { text: chunk.trim() });
    });

    this.proc.on('exit', (code, signal) => {
      this.handleProcessExit(code, signal);
    });

    this.proc.on('error', (err) => {
      this.log('error', 'Codex app-server spawn error', { error: err.message });
      this.rejectAllPending(err);
      this.opts.onExit?.(null, null);
    });

    // Perform initialization handshake
    this.log('info', 'Starting Codex init handshake');
    await this.request('initialize', {
      clientInfo: this.opts.clientInfo ?? {
        name: 'clubhouse',
        title: 'Clubhouse',
        version: '1.0.0',
      },
      capabilities: {},
    });
    this.notify('initialized');
    this.log('info', 'Codex init handshake complete');
  }

  /** Return collected stderr output. */
  getStderr(): string {
    return this.stderrBuffer.join('');
  }

  /** Send a JSON-RPC request and wait for the response. Rejects after the configured timeout. */
  request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    const msg: Record<string, unknown> = { id, method };
    if (params !== undefined) msg.params = params;
    const timeoutMs = this.opts.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;

    this.log('info', `RPC request → ${method}`, { id, method, params });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          const err = new Error(`RPC request '${method}' timed out after ${timeoutMs}ms`);
          this.log('error', `RPC timeout → ${method}`, { id, timeoutMs });
          reject(err);
        }
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (result) => { clearTimeout(timer); resolve(result); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });
      this.send(msg);
    });
  }

  /** Send a JSON-RPC notification (no id, no response expected). */
  notify(method: string, params?: unknown): void {
    const msg: Record<string, unknown> = { method };
    if (params !== undefined) msg.params = params;
    this.send(msg);
  }

  /** Send a JSON-RPC response back to the server (e.g. for approval responses). */
  respond(id: number | string, result: unknown): void {
    this.send({ id, result });
  }

  /** Terminate the child process. */
  kill(): void {
    if (this.killed) return;
    this.killed = true;
    this.flush();
    this.proc?.kill('SIGTERM');
  }

  /** Whether the process is still alive. */
  get alive(): boolean {
    return this.proc !== null && !this.killed && this.proc.exitCode === null;
  }

  // --- Private ---

  private send(msg: Record<string, unknown>): void {
    if (!this.proc?.stdin?.writable) return;
    this.proc.stdin.write(JSON.stringify(msg) + '\n');
  }

  /**
   * NDJSON line-buffered parser (callback-based, same pattern as AcpClient).
   * Accumulates chunks, scans for newlines, and dispatches complete JSON objects.
   */
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
        this.log('warn', 'Malformed JSON line from Codex stdout', {
          line: line.length > 500 ? line.substring(0, 500) + '…' : line,
        });
      }
    }

    const remainder = start < buffer.length ? buffer.substring(start) : '';
    this.chunks = remainder ? [remainder] : [];
  }

  private flush(): void {
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

  private dispatch(msg: Record<string, unknown>): void {
    const hasId = 'id' in msg && msg.id !== undefined;
    const hasMethod = 'method' in msg && typeof msg.method === 'string';

    if (hasId && !hasMethod) {
      // Response to our request
      this.handleResponse(msg);
    } else if (hasId && hasMethod) {
      // Server-initiated request (e.g. approval request)
      this.opts.onServerRequest?.(
        msg.id as number | string,
        msg.method as string,
        msg.params,
      );
    } else if (hasMethod) {
      // Notification
      this.opts.onNotification?.(msg.method as string, msg.params);
    } else {
      // Messages with neither id nor method — log at debug level and ignore
      this.log('info', 'Codex message with neither id nor method (ignored)', {
        keys: Object.keys(msg),
      });
    }
  }

  private handleResponse(msg: Record<string, unknown>): void {
    const id = msg.id as number | string;
    const pending = this.pending.get(id);
    if (!pending) {
      this.log('warn', 'RPC response for unknown request', { id });
      return;
    }
    this.pending.delete(id);

    if (msg.error) {
      const err = msg.error as { code?: number; message?: string; data?: unknown };
      this.log('error', `RPC error ← id=${id}`, {
        code: err.code,
        message: err.message,
        data: err.data,
      });
      pending.reject(
        new Error(`RPC error ${err.code ?? 'unknown'}: ${err.message ?? 'unknown error'}`),
      );
    } else {
      this.log('info', `RPC response ← id=${id}`, {
        resultType: typeof msg.result,
      });
      pending.resolve(msg.result);
    }
  }

  private handleProcessExit(
    code: number | null,
    signal: string | null,
  ): void {
    const stderr = this.getStderr().trim();
    this.log(code === 0 ? 'info' : 'error', 'Codex app-server process exited', {
      code,
      signal,
      pendingRequests: this.pending.size,
      ...(stderr ? { stderr: stderr.length > 2000 ? stderr.substring(0, 2000) + '…' : stderr } : {}),
    });
    this.flush();
    this.rejectAllPending(
      new Error(`Process exited with code ${code}, signal ${signal}`),
    );
    this.opts.onExit?.(code, signal);
  }

  private rejectAllPending(err: Error): void {
    for (const [, { reject }] of this.pending) {
      reject(err);
    }
    this.pending.clear();
  }
}
