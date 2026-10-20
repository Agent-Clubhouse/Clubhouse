import { AcpClient, RpcError, type AcpClientOpts } from './acp-client';
import { ProcessExitedError } from './ndjson-rpc-base';
import {
  ACP_AGENT_METHODS,
  ACP_CLIENT_METHODS,
  ACP_ERROR_CODES,
  ACP_PROTOCOL_VERSION,
  ACP_STOP_REASONS,
  type AvailableCommand,
  type ClientCapabilities,
  type ContentBlock,
  type Implementation,
  type InitializeResponse,
  type LegacySessionModelState,
  type ListSessionsResponse,
  type LoadSessionResponse,
  type McpServer,
  type Meta,
  type NewSessionResponse,
  type PermissionOption,
  type PromptResponse,
  type RequestPermissionOutcome,
  type RequestPermissionRequest,
  type SessionConfigOption,
  type SessionModeState,
  type SessionUpdate,
  type StopReason,
  type ToolCallUpdate,
  type TurnUsage,
} from './acp-schema';
import { parseSessionUpdate } from './acp-updates';
import { deriveAcpCapabilities, type AcpDriverCapabilities } from './acp-capabilities';
import type { PermissionLevel } from '../../../shared/chat/capabilities';
import type { ChatResumeTiming } from '../../../shared/chat/runtime';

/** How long close() waits for an agent to answer `session/close` before killing it. */
export const SESSION_CLOSE_TIMEOUT_MS = 2_000;

/**
 * Timeouts for `session/load` (or `session/resume`), #2155. Copilot often
 * says nothing for several seconds before it starts replaying (a small
 * session took 9.4s on 1.0.82, 2.6s on 1.0.98), then streams the history:
 *
 * - RESUME_FIRST_REPLY_TIMEOUT_MS: how long to wait for the first replayed
 *   update or the answer.
 * - RESUME_STALL_TIMEOUT_MS: once replay has started, how long it may go
 *   quiet. Each replayed update resets this clock, so a long history loads.
 * - RESUME_MAX_MS: a cap on the whole load, however it is going.
 *
 * Measured on 1.0.82 (#2296): initialize takes ~0.4s and is never the slow
 * part; successful loads answered in 1.6-6.3s, each after Copilot connected
 * the session's MCP servers, while every stall never got that far. The first
 * window is about twice the slowest load seen. Every resume logs
 * `ACP <method> timing` so later changes can be made from data.
 */
export const RESUME_FIRST_REPLY_TIMEOUT_MS = 20_000;
export const RESUME_STALL_TIMEOUT_MS = 10_000;
export const RESUME_MAX_MS = 60_000;

/**
 * Agent-initiated turns (#2191). An agent can start work with no prompt in
 * flight: Copilot 1.0.82 answers `session/prompt` while a background subagent
 * is still running, then starts a new turn on its own when the subagent's
 * completion notice arrives. ACP has no turn around that work and Copilot
 * sends no end signal, so the session opens a turn when the activity starts
 * and closes it once the agent goes quiet:
 *
 * - AGENT_TURN_IDLE_MS: quiet time that ends it, with no tool call open and
 *   no permission request pending.
 * - AGENT_TURN_TOOL_IDLE_MS: quiet time that ends it while a tool call is
 *   still open (a long test run sends nothing until it finishes).
 * - AGENT_TURN_CANCEL_SETTLE_MS: after session/cancel, quiet time that ends it as cancelled.
 *
 * A pending permission request keeps it open until answered.
 */
export const AGENT_TURN_IDLE_MS = 15_000;
export const AGENT_TURN_TOOL_IDLE_MS = 10 * 60_000;
export const AGENT_TURN_CANCEL_SETTLE_MS = 2_000;

/** Updates that mean the agent is working, as opposed to session state it reports. */
const AGENT_ACTIVITY_UPDATES: ReadonlySet<string> = new Set([
  'agent_message_chunk',
  'agent_thought_chunk',
  'tool_call',
  'tool_call_update',
  'plan',
]);

/** `session/load` or `session/resume` didn't finish within the resume timeouts. */
export class AcpResumeStalledError extends Error {
  constructor(
    readonly method: string,
    readonly sessionId: string,
    readonly timeoutMs: number,
    readonly reason: 'no_reply' | 'stalled' | 'too_long' = 'stalled',
  ) {
    super(
      reason === 'too_long'
        ? `ACP ${method} for session ${sessionId} took longer than ${timeoutMs}ms`
        : reason === 'no_reply'
          ? `ACP ${method} for session ${sessionId} got no reply or replay for ${timeoutMs}ms`
          : `ACP ${method} for session ${sessionId} stopped replaying for ${timeoutMs}ms`,
    );
    this.name = 'AcpResumeStalledError';
  }

  /** The stalled load's timings, for telemetry. */
  timing?: ChatResumeTiming;
}

