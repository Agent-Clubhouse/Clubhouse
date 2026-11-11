import { describe, expect, it } from 'vitest';
import type { DecisionQuota } from '../../shared/telemetry/helper-usage-contract';
import type { QuotaView } from '../../shared/helper-routing';
import {
  AUTO_FORECAST_HALF_LIFE_MS, AUTO_FORECAST_RETENTION_MS, burnForecastKey, observeHelperBurn, predictHelperBurn,
  readBurnForecast, readBurnObservation, type ForecastEntry,
} from './helper-auto-forecast';

const NOW = 1_800_000_000_000;
const RESET = NOW + 86_400_000;
const entry = (over: Partial<ForecastEntry> = {}): ForecastEntry => ({
  decisionId: 'd', decidedAtMs: NOW, provider: 'claude-code', model: 'opus', effort: 'high',
  difficulty: 'hard', mappingRevision: 'r1.0', spawn: 'started', ...over,
});
const baseline = (over: Partial<DecisionQuota> = {}): DecisionQuota => ({
  state: 'known', source: 'cli_query', quality: 'fresh', asOfMs: NOW - 1000,
  windows: [{ name: 'weekly', usedBp: 1000, resetsAtMs: RESET }, { name: 'fiveHour', usedBp: 2000, resetsAtMs: RESET }],
  ...over,
});
const quota = (over: Partial<QuotaView> = {}): QuotaView => ({
  state: 'known', source: 'cli_query', asOf: new Date(NOW + 2000).toISOString(),
  weekly: { usedPercent: 12, resetsAt: new Date(RESET).toISOString() },
  fiveHour: { usedPercent: 23, resetsAt: new Date(RESET).toISOString() }, ...over,
});
const completed = (): ForecastEntry => {
  const e = entry();
  e.forecast = predictHelperBurn(e, [], NOW, baseline());
  e.forecastRun = { startedMs: NOW, endedMs: NOW + 1000, usageSamples: 1, usable: true };
  return e;
};
const history = (values: number[]): ForecastEntry[] => values.map((value, i) => {
  const e = entry({ decisionId: `d${i}` });
  e.forecast = predictHelperBurn(e, [], NOW - 10_000);
  e.burnObservation = { atMs: NOW - 1000 + i, attribution: 'whole_login_unknown', reason: 'observed', weekly: { observedBp: value } };
  return e;
});

