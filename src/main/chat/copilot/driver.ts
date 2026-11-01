import type { CopilotClient, CopilotSession, MCPServerConfig, PermissionRequest, PermissionRequestResult, SessionConfig, SessionEvent } from '@github/copilot-sdk';
import { MINIMAL_CHAT_CAPABILITIES, type ChatCapabilities, type PermissionLevel } from '../../../shared/chat/capabilities';
import type { ChatEventDraft, ContentBlock, MessageDelivery, TokenUsage } from '../../../shared/chat/events';
import type { ChatDriver, ChatDriverProbe, ChatDriverSession, ChatDriverStartOptions, McpHttpEndpoint, PermissionResponseExtras } from '../../../shared/chat/runtime';
import { AsyncQueue } from '../../orchestrators/adapters/async-queue';
import { CopilotLaunchError, launchCopilotServer, type CopilotServer } from './launch';
import {
  addTokens,
  COPILOT_OPTION_ALLOW,
  COPILOT_OPTION_ALLOW_SESSION,
  COPILOT_OPTION_DENY,
  copilotErrorCode,
  copilotPermissionOptions,
  copilotPermissionView,
  copilotTokens,
  copilotToolContent,
  copilotToolKind,
  copilotToolLocations,
  copilotToolTitle,
} from './normalizer';
import { loadCopilotSdk } from './sdk-loader';

type ReasoningEffort = NonNullable<NonNullable<Parameters<CopilotSession['setModel']>[1]>['reasoningEffort']>;

type Log = (level: 'debug' | 'info' | 'warn' | 'error', message: string, meta?: Record<string, unknown>) => void;

const PROVIDER = 'copilot-cli';

/** `start()` can hang forever on a CLI that never answers. Cold handshakes took 0.8 to 5.9 s. */
export const COPILOT_PROBE_TIMEOUT_MS = 15_000;
/** Connecting and opening a session also loads the user's MCP servers. */
const START_TIMEOUT_MS = 60_000;
const CLOSE_GRACE_MS = 5_000;

const LOGIN_MESSAGE = 'Not logged in to Copilot. Run copilot and use /login.';
const LOGIN_HINT = 'Run copilot and use /login';

/**
 * Phase 1 (docs/copilot-sdk-driver.md "Plan"): text, tools, permissions and
 * interrupt. Steering, the native queue, plan approval, questions and the model
 * menu come in phase 2, so messages sent during a turn queue in the runtime.
 */
export const COPILOT_SDK_CAPABILITIES: ChatCapabilities = Object.freeze({
  ...MINIMAL_CHAT_CAPABILITIES,
  interrupt: true,
  resume: 'native',
  usage: 'tokens',
  liveLevels: ['ask', 'auto_edit', 'full_access'],
  // A reject with feedback lets the model continue; updatedInput has no equivalent.
  permissionExtras: { denyMessage: true, updatedInput: false },
}) as ChatCapabilities;

const LEVEL_NAMES: Partial<Record<PermissionLevel, string>> = { ask: 'Agent', auto_edit: 'Agent, allow edits', full_access: 'Agent, allow all' };

const ignore = (): void => undefined;

function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new CopilotLaunchError(`${what} did not finish within ${ms}ms`, 'rpc_timeout')), ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/** Rejects when the CLI exits, so a request on a dead connection can't wait out its timeout. */
function untilExit(server: CopilotServer): Promise<never> {
  return server.exited.then(() => {
    const tail = server.stderrTail();
    throw new CopilotLaunchError(`Copilot exited${tail ? `: ${tail}` : ''}`, 'process_exited');
  });
}

async function connect(server: CopilotServer): Promise<CopilotClient> {
  const { CopilotClient, RuntimeConnection } = await loadCopilotSdk();
  const client = new CopilotClient({ connection: RuntimeConnection.forUri(server.uri, { connectionToken: server.connectionToken }), logLevel: 'error' });
  await client.start();
  return client;
}

