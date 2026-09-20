/**
 * Derives the §8.4 MVP panel state from a `GoobersConnectionState` snapshot
 * plus the `manageDaemon` setting. A discriminated union rather than organic
 * conditionals in the component, so every state is directly constructible in
 * tests (spec §11 requires `main.test.ts` to render every §8.4 state).
 *
 * §8.4 separates three signals that an earlier revision OR-ed into one
 * "Ready, degraded" state. They come from different subsystems and only
 * shared the word "degraded":
 *
 *   - config lint      `instance.warnings[]` (`instance.status === 'degraded'`)
 *   - data trust       `health.readState.degraded[]` / `.completeness`
 *   - scheduler tick   `connection === 'degraded'`, set in goobers-liveness.ts
 *                      from `lastTickAgeMillis > livenessTimeoutMillis`
 *
 * Only the third is a lifecycle state, so only it is a `kind`. The other two
 * can be true simultaneously with any `kind`, so they are separate fields —
 * which is what makes §8.4's "a state row may not OR together signals from
 * different sources" structurally enforceable rather than a convention.
 */
import type { GoobersConnectionState } from '../../../../shared/goobers-types';

export type GoobersPanelStateKind =
  | 'not-configured'
  | 'invalid-root'
  | 'decommissioned-root'
  | 'binary-not-found'
  | 'daemon-control-off'
  | 'auth-required'
  | 'daemon-not-running'
  | 'starting'
  | 'recovering'
  | 'start-failed'
  | 'start-unknown'
  | 'stopping'
  | 'stop-failed'
  | 'port-mismatch'
  | 'incompatible-api'
  | 'stream-reconnecting'
  | 'polling-fallback'
  | 'no-read-model'
  | 'scheduler-stalled'
  | 'ready'
  | 'connecting'
  | 'unknown-error';

/**
 * §8.4 data freshness. Mirrors upstream portal's `PortalShell.tsx` union so the
 * two products say the same thing. `unknown` renders nothing on purpose —
 * claiming "current" with no read model would be a claim nobody made.
 */
export type GoobersFreshnessKind = 'current' | 'lagging' | 'partial' | 'unknown';

export interface GoobersFreshness {
  kind: GoobersFreshnessKind;
  /** Header text. `null` for 'unknown' — render nothing rather than guess. */
  label: string | null;
  /** §8.4 requires naming the specific degradation; this is that name. */
  detail: string | null;
  /** Alert styling. False for the self-healing reasons, which are routine. */
  alert: boolean;
}

/**
 * §8.4 config lint. Informational only: a count of `instance.warnings[]`, never
 * an alert and never a staleness claim. Most instances carry warnings forever.
 */
export interface GoobersConfigWarnings {
  count: number;
  /** `null` when there are none, so the header can omit the element entirely. */
  label: string | null;
  /** Tooltip naming the codes — §8.4's "name the specific degradation". */
  detail: string | null;
}

export interface GoobersPanelState {
  kind: GoobersPanelStateKind;
  raw: GoobersConnectionState;
  /** Only set for 'unknown-error' and other error-carrying kinds — the raw envelope. */
  error?: NonNullable<GoobersConnectionState['lastError']>;
  /** Orthogonal to `kind` — true alongside any of them. */
  freshness: GoobersFreshness;
  /** Orthogonal to `kind` — true alongside any of them. */
  configWarnings: GoobersConfigWarnings;
}

const NOT_A_ROOT = 'not-a-goobers-instance-root';
const DECOMMISSIONED = 'decommissioned-root';
const BINARY_CODES = new Set(['binary-not-found', 'binary-not-executable']);
/** Conventions for codes M3 has not implemented yet — documented so M3 can match them. */
const AUTH_REQUIRED = 'auth-required';
/** §8.4 (M20) — alive and self-healing; must never route through 'unknown-error'. */
const RECOVERING = 'recovering';
const START_FAILED = 'daemon-start-failed';
/** §7.5 timeout-with-live-child outcome — NOT a failure; see M17. */
const START_UNKNOWN = 'daemon-start-unknown';
const STOP_FAILED = 'daemon-stop-failed';
const PORT_MISMATCH = 'identity-mismatch';

/**
 * `readState.degraded` reasons upstream documents as self-healing — explicitly
 * *not* "the sweep is broken". They still downgrade freshness to `lagging`, but
 * they do not warrant alert styling.
 *
 * Deliberately a deny-list: an unrecognised reason alerts. A degradation we have
 * no copy for is exactly when someone should look, and the reason string is
 * surfaced verbatim in `detail` so it is still self-diagnosing.
 */
const SELF_HEALING_DEGRADED: ReadonlySet<string> = new Set([
  'projection_lag',
  'sweep_stale',
  'no_sweep_completed',
]);

/** §8.4 — informational count, never an alert. */
function deriveConfigWarnings(state: GoobersConnectionState): GoobersConfigWarnings {
  // Counted from `warnings[]` rather than keyed off `instance.status ===
  // 'degraded'`: the count is what gets rendered, and the two only ever
  // disagree if the daemon's summary and its own list disagree.
  const warnings = state.instance?.warnings ?? [];
  const count = warnings.length;
  if (count === 0) {
    return { count, label: null, detail: null };
  }
  // Distinct codes with their multiplicity — "13x VER003, 4x CFG001" says more
  // in a tooltip than 17 repeated explanation strings would.
  const byCode = new Map<string, number>();
  for (const w of warnings) {
    byCode.set(w.code, (byCode.get(w.code) ?? 0) + 1);
  }
  const detail = [...byCode.entries()]
    .map(([code, n]) => (n > 1 ? `${n}x ${code}` : code))
    .join(', ');
  return {
    count,
    label: `${count} config warning${count === 1 ? '' : 's'}`,
    detail,
  };
}

