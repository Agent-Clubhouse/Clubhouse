// Codex chat driver: `codex app-server` (v2 over stdio) behind the shared
// ChatDriver seam (src/shared/chat/runtime.ts). One CLI process and one
// Codex thread per chat session. The driver only translates: the chat
// runtime stamps envelopes, writes the transcript, queues messages and owns
// the session lifecycle.

import { MINIMAL_CHAT_CAPABILITIES, type ChatCapabilities, type PermissionLevel } from '../../../shared/chat/capabilities';
import type { AvailableCommand, ChatEventDraft, ChatQuestionAnswers, ContentBlock, MessageDelivery } from '../../../shared/chat/events';
import type {
  ChatDriver,
  ChatDriverProbe,
  ChatDriverSession,
  ChatDriverStartOptions,
} from '../../../shared/chat/runtime';
import { AsyncQueue } from './async-queue';
import { CodexAppServerClient } from './codex-app-server-client';
import { CodexChatEventMapper, toCodexInput, toCodexMcpServers } from './codex-chat-events';
import {
  CODEX_APP_SERVER_SCHEMA_VERSION,
  type AskForApproval,
  type JsonValue,
  type Model,
  type SandboxMode,
  type ReviewTarget,
  type SandboxPolicy,
  type ServerNotification,
  type ThreadResumeResponse,
  type ThreadStartResponse,
  type TurnStartParams,
} from './codex-protocol';
import { resolveStructuredSpawn } from './structured-spawn';
import { ProcessExitedError } from './ndjson-rpc-base';
import { RpcError } from './acp-client';

type LogFn = (level: 'info' | 'warn' | 'error', message: string, meta?: Record<string, unknown>) => void;

/** What the Codex app-server driver supports live, on the pinned v2 stable surface. */
const codexCapabilities: ChatCapabilities = {
  ...MINIMAL_CHAT_CAPABILITIES,
  steer: true,
  interrupt: true,
  resume: 'native',
  subagents: 'ids_only',
  usage: 'tokens',
  limits: true,
  images: true,
  // turn/start carries model, effort, approval and sandbox overrides, so all
  // of these apply from the next turn without restarting the process.
  modelSwitch: 'per_turn',
  effortSwitch: 'per_turn',
  // turn/start's effort: null drops back to the model's default.
  effortDefault: true,
  liveLevels: ['plan', 'ask', 'auto_edit', 'auto', 'full_access'],
  login: 'terminal',
  // thread/start takes developerInstructions.
  systemPrompt: true,
  // app-server doesn't parse slash commands in prompt text (the TUI does);
  // the driver handles CODEX_SLASH_COMMANDS itself.
  slashCommands: true,
};
export const CODEX_CHAT_CAPABILITIES: ChatCapabilities = Object.freeze(codexCapabilities);

/** Slash commands the driver runs through app-server methods, as the composer lists them. */
export const CODEX_SLASH_COMMANDS: readonly AvailableCommand[] = Object.freeze([
  {
    name: 'review',
    description: 'Review your changes: uncommitted by default, or against a branch or commit',
    inputHint: '[branch <name> | commit <sha> | instructions]',
    // send() handles these only when the message is the command (parseCodexSlashCommand).
    startOnly: true,
  },
  { name: 'compact', description: 'Summarize the conversation to free up context', startOnly: true },
]);

export type CodexSlashCommand =
  | { name: 'review'; target: ReviewTarget }
  | { name: 'compact' }
  /** A known command with arguments it can't take; `send` rejects it with this message. */
  | { name: 'invalid'; error: string };

/**
 * A message that is exactly one of CODEX_SLASH_COMMANDS, parsed. Anything else
 * (including an unknown `/word`) is an ordinary prompt.
 */
