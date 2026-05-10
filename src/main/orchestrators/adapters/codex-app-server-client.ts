import { NdjsonRpcBase, DEFAULT_RPC_TIMEOUT_MS, type BaseRpcOpts } from './ndjson-rpc-base';

export interface CodexAppServerClientOpts extends BaseRpcOpts {
  clientInfo?: { name: string; title: string; version: string };
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
 * - Performs initialization handshake in start()
 */
export class CodexAppServerClient extends NdjsonRpcBase<CodexAppServerClientOpts> {
  protected readonly processLabel = 'Codex app-server';
  protected readonly exitLabel = 'Codex app-server process';
  protected readonly malformedLabel = 'Codex';

  protected override handleUnknownMessage(msg: Record<string, unknown>): void {
    this.log('info', 'Codex message with neither id nor method (ignored)', {
      keys: Object.keys(msg),
    });
  }

  /** Spawn the child process, begin parsing stdout, and complete the init handshake. */
  async start(): Promise<void> {
    this.log('info', 'Spawning Codex app-server process', {
      binary: this.opts.binary,
      args: this.opts.args,
      cwd: this.opts.cwd,
    });

    this.spawnProcess();

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

  protected handleResponse(msg: Record<string, unknown>): void {
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
}
