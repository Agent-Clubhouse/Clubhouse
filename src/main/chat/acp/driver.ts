/**
 * Provider-neutral ACP chat driver. A provider supplies an AcpLaunchSpec (how
 * to launch its agent and the few facts ACP can't negotiate); everything else
 * comes from the protocol. Not registered anywhere yet: a provider driver
 * creates one with createAcpChatDriver and registers that.
 *
 * Lifecycle semantics, all from the ACP v1 prompt-turn docs
 * (https://agentclientprotocol.com/protocol/v1/prompt-turn):
 * - A turn is one `session/prompt` request. It ends when the agent answers it
 *   with a stop reason (or an error). ACP has no turn id, so none is reported.
 * - `session/cancel` asks the agent to stop. The turn still ends only when the
 *   agent answers the prompt (with `cancelled`, which it MUST send).
 * - When the transport ends with a prompt unanswered, the outcome is unknown:
 *   the driver reports the exit and fabricates no turn_ended, permission or
 *   question resolution.
 * - The agent may withdraw a permission request or question with
 *   `$/cancel_request`; that is reported as cancelled by the agent.
 */

import { PERMISSION_LEVEL_LABELS, type ChatCapabilities, type ChatDriverId, type PermissionLevel } from '../../../shared/chat/capabilities';
import type { ChatErrorCode, ChatEventDraft, ChatQuestionAnswers, ContentBlock as ChatContentBlock, MessageDelivery } from '../../../shared/chat/events';
import type {
  ChatDriver,
  ChatDriverProbe,
  ChatDriverSession,
  ChatDriverStartOptions,
  ChatResumeTiming,
} from '../../../shared/chat/runtime';
import { AsyncQueue } from '../../orchestrators/adapters/async-queue';
import { RpcError } from '../../orchestrators/adapters/rpc-error';
import { throwIfStartAborted, untilStartAborted } from '../../orchestrators/adapters/start-abort';
import { resolveStructuredSpawn, type StructuredSpawnCommand } from '../../orchestrators/adapters/structured-spawn';
import {
  acpChatCapabilities,
  levelForMode,
  modeChoice,
  negotiate,
  selectOption,
  type AcpLevelPolicy,
  type AcpNegotiated,
  type AcpSessionFacts,
  type AcpStaticClaims,
} from './capabilities';
import { AcpConnection, AcpDisconnectedError, AcpRequestTimeoutError, type AcpConnector, type AcpLog, type AcpTransportEnd } from './connection';
import {
  AcpUpdateMapper,
  configChoices,
  currentModel,
  toAcpMcpServers,
  toAcpPrompt,
  toChatQuestions,
  toElicitationContent,
  toPermissionOptions,
  toStopReason,
} from './mapper';
import {
  ACP_AGENT_METHODS,
  ACP_CLIENT_METHODS,
  ACP_ERROR_CODES,
  ACP_PROTOCOL_VERSION,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
  type InitializeRequest,
  type InitializeResponse,
  type PermissionOption,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SessionNotification,
  type SessionSetup,
  type SessionSetupResponse,
} from './protocol';
import { stdioConnector } from './stdio';

/** What differs between ACP agents. Everything else is protocol. */
export interface AcpLaunchSpec {
  id: ChatDriverId;
  provider: string;
  optIn?: boolean;
  /**
   * Arguments for the agent binary (`ChatDriverStartOptions.binaryPath`).
   * `extraArgs` are the caller's, already validated. `level` is the start's
   * permission level (absent for a probe), for levels set by a launch flag.
   * The driver applies the command prefix and Windows shim handling
   * (resolveStructuredSpawn).
   */
  args(opts: { extraArgs: readonly string[]; level?: PermissionLevel }): string[];
  claims?: AcpStaticClaims;
  /** How permission levels map onto the agent's session modes. Absent: levels aren't applied over ACP. */
  levels?: AcpLevelPolicy;
  /**
   * The provider's own words for signing in, shown when setup fails with
   * `Authentication required` (-32000). Clubhouse never calls `authenticate`.
   */
  loginHint?: string;
  /**
   * A start whose requested model the session doesn't offer. Absent: the
   * session starts on its own model with a notice. 'refuse': the start fails
   * naming the model, so nothing runs on a model the person didn't choose.
   */
  unofferedModel?: 'refuse';
}

export interface AcpDriverDeps {
  log?: AcpLog;
  /** Clubhouse's version for `clientInfo`; the name is always Clubhouse's own. */
  clientVersion?: string;
  /** Replaces the stdio transport (tests connect a scripted agent). */
  connect?(command: StructuredSpawnCommand, opts: { cwd?: string; env?: Record<string, string> }): AcpConnector;
  timeouts?: Partial<AcpTimeouts>;
}

export interface AcpTimeouts {
  initializeMs: number;
  /** session/new, session/resume, session/set_config_option. */
  requestMs: number;
  /** session/load streams the whole history before answering. */
  loadMs: number;
  /** session/close before the process is stopped anyway. */
  closeMs: number;
}

/** Updates or drafts kept during setup before the rest are dropped. */
const MAX_HELD = 1000;

const DEFAULT_TIMEOUTS: AcpTimeouts = { initializeMs: 30_000, requestMs: 60_000, loadMs: 120_000, closeMs: 5_000 };

