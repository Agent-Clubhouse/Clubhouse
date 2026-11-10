/**
 * Repeated failures in the Dispatcher's work conversation (#3240). A native
 * session can resume fine and then fail every turn: its history is the
 * problem, so every wake, retry, restart and Dispatcher switch fails the same
 * way. After REPEATED_TURN_FAILURES turns in a row fail on one session, the
 * work starts fresh: that session is quarantined, never resumed again, and
 * the visible chat says so.
 *
 * Only turns count. A turn that ends well resets the count; one cancelled
 * leaves it; errors a fresh session would hit too (login, billing, rate
 * limits, timeouts) never count. Counts live for this run of Clubhouse; a
 * quarantine is saved.
 */
import type { ChatEvent } from '../../../shared/chat';
import { onChatEvent } from '../agent-runtime/chat-event-bus';
import { getAgentRuntime } from '../agent-runtime';
import { countsTowardQuarantine, REPEATED_TURN_FAILURES } from '../agent-runtime/stale-session';
import { appLog } from '../log-service';
import { startDispatcherFresh } from './dispatcher-clear-chat';
import { getDispatcherAgentId } from './dispatcher-service';

interface SessionFailures {
  nativeSessionId: string;
  count: number;
}

export interface WorkHealthDeps {
  workAgentId?: () => string | null;
  nativeSessionId?: (agentId: string) => string | undefined;
  startFresh?: () => Promise<unknown>;
}

let failures: SessionFailures | null = null;
/** The running turn hit an error that a fresh session would hit too: it doesn't count. */
let turnExcused = false;
/** A fresh start is under way: the turns it ends don't count again. */
let recovering: Promise<void> | null = null;

/** Fold one chat event of the work agent into its failure count. Exported for tests. */
export function noteWorkChatEvent(event: ChatEvent, deps: WorkHealthDeps = {}): void {
  const workId = (deps.workAgentId ?? getDispatcherAgentId)();
  if (!workId || event.agentId !== workId) return;
  if (event.type === 'turn_started') {
    turnExcused = false;
    return;
  }
  if (event.type === 'error') {
    if (!countsTowardQuarantine(event.data.code, event.data.willRetry)) turnExcused = true;
    return;
  }
  if (event.type !== 'turn_ended') return;
  const nativeSessionId = (deps.nativeSessionId ?? ((id) => getAgentRuntime(id)?.getNativeSessionId()))(workId);
  if (!nativeSessionId) return;
  if (failures?.nativeSessionId !== nativeSessionId) failures = { nativeSessionId, count: 0 };
  const { stopReason } = event.data;
  if (stopReason === 'end_turn') failures.count = 0;
  else if (stopReason === 'error' && !turnExcused) failures.count++;
  turnExcused = false;
  if (failures.count < REPEATED_TURN_FAILURES || recovering) return;
  appLog('core:dispatcher', 'warn', 'Dispatcher work failed every turn; starting fresh', { meta: { failedTurns: failures.count } });
  failures = null;
  const run = (deps.startFresh ?? (() => startDispatcherFresh('work', {}, 'repeated_failures')))();
  recovering = Promise.resolve(run).then((): void => undefined, (err: unknown): void => {
    appLog('core:dispatcher', 'error', 'Dispatcher work could not start fresh', { meta: { error: err instanceof Error ? err.message : String(err) } });
  }).finally(() => { recovering = null; });
}

let unsubscribe: (() => void) | null = null;

/** Watch the work conversation. Called once, with the Dispatcher's other handlers. */
export function installDispatcherWorkHealth(): void {
  unsubscribe ??= onChatEvent((event) => noteWorkChatEvent(event));
}

/** For tests: the fresh start in flight, if any. */
export function _whenRecoveredForTesting(): Promise<void> {
  return recovering ?? Promise.resolve();
}

/** For tests. */
export function _resetDispatcherWorkHealthForTesting(): void {
  unsubscribe?.();
  unsubscribe = null;
  failures = null;
  turnExcused = false;
  recovering = null;
}
