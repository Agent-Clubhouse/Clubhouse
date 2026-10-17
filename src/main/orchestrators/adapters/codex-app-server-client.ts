import { NdjsonRpcBase, DEFAULT_RPC_TIMEOUT_MS, type BaseRpcOpts, type RpcRequestOptions } from './ndjson-rpc-base';
import { RpcError } from './acp-client';
import {
  isKnownNotificationMethod,
  isKnownServerRequestMethod,
  type ClientInfo,
  type CodexClientRequestMethod,
  type CodexRequestParams,
  type CodexResponse,
  type CodexServerRequestMethod,
  type CodexServerRequestResult,
  type CodexUnrecognizedMessage,
  type CommandExecutionApprovalDecision,
  type FileChangeApprovalDecision,
  type InitializeResponse,
  type RateLimitSnapshot,
  type RequestId,
  type ServerNotification,
  type ServerRequest,
  type ThreadListParams,
  type ThreadReadParams,
  type ThreadResumeParams,
  type ThreadStartParams,
  type TurnStartParams,
  type UserInput,
} from './codex-protocol';

/** JSON-RPC error codes Clubhouse sends back for server requests it can't serve. */
export const CODEX_RPC_METHOD_NOT_FOUND = -32601;
export const CODEX_RPC_INTERNAL_ERROR = -32603;

export interface CodexAppServerClientOpts
  extends Omit<BaseRpcOpts, 'onNotification' | 'onServerRequest'> {
  clientInfo?: ClientInfo;
  /** Opt into experimental methods and fields (`initialize.capabilities.experimentalApi`). */
  experimentalApi?: boolean;
  /** Notification methods the server should not send on this connection. */
  optOutNotificationMethods?: string[];
  /** A notification whose method the vendored schema knows. */
  onCodexNotification?: (notification: ServerNotification) => void;
  /**
   * A server request whose method the vendored schema knows. Codex blocks the
   * turn until it is answered with respondToServerRequest (or one of the
   * approval helpers). With no handler, the client answers with an error, and
   * a handler that throws or rejects while the request is still open gets an
   * internal-error reply, so a broken handler can't hang the turn.
   */
  onCodexServerRequest?: (request: ServerRequest) => void | Promise<void>;
  /**
   * A message the vendored schema has no type for — usually a method from a
   * newer Codex. Unknown server requests have already been answered with
   * "method not found" when this fires, so the turn is never left blocked.
   */
  onUnrecognizedMessage?: (message: CodexUnrecognizedMessage) => void;
}

/**
 * Params as they may be logged. `config` (thread/start, thread/resume) holds
 * the MCP servers' env, HTTP headers and token variable names, so it never
 * reaches the app log; its keys are kept so the log still shows what was set.
 */
export function redactForLog(params: unknown): unknown {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return params;
  const p = params as Record<string, unknown>;
  if (!p.config || typeof p.config !== 'object') return params;
  return { ...p, config: { redacted: Object.keys(p.config as Record<string, unknown>) } };
}

/** A text `UserInput` for turn/start and turn/steer. */
export function textInput(text: string): UserInput {
  return { type: 'text', text, text_elements: [] };
}

/**
 * Typed JSON-RPC client for `codex app-server` (protocol v2), on the bindings
 * vendored in ./codex-protocol/generated.
 *
 * Spawns the app-server as a child process and speaks newline-delimited JSON
 * over stdio. Codex omits the `jsonrpc: '2.0'` field in both directions.
 *
 * This is a thin protocol layer: it types requests, notifications and server
 * requests, tracks each thread's active turn (needed by turn/steer and
 * turn/interrupt), and tolerates anything the pinned schema doesn't know by
 * logging and surfacing it. Mapping to Clubhouse's chat events lives above it.
 */
export class CodexAppServerClient extends NdjsonRpcBase<CodexAppServerClientOpts> {
  protected readonly processLabel = 'Codex app-server';
  protected readonly exitLabel = 'Codex app-server process';
  protected readonly malformedLabel = 'Codex';