export function createAcpChatDriver(spec: AcpLaunchSpec, deps: AcpDriverDeps = {}): ChatDriver {
  return new AcpChatDriver(spec, deps);
}

class AcpChatDriver implements ChatDriver {
  readonly id: ChatDriverId;
  readonly provider: string;
  readonly optIn?: boolean;
  private readonly timeouts: AcpTimeouts;

  constructor(private readonly spec: AcpLaunchSpec, private readonly deps: AcpDriverDeps) {
    this.id = spec.id;
    this.provider = spec.provider;
    if (spec.optIn) this.optIn = true;
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...deps.timeouts };
  }

  /** `initialize` only: no session, no prompt, no tokens. */
  async probe(binaryPath: string, env?: Record<string, string>, opts?: { commandPrefix?: string }): Promise<ChatDriverProbe> {
    let conn: AcpConnection | undefined;
    try {
      const command = resolveStructuredSpawn(binaryPath, this.spec.args({ extraArgs: [] }), opts?.commandPrefix);
      conn = new AcpConnection(this.connector(command, { env }), {
        onRequest: () => Promise.reject(new RpcError(ACP_ERROR_CODES.methodNotFound, 'No session')),
        onNotification: () => undefined,
        log: this.deps.log,
      });
      const init = await conn.request<InitializeResponse>(ACP_AGENT_METHODS.initialize, this.initializeParams(), { timeoutMs: this.timeouts.initializeMs });
      checkProtocolVersion(init);
      const n = negotiate(init, true);
      return {
        handshakeOk: true,
        ...(n.agentInfo?.version && { cliVersion: n.agentInfo.version }),
        capabilities: acpChatCapabilities(n, { configOptions: [], commands: false, usage: false }, this.spec.claims),
      };
    } catch (err) {
      return {
        handshakeOk: false,
        capabilities: acpChatCapabilities(negotiate({ protocolVersion: 0 }, false), { configOptions: [], commands: false, usage: false }),
        error: err instanceof Error ? err.message : String(err),
        errorCode: probeErrorCode(err),
      };
    } finally {
      await conn?.close();
    }
  }

  async start(opts: ChatDriverStartOptions): Promise<ChatDriverSession> {
    throwIfStartAborted(opts.signal);
    const command = resolveStructuredSpawn(opts.binaryPath, this.spec.args({ extraArgs: opts.extraArgs ?? [], level: opts.level }), opts.commandPrefix);
    const session = new AcpDriverSession(this.id, this.spec, this.timeouts, this.deps.log ?? (() => undefined));
    session.connect(this.connector(command, { cwd: opts.cwd, env: opts.env }));
    try {
      await untilStartAborted(session.open(opts, this.initializeParams()), opts.signal, () => void session.abort());
      return session;
    } catch (err) {
      // A failed or cancelled start ends the process without waiting on session/close.
      await session.abort();
      throw err;
    }
  }

  private connector(command: StructuredSpawnCommand, opts: { cwd?: string; env?: Record<string, string> }): AcpConnector {
    return this.deps.connect?.(command, opts) ?? stdioConnector({ command, ...opts, log: this.deps.log });
  }

  private initializeParams(): InitializeRequest {
    return {
      protocolVersion: ACP_PROTOCOL_VERSION,
      // Clubhouse serves no fs/* or terminal/* methods; it can show forms.
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, elicitation: { form: {} } },
      clientInfo: { name: 'clubhouse', title: 'Clubhouse', ...(this.deps.clientVersion && { version: this.deps.clientVersion }) },
    };
  }
}

function checkProtocolVersion(init: InitializeResponse | null | undefined): asserts init is InitializeResponse {
  // The agent answers with the version it chose; the client SHOULD disconnect if it can't speak it.
  if (!init || init.protocolVersion !== ACP_PROTOCOL_VERSION) {
    throw new Error(`ACP agent answered protocol version ${init?.protocolVersion ?? 'none'}; Clubhouse speaks ${ACP_PROTOCOL_VERSION}`);
  }
}

function probeErrorCode(err: unknown): ChatDriverProbe['errorCode'] {
  if (err instanceof AcpRequestTimeoutError) return 'rpc_timeout';
  if (err instanceof AcpDisconnectedError) return err.end.spawn ? 'spawn_failed' : 'process_exited';
  if (err instanceof RpcError) return 'protocol_error';
  if (err instanceof Error && 'code' in err && (err.code === 'ENOENT' || err.code === 'EACCES' || err.code === 'EINVAL')) return 'spawn_failed';
  if (err instanceof Error && err.message.startsWith('ACP agent answered protocol version')) return 'protocol_error';
  return 'unknown';
}

interface PendingPermission {
  options: PermissionOption[];
  resolve(response: RequestPermissionResponse): void;
}

interface PendingQuestion {
  request: CreateElicitationRequest;
  resolve(response: CreateElicitationResponse): void;
}

/**
 * One turn: from the first prompt's write until every prompt written into it
 * has been answered. Without the steer claim it only ever holds one prompt.
 */
interface OpenTurn {
  startedAt: number;
  /** Prompts written into this turn and not answered yet. */
  outstanding: number;
}

