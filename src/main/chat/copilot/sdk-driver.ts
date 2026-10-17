/**
 * copilot_sdk chat driver: the GA Copilot SDK (`@github/copilot-sdk`) driving
 * the user's own `copilot` (docs/copilot-sdk-driver.md).
 *
 * It covers a chat turn (send, steer, queue, interrupt), message/reasoning/
 * tool/usage events, approve-once/reject permissions, the Plan / Ask first /
 * Full access levels, MCP servers, the system prompt, model and effort
 * switching and native resume. Plan approval, questions, subagent trees and
 * images come later.
 *
 * Fallback: when the SDK can't drive this install (a Windows .cmd shim or a
 * command prefix, which the SDK's shell-less spawn can't run; a failed load;
 * a protocol-version mismatch at connect) the driver starts the copilot_acp
 * driver instead and says so with a `fallback` notice.
 */

import { randomUUID } from 'crypto';
import type { ChatCapabilities, PermissionLevel } from '../../../shared/chat/capabilities';
import { MINIMAL_CHAT_CAPABILITIES } from '../../../shared/chat/capabilities';
import type { ChatEventDraft, ContentBlock, MessageDelivery } from '../../../shared/chat/events';
import type {
  ChatDriver,
  ChatDriverProbe,
  ChatDriverSession,
  ChatDriverStartOptions,
  PermissionResponseExtras,
} from '../../../shared/chat/runtime';
import { AsyncQueue } from '../../orchestrators/adapters/async-queue';
import { createCopilotAcpChatDriver } from '../../orchestrators/adapters/acp-chat-driver';
import { loadCopilotSdk } from './sdk-loader';
import { CopilotSdkEventMapper, type SdkSessionEvent } from './sdk-events';

type Log = (level: 'info' | 'warn' | 'error', message: string, meta?: Record<string, unknown>) => void;

// ── The slice of the SDK this driver uses (structural, so tests can fake it) ──

export interface SdkSessionLike {
  readonly sessionId: string;
  send(options: { prompt: string; mode?: 'enqueue' | 'immediate' }): Promise<string>;
  on(handler: (event: SdkSessionEvent) => void): () => void;
  abort(): Promise<void>;
  setModel(model: string, options?: { reasoningEffort?: string }): Promise<unknown>;
  disconnect(): Promise<void>;
  readonly rpc: {
    mode: { set(params: { mode: 'interactive' | 'plan' | 'autopilot' }): Promise<unknown> };
    permissions: { setMode(params: { mode: 'manual' | 'assisted' | 'allow-all' }): Promise<unknown> };
  };
}

type SdkPermissionResult = { kind: 'approve-once' } | { kind: 'reject'; feedback?: string } | { kind: 'user-not-available' };

export interface SdkSessionConfig {
  workingDirectory: string;
  streaming: boolean;
  model?: string;
  reasoningEffort?: string;
  systemMessage?: { mode: 'append'; content: string };
  mcpServers?: Record<string, SdkMcpServer>;
  onPermissionRequest: (request: Record<string, unknown>) => Promise<SdkPermissionResult>;
}

export type SdkMcpServer =
  | { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'http' | 'sse'; url: string; headers?: Record<string, string> };

export interface SdkClientLike {
  start(): Promise<void>;
  stop(): Promise<unknown>;
  ping(message?: string): Promise<unknown>;
  getStatus(): Promise<{ version?: string; protocolVersion?: number }>;
  createSession(config: SdkSessionConfig): Promise<SdkSessionLike>;
  resumeSession(sessionId: string, config: SdkSessionConfig): Promise<SdkSessionLike>;
}

export interface SdkModuleLike {
  CopilotClient: new (options: { connection: unknown; workingDirectory?: string }) => SdkClientLike;
  RuntimeConnection: { forStdio(options: { path: string; args?: readonly string[]; env?: Record<string, string> }): unknown };
}

