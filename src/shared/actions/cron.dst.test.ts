/**
 * Daylight saving cases in fixed zones. Node applies a TZ set at runtime, so
 * each block switches zone first; a platform that ignores it skips the block.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { cronTimesBetween, nextCronTime, nextCronTimes, parseCron } from './cron';

const originalTz = process.env.TZ;
afterAll(() => {
  if (originalTz === undefined) delete process.env.TZ; else process.env.TZ = originalTz;
});

function spec(expr: string) {
  const parsed = parseCron(expr);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.spec;
}

/** Switch zone; true when it took (January and July offsets differ). */
function useZone(tz: string): boolean {
  process.env.TZ = tz;
  return new Date(2026, 0, 15).getTimezoneOffset() !== new Date(2026, 6, 15).getTimezoneOffset();
}

const iso = (d: Date | null) => d?.toISOString();

describe('America/New_York', () => {
  const ok = useZone('America/New_York');
  // 2026-03-08 02:00 EST → 03:00 EDT. 2026-11-01 02:00 EDT → 01:00 EST.
  const springJump = Date.UTC(2026, 2, 8, 7, 0); // 03:00 EDT
  const fallFirst130 = Date.UTC(2026, 10, 1, 5, 30); // 01:30 EDT
  const fallSecond130 = Date.UTC(2026, 10, 1, 6, 30); // 01:30 EST

  it.runIf(ok)('runs a fixed time the jump skips right after the jump', () => {
    process.env.TZ = 'America/New_York';
    expect(iso(nextCronTime(spec('30 2 * * *'), Date.UTC(2026, 2, 8, 6, 0)))).toBe(new Date(springJump).toISOString());
    // Searched from just before the jump too.
    expect(iso(nextCronTime(spec('30 2 * * *'), Date.UTC(2026, 2, 8, 6, 59, 30)))).toBe(new Date(springJump).toISOString());
    // Both listed times: 1:30 runs, and 2:30 runs after the jump.
    expect(nextCronTimes(spec('30 1,2 * * *'), Date.UTC(2026, 2, 8, 5, 0), 2).map((d) => d.toISOString()))
      .toEqual([new Date(Date.UTC(2026, 2, 8, 6, 30)).toISOString(), new Date(springJump).toISOString()]);
  });

  it.runIf(ok)('never returns a time before the search start in the repeated hour', () => {
    process.env.TZ = 'America/New_York';
    const next = nextCronTime(spec('* * * * *'), fallSecond130)!;
    expect(next.getTime()).toBe(fallSecond130 + 60_000);
    const between = cronTimesBetween(spec('* * * * *'), fallSecond130, fallSecond130 + 5 * 60_000, 100);
    expect(between).toHaveLength(5);
    expect(between.every((t) => t > fallSecond130)).toBe(true);
  });

  it.runIf(ok)('runs a fixed-hour time once, and `*` hours through the repeated hour', () => {
    process.env.TZ = 'America/New_York';
    // 1:30 daily: the first 1:30 only; the next run is the following day.
    expect(nextCronTime(spec('30 1 * * *'), fallFirst130)!.getTime()).toBe(Date.UTC(2026, 10, 2, 6, 30));
    // Every 15 minutes keeps going through the second 1:xx.
    const runs = nextCronTimes(spec('*/15 * * * *'), Date.UTC(2026, 10, 1, 5, 45), 4).map((d) => d.getTime());
    expect(runs).toEqual([0, 15, 30, 45].map((m) => Date.UTC(2026, 10, 1, 6, m)));
  });
});

describe('America/Santiago (midnight transition)', () => {
  const ok = useZone('America/Santiago');
  it.runIf(ok)('runs a midnight schedule on the day midnight is skipped', () => {
    process.env.TZ = 'America/Santiago';
    // Find the spring-forward day in September 2026: the day whose local midnight doesn't exist.
    let day = 0;
    for (let d = 1; d <= 30; d++) if (new Date(2026, 8, d, 0, 0).getHours() !== 0) { day = d; break; }
    if (!day) return;
    const next = nextCronTime(spec('0 0 * * *'), new Date(2026, 8, day - 1, 12, 0))!;
    expect(next.getDate()).toBe(day);
    expect(next.getHours()).toBe(1);
  });
});