export function parseCodexSlashCommand(content: ContentBlock[]): CodexSlashCommand | undefined {
  if (content.length !== 1 || content[0].type !== 'text') return undefined;
  const match = /^\/(\w+)(?:\s+([\s\S]*))?$/.exec(content[0].text.trim());
  if (!match) return undefined;
  const [, name, rest = ''] = match;
  const arg = rest.trim();
  if (name === 'compact') return arg ? { name: 'invalid', error: '/compact takes no arguments' } : { name: 'compact' };
  if (name !== 'review') return undefined;
  if (!arg) return { name: 'review', target: { type: 'uncommittedChanges' } };
  const [mode, ...values] = arg.split(/\s+/);
  if (mode === 'branch') {
    // A leading '-' would read as an option to git, never a branch name.
    if (values.length !== 1 || values[0].startsWith('-')) {
      return { name: 'invalid', error: 'Usage: /review branch <name>' };
    }
    return { name: 'review', target: { type: 'baseBranch', branch: values[0] } };
  }
  if (mode === 'commit') {
    if (values.length !== 1 || !/^[0-9a-f]{4,40}$/i.test(values[0])) {
      return { name: 'invalid', error: 'Usage: /review commit <sha>' };
    }
    return { name: 'review', target: { type: 'commit', sha: values[0], title: null } };
  }
  return { name: 'review', target: { type: 'custom', instructions: arg } };
}

/** How long close() waits for the process to exit before giving up. */
const CLOSE_TIMEOUT_MS = 5_000;
/** Handshake timeout for probe(). */
const PROBE_TIMEOUT_MS = 15_000;

/**
 * Clubhouse's permission ladder on Codex's approval policy and sandbox.
 * Codex has no stable plan mode, so `plan` is a read-only sandbox.
 */
export function codexLevelSettings(level: PermissionLevel): { approvalPolicy: AskForApproval; sandbox: SandboxMode } {
  switch (level) {
    case 'plan':
      return { approvalPolicy: 'on-request', sandbox: 'read-only' };
    case 'ask':
      return { approvalPolicy: 'untrusted', sandbox: 'workspace-write' };
    case 'auto_edit':
      return { approvalPolicy: 'on-request', sandbox: 'workspace-write' };
    case 'auto':
      return { approvalPolicy: 'never', sandbox: 'workspace-write' };
    case 'full_access':
      return { approvalPolicy: 'never', sandbox: 'danger-full-access' };
  }
}

/**
 * turn/start takes a full SandboxPolicy rather than a mode. When the thread's
 * own policy (from thread/start, which honours config.toml) already has the
 * requested type it is reused, so a level change keeps the user's writable
 * roots and network setting.
 */
export function codexSandboxPolicy(mode: SandboxMode, cwd: string, threadPolicy?: SandboxPolicy): SandboxPolicy {
  switch (mode) {
    case 'read-only':
      return threadPolicy?.type === 'readOnly' ? threadPolicy : { type: 'readOnly', networkAccess: false };
    case 'workspace-write':
      return threadPolicy?.type === 'workspaceWrite'
        ? threadPolicy
        : { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
    case 'danger-full-access':
      return { type: 'dangerFullAccess' };
  }
}

/** `codex app-server` options; everything else in extraArgs is a terminal (TUI) flag. */
const APP_SERVER_VALUE_FLAGS = new Set(['-c', '--config', '--enable', '--disable']);
const APP_SERVER_BOOLEAN_FLAGS = new Set(['--strict-config']);

/**
 * Keep the extraArgs `codex app-server` accepts (config overrides and feature
 * toggles). Per the contract extraArgs are best-effort, so terminal-only
 * flags (--model, --full-auto, a prompt, …) are dropped and reported.
 */
export function appServerArgs(extraArgs: readonly string[]): { args: string[]; dropped: string[] } {
  const args: string[] = [];
  const dropped: string[] = [];
  for (let i = 0; i < extraArgs.length; i++) {
    const arg = extraArgs[i];
    const flag = arg.split('=', 1)[0];
    if (APP_SERVER_BOOLEAN_FLAGS.has(arg) || (APP_SERVER_VALUE_FLAGS.has(flag) && arg.includes('='))) {
      args.push(arg);
    } else if (APP_SERVER_VALUE_FLAGS.has(arg) && i + 1 < extraArgs.length) {
      args.push(arg, extraArgs[++i]);
    } else {
      dropped.push(arg);
    }
  }
  return { args, dropped };
}

/** `codex_cli_rs/0.153.4 (Mac OS 15.5; arm64) …` → `0.153.4`. */
export function parseCodexVersion(userAgent: string | undefined): string | undefined {
  return userAgent ? /\/(\d+\.\d+\.\d+[^\s;)]*)/.exec(userAgent)?.[1] : undefined;
}

