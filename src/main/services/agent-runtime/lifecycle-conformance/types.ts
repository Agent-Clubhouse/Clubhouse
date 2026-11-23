/**
 * What a chat driver supplies to run the lifecycle conformance suite (#3804).
 * Vitest-free, so a driver's own testing module can implement it. The
 * contract the suite checks is written in src/shared/chat/README.md.
 */

import type { ChatDriver, TurnStopReason } from '../../../../shared/chat';

export interface ConformanceTraits {
  /**
   * The provider may fold a prompt sent while an operation it accepted is
   * still open (accepted, or running) into that operation, so two accepted
   * submissions share one turn.
   */
  mergesPrompts: boolean;
  /** The driver can steer a running turn (`capabilities.steer`). */
  steersRunningTurn: boolean;
  /** Whether the provider itself reports how an interrupted turn ended. */
  interruptReport: 'provider_reports' | 'none';
  permissions: boolean;
  questions: boolean;
  /** The provider can close a permission request or question without an answer from Clubhouse. */
  nativeResolution: boolean;
  /**
   * What the driver emits when its transport ends with no report from the
   * provider. 'local_closure': the driver closes its own open turn and
   * requests (a turn_ended, permission_resolved 'cancelled'), which records
   * Clubhouse-side bookkeeping, not a provider outcome. 'none': nothing.
   */
  disconnectClosure: 'none' | 'local_closure';
}

/**
 * The provider side of the most recently started session. Each step means
 * what the provider did; the adapter maps it to its own fake transport.
 */
export interface NativeControl {
  /** Submissions the provider received (prompts and steers). */
  received(): number;
  /** The provider starts the oldest accepted operation. */
  beginTurn(): Promise<void>;
  /** The provider settles the running turn with this outcome. */
  endTurn(stopReason: TurnStopReason): Promise<void>;
  /** The provider asks for permission; options include allow_once and reject_once kinds. */
  requestPermission(requestId: string): Promise<void>;
  /** The provider closes a permission request itself (timeout, cancel, answered elsewhere). */
  resolvePermissionNatively?(requestId: string): Promise<void>;
  ask?(requestId: string): Promise<void>;
  resolveQuestionNatively?(requestId: string): Promise<void>;
  /** The transport ends and the provider reports nothing more. */
  disconnect(): Promise<void>;
  /** The next submission fails at the transport after Clubhouse handed it over (its delivery is unknown). */
  failNextSend?(): void;
}

export interface ConformanceHarness {
  driver: ChatDriver;
  /** The provider side of the most recently started session. */
  native(): NativeControl;
  dispose?(): Promise<void>;
}

export interface ConformanceSubject {
  name: string;
  /** Known before any harness exists, so skipped cases are decided when tests are registered. */
  traits: ConformanceTraits;
  /** Whether the adapter's NativeControl implements failNextSend. */
  canFailSend: boolean;
  /**
   * Cases this existing driver fails today, each with the reason. They are
   * not run and not counted as passing: the coverage matrix reports them as
   * blocked, and the failure itself is pinned in lifecycle-gaps.test.ts.
   * This subject does not conform while any remain. A new driver has none.
   */
  blocked?: Partial<Record<ConformanceCaseId, string>>;
  /** A fresh driver and fake transport for one case. */
  create(): Promise<ConformanceHarness>;
}

export const CONFORMANCE_CASES = [
  'prompt_settles_once',
  'between_turns_prompt',
  'steer_joins_running_turn',
  'merged_submissions_leave_no_debt',
  'client_queue_drains_once',
  'interrupt_settles_as_reported',
  'interrupt_unreported_stays_open',
  'permission_answered_once',
  'permission_closed_by_provider',
  'question_answered_once',
  'question_closed_by_provider',
  'disconnect_outcome_unknown',
  'disconnect_held_input_stays_unsent',
  'disconnect_with_open_requests',
  'send_failure_not_retried',
  'replaced_session_ignored',
] as const;

export type ConformanceCaseId = typeof CONFORMANCE_CASES[number];
export type ConformanceCoverage = Record<ConformanceCaseId, 'run' | `skipped: ${string}` | `blocked: ${string}`>;

/** Which cases a subject with these traits runs, and why the rest are skipped. */
export function conformanceCoverage({ traits, canFailSend, blocked = {} }: Pick<ConformanceSubject, 'traits' | 'canFailSend' | 'blocked'>): ConformanceCoverage {
  const when = (ok: boolean, reason: string): 'run' | `skipped: ${string}` => ok ? 'run' : `skipped: ${reason}`;
  const coverage: ConformanceCoverage = {
    prompt_settles_once: 'run',
    between_turns_prompt: 'run',
    steer_joins_running_turn: when(traits.steersRunningTurn, 'no steer'),
    merged_submissions_leave_no_debt: when(traits.mergesPrompts, 'provider does not merge prompts'),
    client_queue_drains_once: 'run',
    interrupt_settles_as_reported: when(traits.interruptReport === 'provider_reports', 'provider does not report interrupts'),
    interrupt_unreported_stays_open: when(traits.interruptReport === 'none', 'provider reports interrupts'),
    permission_answered_once: when(traits.permissions, 'no permissions'),
    permission_closed_by_provider: when(traits.permissions && traits.nativeResolution, 'provider cannot close requests'),
    question_answered_once: when(traits.questions, 'no questions'),
    question_closed_by_provider: when(traits.questions && traits.nativeResolution, 'provider cannot close questions'),
    disconnect_outcome_unknown: 'run',
    disconnect_held_input_stays_unsent: 'run',
    disconnect_with_open_requests: when(traits.permissions, 'no permissions'),
    send_failure_not_retried: when(canFailSend, 'adapter cannot fail a send'),
    replaced_session_ignored: 'run',
  };
  for (const [id, reason] of Object.entries(blocked) as Array<[ConformanceCaseId, string]>) {
    if (coverage[id] === 'run') coverage[id] = `blocked: ${reason}`;
  }
  return coverage;
}
