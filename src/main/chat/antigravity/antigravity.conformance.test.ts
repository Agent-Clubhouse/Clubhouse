import { vi } from 'vitest';

vi.mock('../../services/agent-runtime/chat-transcript', () => ({ appendChatEvent: vi.fn(async () => undefined), readChatTranscript: vi.fn(async () => []) }));
vi.mock('../../services/log-service', () => ({ appLog: vi.fn() }));
vi.mock('../../util/ipc-broadcast', () => ({ broadcastToAllWindows: vi.fn() }));

import type { TurnStopReason } from '../../../shared/chat/events';
import { describeChatLifecycleConformance, settle } from '../../services/agent-runtime/lifecycle-conformance/conformance-suite';
import type { ConformanceSubject, NativeControl } from '../../services/agent-runtime/lifecycle-conformance/types';
import { ACP_ERROR_CODES, type SessionModeState, type StopReason } from '../acp/protocol';
import { ScriptedAcpAgent, type ScriptedPrompt } from '../acp/testing/scripted-agent';
import { createAntigravityAcpDriver } from './driver';
import type { AntigravityAcpMcp } from './mcp';

/**
 * The #3804 suite against the Antigravity driver over the scripted ACP agent.
 *
 * The docs say a prompt sent while a turn runs steers it, not how each
 * `session/prompt` is then answered. So the suite runs once per plausible
 * answer order; the driver must give the same lifecycle under each. Which
 * order agy really uses is the real-login check #3802 V13.
 */
type SteerAnswers =
  /** Both prompts are answered when the turn ends, with its stop reason. */
  | 'both_end'
  /** The first prompt is answered (end_turn) as the steer joins; the steer's answer carries the outcome. */
  | 'first_ends_on_join'
  /** The steer is refused with an error; the first prompt carries the turn. */
  | 'steer_rejected';

const STOP: Partial<Record<TurnStopReason, StopReason>> = {
  end_turn: 'end_turn', cancelled: 'cancelled', max_tokens: 'max_tokens', max_turns: 'max_turn_requests', refusal: 'refusal',
};

const MODES: SessionModeState = { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }] };

const MCP: AntigravityAcpMcp = {
  buildAntigravityAcpBridgeServer: ({ agentId, nonce, mcpPort }) => ({ name: 'clubhouse', command: 'node', args: ['bridge.js'], env: [
    { name: 'CLUBHOUSE_AGENT_ID', value: agentId }, { name: 'CLUBHOUSE_HOOK_NONCE', value: nonce }, { name: 'CLUBHOUSE_MCP_PORT', value: String(mcpPort) },
  ] }),
  planAntigravityAcpMcpServers: ({ bridge }) => ({ ok: true, servers: [bridge], notices: [] }),
};

function control(agent: ScriptedAcpAgent, answers: SteerAnswers): NativeControl {
  /** Prompts in the running turn, oldest first. */
  let turn: ScriptedPrompt[] = [];
  let taken = 0;
  /** Prompts the agent has received that this control hasn't taken yet join the running turn. */
  const takeJoined = async () => {
    await settle();
    while (taken < agent.promptsWritten) {
      turn.push(await agent.nextPrompt());
      taken++;
    }
  };
  const withdraw = async (requestId: string) => {
    const n = Number(/-(\d+)$/.exec(requestId)?.[1]);
    agent.withdraw(agent.clientRequestIds[n - 1]);
    await settle();
  };
  return {
    received: () => agent.promptsWritten,
    answered: () => agent.answers,
    async beginTurn() {
      const prompt = await agent.nextPrompt();
      taken++;
      turn = [prompt];
      const mine = turn;
      // A live agent answers session/cancel by ending every prompt in the turn with `cancelled`.
      void agent.cancelled().then(async () => {
        if (turn !== mine) return;
        await takeJoined();
        turn = [];
        for (const p of mine) p.end('cancelled');
      });
    },
    async endTurn(stopReason) {
      if (turn.length === 0) { turn = [await agent.nextPrompt()]; taken++; }
      await takeJoined();
      const prompts = turn;
      turn = [];
      const reason = STOP[stopReason];
      const settleOne = (p: ScriptedPrompt) => { if (reason) p.end(reason); else p.fail(ACP_ERROR_CODES.internalError, `Turn ${stopReason}`); };
      const [first, ...steers] = prompts;
      if (steers.length === 0 || answers === 'both_end') {
        for (const p of prompts) settleOne(p);
      } else if (answers === 'first_ends_on_join') {
        first.end('end_turn');
        await settle();
        for (const p of steers) settleOne(p);
      } else {
        for (const p of steers) p.fail(ACP_ERROR_CODES.internalError, 'steer refused');
        await settle();
        settleOne(first);
      }
      await settle();
    },
    async requestPermission() {
      agent.requestPermission(turn[0]!.sessionId, { toolCallId: `tool-${agent.clientRequestIds.length + 1}`, title: 'Run a command' });
      await settle();
    },
    resolvePermissionNatively: withdraw,
    async ask() {
      agent.elicit({ mode: 'form', sessionId: turn[0]!.sessionId, message: 'Continue?', requestedSchema: { type: 'object', properties: { answer: { type: 'string', title: 'Answer' } } } });
      await settle();
    },
    resolveQuestionNatively: withdraw,
    rejectNextSend() { agent.refuseNextPromptWrite(); },
    async disconnect() {
      agent.disconnect({ code: 1, signal: null });
      await settle();
    },
  };
}

function subject(answers: SteerAnswers): ConformanceSubject {
  return {
    name: `Antigravity ACP driver (scripted agent, steer answers: ${answers})`,
    traits: {
      mergesPrompts: false,
      steersRunningTurn: true,
      interruptReport: 'provider_reports',
      permissions: true,
      questions: true,
      nativeResolution: true,
      disconnectClosure: 'none',
    },
    canRejectSend: true,
    create: async () => {
      let last: NativeControl | undefined;
      const driver = createAntigravityAcpDriver({
        mcp: MCP,
        connect: () => { const agent = new ScriptedAcpAgent({ modes: MODES }); last = control(agent, answers); return agent.connector; },
      });
      // The suite's runtime starts the driver with its own options; the bridge env is added here.
      const start = driver.start.bind(driver);
      driver.start = (opts) => start({
        ...opts,
        env: { ...opts.env, CLUBHOUSE_HOOK_NONCE: 'nonce', CLUBHOUSE_MCP_PORT: '1' },
        mcpServers: { clubhouse: { command: 'node', args: ['bridge.js'] }, ...opts.mcpServers },
      });
      return { driver, native: () => last! };
    },
  };
}

for (const answers of ['both_end', 'first_ends_on_join', 'steer_rejected'] as const) {
  describeChatLifecycleConformance(subject(answers), {
    prompt_settles_once: 'run',
    between_turns_prompt: 'run',
    steer_joins_running_turn: 'run',
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
}
