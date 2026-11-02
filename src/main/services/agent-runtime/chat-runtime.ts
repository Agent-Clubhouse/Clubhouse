/**
 * AgentRuntime over a chat driver session.
 *
 * Owns everything protocol-independent so drivers stay thin:
 * - envelope stamping (agentId, sessionId, turnId, seq, ts), transcript
 *   append and bus publish, in order;
 * - session lifecycle: a turn ending does NOT end the session; the process
 *   lives until stop(), the idle timeout, or the CLI exits;
 * - message delivery: steer when the driver can, otherwise a client-side queue
 *   drained at turn end;
 * - permission requests mirrored into the shared permission queue, so the
 *   existing desktop prompt and Annex approve chat agents too.
 *
 * Driver contract: drivers emit turn_started / turn_ended for every turn they
 * run. The runtime emits user_message, session_started, session_state,
 * session_ended, permission_resolved and question_resolved itself. A driver
 * that also reports an answer the runtime gave (Claude, Codex) has that echo
 * dropped, whatever its decision; a driver's own cancellation of a request
 * the runtime never answered still goes through.
 */

import { randomUUID } from 'crypto';
import {
  CHAT_CONTRACT_VERSION,
  coalesceUpdateContent,
  type AgentRuntime,
  type ChatCapabilities,
  type ChatDriverId,
  type ChatDriverSession,
  type ChatResumeTiming,
  type ChatEvent,
  type ChatEventDraft,
  type ChatEventDataMap,
  type ChatQuestionAnswers,
  type ChatSessionState,
  type PermissionResponseExtras,
  type RuntimeExitInfo,
  type ContentBlock,
  type MessageDelivery,
  type MessageSource,
  type PermissionLevel,
  type PermissionOption,
  type RoutedMessagePart,
  type RuntimeSendOptions,
  type RuntimeSendResult,
  type RuntimeTranscriptSlice,
  type SessionEndReason,
} from '../../../shared/chat';
import { appendChatEvent, readChatTranscript } from './chat-transcript';
import { currentRequestTraceparent } from '../../telemetry/facade';
import { captureChatTrace, stampChatTrace, type ChatTraceContext } from '../../telemetry/chat-trace-context';
import { publishChatEvent } from './chat-event-bus';
import * as permissionQueue from '../annex-permission-queue';
import { broadcastToAllWindows } from '../../util/ipc-broadcast';
import { IPC } from '../../../shared/ipc-channels';
import { appLog } from '../log-service';
import { ChatMediaPolicy } from './chat-media';
import { agentRegistry } from '../agent-registry';
import { ACCESS_LEVELS, accessLevelOf, launchAccessForChatLevel } from '../../../shared/orchestration-policy';

