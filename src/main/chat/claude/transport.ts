import { AsyncQueue } from '../../orchestrators/adapters/async-queue';
import type { ClaudeChatEvent, ClaudeChatEventBody, ClaudePermissionMode, ClaudePermissionUpdate } from './events';
import { ClaudeNormalizer, type ClaudeWireMessage } from './normalizer';

export type ClaudeTransportKind = 'sdk' | 'stream-json';

export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ClaudeEffort = typeof CLAUDE_EFFORTS[number];

/** What the session will use on its next request, after /model, /effort and any caps. */
export interface ClaudeAppliedSettings {
  model?: string;
  /** null: no effort is sent (the model has none). */
  effort?: string | null;
}

export type ClaudeTransportLog = (level: 'debug' | 'info' | 'warn' | 'error', message: string, meta?: Record<string, unknown>) => void;

export interface ClaudeTransportOptions {
  /** The user's own installed `claude`, as ClaudeCodeProvider finds it. Never the SDK's bundled binary. */
  binary: string;
  cwd: string;
  /** Required: `-p` may otherwise start in `auto`. */
  permissionMode: ClaudePermissionMode;
  model?: string;
  effort?: ClaudeEffort;
  /** MCP servers by name, in Claude's `mcpServers` config shape (stdio / sse / http). */
  mcpServers?: Record<string, Record<string, unknown>>;
  /** Resume this native session id. */
  resume?: string;
  /** With `resume`: branch into a new session id instead of appending. */
  forkSession?: boolean;
  /** With `resume`: resume from this message uuid. */
  resumeSessionAt?: string;
  /** Appended to Claude Code's own system prompt (the TUI's default prompt is kept). */
  appendSystemPrompt?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  additionalDirectories?: string[];
  /** Extra env layered over the shell environment. */
  env?: Record<string, string>;
  /** Validated command prefix, as for PTY agents (e.g. `source ~/.nvm/nvm.sh`). */
  commandPrefix?: string;
  /** Stream partial deltas (`message_chunk` / `thought_chunk`). Default true. */
  includePartialMessages?: boolean;
  log?: ClaudeTransportLog;
  /**
   * Cancels start(): once aborted nothing is spawned, and an abort during
   * initialization kills the CLI and rejects. Not consulted after start().
   */
  signal?: AbortSignal;
}

export interface ClaudeImageInput {
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  /** Base64 without a data: prefix. */
  data: string;
}

export interface ClaudeUserInput {
  text: string;
  images?: ClaudeImageInput[];
  /**
   * `now` steers the running turn, `next` (the CLI default) joins it at the
   * next tool boundary, `later` queues for the next turn.
   */
  priority?: 'now' | 'next' | 'later';
  /** false appends context without starting a turn. */
  shouldQuery?: boolean;
}

export type ClaudePermissionDecision =
  | {
      behavior: 'allow';
      updatedInput?: Record<string, unknown>;
      /** Pass the request's `suggestions` here for "Always allow". */
      updatedPermissions?: ClaudePermissionUpdate[];
    }
  | { behavior: 'deny'; message: string; interrupt?: boolean };

export interface ClaudeTransport {
  readonly kind: ClaudeTransportKind;
  /** Normalized events; finishes after `session_ended`. */
  readonly events: AsyncIterable<ClaudeChatEvent>;
  readonly sessionId: string;
  /** Spawn the CLI and complete the `initialize` handshake. Sends no prompt. */
  start(): Promise<void>;
  send(input: ClaudeUserInput): void;
  /** Answer a `permission_request`. Permissions are never answered without this call. */
  respondToPermission(requestId: string, decision: ClaudePermissionDecision): void;
  interrupt(): Promise<void>;
  setPermissionMode(mode: ClaudePermissionMode): Promise<void>;
  /** Omit to restore the default model. */
  setModel(model?: string): Promise<void>;
  /** Change reasoning effort live (the flag-settings layer, as `--effort` sets it); null returns to the model's default. */
  setEffort(effort: ClaudeEffort | null): Promise<void>;
  /** The model and effort in effect (`get_settings` → `applied`). */
  appliedSettings(): Promise<ClaudeAppliedSettings>;
  /** The raw `get_usage` reply (session totals and plan windows), skipping the transcript scan. */
  planUsage?(): Promise<unknown>;
  /** End the session: closes stdin and lets the CLI exit, killing it if it doesn't. */
  close(): Promise<void>;
}

