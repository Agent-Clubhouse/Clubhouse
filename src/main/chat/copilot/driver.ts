import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { CopilotClient, CopilotSession, ElicitationContext, ElicitationResult, ExitPlanModeRequest, ExitPlanModeResult, MCPServerConfig, MessageOptions, ModelInfo, PermissionRequest, PermissionRequestResult, SessionConfig, SessionEvent } from '@github/copilot-sdk';
import { MINIMAL_CHAT_CAPABILITIES, type ChatCapabilities, type PermissionLevel } from '../../../shared/chat/capabilities';
import { COMPACTION_STARTED, type ChatEventDraft, type ChatMcpServerStatus, type ChatQuestionAnswers, type ContentBlock, type MessageDelivery, type TokenUsage } from '../../../shared/chat/events';
import type { ChatDriver, ChatDriverProbe, ChatDriverSession, ChatDriverStartOptions, McpHttpEndpoint, PermissionResponseExtras } from '../../../shared/chat/runtime';
import { AsyncQueue } from '../../orchestrators/adapters/async-queue';
import { elicitationContent, elicitationQuestions } from './elicitation';
import { CopilotLaunchError, launchCopilotServer, type CopilotServer } from './launch';
import {
  addTokens,
  COPILOT_OPTION_ALLOW,
  COPILOT_OPTION_ALLOW_SESSION,
  COPILOT_OPTION_DENY,
  copilotErrorCode,
  copilotPermissionOptions,
  copilotPermissionView,
  copilotProviderFromEnv,
  copilotTokens,
  copilotToolContent,
  copilotToolKind,
  copilotToolLocations,
  copilotToolTitle,
} from './normalizer';
import { loadCopilotSdk } from './sdk-loader';
import { copilotTierEntry, type CopilotTierEntry } from '../../../shared/context-window';

type ReasoningEffort = NonNullable<NonNullable<Parameters<CopilotSession['setModel']>[1]>['reasoningEffort']>;

type SlashCommandInfo = Awaited<ReturnType<CopilotSession['rpc']['commands']['list']>>['commands'][number];
type UserInputHandler = NonNullable<SessionConfig['onUserInputRequest']>;
type UserInputRequest = Parameters<UserInputHandler>[0];
type UserInputResponse = Awaited<ReturnType<UserInputHandler>>;

type Log = (level: 'debug' | 'info' | 'warn' | 'error', message: string, meta?: Record<string, unknown>) => void;

const PROVIDER = 'copilot-cli';

/** `start()` can hang forever on a CLI that never answers. Cold handshakes took 0.8 to 5.9 s. */
export const COPILOT_PROBE_TIMEOUT_MS = 15_000;
/** Connecting and opening a session also loads the user's MCP servers. */
const START_TIMEOUT_MS = 60_000;
const CLOSE_GRACE_MS = 5_000;
const MODEL_LIST_TIMEOUT_MS = 15_000;

const LOGIN_MESSAGE = 'Not logged in to Copilot. Run copilot and use /login.';
const LOGIN_HINT = 'Run copilot and use /login';

/**
 * Credits stay out until confirmed on a real login, so usage is tokens only
 * (docs/copilot-sdk-driver.md "Features"). There is no Auto level: Copilot's
 * autopilot keeps going on its own, which isn't what Auto means elsewhere.
 */
export const COPILOT_SDK_CAPABILITIES: ChatCapabilities = Object.freeze({
  ...MINIMAL_CHAT_CAPABILITIES,
  steer: true,
  queue: 'native',
  interrupt: true,
  resume: 'native',
  planApproval: true,
  questions: true,
  subagents: 'full',
  usage: 'tokens',
  images: true,
  slashCommands: true,
  modelSwitch: 'live',
  effortSwitch: 'live',
  liveLevels: ['plan', 'ask', 'auto_edit', 'full_access'],
  // A reject with feedback lets the model continue; updatedInput has no equivalent.
  permissionExtras: { denyMessage: true, updatedInput: false },
}) as ChatCapabilities;

const LEVEL_NAMES: Partial<Record<PermissionLevel, string>> = { plan: 'Plan', ask: 'Agent', auto_edit: 'Agent, allow edits', full_access: 'Agent, allow all' };

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

/** How long a tier catalog read may take, for the server's start and for models.list. */
const TIER_CATALOG_TIMEOUT_MS = 8_000;

