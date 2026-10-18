/**
 * In-memory ChatDriver for tests and for exercising the chat runtime without a
 * CLI. Tests push protocol-level drafts with `emit()` and inspect what the
 * runtime sent with `sent`, `responses` and friends.
 */

import { AsyncQueue } from '../../orchestrators/adapters/async-queue';
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
  type PermissionResponseExtras,
  type ContentBlock,
  type MessageDelivery,
  type PermissionLevel,
} from '../../../shared/chat';

export class FakeChatDriverSession implements ChatDriverSession {
  readonly queue = new AsyncQueue<ChatEventDraft>();
  readonly events = this.queue;
  readonly sent: Array<{ content: ContentBlock[]; delivery: MessageDelivery }> = [];
  readonly responses: Array<{ requestId: string; optionId: string; extras?: PermissionResponseExtras }> = [];
  readonly answers: Array<{ requestId: string; answers: ChatQuestionAnswers }> = [];
  levels: PermissionLevel[] = [];
  models: Array<{ modelId: string; effort?: string | null }> = [];
  interrupts = 0;
  compactions = 0;
  closed = false;

  constructor(
    public nativeSessionId: string | undefined,
    readonly capabilities: ChatCapabilities,
    readonly startOptions?: ChatDriverStartOptions,
  ) {}

  emit(draft: ChatEventDraft): void {
    this.queue.push(draft);
  }

  /** Simulate the CLI process exiting. */
  exit(): void {
    this.queue.finish();
  }

  async send(content: ContentBlock[], delivery: MessageDelivery): Promise<MessageDelivery> {
    this.sent.push({ content, delivery });
    return delivery;
  }

  async interrupt(): Promise<void> { this.interrupts++; }
  async respondPermission(requestId: string, optionId: string, extras?: PermissionResponseExtras): Promise<void> {
    this.responses.push({ requestId, optionId, ...(extras ? { extras } : {}) });
  }
  async answerQuestion(requestId: string, answers: ChatQuestionAnswers): Promise<void> { this.answers.push({ requestId, answers }); }
  async setLevel(level: PermissionLevel): Promise<void> { this.levels.push(level); }
  async setModel(modelId: string, effort?: string | null): Promise<void> { this.models.push({ modelId, effort }); }
  async compact(): Promise<void> { this.compactions++; }

  async close(): Promise<void> {
    this.closed = true;
    this.queue.finish();
  }
}

export class FakeChatDriver implements ChatDriver {
  readonly sessions: FakeChatDriverSession[] = [];

  constructor(
    readonly id: ChatDriverId = 'claude_stream_json',
    readonly provider: string = 'claude-code',
    readonly capabilities: ChatCapabilities = { ...MINIMAL_CHAT_CAPABILITIES, steer: true, interrupt: true },
  ) {}

  get last(): FakeChatDriverSession {
    const session = this.sessions[this.sessions.length - 1];
    if (!session) throw new Error('No fake session started');
    return session;
  }

  async probe(): Promise<ChatDriverProbe> {
    return { handshakeOk: true, capabilities: this.capabilities };
  }

  async start(opts: ChatDriverStartOptions): Promise<ChatDriverSession> {
    const session = new FakeChatDriverSession(
      opts.resumeNativeSessionId ?? `native-${this.sessions.length + 1}`,
      this.capabilities,
      opts,
    );
    this.sessions.push(session);
    return session;
  }
}