/** One entry of an agent's task list. */
export interface AcpTask {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

/** How an agent's native modes and options map onto Clubhouse's permission ladder. */
export interface AcpPermissionLevels {
  /** Levels `apply` can switch to inside a live session. */
  live: readonly PermissionLevel[];
  /** The agent's own name for each live level, for the UI. */
  names?: Partial<Record<PermissionLevel, string>>;
  /** The level the session's current mode and options amount to, if any. */
  current(state: Readonly<AcpSessionState>): PermissionLevel | undefined;
  /**
   * Switch to `level`. With `force`, send every setting even when the reported
   * options already match: after a resume they describe the old process.
   */
  apply(session: AcpSession, level: PermissionLevel, opts?: { force?: boolean }): Promise<void>;
}

/**
 * Agent-specific adjustments layered on the generic ACP driver. The generic
 * profile changes nothing; copilot-acp.ts supplies Copilot's.
 */
export interface AcpAgentProfile {
  id: string;
  /** Build the capability record from the handshake plus known agent facts. */
  capabilities(init: InitializeResponse): AcpDriverCapabilities;
  /** Rewrite config options wherever they arrive (session/new, updates, set results). */
  normalizeConfigOptions?(options: SessionConfigOption[]): SessionConfigOption[];
  normalizeLegacyModels?(models: LegacySessionModelState): LegacySessionModelState;
  /** Inspect each update before it is applied and emitted; return null to drop it. */
  filterUpdate?(update: SessionUpdate, ctx: { openToolCallIds: ReadonlySet<string> }): SessionUpdate | null;
  /** Permission-ladder mapping. Without one, the session reports no levels. */
  permissionLevels?: AcpPermissionLevels;
  /**
   * Whether the agent still has a native session, checked before resuming it
   * so a missing one goes straight to session/new instead of waiting out a
   * load that may hang (#2155). `undefined` means "can't tell": try the load.
   */
  nativeSessionExists?(sessionId: string, env: Record<string, string | undefined>): Promise<boolean | undefined>;
  /**
   * The agent's plan file for this session among a tool call's paths, if any.
   * Writes to it are shown as a Plan card, not a workspace edit (#2176).
   */
  planFilePath?(paths: readonly string[], ctx: { sessionId: string | null; env: Record<string, string | undefined> }): string | undefined;
  /**
   * The task list after a completed tool call, when that call changed it
   * (Copilot keeps todos in a SQL table, #2176). `undefined`: no change.
   */
  tasksAfterToolCall?(rawInput: unknown, current: readonly AcpTask[]): AcpTask[] | undefined;
  /**
   * What `usage_update.size` measures. ACP says the total window; Copilot
   * sends its input budget (#2178). Default 'total'.
   */
  contextWindow?: 'input' | 'total';
  /** A cost hint for a model option, from the agent's private `_meta`. */
  modelCostHint?(meta: Meta | undefined): string | undefined;
  /**
   * session/new reports a placeholder model: the agent resolves the user's
   * configured one when the first prompt starts (Copilot, #2293). Until then
   * a new session's model is unknown, unless the client chose one.
   */
  newSessionModelUnresolved?: boolean;
}

const KNOWN_CLIENT_METHODS: ReadonlySet<string> = new Set(Object.values(ACP_CLIENT_METHODS));

export const GENERIC_ACP_PROFILE: AcpAgentProfile = {
  id: 'generic',
  capabilities: (init) => deriveAcpCapabilities(init, 'generic'),
};

export type TurnStopReason = StopReason | 'unknown' | 'error';

export type AcpSessionEvent =
  /** A schema-valid update. `replay` is true while `session/load` replays history. */
  | { type: 'update'; sessionId: string; replay: boolean; update: SessionUpdate }
  /** An update this schema version doesn't know, or a malformed one. Skipped, not applied. */
  | { type: 'unknown_update'; sessionId: string; replay: boolean; kind: string; reason: string; raw: unknown }
  | { type: 'permission_request'; sessionId: string; requestId: string; toolCall: ToolCallUpdate; options: PermissionOption[] }
  | { type: 'permission_resolved'; sessionId: string; requestId: string; outcome: RequestPermissionOutcome }
  /**
   * `trigger: 'agent'` is a turn the agent started on its own, with no
   * prompt in flight; it ends with `turn_ended` after the agent goes quiet.
   */
  | { type: 'turn_started'; sessionId: string; trigger: 'prompt' | 'agent' }
  | {
      type: 'turn_ended';
      sessionId: string;
      stopReason: TurnStopReason;
      /** The agent's literal stop reason when it isn't one v1 defines. */
      rawStopReason?: string;
      usage?: TurnUsage;
      error?: string;
      /** Why an `error` turn failed: the process died, the agent returned a JSON-RPC error, or something else. */
      errorKind?: 'process_exited' | 'rpc' | 'other';
      /** JSON-RPC error code, for `errorKind: 'rpc'`. */
      rpcCode?: number;
    }
  /** An agent request or notification method outside the ACP schema. Requests are answered -32601. */
  | { type: 'unknown_method'; kind: 'request' | 'notification'; method: string }
  /** Always the last event. Emitted after a running turn's `turn_ended`, even when the process died mid-turn. */
  | { type: 'exit'; code: number | null; signal: string | null };

export interface AcpSessionState {
  sessionId: string | null;
  modes: SessionModeState | null;
  configOptions: SessionConfigOption[];
  /** Copilot's pre-config-options model list, deduped. Prefer the `model` config option. */
  legacyModels: LegacySessionModelState | null;
  availableCommands: AvailableCommand[];
  title: string | null;
  context: { used: number; size: number; cost?: { amount: number; currency: string } | null } | null;
  turnInFlight: boolean;
  /** The agent is working on its own, outside any prompt (see AGENT_TURN_IDLE_MS). */
  agentTurnInFlight: boolean;
}

export interface AcpSessionOpts extends Pick<AcpClientOpts, 'binary' | 'args' | 'cwd' | 'env' | 'windowsVerbatimArguments' | 'rpcTimeoutMs' | 'onLog'> {
  clientInfo?: Implementation;
  /** Resume timeouts (see RESUME_FIRST_REPLY_TIMEOUT_MS); defaults apply when unset. */
  resumeFirstReplyTimeoutMs?: number;
  resumeStallTimeoutMs?: number;
  resumeMaxMs?: number;
  /** Agent-initiated turn timeouts; defaults AGENT_TURN_IDLE_MS and friends. */
  agentTurnIdleMs?: number;
  agentTurnToolIdleMs?: number;
  agentTurnCancelSettleMs?: number;
  /**
   * Profile to apply. Pass a fixed one, or a function that picks it from the
   * handshake (copilot-acp.ts exports `selectAcpProfile`). Defaults to generic.
   */
  profile?: AcpAgentProfile | ((init: InitializeResponse) => AcpAgentProfile);
  onEvent?: (event: AcpSessionEvent) => void;
}

export interface SessionSetup {
  cwd: string;
  mcpServers?: McpServer[];
  additionalDirectories?: string[];
}

export interface PermissionDecision {
  optionId: string;
}

/**
 * Client capabilities Clubhouse advertises. It serves none of the client-side
 * methods (fs/*, terminal/*, elicitation), and presents notices, compaction
 * progress and boolean config options, all of which are just updates it renders.
 */
export const CLUBHOUSE_ACP_CLIENT_CAPABILITIES: ClientCapabilities = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
  session: {
    notices: {},
    compaction: {},
    configOptions: { boolean: {} },
  },
};

