/**
 * Backfill on connect (#2920, spec §6.12): when the user turns a destination
 * on, offer to send it the history the local record already holds, within
 * limits the user picks. Never automatic: an offer exists only for a
 * destination the user turned on from off in this run of the app, and nothing
 * is sent until they accept it. Never for the developer destination, whose
 * purpose is live feedback correlation.
 *
 * Every line goes through the runtime's replay (bootstrap `replayToDestination`):
 * the record converter, then the destination's own level, filters, error-tail
 * rule, stamp and exporters. Diag lines and local-only detail never leave.
 *
 * Nothing is sent twice, and nothing hashed under an earlier salt is sent:
 * - `backfilledThrough` is how far history counts as sent: by a finished
 *   backfill, or live while the destination was on (turning it off sets it);
 * - `backfillProgress` is, per kind of line, the last line the destination
 *   confirmed, so a failed or cancelled send started again resumes after it;
 * - history before the current hash salt came into use (`hashSaltSince`) is
 *   never sent, so a reset install id can't be linked to the old one.
 *
 * No OpenTelemetry imports: part of the main bundle.
 */

import * as fsp from 'fs/promises';
import * as path from 'path';
import { LOG_RETENTION_TIERS, type LogRetention } from '../../shared/types';
import type { BackfillOffer, BackfillRange, BackfillStatus, TelemetryDestinationEntry } from '../../shared/telemetry/settings-types';
import * as logSettings from '../services/log-settings';
import { replayToDestination, sendTestEvent } from './bootstrap';
import { getRuntime } from './facade';
import { countOfflineItems, getOfflineDir } from './offline';
import { isValidIdentity } from './ids';
import { getLogDir } from './local-control';
import { recordFilesNewestFirst } from './local-record-reader';
import { localSaltSince } from './local-salt';
import { getTelemetrySettings, updateTelemetrySettings } from './settings';

export type { BackfillOffer, BackfillRange, BackfillStatus };

const DAY_MS = 24 * 60 * 60 * 1000;
/** The most read for one backfill when the retention tier sets no size limit. */
export const BACKFILL_MAX_BYTES_UNLIMITED = 500 * 1024 * 1024;
/** The most of each signal one backfill sends in all (the hourly session caps, spec §6.4). */
export const BACKFILL_MAX_SPANS = 50_000;
export const BACKFILL_MAX_LOGS = 10_000;
let limits = { spans: BACKFILL_MAX_SPANS, logs: BACKFILL_MAX_LOGS, pauseMs: 50 };
/** The most lines in one slice: one export, the runtime's batch size. */
const SLICE = 256;

type Kind = 'span' | 'log' | 'metric';
type Progress = NonNullable<TelemetryDestinationEntry['backfillProgress']>;

/** Per destination: when it was turned on, and once a send started, the window's start (a resume keeps it). */
const enabledAt = new Map<string, { until: number; from?: number }>();
const running = new Map<string, { abort: AbortController; status: BackfillStatus }>();
const finished = new Map<string, BackfillStatus>();

const FILE = /^telemetry-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:\.\d{1,3})?)(?:\.(\d+))?\.jsonl$/;

/** The user turned this destination on from off, in Settings, at `at`: history before then may be offered. Never for the developer destination. */
export function noteDestinationEnabled(destinationId: string, kind: string, at = Date.now()): void {
  if (kind === 'framebriar') return;
  enabledAt.set(destinationId, { until: at });
  finished.delete(destinationId);
}

/** "Not now": no offer until the destination is turned on again. */
export function dismissBackfill(destinationId: string): void {
  enabledAt.delete(destinationId);
}

/**
 * The destination was turned off and has stopped. What it was sent live up to now
 * counts as sent, so turning it on again offers only what was recorded while it
 * was off. A backfill still running to it stops, and its progress is folded in.
 * Never throws.
 */
export async function noteDestinationDisabled(destinationId: string, at = Date.now()): Promise<void> {
  dismissBackfill(destinationId);
  cancelBackfill(destinationId);
  try {
    await updateEntry(destinationId, (d) => ({ ...d, backfilledThrough: Math.max(d.backfilledThrough ?? 0, at), backfillProgress: undefined }));
  } catch {
    // telemetry-exempt: at worst, history sent live is offered again later, and only if the user accepts
  }
}

async function updateEntry(destinationId: string, fn: (d: TelemetryDestinationEntry) => TelemetryDestinationEntry): Promise<void> {
  await updateTelemetrySettings((s) => ({ ...s, destinations: s.destinations.map((d) => (d.id === destinationId ? fn(d) : d)) }));
}

