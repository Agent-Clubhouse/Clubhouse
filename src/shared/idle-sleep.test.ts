import { describe, it, expect } from 'vitest';
import { formatIdleMinutes, normalizeIdleSleep, resolveIdleSleep } from './idle-sleep';

describe('per-agent auto-sleep (#2143)', () => {
  it('treats unset or malformed values as inherit', () => {
    expect(normalizeIdleSleep(undefined)).toBe('inherit');
    expect(normalizeIdleSleep(null)).toBe('inherit');
    expect(normalizeIdleSleep('inherit')).toBe('inherit');
    expect(normalizeIdleSleep(0)).toBe('inherit');
    expect(normalizeIdleSleep(-5)).toBe('inherit');
    expect(normalizeIdleSleep(Number.NaN)).toBe('inherit');
    expect(normalizeIdleSleep('15')).toBe('inherit');
    expect(normalizeIdleSleep('never')).toBe('never');
    expect(normalizeIdleSleep(45.4)).toBe(45);
  });

  it('resolves agent over app', () => {
    expect(resolveIdleSleep(undefined, 30)).toEqual({ minutes: 30, source: 'app' });
    expect(resolveIdleSleep('inherit', 0)).toEqual({ minutes: 0, source: 'app' });
    expect(resolveIdleSleep(15, 30)).toEqual({ minutes: 15, source: 'agent' });
    expect(resolveIdleSleep(240, 0)).toEqual({ minutes: 240, source: 'agent' });
    expect(resolveIdleSleep('never', 30)).toEqual({ minutes: 0, source: 'agent' });
    expect(resolveIdleSleep(undefined, Number.NaN)).toEqual({ minutes: 0, source: 'app' });
  });

  it('formats minutes', () => {
    expect(formatIdleMinutes(15)).toBe('15 min');
    expect(formatIdleMinutes(60)).toBe('1 h');
    expect(formatIdleMinutes(240)).toBe('4 h');
    expect(formatIdleMinutes(90)).toBe('90 min');
    expect(formatIdleMinutes(0)).toBe('Never');
  });
});
