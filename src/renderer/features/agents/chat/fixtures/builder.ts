/**
 * Builds stamped ChatEvent streams for ChatView tests and development.
 *
 * Fixtures are contract-level: they look like what the chat runtime publishes
 * after a driver has translated its native protocol (see test/chat-fixtures for
 * the native recordings the drivers replay). Seq starts at 1 per session and
 * timestamps advance by a fixed step unless an event says otherwise.
 */

import type { ChatCapabilities, ChatDriverId, ChatEvent, ChatEventDataMap, ChatEventType, PermissionLevel } from '../../../../../shared/chat';

export const FIXTURE_AGENT_ID = 'agent-chat-fixture';
const START_TS = Date.UTC(2026, 9, 16, 17, 0, 0);

export class ChatFixture {
  readonly events: ChatEvent[] = [];
  private seqs: Record<string, number> = {};
  private ts = START_TS;
  sessionId: string;

  constructor(readonly agentId = FIXTURE_AGENT_ID, sessionId = 'chat-session-1') {
    this.sessionId = sessionId;
  }

  /** Append one event. `advanceMs` moves the clock before stamping it. */
  emit<T extends ChatEventType>(type: T, data: ChatEventDataMap[T], opts: { turnId?: string; advanceMs?: number } = {}): this {
    this.ts += opts.advanceMs ?? 200;
    const seq = (this.seqs[this.sessionId] = (this.seqs[this.sessionId] ?? 0) + 1);
    const event = {
      v: 2,
      agentId: this.agentId,
      sessionId: this.sessionId,
      seq,
      ts: this.ts,
      type,
      data,
      ...(opts.turnId !== undefined && { turnId: opts.turnId }),
    } as ChatEvent;
    this.events.push(event);
    return this;
  }

  start(driver: ChatDriverId, provider: string, capabilities: ChatCapabilities, extra: { model?: string; level?: PermissionLevel; cliVersion?: string } = {}): this {
    this.emit('session_started', {
      driver,
      provider,
      cwd: '/work/clubhouse',
      resumed: false,
      nativeSessionId: `${driver}-native-1`,
      capabilities,
      level: extra.level ?? 'ask',
      ...(extra.model !== undefined && { model: extra.model }),
      ...(extra.cliVersion !== undefined && { cliVersion: extra.cliVersion }),
    });
    return this.emit('session_state', { state: 'idle' });
  }

  /** A user prompt that opens a turn. */
  prompt(turnId: string, text: string, delivery: 'prompt' | 'steer' = 'prompt'): this {
    this.emit('user_message', { messageId: `u-${turnId}-${this.events.length}`, content: [{ type: 'text', text }], source: 'user', delivery }, { turnId, advanceMs: 1000 });
    if (delivery === 'prompt') {
      this.emit('turn_started', { trigger: 'prompt' }, { turnId });
      this.emit('session_state', { state: 'running' });
    }
    return this;
  }

  /** Streams a message in a few chunks, then the final text. */
  say(turnId: string, messageId: string, text: string, opts: { subagentId?: string; final?: boolean } = {}): this {
    const words = text.split(' ');
    const third = Math.max(1, Math.ceil(words.length / 3));
    for (let i = 0; i < words.length; i += third) {
      const chunk = words.slice(i, i + third).join(' ') + (i + third < words.length ? ' ' : '');
      this.emit('agent_message_chunk', { messageId, text: chunk, ...(opts.subagentId && { subagentId: opts.subagentId }) }, { turnId, advanceMs: 120 });
    }
    if (opts.final !== false) {
      this.emit('agent_message', { messageId, text, ...(opts.subagentId && { subagentId: opts.subagentId }) }, { turnId, advanceMs: 50 });
    }
    return this;
  }

  think(turnId: string, messageId: string, text: string, durationMs: number): this {
    this.emit('agent_thought_chunk', { messageId, text }, { turnId });
    return this.emit('agent_thought', { messageId, text, durationMs }, { turnId, advanceMs: durationMs });
  }

  /** A tool call that starts and completes. */
  tool(turnId: string, call: ChatEventDataMap['tool_call'], done: Omit<ChatEventDataMap['tool_call_update'], 'toolCallId'> = { status: 'completed' }, opts: { advanceMs?: number } = {}): this {
    this.emit('tool_call', { ...call, status: 'in_progress' }, { turnId });
    return this.emit('tool_call_update', { toolCallId: call.toolCallId, ...done }, { turnId, advanceMs: opts.advanceMs ?? 400 });
  }

  end(turnId: string, data: ChatEventDataMap['turn_ended']): this {
    this.emit('turn_ended', data, { turnId, advanceMs: 300 });
    return this.emit('session_state', { state: 'idle' });
  }
}