export interface CopilotSdkDriverDeps {
  loadSdk?: () => Promise<SdkModuleLike>;
  /** The driver to start when the SDK can't drive this install (copilot_acp in production). */
  fallback?: ChatDriver;
  log?: Log;
  /** Liveness ping interval; the SDK has no public process-exit hook. */
  heartbeatMs?: number;
}

const WINDOWS_BATCH_RE = /\.(cmd|bat)$/i;
const HEARTBEAT_MS = 15_000;

export const COPILOT_SDK_CAPABILITIES: ChatCapabilities = {
  ...MINIMAL_CHAT_CAPABILITIES,
  steer: true,
  queue: 'native',
  interrupt: true,
  resume: 'native',
  usage: 'tokens',
  modelSwitch: 'live',
  effortSwitch: 'live',
  liveLevels: ['plan', 'ask', 'full_access'],
  login: 'terminal',
  systemPrompt: true,
  permissionExtras: { denyMessage: true, updatedInput: false },
};

/**
 * Clubhouse levels → Copilot's session mode and permission mode. Copilot has
 * no "accept edits only" mode, and its `assisted` mode (an LLM safety judge)
 * is experimental, so Auto-accept edits and Auto aren't offered. Autopilot
 * runs without user input and is never chosen by Clubhouse.
 */
const LEVELS: Partial<Record<PermissionLevel, { mode: 'interactive' | 'plan'; permissions: 'manual' | 'allow-all' }>> = {
  plan: { mode: 'plan', permissions: 'manual' },
  ask: { mode: 'interactive', permissions: 'manual' },
  full_access: { mode: 'interactive', permissions: 'allow-all' },
};

export const COPILOT_SDK_LEVEL_NAMES: Partial<Record<PermissionLevel, string>> = {
  plan: 'Plan',
  ask: 'Interactive',
  full_access: 'Interactive, allow all',
};

/** Clubhouse MCP server definitions (McpServerDef) → the SDK's config. Unusable entries are skipped. */
export function toSdkMcpServers(servers: Record<string, unknown> | undefined): Record<string, SdkMcpServer> {
  const out: Record<string, SdkMcpServer> = {};
  for (const [name, raw] of Object.entries(servers ?? {})) {
    const s = raw as Record<string, unknown> | null;
    const env = s?.env && typeof s.env === 'object' ? (s.env as Record<string, string>) : undefined;
    if (s && typeof s.command === 'string') {
      out[name] = { type: 'stdio', command: s.command, ...(Array.isArray(s.args) && { args: s.args.map(String) }), ...(env && { env }) };
    } else if (s && typeof s.url === 'string') {
      const headers = s.headers && typeof s.headers === 'object' ? (s.headers as Record<string, string>) : undefined;
      out[name] = { type: s.type === 'sse' ? 'sse' : 'http', url: s.url, ...(headers && { headers }) };
    }
  }
  return out;
}

/** Why the SDK can't run this launch, or null when it can. */
export function sdkUnsupportedReason(opts: Pick<ChatDriverStartOptions, 'binaryPath' | 'commandPrefix'>): string | null {
  if (opts.commandPrefix) return 'a command prefix is set, and the Copilot SDK spawns the CLI without a shell';
  if (WINDOWS_BATCH_RE.test(opts.binaryPath)) return 'copilot is a Windows batch shim, which the Copilot SDK cannot spawn';
  return null;
}

function promptText(content: ContentBlock[]): string {
  // Minimal: text only. Images and files become attachments in a later pass.
  return content.map((b) => (b.type === 'text' ? b.text : b.type === 'file' ? b.path : '')).filter(Boolean).join('\n\n');
}

function permissionTitle(request: Record<string, unknown>): string {
  const kind = typeof request.kind === 'string' ? request.kind : 'tool';
  const detail = [request.intention, request.fullCommandText, request.fileName, request.url, request.toolName]
    .find((v): v is string => typeof v === 'string' && v.length > 0);
  return detail ? `${kind}: ${detail}` : `Allow ${kind}?`;
}