/** The requested model isn't one the session offers this account. */
export class AcpModelUnavailableError extends Error {
  /** A start error code (chat-spawn): the account, not the driver, so no driver-health failure. */
  readonly code = 'model_unavailable';
  constructor(readonly model: string, detail?: string) {
    super(`${model} is not available for this account${detail ? ` (${detail})` : ''}. Choose another model and start again.`);
    this.name = 'AcpModelUnavailableError';
  }
}

/** Thrown when setup fails for want of a login, in words isLoginRequiredError recognises. */
export class AcpAuthRequiredError extends Error {
  readonly needsLogin = true;
  constructor(readonly loginHint: string, detail: string) {
    super(`Authentication required: ${loginHint} (${detail})`);
  }
}

class AcpDriverSession implements ChatDriverSession {
  private readonly queue = new AsyncQueue<ChatEventDraft>();
  readonly events: AsyncIterable<ChatEventDraft> = this.queue;
  capabilities: ChatCapabilities = acpChatCapabilities(negotiate({ protocolVersion: 0 }, false), { configOptions: [], commands: false, usage: false });
  resumeTiming: ChatResumeTiming | undefined;
  resumeFallback: 'not_found' | undefined;

  private conn!: AcpConnection;
  private negotiated: AcpNegotiated | undefined;
  private sessionId: string | undefined;
  private facts: AcpSessionFacts = { configOptions: [], commands: false, usage: false };
  private readonly mapper: AcpUpdateMapper;
  private readonly claims: AcpStaticClaims;
  private level: PermissionLevel | undefined;
  private turn: OpenTurn | undefined;
  /** Updates for a session id not known yet (they can precede the session/new answer). */
  private early: SessionNotification[] = [];
  /** Drafts from this session's updates during setup, sent after the opening session_info. */
  private heldDrafts: ChatEventDraft[] = [];
  private setupDone = false;
  /** session/load in flight: its updates replay history Clubhouse already has. */
  private replay: { sessionId: string; started: number; firstReplyMs?: number } | undefined;
  private readonly permissions = new Map<string, PendingPermission>();
  private readonly questions = new Map<string, PendingQuestion>();
  private requestCounter = 0;
  private closing = false;
  private ended: Promise<void>;
  private markEnded!: () => void;

  constructor(
    private readonly driverId: ChatDriverId,
    private readonly spec: AcpLaunchSpec,
    private readonly timeouts: AcpTimeouts,
    private readonly log: AcpLog,
  ) {
    this.claims = spec.claims ?? {};
    this.mapper = new AcpUpdateMapper(driverId);
    this.ended = new Promise((resolve) => { this.markEnded = resolve; });
  }

  get nativeSessionId(): string | undefined {
    return this.sessionId;
  }

  /** True once nothing more can reach the agent: closing, or the transport has ended. */
  isClosed(): boolean {
    return this.closing || this.conn.ended !== undefined;
  }

  connect(connector: AcpConnector): void {
    this.conn = new AcpConnection(connector, {
      log: this.log,
      onRequest: (method, params, signal) => this.handleRequest(method, params, signal),
      onNotification: (method, params) => this.handleNotification(method, params),
      onEnd: (end) => this.handleEnd(end),
    });
  }

  async open(opts: ChatDriverStartOptions, init: InitializeRequest): Promise<void> {
    const response = await this.conn.request<InitializeResponse>(ACP_AGENT_METHODS.initialize, init, { timeoutMs: this.timeouts.initializeMs });
    checkProtocolVersion(response);
    const n = negotiate(response, true);
    this.negotiated = n;

    const env = { ...process.env, ...opts.env };
    const { servers, skipped } = toAcpMcpServers(opts.mcpServers, env, opts.mcpHttpEndpoints, n.mcp);
    if (skipped.length) {
      this.log('warn', 'MCP servers the agent cannot take over ACP', { skipped });
      this.push({ type: 'notice', data: { level: 'warn', code: 'mcp_servers_unsupported', message: `This agent can't load these MCP servers in chat: ${skipped.join(', ')}.` } });
    }
    const setup: SessionSetup = {
      cwd: opts.cwd,
      mcpServers: servers,
      ...(opts.systemPrompt && n.systemPrompt && { systemPrompt: { mode: 'append', content: [{ type: 'text', text: opts.systemPrompt }] } }),
    };

    try {
      await this.setUp(opts, setup, n);
    } catch (err) {
      if (this.spec.loginHint && err instanceof RpcError && err.code === ACP_ERROR_CODES.authRequired) throw new AcpAuthRequiredError(this.spec.loginHint, err.message);
      throw err;
    }

    this.capabilities = this.currentCapabilities();
    const choices = configChoices(this.facts.configOptions);
    const model = currentModel(this.facts.configOptions);
    this.push({
      type: 'session_info',
      data: {
        ...(n.agentInfo?.version && { cliVersion: n.agentInfo.version }),
        model: model.modelId ?? null,
        models: choices.models,
        efforts: choices.efforts,
        // With no model id, model_changed can't carry the effort, so it goes here.
        ...(!model.modelId && model.effort && { effort: model.effort }),
      },
    });
    for (const draft of this.heldDrafts.splice(0)) this.push(draft);
  }

