/**
 * Outcome replay for Auto's policy (#2887): fake clock, simulated plans, no
 * provider runs. Each case states its tolerance. See __fixtures__/helper-auto-replay.
 */

import { describe, expect, it } from 'vitest';
import { tieSetKey } from './helper-auto-policy';
import { DAY, HOUR, runReplay, type SimConfig } from './__fixtures__/helper-auto-replay';

const T0 = 1_800_000_000_000;
const A = 'claude-code:default';
const B = 'codex-cli:default';

const base = (over: Partial<SimConfig>): SimConfig => ({
  subscriptions: [
    { key: A, provider: 'claude-code', capacity: 100, resetsAt: T0 + 7 * DAY },
    { key: B, provider: 'codex-cli', capacity: 100, resetsAt: T0 + 7 * DAY },
  ],
  start: T0,
  end: T0 + 2 * DAY,
  tickMs: HOUR,
  arrivals: () => 1,
  work: 1,
  runMs: HOUR,
  sampleEveryMs: 0,
  ...over,
});

describe('Auto replay', () => {
  it('serial starts from zero on equal plans share evenly, and never settle on the first provider', () => {
    const r = runReplay(base({}));
    // A tie goes by the rotation; the one behind then catches up on lower use.
    expect(r.sequence.slice(0, 8)).toEqual([A, B, B, A, A, B, B, A]);
    expect(Math.abs(r.picks[A] - r.picks[B])).toBeLessThanOrEqual(1);
    // Rounding to whole percent: the plans stay within one helper's step of each other.
    expect(r.maxSpreadBp).toBeLessThanOrEqual(100);
  });

  it('equal ties differ by at most one across every complete rotation', () => {
    const r = runReplay(base({ end: T0 + 5 * DAY }));
    for (let i = 2; i <= r.sequence.length; i += 2) {
      const prefix = r.sequence.slice(0, i);
      expect(Math.abs(prefix.filter((k) => k === A).length - prefix.filter((k) => k === B).length)).toBeLessThanOrEqual(1);
    }
  });

  it('unequal plans balance their own percent used, not helper counts', () => {
    const r = runReplay(base({
      subscriptions: [
        { key: A, provider: 'claude-code', capacity: 100, resetsAt: T0 + 7 * DAY },
        { key: B, provider: 'codex-cli', capacity: 300, resetsAt: T0 + 7 * DAY },
      ],
      end: T0 + 4 * DAY,
    }));
    // B's plan is three times A's, so it takes about three of every four.
    expect(r.picks[B] / r.picks[A]).toBeGreaterThan(2.5);
    expect(r.picks[B] / r.picks[A]).toBeLessThan(3.5);
    expect(r.maxSpreadBp).toBeLessThanOrEqual(150);
  });

  it('lower measured use wins: a plan that starts ahead waits until the other catches up', () => {
    const r = runReplay(base({
      subscriptions: [
        { key: A, provider: 'claude-code', capacity: 100, resetsAt: T0 + 7 * DAY, used: 30 },
        { key: B, provider: 'codex-cli', capacity: 100, resetsAt: T0 + 7 * DAY },
      ],
    }));
    expect(r.sequence.slice(0, 30).every((k) => k === B)).toBe(true);
    expect(r.picks[A]).toBeGreaterThan(0);
  });

  describe('staggered resets', () => {
    const staggered = (basis: 'weekly_used' | 'reset_schedule') => runReplay(base({
      subscriptions: [
        { key: A, provider: 'claude-code', capacity: 100, resetsAt: T0 + 1 * DAY, used: 40 },
        { key: B, provider: 'codex-cli', capacity: 100, resetsAt: T0 + 6 * DAY, used: 40 },
      ],
      end: T0 + 1 * DAY + HOUR,
      work: 2.5,
      options: { basis },
    }));

    it('the reset schedule uses the sooner-resetting plan first, leaving less unused at its reset, and keeps the low-mark reserve', () => {
      const baseline = staggered('weekly_used');
      const schedule = staggered('reset_schedule');
      // Baseline splits the day: A resets with about 30% unused. The schedule fills A up to the low mark first.
      expect(baseline.unusedAtReset[A][0]).toBeGreaterThan(25);
      expect(schedule.unusedAtReset[A][0]).toBeLessThan(baseline.unusedAtReset[A][0] - 5);
      expect(schedule.unusedAtReset[A][0]).toBeGreaterThanOrEqual(15);
      expect(schedule.minHeadroomPercent).toBeGreaterThan(0);
      expect(Object.keys(schedule.exhaustedAt)).toEqual([]);
    });
  });

  it('a burst on stale, equal readings spreads by load', () => {
    const r = runReplay(base({ arrivals: (t) => (t === T0 ? 6 : 0), end: T0 + HOUR, sampleEveryMs: DAY }));
    expect(r.picks).toEqual({ [A]: 3, [B]: 3 });
  });

  it('a burst on unequal readings goes to the lower one: helper count never outweighs measured use', () => {
    const r = runReplay(base({
      subscriptions: [
        { key: A, provider: 'claude-code', capacity: 100, resetsAt: T0 + 7 * DAY, used: 10 },
        { key: B, provider: 'codex-cli', capacity: 100, resetsAt: T0 + 7 * DAY, used: 50 },
      ],
      arrivals: (t) => (t === T0 ? 6 : 0), end: T0 + HOUR, sampleEveryMs: DAY,
    }));
    expect(r.picks).toEqual({ [A]: 6, [B]: 0 });
  });

  it('an unreadable plan gets nothing while a measured one has headroom, then takes over at the low mark', () => {
    const r = runReplay(base({
      subscriptions: [
        { key: A, provider: 'claude-code', capacity: 100, resetsAt: T0 + 7 * DAY, used: 60 },
        { key: B, provider: 'codex-cli', capacity: 100, resetsAt: T0 + 7 * DAY, unreadable: true },
      ],
      end: T0 + 2 * DAY,
    }));
    // A takes 20 helpers to reach 80%; every later one goes to B, labeled as a fallback.
    expect(r.sequence.slice(0, 20).every((k) => k === A)).toBe(true);
    expect(r.unknownChosen).toBe(r.picks[B]);
    expect(r.reasons.unknown_fallback).toBe(r.picks[B]);
    expect(r.picks[B]).toBeGreaterThan(0);
    expect(r.minHeadroomPercent).toBeGreaterThanOrEqual(19);
  });

  it('use from outside Clubhouse shifts new helpers to the other plan', () => {
    const r = runReplay(base({
      subscriptions: [
        { key: A, provider: 'claude-code', capacity: 100, resetsAt: T0 + 7 * DAY, outsidePerHour: 1 },
        { key: B, provider: 'codex-cli', capacity: 100, resetsAt: T0 + 7 * DAY },
      ],
    }));
    expect(r.picks[B]).toBeGreaterThan(r.picks[A] * 3);
  });

  it('a provider that leaves and comes back rejoins the rotation, and nothing starves', () => {
    const r = runReplay(base({
      subscriptions: [
        { key: A, provider: 'claude-code', capacity: 100, resetsAt: T0 + 7 * DAY },
        { key: B, provider: 'codex-cli', capacity: 100, resetsAt: T0 + 7 * DAY, available: (t) => t < T0 + 6 * HOUR || t >= T0 + 12 * HOUR },
      ],
    }));
    expect(r.sequence.slice(6, 12).every((k) => k === A)).toBe(true);
    expect(r.sequence.slice(12).filter((k) => k === B).length).toBeGreaterThan(r.sequence.slice(12).length / 2);
    expect(r.maxSpreadBp).toBeLessThanOrEqual(700);
  });

  it('with every plan out, it refuses rather than picking one', () => {
    const r = runReplay(base({
      subscriptions: [
        { key: A, provider: 'claude-code', capacity: 100, resetsAt: T0 + 7 * DAY, used: 100 },
        { key: B, provider: 'codex-cli', capacity: 100, resetsAt: T0 + 7 * DAY, used: 96 },
      ],
      end: T0 + 3 * HOUR,
    }));
    expect(r.refused).toBe(3);
    expect(r.sequence).toEqual([]);
  });

  it('a restart that kept the rotation continues it; one that lost it repeats at most one turn', () => {
    const kept = runReplay(base({ end: T0 + 2 * HOUR, cursors: { [tieSetKey([A, B])]: A } }));
    expect(kept.sequence).toEqual([B, A]);
    const lost = runReplay(base({ end: T0 + 2 * HOUR }));
    expect(lost.sequence).toEqual([A, B]);
  });
});
