/**
 * Runtime seam (docs/structured-chat-research.md §7.2).
 *
 * `AgentRuntime` is what the rest of Clubhouse talks to for a live agent,
 * whether it runs in a terminal (PTY) or in chat. Every feature that today
 * writes keystrokes into a PTY, reads its buffer or derives status from hooks
 * (MCP send_message/send_file, shoulder taps, group-project inject and polling
 * nudges, /clear and /compact, read_output, update-restart, Annex) moves onto
 * this interface, so chat agents get the same features without
 * `if (runtime === ...)` branches.
 *
 * `ChatDriver` / `ChatDriverSession` are what a protocol transport implements
 * (Claude Agent SDK or stream-json, Codex app-server, Copilot ACP or SDK). The
 * chat runtime owns the session lifecycle, stamps envelopes, writes the
 * transcript and publishes events; drivers only translate protocol traffic.
 *
 * These are type-only definitions shared by main and renderer; implementations
 * live in the main process.
 */

import type { ChatCapabilities, ChatDriverId, PermissionLevel } from './capabilities';
import type {
  ChatEvent,
  ChatEventDraft,
  ChatQuestionAnswers,
  ChatSessionState,
  ContentBlock,
  MessageDelivery,
  MessageSource,
  SessionEndReason,
} from './events';

// ── AgentRuntime ────────────────────────────────────────────────────────────

export type AgentRuntimeKind = 'pty' | 'chat';

export interface RuntimeSendOptions {
  source: MessageSource;
  /**
   * 'auto' steers when a turn is running and the runtime can steer, queues
   * when it can't, and prompts when idle. Default 'auto'.
   */
  delivery?: 'auto' | MessageDelivery;
  /** For agent-to-agent messages; PTY runtimes ignore it. */
  taskId?: string;
  /**
   * PTY only: false types the text without pressing Enter (MCP send_message
   * force_submit=false). Chat runtimes always send.
   */
  submit?: boolean;
}

export interface RuntimeSendResult {
  /** How the message was actually delivered. PTY runtimes always report 'prompt'. */
  delivery: MessageDelivery;
  messageId?: string;
}

/**
 * Extra data for a permission answer. Claude can attach a message to a denial
 * (what to do instead) and an edited input to an approval (e.g. a revised plan
 * for ExitPlanMode). Drivers that can't carry them ignore them.
 */
export interface PermissionResponseExtras {
  message?: string;
  updatedInput?: unknown;
}

export interface RuntimeExitInfo {
  reason: SessionEndReason;
  exitCode: number;
}

/** Transcript slice for MCP read_output, Annex replay and the renderer's initial load. */
export interface RuntimeTranscriptSlice {
  kind: AgentRuntimeKind;
  /** Chat runtimes return events (`tail` counts events); PTY runtimes return the terminal buffer tail (`tail` counts lines). */
  events?: ChatEvent[];
  text?: string;
  /** Sequence number of the last event returned (chat only), for incremental reads. */
  lastSeq?: number;
}

export interface AgentRuntime {
  readonly kind: AgentRuntimeKind;
  readonly agentId: string;

  /** True while a live process backs this runtime. */
  isRunning(): boolean;
  /**
   * True while the runtime is replacing its session (chat clearContext): no
   * process backs it for a moment, but it still runs the agent. Chat only.
   */
  isSwappingSession?(): boolean;
  /** Coarse state for status badges; chat runtimes derive it from events. */
  getState(): ChatSessionState;
  /** When the running turn started (ms), or null between turns. Chat runtimes only. */
  getTurnStartedAt?(): number | null;

  /** Deliver user, mission, MCP, shoulder-tap, group-project or Annex text. */
  sendMessage(content: string | ContentBlock[], opts: RuntimeSendOptions): Promise<RuntimeSendResult>;
  /** Cancel the running turn. Chat keeps the session; PTY sends the provider's interrupt key. */
  interrupt(): Promise<void>;
  /** End the process. Chat sessions remain resumable by native session id. */
  stop(opts?: { graceful?: boolean }): Promise<void>;
  /** Start a fresh context (Claude /clear, a new Codex thread, a new ACP session). */
  clearContext(): Promise<void>;
  /** Compact the context (Claude /compact, Codex thread/compact/start, ACP /compact). */
  compact(): Promise<void>;