  private async setUp(opts: ChatDriverStartOptions, setup: SessionSetup, n: AcpNegotiated): Promise<void> {
    const resumeId = opts.resumeNativeSessionId;
    let setupResponse: SessionSetupResponse | undefined;
    if (resumeId && (n.resume || n.loadSession)) {
      try {
        setupResponse = await this.reopen(resumeId, setup, n);
        this.sessionId = resumeId;
      } catch (err) {
        if (!(err instanceof RpcError) || err.code !== ACP_ERROR_CODES.resourceNotFound) throw err;
        this.log('warn', 'Native session not found; starting a new one', { method: n.resume ? 'session/resume' : 'session/load' });
        this.startFresh('The agent no longer has this conversation, so it continues in a new session without the earlier context.');
      }
    } else if (resumeId) {
      this.startFresh('This agent can\'t reopen conversations, so this one continues in a new session without the earlier context.');
    }
    if (!this.sessionId) {
      setupResponse = await this.conn.request<SessionSetupResponse>(ACP_AGENT_METHODS.sessionNew, setup, { timeoutMs: this.timeouts.requestMs });
      if (typeof setupResponse?.sessionId !== 'string') throw new Error('ACP session/new answered without a sessionId');
      this.sessionId = setupResponse.sessionId;
    }
    if (Array.isArray(setupResponse?.configOptions)) this.facts = { ...this.facts, configOptions: setupResponse.configOptions };
    if (setupResponse?.modes && typeof setupResponse.modes === 'object') this.facts = { ...this.facts, modes: setupResponse.modes };
    // Updates that arrived before the session id was known: their state
    // applies now, in arrival order, ahead of anything later.
    for (const early of this.early.splice(0)) {
      if (early.sessionId === this.sessionId) this.holdUpdate(early.update);
    }
    // Requested settings go in before events flow, so they aren't reported as changes.
    await this.applyRequestedLevel(opts.level);
    await this.applyRequestedModel(opts);
    this.setupDone = true;
  }

  /**
   * The start's level, before any prompt. A level the policy maps to a mode
   * the session doesn't offer refuses the start: running at another level
   * than the one asked for is never silent.
   */
  private async applyRequestedLevel(level: PermissionLevel | undefined): Promise<void> {
    const policy = this.spec.levels;
    if (!level || !policy) {
      if (level) this.log('debug', 'Permission levels are provider policy; none applied over ACP', { level });
      return;
    }
    this.level = level;
    // Set by the launch flag (AcpLaunchSpec.args); nothing to send.
    if (policy.processLevels?.includes(level)) return;
    const mode = policy.mode(level);
    if (mode === undefined) throw new Error(`This agent has no mode for the ${PERMISSION_LEVEL_LABELS[level]} level`);
    const choice = modeChoice(this.facts.configOptions, this.facts.modes);
    if (choice?.current === mode) return;
    if (!choice || !choice.available.includes(mode)) {
      throw new Error(`This agent's session doesn't offer mode "${mode}" for the ${PERMISSION_LEVEL_LABELS[level]} level`);
    }
    await this.setMode(mode);
  }

  private async setMode(mode: string): Promise<void> {
    if (!this.sessionId) throw new Error('The ACP session is not open');
    const choice = modeChoice(this.facts.configOptions, this.facts.modes);
    if (!choice) throw new Error('This agent offers no session modes');
    if (choice.via === 'set_mode') {
      await this.conn.request(ACP_AGENT_METHODS.sessionSetMode, { sessionId: this.sessionId, modeId: mode }, { timeoutMs: this.timeouts.requestMs });
      // set_mode answers with nothing, and the agent may or may not confirm
      // with current_mode_update, so the answer itself counts. updateFacts
      // re-sends capabilities if they changed.
      this.updateFacts({ modes: { ...this.facts.modes!, currentModeId: mode } });
      return;
    }
    const response = await this.conn.request<{ configOptions?: SessionConfigOption[] }>(
      ACP_AGENT_METHODS.sessionSetConfigOption,
      { sessionId: this.sessionId, configId: choice.via.configId, value: mode },
      { timeoutMs: this.timeouts.requestMs },
    );
    if (Array.isArray(response?.configOptions)) this.applyConfig(response.configOptions);
  }

  private currentCapabilities(): ChatCapabilities {
    return acpChatCapabilities(this.negotiated!, this.facts, this.claims, { policy: this.spec.levels, launched: this.level });
  }

  private async reopen(sessionId: string, setup: SessionSetup, n: AcpNegotiated): Promise<SessionSetupResponse> {
    if (n.resume) {
      // Reopens without replaying history.
      return this.conn.request<SessionSetupResponse>(ACP_AGENT_METHODS.sessionResume, { sessionId, ...setup }, { timeoutMs: this.timeouts.requestMs });
    }
    // session/load streams the whole conversation back as session/update
    // before it answers. Clubhouse's transcript already has it, so those
    // updates only refresh session state.
    this.replay = { sessionId, started: Date.now() };
    try {
      return await this.conn.request<SessionSetupResponse>(ACP_AGENT_METHODS.sessionLoad, { sessionId, ...setup }, { timeoutMs: this.timeouts.loadMs });
    } finally {
      this.resumeTiming = {
        loadMs: Date.now() - this.replay.started,
        ...(this.replay.firstReplyMs !== undefined && { firstReplyMs: this.replay.firstReplyMs }),
      };
      this.replay = undefined;
    }
  }

