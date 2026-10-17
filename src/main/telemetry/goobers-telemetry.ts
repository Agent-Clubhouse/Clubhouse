/**
 * Goobers integration telemetry (spec §4.13, §12 H12, Phase 6b): activation,
 * liveness transitions, daemon start/stop, event-stream mode and data age.
 *
 * Only state enums and error codes are exported, never messages: Goobers
 * messages interpolate the instance root, the daemon address and instance
 * ids. The poll loop is metrics only (Detailed level), never spans.
 *
 * No OpenTelemetry imports: part of the main bundle.
 */
import { ATTR, getAttributeSpec } from '../../shared/telemetry/attributes';
import { isTelemetryActive, replaySpan, tel } from './facade';

type DaemonState = Parameters<typeof ATTR.goobersDaemonState>[0];
type Connection = Parameters<typeof ATTR.goobersConnection>[0];
type GoobersError = Parameters<typeof ATTR.goobersError>[0];
type StreamMode = Parameters<typeof ATTR.goobersStreamMode>[0];
type Model = Parameters<typeof ATTR.goobersModel>[0];

const KNOWN_ERRORS = new Set<string>(getAttributeSpec('clubhouse.goobers.error')?.values ?? []);

/** An error code from the Goobers state, or `none`; anything unregistered is `other`. */
export function goobersErrorCode(code: string | null | undefined): GoobersError {
  if (!code) return 'none';
  return (KNOWN_ERRORS.has(code) ? code : 'other') as GoobersError;
}

/** The parts of the Goobers connection state that telemetry reads. */
export interface LivenessView {
  daemon: { state: string };
  connection: string;
  lastError?: { code: string } | null;
}

function key(v: LivenessView): string {
  return `${v.daemon.state}|${v.connection}|${v.lastError?.code ?? ''}`;
}

function livenessAttrs(v: LivenessView) {
  return [
    ATTR.goobersDaemonState(v.daemon.state as DaemonState),
    ATTR.goobersConnection(v.connection as Connection),
    ATTR.goobersError(goobersErrorCode(v.lastError?.code)),
  ];
}

/** Emit `clubhouse.goobers.liveness` only when state, connection or error code changed. */
export function recordLivenessChange(prev: LivenessView, next: LivenessView): void {
  if (key(prev) === key(next)) return;
  tel.event('clubhouse.goobers.liveness', livenessAttrs(next));
}

/** subscribe() → the first reconcile finished. */
export function recordActivated(startMs: number, state: LivenessView, atMs = Date.now()): void {
  replaySpan({
    name: 'clubhouse.goobers.activate',
    startMs,
    endMs: Math.max(atMs, startMs),
    attrs: livenessAttrs(state),
    outcome: state.connection === 'error' ? 'error' : 'ok',
    errorType: state.connection === 'error' ? 'goobers_daemon_failed' : undefined,
  });
}

type DaemonResult = { ok: boolean; error?: string; outcome?: 'unknown' };

/**
 * Daemon start/stop as a flow. `failureCode` is the service's own code for a
 * failure whose `error` is free text (it never leaves this process).
 */
export function daemonFlow<R extends DaemonResult>(
  action: 'start' | 'stop',
  failureCode: GoobersError,
  fn: () => Promise<R>,
): Promise<R> {
  const name = action === 'start' ? 'clubhouse.goobers.daemon.start' : 'clubhouse.goobers.daemon.stop';
  return tel.flow(name, {}, async (span) => {
    const r = await fn();
    if (!r.ok) {
      const code = goobersErrorCode(r.error);
      span.set(ATTR.goobersError(code === 'other' ? failureCode : code));
    }
    return r;
  }, {
    classify: (r) => {
      if (r.ok) return 'ok';
      if (r.outcome === 'unknown') return { outcome: 'timeout' };
      return { error: 'goobers_daemon_failed' };
    },
  });
}

export function recordStreamMode(mode: StreamMode): void {
  tel.event('clubhouse.goobers.stream.mode', [ATTR.goobersStreamMode(mode)]);
}

export function recordStreamReconnect(): void {
  tel.count('clubhouse.goobers.sse.reconnects', 1);
}

export function recordStreamTerminal(reason: Parameters<typeof ATTR.sseTerminalReason>[0]): void {
  tel.count('clubhouse.goobers.sse.terminals', 1, [ATTR.sseTerminalReason(reason)]);
}

// --- Data age -------------------------------------------------------------------

const MODELS: Model[] = ['instance', 'run', 'workflow'];
const lastFresh = new Map<Model, number>();

/** A fresh payload arrived for these models (poll result or stream invalidation). */
export function markFresh(models: readonly string[], atMs = Date.now()): void {
  if (!isTelemetryActive()) return;
  for (const m of models) if ((MODELS as string[]).includes(m)) lastFresh.set(m as Model, atMs);
}

export function recordPollSkipped(): void {
  tel.count('clubhouse.goobers.poll.skipped', 1);
}

/**
 * A poll tick finished: count it (Detailed) and sample the data-age gauge for
 * every model seen fresh at least once.
 */
export function recordPollDone(startMs: number, atMs = Date.now()): void {
  if (!isTelemetryActive()) return;
  tel.count('clubhouse.goobers.polls', 1);
  tel.count('clubhouse.goobers.poll.duration', (atMs - startMs) / 1000);
  for (const [model, at] of lastFresh) {
    tel.count('clubhouse.goobers.data.age', Math.max(0, atMs - at) / 1000, [ATTR.goobersModel(model)]);
  }
}

/** The instance root changed: the old root's freshness no longer applies. */
export function resetFreshness(): void {
  lastFresh.clear();
}

/** Test-only reset. */
export function _resetGoobersTelemetryForTests(): void {
  lastFresh.clear();
}