/** A model key from the environment (BYOK) stands in for a GitHub login. */
function hasProviderKey(env: Record<string, string | undefined>): boolean {
  return Object.keys(env).some((k) => k.startsWith('COPILOT_PROVIDER_'));
}

function probeErrorCode(err: unknown): NonNullable<ChatDriverProbe['errorCode']> {
  if (err instanceof CopilotLaunchError) return err.code;
  const message = err instanceof Error ? err.message : String(err);
  if (/protocol version/i.test(message)) return 'protocol_error';
  if (/exited/i.test(message)) return 'process_exited';
  return 'unknown';
}

/**
 * The session's MCP servers. The Clubhouse bridge goes over HTTP with its nonce
 * header, resolved from `env` so it stays out of the config; stdio servers go
 * as they are. Copilot takes both here, unlike over ACP (#2240).
 */
export function toSdkMcpServers(
  servers: Record<string, unknown> | undefined,
  env: Record<string, string | undefined> | undefined,
  endpoints: Record<string, McpHttpEndpoint> | undefined,
): { servers: Record<string, MCPServerConfig>; skipped: string[] } {
  const out: Record<string, MCPServerConfig> = {};
  const skipped: string[] = [];
  const stringMap = (v: unknown): Record<string, string> | undefined => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, val]) => [k, String(val)]));
  };
  for (const [name, raw] of Object.entries(servers ?? {})) {
    const s = raw as Record<string, unknown> | null;
    const endpoint = endpoints?.[name];
    const headers: Record<string, string> = {};
    const resolved = endpoint && Object.entries(endpoint.headersFromEnv ?? {}).every(([header, envName]) => {
      const value = env?.[envName];
      if (value) headers[header] = value;
      return !!value;
    });
    if (endpoint && resolved) {
      out[name] = { type: 'http', url: endpoint.url, headers, tools: ['*'] };
    } else if (s && typeof s.command === 'string') {
      const forwarded = Array.isArray(s.env_vars)
        ? Object.fromEntries(s.env_vars.flatMap((n) => (typeof n === 'string' && typeof env?.[n] === 'string' ? [[n, env[n] as string]] : [])))
        : {};
      out[name] = { type: 'stdio', command: s.command, args: Array.isArray(s.args) ? s.args.map(String) : [], env: { ...stringMap(s.env), ...forwarded }, tools: ['*'] };
    } else if (s && typeof s.url === 'string') {
      out[name] = { type: s.type === 'sse' ? 'sse' : 'http', url: s.url, headers: stringMap(s.headers), tools: ['*'] };
    } else {
      skipped.push(name);
    }
  }
  return { servers: out, skipped };
}

interface PendingPermission {
  resolve: (result: PermissionRequestResult) => void;
  toolCallId?: string;
}

/** The model's own status line to the CLI, not a step of the work. */
const HIDDEN_TOOLS: ReadonlySet<string> = new Set(['report_intent']);

/** Kinds that only occur inside a turn: one arriving while idle means the CLI started a turn on its own. */
const TURN_OPENING_EVENTS: ReadonlySet<string> = new Set([
  'assistant.message_delta', 'assistant.message', 'assistant.reasoning_delta', 'assistant.reasoning', 'tool.execution_start',
]);

/**
 * One chat session over the SDK, translated to the shared chat contract.
 * Note `assistant.turn_start` and `turn_end` mark model rounds, not user turns:
 * a contract turn ends on `session.idle`.
 */
export class CopilotSdkChatSession implements ChatDriverSession {
  readonly capabilities = COPILOT_SDK_CAPABILITIES;
  resumeFallback: 'not_found' | undefined;
  private readonly queue = new AsyncQueue<ChatEventDraft>();
  private readonly pending = new Map<string, PendingPermission>();
  /** Calls in progress, for the result's title and arguments. */
  private readonly tools = new Map<string, { name: string; args: unknown }>();
  private sdk: CopilotSession | undefined;
  private level: PermissionLevel;
  private turn = 0;
  private turnRunning = false;
  private interrupting = false;
  private closing = false;
  private finished = false;
  private nextPermission = 0;
  private turnTokens: TokenUsage | undefined;
  private sessionTokens: TokenUsage | undefined;
  private context: { used: number; size: number } | undefined;