/**
 * One ACP agent process driving one chat session, over the current stable
 * ACP v1 schema (see acp-schema.ts for the pinned version).
 *
 * Works with any ACP agent; agent quirks live in an `AcpAgentProfile`.
 * Request/response plumbing is `AcpClient`; this class owns the session
 * lifecycle, state, permission round-trips and update validation.
 */
export class AcpSession {
  private readonly client: AcpClient;
  private readonly opts: AcpSessionOpts;
  private profile: AcpAgentProfile = GENERIC_ACP_PROFILE;
  private init: InitializeResponse | null = null;
  private caps: AcpDriverCapabilities | null = null;
  private replaying = false;
  /** session/cancel was sent for the turn in flight. */
  private cancelRequested = false;
  private loadRequestId: number | null = null;
  /** Resets the resume stall timer; set while `session/load` or `session/resume` is pending. */
  private resumeActivity: (() => void) | null = null;
  /** What a resume in progress has received so far, for its timing log (#2296). */
  private resumeStats: { notifications: number; inboundChars: number } | null = null;
  /** When `initialize` answered, so the resume timing log can show the gap before the load request. */
  private initializedAt: number | null = null;
  /** The last native session load's timings, however it ended. */
  resumeTiming: ChatResumeTiming | null = null;
  /** Pending while a prompt turn runs; `exit` waits for it so `turn_ended` comes first. */
  private turnSettled: Promise<void> | null = null;
  /** Agents may announce a new session's updates before answering session/new. */
  private creatingSession = false;
  private earlyUpdates: unknown[] = [];
  /** Set by the first prompt: a process has nothing of its own to work on before that. */
  private prompted = false;
  /** The agent-initiated turn in progress, if any. */
  private agentTurn: { timer: ReturnType<typeof setTimeout> | null; cancelled: boolean } | null = null;
  private readonly openToolCalls = new Set<string>();
  /** Compactions reported in progress and not yet finished (compaction_update). */
  private readonly openCompactions = new Set<string>();
  private readonly pendingPermissions = new Map<string, { rpcId: number | string; options: PermissionOption[] }>();
  private readonly loggedUnknownKinds = new Set<string>();
  private readonly state: AcpSessionState = {
    sessionId: null,
    modes: null,
    configOptions: [],
    legacyModels: null,
    availableCommands: [],
    title: null,
    context: null,
    turnInFlight: false,
    agentTurnInFlight: false,
  };

