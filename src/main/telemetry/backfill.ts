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

function lineTime(line: string): number | undefined {
  try {
    const ts = (JSON.parse(line) as { ts?: unknown }).ts;
    const ms = typeof ts === 'string' ? Date.parse(ts) : NaN;
    return Number.isFinite(ms) ? ms : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The user accepted: send history from `range` days before the destination was
 * turned on (or everything kept), not before what was already sent. Runs in the
 * background; `getBackfillStatus` reports it. Resolves once it has started.
 */
export async function startBackfill(destinationId: string, range: BackfillRange, onChange?: (status: BackfillStatus) => void): Promise<{ ok: boolean; reason?: string }> {
  const pending = enabledAt.get(destinationId);
  if (!pending) return { ok: false, reason: 'no_offer' };
  if (running.has(destinationId)) return { ok: false, reason: 'already_running' };
  const until = pending.until;
  const from = range === 'all' ? 0 : until - range * DAY_MS;
  const since = Math.max(from, sentThrough(destinationId));
  const files = (await historyFiles(since, until)).reverse();
  // A file from a run before `since` may still hold lines after it; lines are filtered by time below.
  const runs = [...new Set(files.map((f) => f.run))];
  const status: BackfillStatus = { destinationId, state: 'running', spans: 0, logs: 0, metricPoints: 0, filtered: 0, runsDone: 0, runsTotal: runs.length };
  const abort = new AbortController();
  running.set(destinationId, { abort, status });
  enabledAt.delete(destinationId);
  finished.delete(destinationId);
  const changed = () => { try { onChange?.({ ...status }); } catch { /* a listener must never stop the send */ } };
  changed();

  void (async () => {
    try {
      for (const run of runs) {
        if (abort.signal.aborted) { status.state = 'cancelled'; break; }
        const lines: string[] = [];
        for (const f of files.filter((x) => x.run === run)) {
          const text = await fsp.readFile(f.file, 'utf-8').catch(() => '');
          for (const line of text.split('\n')) {
            if (!line) continue;
            // The session line says how the run was recorded; every other line counts only inside the window.
            if (line.startsWith('{"t":"session"')) { lines.push(line); continue; }
            const t = lineTime(line);
            if (t !== undefined && t >= since && t < until) lines.push(line);
          }
        }
        const report = await replayToDestination(destinationId, lines, { signal: abort.signal });
        status.spans += report.spans;
        status.logs += report.logs;
        status.metricPoints += report.metricPoints;
        status.filtered += report.filtered;
        if (!report.ok) {
          status.state = report.reason === 'cancelled' ? 'cancelled' : 'failed';
          status.reason = report.reason;
          break;
        }
        status.runsDone++;
        changed();
      }
      if (status.state === 'running') {
        status.state = 'done';
        // Sent once: never offered again, even after the destination is turned off and on.
        await updateTelemetrySettings((s) => ({
          ...s,
          destinations: s.destinations.map((d) => (d.id === destinationId ? { ...d, backfilledThrough: Math.max(d.backfilledThrough ?? 0, until) } : d)),
        }));
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