  private startFresh(message: string): void {
    this.resumeFallback = 'not_found';
    this.push({ type: 'notice', data: { level: 'info', code: 'resume_unavailable', message } });
  }

  private async applyRequestedModel(opts: ChatDriverStartOptions): Promise<void> {
    if (opts.model && this.spec.unofferedModel === 'refuse' && selectOption(this.facts.configOptions, 'model')
      && !configChoices(this.facts.configOptions).models.some((m) => m.id === opts.model)) {
      throw new AcpModelUnavailableError(opts.model);
    }
    if (opts.model && this.spec.unofferedModel === 'refuse') {
      // Under 'refuse' the requested model is applied or the start fails: never
      // a session quietly running on a model the person didn't choose.
      await this.setConfig('model', opts.model).catch((err: Error) => {
        this.log('warn', 'Requested model not applied; refusing the start', { error: err.message });
        throw new AcpModelUnavailableError(opts.model!, err.message);
      });
    } else if (opts.model) {
      await this.setConfig('model', opts.model).catch((err: Error) => this.notApplied('model', opts.model!, err));
    }
    if (opts.effort) {
      await this.setConfig('thought_level', opts.effort).catch((err: Error) => this.notApplied('effort', opts.effort!, err));
    }
  }

  private notApplied(what: 'model' | 'effort', value: string, err: Error): void {
    this.log('warn', `Requested ${what} not applied`, { error: err.message });
    this.push({ type: 'notice', data: { level: 'warn', code: `${what}_not_applied`, message: `The agent didn't take the ${what} "${value}": ${err.message}` } });
  }

  // ── Sending ──────────────────────────────────────────────────────────────

  async send(content: ChatContentBlock[], delivery: MessageDelivery): Promise<MessageDelivery> {
    if (this.conn.ended || this.closing || !this.sessionId || !this.negotiated) throw new Error('The ACP session is not open');
    const running = this.turn;
    if (running && !(this.claims.steer && delivery === 'steer')) {
      // Without the steer claim the stable schema has no way in; queue: 'client' means the runtime holds it.
      throw new Error(`Cannot ${delivery} into a running ACP turn; queue it until the turn ends`);
    }
    // A steer that finds the turn already over starts a new one, and says so.
    // Anything that can fail before the prompt is written fails the send itself.
    const prompt = toAcpPrompt(content, this.negotiated.prompt);
    const answer = this.conn.request<PromptResponse>(ACP_AGENT_METHODS.sessionPrompt, { sessionId: this.sessionId, prompt }, { timeoutMs: null });
    if (running) {
      // Documented to join the running turn: no new turn starts, and the turn
      // ends only once this prompt has been answered too.
      running.outstanding++;
      const steered = steerText(content);
      answer.then(
        (response) => this.endTurn(running, response),
        (err: unknown) => this.failTurn(running, err, steered),
      );
      return 'steer';
    }
    const turn: OpenTurn = { startedAt: Date.now(), outstanding: 1 };
    this.turn = turn;
    this.mapper.breakRun();
    this.push({ type: 'turn_started', data: { trigger: 'prompt' } });
    answer.then(
      (response) => this.endTurn(turn, response),
      (err: unknown) => this.failTurn(turn, err),
    );
    return 'prompt';
  }

  private endTurn(turn: OpenTurn, response: PromptResponse | null | undefined): void {
    if (this.turn !== turn) return;
    // A steered turn ends with the answer to its last outstanding prompt.
    if (--turn.outstanding > 0) return;
    this.turn = undefined;
    this.mapper.breakRun();
    const stopReason = toStopReason(response?.stopReason);
    if (!stopReason) {
      this.push({ type: 'protocol_unknown', data: { driver: this.driverId, kind: 'field', name: `stopReason:${String(response?.stopReason)}` } });
    }
    this.push({ type: 'turn_ended', data: { stopReason: stopReason ?? 'error', durationMs: Date.now() - turn.startedAt } });
  }

  private failTurn(turn: OpenTurn, err: unknown, steered?: string): void {
    if (this.turn !== turn) return;
    if (!(err instanceof RpcError)) {
      // The transport ended with the prompt unanswered: the agent may or may
      // not have run it. Left open; handleEnd reports the exit.
      return;
    }
    if (steered !== undefined) {
      // The send already reported 'steer'. The error answer means it may not
      // have reached the turn: say so with its text, and never resend it.
      this.push({
        type: 'notice',
        data: { level: 'warn', code: 'steer_not_delivered', message: `The agent refused a message sent during the turn, so it may not have reached it. It was not resent: "${steered}"` },
      });
    }
    // The agent answered the prompt with an error: a reported failure.
    if (--turn.outstanding > 0) {
      // Another prompt in this turn is still unanswered, so the turn goes on.
      this.push({ type: 'error', data: { code: rpcErrorCode(err), message: err.message, fatal: false } });
      return;
    }
    this.turn = undefined;
    this.mapper.breakRun();
    this.push({ type: 'error', data: { code: rpcErrorCode(err), message: err.message, fatal: false } });
    this.push({ type: 'turn_ended', data: { stopReason: 'error', durationMs: Date.now() - turn.startedAt } });
  }

