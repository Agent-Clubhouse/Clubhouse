/**
 * JSON-RPC 2.0 peer for ACP, over any message transport. The stdio transport
 * (stdio.ts) spawns the agent; tests connect a scripted agent in memory.
 *
 * ACP is symmetric: the client sends requests (session/prompt) and the agent
 * sends requests back (session/request_permission, elicitation/create). Either
 * side may withdraw a request it sent with `$/cancel_request`; the receiver
 * answers it with error -32800.
 */

import { RpcError } from '../../orchestrators/adapters/rpc-error';
import { ACP_ERROR_CODES, ACP_PROTOCOL_METHODS } from './protocol';

export type JsonRpcId = number | string;

export interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: JsonRpcId | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** How the transport ended. Nothing about the agent's work is implied. */
export interface AcpTransportEnd {
  code: number | null;
  signal: string | null;
  error?: Error;
  /** The agent never started. */
  spawn?: boolean;
}

export interface AcpTransport {
  /** Throws when the message can't be written; it then never reaches the agent. */
  send(message: JsonRpcMessage): void;
  /** Ends the transport; resolves once it has closed. */
  close(): Promise<void>;
}

export interface AcpTransportHandlers {
  onMessage(message: JsonRpcMessage): void;
  onEnd(end: AcpTransportEnd): void;
}

/** Opens a transport to one agent process (or an in-memory agent in tests). */
export type AcpConnector = (handlers: AcpTransportHandlers) => AcpTransport;

/** A request still pending when the transport ended: whether the agent acted on it is unknown. */
export class AcpDisconnectedError extends Error {
  constructor(readonly end: AcpTransportEnd) {
    super(end.error
      ? `ACP transport failed: ${end.error.message}`
      : `ACP agent exited with code ${end.code}, signal ${end.signal}`);
    this.name = 'AcpDisconnectedError';
  }
}

/** A request this side gave up waiting for; `$/cancel_request` was sent for it. */
export class AcpRequestTimeoutError extends Error {
  constructor(readonly method: string, readonly timeoutMs: number) {
    super(`ACP request '${method}' timed out after ${timeoutMs}ms`);
    this.name = 'AcpRequestTimeoutError';
  }
}

export type AcpLog = (level: 'debug' | 'info' | 'warn' | 'error', message: string, meta?: Record<string, unknown>) => void;

/**
 * Handles a request from the agent. `signal` aborts when the agent withdraws
 * it with `$/cancel_request` or the transport ends; the connection then
 * answers -32800 itself and ignores the handler's late result.
 */
export type AcpRequestHandler = (method: string, params: unknown, signal: AbortSignal) => Promise<unknown>;

export interface AcpConnectionOpts {
  onRequest: AcpRequestHandler;
  onNotification(method: string, params: unknown): void;
  onEnd?(end: AcpTransportEnd): void;
  log?: AcpLog;
  /** Default request timeout; `null` per request waits for as long as the turn runs. */
  requestTimeoutMs?: number;
}

export const DEFAULT_ACP_REQUEST_TIMEOUT_MS = 30_000;

interface Pending {
  method: string;
  resolve(result: unknown): void;
  reject(err: Error): void;
  timer?: ReturnType<typeof setTimeout>;
}

export class AcpConnection {
  private readonly transport: AcpTransport;
  private readonly pending = new Map<JsonRpcId, Pending>();
  private readonly incoming = new Map<string, AbortController>();
  private nextId = 1;
  private endInfo: AcpTransportEnd | undefined;
  private readonly log: AcpLog;

  constructor(connect: AcpConnector, private readonly opts: AcpConnectionOpts) {
    this.log = opts.log ?? (() => undefined);
    this.transport = connect({
      onMessage: (message) => this.dispatch(message),
      onEnd: (end) => this.handleEnd(end),
    });
  }

  get ended(): AcpTransportEnd | undefined {
    return this.endInfo;
  }

  /**
   * Send a request. `timeoutMs: null` waits until the agent answers or the
   * transport ends (session/prompt answers only when its turn ends). On a
   * timeout the request is withdrawn with `$/cancel_request`; the agent may
   * still have acted on it. Throws synchronously when the transport can't
   * take the message, so the request was never sent.
   */
  request<T = unknown>(method: string, params: unknown, opts: { timeoutMs?: number | null; signal?: AbortSignal } = {}): Promise<T> {
    if (this.endInfo) return Promise.reject(new AcpDisconnectedError(this.endInfo));
    const id = this.nextId++;
    const timeoutMs = opts.timeoutMs === undefined ? this.opts.requestTimeoutMs ?? DEFAULT_ACP_REQUEST_TIMEOUT_MS : opts.timeoutMs;
    // Method and id only: params carry prompt text and MCP secrets.
    this.log('debug', 'ACP request', { id, method });
    const signal = opts.signal;
    if (signal?.aborted) return Promise.reject(new Error(`ACP request '${method}' aborted`));
    let entry!: Pending;
    const answer = new Promise<T>((resolve, reject) => {
      const onAbort = () => withdraw(new Error(`ACP request '${method}' aborted`));
      const settle = () => {
        if (entry.timer) clearTimeout(entry.timer);
        signal?.removeEventListener('abort', onAbort);
      };
      entry = {
        method,
        resolve: (result) => { settle(); resolve(result as T); },
        reject: (err) => { settle(); reject(err); },
      };
      const withdraw = (err: Error) => {
        if (!this.pending.delete(id)) return;
        this.notify(ACP_PROTOCOL_METHODS.cancelRequest, { requestId: id });
        entry.reject(err);
      };
      if (timeoutMs !== null) entry.timer = setTimeout(() => withdraw(new AcpRequestTimeoutError(method, timeoutMs)), timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, entry);
    });
    try {
      this.transport.send({ jsonrpc: '2.0', id, method, params });
    } catch (err) {
      // Never written: the caller's call fails, and nothing waits for an answer.
      this.pending.delete(id);
      entry.resolve(undefined);
      throw err;
    }
    return answer;
  }