export const DEFAULT_CHAT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/** "30 min", "1 h", "4 h", "90 min" for an idle timeout. */
export function formatIdle(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60} h`;
  return `${Math.max(1, minutes)} min`;
}
/** Longest a pre-prompt hook (checkpoint) may delay a prompt. */
const BEFORE_PROMPT_TIMEOUT_MS = 5000;
/** Chat permission requests wait for the user; the queue entry only needs to outlive them. */
const CHAT_PERMISSION_QUEUE_TIMEOUT_MS = 24 * 60 * 60 * 1000;

const TURN_SCOPED: ReadonlySet<ChatEvent['type']> = new Set([
  'turn_started', 'turn_ended', 'user_message', 'agent_message_chunk', 'agent_message',
  'agent_thought_chunk', 'agent_thought', 'tool_call', 'tool_call_update', 'permission_request',
  'permission_resolved', 'question', 'question_resolved', 'plan', 'plan_document', 'subagent',
]);

export interface ChatAgentRuntimeOptions {
  agentId: string;
  provider: string;
  driverId: ChatDriverId;
  cwd: string;
  /** Whether rich chat content (inline images) is on; read per event. Off when absent. */
  richMedia?: () => boolean;
  /**
   * Starts (or resumes) a driver session. Called once at start and again after
   * clearContext(). `signal` aborts when stop() or abandon() cancels the start.
   */
  startSession: (resumeNativeSessionId?: string, signal?: AbortSignal) => Promise<ChatDriverSession>;
  /** Continue this native session on start. */
  resumeNativeSessionId?: string;
  /** Clubhouse chat session to continue (keeps the transcript's sequence going). */
  sessionId?: string;
  /** Sequence number already written for `sessionId`. */
  lastSeq?: number;
  level: PermissionLevel;
  /**
   * Agent system prompt. Drivers that can pass it natively receive it in their
   * start options; for drivers whose capabilities say `systemPrompt: false`,
   * the runtime prepends it to the first message sent.
   */
  systemPrompt?: string;
  /**
   * Awaited (up to a few seconds) before each new prompt is sent, e.g. to
   * checkpoint the working tree. Never blocks steering into a running turn.
   */
  beforePrompt?: () => Promise<void>;
  /**
   * Idle time before the runtime sleeps, read each time the timer arms so a
   * settings change applies from the next idle period. 0 or less: never.
   */
  idleTimeoutMs?: number | (() => number);
  /**
   * Asked when the idle timer fires; false keeps the agent awake and re-arms
   * (e.g. it waits on a group project that is polling).
   */
  shouldIdleSleep?: () => boolean;
  /**
   * Offered each question before the user sees it (#2366): a helper under a
   * hands-off orchestrator sends it to the orchestrator. Returns who it was
   * delivered to, or null to ask the user. Never throws past the runtime.
   */
  routeQuestion?: (question: ChatEventDataMap['question']) => Promise<QuestionRoute | null>;
  /** Called once when the runtime ends for good (stop, idle timeout or process exit). */
  onEnded?: (reason: SessionEndReason, exitCode: number) => void;
  /** Called whenever the CLI reports a native session id (for resume on the next wake). */
  onNativeSessionId?: (nativeSessionId: string) => void;
  /** The CLI's output folder for a native session, by name only (#2422). */
  sessionOutputDir?: (nativeSessionId: string) => string | undefined;
  /** Notices written right after the first session_started (untested CLI version, driver fallback). */
  startNotices?: Array<ChatEventDataMap['notice']>;
  now?: () => number;
  newId?: () => string;
}

/** Who a routed question went to (the helper's parent). */
export type QuestionRoute = NonNullable<ChatEventDataMap['question']['routedTo']>;

/** A start that stop() or abandon() cancelled before its session was up. */
export class ChatStartCancelledError extends Error {
  constructor() {
    super('Chat start cancelled');
    this.name = 'ChatStartCancelledError';
  }
}

/**
 * A message held for the next turn (client-side queue). Consecutive MCP
 * messages share one item (#2414): `messageId` is the first one's, and
 * `parts` holds each message's content, in order.
 */
interface QueuedMessage {
  trace?: ChatTraceContext;
  messageId: string;
  source: MessageSource;
  parts: ContentBlock[][];
  /** The system prompt, for a driver that can't pass it natively, sent ahead of the first message. */
  preamble: ContentBlock[];
}

interface PendingPermission {
  chatRequestId: string;
  options: PermissionOption[];
  queueRequestId?: string;
  settled: boolean;
}

export class ChatAgentRuntime implements AgentRuntime {
  readonly kind = 'chat' as const;
  readonly agentId: string;

  private session: ChatDriverSession | undefined;
  private sessionId: string;
  private seq: number;
  private state: ChatSessionState = 'starting';
  private turnId: string | undefined;
  /** When the running turn started, for status timestamps (Annex). */
  private turnStartedAt: number | null = null;
  /**
   * Requests whose answer the runtime itself wrote to the transcript. A driver
   * that also reports its own answer (Claude, Codex) would otherwise write a
   * second permission_resolved or question_resolved for one click.
   */
  private readonly answeredHere = new Set<string>();
  private nativeSessionId: string | undefined;
  /** How the last session open went with a requested resume, for chat start telemetry (#2304). */
  private resumeOpen: { honored: boolean; timing?: ChatResumeTiming } | undefined;
  private capabilities: ChatCapabilities | undefined;
  private pendingTrace?: ChatTraceContext;
  private pendingTraceAssigned = false;
  private turnTrace?: ChatTraceContext;
  private readonly queued: QueuedMessage[] = [];
  private publishedQueueState = { queuedMessageIds: [] as string[], queueStateSeq: 0 };
  /** drainQueue is sending the next queued item: the turn it starts hasn't begun yet. */
  private draining = false;
  private readonly permissions = new Map<string, PendingPermission>();
  /** Questions awaiting an answer, so a late or duplicate answer is ignored. */
  private readonly questions = new Set<string>();
  /** Open questions that went to the parent orchestrator rather than the user, as asked. */
  private readonly routedQuestions = new Map<string, ChatEventDataMap['question']>();
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private sleptAfterMs: number | undefined;
  private ended = false;
  private stopRequested = false;
  /** clearContext() is replacing the driver session: no session is open, but chat still runs the agent. */
  private swapping = false;
  /** Aborts the driver start in progress, if any. */
  private opening: AbortController | undefined;
  private systemPromptApplied = false;
  private startNoticesEmitted = false;
  /** Serializes stamping so seq order matches transcript and bus order. */
  private emitChain: Promise<void> = Promise.resolve();
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly stateListeners = new Set<(state: ChatSessionState) => void>();
  private readonly exitListeners = new Set<(info: RuntimeExitInfo) => void>();
  private readonly eventListeners = new Set<(event: ChatEvent) => void>();

  /** Stores images out of events, or drops them while rich chat content is off. */
  private readonly media: ChatMediaPolicy;

  constructor(private readonly opts: ChatAgentRuntimeOptions) {
    this.agentId = opts.agentId;
    this.sessionId = opts.sessionId ?? opts.newId?.() ?? randomUUID();
    this.seq = opts.lastSeq ?? 0;
    this.now = opts.now ?? Date.now;
    this.newId = opts.newId ?? randomUUID;
    this.media = new ChatMediaPolicy({
      agentId: opts.agentId,
      enabled: () => opts.richMedia?.() === true,
      cwd: () => opts.cwd,
      resolveAsset: async (assetId) => this.session?.resolveMediaAsset?.(assetId),
    });
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  async start(mission?: string | ContentBlock[], routed?: RoutedMessagePart[]): Promise<void> {
    await this.openSession(this.opts.resumeNativeSessionId);
    if (mission && (typeof mission !== 'string' || mission.trim() !== '')) {
      await this.sendMessage(mission, { source: 'mission', delivery: 'prompt', ...(routed && { routed }) });
    }
  }

  /** True once stop() has been called, even if the session never opened. */
  get wasStopped(): boolean {
    return this.stopRequested;
  }

  private async openSession(resumeNativeSessionId: string | undefined): Promise<void> {
    // A new driver session never echoes answers given in the old one.
    this.answeredHere.clear();
    await this.setState('starting');
    // A new session (start, /clear) runs at the spawn level, whatever the
    // old one was set to: record it for the helper ceiling (#2228), and drop
    // the user's level from the old session.
    this.recordLevel(this.opts.level, 'lower');
    const session = await this.startDriverSession(resumeNativeSessionId);
    this.session = session;
    agentRegistry.setUserLaunchAccess(this.agentId, undefined);
    this.recordLevel(this.opts.level, 'report');
    this.capabilities = session.capabilities;
    this.noteNativeSessionId(session.nativeSessionId ?? resumeNativeSessionId);
    this.resumeOpen = resumeNativeSessionId
      ? { honored: this.nativeSessionId === resumeNativeSessionId, ...(session.resumeTiming && { timing: session.resumeTiming }) }
      : undefined;
    appLog('core:chat', 'info', 'Chat session open', {
      meta: {
        agentId: this.agentId,
        driver: this.opts.driverId,
        nativeSessionId: this.nativeSessionId ?? null,
        requestedResumeId: resumeNativeSessionId ?? null,
        // False when the CLI started fresh instead of resuming (e.g. the old session was gone).
        resumeHonored: this.resumeOpen?.honored ?? null,
      },
    });
    await this.emit({
      type: 'session_started',
      data: {
        driver: this.opts.driverId,
        provider: this.opts.provider,
        cwd: this.opts.cwd,
        resumed: !!resumeNativeSessionId,
        nativeSessionId: this.nativeSessionId,
        level: this.opts.level,
        capabilities: session.capabilities,
      },
    });
    if (!this.startNoticesEmitted) {
      this.startNoticesEmitted = true;
      for (const notice of this.opts.startNotices ?? []) await this.emit({ type: 'notice', data: notice });
    }
    await this.setState('idle');
    this.armIdleTimer();
    void this.pump(session);
  }

  /**
   * The driver start, cancellable: stop() or abandon() rejects it at once
   * instead of waiting for the driver to give up, and a session that still
   * arrives afterwards is closed, not adopted.
   */
  private async startDriverSession(resumeNativeSessionId: string | undefined): Promise<ChatDriverSession> {
    if (this.ended) throw new ChatStartCancelledError();
    const opening = new AbortController();
    this.opening = opening;
    const pending = this.opts.startSession(resumeNativeSessionId, opening.signal);
    try {
      return await new Promise<ChatDriverSession>((resolve, reject) => {
        const onAbort = () => reject(new ChatStartCancelledError());
        opening.signal.addEventListener('abort', onAbort, { once: true });
        pending.then(
          (session) => {
            opening.signal.removeEventListener('abort', onAbort);
            if (opening.signal.aborted) {
              void session.close().catch((): void => undefined);
              return;
            }
            resolve(session);
          },
          (err) => {
            opening.signal.removeEventListener('abort', onAbort);
            reject(opening.signal.aborted ? new ChatStartCancelledError() : err);
          },
        );
      });
    } finally {
      if (this.opening === opening) this.opening = undefined;
    }
  }

  private cancelOpening(): void {
    const opening = this.opening;
    this.opening = undefined;
    opening?.abort();
  }

  private async pump(session: ChatDriverSession): Promise<void> {
    try {
      for await (const draft of session.events) {
        if (this.session !== session) break;
        if (this.isEchoedAnswer(draft)) continue;
        await this.observe(draft);
        if (this.session !== session) break;
        await this.emit(draft);
        if (this.session !== session) break;
        await this.afterEvent(draft);
      }
    } catch (err) {
      if (this.session === session) {
        await this.emit({
          type: 'error',
          data: { code: 'driver_stream_failed', message: err instanceof Error ? err.message : String(err), fatal: true },
        });
        // Don't leave the CLI running behind a session we're about to end.
        await session.close().catch((): void => undefined);
      }
    }
    // The stream ends when the CLI process exits. A replaced session (clearContext) is not an end.
    if (this.session === session && !this.ended) {
      this.session = undefined;
      await this.end('process_exit', 0);
    }
  }

  /**
   * A driver's own report of an answer the runtime already recorded. Any
   * decision counts, 'cancelled' included (Codex "Deny and stop the turn"):
   * the runtime wrote that answer. A driver's cancellation of a request the
   * runtime never answered (an interrupt) isn't an echo and goes through.
   */
  private isEchoedAnswer(draft: ChatEventDraft): boolean {
    if (draft.type === 'permission_resolved') return this.answeredHere.delete(`p:${draft.data.requestId}`);
    if (draft.type === 'question_resolved') return this.answeredHere.delete(`q:${draft.data.requestId}`);
    return false;
  }

  /**
   * Note that the runtime records this answer itself, before the driver is
   * told, so the driver's echo is dropped whichever arrives first. Returns the
   * undo, for when the driver call fails and nothing was answered.
   */
  private answerHere(kind: 'p' | 'q', requestId: string): () => void {
    const key = `${kind}:${requestId}`;
    this.answeredHere.add(key);
    return () => { this.answeredHere.delete(key); };
  }

  /** The runtime's own record of an answer, in the current turn, so it sits with the request it answers. */
  private async emitAnswer(draft: Extract<ChatEventDraft, { type: 'permission_resolved' | 'question_resolved' }>): Promise<void> {
    if (!draft.turnId && this.turnId) draft.turnId = this.turnId;
    await this.emit(draft);
  }

  private async observe(draft: ChatEventDraft): Promise<void> {
    switch (draft.type) {
      case 'turn_started':
        this.turnTrace = this.pendingTrace;
        this.pendingTrace = undefined;
        this.pendingTraceAssigned = false;
        this.turnId = draft.turnId ?? this.newId();
        this.turnStartedAt = this.now();
        this.clearIdleTimer();
        break;
      case 'session_state':
        this.state = draft.data.state;
        break;
      case 'mode_changed':
        // The ceiling for this agent's helpers follows its live level (#2228).
        this.recordLevel(draft.data.level, 'report');
        break;
      case 'question':
        await this.offerQuestion(draft.data);
        break;
      case 'session_info':
        if (draft.data.capabilities && this.capabilities) {
          this.capabilities = { ...this.capabilities, ...draft.data.capabilities };
        }
        if (draft.data.nativeSessionId) this.noteNativeSessionId(draft.data.nativeSessionId);
        break;
    }
    if (hasNativeSessionId(draft)) this.noteNativeSessionId(draft.data.nativeSessionId);
    if (!draft.turnId && this.turnId && TURN_SCOPED.has(draft.type)) {
      draft.turnId = this.turnId;
    }
  }

  private async afterEvent(draft: ChatEventDraft): Promise<void> {
    switch (draft.type) {
      case 'turn_started':
        await this.setState('running');
        break;
      case 'turn_ended':
        this.turnTrace = undefined;
        this.turnId = undefined;
        this.turnStartedAt = null;
        await this.setState('idle');
        await this.drainQueue();
        if (this.state === 'idle') this.armIdleTimer();
        break;
      case 'permission_request':
        await this.setState('waiting_permission');
        this.mirrorPermission(draft.data.requestId, draft.data.toolName ?? draft.data.title, draft.data.rawInput, draft.data.title, draft.data.options);
        break;
      case 'question':
        // With a router, offerQuestion already opened it, and an answer may
        // have closed it again while the event was written.
        if (!this.opts.routeQuestion) this.questions.add(draft.data.requestId);
        // A routed question waits on the parent, not the user: the turn stays running.
        if (this.questions.has(draft.data.requestId) && !this.routedQuestions.has(draft.data.requestId)) {
          await this.setState('waiting_input');
        }
        break;
      case 'question_resolved':
        this.questions.delete(draft.data.requestId);
        this.routedQuestions.delete(draft.data.requestId);
        break;
    }
  }

  /**
   * Give a new question to routeQuestion before it is written. It is marked
   * open first, so an answer that comes back at once is taken.
   */
  private async offerQuestion(question: ChatEventDataMap['question']): Promise<void> {
    if (!this.opts.routeQuestion) return;
    this.questions.add(question.requestId);
    let route: QuestionRoute | null = null;
    try {
      route = await this.opts.routeQuestion(question);
    } catch (err) {
      // telemetry-exempt: logged; the question falls back to the user
      appLog('core:chat', 'warn', 'Question routing failed; asking the user', {
        meta: { agentId: this.agentId, error: err instanceof Error ? err.message : String(err) },
      });
    }
    // Gone while routing (answered, or the session ended or was cleared).
    if (!route || !this.questions.has(question.requestId)) return;
    this.routedQuestions.set(question.requestId, { ...question });
    question.routedTo = route;
  }

  private async end(reason: SessionEndReason, exitCode: number, message?: string): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    this.clearIdleTimer();
    this.settleAllPermissions();
    // Drivers that never echo (ACP) leave their keys behind; nothing can echo after the end.
    this.answeredHere.clear();
    await this.emit({ type: 'session_ended', data: { reason, exitCode, ...(message ? { message } : {}) } });
    await this.setState('sleeping');
    await this.emitChain;
    for (const listener of this.exitListeners) listener({ reason, exitCode });
    this.opts.onEnded?.(reason, exitCode);
  }

  // ── AgentRuntime ───────────────────────────────────────────────────────

  isRunning(): boolean {
    return !!this.session && !this.ended;
  }

  isSwappingSession(): boolean {
    return this.swapping && !this.ended;
  }

  getState(): ChatSessionState {
    return this.state;
  }

  getTurnStartedAt(): number | null {
    return this.turnStartedAt;
  }

  getCapabilities(): ChatCapabilities | undefined {
    return this.capabilities;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  /** Set when the last session open was asked to resume: whether it did, and the load's timings. */
  getResumeOpen(): { honored: boolean; timing?: ChatResumeTiming } | undefined {
    return this.resumeOpen;
  }

  getNativeSessionId(): string | undefined {
    return this.nativeSessionId;
  }

  getSessionOutputDir(): string | undefined {
    return this.nativeSessionId ? this.opts.sessionOutputDir?.(this.nativeSessionId) : undefined;
  }

  onStateChange(listener: (state: ChatSessionState) => void): () => void {
    this.stateListeners.add(listener);
    return () => { this.stateListeners.delete(listener); };
  }

  onExit(listener: (info: RuntimeExitInfo) => void): () => void {
    this.exitListeners.add(listener);
    return () => { this.exitListeners.delete(listener); };
  }

  onEvent(listener: (event: ChatEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => { this.eventListeners.delete(listener); };
  }

  async sendMessage(content: string | ContentBlock[], opts: RuntimeSendOptions): Promise<RuntimeSendResult> {
    const session = this.requireSession();
    const blocks: ContentBlock[] = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
    // While the queue drains, the state still reads idle; a prompt now would race the drained one.
    const running = this.draining
      || this.state === 'running' || this.state === 'waiting_permission' || this.state === 'waiting_input';
    const caps = this.capabilities ?? session.capabilities;

    let wanted: MessageDelivery;
    const requested = opts.delivery ?? 'auto';
    if (requested === 'auto') {
      wanted = !running ? 'prompt' : caps.steer ? 'steer' : 'queued';
    } else if (requested === 'steer' && !caps.steer) {
      wanted = running ? 'queued' : 'prompt';
    } else if (requested === 'prompt' && running) {
      wanted = caps.steer ? 'steer' : 'queued';
    } else {
      wanted = requested;
    }

    const traceContext = captureChatTrace(currentRequestTraceparent());
    const messageId = this.newId();
    const correlation = {
      ...(opts.clientCommandId && { clientCommandId: opts.clientCommandId }),
      ...(opts.routed && { routed: opts.routed }),
    };
    if (wanted === 'queued' && caps.queue !== 'native') {
      // Helper reports and Clubhouse notices arriving mid-turn join the MCP
      // item at the tail, so a burst becomes one turn. Never a user's message.
      const tail = this.queued[this.queued.length - 1];
      if (opts.source === 'mcp' && tail?.source === 'mcp') {
        tail.parts.push(blocks);
        await this.emit({
          type: 'user_message',
          data: { messageId, ...correlation, content: blocks, source: opts.source, delivery: 'queued', queuedWith: tail.messageId },
        });
        return { delivery: 'queued', messageId: tail.messageId };
      }
      const preamble = this.withSystemPrompt([], caps);
      this.queued.push({ messageId, source: opts.source, parts: [blocks], preamble, trace: traceContext });
      // Written together, so no turn_started falls between the message and the event that says the runtime holds it.
      await Promise.all([
        this.emit({ type: 'user_message', data: { messageId, ...correlation, content: blocks, source: opts.source, delivery: 'queued' } }),
        this.emitQueueState([messageId], 'queued'),
      ]);
      return { delivery: 'queued', messageId };
    }

    const outgoing = this.withSystemPrompt(blocks, caps);

    this.clearIdleTimer();
    if (wanted === 'prompt') await this.runBeforePrompt();
    // A steer belongs to the existing turn; native queued delivery has no reliable
    // dispatch boundary, so do not invent a parent for its later turn.
    if (wanted === 'prompt') {
      // Two dispatches before a driver turn boundary are ambiguous. Do not
      // attribute the first turn to whichever request happened to arrive last.
      this.pendingTrace = this.pendingTraceAssigned ? undefined : traceContext;
      this.pendingTraceAssigned = true;
    }
    let delivered: MessageDelivery;
    try { delivered = await session.send(outgoing, wanted); }
    catch (error) {
      if (this.pendingTrace === traceContext) { this.pendingTrace = undefined; this.pendingTraceAssigned = false; }
      throw error;
    }
    if (wanted === 'prompt' && delivered !== 'prompt' && this.pendingTrace === traceContext) {
      this.pendingTrace = undefined;
      this.pendingTraceAssigned = false;
    }
    await this.emit({ type: 'user_message', data: { messageId, ...correlation, content: blocks, source: opts.source, delivery: delivered } });
    return { delivery: delivered, messageId };
  }

  async removeQueued(messageIds?: readonly string[]): Promise<string[]> {
    const wanted = messageIds ? new Set(messageIds) : undefined;
    const removed: string[] = [];
    for (let i = this.queued.length - 1; i >= 0; i--) {
      const { messageId } = this.queued[i];
      if (wanted && !wanted.has(messageId)) continue;
      this.queued.splice(i, 1);
      removed.unshift(messageId);
    }
    if (removed.length) {
      await this.emit({ type: 'queue_removed', data: { messageIds: removed } });
      await this.emitQueueState(removed, 'removed');
    }
    return removed;
  }

  getQueueState(): { queuedMessageIds: string[]; queueStateSeq: number; queueRemovalSupported: boolean } {
    return { ...this.publishedQueueState, queuedMessageIds: [...this.publishedQueueState.queuedMessageIds],
      queueRemovalSupported: this.isRunning() && this.getCapabilities()?.queue !== 'native' };
  }

  private emitQueueState(messageIds: string[], status: ChatEventDataMap['queue_state']['transition']['status']): Promise<void> {
    return this.emit({ type: 'queue_state', data: { queuedMessageIds: this.queued.map((item) => item.messageId), transition: { messageIds, status } } });
  }

  private async runBeforePrompt(): Promise<void> {
    if (!this.opts.beforePrompt) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => { timer = setTimeout(resolve, BEFORE_PROMPT_TIMEOUT_MS); });
    try {
      await Promise.race([this.opts.beforePrompt().catch((): void => undefined), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Prepend the system prompt once, for drivers that can't pass it natively. The transcript keeps the user's own text. */
  private withSystemPrompt(blocks: ContentBlock[], caps: ChatCapabilities): ContentBlock[] {
    const prompt = this.opts.systemPrompt?.trim();
    if (!prompt || caps.systemPrompt || this.systemPromptApplied) return blocks;
    this.systemPromptApplied = true;
    return [{ type: 'text', text: prompt }, ...blocks];
  }

  private async drainQueue(): Promise<void> {
    const session = this.session;
    if (!session) return;
    const next = this.queued.shift();
    if (!next) return;
    this.draining = true;
    try {
      this.clearIdleTimer();
      await this.emitQueueState([next.messageId], 'dispatching');
      await this.runBeforePrompt();
      if (this.session !== session) return;
      this.pendingTrace = this.pendingTraceAssigned ? undefined : next.trace;
      this.pendingTraceAssigned = true;
      await session.send([...next.preamble, ...coalesceUpdateContent(next.parts)], 'prompt');
      if (this.session === session) await this.emitQueueState([next.messageId], 'delivered');
    } catch (err) {
      if (this.pendingTrace === next.trace) { this.pendingTrace = undefined; this.pendingTraceAssigned = false; }
      if (this.session === session) await this.emitQueueState([next.messageId], 'failed');
      throw err;
    } finally {
      this.draining = false;
    }
  }

  async interrupt(): Promise<void> {
    const session = this.requireSession();
    if ((this.capabilities ?? session.capabilities).interrupt) {
      await session.interrupt();
    } else {
      await this.stop();
    }
  }

  /**
   * Tear down after a failed start: close the CLI and cancel timers and
   * mirrored permissions. It never calls onEnded (no untrack, no exit
   * broadcast), so the caller can fall back to the terminal on the same agent
   * id. If a session had started, it ends with reason 'fallback', so
   * consumers (the renderer, telemetry) don't keep it open.
   */
  async abandon(): Promise<void> {
    this.cancelOpening();
    if (this.ended) return;
    appLog('core:chat', 'info', 'Abandoning chat start', { meta: { agentId: this.agentId, driver: this.opts.driverId, sessionOpen: !!this.session } });
    this.ended = true;
    this.clearIdleTimer();
    this.settleAllPermissions();
    const session = this.session;
    this.session = undefined;
    if (session) {
      await this.emit({ type: 'session_ended', data: { reason: 'fallback', message: 'Chat start failed; using the CLI view' } });
      await this.emitChain;
      await session.close().catch((): void => undefined);
    }
  }

  async stop(opts: { throwOnFailure?: boolean } = {}): Promise<void> {
    const session = this.session;
    appLog('core:chat', 'info', 'Stopping chat session', {
      meta: { agentId: this.agentId, driver: this.opts.driverId, nativeSessionId: this.nativeSessionId ?? null, sessionOpen: !!session },
    });
    this.stopRequested = true;
    this.session = undefined;
    // Stopped mid-start: cancel the driver start so it can't open a session
    // (or time out and fall back) after this runtime has ended.
    this.cancelOpening();
    if (session) {
      try {
        await session.close();
      } catch (err) {
        appLog('core:chat', 'warn', 'Driver close failed', {
          meta: { agentId: this.agentId, error: err instanceof Error ? err.message : String(err) },
        });
        if (opts.throwOnFailure) {
          // Keep a still-live session reachable for a retry. Reporting it as
          // asleep would let a later delete skip shutdown after this failure.
          if (!this.ended) this.session = session;
          throw err;
        }
      }
    }
    await this.end('stopped', 0);
  }

  /** Starts a new conversation: new Clubhouse session id, fresh native session. */
  async clearContext(): Promise<void> {
    const old = this.session;
    this.session = undefined;
    // Between closing the old session and opening the new one, isRunning() is
    // false; isSwappingSession() keeps the agent counted as a chat agent, so a
    // view asking "which runtime?" mid-clear doesn't get "terminal" (#2218).
    this.swapping = true;
    try {
      this.settleAllPermissions();
      this.queued.length = 0;
      this.pendingTrace = undefined;
      this.pendingTraceAssigned = false;
      this.turnTrace = undefined;
      this.turnId = undefined;
      if (old) await old.close();
      // Finish queued writes under the old id before starting its replacement.
      await this.emitChain;
      this.sessionId = this.newId();
      this.seq = 0;
      this.publishedQueueState = { queuedMessageIds: [], queueStateSeq: 0 };
      this.systemPromptApplied = false;
      this.nativeSessionId = undefined;
      await this.emit({ type: 'notice', data: { level: 'info', code: 'context_cleared', message: 'Started a new conversation.' } });
      await this.openSession(undefined);
    } finally {
      this.swapping = false;
    }
  }

  async compact(): Promise<void> {
    await this.requireSession().compact();
  }

  getPendingPermissionOptions(requestId: string): readonly PermissionOption[] | undefined {
    const pending = this.permissions.get(requestId);
    return pending && !pending.settled ? pending.options : undefined;
  }

  async respondPermission(requestId: string, optionId: string, extras?: PermissionResponseExtras): Promise<void> {
    const session = this.requireSession();
    const pending = this.permissions.get(requestId);
    // Already answered (another view, the desktop prompt or Annex got there first): nothing to do.
    if (!pending || pending.settled) return;
    pending.settled = true;
    const undo = this.answerHere('p', requestId);
    try {
      await session.respondPermission(requestId, optionId, extras);
    } catch (err) {
      pending.settled = false;
      undo();
      throw err;
    }
    const option = pending?.options.find((o) => o.optionId === optionId);
    const decision = decisionFor(option);
    this.settlePermission(requestId, decision === 'allow' ? 'allow' : 'deny');
    await this.emitAnswer({
      type: 'permission_resolved',
      data: { requestId, optionId, decision, by: 'user' },
    });
    if (this.state === 'waiting_permission' && this.permissions.size === 0) await this.setState('running');
  }

  async answerQuestion(requestId: string, answers: ChatQuestionAnswers): Promise<void> {
    const session = this.requireSession();
    // Already answered from another view: nothing to do.
    if (!this.questions.delete(requestId)) return;
    const undo = this.answerHere('q', requestId);
    try {
      await session.answerQuestion(requestId, answers);
    } catch (err) {
      this.questions.add(requestId);
      undo();
      throw err;
    }
    this.routedQuestions.delete(requestId);
    await this.emitAnswer({ type: 'question_resolved', data: { requestId, answers } });
    if (this.state === 'waiting_input') await this.setState('running');
  }

  hasPendingQuestion(requestId: string): boolean {
    return this.questions.has(requestId);
  }

  async escalateQuestion(requestId: string, notice: string): Promise<boolean> {
    const question = this.routedQuestions.get(requestId);
    if (!question || !this.questions.has(requestId)) return false;
    this.routedQuestions.delete(requestId);
    await this.emit({ type: 'notice', data: { level: 'info', code: 'question_escalated', message: notice } });
    // The user may have answered it in the helper's chat meanwhile.
    if (!this.questions.has(requestId)) return true;
    // Again without routedTo, so every view shows it as the user's to answer.
    await this.emit({ type: 'question', ...(this.turnId && { turnId: this.turnId }), data: question });
    await this.setState('waiting_input');
    return true;
  }

  async setLevel(level: PermissionLevel): Promise<void> {
    const session = this.requireSession();
    // Helpers' ceiling (#2228): take a lowering at once, a raise only once
    // the driver accepted it, so the record never runs above the agent.
    // setLevel is the user's choice (chat level menu, Annex), the only thing
    // allowed to lift the record above the spawn cap.
    this.recordLevel(level, 'lower');
    await session.setLevel(level);
    this.recordLevel(level, 'user');
  }

  /**
   * Record the agent's live level on its registry entry, the ceiling for its
   * helpers (#2228):
   * - `lower`: only if it lowers the record (before a change takes effect);
   * - `user`: a level the user chose, recorded as is;
   * - `report`: a level the driver reports (mode_changed, a session
   *   opening), clamped to max(spawn cap, the user's last level). So a
   *   change the agent makes itself (ExitPlanMode, a native mode switch)
   *   never lifts it above what the user allowed.
   */
  private recordLevel(level: PermissionLevel, how: 'lower' | 'user' | 'report'): void {
    const next = launchAccessForChatLevel(level);
    if (how === 'user') {
      agentRegistry.setUserLaunchAccess(this.agentId, next);
      return;
    }
    if (how === 'lower') {
      const before = agentRegistry.get(this.agentId)?.launchAccess;
      if (ACCESS_LEVELS.indexOf(accessLevelOf(next)) >= ACCESS_LEVELS.indexOf(accessLevelOf(before))) return;
    }
    agentRegistry.reportLaunchAccess(this.agentId, next);
  }

  async setModel(modelId: string, effort?: string | null): Promise<void> {
    await this.requireSession().setModel(modelId, effort);
  }

  async readTranscript(opts?: { tail?: number; afterSeq?: number }): Promise<RuntimeTranscriptSlice> {
    await this.emitChain;
    const events = await readChatTranscript(this.agentId, {
      sessionId: this.sessionId,
      afterSeq: opts?.afterSeq,
      tail: opts?.tail,
    });
    return { kind: 'chat', events, lastSeq: events.length ? events[events.length - 1].seq : undefined };
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private requireSession(): ChatDriverSession {
    if (!this.session || this.ended) throw new Error(`Chat session for ${this.agentId} is not running`);
    return this.session;
  }

  private noteNativeSessionId(id: string | undefined): void {
    if (!id || id === this.nativeSessionId) return;
    this.nativeSessionId = id;
    this.opts.onNativeSessionId?.(id);
  }

  private async setState(state: ChatSessionState): Promise<void> {
    if (this.state === state) return;
    this.state = state;
    for (const listener of this.stateListeners) listener(state);
    await this.emit({ type: 'session_state', data: { state } });
  }

  private emit(draft: ChatEventDraft): Promise<void> {
    const traceContext = draft.type === 'user_message'
      ? captureChatTrace(currentRequestTraceparent()) : this.turnTrace;
    const next = this.emitChain.then(async () => {
      const prepared = await this.media.apply(draft).catch((err: unknown) => {
        // Never lose the event: write it without its images instead.
        appLog('core:chat', 'warn', 'Chat media step failed', { meta: { agentId: this.agentId, error: err instanceof Error ? err.message : String(err) } });
        return this.media.withoutMedia(draft);
      });
      if (!prepared) return;
      draft = prepared;
      const event = {
        v: CHAT_CONTRACT_VERSION,
        agentId: this.agentId,
        sessionId: this.sessionId,
        ...(draft.turnId ? { turnId: draft.turnId } : {}),
        seq: ++this.seq,
        ts: this.now(),
        type: draft.type,
        data: draft.data,
      } as ChatEvent;
      if (event.type === 'queue_state') this.publishedQueueState = { queuedMessageIds: [...event.data.queuedMessageIds], queueStateSeq: event.seq };
      try {
        await appendChatEvent(event);
      } catch (err) {
        appLog('core:chat', 'error', 'Transcript append failed', {
          meta: { agentId: this.agentId, error: err instanceof Error ? err.message : String(err) },
        });
      }
      stampChatTrace(event, traceContext);
      publishChatEvent(event);
      for (const listener of this.eventListeners) {
        try { listener(event); } catch { /* consumers must not break the runtime */ }
      }
    });
    this.emitChain = next.catch((): void => undefined);
    return next;
  }

  private idleTimeout(): number {
    const configured = this.opts.idleTimeoutMs;
    return typeof configured === 'function' ? configured() : configured ?? DEFAULT_CHAT_IDLE_TIMEOUT_MS;
  }

  /** Arm for the configured timeout, less `idleSoFar` ms already spent idle in this period. */
  private armIdleTimer(idleSoFar = 0): void {
    this.clearIdleTimer();
    const ms = this.idleTimeout();
    if (!(ms > 0)) return;
    const wait = Math.max(0, ms - idleSoFar);
    this.idleTimer = setTimeout(() => { void this.sleepForIdle(idleSoFar + wait); }, wait);
    this.idleTimer.unref?.();
  }

  /**
   * The idle timeout changed (#2143): an idle session re-arms so the new value
   * applies now, counting from the change rather than sleeping at once.
   */
  idleTimeoutChanged(): void {
    if (this.state !== 'idle' || this.ended || !this.session) return;
    this.armIdleTimer();
  }

  /** The idle timeout the runtime slept after, once it has (for the sleep reason). */
  get idleSleptAfterMs(): number | undefined {
    return this.sleptAfterMs;
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private async sleepForIdle(idleFor: number): Promise<void> {
    if (this.state !== 'idle' || this.ended) return;
    // Read the setting again: Never, or a longer timeout, chosen since the
    // timer armed applies to this idle period too.
    const ms = this.idleTimeout();
    if (!(ms > 0)) return;
    if (idleFor < ms) {
      this.armIdleTimer(idleFor);
      return;
    }
    if (this.opts.shouldIdleSleep && !this.opts.shouldIdleSleep()) {
      appLog('core:chat', 'info', 'Idle timeout reached; staying awake', { meta: { agentId: this.agentId } });
      this.armIdleTimer();
      return;
    }
    // Take the session before anything awaits, so a prompt arriving now finds
    // the agent asleep rather than starting a turn that is then closed.
    const session = this.session;
    this.session = undefined;
    this.sleptAfterMs = ms;
    await this.emit({ type: 'notice', data: { level: 'info', code: 'idle_sleep', message: `Slept after ${formatIdle(ms)} idle.` } });
    if (session) await session.close().catch((): void => undefined);
    await this.end('idle_timeout', 0);
  }

  /** Mirror into the shared queue so the desktop prompt, badges and Annex see it. */
  private mirrorPermission(
    chatRequestId: string,
    toolName: string,
    rawInput: unknown,
    title: string,
    options: PermissionOption[],
  ): void {
    const pending: PendingPermission = { chatRequestId, options, settled: false };
    this.permissions.set(chatRequestId, pending);
    const input = rawInput && typeof rawInput === 'object' ? (rawInput as Record<string, unknown>) : undefined;
    const { requestId, decision } = permissionQueue.createPermission(
      this.agentId, toolName, input, title, CHAT_PERMISSION_QUEUE_TIMEOUT_MS,
    );
    pending.queueRequestId = requestId;
    // The desktop prompt is driven by these broadcasts, as for hook-driven requests.
    broadcastToAllWindows(IPC.AGENT.PERMISSION_PENDING, this.agentId, {
      requestId,
      agentId: this.agentId,
      toolName,
      toolInput: input,
      message: title,
      createdAt: this.now(),
      timeoutMs: CHAT_PERMISSION_QUEUE_TIMEOUT_MS,
    });
    void decision.then(async (d) => {
      if (pending.settled || d === 'timeout' || !this.session) return;
      const option = d === 'allow'
        ? options.find((o) => o.kind === 'allow_once') ?? options.find((o) => o.kind === 'allow_session')
        : options.find((o) => o.kind === 'reject_once') ?? options.find((o) => o.kind === 'reject_always') ?? options.find((o) => o.kind === 'cancel_turn');
      if (!option) return;
      pending.settled = true;
      broadcastToAllWindows(IPC.AGENT.PERMISSION_SETTLED, this.agentId, { requestId, agentId: this.agentId, decision: d });
      const undo = this.answerHere('p', chatRequestId);
      try {
        await this.session.respondPermission(chatRequestId, option.optionId);
        this.permissions.delete(chatRequestId);
        await this.emitAnswer({
          type: 'permission_resolved',
          data: { requestId: chatRequestId, optionId: option.optionId, decision: d, by: 'annex' },
        });
        if (this.state === 'waiting_permission' && this.permissions.size === 0) await this.setState('running');
      } catch (err) {
        undo();
        appLog('core:chat', 'warn', 'Applying queued permission decision failed', {
          meta: { agentId: this.agentId, requestId: chatRequestId, error: err instanceof Error ? err.message : String(err) },
        });
      }
    });
  }

  /** Withdraw the mirrored queue entry after the request was answered in chat (or the session ended). */
  private settlePermission(chatRequestId: string, decision: 'allow' | 'deny' | 'ask' = 'ask'): void {
    const pending = this.permissions.get(chatRequestId);
    if (!pending) return;
    pending.settled = true;
    this.permissions.delete(chatRequestId);
    if (pending.queueRequestId) {
      permissionQueue.cancelPermission(pending.queueRequestId, 'answered in chat', this.agentId);
      broadcastToAllWindows(IPC.AGENT.PERMISSION_SETTLED, this.agentId, {
        requestId: pending.queueRequestId, agentId: this.agentId, decision,
      });
    }
  }

  private settleAllPermissions(): void {
    for (const id of [...this.permissions.keys()]) this.settlePermission(id);
    this.questions.clear();
    this.routedQuestions.clear();
  }
}

function hasNativeSessionId(draft: ChatEventDraft): draft is Extract<ChatEventDraft, { type: 'session_started' }> & { data: { nativeSessionId: string } } {
  return draft.type === 'session_started' && typeof draft.data.nativeSessionId === 'string';
}

function decisionFor(option: PermissionOption | undefined): 'allow' | 'deny' | 'cancelled' {
  if (!option) return 'deny';
  if (option.kind === 'cancel_turn') return 'cancelled';
  return option.kind.startsWith('allow') ? 'allow' : 'deny';
}