  /**
   * Sends session/cancel and answers open permission requests and questions
   * as cancelled, as the protocol asks of the client. The turn ends when the
   * agent answers the prompt.
   */
  async interrupt(): Promise<void> {
    if (!this.turn || !this.sessionId || this.conn.ended) return;
    for (const [requestId, pending] of this.permissions) {
      this.permissions.delete(requestId);
      pending.resolve({ outcome: { outcome: 'cancelled' } });
      // The driver's own cancellation, not an answer the user gave (the runtime writes those).
      this.push({ type: 'permission_resolved', data: { requestId, decision: 'cancelled', by: 'agent' } });
    }
    for (const [requestId, pending] of this.questions) {
      this.questions.delete(requestId);
      pending.resolve({ action: 'cancel' });
      this.push({ type: 'question_resolved', data: { requestId, answers: {}, cancelled: true } });
    }
    this.conn.notify(ACP_AGENT_METHODS.sessionCancel, { sessionId: this.sessionId });
  }

  async respondPermission(requestId: string, optionId: string): Promise<void> {
    const pending = this.permissions.get(requestId);
    if (!pending) throw new Error(`No open permission request ${requestId}`);
    if (!pending.options.some((o) => o.optionId === optionId)) throw new Error(`Permission request ${requestId} has no option ${optionId}`);
    this.permissions.delete(requestId);
    pending.resolve({ outcome: { outcome: 'selected', optionId } });
  }

  async answerQuestion(requestId: string, answers: ChatQuestionAnswers): Promise<void> {
    const pending = this.questions.get(requestId);
    if (!pending) throw new Error(`No open question ${requestId}`);
    const content = toElicitationContent(pending.request, answers);
    if (!content) throw new Error(`Answers don't fit question ${requestId}`);
    this.questions.delete(requestId);
    pending.resolve({ action: 'accept', content });
  }

  async setLevel(level: PermissionLevel): Promise<void> {
    if (!this.spec.levels) throw new Error(`This ACP agent has no live permission levels (asked for ${level})`);
    if (!this.capabilities.liveLevels.includes(level)) {
      throw new Error(`This ACP agent can't switch to the ${PERMISSION_LEVEL_LABELS[level]} level without a restart`);
    }
    const mode = this.spec.levels!.mode(level)!;
    await this.setMode(mode);
    this.level = level;
  }

  async setModel(modelId: string, effort?: string | null): Promise<void> {
    // ACP config options have no "unset", so there is no provider default to return to.
    if (effort === null) throw new Error("This agent can't return effort to its default");
    // Callers pass the current model with an effort-only change (the UI and Annex do).
    const model = selectOption(this.facts.configOptions, 'model');
    if (!model) throw new Error('This agent offers no model choice');
    if (!flatValues(model).includes(modelId)) throw new Error(`This agent doesn't offer model "${modelId}"`);
    if (model.currentValue !== modelId) await this.setConfig('model', modelId);
    if (effort) await this.setConfig('thought_level', effort);
  }

  /** Effort alone, for a session with a thought_level option and no model choice (gate 3). */
  async setEffort(effort: string | null): Promise<void> {
    if (effort === null) throw new Error("This agent can't return effort to its default");
    const option = selectOption(this.facts.configOptions, 'thought_level');
    if (!option) throw new Error('This agent offers no effort choice');
    if (!flatValues(option).includes(effort)) throw new Error(`This agent doesn't offer effort "${effort}"`);
    if (option.currentValue !== effort) await this.setConfig('thought_level', effort);
  }

  /** ACP v1 has no compaction method. */
  async compact(): Promise<void> {
    throw new Error('ACP has no compaction request');
  }

  /** Ends the process at once, without asking the agent to close the session. */
  async abort(): Promise<void> {
    this.closing = true;
    await this.conn.close();
    return this.ended;
  }

  async close(): Promise<void> {
    if (this.closing) return this.ended;
    this.closing = true;
    if (!this.conn.ended && this.sessionId && this.negotiated?.close) {
      await this.conn.request(ACP_AGENT_METHODS.sessionClose, { sessionId: this.sessionId }, { timeoutMs: this.timeouts.closeMs })
        .catch((err: Error) => this.log('debug', 'session/close not confirmed', { error: err.message }));
    }
    await this.conn.close();
    return this.ended;
  }

  private async setConfig(category: 'model' | 'thought_level', value: string): Promise<void> {
    if (!this.sessionId) throw new Error('The ACP session is not open');
    const option = selectOption(this.facts.configOptions, category);
    if (!option) throw new Error(category === 'model' ? 'This agent offers no model choice' : 'This agent offers no effort choice');
    const response = await this.conn.request<{ configOptions?: SessionConfigOption[] }>(
      ACP_AGENT_METHODS.sessionSetConfigOption,
      { sessionId: this.sessionId, configId: option.id, value },
      { timeoutMs: this.timeouts.requestMs },
    );
    if (Array.isArray(response?.configOptions)) this.applyConfig(response.configOptions);
  }

