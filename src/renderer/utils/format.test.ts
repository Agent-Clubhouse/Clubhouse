import { describe, it, expect } from 'vitest';
import { formatDuration } from './format';

describe('formatDuration', () => {
  it('formats sub-minute durations as seconds', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(500)).toBe('1s');
    expect(formatDuration(5000)).toBe('5s');
    expect(formatDuration(59_499)).toBe('59s');
  });

  it('formats durations under an hour as minutes and seconds', () => {
    expect(formatDuration(60_000)).toBe('1m');
    expect(formatDuration(90_000)).toBe('1m 30s');
    expect(formatDuration(300_000)).toBe('5m');
    expect(formatDuration(3_599_000)).toBe('59m 59s');
  });

  it('formats durations over an hour as hours and minutes', () => {
    expect(formatDuration(3_600_000)).toBe('1h');
    expect(formatDuration(5_400_000)).toBe('1h 30m');
    expect(formatDuration(7_200_000)).toBe('2h');
    expect(formatDuration(7_380_000)).toBe('2h 3m');
  });

  it('rounds seconds correctly', () => {
    expect(formatDuration(1499)).toBe('1s');
    expect(formatDuration(1500)).toBe('2s');
  });
});