class CopilotSdkChatSession implements ChatDriverSession {
  readonly capabilities = COPILOT_SDK_CAPABILITIES;
  readonly events: AsyncIterable<ChatEventDraft>;
  private readonly queue = new AsyncQueue<ChatEventDraft>();
  private readonly mapper = new CopilotSdkEventMapper();
  private readonly permissions = new Map<string, (result: SdkPermissionResult) => void>();
  private session: SdkSessionLike | null = null;
  private unsubscribe: (() => void) | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private turnStartedAt = 0;
  private closed = false;

  constructor(private readonly client: SdkClientLike, private readonly log: Log) {
    this.events = this.queue;
  }

  get nativeSessionId(): string | undefined {
    return this.session?.sessionId;
  }

  attach(session: SdkSessionLike, heartbeatMs: number): void {
    this.session = session;
    this.unsubscribe = session.on((event) => this.onEvent(event));
    if (heartbeatMs > 0) {
      this.heartbeat = setInterval(() => {
        this.client.ping().catch((err: Error) => this.fail('process_exited', `Copilot stopped responding: ${err.message}`));
      }, heartbeatMs);
      this.heartbeat.unref?.();
    }
  }

  push(draft: ChatEventDraft): void {
    this.queue.push(draft);
  }

  /** Permission handler passed to the SDK: surfaces the request and waits for the runtime's answer. */
  readonly onPermissionRequest = (request: Record<string, unknown>): Promise<SdkPermissionResult> => {
    const requestId = randomUUID();
    return new Promise<SdkPermissionResult>((resolve) => {
      this.permissions.set(requestId, resolve);
      this.push({
        type: 'permission_request',
        data: {
          requestId,
          title: permissionTitle(request),
          ...(typeof request.toolCallId === 'string' && { toolCallId: request.toolCallId }),
          ...(typeof request.toolName === 'string' && { toolName: request.toolName }),
          rawInput: request,
          // approve-for-session needs a per-kind approval object; it comes later.
          options: [
            { optionId: 'approve-once', kind: 'allow_once', label: 'Allow once' },
            { optionId: 'reject', kind: 'reject_once', label: 'Deny' },
          ],
        },
      });
    });
  };

  async send(content: ContentBlock[], delivery: MessageDelivery): Promise<MessageDelivery> {
    const session = this.requireSession();
    const prompt = promptText(content);
    if (!this.running) {
      this.running = true;
      this.turnStartedAt = Date.now();
      this.push({ type: 'turn_started', data: { trigger: 'prompt' } });
      void session.send({ prompt }).catch((err: Error) => this.endTurn('error', err.message));
      return 'prompt';
    }
    const mode = delivery === 'steer' ? 'immediate' : 'enqueue';
    await session.send({ prompt, mode });
    return mode === 'immediate' ? 'steer' : 'queued';
  }

  async interrupt(): Promise<void> {
    this.settlePermissions({ kind: 'user-not-available' });
    await this.requireSession().abort();
  }

  async respondPermission(requestId: string, optionId: string, extras?: PermissionResponseExtras): Promise<void> {
    const resolve = this.permissions.get(requestId);
    if (!resolve) throw new Error(`No pending permission request ${requestId}`);
    this.permissions.delete(requestId);
    if (optionId === 'approve-once') resolve({ kind: 'approve-once' });
    else if (optionId === 'reject') resolve({ kind: 'reject', ...(extras?.message && { feedback: extras.message }) });
    else throw new Error(`Option ${optionId} was not offered for permission request ${requestId}`);
  }

  async answerQuestion(): Promise<void> {
    throw new Error('The copilot_sdk driver does not handle questions yet');
  }

