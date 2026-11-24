import { describe, it, expect, vi } from 'vitest';
import type { ChatEvent } from '../../../../shared/chat';

vi.mock('../chat-transcript', () => ({ appendChatEvent: vi.fn(async () => undefined), readChatTranscript: vi.fn(async () => []) }));
vi.mock('../../log-service', () => ({ appLog: vi.fn() }));
vi.mock('../../../util/ipc-broadcast', () => ({ broadcastToAllWindows: vi.fn() }));

import { ChatAgentRuntime } from '../chat-runtime';
import { describeChatLifecycleConformance, settle } from './conformance-suite';
import {
  SCRIPTED_PERSONALITIES,
  ScriptedProtocolDriver,
  scriptedNativeControl,
  type ScriptedPersonality,
} from './scripted-protocol';
import type { ConformanceSubject, ConformanceTraits } from './types';

function subject(personality: ScriptedPersonality, traits: ConformanceTraits): ConformanceSubject {
  return {
    name: `scripted protocol (${personality.name})`,
    traits,
    canRejectSend: true,
    create: async () => {
      const driver = new ScriptedProtocolDriver(personality);
      return { driver, native: () => scriptedNativeControl(driver.last) };
    },
  };
}

const ALL_RUN = {
  prompt_settles_once: 'run', between_turns_prompt: 'run', steer_joins_running_turn: 'run',
  merged_submissions_leave_no_debt: 'run', client_queue_drains_once: 'run', interrupt_settles_as_reported: 'run',
  interrupt_unreported_stays_open: 'skipped: provider reports interrupts', permission_answered_once: 'run',
  permission_closed_by_provider: 'run', question_answered_once: 'run', question_closed_by_provider: 'run',
  disconnect_outcome_unknown: 'run', disconnect_held_input_stays_unsent: 'run', disconnect_with_open_requests: 'run', send_rejected_not_accepted: 'run', accepted_submission_fails_later: 'run',
  replaced_session_ignored: 'run',
} as const;

const BASE: ConformanceTraits = {
  mergesPrompts: false, steersRunningTurn: true, interruptReport: 'provider_reports',
  permissions: true, questions: true, nativeResolution: true, disconnectClosure: 'none',
};

describeChatLifecycleConformance(subject(SCRIPTED_PERSONALITIES.oneTurnPerPrompt, BASE), {
  ...ALL_RUN, merged_submissions_leave_no_debt: 'skipped: provider does not merge prompts',
});

describeChatLifecycleConformance(subject(SCRIPTED_PERSONALITIES.nativeReceipts, { ...BASE, mergesPrompts: true }), ALL_RUN);

describeChatLifecycleConformance(
  subject(SCRIPTED_PERSONALITIES.nativeReceiptsNoSteer, { ...BASE, mergesPrompts: true, steersRunningTurn: false, interruptReport: 'none' }),
  {
    ...ALL_RUN,
    steer_joins_running_turn: 'skipped: no steer',
    interrupt_settles_as_reported: 'skipped: provider does not report interrupts',
    interrupt_unreported_stays_open: 'run',
  },
);

/**
 * The mechanism behind #3782, pinned for drivers without receipts: the
 * runtime reserves one future turn per accepted prompt and retires one per
 * turn_started. If the provider folds two prompts into one turn, a
 * reservation is left behind. This is why a merging provider needs an
 * adapter whose accounting settles every submission (the
 * merged_submissions_leave_no_debt case); it is not a claim about how.
 */
describe('plain-send accounting when the provider merges prompts (mechanism)', () => {
  it('leaves a reservation behind after the merged turn settles', async () => {
    const driver = new ScriptedProtocolDriver({ ...SCRIPTED_PERSONALITIES.oneTurnPerPrompt, promptWhileOpen: 'joins', name: 'plain send, merging' });
    const runtime = new ChatAgentRuntime({
      agentId: 'mechanism', provider: 'scripted', driverId: driver.id, cwd: 'workspace', level: 'ask', idleTimeoutMs: 0,
      startSession: (resumeNativeSessionId) => driver.start({ agentId: 'mechanism', provider: 'scripted', cwd: 'workspace', binaryPath: 'x', level: 'ask', resumeNativeSessionId }),
    });
    const events: ChatEvent[] = [];
    runtime.onEvent((e) => { events.push(e); });
    try {
      await runtime.start();
      await runtime.sendMessage('first', { source: 'action', delivery: 'prompt' });
      await runtime.sendMessage('second', { source: 'action', delivery: 'prompt' });
      driver.last.beginTurn();
      driver.last.endTurn('end_turn');
      await vi.waitFor(() => expect(events.filter((e) => e.type === 'turn_ended')).toHaveLength(1));
      await settle();
      expect(driver.last.awaiting).toEqual([]);
      expect(runtime.getState()).toBe('idle');
      // Nothing more will start, yet the runtime still counts a future turn.
      expect(runtime.hasPendingWork()).toBe(true);
    } finally {
      await runtime.stop();
    }
  });
});
