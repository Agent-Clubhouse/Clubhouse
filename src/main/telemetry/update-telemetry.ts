/**
 * Auto-update telemetry (spec §4.3, §12 H6). The update service calls these
 * at its existing decision points with a start time; spans are replayed with
 * explicit times, so no update code runs inside a telemetry wrapper. That
 * matters for apply: the platform handlers exit the process themselves.
 */
import { ATTR } from '../../shared/telemetry/attributes';
import { isTelemetryActive, replaySpan, tel } from './facade';
import { getInstallKind } from './install-kind';
import type { ErrorType } from './types';

type Trigger = Parameters<typeof ATTR.updateTrigger>[0];
type Result = Parameters<typeof ATTR.updateResult>[0];

/** Map an update error onto the closed `error.type` set. Uses the message locally; never exports it. */
export function classifyUpdateError(err: unknown): ErrorType {
  const msg = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: string } | null)?.code;
  if (/checksum/i.test(msg)) return 'integrity_mismatch';
  if (/redirect/i.test(msg)) return 'redirect_blocked';
  if (/HTTP 4\d\d/.test(msg)) return 'http_4xx';
  if (/HTTP 5\d\d/.test(msg)) return 'http_5xx';
  if (/manifests? unavailable/i.test(msg)) return 'manifests_unavailable';
  if (/JSON|manifest/i.test(msg)) return 'manifest_invalid';
  if (code && /^(ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|EPIPE)$/.test(code)) return 'network_transient';
  if (/timeout|timed out/i.test(msg)) return 'timeout';
  if (code || /network|socket|getaddrinfo/i.test(msg)) return 'network';
  return 'unknown';
}

export function recordUpdateCheck(opts: {
  startMs: number;
  trigger: Trigger;
  preview: boolean;
  result: Result;
  error?: unknown;
}): void {
  const channel = ATTR.updateChannel(opts.preview ? 'preview' : 'stable');
  const errorType = opts.error === undefined ? undefined : classifyUpdateError(opts.error);
  replaySpan({
    name: 'clubhouse.update.check',
    startMs: opts.startMs,
    endMs: Date.now(),
    attrs: [ATTR.updateTrigger(opts.trigger), channel, ATTR.updateResult(opts.result)],
    outcome: errorType ? 'error' : 'ok',
    errorType,
  });
  tel.count('clubhouse.update.checks', 1, [ATTR.updateResult(opts.result), channel, ATTR.updateTrigger(opts.trigger)]);
  if (errorType) tel.count('clubhouse.update.failures', 1, [ATTR.updatePhase('check'), ATTR.errorType(errorType)]);
}

export function recordUpdateDownload(opts: { startMs: number; result: Result; error?: unknown }): void {
  const endMs = Date.now();
  const errorType = opts.error === undefined ? undefined : classifyUpdateError(opts.error);
  replaySpan({
    name: 'clubhouse.update.download',
    startMs: opts.startMs,
    endMs,
    attrs: [ATTR.updateResult(opts.result)],
    outcome: errorType ? 'error' : 'ok',
    errorType,
  });
  if (opts.result === 'downloaded') tel.count('clubhouse.update.download.duration', (endMs - opts.startMs) / 1000);
  if (errorType) tel.count('clubhouse.update.failures', 1, [ATTR.updatePhase('download'), ATTR.errorType(errorType)]);
}

export function recordUpdateApply(opts: { startMs: number; mode: 'relaunch' | 'on_quit'; ok: boolean; error?: unknown }): void {
  const errorType: ErrorType | undefined = opts.ok ? undefined : opts.error === undefined ? 'apply_failed' : classifyUpdateError(opts.error);
  const effective: ErrorType | undefined = errorType === 'unknown' ? 'apply_failed' : errorType;
  replaySpan({
    name: 'clubhouse.update.apply',
    startMs: opts.startMs,
    endMs: Date.now(),
    attrs: [ATTR.updateApplyMode(opts.mode), ATTR.updateResult(opts.ok ? 'applied' : 'failed')],
    outcome: effective ? 'error' : 'ok',
    errorType: effective,
  });
  if (effective) {
    tel.count('clubhouse.update.failures', 1, [
      ATTR.updatePhase(opts.mode === 'on_quit' ? 'apply_on_quit' : 'apply'),
      ATTR.errorType(effective),
    ]);
  }
}

/**
 * At startup, after an apply attempt: did the new version actually take?
 * Catches silent failed applies on every OS, independent of how the attempt
 * marker was written (#1920).
 */
export async function recordApplyVerification(taken: boolean): Promise<void> {
  // Install-kind detection touches the filesystem (and `rpm` on Linux); never do it with telemetry off.
  if (!isTelemetryActive()) return;
  const kind = await getInstallKind();
  tel.event('clubhouse.update.apply_verified', [
    ATTR.applyVerified(taken ? 'verified' : 'not_taken'),
    ATTR.installKind(kind),
  ]);
}