  async setLevel(level: PermissionLevel): Promise<void> {
    const target = LEVELS[level];
    if (!target) throw new Error(`Copilot has no ${level} level`);
    const session = this.requireSession();
    await session.rpc.permissions.setMode({ mode: target.permissions });
    await session.rpc.mode.set({ mode: target.mode });
  }

  async setModel(modelId: string, effort?: string): Promise<void> {
    await this.requireSession().setModel(modelId, effort ? { reasoningEffort: effort } : undefined);
  }

  async compact(): Promise<void> {
    await this.send([{ type: 'text', text: '/compact' }], 'prompt');
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.stopHeartbeat();
    this.settlePermissions({ kind: 'user-not-available' });
    this.unsubscribe?.();
    try {
      await this.session?.disconnect();
    } finally {
      await this.client.stop().catch((err: Error) => this.log('warn', 'Copilot SDK stop failed', { error: err.message }));
      if (this.running) this.endTurn('cancelled');
      this.queue.finish();
    }
  }

  private onEvent(event: SdkSessionEvent): void {
    if (event.type === 'session.idle') {
      const aborted = !!(event.data as { aborted?: boolean } | undefined)?.aborted;
      if (this.running) this.endTurn(aborted ? 'cancelled' : 'end_turn');
      return;
    }
    for (const draft of this.mapper.map(event)) this.push(draft);
  }

  private endTurn(stopReason: 'end_turn' | 'cancelled' | 'error', error?: string): void {
    if (!this.running) return;
    this.running = false;
    if (error) this.push({ type: 'error', data: { code: 'unknown', message: error, fatal: false } });
    this.push({ type: 'turn_ended', data: { stopReason, durationMs: Date.now() - this.turnStartedAt } });
  }

  private fail(code: 'process_exited', message: string): void {
    if (this.closed) return;
    this.closed = true;
    this.stopHeartbeat();
    this.settlePermissions({ kind: 'user-not-available' });
    this.push({ type: 'error', data: { code, message, fatal: true } });
    if (this.running) {
      this.running = false;
      this.push({ type: 'turn_ended', data: { stopReason: 'error', durationMs: Date.now() - this.turnStartedAt } });
    }
    this.queue.finish();
  }