  constructor(
    private readonly client: CopilotClient,
    private readonly server: CopilotServer,
    private readonly opts: ChatDriverStartOptions,
    private readonly log: Log,
    private readonly overrides: Partial<SessionConfig> = {},
  ) {
    // Plan and Auto arrive in phase 2. Until then they ask first: never more access than asked for.
    this.level = COPILOT_SDK_CAPABILITIES.liveLevels.includes(opts.level) ? opts.level : 'ask';
    void server.exited.then(() => this.onExit());
  }

  get nativeSessionId(): string | undefined {
    return this.sdk?.sessionId ?? this.opts.resumeNativeSessionId;
  }

  get events(): AsyncIterable<ChatEventDraft> {
    return this.queue;
  }

  /** Create or resume the native session, then report what it started with. */
  async open(cliVersion: string | undefined): Promise<void> {
    const { servers, skipped } = toSdkMcpServers(this.opts.mcpServers, { ...process.env, ...this.opts.env }, this.opts.mcpHttpEndpoints);
    if (skipped.length) this.log('warn', 'MCP servers not expressible over the Copilot SDK', { skipped });
    const model = this.opts.model && this.opts.model !== 'default' ? this.opts.model : undefined;
    const config: SessionConfig = {
      clientName: 'Clubhouse',
      streaming: true,
      workingDirectory: this.opts.cwd,
      // Off by default in the SDK. Without it the session ignores the user's own
      // instructions, skills and MCP config, which Terminal and ACP both load.
      enableConfigDiscovery: true,
      ...(model && { model }),
      ...(Object.keys(servers).length && { mcpServers: servers }),
      onPermissionRequest: (request) => this.onPermission(request),
      onEvent: (event) => this.onEvent(event),
      ...this.overrides,
    };
    const resumeId = this.opts.resumeNativeSessionId;
    if (resumeId) {
      try {
        this.sdk = await this.client.resumeSession(resumeId, config);
      } catch (err) {
        if (!/not found/i.test((err as Error).message)) throw err;
        this.log('warn', 'Native session not found; starting a new one', { sessionId: resumeId });
        this.push({ type: 'notice', data: { level: 'info', code: 'resume_unavailable', message: 'The agent no longer has this conversation, so it continues in a new session without the earlier context.' } });
        this.resumeFallback = 'not_found';
      }
    }
    this.sdk ??= await this.client.createSession(config);
    // A session opened on another driver can still be in Plan or Autopilot.
    await this.sdk.rpc.mode.set({ mode: 'interactive' }).catch((err: Error) => this.log('warn', 'Could not set the session mode', { error: err.message }));
    if (this.opts.effort && model) {
      await this.sdk.setModel(model, { reasoningEffort: this.opts.effort as ReasoningEffort }).catch((err: Error) => this.log('warn', 'Effort not applied', { error: err.message }));
    }
    this.push({
      type: 'session_info',
      data: {
        nativeSessionId: this.sdk.sessionId,
        ...(cliVersion && { cliVersion }),
        ...(model && { model }),
        levelNames: LEVEL_NAMES,
      },
    });
    if (this.level !== this.opts.level) {
      this.push({ type: 'mode_changed', data: { level: this.level, nativeMode: 'interactive' } });
      this.push({ type: 'notice', data: { level: 'info', code: 'level_unavailable', message: 'The Copilot SDK driver has no Plan or Auto level yet, so this session asks first.' } });
    }
    this.log('info', 'Copilot SDK session opened', {
      agentId: this.opts.agentId,
      nativeSessionId: this.sdk.sessionId,
      cliVersion,
      level: this.level,
      requestedLevel: this.opts.level,
      model,
      resumed: !!resumeId && !this.resumeFallback,
      resumeFallback: this.resumeFallback,
      mcpServers: Object.keys(servers),
    });
    this.push({
      type: 'notice',
      data: { level: 'info', code: 'copilot_sdk_active', message: `This chat runs on the experimental Copilot SDK driver${cliVersion ? ` with Copilot CLI ${cliVersion}` : ''}.` },
    });
  }