async function connect(server: CopilotServer): Promise<CopilotClient> {
  const { CopilotClient, RuntimeConnection } = await loadCopilotSdk();
  const client = new CopilotClient({ connection: RuntimeConnection.forUri(server.uri, { connectionToken: server.connectionToken }), logLevel: 'error' });
  await client.start();
  return client;
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

/** An open approval: `answer` throws on an option it doesn't have, `cancel` says no without a person. */
interface PendingApproval {
  answer(optionId: string, message: string | undefined): void;
  cancel(): void;
}

const PLAN_OPTION_APPROVE = 'approve';
const PLAN_OPTION_REJECT = 'reject';
/** The one question an `ask_user` call carries. */
const QUESTION_ID = 'answer';
const ELICIT_OPTION_ACCEPT = 'accept';
const ELICIT_OPTION_DECLINE = 'decline';

/**
 * Commands the composer doesn't offer, and that a message doesn't run. They
 * change access from inside the CLI, where the level menu can't see it. The menu
 * is the way to change access here, and Auto has no equivalent (see capabilities).
 */
const HIDDEN_COMMANDS: ReadonlySet<string> = new Set(['allow-all', 'permissions', 'autopilot']);
const COMMAND_LIST_TIMEOUT_MS = 15_000;

/** `/name rest` from a message, when the whole message starts with one. */
export function parseSlashCommand(text: string): { name: string; input?: string } | undefined {
  const m = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  return m ? { name: m[1], ...(m[2]?.trim() && { input: m[2].trim() }) } : undefined;
}

/**
 * What approving a plan continues as. The CLI offers autopilot among the
 * actions: approving a plan never turns it on.
 */
export function copilotPlanAction(request: Pick<ExitPlanModeRequest, 'actions' | 'recommendedAction'>): string | undefined {
  const safe = (action: string | undefined) => (action && !action.startsWith('autopilot') ? action : undefined);
  return request.actions.includes('interactive') ? 'interactive' : safe(request.recommendedAction) ?? request.actions.find((a) => safe(a));
}

function mcpStatus(status: string | undefined): ChatMcpServerStatus {
  switch (status) {
    case 'connected': return 'connected';
    case 'pending': return 'pending';
    case 'needs-auth': return 'needs_auth';
    case 'failed': return 'failed';
    case 'disabled': case 'stopped': case 'not_configured': return 'disabled';
    default: return 'unknown';
  }
}

async function imageAttachment(block: Extract<ContentBlock, { type: 'image' }>): Promise<NonNullable<MessageOptions['attachments']>[number]> {
  const mimeType = block.mimeType;
  if (block.data) return { type: 'blob', data: block.data, mimeType };
  const file = block.path ?? (block.uri?.startsWith('file:') ? fileURLToPath(block.uri) : undefined);
  if (!file) throw new Error(`Copilot chat can't attach an image from ${block.uri ?? 'nowhere'}: only inline data or local files`);
  return { type: 'blob', data: (await fsp.readFile(file)).toString('base64'), mimeType };
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
  private readonly pending = new Map<string, PendingApproval>();
  private readonly pendingQuestions = new Map<string, { answer: (answers: ChatQuestionAnswers) => void; cancel: () => void }>();
  /** Commands by name and alias. */
  private commands = new Map<string, SlashCommandInfo>();
  private commandsLoaded: Promise<void> = Promise.resolve();
  /** The system prompt that came ahead of a first message that was a command. It goes with the next prompt instead. */
  private heldPreamble: string | undefined;
  /** Calls in progress, for the result's arguments and to tie a handler's request to its call. */
  private readonly tools = new Map<string, { name: string; args: unknown; parent?: string }>();
  /** Subagent's `agentId` → the tool call that started it, which is its id in the contract. */
  private readonly agents = new Map<string, string>();
  private sdk: CopilotSession | undefined;
  private level: PermissionLevel;
  /** What approving a plan returns to. */
  private actingLevel: PermissionLevel = 'ask';
  private model: string | undefined;
  private effort: string | undefined;
  private models: ModelInfo[] = [];
  private mcpReported = '';
  private turn = 0;
  private turnRunning = false;
  private interrupting = false;
  private closing = false;
  private finished = false;
  private nextRequest = 0;
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
    // Auto has no equivalent, so it asks first: never more access than asked for.
    this.level = COPILOT_SDK_CAPABILITIES.liveLevels.includes(opts.level) ? opts.level : 'ask';
    if (this.level !== 'plan') this.actingLevel = this.level;
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
    const env = { ...process.env, ...this.opts.env };
    const provider = copilotProviderFromEnv(env);
    const saved = this.opts.model && this.opts.model !== 'default' ? this.opts.model : undefined;
    // Saved model first, as `--model` beats COPILOT_MODEL in the CLI.
    const model = saved ?? env.COPILOT_MODEL ?? provider?.modelId;
    if (provider && !model) throw new Error('A Copilot provider (COPILOT_PROVIDER_BASE_URL) needs a model. Set COPILOT_MODEL, or choose a model for the agent.');
    const config: SessionConfig = {
      clientName: 'Clubhouse',
      streaming: true,
      workingDirectory: this.opts.cwd,
      // Off by default in the SDK. Without it the session ignores the user's own
      // instructions, skills and MCP config, which Terminal and ACP both load.
      enableConfigDiscovery: true,
      ...(model && { model }),
      ...(this.opts.contextWindow && { contextTier: this.opts.contextWindow as SessionConfig['contextTier'] }),
      ...(provider && { provider }),
      ...(Object.keys(servers).length && { mcpServers: servers }),
      onPermissionRequest: (request) => this.onPermission(request),
      onUserInputRequest: (request) => this.onQuestion(request),
      onExitPlanModeRequest: (request) => this.onPlan(request),
      onElicitationRequest: (context) => this.onElicitation(context),
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
    // Always sent, even if it looks right: a session opened on another driver or
    // an earlier process can be in any mode, and ACP's stale values cost us #2174.
    await this.sdk.rpc.mode.set({ mode: this.level === 'plan' ? 'plan' : 'interactive' }).catch((err: Error) => this.log('warn', 'Could not set the session mode', { error: err.message }));
    this.model = model ?? await this.sdk.rpc.model.getCurrent().then((c) => c.modelId, (err: Error): undefined => {
      this.log('warn', 'Could not read the current model', { error: err.message });
      return undefined;
    });
    if (this.opts.effort && this.model) {
      await this.sdk.setModel(this.model, { reasoningEffort: this.opts.effort as ReasoningEffort }).then(
        () => { this.effort = this.opts.effort; },
        (err: Error) => this.log('warn', 'Effort not applied', { error: err.message }),
      );
    }
    this.push({
      type: 'session_info',
      data: {
        nativeSessionId: this.sdk.sessionId,
        ...(cliVersion && { cliVersion }),
        ...(this.model && { model: this.model }),
        levelNames: LEVEL_NAMES,
      },
    });
    if (this.level !== this.opts.level) {
      this.push({ type: 'mode_changed', data: { level: this.level, nativeMode: 'interactive' } });
      this.push({ type: 'notice', data: { level: 'info', code: 'level_unavailable', message: 'The Copilot SDK driver has no Auto level, so this session asks first.' } });
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
      ownProvider: !!provider,
    });
    this.push({
      type: 'notice',
      data: { level: 'info', code: 'copilot_sdk_active', message: `This chat runs on the experimental Copilot SDK driver${cliVersion ? ` with Copilot CLI ${cliVersion}` : ''}.` },
    });
    void this.loadModels();
    this.commandsLoaded = this.loadCommands();
  }

  /** What the composer offers: the same list ACP gets, less the commands that change access. */
  private async loadCommands(): Promise<void> {
    let listed: SlashCommandInfo[];
    try {
      ({ commands: listed } = await withTimeout(this.requireSession().rpc.commands.list(), COMMAND_LIST_TIMEOUT_MS, 'Listing commands'));
    } catch (err) {
      this.log('warn', 'Could not list Copilot commands', { error: err instanceof Error ? err.message : String(err) });
      return;
    }
    const usable = listed.filter((c) => !HIDDEN_COMMANDS.has(c.name));
    this.commands = new Map(usable.flatMap((c) => [c.name, ...(c.aliases ?? [])].map((n): [string, SlashCommandInfo] => [n, c])));
    this.push({
      type: 'commands_available',
      data: {
        commands: usable.map((c) => ({
          name: c.name,
          description: c.description,
          ...(c.input?.hint && { inputHint: c.input.hint }),
          // Only a message that starts with one runs it (send). Anywhere else it's text for the model.
          startOnly: true,
        })),
      },
    });
  }

  /** The model menu. It needs a real login, so it's best-effort and never holds a start up. */
  private async loadModels(): Promise<void> {
    try {
      this.models = await withTimeout(this.client.listModels(), MODEL_LIST_TIMEOUT_MS, 'Listing models');
    } catch (err) {
      this.log('info', 'Could not list Copilot models', { error: err instanceof Error ? err.message : String(err) });
      return;
    }
    this.push({
      type: 'session_info',
      data: {
        models: this.models.map((m) => ({
          id: m.id,
          label: m.name || m.id,
          ...(m.billing?.multiplier !== undefined && { costHint: `${m.billing.multiplier}x` }),
        })),
        efforts: this.effortsOf(this.model),
      },
    });
  }

  private effortsOf(model: string | undefined): string[] {
    return this.models.find((m) => m.id === model)?.supportedReasoningEfforts ?? [];
  }

  async send(content: ContentBlock[], delivery: MessageDelivery): Promise<MessageDelivery> {
    const command = await this.commandIn(content);
    if (command === 'hidden') return delivery;
    if (command) {
      if (this.turnRunning && !command.info.allowDuringAgentExecution) {
        this.push({ type: 'notice', data: { level: 'warn', code: 'command_busy', message: `/${command.info.name} can't run during a turn. Send it again when the turn ends.` } }, true);
        return delivery;
      }
      const ownsTurn = !this.turnRunning;
      if (ownsTurn) this.beginTurn('prompt');
      // Not awaited: a command can take as long as a turn (/compact, a skill),
      // and the runtime records the user's message only once send returns.
      void this.runCommand(command.info, command.input, ownsTurn);
      return ownsTurn ? 'prompt' : delivery;
    }
    const body = content
      .map((b) => (b.type === 'text' ? b.text : b.type === 'file' ? b.path : b.type === 'resource' ? b.text ?? b.uri : ''))
      .filter(Boolean)
      .join('\n');
    const prompt = this.heldPreamble ? `${this.heldPreamble}\n${body}` : body;
    this.heldPreamble = undefined;
    const images = await Promise.all(content.filter((b): b is Extract<ContentBlock, { type: 'image' }> => b.type === 'image').map(imageAttachment));
    const attachments = images.length ? { attachments: images } : {};
    if (this.turnRunning) {
      // 'immediate' reaches the next model request of this run; 'enqueue' waits for it to finish.
      const actual: MessageDelivery = delivery === 'queued' ? 'queued' : 'steer';
      await this.requireSession().send({ prompt, ...attachments, mode: actual === 'queued' ? 'enqueue' : 'immediate' });
      return actual;
    }
    // Idle: whatever was asked, the message starts a turn.
    this.beginTurn('prompt');
    try {
      await this.requireSession().send({ prompt, ...attachments });
    } catch (err) {
      this.endTurn('error');
      throw err;
    }
    return 'prompt';
  }

  /**
   * The command a message runs, if it is one. The CLI takes a command only
   * through commands.invoke: sent as a message, it reaches the model as text.
   * Anything not listed stays text too, so a message like "/tmp is full" still works.
   */
  private async commandIn(content: ContentBlock[]): Promise<{ info: SlashCommandInfo; input?: string } | 'hidden' | undefined> {
    if (!content.length || content.some((b) => b.type !== 'text')) return undefined;
    const texts = content.map((b) => (b.type === 'text' ? b.text : ''));
    const parsed = parseSlashCommand(texts[texts.length - 1]);
    if (!parsed) return undefined;
    if (HIDDEN_COMMANDS.has(parsed.name)) {
      this.push({ type: 'notice', data: { level: 'info', code: 'command_hidden', message: `/${parsed.name} changes access from inside the CLI. Use the level menu here, or the CLI view.` } });
      return 'hidden';
    }
    await this.commandsLoaded;
    const info = this.commands.get(parsed.name);
    if (!info) return undefined;
    // The runtime puts the system prompt ahead of a first message, as its own block.
    if (texts.length > 1) this.heldPreamble = texts.slice(0, -1).join('\n');
    return { info, ...(parsed.input && { input: parsed.input }) };
  }

  private async runCommand(info: SlashCommandInfo, input: string | undefined, ownsTurn: boolean): Promise<void> {
    let continues = false;
    const say = (text: string) => this.push({ type: 'agent_message', data: { messageId: `command-${++this.nextRequest}`, text } }, true);
    try {
      const session = this.requireSession();
      const result = await session.rpc.commands.invoke({ name: info.name, ...(input && { input }) });
      switch (result.kind) {
        case 'text':
          say(result.text);
          break;
        case 'completed':
          if (result.message) say(result.message);
          break;
        case 'agent-prompt': {
          if (result.notice) this.push({ type: 'notice', data: { level: 'info', code: 'command_notice', message: result.notice } }, true);
          if (result.mode) await session.rpc.mode.set({ mode: result.mode });
          const prompt = this.heldPreamble ? `${this.heldPreamble}\n${result.prompt}` : result.prompt;
          this.heldPreamble = undefined;
          await session.send({ prompt, displayPrompt: result.displayPrompt, ...(ownsTurn ? {} : { mode: 'immediate' as const }) });
          // The turn now runs like any other, and ends on session.idle.
          continues = true;
          break;
        }
        case 'select-subcommand':
          say([`${result.title}:`, ...result.options.map((o) => `- \`/${result.command} ${o.name}\`: ${o.description}`)].join('\n'));
          break;
        case 'add-timeline-entry':
          say(result.entry.text);
          break;
        case 'set-model':
          await session.setModel(result.model, result.reasoningEffort ? { reasoningEffort: result.reasoningEffort as ReasoningEffort } : undefined);
          if (result.warning) this.push({ type: 'notice', data: { level: 'warn', code: 'command_notice', message: result.warning } }, true);
          break;
        case 'set-plan-model':
          say(result.message);
          break;
        default:
          // A picker the CLI would draw in its own UI (show-dialog, and any kind newer than this SDK).
          this.push({ type: 'notice', data: { level: 'info', code: 'command_needs_cli', message: `/${info.name} opens something only the CLI view can show.${info.name === 'model' ? ' Use the model menu here.' : ''}` } }, true);
      }
    } catch (err) {
      // The CLI's own words: "Nothing to compact." isn't a failed turn.
      const message = err instanceof Error ? err.message.replace(/^Request \S+ failed with message: /, '') : String(err);
      this.log('warn', 'Copilot command failed', { command: info.name, error: message });
      this.push({ type: 'notice', data: { level: 'warn', code: 'command_failed', message: `/${info.name}: ${message}` } }, true);
    }
    if (ownsTurn && !continues) this.endTurn(this.interrupting ? 'cancelled' : 'end_turn');
  }

  async interrupt(): Promise<void> {
    if (this.turnRunning) this.interrupting = true;
    this.settlePending('agent');
    await this.requireSession().abort();
  }

  async respondPermission(requestId: string, optionId: string, extras?: PermissionResponseExtras): Promise<void> {
    const pending = this.pending.get(requestId);
    if (!pending) throw new Error(`No pending Copilot permission request ${requestId}`);
    pending.answer(optionId, extras?.message);
    this.pending.delete(requestId);
    const denied = optionId === COPILOT_OPTION_DENY || optionId === PLAN_OPTION_REJECT;
    this.push({ type: 'permission_resolved', data: { requestId, optionId, decision: denied ? 'deny' : 'allow', by: 'user' } }, true);
  }

  async answerQuestion(requestId: string, answers: ChatQuestionAnswers): Promise<void> {
    const pending = this.pendingQuestions.get(requestId);
    if (!pending) throw new Error(`No pending Copilot question ${requestId}`);
    // A form refuses an answer its schema doesn't allow, and stays open.
    pending.answer(answers);
    this.pendingQuestions.delete(requestId);
    this.push({ type: 'question_resolved', data: { requestId, answers } }, true);
  }

  async setLevel(level: PermissionLevel): Promise<void> {
    if (!this.capabilities.liveLevels.includes(level)) throw new Error(`The Copilot SDK driver has no ${level} level`);
    const previous = this.level;
    if (level === previous) return;
    // Set first, so the mode_changed event this causes reads as nothing new.
    this.level = level;
    if (level !== 'plan') this.actingLevel = level;
    if (level === 'plan' || previous === 'plan') {
      try {
        await this.requireSession().rpc.mode.set({ mode: level === 'plan' ? 'plan' : 'interactive' });
      } catch (err) {
        this.level = previous;
        throw err;
      }
    }
    this.push({ type: 'mode_changed', data: { level, nativeMode: level === 'plan' ? 'plan' : 'interactive' } });
  }

  async setModel(modelId: string, effort?: string | null): Promise<void> {
    // Copilot has no "unset", so there's no default to return to (no effortDefault).
    if (effort === null) throw new Error("Copilot can't return effort to its default");
    const wanted = effort ?? this.effort;
    // The session.model_change event reports what the CLI applied.
    await this.requireSession().setModel(modelId, wanted ? { reasoningEffort: wanted as ReasoningEffort } : undefined);
  }

  async compact(): Promise<void> {
    // session.compaction_start and _complete report it.
    await this.requireSession().rpc.history.compact();
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
    const requestId = `perm-${++this.nextRequest}`;
    const view = copilotPermissionView(request);
    const toolCallId = 'toolCallId' in request ? request.toolCallId : undefined;
    if (toolCallId && view.content) {
      this.push({ type: 'tool_call_update', data: { toolCallId, content: view.content } }, true);
    }
    return new Promise((resolve) => {
      this.pending.set(requestId, {
        answer(optionId, message) {
          if (optionId === COPILOT_OPTION_ALLOW) resolve({ kind: 'approve-once' });
          else if (optionId === COPILOT_OPTION_ALLOW_SESSION) resolve({ kind: 'approve-for-session' });
          else if (optionId === COPILOT_OPTION_DENY) resolve({ kind: 'reject', ...(message && { feedback: message }) });
          else throw new Error(`Unknown Copilot permission option ${optionId}`);
        },
        cancel: () => resolve({ kind: 'reject' }),
      });
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
          ...(toolCallId && this.tools.get(toolCallId)?.parent && { subagentId: this.tools.get(toolCallId)?.parent }),
        },
      }, true);
    });
  }

  /** The running call of this tool. A handler's request doesn't name its call, but runs right after it starts. */
  private openCall(name: string): string | undefined {
    return [...this.tools].reverse().find(([, t]) => t.name === name)?.[0];
  }

  private onQuestion(request: UserInputRequest): Promise<UserInputResponse> | UserInputResponse {
    if (this.closing || this.finished) return { answer: '', wasFreeform: true };
    if (!this.turnRunning) this.beginTurn('system');
    const requestId = `question-${++this.nextRequest}`;
    const choices = request.choices ?? [];
    const toolCallId = this.openCall('ask_user');
    return new Promise((resolve) => {
      this.pendingQuestions.set(requestId, {
        answer: (answers) => {
          const raw = answers[QUESTION_ID] ?? '';
          const answer = Array.isArray(raw) ? raw.join(', ') : raw;
          resolve({ answer, wasFreeform: !choices.includes(answer) });
        },
        cancel: () => resolve({ answer: '', wasFreeform: true }),
      });
      this.push({
        type: 'question',
        data: {
          requestId,
          questions: [{
            id: QUESTION_ID,
            prompt: request.question,
            ...(choices.length && { options: choices.map((c) => ({ id: c, label: c })) }),
            allowFreeText: request.allowFreeform ?? true,
          }],
          toolCallId,
          ...(toolCallId && this.tools.get(toolCallId)?.parent && { subagentId: this.tools.get(toolCallId)?.parent }),
        },
      }, true);
    });
  }

  /**
   * An MCP server asks the user for something. The approval card comes first,
   * since it's the only one with a way to say no: declining and cancelling each
   * reach the server as such. A form's fields then go in question cards. No level
   * answers this: it's the server asking the user, not a tool asking to run.
   */
  private onElicitation(context: ElicitationContext): Promise<ElicitationResult> | ElicitationResult {
    if (this.closing || this.finished) return { action: 'cancel' };
    if (!this.turnRunning) this.beginTurn('system');
    const source = context.elicitationSourceDisplayName ?? context.elicitationSource ?? 'An MCP server';
    const schema = context.requestedSchema;
    const hasFields = context.mode !== 'url' && !!schema && Object.keys(schema.properties).length > 0;
    const requestId = `elicit-${++this.nextRequest}`;
    return new Promise((resolve) => {
      this.pending.set(requestId, {
        answer: (optionId) => {
          if (optionId === ELICIT_OPTION_DECLINE) resolve({ action: 'decline' });
          else if (optionId !== ELICIT_OPTION_ACCEPT) throw new Error(`Unknown Copilot elicitation option ${optionId}`);
          else if (hasFields) this.askElicitationFields(context.message, schema, resolve);
          else resolve({ action: 'accept', ...(context.mode !== 'url' && { content: {} }) });
        },
        cancel: () => resolve({ action: 'cancel' }),
      });
      this.push({
        type: 'permission_request',
        data: {
          requestId,
          title: `${source} is asking`,
          // The URL is for the user to open: nothing here opens a link a server sent.
          description: context.mode === 'url' ? `${context.message}\n${context.url ?? ''}` : context.message,
          toolName: 'elicitation',
          rawInput: { message: context.message, ...(context.url && { url: context.url }), ...(schema && { requestedSchema: schema }) },
          options: [
            { optionId: ELICIT_OPTION_ACCEPT, kind: 'allow_once', label: context.mode === 'url' ? "I've done this in the browser" : hasFields ? 'Answer' : 'Accept' },
            { optionId: ELICIT_OPTION_DECLINE, kind: 'reject_once', label: 'Decline' },
          ],
        },
      }, true);
    });
  }

  private askElicitationFields(message: string, schema: NonNullable<ElicitationContext['requestedSchema']>, resolve: (r: ElicitationResult) => void): void {
    const requestId = `elicit-${++this.nextRequest}`;
    this.pendingQuestions.set(requestId, {
      answer: (answers) => resolve({ action: 'accept', content: elicitationContent(schema, answers) }),
      cancel: () => resolve({ action: 'cancel' }),
    });
    const [first, ...rest] = elicitationQuestions(schema);
    this.push({ type: 'question', data: { requestId, questions: [{ ...first, prompt: `${message}\n\n${first.prompt}` }, ...rest] } }, true);
  }

  /** Approval rides on a permission request, with the plan shown as a document, as for Claude's ExitPlanMode. */
  private onPlan(request: ExitPlanModeRequest): Promise<ExitPlanModeResult> | ExitPlanModeResult {
    if (this.closing || this.finished) return { approved: false };
    if (!this.turnRunning) this.beginTurn('system');
    const requestId = `plan-${++this.nextRequest}`;
    const toolCallId = this.openCall('exit_plan_mode');
    const markdown = request.planContent || request.summary;
    const action = copilotPlanAction(request);
    this.push({ type: 'plan_document', data: { planId: toolCallId ?? requestId, markdown, status: 'ready', toolCallId } }, true);
    return new Promise((resolve) => {
      this.pending.set(requestId, {
        answer(optionId, message) {
          if (optionId === PLAN_OPTION_APPROVE) resolve({ approved: true, ...(action && { selectedAction: action }) });
          else if (optionId === PLAN_OPTION_REJECT) resolve({ approved: false, ...(message && { feedback: message }) });
          else throw new Error(`Unknown Copilot plan option ${optionId}`);
        },
        cancel: () => resolve({ approved: false }),
      });
      this.push({
        type: 'permission_request',
        data: {
          requestId,
          title: 'Plan ready for review',
          description: request.summary,
          toolCallId,
          toolName: 'exit_plan_mode',
          rawInput: { plan: markdown },
          options: [
            { optionId: PLAN_OPTION_APPROVE, kind: 'allow_once', label: 'Approve' },
            { optionId: PLAN_OPTION_REJECT, kind: 'reject_once', label: 'Keep planning' },
          ],
        },
      }, true);
    });
  }

  /** Answer everything open "no" and tell the UI, so nothing waits on a turn that has gone. */
  private settlePending(by: 'agent'): void {
    for (const [requestId, pending] of this.pending) {
      pending.cancel();
      this.push({ type: 'permission_resolved', data: { requestId, decision: 'cancelled', by } }, true);
    }
    this.pending.clear();
    for (const [requestId, pending] of this.pendingQuestions) {
      pending.cancel();
      this.push({ type: 'question_resolved', data: { requestId, answers: {}, cancelled: true } }, true);
    }
    this.pendingQuestions.clear();
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
    // A subagent's own session events (agentId set) don't speak for the session:
    // its idle isn't the turn's, and its model isn't the one the user chose.
    const fromSubagent = !!(event as { agentId?: string }).agentId;
    const subagentOf = (parentToolCallId: string | undefined) => parentToolCallId ?? this.agents.get((event as { agentId?: string }).agentId ?? '');
    if (TURN_OPENING_EVENTS.has(event.type) && !this.turnRunning) this.beginTurn('system');
    switch (event.type) {
      case 'user.message':
        // A queued message starts here, with no idle in between: the run goes
        // idle once, after everything queued. Steers stay in the running turn.
        if (!fromSubagent && event.data.delivery === 'queued') {
          this.endTurn('end_turn');
          this.beginTurn('queued');
        }
        return;
      case 'assistant.message_delta': {
        const { messageId, deltaContent, parentToolCallId } = event.data;
        const subagentId = subagentOf(parentToolCallId);
        this.push({ type: 'agent_message_chunk', data: { messageId, text: deltaContent, ...(subagentId && { subagentId }) } }, true);
        return;
      }
      case 'assistant.message': {
        const { messageId, content, parentToolCallId } = event.data;
        // A round that only calls tools has an empty message.
        const subagentId = subagentOf(parentToolCallId);
        if (content) this.push({ type: 'agent_message', data: { messageId, text: content, ...(subagentId && { subagentId }) } }, true);
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
        const subagentId = subagentOf(parentToolCallId);
        this.tools.set(toolCallId, { name: toolName, args, ...(subagentId && { parent: subagentId }) });
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
            ...(subagentId && { subagentId }),
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
        if (!fromSubagent) this.context = { used: event.data.currentTokens, size: event.data.tokenLimit };
        return;
      case 'session.idle':
        if (fromSubagent) return;
        this.endTurn(event.data.aborted || this.interrupting ? 'cancelled' : 'end_turn');
        return;
      case 'abort':
        this.interrupting = true;
        return;
      case 'session.error':
        // An error during an interrupt is the interrupt. A subagent's failure arrives as subagent.failed.
        if (this.interrupting || fromSubagent) return;
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
      case 'session.model_change': {
        if (fromSubagent) return;
        const efforts = this.effortsOf(this.model).join();
        this.model = event.data.newModel;
        this.effort = event.data.reasoningEffort ?? undefined;
        this.push({ type: 'model_changed', data: { modelId: this.model, ...(this.effort && { effort: this.effort }) } });
        if (this.effortsOf(this.model).join() !== efforts) this.push({ type: 'session_info', data: { efforts: this.effortsOf(this.model) } });
        return;
      }
      case 'session.mode_changed': {
        if (fromSubagent) return;
        // Approving a plan returns the CLI to interactive: back to the level the user acted at.
        const level: PermissionLevel = event.data.newMode === 'plan' ? 'plan' : this.level === 'plan' ? this.actingLevel : this.level;
        if (level === this.level) return;
        this.level = level;
        this.push({ type: 'mode_changed', data: { level, nativeMode: event.data.newMode } });
        return;
      }
      case 'subagent.started': {
        const { toolCallId, agentDisplayName, agentName, agentDescription } = event.data;
        const agentId = (event as { agentId?: string }).agentId;
        if (agentId) this.agents.set(agentId, toolCallId);
        this.push({ type: 'subagent', data: { subagentId: toolCallId, name: agentDisplayName || agentName, description: agentDescription, status: 'running', parentToolCallId: toolCallId } }, true);
        return;
      }
      case 'subagent.completed':
      case 'subagent.failed': {
        const { toolCallId, agentDisplayName, agentName, totalToolCalls, totalTokens } = event.data;
        const failed = event.type === 'subagent.failed';
        const status = failed ? 'failed' : event.data.cancelled ? 'cancelled' : 'completed';
        this.push({
          type: 'subagent',
          data: {
            subagentId: toolCallId,
            name: agentDisplayName || agentName,
            status,
            parentToolCallId: toolCallId,
            ...(totalToolCalls !== undefined && { toolCount: totalToolCalls }),
            ...(totalTokens !== undefined && { usage: { total: totalTokens } }),
          },
        }, true);
        return;
      }
      case 'commands.changed':
        this.commandsLoaded = this.loadCommands();
        return;
      case 'session.compaction_start':
        this.push({ type: 'notice', data: { level: 'info', code: COMPACTION_STARTED, message: 'Compacting context…' } }, true);
        return;
      case 'session.compaction_complete':
        this.push(event.data.success
          ? { type: 'notice', data: { level: 'info', code: 'compacted', message: 'Context compacted' } }
          : { type: 'notice', data: { level: 'warn', code: 'compaction_failed', message: event.data.error ? `Context compaction failed: ${event.data.error}` : 'Context compaction failed' } }, true);
        return;
      case 'session.mcp_servers_loaded': {
        if (fromSubagent) return;
        // Repeats before every turn; report changes only.
        const servers = event.data.servers.map((m) => ({ name: m.name, status: mcpStatus(m.status) }));
        const reported = JSON.stringify(servers);
        if (reported === this.mcpReported) return;
        this.mcpReported = reported;
        this.push({ type: 'session_info', data: { mcpServers: servers } });
        return;
      }
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
      // A provider stands in for a login only because start() hands it to the session.
      const ownProvider = !!copilotProviderFromEnv({ ...process.env, ...env });
      const needsLogin = !auth.isAuthenticated && !ownProvider;
      this.log('info', 'Copilot SDK probe', { binary: binaryPath, cliVersion: status.version, protocolVersion: status.protocolVersion, authenticated: auth.isAuthenticated, authType: auth.authType, ownProvider, needsLogin, elapsedMs: Date.now() - startedAt });
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
        if (!auth.isAuthenticated && !copilotProviderFromEnv({ ...process.env, ...opts.env })) throw new Error(LOGIN_MESSAGE);
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

/**
 * Each model's context tiers, from the SDK's models.list on a local server in
 * an empty folder. Sends no prompt. Throws when it can't read them (no login).
 */
export async function readCopilotTierCatalog(binary: string, env: Record<string, string>): Promise<CopilotTierEntry[]> {
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'clubhouse-copilot-tiers-'));
  let server: CopilotServer | undefined;
  let client: CopilotClient | undefined;
  try {
    server = await launchCopilotServer({ binary, cwd, env, timeoutMs: TIER_CATALOG_TIMEOUT_MS });
    client = await connect(server);
    const models = await withTimeout(client.listModels(), TIER_CATALOG_TIMEOUT_MS, 'Listing models');
    return models.map((m) => copilotTierEntry(m as unknown as Record<string, unknown>)).filter((e): e is CopilotTierEntry => e !== null);
  } finally {
    await client?.forceStop().catch(ignore);
    await server?.kill();
    await fsp.rm(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(ignore);
  }
}

/** Register the driver after ACP, so a provider with no choice saved stays on ACP. Returns the unregister function. */
export function registerCopilotSdkChatDriver(register: (driver: ChatDriver) => () => void, log?: Log): () => void {
  return register(new CopilotSdkChatDriver({ log }));
}
