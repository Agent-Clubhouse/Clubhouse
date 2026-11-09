/**
 * Main-process stall log (#3230). A whole-app beach ball means the main
 * process stopped running JavaScript; this finds out when, for how long, and
 * what was going on.
 *
 * A light interval timer checks how late it fires. When a tick is late by
 * STALL_LOG_MS or more, one `core:perf` warn line records the stall and the
 * operations that were running at any point since the tick before. Hot paths
 * mark themselves with beginOperation / trackOperation (a git watcher rebuild,
 * an agents.json write, an MCP tool call, ...). An async operation that was
 * running isn't proof it caused the stall, so each one carries how long it
 * had been running; a sync one that blocked shows up with the stall's length.
 *
 * At most one line per STALL_LOG_GAP_MS; stalls in between are counted on
 * the next line. A gap longer than MAX_STALL_MS is a sleep, not a stall.
 * Local log only: there is no main-process hang telemetry event.
 */
import * as os from 'os';
import { appLog } from './log-service';

export const STALL_TICK_MS = 500;
export const STALL_LOG_MS = 1_000;
export const STALL_LOG_GAP_MS = 10_000;
/** Late by more than this, the machine was asleep (or the process stopped). */
export const MAX_STALL_MS = 5 * 60_000;
/** Operations named per line at most. */
const MAX_OPERATIONS = 8;

interface Operation {
  name: string;
  startedAt: number;
  endedAt: number | null;
}

let nextId = 1;
const running = new Map<number, Operation>();
/** Operations that ended since the last tick: they may have been the stall. */
let endedSinceTick: Operation[] = [];
let clock: () => number = () => performance.now();
let stop: (() => void) | null = null;

/** Mark an operation as running until the returned function is called. */
export function beginOperation(name: string): () => void {
  const id = nextId++;
  const op: Operation = { name, startedAt: clock(), endedAt: null };
  running.set(id, op);
  return () => {
    if (!running.delete(id)) return;
    op.endedAt = clock();
    // Bounded: a tick drains it; with the monitor off nothing is kept.
    if (stop && endedSinceTick.length < 64) endedSinceTick.push(op);
  };
}

/** Run `fn` marked as `name`. */
export async function trackOperation<T>(name: string, fn: () => T | Promise<T>): Promise<T> {
  const end = beginOperation(name);
  try {
    return await fn();
  } finally {
    end();
  }
}

export interface StallMonitorOptions {
  now?: () => number;
  log?: (msg: string, meta: Record<string, unknown>) => void;
  loadAvg?: () => number[];
}

/** Start the monitor (once). Returns a stop function. */
export function startMainStallMonitor(opts: StallMonitorOptions = {}): () => void {
  if (stop) return stop;
  clock = opts.now ?? (() => performance.now());
  const log = opts.log ?? ((msg, meta) => appLog('core:perf', 'warn', msg, { meta }));
  const loadAvg = opts.loadAvg ?? (() => os.loadavg());
  let last = clock();
  let lastLogAt = -Infinity;
  let suppressed = 0;
  let suppressedMaxMs = 0;

  const tick = () => {
    const now = clock();
    const stallMs = now - last - STALL_TICK_MS;
    last = now;
    const ended = endedSinceTick;
    endedSinceTick = [];
    if (stallMs < STALL_LOG_MS || stallMs > MAX_STALL_MS) return;
    if (now - lastLogAt < STALL_LOG_GAP_MS) {
      suppressed++;
      suppressedMaxMs = Math.max(suppressedMaxMs, stallMs);
      return;
    }
    lastLogAt = now;
    const operations = [...ended, ...running.values()]
      .sort((a, b) => a.startedAt - b.startedAt)
      .slice(0, MAX_OPERATIONS)
      .map((op) => ({
        name: op.name,
        ms: Math.round((op.endedAt ?? now) - op.startedAt),
        ...(op.endedAt !== null && { ended: true }),
      }));
    const meta: Record<string, unknown> = {
      stallMs: Math.round(stallMs),
      operations,
      loadAvg: loadAvg().map((n) => Math.round(n * 100) / 100),
      ...(suppressed > 0 && { suppressed, suppressedMaxMs: Math.round(suppressedMaxMs) }),
    };
    suppressed = 0;
    suppressedMaxMs = 0;
    log(`The main process stalled for ${Math.round(stallMs)}ms`, meta);
  };

  const timer = setInterval(tick, STALL_TICK_MS);
  timer.unref?.();
  stop = () => {
    clearInterval(timer);
    stop = null;
    endedSinceTick = [];
    clock = () => performance.now();
  };
  return stop;
}

/** Test-only: forget running operations. */
export function _resetStallMonitorForTests(): void {
  stop?.();
  running.clear();
  endedSinceTick = [];
  nextId = 1;
}