  async send(content: ContentBlock[], delivery: MessageDelivery): Promise<MessageDelivery> {
    if (this.turnRunning) throw new Error(`Cannot ${delivery} into a running Copilot turn yet; queue it until the turn ends`);
    const prompt = content
      .map((b) => (b.type === 'text' ? b.text : b.type === 'file' ? b.path : b.type === 'resource' ? b.text ?? b.uri : ''))
      .filter(Boolean)
      .join('\n');
    this.beginTurn('prompt');
    try {
      await this.requireSession().send({ prompt });
    } catch (err) {
      this.endTurn('error');
      throw err;
    }
    return 'prompt';
  }

  async interrupt(): Promise<void> {
    if (this.turnRunning) this.interrupting = true;
    this.settlePending('agent');
    await this.requireSession().abort();
  }

  async respondPermission(requestId: string, optionId: string, extras?: PermissionResponseExtras): Promise<void> {
    const pending = this.pending.get(requestId);
    if (!pending) throw new Error(`No pending Copilot permission request ${requestId}`);
    let result: PermissionRequestResult;
    if (optionId === COPILOT_OPTION_ALLOW) result = { kind: 'approve-once' };
    else if (optionId === COPILOT_OPTION_ALLOW_SESSION) result = { kind: 'approve-for-session' };
    else if (optionId === COPILOT_OPTION_DENY) result = { kind: 'reject', ...(extras?.message && { feedback: extras.message }) };
    else throw new Error(`Unknown Copilot permission option ${optionId}`);
    this.pending.delete(requestId);
    pending.resolve(result);
    this.push({ type: 'permission_resolved', data: { requestId, optionId, decision: optionId === COPILOT_OPTION_DENY ? 'deny' : 'allow', by: 'user' } }, true);
  }

  async answerQuestion(): Promise<void> {
    throw new Error('The Copilot SDK driver does not ask structured questions yet');
  }

  async setLevel(level: PermissionLevel): Promise<void> {
    if (!this.capabilities.liveLevels.includes(level)) throw new Error(`The Copilot SDK driver has no ${level} level yet`);
    if (level === this.level) return;
    this.level = level;
    this.push({ type: 'mode_changed', data: { level, nativeMode: 'interactive' } });
  }

  async setModel(modelId: string, effort?: string | null): Promise<void> {
    await this.requireSession().setModel(modelId, effort ? { reasoningEffort: effort as ReasoningEffort } : undefined);
  }

  async compact(): Promise<void> {
    await this.requireSession().rpc.history.compact();
    this.push({ type: 'notice', data: { level: 'info', code: 'compacted', message: 'Context compacted' } }, true);
  }

  async close(): Promise<void> {
    this.closing = true;
    this.settlePending('agent');
    const grace = (work: Promise<unknown>) => withTimeout(work, CLOSE_GRACE_MS, 'Copilot close').catch((err: Error) => this.log('warn', 'Copilot did not close cleanly', { error: err.message }));
    if (this.sdk) await grace(this.sdk.disconnect());
    await grace(this.client.stop());
    await this.server.kill();
    await grace(this.server.exited);
    this.onExit();
  }

  private requireSession(): CopilotSession {
    if (!this.sdk) throw new Error('The Copilot session has not opened');
    return this.sdk;
  }

