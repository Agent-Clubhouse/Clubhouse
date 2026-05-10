import { NdjsonRpcBase, DEFAULT_RPC_TIMEOUT_MS, type BaseRpcOpts } from './ndjson-rpc-base';

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

export interface AcpClientOpts extends BaseRpcOpts {
  clientInfo?: { name: string; version: string };
}

/**
 * JSON-RPC 2.0 over stdio client for ACP (Agent Client Protocol).
 *
 * Spawns a child process, sends JSON-RPC requests to stdin, and parses
 * NDJSON responses from stdout. Uses a callback-based JSONL parser inline
 * (same buffering pattern as JsonlParser but without EventEmitter).
 */
export class AcpClient extends NdjsonRpcBase<AcpClientOpts> {
  protected readonly processLabel = 'ACP process';
  protected readonly exitLabel = 'ACP process';
  protected readonly malformedLabel = 'ACP';

  /** Spawn the child process, begin parsing stdout, and complete the ACP init handshake. */
  async start(): Promise<void> {
    this.log('info', 'Spawning ACP process', {
      binary: this.opts.binary,
      args: this.opts.args,
      cwd: this.opts.cwd,
    });

    this.spawnProcess();

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
      this.send(msg as unknown as Record<string, unknown>);
    });
  }

  /** Send a JSON-RPC notification (no id, no response expected). */
  notify(method: string, params?: unknown): void {
    const msg: Record<string, unknown> = { jsonrpc: '2.0', method };
    if (params !== undefined) msg.params = params;
    this.send(msg);
  }

  /** Send a JSON-RPC response back to the server (e.g. for permission approvals). */
  respond(id: number | string, result: unknown): void {
    const msg: JsonRpcResponse = { jsonrpc: '2.0', id, result };
    this.send(msg as unknown as Record<string, unknown>);
  }

  protected handleResponse(msg: Record<string, unknown>): void {
    const response = msg as unknown as JsonRpcResponse;
    const pending = this.pending.get(response.id);
    if (!pending) {
      this.log('warn', 'RPC response for unknown request', { id: response.id });
      return;
    }
    this.pending.delete(response.id);

    if (response.error) {
      this.log('error', `RPC error ← id=${response.id}`, {
        code: response.error.code,
        message: response.error.message,
        data: response.error.data,
      });
      const rpcError = new RpcError(
        response.error.code,
        response.error.message,
        response.error.data,
      );
      pending.reject(rpcError);
    } else {
      this.log('info', `RPC response ← id=${response.id}`, {
        resultType: typeof response.result,
      });
      pending.resolve(response.result);
    }
  }
}
