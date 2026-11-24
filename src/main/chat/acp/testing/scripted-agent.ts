/**
 * A scripted, in-memory ACP agent for tests: no process, no model, no tokens.
 *
 * Its messages are hand-built from the public ACP v1 schema (../schema), not
 * recorded from any real agent, and it has no provider's behaviour. Tests
 * drive it step by step: wait for a prompt, stream updates, ask for
 * permission, answer the prompt, or drop the connection.
 */

import type { AcpConnector, AcpTransportEnd, JsonRpcId, JsonRpcMessage } from '../connection';
import {
  ACP_AGENT_METHODS,
  ACP_CLIENT_METHODS,
  ACP_ERROR_CODES,
  ACP_PROTOCOL_METHODS,
  type ContentBlock,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
  type InitializeResponse,
  type PermissionOption,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SessionUpdate,
  type StopReason,
  type ToolCallFields,
} from '../protocol';

export interface ScriptedAgentOptions {
  initialize?: InitializeResponse;
  /** Conversations the agent can reopen; `session/load` replays their updates first. */
  sessions?: Record<string, SessionUpdate[]>;
  configOptions?: SessionConfigOption[];
  /** Answer `session/new` with this error instead. */
  newSessionError?: { code: number; message: string };
  /** Updates sent for a new session before `session/new` is answered. */
  beforeNewReply?: SessionUpdate[];
}

export interface ScriptedPrompt {
  sessionId: string;
  prompt: ContentBlock[];
  /** Answer the prompt: the turn ends with this stop reason. */
  end(stopReason: StopReason | string): void;
  /** Answer the prompt with an error. */
  fail(code: number, message: string): void;
}