/** §8.4 — data trustworthiness, independent of config lint and of scheduler tick. */
function deriveFreshness(state: GoobersConnectionState): GoobersFreshness {
  const readState = state.health?.readState;
  if (!readState) {
    return { kind: 'unknown', label: null, detail: null, alert: false };
  }

  const reasons = readState.degraded ?? [];
  const alert = reasons.some((reason) => !SELF_HEALING_DEGRADED.has(reason));
  const detail = reasons.length > 0 ? reasons.join(', ') : null;

  if (readState.completeness === 'partial') {
    const missing = readState.missing?.map((m) => m.name).filter(Boolean) ?? [];
    return {
      kind: 'partial',
      label: missing.length > 0 ? `Partial — ${missing.join(', ')}` : 'Partial data',
      detail: detail ?? readState.missing?.map((m) => m.reason).join(', ') ?? null,
      alert,
    };
  }

  if (reasons.length > 0) {
    return {
      kind: 'lagging',
      label: `Data stale by ${readState.lagSeconds.toFixed(1)}s`,
      detail,
      alert,
    };
  }

  // Note: a large `lagSeconds` alone does not make this 'lagging'. The daemon
  // reports `projection_lag` in `degraded[]` when it considers itself behind;
  // inventing our own threshold here would second-guess it.
  return { kind: 'current', label: 'Data current', detail: null, alert: false };
}

/**
 * Derive the panel's discriminated state. `manageDaemon` comes from
 * GOOBERS_SETTINGS (main-process app config, not plugin settings — §4.1) and
 * is passed in separately since it is not part of `GoobersConnectionState`.
 */
export function deriveGoobersPanelState(
  state: GoobersConnectionState,
  manageDaemon: boolean,
): GoobersPanelState {
  return {
    ...deriveKind(state, manageDaemon),
    raw: state,
    freshness: deriveFreshness(state),
    configWarnings: deriveConfigWarnings(state),
  };
}

type KindResult = Pick<GoobersPanelState, 'kind' | 'error'>;

function deriveKind(state: GoobersConnectionState, manageDaemon: boolean): KindResult {
  const { connection, daemon, stream, apiCompatible, lastError, instance, rootIdentity } = state;

  if (!state.configured || !state.instanceRoot) {
    return { kind: 'not-configured' };
  }

  // §7.4 step 3 — never render another instance's data (§9.1).
  const identityMismatch =
    lastError?.code === PORT_MISMATCH ||
    (!!instance?.rootIdentity?.id && !!rootIdentity && instance.rootIdentity.id !== rootIdentity);
  if (identityMismatch) {
    return { kind: 'port-mismatch', error: lastError ?? undefined };
  }

  if (lastError?.code === NOT_A_ROOT) {
    return { kind: 'invalid-root', error: lastError };
  }
  if (lastError?.code === DECOMMISSIONED) {
    return { kind: 'decommissioned-root', error: lastError };
  }
  if (lastError?.code && BINARY_CODES.has(lastError.code)) {
    return { kind: 'binary-not-found', error: lastError };
  }
  if (lastError?.code === AUTH_REQUIRED) {
    return { kind: 'auth-required', error: lastError };
  }
  if (lastError?.code === RECOVERING) {
    // Ahead of the generic daemon.state === 'starting' branch below — same
    // underlying state, but this one carries a `raw.recovery` breakdown
    // (phase/since/checks) the plain 'starting' screen doesn't have.
    return { kind: 'recovering', error: lastError };
  }
  if (lastError?.code === START_FAILED) {
    return { kind: 'start-failed', error: lastError };
  }
  if (lastError?.code === START_UNKNOWN) {
    return { kind: 'start-unknown', error: lastError };
  }
  if (lastError?.code === STOP_FAILED) {
    return { kind: 'stop-failed', error: lastError };
  }

  if (daemon.draining) {
    return { kind: 'stopping' };
  }
  if (daemon.state === 'starting') {
    return { kind: 'starting' };
  }
  if (daemon.state === 'not-running') {
    return manageDaemon
      ? { kind: 'daemon-not-running' }
      : { kind: 'daemon-control-off' };
  }

  if (connection === 'connected' || connection === 'degraded') {
    if (!apiCompatible) {
      return { kind: 'incompatible-api', error: lastError ?? undefined };
    }
    // Scheduler liveness only. `instance.status === 'degraded'` is config lint
    // and deliberately does not appear here: it is a permanent property of most
    // instances, so OR-ing it in made this branch unconditional and left the
    // three `stream` checks below unreachable.
    if (connection === 'degraded') {
      return { kind: 'scheduler-stalled' };
    }
    if (stream === 'reconnecting') {
      return { kind: 'stream-reconnecting' };
    }
    if (stream === 'polling') {
      return { kind: 'polling-fallback' };
    }
    if (stream === 'unavailable') {
      return { kind: 'no-read-model' };
    }
    return { kind: 'ready' };
  }

  if (connection === 'connecting') {
    return { kind: 'connecting' };
  }

  if (connection === 'error' && lastError) {
    return { kind: 'unknown-error', error: lastError };
  }

  return { kind: 'connecting' };
}