  private onPermission(request: PermissionRequest): Promise<PermissionRequestResult> | PermissionRequestResult {
    // A managed policy that wants a person is never skipped by a level.
    if (!request.managedApprovalRequired) {
      if (this.level === 'full_access') return { kind: 'approve-once' };
      if (this.level === 'auto_edit' && request.kind === 'write') return { kind: 'approve-once' };
    }
    if (this.closing || this.finished) return { kind: 'reject' };
    if (!this.turnRunning) this.beginTurn('system');
    const requestId = `perm-${++this.nextPermission}`;
    const view = copilotPermissionView(request);
    const toolCallId = 'toolCallId' in request ? request.toolCallId : undefined;
    if (toolCallId && view.content) {
      this.push({ type: 'tool_call_update', data: { toolCallId, content: view.content } }, true);
    }
    return new Promise((resolve) => {
      this.pending.set(requestId, { resolve, toolCallId });
      this.push({
        type: 'permission_request',
        data: {
          requestId,
          title: view.title,
          description: view.description,
          toolCallId,
          toolName: view.toolName,
          rawInput: request,
          options: copilotPermissionOptions(request),
        },
      }, true);
    });
  }

  /** Answer every open request "no" and tell the UI, so nothing waits on a turn that has gone. */
  private settlePending(by: 'agent'): void {
    for (const [requestId, pending] of this.pending) {
      pending.resolve({ kind: 'reject' });
      this.push({ type: 'permission_resolved', data: { requestId, decision: 'cancelled', by } }, true);
    }
    this.pending.clear();
  }

  private get turnId(): string | undefined {
    return this.turn > 0 ? `turn-${this.turn}` : undefined;
  }

  private push(draft: ChatEventDraft, turnScoped = false): void {
    if (this.finished) return;
    this.queue.push(turnScoped && this.turnRunning && this.turnId ? { ...draft, turnId: this.turnId } as ChatEventDraft : draft);
  }

  private beginTurn(trigger: MessageDelivery | 'system'): void {
    this.turn += 1;
    this.turnRunning = true;
    this.interrupting = false;
    this.turnTokens = undefined;
    this.push({ type: 'turn_started', data: { trigger } }, true);
  }

  private endTurn(stopReason: 'end_turn' | 'cancelled' | 'error'): void {
    if (!this.turnRunning) return;
    const usage = this.turnTokens;
    if (usage || this.context) this.push({ type: 'usage', data: { scope: 'turn', ...(usage && { tokens: usage }), ...(this.context && { context: this.context }) } }, true);
    if (this.sessionTokens) this.push({ type: 'usage', data: { scope: 'session', tokens: this.sessionTokens } }, true);
    this.push({ type: 'turn_ended', data: { stopReason, ...(usage && { usage }) } }, true);
    this.turnRunning = false;
    this.interrupting = false;
  }

  /** The CLI is gone. The SDK fires no session event for this, so the driver ends the session itself. */
  private onExit(): void {
    if (this.finished) return;
    this.log(this.closing ? 'info' : 'warn', 'Copilot CLI exited', {
      agentId: this.opts.agentId,
      nativeSessionId: this.sdk?.sessionId,
      exitCode: this.server.exitCode(),
      closing: this.closing,
      turnRunning: this.turnRunning,
      ...(!this.closing && { stderr: this.server.stderrTail() }),
    });
    this.settlePending('agent');
    this.endTurn(this.closing || this.interrupting ? 'cancelled' : 'error');
    this.finished = true;
    this.queue.finish();
  }

