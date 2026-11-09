import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./log-service', () => ({ appLog: vi.fn() }));

import { appLog } from './log-service';
import {
  STALL_LOG_GAP_MS, STALL_TICK_MS, _resetStallMonitorForTests, beginOperation, startMainStallMonitor, trackOperation,
} from './main-stall-monitor';

let t: number;
let lines: Array<{ msg: string; meta: Record<string, unknown> }>;

/** Normal ticks: the clock moves with the timers. */
function idle(ms: number): void {
  for (let left = ms; left > 0; left -= STALL_TICK_MS) {
    t += STALL_TICK_MS;
    vi.advanceTimersByTime(STALL_TICK_MS);
  }
}

/** The main thread was blocked for `ms`, then the next tick ran. */
function block(ms: number): void {
  t += ms + STALL_TICK_MS;
  vi.advanceTimersByTime(STALL_TICK_MS);
}

beforeEach(() => {
  vi.useFakeTimers();
  t = 1_000;
  lines = [];
  startMainStallMonitor({ now: () => t, log: (msg, meta) => lines.push({ msg, meta }), loadAvg: () => [12.345, 8, 4] });
});

afterEach(() => {
  _resetStallMonitorForTests();
  vi.useRealTimers();
  vi.mocked(appLog).mockClear();
});

describe('main stall monitor', () => {
  it('logs nothing while ticks are on time or only a little late', () => {
    idle(5_000);
    block(900);
    expect(lines).toEqual([]);
  });

  it('logs a stall with the operation that was running when it began', () => {
    idle(1_000);
    const end = beginOperation('git watcher rebuild');
    block(18_000);
    end();
    expect(lines).toEqual([{
      msg: 'The main process stalled for 18000ms',
      // Running for the stall plus the tick it started in.
      meta: { stallMs: 18_000, operations: [{ name: 'git watcher rebuild', ms: 18_500 }], loadAvg: [12.35, 8, 4] },
    }]);
  });

  it('names a synchronous operation that ended before the late tick', async () => {
    idle(1_000);
    await trackOperation('agents.json write', () => { t += 3_000; });
    block(0);
    expect(lines).toHaveLength(1);
    expect(lines[0].meta).toMatchObject({ stallMs: 3_000, operations: [{ name: 'agents.json write', ms: 3_000, ended: true }] });
  });

  it('forgets operations that ended before the tick before the stall', () => {
    beginOperation('mcp start_helper')();
    idle(1_000);
    block(2_000);
    expect(lines[0].meta.operations).toEqual([]);
  });

  it('logs at most one line per gap and counts the stalls in between', () => {
    block(2_000);
    block(1_500);
    block(1_200);
    expect(lines).toHaveLength(1);
    idle(STALL_LOG_GAP_MS);
    block(1_100);
    expect(lines).toHaveLength(2);
    expect(lines[1].meta).toMatchObject({ stallMs: 1_100, suppressed: 2, suppressedMaxMs: 1_500 });
  });

  it('treats a very long gap as sleep, not a stall', () => {
    block(30 * 60_000);
    expect(lines).toEqual([]);
  });

  it('writes core:perf warn lines through appLog by default', () => {
    _resetStallMonitorForTests();
    startMainStallMonitor({ now: () => t });
    block(1_200);
    expect(appLog).toHaveBeenCalledWith('core:perf', 'warn', 'The main process stalled for 1200ms', {
      meta: expect.objectContaining({ stallMs: 1_200, operations: [], loadAvg: expect.any(Array) }),
    });
  });

  it('passes through the result and the error of a tracked operation', async () => {
    await expect(trackOperation('x', async () => 7)).resolves.toBe(7);
    await expect(trackOperation('y', () => { throw new Error('boom'); })).rejects.toThrow('boom');
  });
});
