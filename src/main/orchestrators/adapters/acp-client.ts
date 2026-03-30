import { spawn, type ChildProcess } from 'child_process';

/** Rich RPC error that preserves error code and optional data from the JSON-RPC response. */
export class RpcError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(`RPC error ${code}: ${message}`);
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
  }
}

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

/** Default timeout for RPC requests (ms). Prevents indefinite hangs on init failures. */
const DEFAULT_RPC_TIMEOUT_MS = 30_000;

export interface AcpClientOpts {
  binary: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  clientInfo?: { name: string; version: string };
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
  private stderrBuffer: string[] = [];

  constructor(opts: AcpClientOpts) {
    this.opts = opts;
  }

  private log(level: 'info' | 'warn' | 'error', message: string, meta?: Record<string, unknown>): void {
    this.opts.onLog?.(level, message, meta);
  }

  /** Spawn the child process, begin parsing stdout, and complete the ACP init handshake. */
  async start(): Promise<void> {
    this.log('info', 'Spawning ACP process', {
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
      this.log('warn', 'ACP process stderr', { text: chunk.trim() });
    });

    this.proc.on('exit', (code, signal) => {
      this.handleProcessExit(code, signal);
    });

    this.proc.on('error', (err) => {
      this.log('error', 'ACP process spawn error', { error: err.message });
      this.rejectAllPending(err);
      this.opts.onExit?.(null, null);
    });

    // Perform ACP initialization handshake
    this.log('info', 'Starting ACP init handshake');
    await this.request('initialize', {
      protocolVersion: 1,
      clientInfo: this.opts.clientInfo ?? { name: 'clubhouse', version: '1.0.0' },
      capabilities: {},
    });
    this.notify('initialized');
    this.log('info', 'ACP init handshake complete');
  }

  /** Return collected stderr output. */
  getStderr(): string {
    return this.stderrBuffer.join('');
  }

  /** Send a JSON-RPC request and wait for the response. Rejects after the configured timeout. */
  request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    const msg: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    const timeoutMs = this.opts.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;

    this.log('info', `RPC request → ${method}`, { id, method, params });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          const err = new RpcError(-32000, `RPC request '${method}' timed out after ${timeoutMs}ms`);
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
    const msg: Record<string, unknown> = { jsonrpc: '2.0', method };
    if (params !== undefined) msg.params = params;
    this.send(msg as unknown as JsonRpcRequest);
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
        this.log('warn', 'Malformed JSON line from ACP stdout', {
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
    } else {
      // Messages with neither id nor method are logged and ignored
      this.log('warn', 'ACP message with neither id nor method', {
        keys: Object.keys(msg),
      });
    }
  }

  private handleResponse(msg: JsonRpcResponse): void {
    const pending = this.pending.get(msg.id);
    if (!pending) {
      this.log('warn', 'RPC response for unknown request', { id: msg.id });
      return;
    }
    this.pending.delete(msg.id);

    if (msg.error) {
      this.log('error', `RPC error ← id=${msg.id}`, {
        code: msg.error.code,
        message: msg.error.message,
        data: msg.error.data,
      });
      const rpcError = new RpcError(
        msg.error.code,
        msg.error.message,
        msg.error.data,
      );
      pending.reject(rpcError);
    } else {
      this.log('info', `RPC response ← id=${msg.id}`, {
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
    this.log(code === 0 ? 'info' : 'error', 'ACP process exited', {
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
