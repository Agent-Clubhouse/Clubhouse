import { vi } from 'vitest';

vi.mock('../../services/agent-runtime/chat-transcript', () => ({ appendChatEvent: vi.fn(async () => undefined), readChatTranscript: vi.fn(async () => []) }));
vi.mock('../../services/log-service', () => ({ appLog: vi.fn() }));
vi.mock('../../util/ipc-broadcast', () => ({ broadcastToAllWindows: vi.fn() }));

import type { ChatDriverId } from '../../../shared/chat/capabilities';
import type { TurnStopReason } from '../../../shared/chat/events';
import { describeChatLifecycleConformance, settle } from '../../services/agent-runtime/lifecycle-conformance/conformance-suite';
import type { ConformanceSubject, NativeControl } from '../../services/agent-runtime/lifecycle-conformance/types';
import { createAcpChatDriver } from './driver';
import { ACP_ERROR_CODES, type StopReason } from './protocol';
import { ScriptedAcpAgent, type ScriptedPrompt } from './testing/scripted-agent';

// ACP stop reasons for the outcomes the suite asks for. 'timeout' and 'error'
// have no stop reason: the agent answers the prompt with an error instead.
const STOP: Partial<Record<TurnStopReason, StopReason>> = {
  end_turn: 'end_turn', cancelled: 'cancelled', max_tokens: 'max_tokens', max_turns: 'max_turn_requests', refusal: 'refusal',
};

/** NativeControl over one scripted agent connection (one driver session). */
function control(agent: ScriptedAcpAgent): NativeControl {
  let current: ScriptedPrompt | undefined;
  // The driver numbers the agent's permission requests and questions in the
  // order they arrive; this maps its request ids back to JSON-RPC ids.
  const withdraw = async (requestId: string) => {
    const n = Number(/-(\d+)$/.exec(requestId)?.[1]);
    agent.withdraw(agent.clientRequestIds[n - 1]);
    await settle();
  };
  return {
    received: () => agent.promptsWritten,
    answered: () => agent.answers,
    // An ACP turn runs from the prompt's receipt; there's no separate start message.
    async beginTurn() {
      const prompt = await agent.nextPrompt();
      current = prompt;
      // A live agent answers session/cancel by ending the prompt with
      // `cancelled`, as the protocol requires. (An agent lost before that
      // answer is a different case: driver.test.ts keeps it unknown.)
      void agent.cancelled().then(() => {
        if (current !== prompt) return;
        current = undefined;
        prompt.end('cancelled');
      });
    },
    async endTurn(stopReason) {
      const turn = current ?? await agent.nextPrompt();
      current = undefined;
      const reason = STOP[stopReason];
      if (reason) turn.end(reason); else turn.fail(ACP_ERROR_CODES.internalError, `Turn ${stopReason}`);
      await settle();
    },
    async requestPermission() {
      agent.requestPermission(current!.sessionId, { toolCallId: `tool-${agent.clientRequestIds.length + 1}`, title: 'Run a command' });
      await settle();
    },
    resolvePermissionNatively: withdraw,
    async ask() {
      agent.elicit({ mode: 'form', sessionId: current!.sessionId, message: 'Continue?', requestedSchema: { type: 'object', properties: { answer: { type: 'string', title: 'Answer' } } } });
      await settle();
    },
    resolveQuestionNatively: withdraw,
    // Known non-acceptance: the transport refuses the session/prompt write,
    // so it never reaches the agent and send() throws before any turn.
    // (An error answer to a written prompt is accepted_submission_fails_later:
    // endTurn('error') below.)
    rejectNextSend() { agent.refuseNextPromptWrite(); },
    async disconnect() {
      agent.disconnect({ code: 1, signal: null });
      await settle();
    },
  };
}

const subject: ConformanceSubject = {
  name: 'provider-neutral ACP driver (scripted agent)',
  traits: {
    mergesPrompts: false,
    steersRunningTurn: false,
    interruptReport: 'provider_reports',
    permissions: true,
    // The scripted agent asks with elicitation/create; the claim says so.
    questions: true,
    nativeResolution: true,
    disconnectClosure: 'none',
  },
  canRejectSend: true,
  create: async () => {
    // One agent, and one control keeping its running prompt, per driver session.
    let last: { agent: ScriptedAcpAgent; native: NativeControl } | undefined;
    const driver = createAcpChatDriver(
      { id: 'acp_neutral_test' as ChatDriverId, provider: 'acp-test', args: () => [], claims: { questions: true } },
      { connect: () => { const agent = new ScriptedAcpAgent(); last = { agent, native: control(agent) }; return agent.connector; } },
    );
    return { driver, native: () => last!.native };
  },
};

describeChatLifecycleConformance(subject, {
  prompt_settles_once: 'run',
  between_turns_prompt: 'run',
  steer_joins_running_turn: 'skipped: no steer',
  merged_submissions_leave_no_debt: 'skipped: provider does not merge prompts',
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
  send_rejected_not_accepted: 'run',
  accepted_submission_fails_later: 'run',
  replaced_session_ignored: 'run',
});
