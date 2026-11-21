/** Closed terminal-coverage ranges. Covered means accepted OR scan-time excluded. */
export type NoticeInterval = readonly [number, number];

export function noticeSequence(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid notice sequence');
  return value;
}

/** Validate the canonical persisted form, rather than silently repairing corrupt state. */
export function validateNoticeIntervals(value: unknown): NoticeInterval[] {
  if (!Array.isArray(value)) throw new Error('Invalid notice coverage');
  const result: NoticeInterval[] = [];
  for (const range of value) {
    if (!Array.isArray(range) || range.length !== 2) throw new Error('Invalid notice interval');
    const lo = noticeSequence(range[0]);
    const hi = noticeSequence(range[1]);
    const prior = result[result.length - 1];
    if (lo > hi || (prior && lo - prior[1] <= 1)) throw new Error('Noncanonical notice intervals');
    result.push([lo, hi]);
  }
  return result;
}

export function noticeCovered(ranges: readonly NoticeInterval[], seq: number): boolean {
  noticeSequence(seq);
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const mid = low + Math.floor((high - low) / 2);
    const [start, end] = ranges[mid];
    if (seq < start) high = mid - 1;
    else if (seq > end) low = mid + 1;
    else return true;
  }
  return false;
}

/** Merge even ABOVE an uncertain hole; no per-post retained terminal rows. */
export function coverNoticeInterval(ranges: readonly NoticeInterval[], start: number, end = start): NoticeInterval[] {
  noticeSequence(start); noticeSequence(end);
  if (end < start) throw new Error('Reversed notice interval');
  const result: NoticeInterval[] = [];
  let inserted = false;
  for (const [lo, hi] of ranges) {
    if (hi < start && start - hi > 1) result.push([lo, hi]);
    else if (end < lo && lo - end > 1) {
      if (!inserted) { result.push([start, end]); inserted = true; }
      result.push([lo, hi]);
    } else {
      start = Math.min(start, lo);
      end = Math.max(end, hi);
    }
  }
  if (!inserted) result.push([start, end]);
  return result;
}

/** Baseline is inherited coverage, not a newly observed delivery receipt. */
export function contiguousNoticeFloor(ranges: readonly NoticeInterval[], baseline: number): number {
  noticeSequence(baseline);
  let floor = baseline;
  for (const [lo, hi] of ranges) {
    if (lo > floor && lo - floor > 1) break;
    floor = Math.max(floor, hi);
  }
  return floor;
}