  private initializeResult: InitializeResponse | null = null;
  private readonly activeTurns = new Map<string, string>();
  /** Last completed turn per thread, so a late turn/start reply can't revive it. */
  private readonly completedTurns = new Map<string, string>();
  private readonly openServerRequests = new Map<RequestId, CodexServerRequestMethod>();

  /** The server's `initialize` result, once start() has resolved. */
  get serverInfo(): InitializeResponse | null {
    return this.initializeResult;
  }

  /** The in-progress turn on a thread, per turn/started and turn/completed. */
  getActiveTurnId(threadId: string): string | undefined {
    return this.activeTurns.get(threadId);
  }

  /** Server requests that are still waiting on an answer from this client. */
  getOpenServerRequests(): ReadonlyMap<RequestId, CodexServerRequestMethod> {
    return this.openServerRequests;
  }

  /** Spawn the child process, begin parsing stdout, and complete the init handshake. */
  async start(): Promise<InitializeResponse> {
    this.log('info', 'Spawning Codex app-server process', {
      binary: this.opts.binary,
      args: this.opts.args,
      cwd: this.opts.cwd,
    });

    this.spawnProcess();

    this.log('info', 'Starting Codex init handshake');
    const result = await this.request('initialize', {
      clientInfo: this.opts.clientInfo ?? {
        name: 'clubhouse',
        title: 'Clubhouse',
        version: '1.0.0',
      },
      capabilities: {
        experimentalApi: this.opts.experimentalApi ?? false,
        requestAttestation: false,
        ...(this.opts.optOutNotificationMethods && {
          optOutNotificationMethods: this.opts.optOutNotificationMethods,
        }),
      },
    });
    this.initializeResult = result;
    this.notify('initialized');
    this.log('info', 'Codex init handshake complete', {
      userAgent: result?.userAgent,
      platformOs: result?.platformOs,
    });
    return result;
  }

  // ── Typed requests ──────────────────────────────────────────────────────

  threadStart(params: ThreadStartParams) {
    return this.request('thread/start', params);
  }

  threadResume(params: ThreadResumeParams) {
    return this.request('thread/resume', params);
  }

  threadList(params: ThreadListParams = {}) {
    return this.request('thread/list', params);
  }

  threadRead(params: ThreadReadParams) {
    return this.request('thread/read', params);
  }

  /**
   * Start a turn. The reply already carries the new turn, so it becomes the
   * thread's active turn here rather than waiting for turn/started; until then
   * a steer would start a second turn and an interrupt would find nothing.
   */
  async turnStart(params: TurnStartParams) {
    const result = await this.request('turn/start', params);
    const turn = result?.turn;
    if (turn?.status === 'inProgress' && this.completedTurns.get(params.threadId) !== turn.id) {
      this.activeTurns.set(params.threadId, turn.id);
    }
    return result;
  }

  /**
   * Add input to the thread's in-progress turn. Codex rejects the steer when
   * `expectedTurnId` isn't the active turn; it defaults to the tracked one.
   */
  turnSteer(threadId: string, input: UserInput[], expectedTurnId = this.activeTurns.get(threadId)) {
    if (!expectedTurnId) {
      return Promise.reject(new Error(`No active Codex turn to steer on thread ${threadId}`));
    }
    return this.request('turn/steer', { threadId, input, expectedTurnId });
  }

  /** Interrupt a turn; defaults to the thread's tracked active turn. */
  turnInterrupt(threadId: string, turnId = this.activeTurns.get(threadId)) {
    if (!turnId) {
      return Promise.reject(new Error(`No active Codex turn to interrupt on thread ${threadId}`));
    }
    return this.request('turn/interrupt', { threadId, turnId });
  }

  async readRateLimits(): Promise<RateLimitSnapshot> {
    const result = await this.request('account/rateLimits/read', undefined);
    return result.rateLimits;
  }

