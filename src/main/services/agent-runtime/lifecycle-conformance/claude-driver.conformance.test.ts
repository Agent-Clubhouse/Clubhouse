/**
 * The real ClaudeChatDriver through the lifecycle conformance suite, over a
 * scripted ClaudeTransport: the seam the driver's own mapping tests use
 * (src/main/chat/claude/driver.test.ts). The driver id is claude_agent_sdk,
 * but the transport is scripted, so this covers the driver's lifecycle
 * mapping shared by the Agent SDK and stream-json transports. It does not
 * cover ClaudeSdkTransport or the SDK process itself: those run against the
 * text-keyed fake-claude.mjs, whose turns run on their own and cannot be
 * stepped by these cases.
 */
import { vi } from 'vitest';

vi.mock('../chat-transcript', () => ({ appendChatEvent: vi.fn(async () => undefined), readChatTranscript: vi.fn(async () => []) }));
vi.mock('../../log-service', () => ({ appLog: vi.fn() }));
vi.mock('../../../util/ipc-broadcast', () => ({ broadcastToAllWindows: vi.fn() }));

import { AsyncQueue } from '../../../orchestrators/adapters/async-queue';
import { ClaudeChatDriver } from '../../../chat/claude/driver';
import type { ClaudeChatEvent, ClaudeChatEventBody } from '../../../chat/claude/events';
import type { ClaudePermissionDecision, ClaudeTransport, ClaudeUserInput } from '../../../chat/claude/transport';
import { describeChatLifecycleConformance } from './conformance-suite';
import type { ConformanceSubject, NativeControl } from './types';

/** The CLI side of one session, as normalized transport events. */
class ScriptedClaudeTransport implements ClaudeTransport {
  readonly kind = 'sdk' as const;
  readonly sent: ClaudeUserInput[] = [];
  readonly answers: Array<[string, ClaudePermissionDecision]> = [];
  readonly sessionId: string;
  private readonly queue = new AsyncQueue<ClaudeChatEvent>();
  private seq = 0;
  private ended = false;

  constructor(index: number) {
    this.sessionId = `claude-session-${index}`;
  }

  get events(): AsyncIterable<ClaudeChatEvent> { return this.queue; }
  emit(body: ClaudeChatEventBody): void {
    this.queue.push({ ...body, sessionId: this.sessionId, turnId: 0, seq: ++this.seq } as ClaudeChatEvent);
  }
  async start(): Promise<void> { this.emit({ kind: 'initialized', commands: [], models: [], raw: { claude_code_version: '2.1.300' } }); }
  /** Both real transports refuse a send once the session has ended (sdk-transport, stream-transport). */
  send(input: ClaudeUserInput): void {
    if (this.ended) throw new Error('Claude SDK session is not running');
    this.sent.push(input);
  }
  respondToPermission(requestId: string, decision: ClaudePermissionDecision): void { this.answers.push([requestId, decision]); }
  /** The CLI ends an interrupted turn with an error_during_execution result. */
  async interrupt(): Promise<void> { this.result('error_during_execution', true); }
  async setPermissionMode(): Promise<void> {}
  async setModel(): Promise<void> {}
  async setEffort(): Promise<void> {}
  async appliedSettings() { return {}; }
  async close(): Promise<void> { this.end(0); }
  result(subtype: string, isError: boolean): void { this.emit({ kind: 'turn_ended', subtype, isError, stopReason: 'end_turn' }); }
  end(exitCode: number): void {
    if (this.ended) return;
    this.ended = true;
    this.emit({ kind: 'session_ended', exitCode, signal: null });
    this.queue.finish();
  }
}

function control(transport: ScriptedClaudeTransport): NativeControl {
  return {
    received: () => transport.sent.length,
    answered: () => transport.answers.length,
    // The driver opens its turn when it sends from idle; the CLI reports only the result.
    beginTurn: async () => undefined,
    endTurn: async (stopReason) => {
      if (stopReason === 'end_turn') transport.result('success', false);
      else transport.result('error_during_execution', true);
    },
    requestPermission: async (requestId) => {
      transport.emit({ kind: 'permission_request', requestId, toolName: 'Bash', input: { command: 'npm test' }, suggestions: [] });
    },
    resolvePermissionNatively: async (requestId) => { transport.emit({ kind: 'permission_cancelled', requestId }); },
    ask: async (requestId) => {
      transport.emit({
        kind: 'permission_request', requestId, toolName: 'AskUserQuestion', suggestions: [],
        input: { questions: [{ question: 'Which?', header: 'Pick', options: [{ label: 'A' }, { label: 'B' }], multiSelect: false }] },
      });
    },
    resolveQuestionNatively: async (requestId) => { transport.emit({ kind: 'permission_cancelled', requestId }); },
    // The CLI exits with nothing more on stdout.
    disconnect: async () => { transport.end(1); },
  };
}

const subject: ConformanceSubject = {
  name: 'Claude driver mapping (claude_agent_sdk id, scripted ClaudeTransport)',
  traits: {
    // A message sent while the driver's turn runs goes to the CLI without a priority, which folds it into the turn.
    mergesPrompts: true,
    steersRunningTurn: true,
    interruptReport: 'provider_reports',
    permissions: true,
    questions: true,
    // The CLI withdraws a request with a control_cancel_request (permission_cancelled).
    nativeResolution: true,
    // On session_ended mid-turn the driver ends its turn ('error') and cancels its requests itself.
    disconnectClosure: 'local_closure',
  },
  // transport.send has no result and throws only once the session ended: there is no controlled refusal of a live send.
  canRejectSend: false,
  create: async () => {
    const transports: ScriptedClaudeTransport[] = [];
    const driver = new ClaudeChatDriver('claude_agent_sdk', {
      createTransport: () => {
        const transport = new ScriptedClaudeTransport(transports.length + 1);
        transports.push(transport);
        return transport;
      },
    });
    return {
      driver,
      native: () => {
        const transport = transports[transports.length - 1];
        if (!transport) throw new Error('No Claude transport created');
        return control(transport);
      },
    };
  },
};

describeChatLifecycleConformance(subject, {
  prompt_settles_once: 'run',
  between_turns_prompt: 'run',
  steer_joins_running_turn: 'run',
  merged_submissions_leave_no_debt: 'run',
  client_queue_drains_once: 'run',
  interrupt_settles_as_reported: 'run',
  interrupt_unreported_stays_open: 'skipped: provider reports interrupts',
  permission_answered_once: 'run',
  permission_closed_by_provider: 'run',
  question_answered_once: 'run',
  question_closed_by_provider: 'run',
  disconnect_outcome_unknown: 'run',
  disconnect_held_input_stays_unsent: 'run',
  disconnect_with_open_requests: 'run',
  send_rejected_not_accepted: 'skipped: no controlled known non-acceptance',
  accepted_submission_fails_later: 'run',
  replaced_session_ignored: 'run',
});
