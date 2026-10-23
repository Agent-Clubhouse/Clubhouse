import type { ChatCapabilities, ChatDriverId, PermissionLevel } from '../../../shared/chat/capabilities';
import type { ChatEventDraft, ContentBlock, MessageDelivery } from '../../../shared/chat/events';
import type {
  ChatDriver,
  ChatDriverProbe,
  ChatMediaAssetResult,
  ChatDriverSession,
  ChatDriverStartOptions,
  ChatResumeTiming,
} from '../../../shared/chat/runtime';
import { AsyncQueue } from './async-queue';
import { RpcError } from './acp-client';
import { ACP_ERROR_CODES } from './acp-schema';
import { AcpResumeStalledError, AcpSession, GENERIC_ACP_PROFILE, type AcpAgentProfile, type AcpSessionEvent, type AcpSessionOpts } from './acp-session';
import { AcpChatEventMapper, toAcpMcpServers, toAcpPrompt, toChatCapabilities } from './acp-chat-mapper';
import type { InitializeResponse } from './acp-schema';
import { resolveStructuredSpawn, type StructuredSpawnCommand } from './structured-spawn';
import { COPILOT_ACP_TESTED_RANGE, copilotVersionStatus, resolveCopilotAcpSpawn, selectAcpProfile } from './copilot-acp';

type Log = (level: 'debug' | 'info' | 'warn' | 'error', message: string, meta?: Record<string, unknown>) => void;

/** What differs between ACP agents at launch; everything else is the generic driver. */
export interface AcpLaunchSpec {
  id: ChatDriverId;
  provider: string;
  spawn(opts: { binary: string; extraArgs?: string[]; commandPrefix?: string }): StructuredSpawnCommand;
  profile: AcpAgentProfile | ((init: InitializeResponse) => AcpAgentProfile);
  /** Extra drafts after the handshake, e.g. an untested-version notice. */
  handshakeNotices?(init: InitializeResponse): ChatEventDraft[];
}

const CLOSE_GRACE_MS = 5_000;

class AcpChatDriverSession implements ChatDriverSession {
  readonly events: AsyncIterable<ChatEventDraft>;
  readonly capabilities: ChatCapabilities;
  resumeTiming: ChatResumeTiming | undefined;
  private exited = false;
  private readonly exitWaiters: Array<() => void> = [];
  /** Called after an effort is chosen in the session (set once mapping starts). */
  onEffortChosen: (() => void) | undefined;
  /** Called after a model is chosen in the session (set once mapping starts). */
  onModelChosen: (() => void) | undefined;
  /** Why a requested resume started fresh instead (see ChatDriverSession). */
  resumeFallback: 'not_found' | 'stalled' | undefined;
  /** The profile's binary-asset lookup for this session, when it has one (#2421). */
  private readonly assets: ((sessionId: string | null, assetId: string) => Promise<ChatMediaAssetResult>) | undefined;

  constructor(
    private readonly session: AcpSession,
    queue: AsyncQueue<ChatEventDraft>,
    capabilities: ChatCapabilities,
    private readonly log: Log,
    env: Record<string, string | undefined> = {},
  ) {
    this.events = queue;
    this.capabilities = capabilities;
    this.assets = session.agentProfile.binaryAssets?.(env);
  }

  /** Bytes for an asset id, from this session's own store only: the id it was opened with, never a path. */
  async resolveMediaAsset(assetId: string): Promise<ChatMediaAssetResult> {
    if (!this.assets) return { ok: false, reason: 'unsupported' };
    return this.assets(this.session.getState().sessionId, assetId);
  }

  get nativeSessionId(): string | undefined {
    return this.session.getState().sessionId ?? undefined;
  }

  markExited(): void {
    this.exited = true;
    for (const resolve of this.exitWaiters.splice(0)) resolve();
  }