  /**
   * Send a typed client request and wait for its result. Methods outside
   * CodexResponseMap resolve to `unknown`; requestRaw covers methods the
   * vendored schema doesn't have (experimental or newer than the pin).
   */
  request<M extends CodexClientRequestMethod>(
    method: M,
    params: CodexRequestParams<M>,
    options?: RpcRequestOptions,
  ): Promise<CodexResponse<M>> {
    return this.requestRaw(method, params, options) as Promise<CodexResponse<M>>;
  }

  /** Send an untyped request. Rejects with RpcError on an error response, or after the timeout. */
  requestRaw(method: string, params?: unknown, options?: RpcRequestOptions): Promise<unknown> {
    const id = this.nextId++;
    const msg: Record<string, unknown> = { id, method };
    if (params !== undefined) msg.params = params;
    const timeoutMs = options?.timeoutMs === undefined
      ? (this.opts.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS)
      : options.timeoutMs;

    this.log('info', `RPC request → ${method}`, { id, method, params: redactForLog(params) });

    return new Promise((resolve, reject) => {
      const timer = timeoutMs === null ? null : setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          this.log('error', `RPC timeout → ${method}`, { id, timeoutMs });
          reject(new Error(`RPC request '${method}' timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (result) => { if (timer) clearTimeout(timer); resolve(result); },
        reject: (err) => { if (timer) clearTimeout(timer); reject(err); },
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

  // ── Answering server requests ───────────────────────────────────────────

  /** Answer a server request with the result type its method expects. */
  respondToServerRequest<M extends CodexServerRequestMethod>(
    id: RequestId,
    method: M,
    result: CodexServerRequestResult<M>,
  ): void {
    const open = this.openServerRequests.get(id);
    if (open && open !== method) {
      this.log('warn', 'Codex server request answered as a different method', { id, open, method });
    }
    this.respond(id, result);
  }

  respondToCommandApproval(id: RequestId, decision: CommandExecutionApprovalDecision): void {
    this.respondToServerRequest(id, 'item/commandExecution/requestApproval', { decision });
  }

  respondToFileChangeApproval(id: RequestId, decision: FileChangeApprovalDecision): void {
    this.respondToServerRequest(id, 'item/fileChange/requestApproval', { decision });
  }

  /** Send a raw JSON-RPC result for a server request. */
  respond(id: RequestId, result: unknown): void {
    if (!this.openServerRequests.delete(id)) {
      this.log('warn', 'Answering a Codex server request that is not open', { id });
    }
    this.send({ id, result });
  }

  /**
   * Send a JSON-RPC error back to the server.
   *
   * Every server-initiated request must be answered. Codex blocks the turn
   * waiting for a reply, so an unanswered request stalls the session with
   * nothing surfaced to the user — far worse than an explicit rejection,
   * which Codex can report and recover from.
   */
  respondWithError(id: RequestId, code: number, message: string): void {
    this.openServerRequests.delete(id);
    this.log('warn', `RPC error response → id=${id}`, { code, message });
    this.send({ id, error: { code, message } });
  }

  // ── Inbound dispatch ────────────────────────────────────────────────────

  protected override dispatch(msg: Record<string, unknown>): void {
    const hasId = 'id' in msg && (typeof msg.id === 'number' || typeof msg.id === 'string');
    const hasMethod = typeof msg.method === 'string';

    if (hasId && !hasMethod) {
      this.handleResponse(msg);
    } else if (hasId && hasMethod) {
      this.handleServerRequest(msg.id as RequestId, msg.method as string, msg.params);
    } else if (hasMethod) {
      this.handleNotification(msg.method as string, msg.params);
    } else {
      this.handleUnknownMessage(msg);
    }
  }

  private handleNotification(method: string, params: unknown): void {
    if (!isKnownNotificationMethod(method)) {
      this.log('warn', 'Unrecognized Codex notification', { method });
      this.surfaceUnrecognized({ kind: 'notification', method, params });
      return;
    }
    const notification = { method, params } as ServerNotification;
    this.trackNotification(notification);
    this.invokeHandler('onCodexNotification', () => this.opts.onCodexNotification?.(notification));
  }

  private trackNotification(notification: ServerNotification): void {
    switch (notification.method) {
      case 'turn/started':
        if (notification.params?.turn?.id) {
          this.activeTurns.set(notification.params.threadId, notification.params.turn.id);
        }
        break;
      case 'turn/completed':
        if (notification.params?.turn?.id) {
          this.completedTurns.set(notification.params.threadId, notification.params.turn.id);
        }
        if (this.activeTurns.get(notification.params?.threadId) === notification.params?.turn?.id) {
          this.activeTurns.delete(notification.params.threadId);
        }
        break;
      case 'serverRequest/resolved':
        // Codex withdrew the request itself (the turn ended or was interrupted).
        this.openServerRequests.delete(notification.params?.requestId);
        break;
      default:
        break;
    }
  }

  private handleServerRequest(id: RequestId, method: string, params: unknown): void {
    if (!isKnownServerRequestMethod(method)) {
      this.log('warn', 'Unrecognized Codex server request; answering method-not-found', { id, method });
      this.send({ id, error: { code: CODEX_RPC_METHOD_NOT_FOUND, message: `Clubhouse does not support '${method}'` } });
      this.surfaceUnrecognized({ kind: 'request', id, method, params });
      return;
    }

    this.openServerRequests.set(id, method);
    const handler = this.opts.onCodexServerRequest;
    if (!handler) {
      this.respondWithError(id, CODEX_RPC_METHOD_NOT_FOUND, `No handler for '${method}'`);
      return;
    }
    const request = { id, method, params } as ServerRequest;
    const failIfOpen = () => {
      if (this.openServerRequests.has(id)) {
        this.respondWithError(id, CODEX_RPC_INTERNAL_ERROR, `Clubhouse failed to handle '${method}'`);
      }
    };
    let returned: void | Promise<void> = undefined;
    const ok = this.invokeHandler('onCodexServerRequest', () => { returned = handler(request); });
    if (!ok) {
      failIfOpen();
    } else if (returned && typeof (returned as Promise<void>).then === 'function') {
      (returned as Promise<void>).then(undefined, (err: unknown) => {
        this.log('error', 'Codex onCodexServerRequest handler rejected', {
          error: err instanceof Error ? err.message : String(err),
        });
        failIfOpen();
      });
    }
  }

  protected override handleUnknownMessage(msg: Record<string, unknown>): void {
    this.log('warn', 'Codex message with neither id nor method', { keys: Object.keys(msg) });
    this.surfaceUnrecognized({ kind: 'other', message: msg });
  }

  private surfaceUnrecognized(message: CodexUnrecognizedMessage): void {
    this.invokeHandler('onUnrecognizedMessage', () => this.opts.onUnrecognizedMessage?.(message));
  }

  /** Run a consumer callback so a throwing handler can't break stdout parsing. */
  private invokeHandler(name: string, fn: () => void): boolean {
    try {
      fn();
      return true;
    } catch (err) {
      this.log('error', `Codex ${name} handler threw`, {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  protected handleResponse(msg: Record<string, unknown>): void {
    const id = msg.id as RequestId;
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
      pending.reject(new RpcError(err.code ?? -1, err.message ?? 'unknown error', err.data));
    } else {
      this.log('info', `RPC response ← id=${id}`, { resultType: typeof msg.result });
      pending.resolve(msg.result);
    }
  }

  protected override handleProcessExit(code: number | null, signal: string | null): void {
    super.handleProcessExit(code, signal);
    // After super, which flushes buffered stdout that could otherwise
    // repopulate these.
    this.activeTurns.clear();
    this.completedTurns.clear();
    this.openServerRequests.clear();
  }
}
