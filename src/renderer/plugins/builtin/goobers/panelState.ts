/**
 * Derives the §8.4 MVP panel state from a `GoobersConnectionState` snapshot
 * plus the `manageDaemon` setting. A discriminated union rather than organic
 * conditionals in the component, so every state is directly constructible in
 * tests (spec §11 requires `main.test.ts` to render every §8.4 state).
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
  | 'degraded'
  | 'ready'
  | 'connecting'
  | 'unknown-error';

export interface GoobersPanelState {
  kind: GoobersPanelStateKind;
  raw: GoobersConnectionState;
  /** Only set for 'unknown-error' and other error-carrying kinds — the raw envelope. */
  error?: NonNullable<GoobersConnectionState['lastError']>;
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
 * Derive the panel's discriminated state. `manageDaemon` comes from
 * GOOBERS_SETTINGS (main-process app config, not plugin settings — §4.1) and
 * is passed in separately since it is not part of `GoobersConnectionState`.
 */
export function deriveGoobersPanelState(
  state: GoobersConnectionState,
  manageDaemon: boolean,
): GoobersPanelState {
  const { connection, daemon, stream, apiCompatible, lastError, instance, rootIdentity } = state;

  if (!state.configured || !state.instanceRoot) {
    return { kind: 'not-configured', raw: state };
  }

  // §7.4 step 3 — never render another instance's data (§9.1).
  const identityMismatch =
    lastError?.code === PORT_MISMATCH ||
    (!!instance?.rootIdentity?.id && !!rootIdentity && instance.rootIdentity.id !== rootIdentity);
  if (identityMismatch) {
    return { kind: 'port-mismatch', raw: state, error: lastError ?? undefined };
  }

  if (lastError?.code === NOT_A_ROOT) {
    return { kind: 'invalid-root', raw: state, error: lastError };
  }
  if (lastError?.code === DECOMMISSIONED) {
    return { kind: 'decommissioned-root', raw: state, error: lastError };
  }
  if (lastError?.code && BINARY_CODES.has(lastError.code)) {
    return { kind: 'binary-not-found', raw: state, error: lastError };
  }
  if (lastError?.code === AUTH_REQUIRED) {
    return { kind: 'auth-required', raw: state, error: lastError };
  }
  if (lastError?.code === RECOVERING) {
    // Ahead of the generic daemon.state === 'starting' branch below — same
    // underlying state, but this one carries a `raw.recovery` breakdown
    // (phase/since/checks) the plain 'starting' screen doesn't have.
    return { kind: 'recovering', raw: state, error: lastError };
  }
  if (lastError?.code === START_FAILED) {
    return { kind: 'start-failed', raw: state, error: lastError };
  }
  if (lastError?.code === START_UNKNOWN) {
    return { kind: 'start-unknown', raw: state, error: lastError };
  }
  if (lastError?.code === STOP_FAILED) {
    return { kind: 'stop-failed', raw: state, error: lastError };
  }

  if (daemon.draining) {
    return { kind: 'stopping', raw: state };
  }
  if (daemon.state === 'starting') {
    return { kind: 'starting', raw: state };
  }
  if (daemon.state === 'not-running') {
    return manageDaemon
      ? { kind: 'daemon-not-running', raw: state }
      : { kind: 'daemon-control-off', raw: state };
  }

  if (connection === 'connected' || connection === 'degraded') {
    if (!apiCompatible) {
      return { kind: 'incompatible-api', raw: state, error: lastError ?? undefined };
    }
    if (connection === 'degraded' || instance?.status === 'degraded') {
      return { kind: 'degraded', raw: state };
    }
    if (stream === 'reconnecting') {
      return { kind: 'stream-reconnecting', raw: state };
    }
    if (stream === 'polling') {
      return { kind: 'polling-fallback', raw: state };
    }
    if (stream === 'unavailable') {
      return { kind: 'no-read-model', raw: state };
    }
    return { kind: 'ready', raw: state };
  }

  if (connection === 'connecting') {
    return { kind: 'connecting', raw: state };
  }

  if (connection === 'error' && lastError) {
    return { kind: 'unknown-error', raw: state, error: lastError };
  }

  return { kind: 'connecting', raw: state };
}