  async send(content: ContentBlock[], delivery: MessageDelivery): Promise<MessageDelivery> {
    if (this.session.getState().turnInFlight) {
      // ACP v1 can't steer or queue; the chat runtime queues (capabilities.queue === 'client').
      throw new Error(`Cannot ${delivery} into a running ACP turn; queue it until the turn ends`);
    }
    // During an agent-initiated turn the runtime queues too (the session reads
    // running). A prompt that gets here anyway closes that turn and starts its own.
    this.runTurn(toAcpPrompt(content));
    return 'prompt';
  }

  /** Also stops an agent-initiated turn: session/cancel goes out either way. */
  async interrupt(): Promise<void> {
    this.session.cancel();
  }

  async respondPermission(requestId: string, optionId: string): Promise<void> {
    this.session.respondToPermission(requestId, { optionId });
  }

  async answerQuestion(): Promise<void> {
    throw new Error('ACP v1 agents do not ask structured questions');
  }

  async setLevel(level: PermissionLevel): Promise<void> {
    const levels = this.session.agentProfile.permissionLevels;
    if (!levels) throw new Error('This ACP agent has no permission levels');
    await levels.apply(this.session, level);
  }

  async setModel(modelId: string, effort?: string | null): Promise<void> {
    // ACP config options have no "unset", so there's no default to return to (no effortDefault).
    if (effort === null) throw new Error("This agent can't return effort to its default");
    await this.session.setModel(modelId);
    this.onModelChosen?.();
    if (effort) await this.setEffort(effort);
  }

  /** ACP has no compaction method; agents that support it take `/compact` as prompt text. */
  async compact(): Promise<void> {
    if (!this.session.getState().availableCommands.some((c) => c.name === 'compact')) {
      throw new Error('This ACP agent does not offer /compact');
    }
    await this.session.prompt('/compact');
  }

  async close(): Promise<void> {
    const exited = this.exited ? Promise.resolve() : new Promise<void>((resolve) => this.exitWaiters.push(resolve));
    await this.session.close();
    await Promise.race([exited, new Promise((r) => setTimeout(r, CLOSE_GRACE_MS))]);
  }

  async setEffort(effort: string): Promise<void> {
    const option = this.session.getState().configOptions.find((o) => o.category === 'thought_level');
    if (!option) throw new Error('This ACP agent has no reasoning-effort option');
    await this.session.setConfigOption(option.id, effort);
    this.onEffortChosen?.();
  }

  /** Prompts resolve when the turn ends; outcomes reach the stream as turn_ended. */
  private runTurn(prompt: ReturnType<typeof toAcpPrompt>): void {
    this.session.prompt(prompt).catch((err: Error) => {
      this.log('warn', 'ACP prompt turn failed', { error: err.message });
    });
  }
}

/**
 * Chat driver for an ACP agent: drives an `AcpSession` and translates its
 * events into chat contract drafts. Lifecycle (session_started, state,
 * transcripts, queueing) belongs to the chat runtime.
 */
export class AcpChatDriver implements ChatDriver {
  readonly id: ChatDriverId;
  readonly provider: string;

  /** Session options tests override, e.g. a short stall timeout. */
  sessionOverrides: Pick<AcpSessionOpts, 'resumeFirstReplyTimeoutMs' | 'resumeStallTimeoutMs' | 'resumeMaxMs' | 'rpcTimeoutMs' | 'agentTurnIdleMs' | 'agentTurnToolIdleMs' | 'agentTurnCancelSettleMs'> = {};

  constructor(private readonly spec: AcpLaunchSpec, private readonly log: Log = () => undefined) {
    this.id = spec.id;
    this.provider = spec.provider;
  }