export const BASIC_PERMISSION_OPTIONS: PermissionOption[] = [
  { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
  { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
];

type Waiter<T> = { resolve(value: T): void };

export class ScriptedAcpAgent {
  /** Every request and notification the client sent, in order. Bounded by the test's script. */
  readonly received: Array<{ method: string; params: unknown }> = [];
  readonly connector: AcpConnector;
  /** Number of times a client connected. */
  connections = 0;
  /** session/prompt requests the client wrote, counted at the write (before delivery). */
  promptsWritten = 0;
  /** Ids of this agent's requests to the client, in the order sent. */
  readonly clientRequestIds: JsonRpcId[] = [];
  /** Results (not errors) the client sent back for this agent's requests. */
  answers = 0;
  private rejectPromptWrite = false;

  private client: { onMessage(m: JsonRpcMessage): void; onEnd(e: AcpTransportEnd): void } | undefined;
  private open = false;
  private nextSession = 1;
  private nextId = 1;
  private readonly sessions: Record<string, SessionUpdate[]>;
  private configOptions: SessionConfigOption[];
  private readonly prompts: ScriptedPrompt[] = [];
  private readonly promptWaiters: Array<Waiter<ScriptedPrompt>> = [];
  private readonly outgoing = new Map<JsonRpcId, Waiter<JsonRpcMessage>>();
  private readonly cancelWaiters: Array<() => void> = [];
  private nextPromptError: { code: number; message: string } | undefined;

  constructor(private readonly opts: ScriptedAgentOptions = {}) {
    this.sessions = { ...opts.sessions };
    this.configOptions = opts.configOptions ?? [];
    this.connector = (handlers) => {
      this.connections++;
      this.client = handlers;
      this.open = true;
      return {
        send: (message) => {
          if (message.method === ACP_AGENT_METHODS.sessionPrompt) {
            if (this.rejectPromptWrite) {
              // The pipe refuses the write: nothing reaches the agent.
              this.rejectPromptWrite = false;
              throw new Error('Scripted transport refused the write');
            }
            this.promptsWritten++;
          }
          // Deliver on a later tick, as a pipe would.
          queueMicrotask(() => { if (this.open) this.receive(message); });
        },
        close: async () => this.disconnect({ code: 0, signal: null }),
      };
    };
  }

  /** The next prompt the client sends (or one already waiting). */
  nextPrompt(): Promise<ScriptedPrompt> {
    const ready = this.prompts.shift();
    if (ready) return Promise.resolve(ready);
    return new Promise((resolve) => this.promptWaiters.push({ resolve }));
  }

  /** The transport refuses the next `session/prompt` write, so it never reaches the agent. */
  refuseNextPromptWrite(): void {
    this.rejectPromptWrite = true;
  }

  /** Answer the next `session/prompt` with this JSON-RPC error as soon as it arrives. */
  failNextPrompt(code: number, message: string): void {
    this.nextPromptError = { code, message };
  }

  /** Resolves when the client sends `session/cancel`. */
  cancelled(): Promise<void> {
    return new Promise((resolve) => this.cancelWaiters.push(resolve));
  }

  update(sessionId: string, update: SessionUpdate | { sessionUpdate: string; [k: string]: unknown }): void {
    this.toClient({ jsonrpc: '2.0', method: ACP_CLIENT_METHODS.sessionUpdate, params: { sessionId, update } });
  }

  /** Ask the client; `id` lets the test withdraw it with `withdraw(id)`. */
  requestPermission(sessionId: string, toolCall: ToolCallFields, options = BASIC_PERMISSION_OPTIONS): { id: JsonRpcId; response: Promise<JsonRpcMessage> } {
    return this.requestClient(ACP_CLIENT_METHODS.sessionRequestPermission, { sessionId, toolCall, options });
  }

  elicit(req: CreateElicitationRequest): { id: JsonRpcId; response: Promise<JsonRpcMessage> } {
    return this.requestClient(ACP_CLIENT_METHODS.elicitationCreate, req);
  }

  /** Send the client any request (e.g. one it never advertised). */
  requestClient(method: string, params: unknown): { id: JsonRpcId; response: Promise<JsonRpcMessage> } {
    const id = `agent-${this.nextId++}`;
    this.clientRequestIds.push(id);
    const response = new Promise<JsonRpcMessage>((resolve) => this.outgoing.set(id, { resolve }));
    this.toClient({ jsonrpc: '2.0', id, method, params });
    return { id, response };
  }

  /** `$/cancel_request` for a request this agent sent. */
  withdraw(id: JsonRpcId): void {
    this.toClient({ jsonrpc: '2.0', method: ACP_PROTOCOL_METHODS.cancelRequest, params: { requestId: id } });
  }

  notify(method: string, params: unknown): void {
    this.toClient({ jsonrpc: '2.0', method, params });
  }

  /** The transport ends; the agent reports nothing more. */
  disconnect(end: AcpTransportEnd = { code: 1, signal: null }): void {
    if (!this.open) return;
    this.open = false;
    const client = this.client;
    queueMicrotask(() => client?.onEnd(end));
  }

  sentRequests(method: string): unknown[] {
    return this.received.filter((r) => r.method === method).map((r) => r.params);
  }

  /** False once the transport has ended. */
  get isOpen(): boolean {
    return this.open;
  }

  private toClient(message: JsonRpcMessage): void {
    if (!this.open) return;
    // Written before a disconnect means delivered before it, as with a pipe.
    const client = this.client;
    queueMicrotask(() => client?.onMessage(message));
  }

  private reply(id: JsonRpcId, result: unknown): void {
    this.toClient({ jsonrpc: '2.0', id, result });
  }

  private replyError(id: JsonRpcId, code: number, message: string): void {
    this.toClient({ jsonrpc: '2.0', id, error: { code, message } });
  }

  private receive(msg: JsonRpcMessage): void {
    if (typeof msg.method !== 'string') {
      // An answer to one of this agent's requests.
      const waiter = msg.id !== undefined && msg.id !== null ? this.outgoing.get(msg.id) : undefined;
      if (waiter) {
        this.outgoing.delete(msg.id!);
        if (msg.result !== undefined) this.answers++;
        waiter.resolve(msg);
      }
      return;
    }
    this.received.push({ method: msg.method, params: msg.params });
    const id = msg.id;
    const params = (msg.params ?? {}) as Record<string, unknown>;
    if (id === undefined || id === null) {
      if (msg.method === ACP_AGENT_METHODS.sessionCancel) for (const resolve of this.cancelWaiters.splice(0)) resolve();
      return;
    }
    switch (msg.method) {
      case ACP_AGENT_METHODS.initialize:
        return this.reply(id, this.opts.initialize ?? { protocolVersion: 1, agentCapabilities: {}, authMethods: [] });
      case ACP_AGENT_METHODS.sessionNew: {
        if (this.opts.newSessionError) return this.replyError(id, this.opts.newSessionError.code, this.opts.newSessionError.message);
        const sessionId = `session-${this.nextSession++}`;
        this.sessions[sessionId] = [];
        for (const update of this.opts.beforeNewReply ?? []) this.update(sessionId, update);
        return this.reply(id, { sessionId, configOptions: this.configOptions });
      }
      case ACP_AGENT_METHODS.sessionLoad: {
        const history = this.sessions[params.sessionId as string];
        if (!history) return this.replyError(id, ACP_ERROR_CODES.resourceNotFound, 'Session not found');
        for (const update of history) this.update(params.sessionId as string, update);
        return this.reply(id, { configOptions: this.configOptions });
      }
      case ACP_AGENT_METHODS.sessionResume:
        if (!this.sessions[params.sessionId as string]) return this.replyError(id, ACP_ERROR_CODES.resourceNotFound, 'Session not found');
        return this.reply(id, { configOptions: this.configOptions });
      case ACP_AGENT_METHODS.sessionClose:
        return this.reply(id, {});
      case ACP_AGENT_METHODS.sessionSetConfigOption: {
        const option = this.configOptions.find((o) => o.id === params.configId);
        if (!option || option.type !== 'select') return this.replyError(id, ACP_ERROR_CODES.invalidParams, 'Unknown config option');
        this.configOptions = this.configOptions.map((o) => (o.id === option.id ? { ...option, currentValue: params.value as string } : o));
        return this.reply(id, { configOptions: this.configOptions });
      }
      case ACP_AGENT_METHODS.sessionPrompt: {
        if (this.nextPromptError) {
          const { code, message } = this.nextPromptError;
          this.nextPromptError = undefined;
          return this.replyError(id, code, message);
        }
        const prompt: ScriptedPrompt = {
          sessionId: params.sessionId as string,
          prompt: params.prompt as ContentBlock[],
          end: (stopReason) => this.reply(id, { stopReason }),
          fail: (code, message) => this.replyError(id, code, message),
        };
        const waiter = this.promptWaiters.shift();
        if (waiter) waiter.resolve(prompt); else this.prompts.push(prompt);
        return;
      }
      default:
        return this.replyError(id, ACP_ERROR_CODES.methodNotFound, `Unknown method ${msg.method}`);
    }
  }
}

export type { CreateElicitationResponse, RequestPermissionResponse };
