/**
 * Backfill on connect (#2920, spec §6.12): when the user turns a destination
 * on, offer to send it the history the local record already holds, within
 * limits the user picks. Never automatic: an offer exists only for a
 * destination the user turned on in this run of the app, and nothing is sent
 * until they accept it. Never for the developer destination, whose purpose is
 * live feedback correlation.
 *
 * Every line goes through the runtime's replay (bootstrap `replayToDestination`):
 * the record converter, then the destination's own level, filters, error-tail
 * rule, limits, stamp and exporters. Diag lines and local-only detail never
 * leave. History already sent (`backfilledThrough`) is never offered again.
 *
 * No OpenTelemetry imports: part of the main bundle.
 */

import * as fsp from 'fs/promises';
import * as path from 'path';
import { LOG_RETENTION_TIERS, type LogRetention } from '../../shared/types';
import * as logSettings from '../services/log-settings';
import { replayToDestination } from './bootstrap';
import { getLogDir } from './local-control';
import { recordFilesNewestFirst } from './local-record-reader';
import { getTelemetrySettings, updateTelemetrySettings } from './settings';
import type { BackfillOffer, BackfillRange, BackfillStatus } from '../../shared/telemetry/settings-types';

export type { BackfillOffer, BackfillRange, BackfillStatus };

const DAY_MS = 24 * 60 * 60 * 1000;
/** The most read for one backfill when the retention tier sets no size limit. */
export const BACKFILL_MAX_BYTES_UNLIMITED = 500 * 1024 * 1024;
interface Pending { until: number }
const enabledAt = new Map<string, Pending>();
const running = new Map<string, { abort: AbortController; status: BackfillStatus }>();
const finished = new Map<string, BackfillStatus>();

const FILE = /^telemetry-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:\.\d{1,3})?)(?:\.(\d+))?\.jsonl$/;

/** The user turned this destination on just now, in Settings: history before now may be offered. Never for the developer destination. */
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
 * The destination was turned off. What it was sent live up to now counts as sent,
 * so turning it on again offers only what was recorded while it was off. A
 * backfill still running to it stops. Never throws.
 */
export async function noteDestinationDisabled(destinationId: string, at = Date.now()): Promise<void> {
  dismissBackfill(destinationId);
  cancelBackfill(destinationId);
  try {
    await updateTelemetrySettings((s) => ({
      ...s,
      destinations: s.destinations.map((d) => (d.id === destinationId ? { ...d, backfilledThrough: Math.max(d.backfilledThrough ?? 0, at) } : d)),
    }));
  } catch {
    // telemetry-exempt: at worst, history sent live is offered again later, and only if the user accepts
  }
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

function sentThrough(destinationId: string): number {
  try {
    return getTelemetrySettings().destinations.find((d) => d.id === destinationId)?.backfilledThrough ?? 0;
  } catch {
    return 0;
  }
}

/** A run's start time, from its file name (the recorder's start, local ISO with dashes). */
function runStartMs(base: string): number {
  const iso = base.replace(/T(\d{2})-(\d{2})-(\d{2})/, 'T$1:$2:$3');
  const ms = Date.parse(`${iso}Z`);
  return Number.isFinite(ms) ? ms : 0;
}

interface RecordFile { file: string; run: string; startMs: number; bytes: number; mtimeMs: number }

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
    // Written to only after `since`, and begun before `until`.
    if (stat.mtimeMs < since || runStartMs(m[1]) >= until) continue;
    if (stat.size > budget) break;
    budget -= stat.size;
    out.push({ file, run: m[1], startMs: runStartMs(m[1]), bytes: stat.size, mtimeMs: stat.mtimeMs });
  }
  return out;
}

/** The offer for a destination the user just turned on, or null when there's nothing to send. */
export async function getBackfillOffer(destinationId: string): Promise<BackfillOffer | null> {
  const pending = enabledAt.get(destinationId);
  if (!pending || running.has(destinationId)) return null;
  const files = await historyFiles(sentThrough(destinationId), pending.until);
  if (files.length === 0) return null;
  const oldest = Math.max(sentThrough(destinationId), Math.min(...files.map((f) => f.startMs)));
  if (oldest >= pending.until) return null;
  return {
    destinationId,
    until: pending.until,
    oldest,
    days: Math.max(1, Math.ceil((pending.until - oldest) / DAY_MS)),
    bytes: files.reduce((n, f) => n + f.bytes, 0),
  };
}

export function getBackfillStatus(destinationId: string): BackfillStatus | null {
  return running.get(destinationId)?.status ?? finished.get(destinationId) ?? null;
}

export function cancelBackfill(destinationId: string): void {
  running.get(destinationId)?.abort.abort();
}

interface Parsed { line: string; t: number; kind: 'span' | 'log' | 'metric'; traceId?: string; failed?: boolean }

const KIND: Record<string, Parsed['kind']> = { span: 'span', event: 'log', exception: 'log', metric: 'metric' };