  /** `initialize` only: no session, no prompt, no tokens. */
  async probe(binaryPath: string, env?: Record<string, string>, opts?: { commandPrefix?: string }): Promise<ChatDriverProbe> {
    const cmd = this.spec.spawn({ binary: binaryPath, commandPrefix: opts?.commandPrefix });
    const session = new AcpSession({ ...cmd, env, profile: this.spec.profile, onLog: this.log });
    try {
      const caps = await session.start();
      return {
        handshakeOk: true,
        ...(caps.agent.version && { cliVersion: caps.agent.version }),
        capabilities: toChatCapabilities(caps, undefined, session.agentProfile.permissionLevels),
      };
    } catch (err) {
      return { handshakeOk: false, capabilities: toChatCapabilities(MINIMAL_ACP_CAPS), error: (err as Error).message };
    } finally {
      session.kill();
    }
  }

  /**
   * Start a session, resuming `opts.resumeNativeSessionId` when given. A
   * resume the agent no longer has (checked on disk first where the profile
   * can), or one that times out (see RESUME_FIRST_REPLY_TIMEOUT_MS), continues
   * in a fresh session with a notice:
   * a stalled one in a new process, since the old one may still be busy.
   * `opts.signal` kills the CLI and rejects.
   */
  async start(opts: ChatDriverStartOptions): Promise<ChatDriverSession> {
    try {
      return await this.open(opts, opts.resumeNativeSessionId, undefined, []);
    } catch (err) {
      if (!(err instanceof AcpResumeStalledError) || opts.signal?.aborted) throw err;
      this.log('warn', 'Native session resume stalled; starting a new one', { sessionId: err.sessionId, method: err.method, timeoutMs: err.timeoutMs });
      const fresh = await this.open(opts, undefined, err.timing, [{
        type: 'notice',
        data: {
          level: 'info',
          code: 'resume_stalled',
          message: 'The agent didn\'t reopen this conversation in time, so it continues in a new session without the earlier context.',
        },
      }]);
      fresh.resumeFallback = 'stalled';
      return fresh;
    }
  }

