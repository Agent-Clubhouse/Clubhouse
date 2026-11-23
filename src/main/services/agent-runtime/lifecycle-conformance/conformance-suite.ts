/**
 * Chat driver lifecycle conformance (#3804): one set of cases any ChatDriver
 * runs through ChatAgentRuntime against its own fake transport. The cases
 * check what the runtime and driver already promise (src/shared/chat/README.md,
 * "Lifecycle contract"); they add no provider-processed or exactly-once claim.
 *
 * Test-only: imports vitest. The calling test file must mock
 * './chat-transcript' (relative to agent-runtime), '../log-service' and
 * '../../util/ipc-broadcast', as the runtime tests do, so no case writes to
 * disk or a window.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ActionQueueSettlement, ChatEvent, PermissionOption } from '../../../../shared/chat';
import { ChatAgentRuntime } from '../chat-runtime';
import * as permissionQueue from '../../annex-permission-queue';
import {
  CONFORMANCE_CASES,
  conformanceCoverage,
  type ConformanceCaseId,
  type ConformanceCoverage,
  type ConformanceHarness,
  type ConformanceSubject,
} from './types';

/** Let the runtime's emit chain and queued microtasks settle. */
export async function settle(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setImmediate(r));
}

let agents = 0;

interface Run {
  harness: ConformanceHarness;
  runtime: ChatAgentRuntime;
  events: ChatEvent[];
  of<T extends ChatEvent['type']>(type: T): Array<Extract<ChatEvent, { type: T }>>;
  until(check: () => void): Promise<void>;
}

async function open(subject: ConformanceSubject): Promise<Run> {
  const harness = await subject.create();
  const agentId = `conformance-${++agents}`;
  const runtime = new ChatAgentRuntime({
    agentId,
    provider: harness.driver.provider,
    driverId: harness.driver.id,
    cwd: 'workspace',
    level: 'ask',
    idleTimeoutMs: 0,
    startSession: (resumeNativeSessionId, signal) => harness.driver.start({
      agentId, provider: harness.driver.provider, cwd: 'workspace', binaryPath: 'provider-cli', level: 'ask', resumeNativeSessionId, signal,
    }),
  });
  const events: ChatEvent[] = [];
  runtime.onEvent((event) => { events.push(event); });
  await runtime.start();
  await settle();
  return {
    harness,
    runtime,
    events,
    of: <T extends ChatEvent['type']>(type: T) => events.filter((e): e is Extract<ChatEvent, { type: T }> => e.type === type),
    until: (check) => vi.waitFor(check, { timeout: 5000, interval: 5 }),
  };
}

function optionOf(options: PermissionOption[], kind: PermissionOption['kind']): string {
  const option = options.find((o) => o.kind === kind);
  if (!option) throw new Error(`Permission request has no ${kind} option`);
  return option.optionId;
}

type Case = (run: Run, subject: ConformanceSubject) => Promise<void>;

/** One accepted prompt: one turn, settled once, nothing left pending. */
async function promptTurn(run: Run, text: string, turnsBefore = run.of('turn_ended').length): Promise<void> {
  const native = run.harness.native();
  const before = native.received();
  expect(await run.runtime.sendMessage(text, { source: 'user', delivery: 'prompt' })).toMatchObject({ delivery: 'prompt' });
  expect(native.received()).toBe(before + 1);
  await native.beginTurn();
  await run.until(() => expect(run.runtime.getState()).toBe('running'));
  await native.endTurn('end_turn');
  await run.until(() => expect(run.of('turn_ended')).toHaveLength(turnsBefore + 1));
  await settle();
}

