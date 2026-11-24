/**
 * A provider-neutral scripted protocol for the chat lifecycle conformance
 * suite (#3804). It is not a recording of any CLI. A personality states what
 * a transport reports (native turn receipts, whether a prompt sent while a
 * native operation is open joins it, what an interrupt reports, whether the
 * driver echoes answers), and tests drive the native side by hand: start and
 * end turns, ask for permission, ask questions, report answers given
 * elsewhere, disconnect or crash.
 *
 * Disconnect and crash end the stream with nothing else: no turn_ended, no
 * resolution. That is the reference behavior for "the provider reported
 * nothing". Held receipts reject on disconnect, as a transport's pending RPCs
 * do when its process goes away.
 */

import { AsyncQueue } from '../../../orchestrators/adapters/async-queue';
import {
  MINIMAL_CHAT_CAPABILITIES,
  type ChatCapabilities,
  type ChatDriver,
  type ChatDriverId,
  type ChatDriverProbe,
  type ChatDriverSession,
  type ChatDriverStartOptions,
  type ChatEventDraft,
  type ChatQuestionAnswers,
  type ChatSendReceipt,
  type ContentBlock,
  type MessageDelivery,
  type PermissionLevel,
  type PermissionOption,
  type PermissionResponseExtras,
  type TurnStopReason,
} from '../../../../shared/chat';

export interface ScriptedPersonality {
  /** Label for test names. */
  name: string;
  capabilities: ChatCapabilities;
  /**
   * 'native_turn': the session implements sendWithReceipt and names the
   * native operation each prompt joined. 'none': plain send only.
   */
  receipts: 'native_turn' | 'none';
  /**
   * What the provider does with a prompt sent while a native operation it
   * accepted is open (accepted but not started, or running). 'joins' is the
   * shape Codex turn/start and ACP mid-turn session/prompt document.
   */
  promptWhileOpen: 'joins' | 'new_operation';
  /** What the provider reports when a running turn is interrupted. */
  interrupt: 'reports_cancelled' | 'silent';
  /** The driver reports answers the runtime gave (Claude, Codex do). */
  echoesAnswers: boolean;
}

export const PERMISSION_OPTIONS: PermissionOption[] = [
  { optionId: 'allow', kind: 'allow_once', label: 'Allow' },
  { optionId: 'reject', kind: 'reject_once', label: 'Deny' },
];

interface Operation {
  id: string;
  started: boolean;
  ended: boolean;
}

interface HeldReceipt {
  resolve: (receipt: ChatSendReceipt) => void;
  reject: (err: Error) => void;
  receipt: () => ChatSendReceipt;
}

export class ScriptedProtocolSession implements ChatDriverSession {
  readonly queue = new AsyncQueue<ChatEventDraft>();
  readonly events = this.queue;
  readonly sendWithReceipt?: (content: ContentBlock[], delivery: MessageDelivery) => Promise<ChatSendReceipt>;
  readonly sent: Array<{ content: ContentBlock[]; delivery: MessageDelivery }> = [];
  readonly responses: Array<{ requestId: string; optionId: string }> = [];
  readonly answers: Array<{ requestId: string; answers: ChatQuestionAnswers }> = [];
  interrupts = 0;
  closed = false;
  /** While true, receipts wait for releaseReceipts(). Sends are recorded at once either way. */
  holdReceipts = false;
  /** When set, the next send is refused locally before anything reaches the provider. */
  rejectNextSend: Error | undefined;
  private readonly operations: Operation[] = [];
  private readonly held: HeldReceipt[] = [];
  private nextOperation = 1;
  private disconnected = false;

  constructor(
    readonly personality: ScriptedPersonality,
    public nativeSessionId: string,
    readonly startOptions: ChatDriverStartOptions,
  ) {
    if (personality.receipts === 'native_turn') {
      this.sendWithReceipt = (content, delivery) => this.submit(content, delivery);
    }
  }

  get capabilities(): ChatCapabilities {
    return this.personality.capabilities;
  }

  /** The operation a turn is running, if any. */
  get running(): Operation | undefined {
    return this.operations.find((op) => op.started && !op.ended);
  }