  /**
   * Answer a pending permission request with one of its option ids. PTY
   * runtimes resolve the hook-driven permission queue, whose only options are
   * 'allow' and 'deny'; any other id is treated as 'deny'.
   */
  respondPermission(requestId: string, optionId: string, extras?: PermissionResponseExtras): Promise<void>;
  /** Answer a pending question, keyed by question id. */
  answerQuestion(requestId: string, answers: ChatQuestionAnswers): Promise<void>;

  /** Read the transcript; `afterSeq` returns only newer chat events of the current session. */
  readTranscript(opts?: { tail?: number; afterSeq?: number }): Promise<RuntimeTranscriptSlice>;

  /** The CLI's own session id, for resume (PTY runtimes read it from the terminal when the provider prints one). */
  getNativeSessionId(): string | undefined;

  /**
   * Push notifications, each returning an unsubscribe function. PTY runtimes
   * report only liveness changes ('sleeping' on exit); terminal status detail
   * still arrives through hooks.
   */
  onStateChange(listener: (state: ChatSessionState) => void): () => void;
  onExit(listener: (info: RuntimeExitInfo) => void): () => void;
  /** Every stamped event for this agent (chat runtimes only; the global bus carries all agents). */
  onEvent?(listener: (event: ChatEvent) => void): () => void;

  /** Chat-only controls; undefined on PTY runtimes. */
  setLevel?(level: PermissionLevel): Promise<void>;
  setModel?(modelId: string, effort?: string | null): Promise<void>;
  /** Capability record of the active chat driver; undefined on PTY runtimes. */
  getCapabilities?(): ChatCapabilities | undefined;
}

// ── ChatDriver ──────────────────────────────────────────────────────────────

/** An MCP server's HTTP endpoint; see ChatDriverStartOptions.mcpHttpEndpoints. */
export interface McpHttpEndpoint {
  url: string;
  /** Header name → name of the env var (in ChatDriverStartOptions.env) holding its value. */
  headersFromEnv?: Record<string, string>;
}

export interface ChatDriverStartOptions {
  agentId: string;
  /** Orchestrator id, e.g. 'claude-code'. */
  provider: string;
  cwd: string;
  /** The user's own installed CLI. Drivers never use a bundled binary. */
  binaryPath: string;
  env?: Record<string, string>;
  /** Shell command prefix from project settings, applied the same way as for PTY agents. */
  commandPrefix?: string;
  model?: string;
  effort?: string;
  level: PermissionLevel;
  systemPrompt?: string;
  /**
   * Continue this native session instead of starting a new one. Clubhouse's
   * transcript already holds the history, so a driver whose resume replays it
   * (ACP session/load) must swallow the replayed updates rather than re-emit
   * them as new events.
   */
  resumeNativeSessionId?: string;
  /** MCP servers to attach, keyed by name (the Clubhouse bridge plus project servers). */
  mcpServers?: Record<string, unknown>;
  /**
   * HTTP endpoints serving the same server as a stdio entry in `mcpServers`,
   * keyed by that entry's name. A driver whose agent takes HTTP MCP servers
   * (ACP agents that advertise `mcpCapabilities.http`) sends the endpoint
   * instead of the stdio command. Header values are named by env var and
   * resolved from `env`, so secrets such as the agent's nonce stay out of
   * this object (#2240).
   */
  mcpHttpEndpoints?: Record<string, McpHttpEndpoint>;
  /**
   * Provider-specific extra CLI args (e.g. Copilot --agent / --source).
   * Best-effort: drivers whose transport can't pass CLI args (the Claude Agent
   * SDK) ignore them and should log that they did.
   */
  extraArgs?: string[];
  /**
   * Aborted when the start is cancelled (the agent was killed or a newer
   * start replaced this one). Drivers should close their CLI right away; the
   * runtime stops waiting either way and closes a session that arrives late.
   */
  signal?: AbortSignal;
}