/** Build the stream-json user message both transports send. */
export function toWireUserMessage(input: ClaudeUserInput, sessionId: string): Record<string, unknown> {
  const content: unknown[] = [];
  for (const img of input.images ?? []) {
    content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } });
  }
  content.push({ type: 'text', text: input.text });
  const msg: Record<string, unknown> = {
    type: 'user',
    message: { role: 'user', content: input.images?.length ? content : input.text },
    parent_tool_use_id: null,
    session_id: sessionId,
  };
  if (input.priority) msg.priority = input.priority;
  if (input.shouldQuery === false) msg.shouldQuery = false;
  return msg;
}

/** The PermissionResult shape the CLI expects in a `can_use_tool` response. */
export function toWirePermissionResult(
  decision: ClaudePermissionDecision,
  originalInput: Record<string, unknown>,
  toolUseId?: string,
): Record<string, unknown> {
  const base = toolUseId ? { toolUseID: toolUseId } : {};
  if (decision.behavior === 'allow') {
    return {
      behavior: 'allow',
      // The CLI requires updatedInput on allow; echo the original when unchanged.
      updatedInput: decision.updatedInput ?? originalInput,
      ...(decision.updatedPermissions?.length ? { updatedPermissions: decision.updatedPermissions } : {}),
      ...base,
    };
  }
  return { behavior: 'deny', message: decision.message, ...(decision.interrupt ? { interrupt: true } : {}), ...base };
}

interface PendingPermission {
  input: Record<string, unknown>;
  toolUseId?: string;
  /** null when the CLI withdrew the request: nothing may be sent back for it. */
  resolve: (result: Record<string, unknown> | null) => void;
}

/**
 * The CLI didn't finish `initialize` within Clubhouse's startup budget. The
 * transport has already closed the session; the probe reports it as `rpc_timeout`.
 */
export class ClaudeStartupTimeoutError extends Error {
  readonly code = 'rpc_timeout' as const;
  constructor(readonly timeoutMs: number) {
    super(`Claude did not finish initializing within ${timeoutMs}ms`);
    this.name = 'ClaudeStartupTimeoutError';
  }
}

/**
 * Shared plumbing: one normalizer, one event queue and the pending-permission
 * table. Subclasses own the process and the control protocol.
 */
export abstract class ClaudeTransportBase implements ClaudeTransport {
  abstract readonly kind: ClaudeTransportKind;
  protected readonly normalizer = new ClaudeNormalizer();
  private readonly queue = new AsyncQueue<ClaudeChatEvent>();
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private ended = false;

  constructor(protected readonly opts: ClaudeTransportOptions) {}

  get events(): AsyncIterable<ClaudeChatEvent> {
    return this.queue;
  }

  get sessionId(): string {
    return this.normalizer.currentSessionId;
  }

  abstract start(): Promise<void>;
  abstract send(input: ClaudeUserInput): void;
  abstract interrupt(): Promise<void>;
  abstract setPermissionMode(mode: ClaudePermissionMode): Promise<void>;
  abstract setModel(model?: string): Promise<void>;
  abstract setEffort(effort: ClaudeEffort | null): Promise<void>;
  abstract appliedSettings(): Promise<ClaudeAppliedSettings>;
  abstract close(): Promise<void>;