  private settlePermissions(result: SdkPermissionResult): void {
    for (const resolve of this.permissions.values()) resolve(result);
    this.permissions.clear();
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  private requireSession(): SdkSessionLike {
    if (!this.session || this.closed) throw new Error('Copilot SDK session is not open');
    return this.session;
  }
}

/** Prepends drafts (the fallback notice) to another session's stream. */
function withLeadingDrafts(session: ChatDriverSession, drafts: ChatEventDraft[]): ChatDriverSession {
  const events: AsyncIterable<ChatEventDraft> = {
    async *[Symbol.asyncIterator]() {
      yield* drafts;
      yield* session.events;
    },
  };
  return new Proxy(session, {
    get(target, prop, receiver) {
      if (prop === 'events') return events;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export class CopilotSdkChatDriver implements ChatDriver {
  readonly id = 'copilot_sdk' as const;
  readonly provider = 'copilot-cli';
  private readonly loadSdk: () => Promise<SdkModuleLike>;
  private readonly log: Log;

  constructor(private readonly deps: CopilotSdkDriverDeps = {}) {
    this.loadSdk = deps.loadSdk ?? (loadCopilotSdk as unknown as () => Promise<SdkModuleLike>);
    this.log = deps.log ?? (() => undefined);
  }

  /** Handshake only (connect + status.get): no session, no prompt, no tokens. */
  async probe(binaryPath: string, env?: Record<string, string>): Promise<ChatDriverProbe> {
    const unsupported = sdkUnsupportedReason({ binaryPath });
    if (unsupported) return { handshakeOk: false, capabilities: COPILOT_SDK_CAPABILITIES, error: unsupported };
    let client: SdkClientLike | null = null;
    try {
      const sdk = await this.loadSdk();
      client = new sdk.CopilotClient({ connection: sdk.RuntimeConnection.forStdio({ path: binaryPath, env }) });
      await client.start();
      const status = await client.getStatus();
      return { handshakeOk: true, ...(status.version && { cliVersion: status.version }), capabilities: COPILOT_SDK_CAPABILITIES };
    } catch (err) {
      return { handshakeOk: false, capabilities: COPILOT_SDK_CAPABILITIES, error: (err as Error).message };
    } finally {
      await client?.stop().catch((): undefined => undefined); // telemetry-exempt: best-effort cleanup after a probe
    }
  }

  async start(opts: ChatDriverStartOptions): Promise<ChatDriverSession> {
    const unsupported = sdkUnsupportedReason(opts);
    if (unsupported) return this.startFallback(opts, unsupported);

    let client: SdkClientLike;
    try {
      const sdk = await this.loadSdk();
      client = new sdk.CopilotClient({
        connection: sdk.RuntimeConnection.forStdio({ path: opts.binaryPath, args: opts.extraArgs ?? [], env: opts.env }),
        workingDirectory: opts.cwd,
      });
      await client.start();
    } catch (err) {
      // Load failures and protocol-version mismatches land here (research §7.1: fall back on real failures).
      return this.startFallback(opts, `the Copilot SDK could not connect: ${(err as Error).message}`);
    }

    const chat = new CopilotSdkChatSession(client, this.log);
    const config: SdkSessionConfig = {
      workingDirectory: opts.cwd,
      streaming: true,
      ...(opts.model && { model: opts.model }),
      ...(opts.effort && { reasoningEffort: opts.effort }),
      ...(opts.systemPrompt && { systemMessage: { mode: 'append' as const, content: opts.systemPrompt } }),
      ...(opts.mcpServers && { mcpServers: toSdkMcpServers(opts.mcpServers) }),
      onPermissionRequest: chat.onPermissionRequest,
    };
    try {
      const session = opts.resumeNativeSessionId
        ? await client.resumeSession(opts.resumeNativeSessionId, config)
        : await client.createSession(config);
      chat.attach(session, this.deps.heartbeatMs ?? HEARTBEAT_MS);
      if (LEVELS[opts.level]) await chat.setLevel(opts.level);
      else this.log('warn', 'Permission level not available on Copilot; keeping its default', { level: opts.level });
      const status = await client.getStatus().catch((): { version?: string } => ({})); // telemetry-exempt: version is optional
      chat.push({
        type: 'session_info',
        data: {
          nativeSessionId: session.sessionId,
          ...(status.version && { cliVersion: status.version }),
          levelNames: COPILOT_SDK_LEVEL_NAMES,
        },
      });
      return chat;
    } catch (err) {
      await client.stop().catch((): undefined => undefined); // telemetry-exempt: best-effort cleanup; the start error is rethrown
      throw err;
    }
  }

  private async startFallback(opts: ChatDriverStartOptions, reason: string): Promise<ChatDriverSession> {
    if (!this.deps.fallback) throw new Error(`copilot_sdk cannot start: ${reason}`);
    this.log('warn', 'copilot_sdk falling back', { reason, fallback: this.deps.fallback.id });
    const session = await this.deps.fallback.start(opts);
    return withLeadingDrafts(session, [{
      type: 'notice',
      data: { level: 'info', code: 'fallback', message: `Using Copilot over ACP because ${reason}.` },
    }]);
  }
}

/**
 * The production driver: the real SDK, with copilot_acp as the fallback.
 * Registered after copilot_acp in registerBuiltinChatDrivers(), so ACP stays
 * Copilot's default; a provider setting of `driver: 'copilot_sdk'` selects it.
 */
export function createCopilotSdkChatDriver(log?: Log): CopilotSdkChatDriver {
  return new CopilotSdkChatDriver({ fallback: createCopilotAcpChatDriver(log), log });
}