export interface ChatDriverSession {
  /**
   * Values known at start. Either may change later: the driver then emits a
   * `session_info` event (e.g. Claude stream-json sends system/init only after
   * the first prompt), and the runtime treats that event as authoritative.
   */
  readonly nativeSessionId: string | undefined;
  readonly capabilities: ChatCapabilities;
  /**
   * Native protocol translated into contract events, in order. The chat
   * runtime stamps envelopes (agentId, sessionId, seq, ts) and may synthesize
   * lifecycle events (session_state, turn_started/turn_ended) when a driver
   * doesn't report them. The iterable ends when the process exits.
   */
  readonly events: AsyncIterable<ChatEventDraft>;

  /** Send content. Returns how it was delivered (a driver without steer reports 'queued' or 'prompt'). */
  send(content: ContentBlock[], delivery: MessageDelivery): Promise<MessageDelivery>;
  interrupt(): Promise<void>;
  respondPermission(requestId: string, optionId: string, extras?: PermissionResponseExtras): Promise<void>;
  answerQuestion(requestId: string, answers: ChatQuestionAnswers): Promise<void>;
  setLevel(level: PermissionLevel): Promise<void>;
  /**
   * Effort is applied according to `capabilities.effortSwitch`; with 'restart' it takes effect on the next start.
   * Omitted keeps the current effort; null returns it to the provider's default (`capabilities.effortDefault`).
   */
  setModel(modelId: string, effort?: string | null): Promise<void>;
  compact(): Promise<void>;
  /** Stop the CLI process. Resolves when it has exited. */
  close(): Promise<void>;
}

export interface ChatDriverProbe {
  cliVersion?: string;
  /** True when the CLI completed its handshake without a login and sent no model request. */
  handshakeOk: boolean;
  capabilities: ChatCapabilities;
  error?: string;
  /** Bounded probe failure category; safe to export without the error text. */
  errorCode?: 'spawn_failed' | 'process_exited' | 'rpc_timeout' | 'protocol_error' | 'unknown';
  /**
   * True when the CLI reports no usable login (Claude initialize account,
   * Codex account/read, ACP auth methods). The handshake itself can still
   * succeed. Clubhouse then opens the agent in the terminal so the user can
   * log in with the CLI's own flow.
   */
  needsLogin?: boolean;
  /** How to log in, in the CLI's words, e.g. "Run copilot login". */
  loginHint?: string;
  /**
   * True when the version lookup failed in a way that may pass (a timeout,
   * a slow first launch): the probe isn't cached, so the next start retries
   * it rather than skipping the version policy until the binary changes.
   */
  versionTransient?: boolean;
}

export interface ChatDriver {
  readonly id: ChatDriverId;
  readonly provider: string;
  /**
   * Zero-token handshake used for availability checks, fallback decisions and
   * the nightly smoke test. `commandPrefix` launches the CLI the same way
   * start() will.
   */
  probe(binaryPath: string, env?: Record<string, string>, opts?: { commandPrefix?: string }): Promise<ChatDriverProbe>;
  start(opts: ChatDriverStartOptions): Promise<ChatDriverSession>;
}

// ── Settings ────────────────────────────────────────────────────────────────

/** What the renderer needs to choose an agent's view. */
export interface ChatAgentRuntimeInfo {
  /**
   * The agent uses the chat runtime: chat runs it now, a chat start is in
   * progress, or (when asked with `starting`) it is waking into chat (#2206).
   */
  chat: boolean;
  /**
   * A chat runtime is running the agent right now. Absent from older answers,
   * where `chat` meant the same thing.
   */
  live?: boolean;
  /** A chat driver is registered for the agent's provider, so it can switch to chat. */
  chatAvailable: boolean;
}

export type AgentRuntimeMode = 'chat' | 'terminal';

export interface ProviderRuntimeSetting {
  mode: AgentRuntimeMode;
  /** Chat transport when a provider has more than one (Claude: agent SDK or stream-json). */
  driver?: ChatDriverId;
}

/**
 * Per-provider runtime preference, keyed by orchestrator id. Only consulted
 * when the experimental Chat flag is on; a missing entry means the provider's
 * default. Durable agents can override `mode` individually.
 */
export type ChatRuntimeSettings = Record<string, ProviderRuntimeSetting>;