  respondToPermission(requestId: string, decision: ClaudePermissionDecision): void {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) {
      this.log('warn', 'Permission response for unknown or settled request', { requestId });
      return;
    }
    this.pendingPermissions.delete(requestId);
    this.log('info', 'Permission decision', { requestId, behavior: decision.behavior });
    pending.resolve(toWirePermissionResult(decision, pending.input, pending.toolUseId));
  }

  protected log(level: 'debug' | 'info' | 'warn' | 'error', message: string, meta?: Record<string, unknown>): void {
    this.opts.log?.(level, `[claude-${this.kind}] ${message}`, meta);
  }

  protected pushWire(msg: ClaudeWireMessage): void {
    for (const ev of this.normalizer.normalize(msg)) {
      if (ev.kind === 'unmapped') {
        // The name once at info; every occurrence's shape at debug, so the
        // next drift can be mapped without guessing (never the values).
        const name = ev.subtype ? `${ev.type}/${ev.subtype}` : ev.type;
        if (!this.loggedUnmapped.has(name)) {
          this.loggedUnmapped.add(name);
          this.log('info', 'Unmapped Claude wire message', { type: ev.type, subtype: ev.subtype });
        }
        this.log('debug', 'Unmapped Claude wire message shape', { name, shape: wireKeyShape(ev.raw) });
      }
      this.queue.push(ev);
    }
  }

  private readonly loggedUnmapped = new Set<string>();

  protected pushEvent(body: ClaudeChatEventBody): void {
    this.queue.push(this.normalizer.emit(body));
  }

  /**
   * Register a permission request and surface it. Resolves with the wire
   * PermissionResult once the user answers via respondToPermission, or with
   * null if the CLI cancels the request first (or already had, when `signal`
   * is aborted on arrival; such a request is never surfaced).
   */
  protected awaitPermission(
    body: Extract<ClaudeChatEventBody, { kind: 'permission_request' }>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown> | null> {
    return new Promise((resolve) => {
      if (signal?.aborted) {
        resolve(null);
        return;
      }
      const { requestId } = body;
      this.pendingPermissions.set(requestId, { input: body.input, toolUseId: body.toolCallId, resolve });
      signal?.addEventListener('abort', () => this.cancelPermission(requestId), { once: true });
      this.pushEvent(body);
    });
  }

  /** The CLI withdrew a request (control_cancel_request, interrupt). */
  protected cancelPermission(requestId: string): void {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return;
    this.pendingPermissions.delete(requestId);
    pending.resolve(null);
    this.pushEvent({ kind: 'permission_cancelled', requestId });
  }

  /** Emit session_ended once and finish the stream. Pending permissions are cancelled. */
  protected end(exitCode: number | null, signal: string | null, reason?: string): void {
    if (this.ended) return;
    this.ended = true;
    for (const requestId of [...this.pendingPermissions.keys()]) this.cancelPermission(requestId);
    this.pushEvent({ kind: 'session_ended', exitCode, signal, reason });
    this.queue.finish();
  }

  protected get isEnded(): boolean {
    return this.ended;
  }
}

/**
 * The keys of a wire message and the kinds of their values, never the values
 * themselves (they can hold prompts, paths and output). Nested objects go
 * three levels deep; an array shows its first element's shape.
 */
export function wireKeyShape(value: unknown, depth = 0): unknown {
  if (Array.isArray(value)) return value.length === 0 ? [] : [depth >= 3 ? 'array' : wireKeyShape(value[0], depth + 1)];
  if (value === null) return 'null';
  if (typeof value !== 'object') return typeof value;
  if (depth >= 3) return 'object';
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = wireKeyShape(v, depth + 1);
  return out;
}

/** The `applied` block of a `get_settings` response. */
export function appliedSettingsFromWire(response: unknown): ClaudeAppliedSettings {
  const applied = typeof response === 'object' && response !== null ? (response as Record<string, unknown>).applied : undefined;
  if (typeof applied !== 'object' || applied === null) return {};
  const { model, effort } = applied as Record<string, unknown>;
  return {
    ...(typeof model === 'string' && { model }),
    ...((typeof effort === 'string' || effort === null) && { effort: effort as string | null }),
  };
}