  private onEvent(event: SessionEvent): void {
    if (TURN_OPENING_EVENTS.has(event.type) && !this.turnRunning) this.beginTurn('system');
    switch (event.type) {
      case 'assistant.message_delta': {
        const { messageId, deltaContent, parentToolCallId } = event.data;
        this.push({ type: 'agent_message_chunk', data: { messageId, text: deltaContent, ...(parentToolCallId && { subagentId: parentToolCallId }) } }, true);
        return;
      }
      case 'assistant.message': {
        const { messageId, content, parentToolCallId } = event.data;
        // A round that only calls tools has an empty message.
        if (content) this.push({ type: 'agent_message', data: { messageId, text: content, ...(parentToolCallId && { subagentId: parentToolCallId }) } }, true);
        return;
      }
      case 'assistant.reasoning_delta':
        this.push({ type: 'agent_thought_chunk', data: { messageId: event.data.reasoningId, text: event.data.deltaContent } }, true);
        return;
      case 'assistant.reasoning':
        if (event.data.content) this.push({ type: 'agent_thought', data: { messageId: event.data.reasoningId, text: event.data.content } }, true);
        return;
      case 'tool.execution_start': {
        const { toolCallId, toolName, arguments: args, toolTitle, parentToolCallId } = event.data;
        if (HIDDEN_TOOLS.has(toolName)) return;
        this.tools.set(toolCallId, { name: toolName, args });
        this.push({
          type: 'tool_call',
          data: {
            toolCallId,
            kind: copilotToolKind(toolName),
            title: copilotToolTitle(toolName, args, toolTitle, this.opts.cwd),
            status: 'in_progress',
            toolName,
            rawInput: args,
            locations: copilotToolLocations(args),
            ...(parentToolCallId && { subagentId: parentToolCallId }),
          },
        }, true);
        return;
      }
      case 'tool.execution_complete': {
        const { toolCallId, success, result, error, shellExecution } = event.data;
        const tool = this.tools.get(toolCallId);
        if (!tool) return;
        this.tools.delete(toolCallId);
        const output = result?.detailedContent ?? result?.content;
        this.push({
          type: 'tool_call_update',
          data: {
            toolCallId,
            status: success ? 'completed' : 'failed',
            content: copilotToolContent(tool.name, tool.args, output, shellExecution?.exitCode ?? undefined, this.opts.cwd),
            rawOutput: result,
            ...(!success && { error: error?.message ?? output ?? 'The tool failed' }),
          },
        }, true);
        return;
      }
      case 'assistant.usage': {
        const tokens = copilotTokens(event.data);
        // Subagent calls count toward the session, not the context in front of the user.
        this.sessionTokens = addTokens(this.sessionTokens, tokens);
        this.turnTokens = addTokens(this.turnTokens, tokens);
        return;
      }
      case 'session.usage_info':
        this.context = { used: event.data.currentTokens, size: event.data.tokenLimit };
        return;
      case 'session.idle':
        this.endTurn(event.data.aborted || this.interrupting ? 'cancelled' : 'end_turn');
        return;
      case 'abort':
        this.interrupting = true;
        return;
      case 'session.error':
        // An error during an interrupt is the interrupt.
        if (this.interrupting) return;
        this.log('warn', 'Copilot session error', { agentId: this.opts.agentId, errorType: event.data.errorType, errorCode: event.data.errorCode, statusCode: event.data.statusCode, message: event.data.message });
        this.push({ type: 'error', data: { code: copilotErrorCode(event.data), message: event.data.message, fatal: false } }, true);
        this.endTurn('error');
        return;
      case 'session.warning':
        this.push({ type: 'notice', data: { level: 'warn', code: event.data.warningType, message: event.data.message } }, true);
        return;
      case 'session.info':
        this.push({ type: 'notice', data: { level: 'info', code: event.data.infoType, message: event.data.message } }, true);
        return;
      case 'session.title_changed':
        this.push({ type: 'session_info', data: { title: event.data.title } });
        return;
      case 'session.model_change':
        this.push({ type: 'model_changed', data: { modelId: event.data.newModel, ...(event.data.reasoningEffort && { effort: event.data.reasoningEffort }) } });
        return;
      default:
        // Sessions emit far more than the contract shows, including types the
        // SDK doesn't declare, so an unhandled type isn't drift.
        return;
    }
  }
}

export interface CopilotSdkDriverOptions {
  log?: Log;
  /** Session settings tests override, e.g. a fake model's `provider`. */
  sessionOverrides?: Partial<SessionConfig>;
  probeTimeoutMs?: number;
}

/**
 * Copilot chat over `@github/copilot-sdk`, running the user's own `copilot`.
 * Opt-in: only used when chosen in Settings, and never reached as a fallback
 * from another driver. A failed probe falls back to ACP (chat-spawn.ts).
 */