/** How long start waits for model/list before going on without menus. */
const MODEL_LIST_TIMEOUT_MS = 5_000;

/** A model's reasoning-effort levels, in Codex's order. */
export function codexEfforts(model: Pick<Model, 'supportedReasoningEfforts'>): string[] {
  return model.supportedReasoningEfforts.map((e) => e.reasoningEffort);
}

export class CodexChatDriver implements ChatDriver {
  readonly id = 'codex_app_server' as const;
  readonly provider = 'codex-cli';

  constructor(private readonly deps: { onLog?: LogFn } = {}) {}

  async probe(binaryPath: string, env?: Record<string, string>, opts?: { commandPrefix?: string }): Promise<ChatDriverProbe> {
    const spawnCmd = resolveStructuredSpawn(binaryPath, ['app-server'], opts?.commandPrefix);
    const client = new CodexAppServerClient({
      ...spawnCmd,
      env,
      rpcTimeoutMs: PROBE_TIMEOUT_MS,
      onLog: this.deps.onLog,
    });
    try {
      const info = await client.start();
      return { handshakeOk: true, cliVersion: parseCodexVersion(info?.userAgent), capabilities: CODEX_CHAT_CAPABILITIES };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const missingNode = err instanceof ProcessExitedError && err.code === 127
        && /env:.*\bnode\b.*(?:No such file|not found)/i.test(client.getStderr());
      const spawnError = err instanceof Error && 'code' in err
        && (err.code === 'ENOENT' || err.code === 'EACCES');
      return {
        handshakeOk: false,
        capabilities: MINIMAL_CHAT_CAPABILITIES,
        error: missingNode
          ? 'Node.js was not found on the Codex launch PATH. Check your shell or profile PATH and restart the agent.'
          : message,
        errorCode: missingNode || spawnError ? 'spawn_failed'
          : err instanceof ProcessExitedError ? 'process_exited'
          : err instanceof RpcError ? 'protocol_error'
          : /^RPC request '.+' timed out after \d+ms$/.test(message) ? 'rpc_timeout'
          : 'unknown',
      };
    } finally {
      client.kill();
    }
  }

  async start(opts: ChatDriverStartOptions): Promise<ChatDriverSession> {
    const session = new CodexChatSession(opts, this.deps.onLog);
    await session.open();
    return session;
  }
}

class CodexChatSession implements ChatDriverSession {
  readonly capabilities = CODEX_CHAT_CAPABILITIES;
  private readonly queue = new AsyncQueue<ChatEventDraft>();
  private readonly mapper = new CodexChatEventMapper();
  private readonly client: CodexAppServerClient;
  private threadId: string | undefined;
  /** Events that arrive before session_started is emitted. */
  private early: ChatEventDraft[] | null = [];
  private closing = false;
  /** Between a turn_started and its turn_ended on this chat's thread. */
  private turnRunning = false;
  /** interrupt() was sent for the running turn and it hasn't ended yet. */
  private interrupting = false;
  private exited: Promise<void>;
  /** Overrides applied on the next turn/start (Codex keeps them for later turns too). */
  private nextTurn: Partial<TurnStartParams> = {};
  /** A slash command was sent and its turn hasn't ended (see send()). */
  private commandRunning = false;
  /** The turn a /review started, once review/start has answered. */
  private commandTurnId: string | undefined;
  /** The last turn that ended here, so a late review/start reply can't re-block commands. */
  private lastEndedTurnId: string | undefined;
  /** The sandbox policy Codex resolved for the thread, used as the base for level changes. */
  private threadSandbox: SandboxPolicy | undefined;
  /** model/list, for the model and effort menus (#2091); empty if Codex didn't answer. */
  private catalog: Model[] = [];
  /** Effort levels last reported, for the current model. */
  private efforts: string[] | undefined;

