import { spawn, type ChildProcess } from 'child_process';

export interface CodexAppServerClientOpts {
  binary: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  clientInfo?: { name: string; title: string; version: string };
  /** Called for notifications (method, no id) */
  onNotification?: (method: string, params: unknown) => void;
  /** Called for server-initiated requests (method + id) */
  onServerRequest?: (id: number | string, method: string, params: unknown) => void;
  /** Called when the process exits */
  onExit?: (code: number | null, signal: string | null) => void;
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

  constructor(opts: CodexAppServerClientOpts) {
    this.opts = opts;
  }

  /** Spawn the child process, begin parsing stdout, and complete the init handshake. */
  async start(): Promise<void> {
    this.proc = spawn(this.opts.binary, this.opts.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: this.opts.cwd,
      env: this.opts.env,
    });

    this.proc.stdout?.setEncoding('utf8');
    this.proc.stdout?.on('data', (chunk: string) => this.feed(chunk));

    this.proc.stderr?.setEncoding('utf8');
    this.proc.stderr?.on('data', () => {
      // Stderr consumed to prevent backpressure; not forwarded
    });

    this.proc.on('exit', (code, signal) => {
      this.handleProcessExit(code, signal);
    });

    this.proc.on('error', (err) => {
      this.rejectAllPending(err);
      this.opts.onExit?.(null, null);
    });

    // Perform initialization handshake
    await this.request('initialize', {
      clientInfo: this.opts.clientInfo ?? {
        name: 'clubhouse',
        title: 'Clubhouse',
        version: '1.0.0',
      },
      capabilities: {},
    });
    this.notify('initialized');
  }

  /** Send a JSON-RPC request and wait for the response. */
  request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    const msg: Record<string, unknown> = { id, method };
    if (params !== undefined) msg.params = params;

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
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
        // Skip malformed lines
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
    }
    // Messages with neither id nor method are silently ignored
  }

  private handleResponse(msg: Record<string, unknown>): void {
    const id = msg.id as number | string;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);

    if (msg.error) {
      const err = msg.error as { code?: number; message?: string };
      pending.reject(
        new Error(`RPC error ${err.code ?? 'unknown'}: ${err.message ?? 'unknown error'}`),
      );
    } else {
      pending.resolve(msg.result);
    }
  }

  private handleProcessExit(
    code: number | null,
    signal: string | null,
  ): void {
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
