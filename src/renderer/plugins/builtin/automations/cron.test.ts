import { describe, it, expect } from 'vitest';
import { parseField, matchesCron, describeSchedule, PRESETS } from './cron';

// ── parseField ──────────────────────────────────────────────────────────

describe('parseField', () => {
  it('parses wildcard', () => {
    const result = parseField('*', 0, 5);
    expect(result).toEqual(new Set([0, 1, 2, 3, 4, 5]));
  });

  it('parses single value', () => {
    expect(parseField('3', 0, 59)).toEqual(new Set([3]));
  });

  it('parses range', () => {
    expect(parseField('2-5', 0, 59)).toEqual(new Set([2, 3, 4, 5]));
  });

  it('parses list', () => {
    expect(parseField('1,3,5', 0, 59)).toEqual(new Set([1, 3, 5]));
  });

  it('parses step on wildcard', () => {
    const result = parseField('*/15', 0, 59);
    expect(result).toEqual(new Set([0, 15, 30, 45]));
  });

  it('parses step on range', () => {
    const result = parseField('10-20/5', 0, 59);
    expect(result).toEqual(new Set([10, 15, 20]));
  });

  it('parses combined list and range', () => {
    const result = parseField('1,10-12', 0, 59);
    expect(result).toEqual(new Set([1, 10, 11, 12]));
  });

  it('handles min = max single value range', () => {
    expect(parseField('*', 5, 5)).toEqual(new Set([5]));
  });

  it('handles step larger than range', () => {
    const result = parseField('*/60', 0, 59);
    expect(result).toEqual(new Set([0]));
  });
});

// ── matchesCron ─────────────────────────────────────────────────────────

describe('matchesCron', () => {
  it('matches every minute', () => {
    const date = new Date(2026, 1, 15, 10, 30); // Feb 15 2026 10:30 (Sunday)
    expect(matchesCron('* * * * *', date)).toBe(true);
  });

  it('matches specific minute and hour', () => {
    const date = new Date(2026, 1, 15, 9, 0);
    expect(matchesCron('0 9 * * *', date)).toBe(true);
  });

  it('rejects non-matching minute', () => {
    const date = new Date(2026, 1, 15, 9, 5);
    expect(matchesCron('0 9 * * *', date)).toBe(false);
  });

  it('matches day of month', () => {
    const date = new Date(2026, 0, 1, 0, 0); // Jan 1
    expect(matchesCron('0 0 1 * *', date)).toBe(true);
  });

  it('rejects wrong day of month', () => {
    const date = new Date(2026, 0, 2, 0, 0); // Jan 2
    expect(matchesCron('0 0 1 * *', date)).toBe(false);
  });

  it('matches month', () => {
    const date = new Date(2026, 5, 15, 10, 0); // June
    expect(matchesCron('0 10 * 6 *', date)).toBe(true);
  });

  it('rejects wrong month', () => {
    const date = new Date(2026, 4, 15, 10, 0); // May
    expect(matchesCron('0 10 * 6 *', date)).toBe(false);
  });

  it('matches day of week (0=Sunday)', () => {
    const date = new Date(2026, 1, 15, 0, 0); // Feb 15 2026 is Sunday
    expect(matchesCron('0 0 * * 0', date)).toBe(true);
  });

  it('matches weekdays (1-5)', () => {
    const date = new Date(2026, 1, 16, 9, 0); // Feb 16 2026 is Monday
    expect(matchesCron('0 9 * * 1-5', date)).toBe(true);
  });

  it('rejects weekend on weekday filter', () => {
    const date = new Date(2026, 1, 15, 9, 0); // Feb 15 2026 is Sunday
    expect(matchesCron('0 9 * * 1-5', date)).toBe(false);
  });

  it('matches step pattern */5 for minutes', () => {
    const date = new Date(2026, 1, 15, 10, 15);
    expect(matchesCron('*/5 * * * *', date)).toBe(true);
  });

  it('rejects non-step minute', () => {
    const date = new Date(2026, 1, 15, 10, 13);
    expect(matchesCron('*/5 * * * *', date)).toBe(false);
  });

  it('returns false for invalid expression (wrong field count)', () => {
    const date = new Date();
    expect(matchesCron('* * *', date)).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(matchesCron('', new Date())).toBe(false);
  });
});

// ── describeSchedule ────────────────────────────────────────────────────

describe('describeSchedule', () => {
  it('describes known presets by label', () => {
    expect(describeSchedule('*/5 * * * *')).toBe('Every 5 min');
    expect(describeSchedule('0 * * * *')).toBe('Every hour');
    expect(describeSchedule('0 6 * * *')).toBe('Daily at 6 AM');
  });

  it('describes every N minutes pattern', () => {
    expect(describeSchedule('*/3 * * * *')).toBe('Every 3 minutes');
  });

  it('describes hourly at specific minute', () => {
    expect(describeSchedule('15 * * * *')).toBe('Every hour at :15');
  });

  it('describes daily at specific time (AM)', () => {
    expect(describeSchedule('30 8 * * *')).toBe('Daily at 8:30 AM');
  });

  it('describes daily at specific time (PM)', () => {
    expect(describeSchedule('0 14 * * *')).toBe('Daily at 2:00 PM');
  });

  it('describes daily at midnight', () => {
    expect(describeSchedule('0 0 * * *')).toBe('Daily at 12:00 AM');
  });

  it('describes weekday schedule', () => {
    expect(describeSchedule('0 9 * * 1-5')).toBe('Weekdays at 9:00 AM');
  });

  it('describes specific day of week at time', () => {
    expect(describeSchedule('0 9 * * 1')).toBe('Every Monday');
    expect(describeSchedule('0 12 * * 6')).toBe('Saturday at noon');
    expect(describeSchedule('0 15 * * 0')).toBe('Sunday at 3:00 PM');
  });

  it('describes every N hours pattern', () => {
    expect(describeSchedule('0 */2 * * *')).toBe('Every 2 hours');
    expect(describeSchedule('0 */6 * * *')).toBe('Every 6 hours');
  });

  it('falls back to raw expression for complex patterns', () => {
    expect(describeSchedule('0 9 1,15 * *')).toBe('0 9 1,15 * *');
  });

  it('returns raw expression for invalid field count', () => {
    expect(describeSchedule('foo')).toBe('foo');
  });
});

// ── PRESETS ─────────────────────────────────────────────────────────────

describe('PRESETS', () => {
  it('is a non-empty array', () => {
    expect(PRESETS.length).toBeGreaterThan(0);
  });

  it('each preset has label and value', () => {
    for (const p of PRESETS) {
      expect(typeof p.label).toBe('string');
      expect(typeof p.value).toBe('string');
    }
  });

  it('each preset value is a valid 5-field cron expression', () => {
    for (const p of PRESETS) {
      const fields = p.value.trim().split(/\s+/);
      expect(fields).toHaveLength(5);
    }
  });

  it('has no duplicate values', () => {
    const values = PRESETS.map((p) => p.value);
    expect(new Set(values).size).toBe(values.length);
  });
});