  constructor(private readonly opts: ChatDriverStartOptions, private readonly log?: LogFn) {
    const { args, dropped } = appServerArgs(opts.extraArgs ?? []);
    if (dropped.length > 0) {
      log?.('warn', 'Ignoring extraArgs that codex app-server does not accept', { dropped });
    }
    const spawnCmd = resolveStructuredSpawn(opts.binaryPath, ['app-server', ...args], opts.commandPrefix);
    let markExited: () => void = () => {};
    this.exited = new Promise((resolve) => { markExited = resolve; });
    this.client = new CodexAppServerClient({
      ...spawnCmd,
      cwd: opts.cwd,
      env: opts.env,
      onLog: log,
      onCodexNotification: (n) => this.onNotification(n),
      onCodexServerRequest: (request) => {
        const threadId = threadOf(request.params);
        const fromSubagent = this.threadId !== undefined && threadId !== undefined && threadId !== this.threadId;
        const events = this.mapper.mapServerRequest(request);
        if (events === null) {
          // The contract can't express this request yet. Decline it so the
          // turn isn't left blocked; the client logs it.
          this.client.respondWithError(request.id, -32601, `Clubhouse chat does not support '${request.method}' yet`);
          this.emit({ type: 'protocol_unknown', data: { driver: 'codex_app_server', kind: 'request', name: request.method } });
          return;
        }
        for (const event of events) {
          this.emit(fromSubagent ? tagSubagent(event, threadId) ?? event : event);
        }
      },
      onUnrecognizedMessage: (message) => this.mapper.mapUnrecognized(message).forEach((e) => this.emit(e)),
      onExit: (code, signal) => {
        // Close out what the dead process can no longer finish, as the Claude
        // and ACP drivers do: the running turn, then any open approvals.
        if (this.turnRunning) {
          // A turn the user already asked to stop (close or interrupt) ends
          // as cancelled even if the process dies before confirming it.
          const cancelled = this.closing || this.interrupting;
          if (!cancelled) {
            const how = code !== null ? ` with code ${code}` : signal ? ` on ${signal}` : '';
            this.emit({
              type: 'error',
              data: { code: 'process_exited', message: `Codex app-server exited${how} during a turn`, fatal: true },
            });
          }
          this.emit({ type: 'turn_ended', data: { stopReason: cancelled ? 'cancelled' : 'error' } });
        }
        this.mapper.cancelOpenRequests().forEach((e) => this.emit(e));
        this.emit({
          type: 'session_ended',
          data: {
            reason: this.closing ? 'stopped' : code === 0 ? 'process_exit' : 'error',
            ...(code !== null && { exitCode: code }),
            ...(signal && !this.closing && { message: `Codex app-server exited on ${signal}` }),
          },
        });
        this.flushEarly();
        this.queue.finish();
        markExited();
      },
    });
  }

  get nativeSessionId(): string | undefined {
    return this.threadId;
  }

  get events(): AsyncIterable<ChatEventDraft> {
    return this.queue;
  }