  notify(method: string, params: unknown): void {
    if (this.endInfo) return;
    this.log('debug', 'ACP notification', { method });
    try {
      this.transport.send({ jsonrpc: '2.0', method, params });
    } catch (err) {
      // A notification has no answer to wait for; the transport reports its own end.
      this.log('warn', 'ACP notification not written', { method, error: err instanceof Error ? err.message : String(err) });
    }
  }

  close(): Promise<void> {
    return this.transport.close();
  }

  private dispatch(msg: JsonRpcMessage): void {
    if (this.endInfo) return;
    const hasId = msg.id !== undefined && msg.id !== null;
    if (typeof msg.method === 'string') {
      if (hasId) this.handleRequest(msg.id as JsonRpcId, msg.method, msg.params);
      else this.handleNotification(msg.method, msg.params);
      return;
    }
    if (hasId) {
      this.handleResponse(msg);
      return;
    }
    this.log('warn', 'ACP message with neither id nor method', { keys: Object.keys(msg) });
  }

  private handleResponse(msg: JsonRpcMessage): void {
    const id = msg.id as JsonRpcId;
    const entry = this.pending.get(id);
    if (!entry) {
      // A late answer to a request this side withdrew.
      this.log('debug', 'ACP response for no pending request', { id });
      return;
    }
    this.pending.delete(id);
    if (msg.error) {
      this.log('warn', 'ACP error response', { id, method: entry.method, code: msg.error.code });
      entry.reject(new RpcError(msg.error.code, msg.error.message, msg.error.data));
    } else {
      entry.resolve(msg.result);
    }
  }

  private handleNotification(method: string, params: unknown): void {
    if (method === ACP_PROTOCOL_METHODS.cancelRequest) {
      const requestId = (params as { requestId?: JsonRpcId } | null)?.requestId;
      if (requestId !== undefined) this.incoming.get(key(requestId))?.abort();
      return;
    }
    this.opts.onNotification(method, params);
  }

  private handleRequest(id: JsonRpcId, method: string, params: unknown): void {
    if (this.incoming.has(key(id))) {
      // JSON-RPC ids identify one outstanding request. Any answer to a reused
      // id would read as the first request's, so the duplicate gets none and
      // the first keeps its handler and its withdrawal.
      this.log('warn', 'ACP request reuses an id still in flight; ignored', { method });
      return;
    }
    const controller = new AbortController();
    this.incoming.set(key(id), controller);
    let answered = false;
    const answer = (msg: Omit<JsonRpcMessage, 'jsonrpc' | 'id'>) => {
      if (answered) return;
      answered = true;
      this.incoming.delete(key(id));
      if (this.endInfo) return;
      try {
        this.transport.send({ jsonrpc: '2.0', id, ...msg });
      } catch (err) {
        this.log('warn', 'ACP answer not written', { error: err instanceof Error ? err.message : String(err) });
      }
    };
    controller.signal.addEventListener('abort', () => answer({
      error: { code: ACP_ERROR_CODES.requestCancelled, message: 'Request cancelled' },
    }), { once: true });
    let work: Promise<unknown>;
    try {
      work = this.opts.onRequest(method, params, controller.signal);
    } catch (err) {
      work = Promise.reject(err);
    }
    work.then(
      (result) => answer({ result: result ?? null }),
      (err: unknown) => answer({
        error: err instanceof RpcError
          ? { code: err.code, message: err.message.replace(/^RPC error -?\d+: /, ''), ...(err.data !== undefined && { data: err.data }) }
          : { code: ACP_ERROR_CODES.internalError, message: err instanceof Error ? err.message : String(err) },
      }),
    );
  }

  private handleEnd(end: AcpTransportEnd): void {
    if (this.endInfo) return;
    this.endInfo = end;
    const err = new AcpDisconnectedError(end);
    for (const [, entry] of this.pending) entry.reject(err);
    this.pending.clear();
    for (const [, controller] of this.incoming) controller.abort();
    this.incoming.clear();
    // After a macrotask, so work already settled by answers that arrived
    // before the end (their promise callbacks) runs first.
    setTimeout(() => this.opts.onEnd?.(end), 0);
  }
}

/** JSON-RPC ids compare by value and type: 1 and "1" are different requests. */
function key(id: JsonRpcId): string {
  return `${typeof id}:${id}`;
}