  /** Accepted operations the provider has not started yet, oldest first. */
  get awaiting(): Operation[] {
    return this.operations.filter((op) => !op.started && !op.ended);
  }

  emit(draft: ChatEventDraft): void {
    this.queue.push(draft);
  }

  /** Starts the oldest accepted operation (or `id`), as the provider's turn_started. */
  beginTurn(id?: string): string {
    const op = id ? this.operations.find((o) => o.id === id) : this.awaiting[0];
    if (!op) throw new Error('No accepted operation to start');
    op.started = true;
    this.emit({ type: 'turn_started', data: { trigger: 'prompt', nativeTurnId: op.id } });
    return op.id;
  }

  /** Ends the running turn with the outcome the provider reports. */
  endTurn(stopReason: TurnStopReason = 'end_turn'): void {
    const op = this.running;
    if (!op) throw new Error('No running turn');
    op.ended = true;
    this.emit({ type: 'turn_ended', data: { stopReason } });
  }

  requestPermission(requestId: string, options: PermissionOption[] = PERMISSION_OPTIONS): void {
    this.emit({ type: 'permission_request', data: { requestId, title: `Run ${requestId}`, toolName: 'Bash', options } });
  }

  /** The provider reports a request closed without an answer from the runtime (timeout, cancel, answered elsewhere). */
  resolvePermissionNatively(requestId: string, decision: 'allow' | 'deny' | 'cancelled', by: 'agent' | 'timeout' | 'mode' = 'agent'): void {
    this.emit({ type: 'permission_resolved', data: { requestId, decision, by } });
  }

  ask(requestId: string): void {
    this.emit({ type: 'question', data: { requestId, questions: [{ id: 'q1', prompt: 'Which?', allowFreeText: true }] } });
  }

  resolveQuestionNatively(requestId: string): void {
    this.emit({ type: 'question_resolved', data: { requestId, answers: {}, cancelled: true } });
  }

  /** Answer every held receipt with what it would have said, in order. */
  releaseReceipts(): void {
    for (const held of this.held.splice(0)) held.resolve(held.receipt());
  }

  /** The transport went away with nothing reported. Held receipts reject. */
  disconnect(): void {
    this.disconnected = true;
    for (const held of this.held.splice(0)) held.reject(new Error('Scripted transport disconnected'));
    this.queue.finish();
  }

  /** The stream itself fails (a protocol error), with nothing else reported. */
  crash(message = 'Scripted protocol failure'): void {
    this.disconnected = true;
    for (const held of this.held.splice(0)) held.reject(new Error(message));
    this.queue.fail(new Error(message));
  }

  async send(content: ContentBlock[], delivery: MessageDelivery): Promise<MessageDelivery> {
    return (await this.submit(content, delivery)).delivery;
  }

  private submit(content: ContentBlock[], delivery: MessageDelivery): Promise<ChatSendReceipt> {
    if (this.disconnected) return Promise.reject(new Error('Scripted transport disconnected'));
    const refused = this.rejectNextSend;
    this.rejectNextSend = undefined;
    if (refused) return Promise.reject(refused);
    this.sent.push({ content, delivery });
    const running = this.running;
    let receipt: () => ChatSendReceipt;
    if (delivery === 'steer' && running) {
      // Steering never claims a future turn.
      receipt = () => ({ delivery: 'steer' });
    } else {
      const open = this.personality.promptWhileOpen === 'joins' ? running ?? this.awaiting[0] : undefined;
      const op = open ?? this.accept();
      const effective: MessageDelivery = delivery === 'steer' ? 'prompt' : delivery;
      receipt = () => ({ delivery: effective, nativeTurn: { id: op.id, completed: op.ended } });
    }
    if (!this.holdReceipts) return Promise.resolve(receipt());
    return new Promise((resolve, reject) => { this.held.push({ resolve, reject, receipt }); });
  }

  private accept(): Operation {
    const op = { id: `${this.nativeSessionId}:op-${this.nextOperation++}`, started: false, ended: false };
    this.operations.push(op);
    return op;
  }

  async interrupt(): Promise<void> {
    this.interrupts++;
    if (this.personality.interrupt === 'reports_cancelled' && this.running) this.endTurn('cancelled');
  }

