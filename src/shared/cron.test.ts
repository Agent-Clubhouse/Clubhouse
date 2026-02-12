import { describe, it, expect } from 'vitest';
import { matchesCron, describeSchedule } from './cron';

// Helper: create a Date for a specific minute/hour/dom/month/dow
// month is 1-based (like cron), dow: 0=Sun
function d(min: number, hour: number, dom: number, month: number, year = 2025): Date {
  // month-1 because JS Date months are 0-based
  return new Date(year, month - 1, dom, hour, min, 0);
}

describe('matchesCron', () => {
  it('matches wildcard (* * * * *) for any date', () => {
    expect(matchesCron('* * * * *', d(0, 0, 1, 1))).toBe(true);
    expect(matchesCron('* * * * *', d(30, 14, 15, 6))).toBe(true);
  });

  it('matches specific minute', () => {
    expect(matchesCron('30 * * * *', d(30, 0, 1, 1))).toBe(true);
    expect(matchesCron('30 * * * *', d(31, 0, 1, 1))).toBe(false);
  });

  it('matches specific hour', () => {
    expect(matchesCron('0 9 * * *', d(0, 9, 1, 1))).toBe(true);
    expect(matchesCron('0 9 * * *', d(0, 10, 1, 1))).toBe(false);
  });

  it('matches specific day-of-month', () => {
    expect(matchesCron('0 0 15 * *', d(0, 0, 15, 1))).toBe(true);
    expect(matchesCron('0 0 15 * *', d(0, 0, 14, 1))).toBe(false);
  });

  it('matches specific month', () => {
    expect(matchesCron('0 0 1 6 *', d(0, 0, 1, 6))).toBe(true);
    expect(matchesCron('0 0 1 6 *', d(0, 0, 1, 7))).toBe(false);
  });

  it('matches day-of-week', () => {
    // Jan 6 2025 is a Monday (dow=1)
    const monday = new Date(2025, 0, 6, 9, 0, 0);
    expect(matchesCron('0 9 * * 1', monday)).toBe(true);
    expect(matchesCron('0 9 * * 0', monday)).toBe(false);
  });

  it('handles step expressions (*/15)', () => {
    expect(matchesCron('*/15 * * * *', d(0, 0, 1, 1))).toBe(true);
    expect(matchesCron('*/15 * * * *', d(15, 0, 1, 1))).toBe(true);
    expect(matchesCron('*/15 * * * *', d(30, 0, 1, 1))).toBe(true);
    expect(matchesCron('*/15 * * * *', d(45, 0, 1, 1))).toBe(true);
    expect(matchesCron('*/15 * * * *', d(7, 0, 1, 1))).toBe(false);
    expect(matchesCron('*/15 * * * *', d(22, 0, 1, 1))).toBe(false);
  });

  it('handles comma-separated values', () => {
    expect(matchesCron('0,30 * * * *', d(0, 0, 1, 1))).toBe(true);
    expect(matchesCron('0,30 * * * *', d(30, 0, 1, 1))).toBe(true);
    expect(matchesCron('0,30 * * * *', d(15, 0, 1, 1))).toBe(false);
  });

  it('handles ranges (1-5)', () => {
    expect(matchesCron('* * * * 1-5', d(0, 0, 6, 1))).toBe(true);  // Jan 6 2025 = Mon
    expect(matchesCron('* * * * 1-5', d(0, 0, 5, 1))).toBe(false);  // Jan 5 2025 = Sun
  });

  it('handles range with step (1-30/10)', () => {
    expect(matchesCron('1-30/10 * * * *', d(1, 0, 1, 1))).toBe(true);
    expect(matchesCron('1-30/10 * * * *', d(11, 0, 1, 1))).toBe(true);
    expect(matchesCron('1-30/10 * * * *', d(21, 0, 1, 1))).toBe(true);
    expect(matchesCron('1-30/10 * * * *', d(31, 0, 1, 1))).toBe(false);
    expect(matchesCron('1-30/10 * * * *', d(5, 0, 1, 1))).toBe(false);
  });

  it('handles combined fields', () => {
    // 9:30 AM on weekdays
    const monday930 = new Date(2025, 0, 6, 9, 30, 0);
    expect(matchesCron('30 9 * * 1-5', monday930)).toBe(true);
    // Sunday 9:30 should not match
    const sunday930 = new Date(2025, 0, 5, 9, 30, 0);
    expect(matchesCron('30 9 * * 1-5', sunday930)).toBe(false);
  });

  it('rejects invalid expressions (wrong number of fields)', () => {
    expect(matchesCron('* * *', d(0, 0, 1, 1))).toBe(false);
    expect(matchesCron('', d(0, 0, 1, 1))).toBe(false);
    expect(matchesCron('* * * * * *', d(0, 0, 1, 1))).toBe(false);
  });

  it('handles every-minute expression', () => {
    expect(matchesCron('*/1 * * * *', d(0, 0, 1, 1))).toBe(true);
    expect(matchesCron('*/1 * * * *', d(37, 14, 20, 8))).toBe(true);
  });
});

describe('describeSchedule', () => {
  it('returns known preset descriptions', () => {
    expect(describeSchedule('*/15 * * * *')).toBe('Every 15 minutes');
    expect(describeSchedule('*/30 * * * *')).toBe('Every 30 minutes');
    expect(describeSchedule('0 * * * *')).toBe('Every hour');
    expect(describeSchedule('0 */6 * * *')).toBe('Every 6 hours');
    expect(describeSchedule('0 0 * * *')).toBe('Daily at midnight');
    expect(describeSchedule('0 9 * * *')).toBe('Daily at 9 AM');
    expect(describeSchedule('0 9 * * 1')).toBe('Weekly on Monday at 9 AM');
  });

  it('describes custom time expressions', () => {
    const desc = describeSchedule('30 14 * * *');
    expect(desc).toContain('14');
    expect(desc).toContain('30');
  });

  it('mentions day-of-week when specified', () => {
    const desc = describeSchedule('0 9 * * 1,3,5');
    expect(desc).toContain('Mon');
    expect(desc).toContain('Wed');
    expect(desc).toContain('Fri');
  });

  it('returns error for invalid expression', () => {
    expect(describeSchedule('bad')).toBe('Invalid cron expression');
  });
});
