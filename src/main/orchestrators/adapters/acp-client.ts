import { spawn, type ChildProcess } from 'child_process';

/** JSON-RPC 2.0 message types */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

/** A server-initiated request (has both id and method) */
export interface JsonRpcServerRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
}

export type JsonRpcMessage =
  | JsonRpcResponse
  | JsonRpcNotification
  | JsonRpcServerRequest;

export interface AcpClientOpts {
  binary: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** Called for notifications (method, no id) */
  onNotification?: (method: string, params: unknown) => void;
  /** Called for server-initiated requests (method + id) */
  onServerRequest?: (id: number | string, method: string, params: unknown) => void;
  /** Called when the process exits */
  onExit?: (code: number | null, signal: string | null) => void;
}

/**
 * JSON-RPC 2.0 over stdio client for ACP (Agent Client Protocol).
 *
 * Spawns a child process, sends JSON-RPC requests to stdin, and parses
 * NDJSON responses from stdout. Uses a callback-based JSONL parser inline
 * (same buffering pattern as JsonlParser but without EventEmitter).
 */
export class AcpClient {
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<
    number | string,
    { resolve: (result: unknown) => void; reject: (err: Error) => void }
  >();
  private chunks: string[] = [];
  private opts: AcpClientOpts;
  private killed = false;

  constructor(opts: AcpClientOpts) {
    this.opts = opts;
  }

  /** Spawn the child process and begin parsing stdout. */
  start(): void {
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
  }

  /** Send a JSON-RPC request and wait for the response. */
  request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    const msg: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send(msg);
    });
  }

  /** Send a JSON-RPC response back to the server (e.g. for permission approvals). */
  respond(id: number | string, result: unknown): void {
    const msg: JsonRpcResponse = { jsonrpc: '2.0', id, result };
    this.send(msg);
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

  private send(msg: JsonRpcRequest | JsonRpcResponse): void {
    if (!this.proc?.stdin?.writable) return;
    this.proc.stdin.write(JSON.stringify(msg) + '\n');
  }

  /**
   * NDJSON line-buffered parser (callback-based, same pattern as JsonlParser).
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
      this.handleResponse(msg as unknown as JsonRpcResponse);
    } else if (hasId && hasMethod) {
      // Server-initiated request (e.g. permission_request)
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

  private handleResponse(msg: JsonRpcResponse): void {
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);

    if (msg.error) {
      pending.reject(
        new Error(`RPC error ${msg.error.code}: ${msg.error.message}`),
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
