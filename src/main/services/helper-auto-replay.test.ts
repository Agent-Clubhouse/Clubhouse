/**
 * Outcome replay for Auto's policy (#2887): fake clock, simulated plans, no
 * provider runs. Each case states its tolerance. See __fixtures__/helper-auto-replay.
 */

import { describe, expect, it } from 'vitest';
import { tieSetKey } from './helper-auto-policy';
import { DAY, HOUR, forecastReplayFixture, runForecastReplay, runReplay, type SimConfig } from './__fixtures__/helper-auto-replay';

const T0 = 1_800_000_000_000;
const A = 'claude-code:default';
const B = 'codex-cli:default';
const C = 'copilot-cli:default';

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
  it('is byte-for-byte identical with shadow forecasts off across bursts, resets and outside use', () => {
    const config = base({
      subscriptions: [
        { key: A, provider: 'claude-code', capacity: 100, resetsAt: T0 + DAY, outsidePerHour: 1 },
        { key: B, provider: 'codex-cli', capacity: 300, resetsAt: T0 + 6 * DAY },
        { key: C, provider: 'copilot-cli', capacity: 100, resetsAt: T0 + 7 * DAY, unreadable: true, unknownReason: 'not_supported' },
      ],
      arrivals: (t) => t === T0 ? 6 : 1,
    });
    const baseline = JSON.stringify(runReplay(config));
    const withPredictions = { ...config, subscriptions: config.subscriptions.map((s, i) => ({ ...s, expectedBurnBp: i === 0 ? 9000 : 0 })) };
    expect(JSON.stringify(runReplay(withPredictions))).toBe(baseline);
    expect(JSON.stringify(runReplay({ ...withPredictions, options: { useBurnForecasts: false } }))).toBe(baseline);
  });

  it('serial starts from zero on equal plans share evenly, and never settle on the first provider', () => {
    const r = runReplay(base({}));
    // A tie goes by the rotation; the one behind then catches up on lower use.
    expect(r.sequence.slice(0, 8)).toEqual([A, B, B, A, A, B, B, A]);
    expect(Math.abs(r.picks[A] - r.picks[B])).toBeLessThanOrEqual(1);
    // Rounding to whole percent: the plans stay within one helper's step of each other.
    expect(r.maxSpreadBp).toBeLessThanOrEqual(100);
  });

  describe('Stage 3 chronological calibration replay', () => {
    it('reports zero held-out error per exact provider/model/effort/revision key on stationary fixtures', () => {
      const replay = runForecastReplay([
        ...forecastReplayFixture(T0, Array(8).fill(100)),
        ...forecastReplayFixture(T0, Array(8).fill(300), { provider: 'codex-cli', model: 'gpt-6.1-sol' }),
      ].reverse());
      expect(Object.keys(replay.calibration)).toHaveLength(4);
      for (const report of Object.values(replay.calibration)) {
        expect(report).toEqual({ decisions: 8, unknown: 5, evaluated: 3, excluded: 0, maeBp: 0, biasBp: 0 });
      }
    });

    it('reports outside bursts as proxy error, not attributed helper consumption, with no future leakage', () => {
      const replay = runForecastReplay(forecastReplayFixture(T0, [100, 100, 100, 100, 100, 700]));
      for (const report of Object.values(replay.calibration)) {
        expect(report).toMatchObject({ unknown: 5, evaluated: 1, maeBp: 600, biasBp: 600 });
      }
      expect(replay.entries[5].burnObservation?.attribution).toBe('whole_login_unknown');
      expect(replay.entries.slice(0, 5).every((e) => e.forecast?.weekly.expectedBp === undefined)).toBe(true);
    });

    it('a delayed quota sample cannot train a decision already made, and sparse or changed mappings stay unknown', () => {
      const fixture = forecastReplayFixture(T0, Array(6).fill(100));
      const delayed = fixture.find((e) => e.type === 'quota' && e.atMs === T0 + 4.5 * HOUR)!;
      delayed.atMs += HOUR;
      const replay = runForecastReplay(fixture);
      expect(replay.entries[5].forecast?.weekly.expectedBp).toBeUndefined();
      const changed = runForecastReplay([
        ...forecastReplayFixture(T0, Array(5).fill(100)),
        ...forecastReplayFixture(T0 + 10 * HOUR, [100], { mappingRevision: 'r2.0' }),
      ]);
      expect(changed.entries.at(-1)?.forecast?.weekly).toEqual({ samples: 0 });
    });

    it('reports resets and incomplete usage as excluded intervals without inventing calibration errors', () => {
      const fixture = forecastReplayFixture(T0, Array(7).fill(100));
      const reset = fixture.find((e) => e.type === 'quota' && e.atMs === T0 + 5.5 * HOUR)!;
      if (reset.type !== 'quota') throw new Error('Expected quota fixture');
      reset.quota.weekly!.resetsAt = new Date(T0 + 14 * DAY).toISOString();
      const incomplete = fixture.find((e) => e.type === 'decision' && e.atMs === T0 + 6 * HOUR)!;
      if (incomplete.type !== 'decision') throw new Error('Expected decision fixture');
      incomplete.entry.forecastRun!.usable = false;
      const replay = runForecastReplay(fixture);
      expect(replay.entries[5].burnObservation?.reason).toBe('reset');
      expect(replay.entries[6].burnObservation?.reason).toBe('incomplete');
      for (const report of Object.values(replay.calibration)) {
        expect(report).toEqual({ decisions: 7, unknown: 5, evaluated: 0, excluded: 2 });
      }
    });
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

  it('keeps Copilot last through headroom and low readings, then falls back at near-limit', () => {
    const r = runReplay(base({
      subscriptions: [
        { key: A, provider: 'claude-code', capacity: 100, resetsAt: T0 + 7 * DAY, used: 78 },
        { key: B, provider: 'codex-cli', capacity: 100, resetsAt: T0 + 7 * DAY, used: 100 },
        { key: C, provider: 'copilot-cli', capacity: 100, resetsAt: T0 + 7 * DAY, unreadable: true, unknownReason: 'not_supported' },
      ],
      end: T0 + DAY,
    }));
    expect(r.sequence.slice(0, 17)).toEqual(Array(17).fill(A));
    expect(r.sequence.slice(17)).toEqual(Array(7).fill(C));
    expect(r.reasons.last_resort_unmeasured).toBe(7);
    expect(r.unknownChosen).toBe(7);
    expect(r.refused).toBe(0);
  });

  it('a temporarily unreadable provider stays ahead of Copilot, and Copilot takes over while it is unavailable', () => {
    const r = runReplay(base({
      subscriptions: [
        { key: A, provider: 'claude-code', capacity: 100, resetsAt: T0 + 7 * DAY, unreadable: true, available: (t) => t < T0 + 3 * HOUR },
        { key: C, provider: 'copilot-cli', capacity: 100, resetsAt: T0 + 7 * DAY, unreadable: true, unknownReason: 'not_supported' },
      ],
      end: T0 + 6 * HOUR,
    }));
    expect(r.sequence).toEqual([A, A, A, C, C, C]);
    expect(r.reasons.last_resort_unmeasured).toBe(3);
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

  it('restarts that lost the rotation, whatever they restored, leave ties within R + 1', () => {
    const C = 'claude-code:work';
    const three = [
      { key: A, provider: 'claude-code', capacity: 100, resetsAt: T0 + 7 * DAY, unreadable: true },
      { key: B, provider: 'codex-cli', capacity: 100, resetsAt: T0 + 7 * DAY, unreadable: true },
      { key: C, provider: 'claude-code', capacity: 100, resetsAt: T0 + 7 * DAY, unreadable: true },
    ];
    const setKey = tieSetKey([A, B, C]);
    // What each restart found on disk: nothing, a stale cursor, the same stale one again, an evicted set.
    const restored: Array<Record<string, string> | undefined> = [undefined, { [setKey]: B }, { [setKey]: B }, {}, { [setKey]: C }];
    const lengths = [4, 5, 2, 7, 3];
    const totals: Record<string, number> = { [A]: 0, [B]: 0, [C]: 0 };
    let start = T0;
    restored.forEach((cursors, run) => {
      const r = runReplay(base({ subscriptions: three, start, end: start + lengths[run] * HOUR, ...(cursors && { cursors }) }));
      const counts = Object.values(r.picks);
      // Within a run: a round robin from wherever it started.
      expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
      for (const [key, n] of Object.entries(r.picks)) totals[key] += n;
      const all = Object.values(totals);
      expect(Math.max(...all) - Math.min(...all)).toBeLessThanOrEqual(run + 1);
      start += lengths[run] * HOUR;
    });
  });

  it('with two tied, a restart that kept the rotation continues it, and one that lost it starts from the first', () => {
    const kept = runReplay(base({ end: T0 + 2 * HOUR, cursors: { [tieSetKey([A, B])]: A } }));
    expect(kept.sequence).toEqual([B, A]);
    const lost = runReplay(base({ end: T0 + 2 * HOUR }));
    expect(lost.sequence).toEqual([A, B]);
  });
});