const CASES: Record<ConformanceCaseId, Case> = {
  async prompt_settles_once(run) {
    await promptTurn(run, 'one');
    expect(run.of('turn_started')).toHaveLength(1);
    expect(run.of('turn_ended').map((e) => e.data.stopReason)).toEqual(['end_turn']);
    expect(run.of('user_message').map((e) => e.data.delivery)).toEqual(['prompt']);
    expect(run.runtime.getState()).toBe('idle');
    expect(run.runtime.hasPendingWork()).toBe(false);
  },

  async between_turns_prompt(run) {
    await promptTurn(run, 'one');
    await promptTurn(run, 'two');
    expect(run.of('turn_started')).toHaveLength(2);
    expect(run.of('turn_ended')).toHaveLength(2);
    expect(run.harness.native().received()).toBe(2);
    expect(run.runtime.hasPendingWork()).toBe(false);
  },

  async steer_joins_running_turn(run) {
    const native = run.harness.native();
    await run.runtime.sendMessage('start', { source: 'user', delivery: 'prompt' });
    await native.beginTurn();
    await run.until(() => expect(run.runtime.getState()).toBe('running'));
    expect(await run.runtime.sendMessage('steer', { source: 'user' })).toMatchObject({ delivery: 'steer' });
    expect(native.received()).toBe(2);
    await native.endTurn('end_turn');
    await run.until(() => expect(run.of('turn_ended')).toHaveLength(1));
    await settle();
    expect(run.of('turn_started')).toHaveLength(1);
    expect(run.runtime.hasPendingWork()).toBe(false);
  },

  async merged_submissions_leave_no_debt(run) {
    const native = run.harness.native();
    // Both accepted before the provider starts anything; the provider folds them into one turn.
    await run.runtime.sendMessage('first', { source: 'action', delivery: 'prompt' });
    await run.runtime.sendMessage('second', { source: 'action', delivery: 'prompt' });
    expect(native.received()).toBe(2);
    await native.beginTurn();
    await run.until(() => expect(run.runtime.getState()).toBe('running'));
    await native.endTurn('end_turn');
    await run.until(() => expect(run.of('turn_ended')).toHaveLength(1));
    await settle();
    expect(run.of('turn_started')).toHaveLength(1);
    expect(run.runtime.hasPendingWork()).toBe(false);
    // Later queued input finds the runtime idle and is sent, not held behind a phantom turn.
    expect(await run.runtime.sendMessage('later', { source: 'action', delivery: 'queued' })).toMatchObject({ delivery: 'prompt' });
    expect(native.received()).toBe(3);
    expect(run.runtime.getQueueState().queuedMessageIds).toEqual([]);
  },

  async client_queue_drains_once(run) {
    const native = run.harness.native();
    const settled: ActionQueueSettlement[] = [];
    await run.runtime.sendMessage('start', { source: 'user', delivery: 'prompt' });
    await native.beginTurn();
    await run.until(() => expect(run.runtime.getState()).toBe('running'));
    const held = await run.runtime.sendMessage('held', {
      source: 'action', delivery: 'queued', actionQueue: { actionId: 'a', onSettled: (d) => { settled.push(d); } },
    });
    expect(held.delivery).toBe('queued');
    expect(native.received()).toBe(1);
    await native.endTurn('end_turn');
    await run.until(() => expect(native.received()).toBe(2));
    await native.beginTurn();
    await run.until(() => expect(run.runtime.getState()).toBe('running'));
    await native.endTurn('end_turn');
    await run.until(() => expect(run.of('turn_ended')).toHaveLength(2));
    await settle();
    expect(settled).toEqual(['delivered']);
    expect(native.received()).toBe(2);
    expect(run.runtime.hasPendingWork()).toBe(false);
  },

  async interrupt_settles_as_reported(run) {
    const native = run.harness.native();
    await run.runtime.sendMessage('long', { source: 'user', delivery: 'prompt' });
    await native.beginTurn();
    await run.until(() => expect(run.runtime.getState()).toBe('running'));
    await run.runtime.interrupt();
    await run.until(() => expect(run.of('turn_ended')).toHaveLength(1));
    await settle();
    expect(run.of('turn_ended')[0].data.stopReason).toBe('cancelled');
    expect(run.runtime.getState()).toBe('idle');
    expect(run.runtime.hasPendingWork()).toBe(false);
    expect(run.runtime.isRunning()).toBe(true);
  },

  async interrupt_unreported_stays_open(run) {
    const native = run.harness.native();
    await run.runtime.sendMessage('long', { source: 'user', delivery: 'prompt' });
    await native.beginTurn();
    await run.until(() => expect(run.runtime.getState()).toBe('running'));
    await run.runtime.interrupt();
    await settle();
    // Asking is not an outcome: nothing settles until the provider says how the turn ended.
    expect(run.of('turn_ended')).toHaveLength(0);
    expect(run.runtime.getState()).toBe('running');
    await native.endTurn('cancelled');
    await run.until(() => expect(run.of('turn_ended')).toHaveLength(1));
    expect(run.of('turn_ended')[0].data.stopReason).toBe('cancelled');
  },

  async permission_answered_once(run) {
    const native = run.harness.native();
    await run.runtime.sendMessage('edit', { source: 'user', delivery: 'prompt' });
    await native.beginTurn();
    await native.requestPermission('p1');
    await run.until(() => expect(run.runtime.getState()).toBe('waiting_permission'));
    const [request] = run.of('permission_request');
    expect(permissionQueue.listPendingForAgent(run.runtime.agentId)).toHaveLength(1);
    const allow = optionOf(request.data.options, 'allow_once');
    await run.runtime.respondPermission(request.data.requestId, allow);
    // A second answer from another view is ignored, not sent twice.
    await run.runtime.respondPermission(request.data.requestId, allow);
    await settle();
    expect(run.of('permission_resolved').map((e) => [e.data.decision, e.data.by])).toEqual([['allow', 'user']]);
    expect(run.runtime.getPendingPermissionOptions(request.data.requestId)).toBeUndefined();
    expect(permissionQueue.listPendingForAgent(run.runtime.agentId)).toHaveLength(0);
    expect(run.runtime.getState()).toBe('running');
    await native.endTurn('end_turn');
    await run.until(() => expect(run.runtime.getState()).toBe('idle'));
    expect(run.runtime.hasPendingWork()).toBe(false);
  },

  async permission_closed_by_provider(run) {
    const native = run.harness.native();
    await run.runtime.sendMessage('edit', { source: 'user', delivery: 'prompt' });
    await native.beginTurn();
    await native.requestPermission('p1');
    await run.until(() => expect(run.runtime.getState()).toBe('waiting_permission'));
    const [request] = run.of('permission_request');
    await native.resolvePermissionNatively!(request.data.requestId);
    await run.until(() => expect(run.of('permission_resolved')).toHaveLength(1));
    // The provider's own record goes through as the provider said it; the runtime writes nothing of its own.
    expect(run.of('permission_resolved')[0].data.by).not.toBe('user');
    await native.endTurn('end_turn');
    await run.until(() => expect(run.runtime.getState()).toBe('idle'));
    await settle();
    expect(run.runtime.hasPendingWork()).toBe(false);
    // Not blocking: the next turn runs normally.
    await promptTurn(run, 'next');
    expect(run.of('permission_resolved')).toHaveLength(1);
  },

  async question_answered_once(run) {
    const native = run.harness.native();
    await run.runtime.sendMessage('ask me', { source: 'user', delivery: 'prompt' });
    await native.beginTurn();
    await native.ask!('q1');
    await run.until(() => expect(run.runtime.getState()).toBe('waiting_input'));
    const [question] = run.of('question');
    const answers = { [question.data.questions[0].id]: 'yes' };
    await run.runtime.answerQuestion(question.data.requestId, answers);
    await run.runtime.answerQuestion(question.data.requestId, answers);
    await settle();
    expect(run.of('question_resolved')).toHaveLength(1);
    expect(run.runtime.hasPendingQuestion(question.data.requestId)).toBe(false);
    expect(run.runtime.getState()).toBe('running');
    await native.endTurn('end_turn');
    await run.until(() => expect(run.runtime.getState()).toBe('idle'));
  },

  async question_closed_by_provider(run) {
    const native = run.harness.native();
    await run.runtime.sendMessage('ask me', { source: 'user', delivery: 'prompt' });
    await native.beginTurn();
    await native.ask!('q1');
    await run.until(() => expect(run.runtime.getState()).toBe('waiting_input'));
    const [question] = run.of('question');
    await native.resolveQuestionNatively!(question.data.requestId);
    await run.until(() => expect(run.of('question_resolved')).toHaveLength(1));
    expect(run.runtime.hasPendingQuestion(question.data.requestId)).toBe(false);
    await native.endTurn('end_turn');
    await run.until(() => expect(run.runtime.getState()).toBe('idle'));
    await settle();
    await promptTurn(run, 'next');
  },

  async disconnect_outcome_unknown(run, subject) {
    const native = run.harness.native();
    const accepted = await run.runtime.sendMessage('accepted', { source: 'user', delivery: 'prompt' });
    await native.beginTurn();
    await run.until(() => expect(run.runtime.getState()).toBe('running'));
    await native.disconnect();
    await run.until(() => expect(run.runtime.isRunning()).toBe(false));
    await settle();
    expect(run.of('session_ended').length).toBeGreaterThanOrEqual(1);
    expect(run.runtime.getState()).toBe('sleeping');
    // Nothing is sent again on Clubhouse's own initiative.
    expect(native.received()).toBe(1);
    // The accepted prompt's record stays as written: its outcome is unknown, never relabeled.
    expect(run.of('user_message').filter((e) => e.data.messageId === accepted.messageId).map((e) => e.data.delivery)).toEqual(['prompt']);
    const transitions = run.of('queue_state').flatMap((e) => e.data.transition.messageIds);
    expect(transitions).not.toContain(accepted.messageId);
    const ended = run.of('turn_ended');
    if (subject.traits.disconnectClosure === 'none') {
      expect(ended).toHaveLength(0);
    } else {
      // The driver closing its own bookkeeping. The schema cannot mark it as
      // such (README, "Disconnect"), so it is never a completion.
      expect(ended).toHaveLength(1);
      expect(ended[0].data.stopReason).not.toBe('end_turn');
    }
  },

  async disconnect_held_input_stays_unsent(run) {
    const native = run.harness.native();
    const settled: ActionQueueSettlement[] = [];
    await run.runtime.sendMessage('accepted', { source: 'user', delivery: 'prompt' });
    await native.beginTurn();
    await run.until(() => expect(run.runtime.getState()).toBe('running'));
    // Held in Clubhouse's own queue: provably never handed to the provider.
    const held = await run.runtime.sendMessage('held', {
      source: 'action', delivery: 'queued', actionQueue: { actionId: 'a', onSettled: (d) => { settled.push(d); } },
    });
    expect(held.delivery).toBe('queued');
    await native.disconnect();
    await vi.waitFor(() => expect(run.runtime.isRunning()).toBe(false), { timeout: 1500, interval: 5 });
    await settle();
    expect(native.received()).toBe(1);
    // It was never sent, so it is dropped with the session, and is never dispatched into a dead transport.
    expect(settled).toEqual(['dropped']);
    const statuses = run.of('queue_state').filter((e) => e.data.transition.messageIds.includes(held.messageId!)).map((e) => e.data.transition.status);
    expect(statuses).toEqual(['queued']);
  },

  async disconnect_with_open_requests(run, subject) {
    const native = run.harness.native();
    await run.runtime.sendMessage('edit', { source: 'user', delivery: 'prompt' });
    await native.beginTurn();
    await native.requestPermission('p1');
    await run.until(() => expect(run.of('permission_request')).toHaveLength(1));
    const [request] = run.of('permission_request');
    let questionId: string | undefined;
    if (subject.traits.questions && native.ask) {
      await native.ask('q1');
      await run.until(() => expect(run.of('question')).toHaveLength(1));
      questionId = run.of('question')[0].data.requestId;
    }
    await native.disconnect();
    await run.until(() => expect(run.runtime.isRunning()).toBe(false));
    await settle();
    // Nothing still waits on an answer that can no longer be delivered.
    expect(permissionQueue.listPendingForAgent(run.runtime.agentId)).toHaveLength(0);
    expect(run.runtime.getPendingPermissionOptions(request.data.requestId)).toBeUndefined();
    if (questionId) expect(run.runtime.hasPendingQuestion(questionId)).toBe(false);
    // No answer is invented: never an allow or deny, never by the user.
    const resolved = [...run.of('permission_resolved'), ...run.of('question_resolved')];
    if (subject.traits.disconnectClosure === 'none') {
      expect(resolved).toEqual([]);
    } else {
      for (const e of run.of('permission_resolved')) expect([e.data.decision, e.data.by]).toEqual(['cancelled', 'agent']);
      for (const e of run.of('question_resolved')) expect(e.data.cancelled).toBe(true);
    }
  },

  async send_failure_not_retried(run) {
    const native = run.harness.native();
    native.failNextSend!();
    await expect(run.runtime.sendMessage('lost', { source: 'user', delivery: 'prompt' })).rejects.toThrow();
    await settle();
    // Delivery is unknown: the caller is told, and Clubhouse never sends it again on its own.
    expect(native.received()).toBe(1);
    expect(run.of('user_message')).toHaveLength(0);
    expect(run.runtime.hasPendingWork()).toBe(false);
    expect(run.runtime.isRunning()).toBe(true);
    await promptTurn(run, 'next');
    expect(native.received()).toBe(2);
  },

  async replaced_session_ignored(run) {
    const old = run.harness.native();
    await run.runtime.sendMessage('old', { source: 'user', delivery: 'prompt' });
    await old.beginTurn();
    await run.until(() => expect(run.runtime.getState()).toBe('running'));
    const oldSession = run.runtime.getSessionId();
    await run.runtime.clearContext();
    const fresh = run.harness.native();
    expect(fresh).not.toBe(old);
    // Whatever the old transport still says is not the new conversation's.
    await old.endTurn('end_turn').catch((): void => undefined);
    await settle();
    const newSession = run.runtime.getSessionId();
    expect(newSession).not.toBe(oldSession);
    expect(run.events.filter((e) => e.sessionId === newSession && (e.type === 'turn_started' || e.type === 'turn_ended'))).toEqual([]);
    expect(run.runtime.hasPendingWork()).toBe(false);
    await promptTurn(run, 'new', 0);
    expect(old.received()).toBe(1);
    expect(fresh.received()).toBe(1);
    expect(run.events.filter((e) => e.sessionId === newSession && e.type === 'turn_ended')).toHaveLength(1);
    expect(run.runtime.hasPendingWork()).toBe(false);
  },
};

