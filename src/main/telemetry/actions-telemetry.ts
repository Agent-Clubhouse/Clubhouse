/**
 * Actions telemetry (#2956, epic #2918): what the engine reports through
 * `observeActions` becomes `clubhouse.action.*` events.
 *
 * Safety:
 * - Standard events carry closed codes and counts only: trigger and event
 *   kinds, step kinds, outcomes, wait, overlap and limit codes, the owner's
 *   kind and coarse buckets. Never an action's name, a prompt, a message,
 *   a reason in words, or an agent or project id.
 * - The action id (and an owning agent's id) go, hashed, on
 *   `clubhouse.action.run_detail` only. That event is Detailed: it is
 *   recorded only when the person chose Detailed, and exported only to
 *   destinations they set to Detailed. Reasons in words are never sent
 *   anywhere; they stay in the run history.
 * - Clubhouse's own hidden actions are counted, marked `owner=app`.
 * - Nothing here changes a run: every function returns void and swallows its
 *   own errors, and with telemetry off nothing is built or recorded.
 * - The chatty events (triggered, wait, overlap, step) are capped per event
 *   name per hour, so a busy event trigger can't crowd out the others. Runs,
 *   limit hits and catch-up are not capped here: the engine already limits
 *   each action to 60 runs an hour. Drops are logged when the hour ends.
 */
import { performance } from 'perf_hooks';
import { ATTR, type EventName, type TelAttr } from '../../shared/telemetry/attributes';
import type { ActionOwner } from '../../shared/actions/types';
import type { EngineObservation } from '../services/actions/engine';
import { appLog } from '../services/log-service';
import { isTelemetryActive, tel, telemetryLevel } from './facade';

/** Each chatty event, per hour, across all actions. */
export const ACTIONS_TELEMETRY_MAX_EVENTS_PER_HOUR = 300;

const CAPPED: ReadonlySet<EventName> = new Set<EventName>([
  'clubhouse.action.triggered',
  'clubhouse.action.wait',
  'clubhouse.action.overlap',
  'clubhouse.action.step',
]);

const HOUR_MS = 60 * 60_000;
let windowStart: number | null = null;
const used = new Map<EventName, number>();
const dropped = new Map<EventName, number>();
// Monotonic, so a wall-clock change can't stretch or shorten the hour.
let clock: () => number = () => performance.now();

function rollWindow(t: number): void {
  if (dropped.size > 0) {
    // telemetry-exempt: this is telemetry's own drop report
    appLog('core:actions', 'info', 'Actions telemetry dropped events over the hourly cap', {
      meta: { dropped: Object.fromEntries(dropped) },
    });
  }
  windowStart = t;
  used.clear();
  dropped.clear();
}

/** Whether a capped event fits this hour. The hour starts with the first event and restarts if the clock goes back. */
function admit(name: EventName): boolean {
  if (!CAPPED.has(name)) return true;
  const t = clock();
  if (windowStart === null || t < windowStart || t - windowStart >= HOUR_MS) rollWindow(t);
  const n = used.get(name) ?? 0;
  if (n >= ACTIONS_TELEMETRY_MAX_EVENTS_PER_HOUR) {
    dropped.set(name, (dropped.get(name) ?? 0) + 1);
    return false;
  }
  used.set(name, n + 1);
  return true;
}

function emit(name: EventName, attrs: TelAttr[]): void {
  if (!admit(name)) return;
  tel.event(name, attrs);
}

export function chainDepthBucket(depth: number): '0' | '1' | '2' | '3+' {
  return depth <= 0 ? '0' : depth === 1 ? '1' : depth === 2 ? '2' : '3+';
}

export function missedBucket(n: number): '0' | '1' | '2-4' | '5-9' | '10+' {
  return n <= 0 ? '0' : n === 1 ? '1' : n <= 4 ? '2-4' : n <= 9 ? '5-9' : '10+';
}

function ownerAttr(owner: ActionOwner): TelAttr {
  return ATTR.actionOwner(owner.kind);
}

/** One engine observation as telemetry. Never throws. */
export function recordActionObservation(o: EngineObservation): void {
  try {
    if (!isTelemetryActive()) return;
    const owner = ownerAttr(o.owner);
    switch (o.type) {
      case 'trigger':
        emit('clubhouse.action.triggered', [
          owner,
          ATTR.actionTrigger(o.trigger),
          ...(o.event ? [ATTR.actionEvent(o.event), ATTR.actionDelayed(o.delayed === true)] : []),
        ]);
        return;
      case 'wait':
        emit('clubhouse.action.wait', [owner, ATTR.actionWait(o.what), ...(o.event ? [ATTR.actionEvent(o.event)] : [])]);
        return;
      case 'overlap':
        emit('clubhouse.action.overlap', [owner, ATTR.actionOverlap(o.what), ATTR.actionTrigger(o.trigger)]);
        return;
      case 'limit':
        emit('clubhouse.action.limit_hit', [owner, ATTR.actionLimit(o.what), ATTR.actionChainDepth(chainDepthBucket(o.chainDepth))]);
        return;
      case 'catch_up':
        emit('clubhouse.action.catch_up', [owner, ATTR.actionMissedBucket(missedBucket(o.missed)), ATTR.actionMissedRule(o.rule)]);
        return;
      case 'run':
        recordRun(o, owner);
        return;
    }
  } catch {
    // Telemetry never affects a run.
  }
}

function recordRun(o: Extract<EngineObservation, { type: 'run' }>, owner: TelAttr): void {
  // A run still going is not an outcome; the engine reports runs as they end.
  if (o.outcome === 'running') return;
  const failed = o.stepResults.find((s) => s.outcome === 'failed');
  const outcome = ATTR.actionRunOutcome(o.outcome);
  const reason = ATTR.actionRunReason(o.reasonCode ?? 'none');
  const trigger = ATTR.actionTrigger(o.trigger);
  emit('clubhouse.action.run', [
    owner,
    outcome,
    reason,
    trigger,
    ATTR.actionRunSteps(o.steps),
    ATTR.actionRunFailedStep(failed?.kind ?? 'none'),
    ATTR.actionChainDepth(chainDepthBucket(o.chainDepth)),
    ATTR.actionRunDurationMs(Math.max(0, o.durationMs)),
  ]);
  o.stepResults.forEach((s, i) => {
    emit('clubhouse.action.step', [owner, ATTR.actionStepKind(s.kind), ATTR.actionStepOutcome(s.outcome), ATTR.actionStepIndex(i + 1)]);
  });
  if (telemetryLevel() === 'detailed') {
    emit('clubhouse.action.run_detail', [
      owner,
      outcome,
      reason,
      trigger,
      ATTR.actionIdHash(o.actionId),
      ...(o.owner.kind === 'agent' ? [ATTR.agentIdHash(o.owner.agentId)] : []),
    ]);
  }
}

/** Subscribe to the engine's observations. Returns the unsubscribe. */
export function installActionsTelemetry(observe: (fn: (o: EngineObservation) => void) => () => void): () => void {
  return observe(recordActionObservation);
}

/** Tests: reset the hourly budget, optionally with a fake clock. */
export function _resetActionsTelemetryForTests(now?: () => number): void {
  windowStart = null;
  used.clear();
  dropped.clear();
  clock = now ?? (() => performance.now());
}