  async open(): Promise<void> {
    const { opts } = this;
    const level = codexLevelSettings(opts.level);
    let result: ThreadStartResponse | ThreadResumeResponse;
    let cliVersion: string | undefined;
    let mcp: ReturnType<typeof toCodexMcpServers> = { servers: {}, skipped: [] };
    try {
      const info = await this.client.start();
      cliVersion = parseCodexVersion(info?.userAgent);
      mcp = toCodexMcpServers(opts.mcpServers, opts.cwd);
      const shared = {
        cwd: opts.cwd,
        ...(opts.model && { model: opts.model }),
        approvalPolicy: level.approvalPolicy,
        sandbox: level.sandbox,
        ...(opts.systemPrompt && { developerInstructions: opts.systemPrompt }),
        // Codex reads MCP servers from config.toml's `mcp_servers` table;
        // the per-session override takes the same shape.
        ...(Object.keys(mcp.servers).length > 0 && { config: { mcp_servers: mcp.servers as unknown as JsonValue } }),
      };
      result = opts.resumeNativeSessionId
        ? await this.client.threadResume({ threadId: opts.resumeNativeSessionId, excludeTurns: true, ...shared })
        : await this.client.threadStart(shared);
    } catch (err) {
      this.closing = true;
      this.client.kill();
      throw err;
    }

    this.threadId = result.thread.id;
    this.threadSandbox = result.sandbox;
    if (opts.effort) this.nextTurn.effort = opts.effort as TurnStartParams['effort'];
    this.catalog = await this.listModels();

    this.queue.push({
      type: 'session_started',
      data: {
        driver: 'codex_app_server',
        provider: opts.provider,
        cwd: opts.cwd,
        resumed: Boolean(opts.resumeNativeSessionId),
        nativeSessionId: result.thread.id,
        cliVersion: cliVersion ?? result.thread.cliVersion,
        model: result.model,
        level: opts.level,
        capabilities: this.capabilities,
      },
    });
    this.queue.push({ type: 'commands_available', data: { commands: [...CODEX_SLASH_COMMANDS] } });
    const row = this.catalogRow(result.model);
    if (this.catalog.length) {
      this.efforts = row ? codexEfforts(row) : [];
      this.queue.push({
        type: 'session_info',
        data: {
          models: this.catalog.map((m) => ({ id: m.model, label: m.displayName || m.model, description: m.description || undefined })),
          efforts: this.efforts,
        },
      });
      const effort = opts.effort ?? result.reasoningEffort ?? row?.defaultReasoningEffort ?? undefined;
      this.queue.push({ type: 'model_changed', data: { modelId: result.model, ...(effort && { effort }) } });
    }
    if (mcp.skipped.length > 0) {
      this.log?.('warn', 'MCP servers Codex cannot run were left out', { skipped: mcp.skipped });
      this.queue.push({
        type: 'notice',
        data: {
          level: 'warn',
          code: 'mcp_servers_skipped',
          message: `Left out MCP servers Codex can't run: ${mcp.skipped.map((x) => `${x.name} (${x.reason})`).join(', ')}`,
        },
      });
    }
    const version = cliVersion ?? result.thread.cliVersion;
    if (version && version !== CODEX_APP_SERVER_SCHEMA_VERSION) {
      this.queue.push({
        type: 'notice',
        data: {
          level: 'info',
          code: 'untested_cli_version',
          message: `Codex ${version} is untested with Clubhouse chat (tested with ${CODEX_APP_SERVER_SCHEMA_VERSION}).`,
        },
      });
    }
    this.flushEarly();
  }