describe('recorded burn forecasts', () => {
  it('is unknown until the minimum cohort, then uses a median without inventing a missing window', () => {
    const samples = history([100, 300, 200, 200, 900]);
    expect(predictHelperBurn(entry(), samples.slice(0, 4), NOW).weekly).toEqual({ samples: 4 });
    expect(predictHelperBurn(entry(), samples, NOW)).toMatchObject({ weekly: { samples: 5, expectedBp: 200 }, fiveHour: { samples: 0 } });
    expect(predictHelperBurn(entry(), history([0, 0, 0, 0, 0]), NOW).weekly.expectedBp).toBe(0);
  });

  it.each([
    { provider: 'codex-cli' }, { model: 'claude-opus-5-5' }, { effort: 'medium' }, { difficulty: 'easy' as const },
    { mappingRevision: 'r2.0' }, { taskProfile: 'small' as const }, { model: null }, { mappingRevision: undefined },
  ])('does not transfer calibration across changed or missing identities: %j', (change) => {
    expect(predictHelperBurn(entry(change), history([100, 100, 100, 100, 100]), NOW).weekly).toEqual({ samples: 0 });
  });

  it('keeps observations chronological, bounded and recent, with a recency-weighted median', () => {
    const old = history(Array(10).fill(100)).map((e) => ({
      ...e, decisionId: `old-${e.decisionId}`, burnObservation: { ...e.burnObservation!, atMs: NOW - 3 * AUTO_FORECAST_HALF_LIFE_MS },
    }));
    const recent = history(Array(5).fill(300));
    expect(predictHelperBurn(entry(), [...old, ...recent], NOW).weekly.expectedBp).toBe(300);
    expect(predictHelperBurn(entry(), old.map((e) => ({
      ...e, burnObservation: { ...e.burnObservation!, atMs: NOW - AUTO_FORECAST_RETENTION_MS - 1 },
    })), NOW).weekly).toEqual({ samples: 0 });
    expect(predictHelperBurn(entry(), recent.map((e) => ({
      ...e, burnObservation: { ...e.burnObservation!, atMs: NOW },
    })), NOW).weekly).toEqual({ samples: 0 });
    expect(predictHelperBurn(entry(), history(Array(100).fill(200)), NOW).weekly.samples).toBe(32);
    const repeated = history([100])[0];
    expect(predictHelperBurn(entry(), Array(5).fill(repeated), NOW).weekly).toEqual({ samples: 1 });
    const thin = [...old.slice(0, 4), ...recent.slice(0, 1)];
    expect(predictHelperBurn(entry(), thin, NOW).weekly).toEqual({ samples: 5 });
  });

  it('records signed errors against an interval proxy, leaving its immutable prediction unchanged', () => {
    const e = completed();
    e.forecast = predictHelperBurn(e, history([100, 100, 100, 100, 100]), NOW, baseline());
    const prediction = structuredClone(e.forecast);
    const observed = observeHelperBurn(e, [e], quota());
    expect(observed).toMatchObject({
      attribution: 'whole_login_unknown', reason: 'observed', weekly: { observedBp: 200, errorBp: 100 }, fiveHour: { observedBp: 300 },
    });
    expect(observed?.fiveHour).not.toHaveProperty('errorBp');
    expect(e.forecast).toEqual(prediction);
    e.burnObservation = observed;
    expect(observeHelperBurn(e, [e], quota())).toBeUndefined();
  });

  it('waits for a fresh quota timestamp after completion and never measures a running helper', () => {
    const e = completed();
    expect(observeHelperBurn(e, [e], quota({ asOf: new Date(NOW).toISOString() }))).toBeUndefined();
    expect(observeHelperBurn(e, [e], quota({ state: 'unknown' }))).toBeUndefined();
    delete e.forecastRun!.endedMs;
    expect(observeHelperBurn(e, [e], quota())).toBeUndefined();
  });

  it('rejects reset crossings, decreasing readings, incomplete usage and overlapping starts', () => {
    const e = completed();
    expect(observeHelperBurn(e, [e], quota({ fiveHour: { usedPercent: 1, resetsAt: new Date(RESET + 1000).toISOString() } })))
      .toEqual({ atMs: NOW + 2000, attribution: 'whole_login_unknown', reason: 'reset' });
    expect(observeHelperBurn(e, [e], quota({ fiveHour: { usedPercent: 19, resetsAt: new Date(RESET).toISOString() } })))
      .toEqual({ atMs: NOW + 2000, attribution: 'whole_login_unknown', reason: 'decreased' });
    expect(observeHelperBurn(e, [e, entry({ decisionId: 'other', decidedAtMs: NOW + 1 })], quota())).toMatchObject({ reason: 'overlap' });
    expect(observeHelperBurn(e, [e, entry({ provider: 'codex-cli', decisionId: 'other' })], quota())).toMatchObject({ reason: 'observed' });
    e.forecastRun!.usable = false;
    expect(observeHelperBurn(e, [e], quota())).toMatchObject({ reason: 'incomplete' });
  });

  it('cannot fabricate burn from missing, stale or resetless baselines', () => {
    const e = completed();
    for (const b of [undefined, baseline({ quality: 'stale' }), baseline({ asOfMs: NOW - 16 * 60_000 }), baseline({ windows: [{ name: 'weekly', usedBp: 1000 }] })]) {
      e.forecast = predictHelperBurn(e, [], NOW, b);
      expect(observeHelperBurn(e, [e], quota())).toMatchObject({ reason: 'missing_baseline' });
    }
  });

  it('reads only closed, finite persisted shapes without carrying extra content', () => {
    const e = completed();
    expect(readBurnForecast({ ...e.forecast, prompt: 'not retained' })).toEqual(e.forecast);
    expect(readBurnForecast({ ...e.forecast, weekly: { samples: 5, expectedBp: NaN } })).toBeUndefined();
    expect(readBurnObservation({ atMs: NOW, attribution: 'whole_login_unknown', reason: 'invented' })).toBeUndefined();
    expect(burnForecastKey(entry({ model: null }))).toBeNull();
  });
});