  /** `stalledTiming`: the timings of a resume that stalled, for the fresh session that replaces it. */
  private async open(
    opts: ChatDriverStartOptions,
    resumeNativeSessionId: string | undefined,
    stalledTiming: ChatResumeTiming | undefined,
    notices: ChatEventDraft[],
  ): Promise<AcpChatDriverSession> {
    if (opts.signal?.aborted) throw new Error('Chat start cancelled');
    const cmd = this.spec.spawn({ binary: opts.binaryPath, extraArgs: opts.extraArgs, commandPrefix: opts.commandPrefix });
    const queue = new AsyncQueue<ChatEventDraft>();
    for (const notice of notices) queue.push(notice);
    let mapper: AcpChatEventMapper | null = null;
    let driverSession: AcpChatDriverSession | null = null;
    const buffered: AcpSessionEvent[] = [];

    const session = new AcpSession({
      ...cmd,
      ...this.sessionOverrides,
      cwd: opts.cwd,
      env: opts.env,
      profile: this.spec.profile,
      onLog: this.log,
      onEvent: (event) => {
        if (event.type === 'exit') {
          // AcpSession emits exit only after a running turn's turn_ended, so nothing is cut off.
          driverSession?.markExited();
          queue.finish();
          return;
        }
        if (!mapper) {
          buffered.push(event);
          return;
        }
        for (const draft of mapper.map(event, session.getState())) queue.push(draft);
      },
    });

    // Killing the CLI settles whatever request is pending, so the start rejects.
    const onAbort = () => session.kill();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const caps = await session.start();
      const { servers, skipped, unsupported } = toAcpMcpServers(opts.mcpServers, opts.env, {
        transports: caps.mcp,
        httpEndpoints: opts.mcpHttpEndpoints,
      });
      if (skipped.length) this.log('warn', 'MCP servers not expressible over ACP', { skipped });
      if (unsupported.length) {
        // Copilot over ACP drops client stdio servers (#2240). They are still
        // sent, in case a later version takes them.
        this.log('warn', 'Agent does not accept stdio MCP servers over ACP; these will not load in chat', {
          unsupported,
          accepts: caps.mcp,
        });
        queue.push({
          type: 'notice',
          data: {
            level: 'warn',
            code: 'mcp_servers_unsupported',
            message: `${caps.agent.title ?? caps.agent.name} chat can't load stdio MCP servers, so these are off: ${unsupported.join(', ')}. Run them in Terminal mode, or set them up as HTTP servers.`,
          },
        });
      }
      this.log('info', 'MCP servers for session', {
        servers: servers.map((s) => ({ name: s.name, transport: 'type' in s ? s.type : 'stdio' })),
      });
      const setup = { cwd: opts.cwd, mcpServers: servers };
      let resumeFallback: 'not_found' | undefined;
      const startFresh = async (logMessage: string, message: string) => {
        this.log('warn', logMessage, { sessionId: resumeNativeSessionId });
        // Drop anything a failed load replayed before it gave up.
        buffered.length = 0;
        queue.push({ type: 'notice', data: { level: 'info', code: 'resume_unavailable', message } });
        resumeFallback = 'not_found';
        await session.newSession(setup);
      };
      let resumed = false;
      const exists = resumeNativeSessionId
        ? await session.agentProfile.nativeSessionExists?.(resumeNativeSessionId, { ...process.env, ...opts.env })
        : undefined;
      // undefined: the profile can't tell, or the check itself failed; the load decides.
      if (resumeNativeSessionId) this.log('info', 'Native session on-disk check', { sessionId: resumeNativeSessionId, onDisk: exists ?? null });
      if (resumeNativeSessionId && exists === false) {
        // Copilot hangs on session/load for a session it doesn't have (#2155):
        // don't send it at all.
        await startFresh(
          'Native session not found on disk; starting a new one',
          'The previous session was not found, so this conversation continues in a new session without the earlier context.',
        );
      } else if (resumeNativeSessionId) {
        try {
          await session.resumeSession(resumeNativeSessionId, setup);
          resumed = true;
        } catch (err) {
          // The agent no longer has the session and answers "resource not found"
          // (Copilot, for one, doesn't persist a session that never got a prompt).
          // Clubhouse's transcript still has the history; start a fresh native
          // session and say so. Applies to every ACP agent, not just Copilot.
          if (!(err instanceof RpcError) || err.code !== ACP_ERROR_CODES.resourceNotFound) throw err;
          await startFresh(
            'Native session not found; starting a new one',
            'The agent no longer has this conversation, so it continues in a new session without the earlier context.',
          );
        }
      } else {
        await session.newSession(setup);
      }

      const levels = session.agentProfile.permissionLevels;
      driverSession = new AcpChatDriverSession(session, queue, toChatCapabilities(caps, session.getState(), levels), this.log, { ...process.env, ...opts.env });
      driverSession.resumeTiming = session.resumeTiming ?? stalledTiming;
      driverSession.resumeFallback = resumeFallback;
      for (const draft of this.spec.handshakeNotices?.(session.initializeResponse!) ?? []) queue.push(draft);

      // Apply requested settings before mapping starts, so they aren't reported as changes.
      if (opts.model) await driverSession.setModel(opts.model);
      if (opts.effort) await driverSession.setEffort(opts.effort).catch((err: Error) => this.log('warn', 'Effort not applied', { error: err.message }));
      if (levels && levels.live.includes(opts.level)) {
        // A resumed session's options describe the old process; re-send them.
        await levels.apply(session, opts.level, { force: resumed });
      } else {
        this.log('warn', 'Permission level not available over ACP; keeping the agent default', { level: opts.level });
      }

      mapper = new AcpChatEventMapper(this.id, {
        profile: session.agentProfile,
        effortPinned: !!opts.effort,
        // A new session runs the agent's own default until the first prompt resolves it (#2293).
        modelUnresolved: !resumed && !opts.model && !!session.agentProfile.newSessionModelUnresolved,
        env: { ...process.env, ...opts.env },
      });
      const state = session.getState();
      queue.push(mapper.initialInfo(state, session.initializeResponse?.agentInfo?.version));
      // Session-scoped state that arrived during setup. Replayed copies count:
      // Copilot's trailing command list can land while session/load still reads as replay.
      for (const event of buffered.splice(0)) {
        if (event.type === 'update'
          && (event.update.sessionUpdate === 'available_commands_update' || event.update.sessionUpdate === 'usage_update')) {
          for (const draft of mapper.map(event, state)) queue.push(draft);
        } else if (event.type === 'unknown_update' || event.type === 'unknown_method') {
          for (const draft of mapper.map(event, state)) queue.push(draft);
        }
      }
      mapper.prime(session.getState());
      const primed = mapper;
      driverSession.onEffortChosen = () => { for (const draft of primed.pinEffort(session.getState())) queue.push(draft); };
      driverSession.onModelChosen = () => { for (const draft of primed.modelChosen(session.getState())) queue.push(draft); };
      if (opts.signal?.aborted) throw new Error('Chat start cancelled');
      return driverSession;
    } catch (err) {
      session.kill();
      queue.finish();
      throw err;
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
    }
  }
}

