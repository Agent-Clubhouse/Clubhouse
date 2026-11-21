import { describe, expect, it } from 'vitest';
import { contiguousNoticeFloor, coverNoticeInterval, noticeCovered, validateNoticeIntervals } from './intervals';

describe('terminal notice coverage', () => {
  it('compacts a million later terminal posts without erasing the first uncertain hole', () => {
    const ranges = coverNoticeInterval([], 2, 1_000_001);
    expect(ranges).toEqual([[2, 1_000_001]]);
    expect(contiguousNoticeFloor(ranges, 0)).toBe(0);
    expect(noticeCovered(ranges, 1)).toBe(false);
    expect(noticeCovered(ranges, 1_000_001)).toBe(true);
    expect(coverNoticeInterval(ranges, 1)).toEqual([[1, 1_000_001]]);
  });

  it('bridges multiple holes without mutating the saved input', () => {
    const saved = [[2, 3], [7, 9], [11, 15]] as const;
    expect(coverNoticeInterval(saved, 4, 11)).toEqual([[2, 15]]);
    expect(saved).toEqual([[2, 3], [7, 9], [11, 15]]);
    expect(contiguousNoticeFloor(saved, 1)).toBe(3);
    expect(contiguousNoticeFloor(saved, 6)).toBe(9);
  });

  it('preserves disjoint holes and idempotently covers an existing interior', () => {
    const saved = [[2, 3], [7, 9]] as const;
    expect(coverNoticeInterval(saved, 5)).toEqual([[2, 3], [5, 5], [7, 9]]);
    expect(coverNoticeInterval(saved, 8)).toEqual(saved);
    expect(noticeCovered(saved, 4)).toBe(false);
    expect(noticeCovered(saved, 10)).toBe(false);
  });

  it('keeps safe integer boundaries without adding past MAX_SAFE_INTEGER', () => {
    const max = Number.MAX_SAFE_INTEGER;
    const ranges = coverNoticeInterval([[max - 2, max - 1]], max);
    expect(ranges).toEqual([[max - 2, max]]);
    expect(contiguousNoticeFloor(ranges, max - 3)).toBe(max);
    expect(noticeCovered(ranges, max)).toBe(true);
  });

  it.each([null, {}, [[1]], [[2, 1]], [[1, 2], [3, 4]], [[2, 3], [1, 1]], [[-1, 2]], [[1.5, 2]], [[0, Number.MAX_SAFE_INTEGER + 1]]])('rejects corrupt persisted intervals %j', (value) => {
    expect(() => validateNoticeIntervals(value)).toThrow();
  });

  it('validates the persisted canonical form without treating gaps as covered', () => {
    expect(validateNoticeIntervals([[0, 2], [4, 8]])).toEqual([[0, 2], [4, 8]]);
    expect(() => coverNoticeInterval([], 9, 8)).toThrow();
    expect(() => noticeCovered([], NaN)).toThrow();
  });
});