  // ── Agent → client ───────────────────────────────────────────────────────

  private handleNotification(method: string, params: unknown): void {
    if (method === ACP_CLIENT_METHODS.sessionUpdate) {
      const note = params as SessionNotification | null;
      if (!note || typeof note.sessionId !== 'string') return;
      if (!this.setupDone) {
        if (this.replay?.sessionId === note.sessionId) {
          this.replay.firstReplyMs ??= Date.now() - this.replay.started;
          this.applyEffectsOnly(note.update);
        } else if (this.sessionId) {
          if (note.sessionId === this.sessionId) this.holdUpdate(note.update);
        } else if (this.early.length < MAX_HELD) {
          // session/new hasn't answered yet; keep it until the id is known.
          this.early.push(note);
        }
        return;
      }
      if (note.sessionId !== this.sessionId) {
        this.log('debug', 'session/update for another session ignored');
        return;
      }
      this.applyUpdate(note.update);
      return;
    }
    if (method === ACP_CLIENT_METHODS.elicitationComplete) return; // URL mode only, which Clubhouse doesn't advertise.
    this.push({ type: 'protocol_unknown', data: { driver: this.driverId, kind: 'notification', name: method } });
  }

  private async handleRequest(method: string, params: unknown, signal: AbortSignal): Promise<unknown> {
    switch (method) {
      case ACP_CLIENT_METHODS.sessionRequestPermission:
        return this.requestPermission(params as RequestPermissionRequest, signal);
      case ACP_CLIENT_METHODS.elicitationCreate:
        return this.elicit(params as CreateElicitationRequest, signal);
      case ACP_CLIENT_METHODS.fsReadTextFile:
      case ACP_CLIENT_METHODS.fsWriteTextFile:
      case ACP_CLIENT_METHODS.terminalCreate:
      case ACP_CLIENT_METHODS.terminalOutput:
      case ACP_CLIENT_METHODS.terminalRelease:
      case ACP_CLIENT_METHODS.terminalWaitForExit:
      case ACP_CLIENT_METHODS.terminalKill:
        // Not advertised in clientCapabilities, so the agent shouldn't ask.
        throw new RpcError(ACP_ERROR_CODES.methodNotFound, `${method} is not supported by this client`);
      default:
        this.push({ type: 'protocol_unknown', data: { driver: this.driverId, kind: 'request', name: method } });
        throw new RpcError(ACP_ERROR_CODES.methodNotFound, `Unknown method ${method}`);
    }
  }

  private requestPermission(req: RequestPermissionRequest, signal: AbortSignal): Promise<RequestPermissionResponse> {
    if (this.closing || req?.sessionId !== this.sessionId || !Array.isArray(req.options)) {
      return Promise.resolve({ outcome: { outcome: 'cancelled' } });
    }
    const requestId = `acp-permission-${++this.requestCounter}`;
    const toolCall = req.toolCall ?? { toolCallId: '' };
    return new Promise((resolve) => {
      this.permissions.set(requestId, { options: req.options, resolve });
      this.onWithdrawn(signal, () => {
        if (!this.permissions.delete(requestId)) return;
        this.push({ type: 'permission_resolved', data: { requestId, decision: 'cancelled', by: 'agent' } });
      });
      this.push({
        type: 'permission_request',
        data: {
          requestId,
          title: typeof toolCall.title === 'string' && toolCall.title ? toolCall.title : 'Permission requested',
          ...(toolCall.toolCallId && { toolCallId: toolCall.toolCallId }),
          ...(typeof toolCall.name === 'string' && { toolName: toolCall.name }),
          ...(toolCall.rawInput !== undefined && { rawInput: toolCall.rawInput }),
          options: toPermissionOptions(req.options),
        },
      });
    });
  }

  private elicit(req: CreateElicitationRequest, signal: AbortSignal): Promise<CreateElicitationResponse> {
    if (this.closing || req?.mode !== 'form' || req.sessionId !== this.sessionId) return Promise.resolve({ action: 'decline' });
    const questions = toChatQuestions(req);
    if (!questions) {
      this.push({ type: 'notice', data: { level: 'warn', code: 'question_unsupported', message: `The agent asked "${req.message}" with a form chat can't show, so it was declined.` } });
      return Promise.resolve({ action: 'decline' });
    }
    const requestId = `acp-question-${++this.requestCounter}`;
    return new Promise((resolve) => {
      this.questions.set(requestId, { request: req, resolve });
      this.onWithdrawn(signal, () => {
        if (!this.questions.delete(requestId)) return;
        this.push({ type: 'question_resolved', data: { requestId, answers: {}, cancelled: true } });
      });
      this.push({
        type: 'question',
        data: { requestId, questions, ...(typeof req.toolCallId === 'string' && { toolCallId: req.toolCallId }) },
      });
    });
  }

  /**
   * `signal` aborts when the agent withdraws the request ($/cancel_request)
   * or the transport ends. Only the first is the agent's decision; after a
   * disconnect the request's outcome is unknown and nothing is reported.
   */
  private onWithdrawn(signal: AbortSignal, withdrawn: () => void): void {
    signal.addEventListener('abort', () => {
      if (!this.conn.ended) withdrawn();
    }, { once: true });
  }