export class CopilotSdkChatDriver implements ChatDriver {
  readonly id = 'copilot_sdk' as const;
  readonly provider = PROVIDER;
  readonly optIn = true;
  private readonly log: Log;

  constructor(private readonly options: CopilotSdkDriverOptions = {}) {
    this.log = options.log ?? (() => undefined);
  }

  /** Connect and read status and login: no session, no prompt, no tokens. */
  async probe(binaryPath: string, env?: Record<string, string>, opts?: { commandPrefix?: string }): Promise<ChatDriverProbe> {
    const timeoutMs = this.options.probeTimeoutMs ?? COPILOT_PROBE_TIMEOUT_MS;
    let server: CopilotServer | undefined;
    let client: CopilotClient | undefined;
    try {
      const startedAt = Date.now();
      server = await launchCopilotServer({ binary: binaryPath, env, commandPrefix: opts?.commandPrefix, timeoutMs });
      const running = server;
      const handshake = (async () => {
        client = await connect(running);
        const [status, auth] = await Promise.all([client.getStatus(), client.getAuthStatus()]);
        return { status, auth };
      })();
      const remaining = Math.max(1, timeoutMs - (Date.now() - startedAt));
      const { status, auth } = await withTimeout(Promise.race([handshake, untilExit(running)]), remaining, 'Copilot handshake');
      const needsLogin = !auth.isAuthenticated && !hasProviderKey({ ...process.env, ...env });
      this.log('info', 'Copilot SDK probe', { binary: binaryPath, cliVersion: status.version, protocolVersion: status.protocolVersion, authenticated: auth.isAuthenticated, authType: auth.authType, needsLogin, elapsedMs: Date.now() - startedAt });
      return {
        handshakeOk: true,
        cliVersion: status.version,
        capabilities: COPILOT_SDK_CAPABILITIES,
        ...(needsLogin && { needsLogin, loginHint: LOGIN_HINT }),
      };
    } catch (err) {
      return { handshakeOk: false, capabilities: COPILOT_SDK_CAPABILITIES, error: err instanceof Error ? err.message : String(err), errorCode: probeErrorCode(err) };
    } finally {
      await client?.forceStop().catch(ignore);
      await server?.kill();
    }
  }

  async start(opts: ChatDriverStartOptions): Promise<ChatDriverSession> {
    const server = await launchCopilotServer({
      binary: opts.binaryPath,
      extraArgs: opts.extraArgs,
      commandPrefix: opts.commandPrefix,
      cwd: opts.cwd,
      env: opts.env,
      timeoutMs: START_TIMEOUT_MS,
      signal: opts.signal,
    });
    // Killing the CLI settles whatever request is pending, so the start rejects.
    const onAbort = (): void => { void server.kill(); };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    let client: CopilotClient | undefined;
    try {
      const opening = (async () => {
        client = await connect(server);
        const [status, auth] = await Promise.all([client.getStatus(), client.getAuthStatus()]);
        // The probe's answer can be cached from before a logout. Handshake and
        // createSession succeed logged out, so only the first send would say.
        if (!auth.isAuthenticated && !hasProviderKey({ ...process.env, ...opts.env })) throw new Error(LOGIN_MESSAGE);
        const session = new CopilotSdkChatSession(client, server, opts, this.log, this.options.sessionOverrides);
        await session.open(status.version);
        return session;
      })();
      const session = await withTimeout(Promise.race([opening, untilExit(server)]), START_TIMEOUT_MS, 'Copilot session start');
      if (opts.signal?.aborted) {
        await session.close();
        throw new Error('Chat start cancelled');
      }
      return session;
    } catch (err) {
      await client?.forceStop().catch(ignore);
      await server.kill();
      throw err;
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
    }
  }
}

/** Register the driver after ACP, so a provider with no choice saved stays on ACP. Returns the unregister function. */
export function registerCopilotSdkChatDriver(register: (driver: ChatDriver) => () => void, log?: Log): () => void {
  return register(new CopilotSdkChatDriver({ log }));
}