const MINIMAL_ACP_CAPS = {
  driver: 'acp',
  profile: 'generic',
  agent: { name: 'unknown' },
  protocolVersion: 0,
  schemaVersion: '',
  resume: 'none',
  fork: false,
  listSessions: false,
  listIsMachineWide: false,
  closeSession: false,
  deleteSession: false,
  cancel: true,
  steer: false,
  queue: 'client',
  rewind: false,
  planApproval: false,
  subagents: 'none',
  modes: false,
  configOptions: false,
  permissionOptionKinds: 'any',
  permissionRules: 'protocol',
  usage: { context: false, turnTokens: false, cost: false },
  prompt: { image: false, audio: false, embeddedContext: false },
  mcp: { stdio: true, http: false, sse: false },
  slashCommands: false,
  interactiveSlashCommands: false,
  login: 'none',
  clientFs: false,
  quirks: [],
} as const satisfies Parameters<typeof toChatCapabilities>[0];

/** Copilot CLI over ACP (`copilot --acp --stdio`). */
export const COPILOT_ACP_LAUNCH: AcpLaunchSpec = {
  id: 'copilot_acp',
  provider: 'copilot-cli',
  spawn: resolveCopilotAcpSpawn,
  profile: selectAcpProfile,
  handshakeNotices(init) {
    const version = init.agentInfo?.version;
    if (copilotVersionStatus(version) !== 'newer') return [];
    return [{
      type: 'notice',
      data: {
        level: 'info',
        code: 'untested_cli_version',
        message: `Copilot CLI ${version} is newer than the versions chat was tested with (up to ${COPILOT_ACP_TESTED_RANGE.max}).`,
      },
    }];
  },
};

export function createCopilotAcpChatDriver(log?: Log): AcpChatDriver {
  return new AcpChatDriver(COPILOT_ACP_LAUNCH, log);
}

/**
 * Register Copilot's chat driver with the chat runtime's registry
 * (`registerChatDriver` in services/agent-runtime/chat-drivers.ts). Copilot
 * has one chat mode today; the Copilot SDK driver will register ahead of it
 * (docs/copilot-sdk-driver.md). Returns the unregister function.
 */
export function registerCopilotChatDrivers(
  register: (driver: ChatDriver) => () => void,
  log?: Log,
): () => void {
  return register(createCopilotAcpChatDriver(log));
}

/**
 * Any other ACP agent (Gemini CLI, adapters for other CLIs): driver id `acp`.
 * The agent's own ACP flags go in `agentArgs`; no agent-specific quirks apply.
 */
export function createGenericAcpChatDriver(provider: string, agentArgs: string[] = [], log?: Log): AcpChatDriver {
  return new AcpChatDriver({
    id: 'acp',
    provider,
    spawn: ({ binary, extraArgs, commandPrefix }) => resolveStructuredSpawn(binary, [...agentArgs, ...(extraArgs ?? [])], commandPrefix),
    profile: GENERIC_ACP_PROFILE,
  }, log);
}
