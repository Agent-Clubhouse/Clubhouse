import { describe, expect, it } from 'vitest';
import { cronMatches, cronTimesBetween, describeCron, formatClock, nextCronTime, nextCronTimes, parseCron, validateCron } from './cron';

function spec(expr: string) {
  const parsed = parseCron(expr);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.spec;
}

/** A local time, so tests read the same in every time zone. */
function local(y: number, mo: number, d: number, h = 0, mi = 0): Date {
  return new Date(y, mo - 1, d, h, mi, 0, 0);
}

describe('parseCron', () => {
  it('parses lists, ranges, steps and names', () => {
    const s = spec('*/15 9-17 1,15 JAN-MAR MON-FRI');
    expect([...s.minute]).toEqual([0, 15, 30, 45]);
    expect([...s.hour]).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect([...s.dayOfMonth]).toEqual([1, 15]);
    expect([...s.month]).toEqual([1, 2, 3]);
    expect([...s.dayOfWeek]).toEqual([1, 2, 3, 4, 5]);
  });

  it('treats 7 as Sunday and a bare start with a step as running to the end', () => {
    expect([...spec('0 0 * * 7').dayOfWeek]).toEqual([0]);
    expect([...spec('5/20 * * * *').minute]).toEqual([5, 25, 45]);
  });

  it('rejects bad lines with one plain sentence', () => {
    expect(validateCron('* * * *')).toMatch(/needs 5 parts/);
    expect(validateCron('60 * * * *')).toMatch(/minute must be between 0 and 59/);
    expect(validateCron('*/0 * * * *')).toMatch(/step/);
    expect(validateCron('5-1 * * * *')).toMatch(/backwards/);
    expect(validateCron('* * * FOO *')).toMatch(/isn’t a valid month/);
    expect(validateCron('0 9 * * 1-5')).toBeNull();
  });
});

describe('nextCronTime', () => {
  it('finds the next weekday morning', () => {
    // Friday 2026-11-06 10:00 → Monday 09:00.
    expect(nextCronTime(spec('0 9 * * 1-5'), local(2026, 11, 6, 10))).toEqual(local(2026, 11, 9, 9));
    // Before 9 on a weekday → the same day.
    expect(nextCronTime(spec('0 9 * * 1-5'), local(2026, 11, 9, 8, 59))).toEqual(local(2026, 11, 9, 9));
  });

  it('is strictly after the given time', () => {
    expect(nextCronTime(spec('0 9 * * *'), local(2026, 11, 9, 9))).toEqual(local(2026, 11, 10, 9));
  });

  it('matches either day field when both are restricted', () => {
    // The 13th, or any Friday.
    const s = spec('0 12 13 * 5');
    expect(nextCronTime(s, local(2026, 11, 1))).toEqual(local(2026, 11, 6, 12)); // Friday the 6th
    expect(nextCronTime(s, local(2026, 11, 6, 13))).toEqual(local(2026, 11, 13, 12)); // the 13th
  });

  it('returns null for a date that never comes', () => {
    expect(nextCronTime(spec('0 0 30 2 *'), local(2026, 1, 1))).toBeNull();
  });

  it('handles leap days', () => {
    expect(nextCronTime(spec('0 0 29 2 *'), local(2026, 3, 1))).toEqual(local(2028, 2, 29));
  });

  it('lists the next few runs', () => {
    const runs = nextCronTimes(spec('30 * * * *'), local(2026, 11, 9, 9, 45), 3);
    expect(runs).toEqual([local(2026, 11, 9, 10, 30), local(2026, 11, 9, 11, 30), local(2026, 11, 9, 12, 30)]);
  });

  it('lists missed times between two moments, capped', () => {
    const s = spec('0 * * * *');
    const missed = cronTimesBetween(s, local(2026, 11, 9, 0, 30).getTime(), local(2026, 11, 9, 5, 0).getTime(), 10);
    expect(missed.map((t) => new Date(t).getHours())).toEqual([1, 2, 3, 4, 5]);
    expect(cronTimesBetween(s, local(2026, 11, 1).getTime(), local(2026, 11, 9).getTime(), 10)).toHaveLength(10);
  });

  it('matches a minute', () => {
    expect(cronMatches(spec('0 9 * * 1-5'), local(2026, 11, 9, 9))).toBe(true);
    expect(cronMatches(spec('0 9 * * 1-5'), local(2026, 11, 8, 9))).toBe(false);
  });
});

describe('daylight saving (in the machine’s zone, when it has DST)', () => {
  // Find this zone's spring-forward gap in 2026, if it has one.
  function springForward(): Date | null {
    for (let t = local(2026, 1, 1).getTime(); t < local(2026, 12, 31).getTime(); t += 3600_000) {
      const a = new Date(t);
      const b = new Date(t + 3600_000);
      // Whole-hour jumps only (a few zones move by 30 minutes).
      if (a.getMinutes() !== 0 || b.getMinutes() !== 0) continue;
      if (b.getHours() - a.getHours() === 2 || (a.getHours() === 23 && b.getHours() === 1)) return b;
    }
    return null;
  }
  const jump = springForward();

  it.runIf(jump)('runs a time skipped by the jump at the first minute after it', () => {
    // The hour that doesn't exist on the jump day.
    const skippedHour = (jump!.getHours() + 23) % 24;
    const before = new Date(jump!.getTime() - 2 * 3600_000);
    const next = nextCronTime(spec(`30 ${skippedHour} * * *`), before)!;
    expect(next.getTime()).toBe(jump!.getTime());
  });

  it.runIf(jump)('keeps a daily time on the same clock time across the change', () => {
    const before = new Date(jump!.getTime() - 3 * 24 * 3600_000);
    const runs = nextCronTimes(spec('0 12 * * *'), before, 6);
    expect(runs.every((d) => d.getHours() === 12 && d.getMinutes() === 0)).toBe(true);
  });
});

describe('describeCron', () => {
  it.each([
    ['0 9 * * *', 'Every day at 9:00 AM'],
    ['0 9 * * 1-5', 'Weekdays at 9:00 AM'],
    ['30 17 * * 0,6', 'Weekends at 5:30 PM'],
    ['0 9 * * 1', 'On Mondays at 9:00 AM'],
    ['0 9 * * 1,3', 'On Mondays and Wednesdays at 9:00 AM'],
    ['0 * * * *', 'Every hour'],
    ['15 * * * *', 'Every hour at 15 minutes past'],
    ['*/15 * * * *', 'Every 15 minutes'],
    ['0 */2 * * *', 'Every 2 hours'],
    ['0 9 1 * *', 'On the 1st of the month at 9:00 AM'],
    ['0 0 * * *', 'Every day at 12:00 AM'],
    ['0 9,17 * * *', 'Every day at 9:00 AM and 5:00 PM'],
  ])('%s → %s', (expr, words) => {
    expect(describeCron(expr)).toBe(words);
  });

  it('describes an invalid line by its error', () => {
    expect(describeCron('nope')).toMatch(/needs 5 parts/);
  });

  it('formats the clock', () => {
    expect(formatClock(0, 5)).toBe('12:05 AM');
    expect(formatClock(12, 0)).toBe('12:00 PM');
    expect(formatClock(23, 59)).toBe('11:59 PM');
  });
});