function maxBytes(): number {
  let tier: LogRetention = 'medium';
  try {
    tier = logSettings.getSettings().retention ?? 'medium';
  } catch {
    // Unreadable settings: the default tier.
  }
  return LOG_RETENTION_TIERS[tier]?.maxTotalBytes || BACKFILL_MAX_BYTES_UNLIMITED;
}

function entryOf(destinationId: string): TelemetryDestinationEntry | undefined {
  try {
    return getTelemetrySettings().destinations.find((d) => d.id === destinationId);
  } catch {
    return undefined;
  }
}

/**
 * The earliest time history may come from: the current hash salt's start. Before
 * it, hashes were made with another salt, and stamped with this install's id they
 * would link the two. With no identity yet, the local record's salt; with neither, nothing.
 */
function saltSince(): number {
  try {
    const s = getTelemetrySettings();
    if (isValidIdentity(s)) return s.hashSaltSince ?? 0;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
  return localSaltSince() ?? Number.POSITIVE_INFINITY;
}

/** A run's start time, from its file name (the recorder's start, UTC, with dashes for colons). */
function runStartMs(base: string): number {
  const iso = base.replace(/T(\d{2})-(\d{2})-(\d{2})/, 'T$1:$2:$3');
  const ms = Date.parse(`${iso}Z`);
  return Number.isFinite(ms) ? ms : 0;
}

interface RecordFile { file: string; run: string; startMs: number; bytes: number }

/** Record files that may hold history in [since, until), newest first, within the byte limit. */
async function historyFiles(since: number, until: number): Promise<RecordFile[]> {
  const out: RecordFile[] = [];
  let budget = maxBytes();
  for (const file of await recordFilesNewestFirst(getLogDir())) {
    const m = FILE.exec(path.basename(file));
    if (!m) continue;
    let stat;
    try {
      stat = await fsp.stat(file);
    } catch {
      continue;
    }
    // Written to after `since`, and begun before `until`.
    if (stat.mtimeMs < since || runStartMs(m[1]) >= until) continue;
    if (stat.size > budget) break;
    budget -= stat.size;
    out.push({ file, run: m[1], startMs: runStartMs(m[1]), bytes: stat.size });
  }
  return out;
}

/** How recent a successful live export must be for Azure to count as reachable. */
export const AZURE_REACHABLE_WITHIN_MS = 10 * 60 * 1000;

/**
 * Azure Monitor's exporter keeps batches it can't send in its own disk queue and
 * reports success (spec §6.12), so a backfill to it would fill that queue rather
 * than stop. Reachable means: a live export succeeded in the last ten minutes,
 * none failed since, and the offline queue is empty (nothing is waiting to retry).
 */
async function azureReachable(destinationId: string, probe = false): Promise<boolean> {
  const recent = () => {
    const health = getRuntime()?.destinationHealth()[destinationId];
    return !!health?.lastSuccessAt && Date.now() - health.lastSuccessAt <= AZURE_REACHABLE_WITHIN_MS
      && (health.lastFailureAt ?? 0) <= health.lastSuccessAt;
  };
  if ((await queuedOffline()) !== 0) return false;
  if (recent()) return true;
  // Just turned on, nothing exported yet: one test event, as "Send test event" sends, settles it.
  if (!probe) return false;
  const test = await sendTestEvent(destinationId).catch(() => ({ ok: false }));
  return test.ok && recent() && (await queuedOffline()) === 0;
}

async function queuedOffline(): Promise<number> {
  try {
    return await countOfflineItems(getOfflineDir());
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** The first time history may come from for this destination. */
function floorFor(destinationId: string): number {
  return Math.max(entryOf(destinationId)?.backfilledThrough ?? 0, saltSince());
}

/** The offer for a destination the user just turned on, or null when there's nothing to send. */
export async function getBackfillOffer(destinationId: string): Promise<BackfillOffer | null> {
  const pending = enabledAt.get(destinationId);
  if (!pending || running.has(destinationId)) return null;
  const floor = floorFor(destinationId);
  if (floor >= pending.until) return null;
  const files = await historyFiles(floor, pending.until);
  if (files.length === 0) return null;
  const oldest = Math.max(floor, Math.min(...files.map((f) => f.startMs)));
  if (oldest >= pending.until) return null;
  return {
    destinationId,
    until: pending.until,
    oldest,
    days: Math.max(1, Math.ceil((pending.until - oldest) / DAY_MS)),
    bytes: files.reduce((n, f) => n + f.bytes, 0),
    // A send already started: the rest goes in the window chosen then.
    ...(pending.from !== undefined && { resuming: true }),
  };
}

export function getBackfillStatus(destinationId: string): BackfillStatus | null {
  return running.get(destinationId)?.status ?? finished.get(destinationId) ?? null;
}

export function cancelBackfill(destinationId: string): void {
  running.get(destinationId)?.abort.abort();
}

interface Parsed { line: string; t: number; kind: Kind; traceId?: string; failed?: boolean }

const KIND: Record<string, Kind> = { span: 'span', event: 'log', exception: 'log', metric: 'metric' };

/** A line the converter can send, with its time and kind. Diag and bookkeeping lines are left here. */
function parse(line: string): Parsed | undefined {
  try {
    const r = JSON.parse(line) as { t?: unknown; ts?: unknown; traceId?: unknown; outcome?: unknown };
    const kind = typeof r.t === 'string' && Object.prototype.hasOwnProperty.call(KIND, r.t) ? KIND[r.t] : undefined;
    const t = typeof r.ts === 'string' ? Date.parse(r.ts) : NaN;
    if (!kind || !Number.isFinite(t)) return undefined;
    return { line, t, kind, ...(typeof r.traceId === 'string' && { traceId: r.traceId }), ...(r.outcome === 'error' && { failed: true }) };
  } catch {
    return undefined;
  }
}

/** Per kind, the lines not yet confirmed: after the progress mark (its time, and how many lines at that time were sent). */
function afterProgress(lines: Parsed[], progress: Progress): Parsed[] {
  const seenAt = new Map<Kind, number>();
  return lines.filter((p) => {
    const mark = progress[p.kind];
    if (!mark || p.t > mark.t) return true;
    if (p.t < mark.t) return false;
    const seen = (seenAt.get(p.kind) ?? 0) + 1;
    seenAt.set(p.kind, seen);
    return seen > mark.n;
  });
}

/**
 * The user accepted: send history from `range` days before the destination was
 * turned on (or everything kept), from after what was already sent. Runs in the
 * background; `getBackfillStatus` reports it. Resolves once it has started.
 *
 * Each run's lines are sorted by time and sent as slices of one kind, up to 256
 * lines: exactly one export each, which the destination confirms or not. After
 * each confirmed slice the kind's progress mark moves past it. After a failure or
 * a cancel the offer stays, and starting again resumes after the marks.
 */
export async function startBackfill(destinationId: string, range: BackfillRange, onChange?: (status: BackfillStatus) => void): Promise<{ ok: boolean; reason?: string }> {
  const pending = enabledAt.get(destinationId);
  if (!pending) return { ok: false, reason: 'no_offer' };
  if (running.has(destinationId)) return { ok: false, reason: 'already_running' };
  const azure = entryOf(destinationId)?.kind === 'azure';
  // Claimed before the first wait, so a second start (a double click) is refused.
  const abort = new AbortController();
  const status: BackfillStatus = { destinationId, state: 'running', spans: 0, logs: 0, metricPoints: 0, filtered: 0, runsDone: 0, runsTotal: 0 };
  running.set(destinationId, { abort, status });
  const changed = () => { try { onChange?.({ ...status }); } catch { /* a listener must never stop the send */ } };

  if (azure && !await azureReachable(destinationId, true)) {
    // Refused before anything started: an earlier stopped send's status stays.
    running.delete(destinationId);
    return { ok: false, reason: 'not_reachable' };
  }
  finished.delete(destinationId);
  const until = pending.until;
  // A resume keeps the window of the first send, so nothing between its marks and a narrower new window is lost.
  pending.from ??= range === 'all' ? 0 : until - range * DAY_MS;
  const from = Math.max(pending.from, floorFor(destinationId));
  let files: RecordFile[];
  try {
    files = (await historyFiles(from, until)).reverse();
  } catch {
    files = [];
  }
  const runs = [...new Set(files.map((f) => f.run))];
  status.runsTotal = runs.length;
  changed();

  void (async () => {
    try {
      const progress: Progress = { ...entryOf(destinationId)?.backfillProgress };
      // Up to and including this time was already sent, by an earlier backfill or live.
      const sentUpTo = entryOf(destinationId)?.backfilledThrough ?? 0;
      for (const run of runs) {
        if (abort.signal.aborted) { status.state = 'cancelled'; break; }
        let session: string | undefined;
        const parsed: Parsed[] = [];
        // Every line of the run, for the error-tail decision; only those in the window are sent.
        const failedTraces = new Set<string>();
        for (const f of files.filter((x) => x.run === run)) {
          const text = await fsp.readFile(f.file, 'utf-8').catch(() => '');
          for (const line of text.split('\n')) {
            if (!line) continue;
            if (line.startsWith('{"t":"session"')) { session ??= line; continue; }
            const p = parse(line);
            if (!p) continue;
            if (p.failed && p.traceId) failedTraces.add(p.traceId);
            if (p.t >= from && p.t > sentUpTo && p.t < until) parsed.push(p);
          }
        }
        // A run whose first chunk is gone has no session line: nothing says which build or
        // process recorded it, so it isn't sent rather than sent as today's.
        if (!session) { status.runsDone++; changed(); continue; }
        // Stable: lines with the same time keep their file order, which the progress counts rely on.
        parsed.sort((a, b) => a.t - b.t);
        const todo = afterProgress(parsed, progress);
        const state = {};
        let slice: Parsed[] = [];
        const slices: Parsed[][] = [];
        for (const p of todo) {
          if (slice.length > 0 && (p.kind !== slice[0].kind || slice.length >= SLICE)) { slices.push(slice); slice = []; }
          slice.push(p);
        }
        if (slice.length > 0) slices.push(slice);

        for (const s of slices) {
          if (abort.signal.aborted) { status.state = 'cancelled'; break; }
          const kind = s[0].kind;
          const remaining = kind === 'span' ? limits.spans - status.spans : kind === 'log' ? limits.logs - status.logs : Infinity;
          if (remaining > 0) {
            const queuedBefore = azure ? await queuedOffline() : 0;
            const report = await replayToDestination(destinationId, [session, ...s.map((p) => p.line)], {
              signal: abort.signal, errorTraceIds: failedTraces, state,
              ...(kind === 'span' && { maxSpans: remaining }), ...(kind === 'log' && { maxLogs: remaining }),
            });
            status.spans += report.spans;
            status.logs += report.logs;
            status.metricPoints += report.metricPoints;
            status.filtered += report.filtered;
            if (!report.ok) {
              status.state = report.reason === 'cancelled' ? 'cancelled' : 'failed';
              status.reason = report.reason;
              break;
            }
            // Azure said yes but queued it to disk: it isn't sending now. Stop, so a backfill
            // never fills that queue. The queued slice is sent when Azure is back, so it counts as sent.
            if (azure && (await queuedOffline()) > queuedBefore) {
              const last = s[s.length - 1].t;
              const before = progress[kind];
              const atLast = s.filter((p) => p.t === last).length;
              progress[kind] = { t: last, n: before && before.t === last ? before.n + atLast : atLast };
              await updateEntry(destinationId, (d) => ({ ...d, backfillProgress: { ...progress } }));
              status.state = 'failed';
              status.reason = 'not_reachable';
              break;
            }
          } else {
            // Past the backfill's limit for this kind: left out for good, like the session caps.
            status.filtered += s.length;
          }
          // Confirmed (or deliberately left out): the kind's mark moves past this slice.
          const last = s[s.length - 1].t;
          const before = progress[kind];
          const atLast = s.filter((p) => p.t === last).length;
          progress[kind] = { t: last, n: before && before.t === last ? before.n + atLast : atLast };
          await updateEntry(destinationId, (d) => ({ ...d, backfillProgress: { ...progress } }));
          changed();
          // A pause between slices, so a backfill never floods a destination (Azure queues what fails to its own disk).
          await new Promise((resolve) => setTimeout(resolve, limits.pauseMs));
        }
        if (status.state !== 'running') break;
        status.runsDone++;
        changed();
      }
      if (status.state === 'running') {
        status.state = 'done';
        // Nothing left before the destination was turned on: never offered again.
        await updateEntry(destinationId, (d) => ({ ...d, backfilledThrough: Math.max(d.backfilledThrough ?? 0, until), backfillProgress: undefined }));
        enabledAt.delete(destinationId);
      }
    } catch (err) {
      // telemetry-exempt: the status says it failed; nothing more is sent and it never retries on its own
      status.state = 'failed';
      status.reason = err instanceof Error ? err.name : 'unknown';
    } finally {
      running.delete(destinationId);
      finished.set(destinationId, { ...status });
      changed();
    }
  })();
  return { ok: true };
}

/** For tests: smaller limits, no pause. */
export function _setBackfillLimitsForTests(next: Partial<typeof limits>): void {
  limits = { ...limits, ...next };
}

/** For tests: forget offers and runs. */
export function _resetBackfillForTests(): void {
  limits = { spans: BACKFILL_MAX_SPANS, logs: BACKFILL_MAX_LOGS, pauseMs: 50 };
  for (const r of running.values()) r.abort.abort();
  running.clear();
  enabledAt.clear();
  finished.clear();
}