  constructor(opts: AcpSessionOpts) {
    this.opts = opts;
    this.client = new AcpClient({
      binary: opts.binary,
      args: opts.args,
      cwd: opts.cwd,
      env: opts.env,
      windowsVerbatimArguments: opts.windowsVerbatimArguments,
      rpcTimeoutMs: opts.rpcTimeoutMs,
      onLog: opts.onLog,
      initialize: {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: CLUBHOUSE_ACP_CLIENT_CAPABILITIES,
        clientInfo: opts.clientInfo ?? { name: 'clubhouse', version: '1.0.0' },
      },
      onLine: (length) => {
        if (this.resumeStats) this.resumeStats.inboundChars += length;
      },
      onNotification: (method, params) => this.handleNotification(method, params),
      onServerRequest: (id, method, params) => this.handleServerRequest(id, method, params),
      onExit: (code, signal) => this.handleExit(code, signal),
      onResponse: (id) => {
        // Replay is over the moment session/load answers, even if later updates share its chunk.
        if (id === this.loadRequestId) this.replaying = false;
      },
    });
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /** Spawn the agent and complete `initialize`. Rejects if it speaks another protocol version. */
  async start(): Promise<AcpDriverCapabilities> {
    const spawnedAt = Date.now();
    const init = await this.client.start();
    this.initializedAt = Date.now();
    if (init.protocolVersion !== ACP_PROTOCOL_VERSION) {
      this.client.kill();
      throw new Error(`ACP agent negotiated protocol version ${init.protocolVersion}; Clubhouse supports ${ACP_PROTOCOL_VERSION}`);
    }
    this.init = init;
    const p = this.opts.profile;
    this.profile = typeof p === 'function' ? p(init) : p ?? GENERIC_ACP_PROFILE;
    this.caps = this.profile.capabilities(init);
    this.log('info', 'ACP session driver ready', {
      profile: this.profile.id,
      agent: init.agentInfo?.name,
      version: init.agentInfo?.version,
      // Advertised whether or not the user is logged in; a later "Authentication required" is the real signal.
      authMethods: (init.authMethods ?? []).map((m) => m.id),
      loadSession: init.agentCapabilities?.loadSession === true,
      initializeMs: this.initializedAt - spawnedAt,
    });
    return this.caps;
  }

  get capabilities(): AcpDriverCapabilities {
    if (!this.caps) throw new Error('AcpSession not started');
    return this.caps;
  }

  get initializeResponse(): InitializeResponse | null {
    return this.init;
  }

  get profileId(): string {
    return this.profile.id;
  }

  get agentProfile(): AcpAgentProfile {
    return this.profile;
  }

  getState(): Readonly<AcpSessionState> {
    return this.state;
  }

  get alive(): boolean {
    return this.client.alive;
  }

  getStderr(): string {
    return this.client.getStderr();
  }

  async authenticate(methodId: string): Promise<void> {
    await this.client.request(ACP_AGENT_METHODS.authenticate, { methodId });
  }

  async newSession(setup: SessionSetup): Promise<AcpSessionState> {
    this.requireStarted();
    this.creatingSession = true;
    let res: NewSessionResponse;
    try {
      res = (await this.client.request(ACP_AGENT_METHODS.sessionNew, this.sessionParams(setup))) as NewSessionResponse;
    } finally {
      this.creatingSession = false;
    }
    const early = this.earlyUpdates;
    this.earlyUpdates = [];
    if (!res || typeof res.sessionId !== 'string') throw new Error('session/new returned no sessionId');
    this.state.sessionId = res.sessionId;
    this.applySessionSetup(res);
    for (const params of early) this.handleNotification(ACP_CLIENT_METHODS.sessionUpdate, params);
    return this.state;
  }

  /**
   * Reopen an earlier session. Uses `session/resume` (no replay) when the
   * agent supports it, else `session/load`, whose history replay is emitted
   * with `replay: true`. Clubhouse's own transcript owns history, so callers
   * normally ignore replayed updates.
   */
  async resumeSession(sessionId: string, setup: SessionSetup): Promise<{ method: 'resume' | 'load' }> {
    const caps = this.requireStarted();
    if (caps.resume === 'resume') {
      this.state.sessionId = sessionId;
      try {
        const res = (await this.withStallTimeout(ACP_AGENT_METHODS.sessionResume, sessionId, this.client.request(ACP_AGENT_METHODS.sessionResume, {
          sessionId,
          ...this.sessionParams(setup),
        }, { timeoutMs: null }))) as LoadSessionResponse;
        this.applySessionSetup(res ?? {});
      } catch (err) {
        this.resetSessionState();
        throw err;
      }
      return { method: 'resume' };
    }
    if (caps.resume === 'load') {
      await this.loadSession(sessionId, setup);
      return { method: 'load' };
    }
    throw new Error('ACP agent supports neither session/resume nor session/load');
  }

  async loadSession(sessionId: string, setup: SessionSetup): Promise<AcpSessionState> {
    this.requireStarted();
    this.state.sessionId = sessionId;
    this.replaying = true;
    try {
      const pending = this.client.request(ACP_AGENT_METHODS.sessionLoad, {
        sessionId,
        ...this.sessionParams(setup),
      }, { timeoutMs: null });
      this.loadRequestId = this.client.lastRequestId;
      const res = (await this.withStallTimeout(ACP_AGENT_METHODS.sessionLoad, sessionId, pending)) as LoadSessionResponse;
      this.applySessionSetup(res ?? {});
    } catch (err) {
      // A load can replay part of the history and still fail. Leave nothing of
      // that session behind, so a fallback session/new starts clean.
      this.resetSessionState();
      throw err;
    } finally {
      this.replaying = false;
      this.loadRequestId = null;
      // Replayed tool calls are history, not work in progress.
      this.openToolCalls.clear();
      this.openCompactions.clear();
    }
    return this.state;
  }

  /**
   * Reject with AcpResumeStalledError when `pending` gets no answer or replay
   * within the first-reply window, goes quiet for the stall window once replay
   * has started, or runs past the overall cap. The request itself is left to
   * the process: callers kill it, which settles it.
   */
  private withStallTimeout<T>(method: string, sessionId: string, pending: Promise<T>): Promise<T> {
    const firstMs = this.opts.resumeFirstReplyTimeoutMs ?? RESUME_FIRST_REPLY_TIMEOUT_MS;
    const stallMs = this.opts.resumeStallTimeoutMs ?? RESUME_STALL_TIMEOUT_MS;
    const maxMs = this.opts.resumeMaxMs ?? RESUME_MAX_MS;
    const requestedAt = Date.now();
    let firstActivityAt: number | null = null;
    const stats = { notifications: 0, inboundChars: 0 };
    this.resumeStats = stats;
    // Timings and counts only, never content: what a slow resume waited on (#2296).
    let reported = false;
    const report = (outcome: string) => {
      // A timed-out request settles again later, when the caller kills the process.
      if (reported) return;
      reported = true;
      if (this.resumeStats === stats) this.resumeStats = null;
      // One reading, so the session's timing and the log line agree (#2401).
      const totalMs = Date.now() - requestedAt;
      this.resumeTiming = {
        loadMs: totalMs,
        ...(firstActivityAt !== null && { firstReplyMs: firstActivityAt - requestedAt }),
      };
      this.log(outcome === 'ok' ? 'info' : 'warn', `ACP ${method} timing`, {
        sessionId,
        outcome,
        initializeToRequestMs: this.initializedAt === null ? null : requestedAt - this.initializedAt,
        firstActivityMs: firstActivityAt === null ? null : firstActivityAt - requestedAt,
        totalMs,
        // Notifications received during the load: the replayed history, plus anything else the agent sent.
        notifications: stats.notifications,
        // Characters of every stdout line received during the load, the response included.
        inboundChars: stats.inboundChars,
        windowsMs: { firstReply: firstMs, stall: stallMs, max: maxMs },
      });
    };
    return new Promise<T>((resolve, reject) => {
      let idle: ReturnType<typeof setTimeout>;
      let heard = false;
      const fail = (timeoutMs: number, reason: AcpResumeStalledError['reason']) => {
        settle();
        report(reason);
        this.log('warn', `ACP ${method} timed out`, { sessionId, timeoutMs, reason });
        const stalled = new AcpResumeStalledError(method, sessionId, timeoutMs, reason);
        if (this.resumeTiming) stalled.timing = this.resumeTiming;
        reject(stalled);
      };
      const arm = () => {
        clearTimeout(idle);
        const ms = heard ? stallMs : firstMs;
        const reason = heard ? 'stalled' : 'no_reply';
        idle = setTimeout(() => fail(ms, reason), ms);
      };
      const onActivity = () => {
        stats.notifications++;
        firstActivityAt ??= Date.now();
        heard = true;
        arm();
      };
      const cap = setTimeout(() => fail(maxMs, 'too_long'), maxMs);
      const settle = () => {
        clearTimeout(idle);
        clearTimeout(cap);
        if (this.resumeActivity === onActivity) this.resumeActivity = null;
      };
      this.resumeActivity = onActivity;
      arm();
      pending.then(
        (value) => { settle(); report('ok'); resolve(value); },
        (err: unknown) => { settle(); report('error'); reject(err); },
      );
    });
  }

  async listSessions(opts: { cwd?: string; cursor?: string } = {}): Promise<ListSessionsResponse> {
    const caps = this.requireStarted();
    if (!caps.listSessions) throw new Error('ACP agent does not support session/list');
    const res = (await this.client.request(ACP_AGENT_METHODS.sessionList, {
      ...(opts.cwd && { cwd: opts.cwd }),
      ...(opts.cursor && { cursor: opts.cursor }),
    })) as ListSessionsResponse;
    const sessions = Array.isArray(res?.sessions) ? res.sessions : [];
    // Some agents (Copilot) list every session on the machine; keep the filter honest.
    const filtered = opts.cwd ? sessions.filter((s) => s.cwd === opts.cwd) : sessions;
    return { sessions: filtered, nextCursor: res?.nextCursor ?? null };
  }

  /** Close the session if the agent supports it, then stop the process. */
  async close(): Promise<void> {
    const sessionId = this.state.sessionId;
    if (sessionId && this.caps?.closeSession && this.client.alive) {
      try {
        // Bounded: the process is killed right after either way, so an agent
        // that never answers must not hold Stop for the full RPC timeout.
        await this.client.request(ACP_AGENT_METHODS.sessionClose, { sessionId }, { timeoutMs: SESSION_CLOSE_TIMEOUT_MS });
      } catch (err) {
        this.log('warn', 'session/close failed', { error: (err as Error).message });
      }
    }
    this.kill();
  }

  kill(): void {
    this.answerPendingPermissionsCancelled();
    this.endAgentTurn('cancelled');
    this.client.kill();
  }

  // ── Turns ────────────────────────────────────────────────────────────────

  /**
   * Send one user turn. Resolves when the agent ends the turn, however long
   * that takes (no RPC timeout). One turn at a time: v1 has no queueing or
   * steering, so callers queue client-side.
   */
  async prompt(prompt: string | ContentBlock[]): Promise<{ stopReason: TurnStopReason; rawStopReason?: string; usage?: TurnUsage }> {
    const sessionId = this.requireSession();
    if (this.state.turnInFlight) throw new Error('A prompt turn is already in flight; cancel it or wait');
    const blocks: ContentBlock[] = typeof prompt === 'string' ? [{ type: 'text', text: prompt }] : prompt;

    // A prompt during an agent-initiated turn closes it: what follows belongs to
    // the prompt. Callers normally queue until it ends (the chat runtime does).
    // One the user already stopped still reads as stopped (#2158).
    this.endAgentTurn(this.agentTurn?.cancelled ? 'cancelled' : 'end_turn');
    this.prompted = true;
    this.state.turnInFlight = true;
    this.cancelRequested = false;
    let settle: () => void = () => undefined;
    this.turnSettled = new Promise<void>((resolve) => { settle = resolve; });
    this.emit({ type: 'turn_started', sessionId, trigger: 'prompt' });
    try {
      const res = (await this.client.request(
        ACP_AGENT_METHODS.sessionPrompt,
        { sessionId, prompt: blocks },
        { timeoutMs: null },
      )) as PromptResponse;
      let raw = typeof res?.stopReason === 'string' ? res.stopReason : '';
      // The user stopped this turn. Some agents (Copilot) still answer
      // end_turn after session/cancel; report what happened (#2158).
      if (this.cancelRequested && raw !== 'cancelled') {
        this.log('info', 'Turn ended after cancel; reporting it as cancelled', { stopReason: raw });
        raw = 'cancelled';
      }
      const known = (ACP_STOP_REASONS as readonly string[]).includes(raw);
      const stopReason: TurnStopReason = known ? (raw as StopReason) : 'unknown';
      const usage = readTurnUsage(res);
      if (!known) this.log('warn', 'Unknown ACP stopReason', { stopReason: raw });
      this.emit({
        type: 'turn_ended',
        sessionId,
        stopReason,
        ...(!known && { rawStopReason: raw }),
        ...(usage && { usage }),
      });
      return { stopReason, ...(!known && { rawStopReason: raw }), ...(usage && { usage }) };
    } catch (err) {
      const message = (err as Error).message;
      const errorKind = err instanceof ProcessExitedError ? 'process_exited' : err instanceof RpcError ? 'rpc' : 'other';
      this.emit({
        type: 'turn_ended',
        sessionId,
        stopReason: 'error',
        error: message,
        errorKind,
        ...(err instanceof RpcError && { rpcCode: err.code }),
      });
      throw err;
    } finally {
      this.state.turnInFlight = false;
      this.cancelRequested = false;
      this.openToolCalls.clear();
      this.openCompactions.clear();
      this.turnSettled = null;
      settle();
    }
  }

  /**
   * Cancel the running turn. The agent answers the pending `session/prompt`
   * with `stopReason: "cancelled"`. Per spec, every pending permission request
   * is answered `cancelled` first. An agent-initiated turn has no prompt to
   * answer, so it ends as cancelled once the agent has been quiet for
   * AGENT_TURN_CANCEL_SETTLE_MS.
   */
  cancel(): void {
    const sessionId = this.state.sessionId;
    if (!sessionId) return;
    if (this.state.turnInFlight) this.cancelRequested = true;
    this.answerPendingPermissionsCancelled();
    this.client.notify(ACP_AGENT_METHODS.sessionCancel, { sessionId });
    if (this.agentTurn) {
      this.agentTurn.cancelled = true;
      this.armAgentTurnTimer();
    }
  }

  // ── Modes and config options ─────────────────────────────────────────────

  async setMode(modeId: string): Promise<void> {
    const sessionId = this.requireSession();
    const modeOption = this.state.configOptions.find((o) => o.category === 'mode' && o.type === 'select');
    if (this.state.modes) {
      await this.client.request(ACP_AGENT_METHODS.sessionSetMode, { sessionId, modeId });
      this.state.modes = { ...this.state.modes, currentModeId: modeId };
    } else if (modeOption) {
      await this.setConfigOption(modeOption.id, modeId);
    } else {
      throw new Error('ACP agent exposes no session modes');
    }
  }

  async setConfigOption(configId: string, value: string | boolean): Promise<SessionConfigOption[]> {
    const sessionId = this.requireSession();
    const params = typeof value === 'boolean'
      ? { sessionId, configId, type: 'boolean', value }
      : { sessionId, configId, value };
    const res = (await this.client.request(ACP_AGENT_METHODS.sessionSetConfigOption, params)) as { configOptions?: SessionConfigOption[] };
    if (Array.isArray(res?.configOptions)) this.setConfigOptions(res.configOptions);
    return this.state.configOptions;
  }

  /** Switch model through the `model` config option, or Copilot's legacy `session/set_model`. */
  async setModel(modelId: string): Promise<void> {
    const sessionId = this.requireSession();
    const option = this.state.configOptions.find((o) => o.category === 'model' && o.type === 'select')
      ?? this.state.configOptions.find((o) => o.id === 'model' && o.type === 'select');
    if (option) {
      await this.setConfigOption(option.id, modelId);
      return;
    }
    if (this.state.legacyModels) {
      // Unstable in the schema; only reached for agents that never sent config options.
      await this.client.request('session/set_model', { sessionId, modelId });
      this.state.legacyModels = { ...this.state.legacyModels, currentModelId: modelId };
      return;
    }
    throw new Error('ACP agent exposes no model selection');
  }

  // ── Permissions ──────────────────────────────────────────────────────────

  /** Answer a `permission_request` event with one of its options, or `'cancelled'`. */
  respondToPermission(requestId: string, decision: PermissionDecision | 'cancelled'): void {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) throw new Error(`No pending permission request ${requestId}`);
    let outcome: RequestPermissionOutcome;
    if (decision === 'cancelled') {
      outcome = { outcome: 'cancelled' };
    } else {
      if (!pending.options.some((o) => o.optionId === decision.optionId)) {
        throw new Error(`Option ${decision.optionId} was not offered for permission request ${requestId}`);
      }
      outcome = { outcome: 'selected', optionId: decision.optionId };
    }
    this.pendingPermissions.delete(requestId);
    this.client.respond(pending.rpcId, { outcome });
    this.emit({ type: 'permission_resolved', sessionId: this.state.sessionId ?? '', requestId, outcome });
    if (this.agentTurn) this.armAgentTurnTimer();
  }