/** A line the converter can send, with its time and kind. Diag and bookkeeping lines are left here. */
function parse(line: string): Parsed | undefined {
  try {
    const r = JSON.parse(line) as { t?: unknown; ts?: unknown; traceId?: unknown; outcome?: unknown };
    const kind = typeof r.t === 'string' ? KIND[r.t] : undefined;
    const t = typeof r.ts === 'string' ? Date.parse(r.ts) : NaN;
    if (!kind || !Number.isFinite(t)) return undefined;
    return { line, t, kind, ...(typeof r.traceId === 'string' && { traceId: r.traceId }), ...(r.outcome === 'error' && { failed: true }) };
  } catch {
    return undefined;
  }
}

/** The most lines in one slice: one exporter call, the runtime's batch size. */
const SLICE = 256;

/**
 * A run's lines as slices sent one at a time: in time order, each of one kind, so
 * each is exactly one export the destination confirms or not. A slice never
 * splits lines with the same time, so resuming after the last confirmed time
 * skips nothing and repeats nothing.
 */
function slicesOf(lines: Parsed[]): Parsed[][] {
  const out: Parsed[][] = [];
  let current: Parsed[] = [];
  for (const p of lines) {
    const last = current[current.length - 1];
    if (last && (p.kind !== last.kind || current.length >= SLICE) && p.t !== last.t) {
      out.push(current);
      current = [];
    }
    current.push(p);
  }
  if (current.length > 0) out.push(current);
  return out;
}

async function markSent(destinationId: string, through: number): Promise<void> {
  await updateTelemetrySettings((s) => ({
    ...s,
    destinations: s.destinations.map((d) => (d.id === destinationId ? { ...d, backfilledThrough: Math.max(d.backfilledThrough ?? 0, through) } : d)),
  }));
}

/**
 * The user accepted: send history from `range` days before the destination was
 * turned on (or everything kept), after what was already sent. Runs in the
 * background; `getBackfillStatus` reports it. Resolves once it has started.
 *
 * What's marked sent (`backfilledThrough`) advances only past slices the
 * destination's exporter confirmed. After a failure or a cancel the offer stays,
 * and starting again resumes after the last confirmed slice.
 */
export async function startBackfill(destinationId: string, range: BackfillRange, onChange?: (status: BackfillStatus) => void): Promise<{ ok: boolean; reason?: string }> {
  const pending = enabledAt.get(destinationId);
  if (!pending) return { ok: false, reason: 'no_offer' };
  if (running.has(destinationId)) return { ok: false, reason: 'already_running' };
  const until = pending.until;
  const from = range === 'all' ? 0 : until - range * DAY_MS;
  const files = (await historyFiles(Math.max(from, sentThrough(destinationId)), until)).reverse();
  const runs = [...new Set(files.map((f) => f.run))];
  const status: BackfillStatus = { destinationId, state: 'running', spans: 0, logs: 0, metricPoints: 0, filtered: 0, runsDone: 0, runsTotal: runs.length };
  const abort = new AbortController();
  running.set(destinationId, { abort, status });
  finished.delete(destinationId);
  const changed = () => { try { onChange?.({ ...status }); } catch { /* a listener must never stop the send */ } };
  changed();

  void (async () => {
    try {
      for (const run of runs) {
        if (abort.signal.aborted) { status.state = 'cancelled'; break; }
        // Read again for each run: a resumed send starts after the last confirmed slice.
        const after = sentThrough(destinationId);
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
            if (p.t >= from && p.t > after && p.t < until) parsed.push(p);
          }
        }
        // Stable: lines with the same time keep their file order.
        parsed.sort((a, b) => a.t - b.t);
        const state = {};
        for (const slice of slicesOf(parsed)) {
          if (abort.signal.aborted) { status.state = 'cancelled'; break; }
          const lines = session ? [session, ...slice.map((p) => p.line)] : slice.map((p) => p.line);
          const report = await replayToDestination(destinationId, lines, { signal: abort.signal, errorTraceIds: failedTraces, state });
          status.spans += report.spans;
          status.logs += report.logs;
          status.metricPoints += report.metricPoints;
          status.filtered += report.filtered;
          if (!report.ok) {
            status.state = report.reason === 'cancelled' ? 'cancelled' : 'failed';
            status.reason = report.reason;
            break;
          }
          // Confirmed: everything up to this slice's time is sent.
          await markSent(destinationId, slice[slice.length - 1].t);
          changed();
        }
        if (status.state !== 'running') break;
        status.runsDone++;
        changed();
      }
      if (status.state === 'running') {
        status.state = 'done';
        // Nothing left before the destination was turned on: never offered again.
        await markSent(destinationId, until);
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

/** For tests: forget offers and runs. */
export function _resetBackfillForTests(): void {
  for (const r of running.values()) r.abort.abort();
  running.clear();
  enabledAt.clear();
  finished.clear();
}