  private applyUpdate(update: unknown): void {
    const { drafts, effects } = this.mapper.map(update);
    for (const draft of drafts) this.push(draft);
    this.applyEffects(effects);
    this.applyModeUpdate(update, true);
  }

  /** `current_mode_update` keeps the session's mode; reported as a level change when one level maps to it. */
  private applyModeUpdate(update: unknown, report: boolean): void {
    const u = update as { sessionUpdate?: unknown; currentModeId?: unknown } | null;
    if (u?.sessionUpdate !== 'current_mode_update' || typeof u.currentModeId !== 'string' || !this.facts.modes) return;
    if (this.facts.modes.currentModeId === u.currentModeId) return;
    this.facts = { ...this.facts, modes: { ...this.facts.modes, currentModeId: u.currentModeId } };
    const level = levelForMode(this.spec.levels, u.currentModeId);
    if (level) this.level = level;
    if (report && level) this.push({ type: 'mode_changed', data: { level, nativeMode: u.currentModeId } });
  }

  /** An update during setup: its state applies now, its events wait for the opening session_info. */
  private holdUpdate(update: unknown): void {
    const { drafts, effects } = this.mapper.map(update);
    this.applyEffects(effects);
    this.applyModeUpdate(update, false);
    if (this.heldDrafts.length + drafts.length <= MAX_HELD) this.heldDrafts.push(...drafts);
  }

  /** A replayed update: session state only, no transcript events. */
  private applyEffectsOnly(update: unknown): void {
    this.applyEffects(this.mapper.map(update).effects);
  }

  private applyEffects(effects: ReturnType<AcpUpdateMapper['map']>['effects']): void {
    if (effects.configOptions) this.applyConfig(effects.configOptions);
    if (effects.commands && !this.facts.commands) this.updateFacts({ commands: true });
    if (effects.usage && !this.facts.usage) this.updateFacts({ usage: true });
  }

  private applyConfig(options: SessionConfigOption[]): void {
    const before = currentModel(this.facts.configOptions);
    const beforeChoices = JSON.stringify(configChoices(this.facts.configOptions));
    this.updateFacts({ configOptions: options });
    if (!this.setupDone) return;
    const after = currentModel(options);
    const choices = configChoices(options);
    if (JSON.stringify(choices) !== beforeChoices) this.push({ type: 'session_info', data: { models: choices.models, efforts: choices.efforts } });
    if (after.modelId && (after.modelId !== before.modelId || after.effort !== before.effort)) {
      this.push({ type: 'model_changed', data: { modelId: after.modelId, ...(after.effort && { effort: after.effort }) } });
    } else if (!after.modelId && after.effort !== before.effort) {
      this.push({ type: 'session_info', data: { effort: after.effort ?? null } });
    }
  }

  private updateFacts(change: Partial<AcpSessionFacts>): void {
    this.facts = { ...this.facts, ...change };
    if (!this.negotiated || !this.setupDone) return;
    const next = this.currentCapabilities();
    const changed: Partial<ChatCapabilities> = {};
    for (const key of Object.keys(next) as Array<keyof ChatCapabilities>) {
      if (JSON.stringify(next[key]) !== JSON.stringify(this.capabilities[key])) (changed as Record<string, unknown>)[key] = next[key];
    }
    this.capabilities = next;
    if (Object.keys(changed).length) this.push({ type: 'session_info', data: { capabilities: changed } });
  }

  private handleEnd(end: AcpTransportEnd): void {
    if (!this.closing) {
      const how = end.error ? `: ${end.error.message}` : end.code !== null ? ` with code ${end.code}` : end.signal ? ` on ${end.signal}` : '';
      this.push({
        type: 'error',
        data: {
          code: end.spawn ? 'spawn_failed' : 'process_exited',
          message: `The ACP agent exited${how}${this.turn ? ' during a turn; whether the turn finished is unknown' : ''}`,
          fatal: true,
        },
      });
    }
    // Open turn, permissions and questions stay unresolved: the provider
    // reported nothing, and the runtime owns what an unknown outcome means.
    this.permissions.clear();
    this.questions.clear();
    this.queue.finish();
    this.markEnded();
  }

  private push(draft: ChatEventDraft): void {
    this.queue.push(draft);
  }
}

/** A steered message's text, for a notice if the agent refuses it. */
function steerText(content: ChatContentBlock[]): string {
  const text = content.map((b) => (b.type === 'text' ? b.text : b.type === 'file' ? `[${b.name ?? b.path}]` : b.type === 'image' ? '[image]' : `[${b.uri}]`)).join(' ').trim();
  return text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
}

function flatValues(option: Extract<SessionConfigOption, { type: 'select' }>): string[] {
  return option.options.flatMap((o) => ('group' in o ? o.options : [o])).map((o) => o.value);
}

function rpcErrorCode(err: RpcError): ChatErrorCode {
  if (err.code === ACP_ERROR_CODES.authRequired) return 'auth_required';
  if (err.code === ACP_ERROR_CODES.invalidParams || err.code === ACP_ERROR_CODES.invalidRequest || err.code === ACP_ERROR_CODES.methodNotFound) return 'protocol_error';
  return 'unknown';
}