  get pendingPermissionIds(): string[] {
    return [...this.pendingPermissions.keys()];
  }

  // ── Inbound ──────────────────────────────────────────────────────────────

  private handleNotification(method: string, params: unknown): void {
    this.resumeActivity?.();
    if (method !== ACP_CLIENT_METHODS.sessionUpdate) {
      this.log('info', 'Ignoring ACP notification', { method });
      if (!KNOWN_CLIENT_METHODS.has(method)) this.emit({ type: 'unknown_method', kind: 'notification', method });
      return;
    }
    const p = params as { sessionId?: unknown; update?: unknown } | undefined;
    const sessionId = typeof p?.sessionId === 'string' ? p.sessionId : '';
    if (!this.state.sessionId && this.creatingSession) {
      this.earlyUpdates.push(params);
      return;
    }
    if (!this.state.sessionId || sessionId !== this.state.sessionId) {
      this.log('warn', 'session/update for another session', { sessionId, current: this.state.sessionId });
      return;
    }

    const parsed = parseSessionUpdate(p?.update);
    if (parsed.result === 'skipped') {
      if (!this.loggedUnknownKinds.has(parsed.kind)) {
        this.loggedUnknownKinds.add(parsed.kind);
        this.log('warn', 'Skipping unsupported ACP session/update', { kind: parsed.kind, reason: parsed.reason });
      }
      this.emit({ type: 'unknown_update', sessionId, replay: this.replaying, kind: parsed.kind, reason: parsed.reason, raw: parsed.raw });
      return;
    }

    const update = this.profile.filterUpdate
      ? this.profile.filterUpdate(parsed.update, { openToolCallIds: this.openToolCalls })
      : parsed.update;
    if (!update) return;

    // A compaction starting is work (auto compaction can follow an agent-initiated
    // turn's tools); its later statuses only settle it and never open a turn.
    const compactionStarted = update.sessionUpdate === 'compaction_update' && update.status === 'in_progress';
    if (!this.replaying && (AGENT_ACTIVITY_UPDATES.has(update.sessionUpdate) || compactionStarted)) this.noteAgentActivity();
    this.applyUpdate(update);
    this.emit({ type: 'update', sessionId, replay: this.replaying, update });
    // A tool call or compaction that just finished may have been the last thing holding the turn open.
    if (this.agentTurn && (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update' || update.sessionUpdate === 'compaction_update')) {
      this.armAgentTurnTimer();
    }
  }

  private applyUpdate(update: SessionUpdate): void {
    switch (update.sessionUpdate) {
      case 'tool_call':
      case 'tool_call_update':
        if (update.status === 'completed' || update.status === 'failed') this.openToolCalls.delete(update.toolCallId);
        else if (update.sessionUpdate === 'tool_call' || update.status) this.openToolCalls.add(update.toolCallId);
        break;
      case 'available_commands_update':
        this.state.availableCommands = update.availableCommands;
        break;
      case 'current_mode_update':
        if (this.state.modes) this.state.modes = { ...this.state.modes, currentModeId: update.currentModeId };
        break;
      case 'config_option_update':
        this.setConfigOptions(update.configOptions);
        // The emitted update should carry the normalized list too.
        update.configOptions = this.state.configOptions;
        break;
      case 'session_info_update':
        if (update.title !== undefined) this.state.title = update.title ?? null;
        break;
      case 'usage_update':
        this.state.context = { used: update.used, size: update.size, ...(update.cost !== undefined && { cost: update.cost }) };
        break;
      case 'compaction_update':
        if (this.replaying) break;
        if (update.status === 'in_progress') this.openCompactions.add(update.compactionId);
        else this.openCompactions.delete(update.compactionId);
        break;
      default:
        break;
    }
  }

  private handleServerRequest(id: number | string, method: string, params: unknown): void {
    if (method === ACP_CLIENT_METHODS.sessionRequestPermission) {
      const req = params as RequestPermissionRequest | undefined;
      const sessionId = typeof req?.sessionId === 'string' ? req.sessionId : '';
      if (!req || !Array.isArray(req.options) || !req.toolCall || sessionId !== this.state.sessionId) {
        this.client.respondWithError(id, ACP_ERROR_CODES.invalidParams, 'Malformed or foreign session/request_permission');
        return;
      }
      if (this.state.turnInFlight === false && !this.replaying) {
        this.noteAgentActivity();
        if (!this.agentTurn) this.log('warn', 'Permission request outside a prompt turn', { id });
      }
      const requestId = String(id);
      this.pendingPermissions.set(requestId, { rpcId: id, options: req.options });
      // Waiting on the user, not on the agent: don't let the quiet timer end the turn.
      if (this.agentTurn) this.armAgentTurnTimer();
      this.emit({ type: 'permission_request', sessionId, requestId, toolCall: req.toolCall, options: req.options });
      return;
    }

    // fs/*, terminal/* and elicitation/* are not advertised, so a conforming
    // agent never sends them. Answer anyway: an unanswered request blocks the turn.
    this.client.respondWithError(id, ACP_ERROR_CODES.methodNotFound, `Method not found: ${method}`, { method });
    if (!KNOWN_CLIENT_METHODS.has(method)) this.emit({ type: 'unknown_method', kind: 'request', method });
  }

  private handleExit(code: number | null, signal: string | null): void {
    this.pendingPermissions.clear();
    if (this.agentTurn) {
      this.endAgentTurn('error', { error: `ACP agent exited (code ${code ?? 'null'}, signal ${signal ?? 'null'})`, errorKind: 'process_exited' });
    }
    // Pending requests were rejected just before this, but prompt()'s catch runs
    // on a later microtask. Let its turn_ended go out before exit.
    const emitExit = () => this.emit({ type: 'exit', code, signal });
    if (this.turnSettled) void this.turnSettled.then(emitExit);
    else emitExit();
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  // ── Agent-initiated turns ────────────────────────────────────────────────

  /**
   * The agent is working. Outside a prompt turn, that opens an agent-initiated
   * turn (or keeps the open one going). Before the first prompt, a process
   * has no work of its own, so anything then is a resume's replay tail.
   */
  private noteAgentActivity(): void {
    if (this.state.turnInFlight || !this.prompted || !this.state.sessionId) return;
    if (!this.agentTurn) {
      this.agentTurn = { timer: null, cancelled: false };
      this.state.agentTurnInFlight = true;
      this.log('info', 'Agent started work with no prompt in flight; opening an agent-initiated turn');
      this.emit({ type: 'turn_started', sessionId: this.state.sessionId, trigger: 'agent' });
    }
    this.armAgentTurnTimer();
  }

  /** (Re)start the quiet timer that ends the agent-initiated turn. */
  private armAgentTurnTimer(): void {
    const turn = this.agentTurn;
    if (!turn) return;
    if (turn.timer) clearTimeout(turn.timer);
    turn.timer = null;
    let ms: number;
    if (turn.cancelled) {
      ms = this.opts.agentTurnCancelSettleMs ?? AGENT_TURN_CANCEL_SETTLE_MS;
    } else if (this.pendingPermissions.size > 0) {
      return;
    } else if (this.openToolCalls.size > 0 || this.openCompactions.size > 0) {
      // A long test run or a compaction sends nothing until it finishes.
      ms = this.opts.agentTurnToolIdleMs ?? AGENT_TURN_TOOL_IDLE_MS;
    } else {
      ms = this.opts.agentTurnIdleMs ?? AGENT_TURN_IDLE_MS;
    }
    turn.timer = setTimeout(() => {
      if (this.agentTurn !== turn) return;
      this.endAgentTurn(turn.cancelled ? 'cancelled' : 'end_turn');
    }, ms);
  }

  private endAgentTurn(
    stopReason: TurnStopReason,
    failure?: { error: string; errorKind: 'process_exited' | 'other' },
  ): void {
    const turn = this.agentTurn;
    if (!turn) return;
    if (turn.timer) clearTimeout(turn.timer);
    this.agentTurn = null;
    this.state.agentTurnInFlight = false;
    this.openToolCalls.clear();
    this.openCompactions.clear();
    this.emit({ type: 'turn_ended', sessionId: this.state.sessionId ?? '', stopReason, ...failure });
  }

  private resetSessionState(): void {
    Object.assign(this.state, {
      sessionId: null,
      modes: null,
      configOptions: [],
      legacyModels: null,
      availableCommands: [],
      title: null,
      context: null,
    });
    this.openToolCalls.clear();
    this.openCompactions.clear();
  }

  private applySessionSetup(res: LoadSessionResponse): void {
    if (res.modes && Array.isArray(res.modes.availableModes)) this.state.modes = res.modes;
    if (Array.isArray(res.configOptions)) this.setConfigOptions(res.configOptions);
    if (res.models && Array.isArray(res.models.availableModels)) {
      this.state.legacyModels = this.profile.normalizeLegacyModels
        ? this.profile.normalizeLegacyModels(res.models)
        : res.models;
    }
  }

  private setConfigOptions(options: SessionConfigOption[]): void {
    this.state.configOptions = this.profile.normalizeConfigOptions
      ? this.profile.normalizeConfigOptions(options)
      : options;
  }

  private sessionParams(setup: SessionSetup): Record<string, unknown> {
    return {
      cwd: setup.cwd,
      mcpServers: setup.mcpServers ?? [],
      ...(setup.additionalDirectories?.length && { additionalDirectories: setup.additionalDirectories }),
    };
  }

  private answerPendingPermissionsCancelled(): void {
    for (const requestId of [...this.pendingPermissions.keys()]) {
      this.respondToPermission(requestId, 'cancelled');
    }
  }

  private requireStarted(): AcpDriverCapabilities {
    if (!this.caps) throw new Error('AcpSession not started');
    return this.caps;
  }

  private requireSession(): string {
    this.requireStarted();
    if (!this.state.sessionId) throw new Error('No ACP session; call newSession or resumeSession first');
    return this.state.sessionId;
  }

  private emit(event: AcpSessionEvent): void {
    this.opts.onEvent?.(event);
  }

  private log(level: 'debug' | 'info' | 'warn' | 'error', message: string, meta?: Record<string, unknown>): void {
    this.opts.onLog?.(level, message, meta);
  }
}

/** Per-turn usage: Copilot puts it on the result; the draft RFD puts it under `_meta`. */
function readTurnUsage(res: PromptResponse | undefined): TurnUsage | undefined {
  const candidate = res?.usage ?? (res?._meta as { usage?: unknown } | null | undefined)?.usage;
  if (!candidate || typeof candidate !== 'object') return undefined;
  const out: TurnUsage = {};
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'thoughtTokens', 'cachedReadTokens', 'cachedWriteTokens'] as const) {
    const v = (candidate as Record<string, unknown>)[key];
    if (typeof v === 'number') out[key] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

export { RpcError };