/**
 * Registers the conformance cases for `subject`. `expectedCoverage` must equal
 * what its traits select, so every skipped case is reviewed per subject and a
 * skip never reads as conformance.
 */
export function describeChatLifecycleConformance(subject: ConformanceSubject, expectedCoverage: ConformanceCoverage): void {
  const coverage = conformanceCoverage(subject);
  describe(`chat lifecycle conformance: ${subject.name}`, () => {
    let run: Run | undefined;
    afterEach(async () => {
      await run?.runtime.stop().catch((): void => undefined);
      await run?.harness.dispose?.();
      run = undefined;
      permissionQueue.reset();
    });

    it('declares its coverage', () => {
      expect(coverage).toEqual(expectedCoverage);
    });

    for (const id of CONFORMANCE_CASES) {
      const status = coverage[id];
      if (status !== 'run') {
        // Not run, never counted as passing; the matrix above names why.
        it.skip(`${id} (${status})`, () => undefined);
        continue;
      }
      it(id, async () => {
        run = await open(subject);
        await CASES[id](run, subject);
      });
    }
  });
}

/**
 * What happens today to input held in Clubhouse's queue when the transport
 * ends mid-turn, for pinning a blocked disconnect_held_input_stays_unsent.
 */
export async function observeHeldInputOnDisconnect(subject: ConformanceSubject) {
  const run = await open(subject);
  try {
    const native = run.harness.native();
    const settled: ActionQueueSettlement[] = [];
    await run.runtime.sendMessage('accepted', { source: 'user', delivery: 'prompt' });
    await native.beginTurn();
    await run.until(() => expect(run.runtime.getState()).toBe('running'));
    const held = await run.runtime.sendMessage('held', {
      source: 'action', delivery: 'queued', actionQueue: { actionId: 'a', onSettled: (d) => { settled.push(d); } },
    });
    await native.disconnect();
    await settle(50);
    return {
      received: native.received(),
      settled,
      statuses: run.of('queue_state').filter((e) => e.data.transition.messageIds.includes(held.messageId!)).map((e) => e.data.transition.status),
      notices: run.of('notice').map((e) => e.data.code),
      turnEnded: run.of('turn_ended').map((e) => e.data.stopReason),
      running: run.runtime.isRunning(),
    };
  } finally {
    await run.runtime.stop().catch((): void => undefined);
    await run.harness.dispose?.();
    permissionQueue.reset();
  }
}
