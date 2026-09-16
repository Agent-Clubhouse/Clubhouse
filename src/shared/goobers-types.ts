/**
 * Clubhouse-side Goobers types — not vendored from the portal. These are the
 * shapes the main process and renderer exchange over IPC (spec §6.3, §6.4).
 */
import type {
  Health,
  Instance,
  OutcomeFilter,
  RunPhase,
  RunTriggerKind,
  StagePopulationFilter,
} from './goobers-api-types';

/** Renderer-facing passthrough to GET /api/v1/runs (spec §6.3). Cursor-based
 *  pagination — `nextCursor`/`hasMore` on the response, never offset. */
export interface RunListQuery {
  gaggle?: string;
  workflow?: string;
  stage?: string;
  outcome?: OutcomeFilter;
  population?: StagePopulationFilter;
  phase?: RunPhase;
  trigger?: RunTriggerKind;
  since?: string;
  until?: string;
  cursor?: string;
  limit?: number;
  latestPerWorkflow?: boolean;
  showNoWork?: boolean;
  orderByActivity?: boolean;
}

/** Spec §6.4 — copied verbatim. */
export interface GoobersDaemonStatus {
  state: 'running' | 'not-running' | 'starting' | 'stopping' | 'unknown';
  address: string | null;
  /** DISPLAY ONLY — never liveness (§2.2). */
  pid: number | null;
  version: string | null;
  startedAt: string | null;
  lastTickAgeMillis: number | null;
  /** Stop requested, lock still held. */
  draining: boolean;
}

/** Spec §6.4 — copied verbatim. */
export interface GoobersConnectionState {
  configured: boolean;
  instanceRoot: string | null;
  /** From `.instance-id` (never the sibling `instance-id` file — see §4.2). */
  rootIdentity: string | null;
  /**
   * Extension beyond §6.4's verbatim shape: `spec.instance.name`/
   * `.environment` from the optional `config/manifest.yaml` (not in §14.2's
   * file list — absence is normal). Lets the daemon-down screen show
   * "Instance identity + config summary from disk" per §8.4/§12 even though
   * the API hasn't been reachable yet. `null` when unavailable, never an
   * error.
   */
  instanceName?: string | null;
  instanceEnvironment?: string | null;
  daemon: GoobersDaemonStatus;
  connection: 'idle' | 'connecting' | 'connected' | 'degraded' | 'error';
  stream: 'live' | 'reconnecting' | 'polling' | 'unavailable';
  instance: Instance | null;
  health: Health | null;
  /** See §9.4. */
  apiCompatible: boolean;
  lastError: { code: string; message: string } | null;
  /** ISO timestamp. */
  lastUpdatedAt: string;
}
