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
  ChatSessionState,
  ContentBlock,
  MessageDelivery,
  MessageSource,
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
}

export interface RuntimeSendResult {
  /** How the message was actually delivered. PTY runtimes always report 'prompt'. */
  delivery: MessageDelivery;
  messageId?: string;
}

/** Transcript slice for MCP read_output, Annex replay and the renderer's initial load. */
export interface RuntimeTranscriptSlice {
  kind: AgentRuntimeKind;
  /** Chat runtimes return events; PTY runtimes return the terminal buffer tail. */
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
  /** Coarse state for status badges; chat runtimes derive it from events. */
  getState(): ChatSessionState;

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

  /** Answer a pending permission request with one of its option ids. */
  respondPermission(requestId: string, optionId: string): Promise<void>;
  /** Answer a pending question. */
  answerQuestion(requestId: string, answer: string): Promise<void>;

  /** Read the transcript; `afterSeq` returns only newer chat events. */
  readTranscript(opts?: { tail?: number; afterSeq?: number }): Promise<RuntimeTranscriptSlice>;

  /** Chat-only controls; undefined on PTY runtimes. */
  setLevel?(level: PermissionLevel): Promise<void>;
  setModel?(modelId: string, effort?: string): Promise<void>;
  /** Capability record of the active chat driver; undefined on PTY runtimes. */
  getCapabilities?(): ChatCapabilities | undefined;
}

// ── ChatDriver ──────────────────────────────────────────────────────────────

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
  /** Continue this native session instead of starting a new one. */
  resumeNativeSessionId?: string;
  /** MCP servers to attach, keyed by name (the Clubhouse bridge plus project servers). */
  mcpServers?: Record<string, unknown>;
  /** Provider-specific extra CLI args (e.g. Copilot --agent / --source). */
  extraArgs?: string[];
}

export interface ChatDriverSession {
  /** Known once the CLI reports it; may arrive after start. */
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
  respondPermission(requestId: string, optionId: string): Promise<void>;
  answerQuestion(requestId: string, answer: string): Promise<void>;
  setLevel(level: PermissionLevel): Promise<void>;
  setModel(modelId: string, effort?: string): Promise<void>;
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
}

export interface ChatDriver {
  readonly id: ChatDriverId;
  readonly provider: string;
  /** Zero-token handshake used for availability checks, fallback decisions and the nightly smoke test. */
  probe(binaryPath: string, env?: Record<string, string>): Promise<ChatDriverProbe>;
  start(opts: ChatDriverStartOptions): Promise<ChatDriverSession>;
}

// ── Settings ────────────────────────────────────────────────────────────────

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