  async respondPermission(requestId: string, optionId: string, _extras?: PermissionResponseExtras): Promise<void> {
    this.responses.push({ requestId, optionId });
    if (this.personality.echoesAnswers) {
      const kind = PERMISSION_OPTIONS.find((o) => o.optionId === optionId)?.kind;
      this.emit({ type: 'permission_resolved', data: { requestId, optionId, decision: kind?.startsWith('allow') ? 'allow' : 'deny', by: 'user' } });
    }
  }

  async answerQuestion(requestId: string, answers: ChatQuestionAnswers): Promise<void> {
    this.answers.push({ requestId, answers });
    if (this.personality.echoesAnswers) this.emit({ type: 'question_resolved', data: { requestId, answers } });
  }

  async setLevel(_level: PermissionLevel): Promise<void> {}
  async setModel(_modelId: string, _effort?: string | null): Promise<void> {}
  async compact(): Promise<void> {}

  async close(): Promise<void> {
    this.closed = true;
    this.disconnect();
  }
}

export class ScriptedProtocolDriver implements ChatDriver {
  readonly sessions: ScriptedProtocolSession[] = [];

  constructor(
    readonly personality: ScriptedPersonality,
    readonly id: ChatDriverId = 'claude_stream_json',
    readonly provider: string = 'scripted',
  ) {}

  get last(): ScriptedProtocolSession {
    const session = this.sessions[this.sessions.length - 1];
    if (!session) throw new Error('No scripted session started');
    return session;
  }

  async probe(): Promise<ChatDriverProbe> {
    return { handshakeOk: true, capabilities: this.personality.capabilities };
  }

  async start(opts: ChatDriverStartOptions): Promise<ChatDriverSession> {
    const session = new ScriptedProtocolSession(this.personality, opts.resumeNativeSessionId ?? `native-${this.sessions.length + 1}`, opts);
    this.sessions.push(session);
    return session;
  }
}

const STEERING: ChatCapabilities = { ...MINIMAL_CHAT_CAPABILITIES, steer: true, interrupt: true, questions: true };

/**
 * The personalities the suite runs. `native-receipts` is the reference for a
 * transport whose provider can merge submissions into one native turn (Codex
 * app-server today; an ACP agent that steers mid-turn prompts).
 */
export const SCRIPTED_PERSONALITIES = {
  /** A plain-send driver whose provider starts one turn per accepted prompt. */
  oneTurnPerPrompt: {
    name: 'plain send, one turn per prompt',
    capabilities: STEERING,
    receipts: 'none',
    promptWhileOpen: 'new_operation',
    interrupt: 'reports_cancelled',
    echoesAnswers: true,
  },
  /** Native receipts; a prompt while an operation is open joins it. */
  nativeReceipts: {
    name: 'native receipts, prompts join the open turn',
    capabilities: STEERING,
    receipts: 'native_turn',
    promptWhileOpen: 'joins',
    interrupt: 'reports_cancelled',
    echoesAnswers: false,
  },
  /** No steer, client queue, native receipts: the Codex-like shape #3783 fixed. */
  nativeReceiptsNoSteer: {
    name: 'native receipts, no steer, client queue',
    capabilities: { ...STEERING, steer: false, queue: 'client' },
    receipts: 'native_turn',
    promptWhileOpen: 'joins',
    interrupt: 'silent',
    echoesAnswers: true,
  },
} satisfies Record<string, ScriptedPersonality>;

/** Steps for the conformance suite over a scripted session. */
export function scriptedNativeControl(session: ScriptedProtocolSession): import('./types').NativeControl {
  return {
    received: () => session.sent.length,
    answered: () => session.responses.length + session.answers.length,
    beginTurn: async () => { session.beginTurn(); },
    endTurn: async (stopReason) => { session.endTurn(stopReason); },
    requestPermission: async (id) => { session.requestPermission(id); },
    resolvePermissionNatively: async (id) => { session.resolvePermissionNatively(id, 'cancelled'); },
    ask: async (id) => { session.ask(id); },
    resolveQuestionNatively: async (id) => { session.resolveQuestionNatively(id); },
    disconnect: async () => { session.disconnect(); },
    rejectNextSend: () => { session.rejectNextSend = new Error('Scripted transport refused the send before dispatch'); },
  };
}