  async send(content: ContentBlock[], delivery: MessageDelivery): Promise<MessageDelivery> {
    const threadId = this.requireThread();
    const command = parseCodexSlashCommand(content);
    if (command) {
      if (command.name === 'invalid') throw new Error(command.error);
      // Each command starts its own turn, so it can't join a running one. A
      // command already sent counts as running until its turn ends, which
      // closes the gap before turn/started arrives.
      if (this.client.getActiveTurnId(threadId) || this.commandRunning) {
        throw new Error(`Finish or stop the current turn before running /${command.name}`);
      }
      this.commandRunning = true;
      try {
        if (command.name === 'compact') {
          await this.compact();
          this.commandRunning = false;
        } else {
          // Inline: the review runs on this thread, so its turn and items
          // stream into this chat rather than a detached review thread.
          // review/start takes no model or approval settings: a pending
          // setModel/setLevel stays queued for the next turn/start, and the
          // review runs with the thread's current ones.
          const result = await this.client.request('review/start', { threadId, target: command.target, delivery: 'inline' });
          const turn = result?.turn;
          if (turn?.status === 'inProgress' && turn.id !== this.lastEndedTurnId) this.commandTurnId = turn.id;
          else this.commandRunning = false;
        }
      } catch (err) {
        this.commandRunning = false;
        throw err;
      }
      return 'prompt';
    }
    const input = toCodexInput(content);
    if (delivery === 'steer' && this.client.getActiveTurnId(threadId)) {
      try {
        await this.client.turnSteer(threadId, input);
        return 'steer';
      } catch (err) {
        // The turn can end between the check and the steer, and Codex then
        // rejects the stale expectedTurnId. With no turn left running, the
        // message starts the next one instead of being lost.
        if (this.client.getActiveTurnId(threadId)) throw err;
      }
    }
    // Queueing is the runtime's job (capabilities.queue === 'client'), so
    // anything that isn't a live steer starts a turn.
    const overrides = this.nextTurn;
    this.nextTurn = {};
    try {
      await this.client.turnStart({ threadId, input, ...overrides });
    } catch (err) {
      this.nextTurn = { ...overrides, ...this.nextTurn };
      throw err;
    }
    return 'prompt';
  }

  async interrupt(): Promise<void> {
    const threadId = this.requireThread();
    if (!this.client.getActiveTurnId(threadId)) return;
    this.interrupting = true;
    try {
      await this.client.turnInterrupt(threadId);
    } catch (err) {
      this.interrupting = false;
      throw err;
    }
  }

  /** Codex approvals carry only a decision, so denial messages and edited inputs are dropped. */
  async respondPermission(requestId: string, optionId: string): Promise<void> {
    const resolved = this.mapper.resolvePermission(requestId, optionId);
    if (!resolved) throw new Error(`No open Codex permission request ${requestId} with option ${optionId}`);
    // Each reply was built with its method's result type in the mapper.
    this.client.respond(resolved.reply.id, resolved.reply.result);
    this.emit(resolved.event);
  }

  async answerQuestion(requestId: string, answers: ChatQuestionAnswers): Promise<void> {
    const resolved = this.mapper.resolveQuestion(requestId, answers);
    if (!resolved) throw new Error(`No open Codex question ${requestId}`);
    this.client.respondToServerRequest(resolved.reply.id, resolved.reply.method, resolved.reply.result);
    this.emit(resolved.event);
  }

  async setLevel(level: PermissionLevel): Promise<void> {
    const { approvalPolicy, sandbox } = codexLevelSettings(level);
    this.nextTurn.approvalPolicy = approvalPolicy;
    this.nextTurn.sandboxPolicy = codexSandboxPolicy(sandbox, this.opts.cwd, this.threadSandbox);
    this.emit({ type: 'mode_changed', data: { level, nativeMode: `${approvalPolicy}/${sandbox}` } });
  }

  async setModel(modelId: string, effort?: string | null): Promise<void> {
    const row = this.catalogRow(modelId);
    const efforts = row ? codexEfforts(row) : undefined;
    // A model the catalog lists without effort levels takes none: drop it rather than show a stale one.
    const kept = (efforts && !efforts.length) || effort === null ? undefined : effort;
    this.nextTurn.model = modelId;
    // null (and a model without levels) resets any effort already queued, so the model's default applies.
    if ((efforts && !efforts.length) || effort === null) this.nextTurn.effort = null;
    else if (kept) this.nextTurn.effort = kept as TurnStartParams['effort'];
    this.emit({ type: 'model_changed', data: { modelId, ...(kept && { effort: kept }) } });
    // Without the catalog there are no menus to update.
    if (!this.catalog.length) return;
    const levels = efforts ?? [];
    if (this.efforts && levels.join() === this.efforts.join()) return;
    this.efforts = levels;
    this.emit({ type: 'session_info', data: { efforts: levels } });
  }

  /** Codex's model picker, without the models it hides. Best-effort: the menus are just not offered without it. */
  private async listModels(): Promise<Model[]> {
    try {
      // Best-effort and on the start path: don't wait the default RPC timeout for it.
      const res = await this.client.request('model/list', {}, { timeoutMs: MODEL_LIST_TIMEOUT_MS });
      return (res?.data ?? []).filter((m) => !m.hidden);
    } catch (err) {
      this.log?.('warn', 'Codex model/list failed; no model menu', { error: err instanceof Error ? err.message : String(err) });
      return [];
    }
  }

  private catalogRow(model: string): Model | undefined {
    return this.catalog.find((m) => m.model === model || m.id === model);
  }

  async compact(): Promise<void> {
    await this.client.request('thread/compact/start', { threadId: this.requireThread() });
  }

  async close(): Promise<void> {
    if (!this.client.alive) return;
    this.closing = true;
    this.client.kill();
    await Promise.race([this.exited, new Promise((resolve) => setTimeout(resolve, CLOSE_TIMEOUT_MS))]);
  }

  private onNotification(notification: ServerNotification): void {
    const threadId = threadOf(notification.params);
    if (notification.method === 'turn/completed' && threadId === this.threadId) {
      const ended = notification.params.turn.id;
      this.lastEndedTurnId = ended;
      if (ended === this.commandTurnId) {
        this.commandTurnId = undefined;
        this.commandRunning = false;
      }
    }
    const events = this.mapper.mapNotification(notification);
    // Account-level notifications have no thread and always apply.
    if (!this.threadId || threadId === undefined || threadId === this.threadId) {
      events.forEach((e) => this.emit(e));
      return;
    }
    // Subagent threads stream on the same connection. Their messages and tool
    // calls are shown under the subagent (its thread id is the subagentId the
    // mapper gives collabAgentToolCall receivers); their turn lifecycle,
    // usage and state belong to the subagent, not this chat.
    for (const event of events) {
      const tagged = tagSubagent(event, threadId);
      if (tagged) this.emit(tagged);
    }
  }

  private emit(event: ChatEventDraft): void {
    if (event.type === 'turn_started') this.turnRunning = true;
    else if (event.type === 'turn_ended') {
      this.turnRunning = false;
      this.interrupting = false;
    }
    if (this.early) this.early.push(event);
    else this.queue.push(event);
  }

  private flushEarly(): void {
    const early = this.early;
    this.early = null;
    early?.forEach((e) => this.queue.push(e));
  }

  private requireThread(): string {
    if (!this.threadId) throw new Error('Codex chat session has no thread yet');
    return this.threadId;
  }
}

function threadOf(params: unknown): string | undefined {
  const threadId = (params as { threadId?: unknown } | undefined)?.threadId;
  return typeof threadId === 'string' ? threadId : undefined;
}

/** The event attributed to a subagent, or null when it has no place in the parent chat. */
function tagSubagent(event: ChatEventDraft, subagentId: string): ChatEventDraft | null {
  switch (event.type) {
    case 'agent_message_chunk':
    case 'agent_message':
    case 'agent_thought_chunk':
    case 'agent_thought':
    case 'tool_call':
    case 'permission_request':
    case 'question':
      return { ...event, data: { ...event.data, subagentId } } as ChatEventDraft;
    case 'tool_call_update':
    case 'permission_resolved':
    case 'question_resolved':
    case 'protocol_unknown':
      // Keyed by ids the parent already knows about.
      return event;
    default:
      return null;
  }
}
