import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_PRESETS,
  HELPER_DIFFICULTIES,
  HELPER_ROUTING_FALLBACKS,
  HELPER_ROUTING_LABELS,
  HELPER_ROUTING_REASONS,
  PRESET_CELL_STATES,
  PRESET_PROVIDERS,
  QUOTA_REFETCH_FLOOR_SECONDS,
  QUOTA_STALE_MS,
  classifyQuota,
  describeRouting,
  isPresetModel,
  minimalRouting,
  normalizeSavedPresets,
  quotaRefetchDelaySeconds,
  routingLabel,
  type HelperRouting,
  type QuotaWindow,
} from './helper-routing';

const routing: HelperRouting = {
  mode: 'preset', balanced: false, decidedAt: '2026-11-01T00:00:00.000Z', policyVersion: 1, fallback: 'none', context: { status: 'none' },
  requested: { provider: null, model: null, effort: null, difficulty: 'hard' },
  resolved: { provider: 'codex-cli', model: 'gpt-6.1-sol', effort: 'high', difficulty: 'hard' },
  source: { provider: 'orchestrator', model: 'builtin_mapping', effort: 'builtin_mapping' },
  reason: 'preset_on_cli',
};

describe('helper routing', () => {
  it('has a built-in for every provider and difficulty, and only the agreed values', () => {
    for (const provider of PRESET_PROVIDERS) {
      for (const difficulty of HELPER_DIFFICULTIES) expect(isPresetModel(BUILTIN_PRESETS[provider][difficulty].model)).toBe(true);
    }
    expect(BUILTIN_PRESETS).toEqual({
      'claude-code': { easy: { model: 'haiku', effort: 'low' }, medium: { model: 'sonnet', effort: 'medium' }, hard: { model: 'opus', effort: 'high' } },
      'codex-cli': { easy: { model: 'gpt-6-luna', effort: 'low' }, medium: { model: 'gpt-6.1-terra', effort: 'medium' }, hard: { model: 'gpt-6.1-sol', effort: 'high' } },
    });
  });

  it('keeps only valid stored cells', () => {
    expect(normalizeSavedPresets({
      'claude-code': { hard: { model: 'opus', effort: 'max' }, easy: { model: 'has space', effort: 'low' }, nope: { model: 'opus' } },
      'codex-cli': { easy: { model: 'x', effort: 'BAD;' }, hard: { model: 'y' } },
      'copilot-cli': { easy: { model: 'x', effort: null } },
    })).toEqual({ 'claude-code': { hard: { model: 'opus', effort: 'max' } }, 'codex-cli': { hard: { model: 'y', effort: null } } });
    for (const raw of [null, 'x', [], 3]) expect(normalizeSavedPresets(raw)).toEqual({});
  });

  it('accepts ids a CLI lists, and nothing that could be an argument or shell syntax', () => {
    for (const ok of ['opus', 'opus[1m]', 'gpt-6.1-sol', 'claude-opus-5-5', 'default']) expect(isPresetModel(ok)).toBe(true);
    for (const bad of ['', '-c', 'a b', 'x;y', '$(x)', 'a'.repeat(129), 3, null]) expect(isPresetModel(bad)).toBe(false);
  });

  it('has words for every advertised code, and a generic line for one it doesn\'t know', () => {
    for (const code of HELPER_ROUTING_REASONS) expect(HELPER_ROUTING_LABELS.reason[code]).toBeTruthy();
    for (const code of HELPER_ROUTING_FALLBACKS) expect(HELPER_ROUTING_LABELS.fallback[code]).toBeTruthy();
    for (const code of PRESET_CELL_STATES) expect(HELPER_ROUTING_LABELS.cell[code]).toBeTruthy();
    expect(routingLabel('reason', 'from_the_future')).toBe(HELPER_ROUTING_LABELS.generic.unknownCode);
  });

  it('never words unknown quota as available, or claims more than it knows', () => {
    expect(HELPER_ROUTING_LABELS.quota.unknown).toBe('Unknown');
    const words = JSON.stringify(HELPER_ROUTING_LABELS).toLowerCase();
    for (const claim of ['cheapest', 'best', 'optimal', 'guaranteed', 'verified capacity']) expect(words).not.toContain(claim);
  });

  it('has words for every source of the Auto setting, and no label calls unknown quota healthy', () => {
    for (const source of ['agent', 'project', 'app', 'default', 'mcp_off', 'dispatcher_locked'] as const) expect(HELPER_ROUTING_LABELS.autoSource[source]).toBeTruthy();
    expect(JSON.stringify(HELPER_ROUTING_LABELS).toLowerCase()).not.toContain('healthy');
  });

  it('the snapshot form is codes only', () => {
    expect(minimalRouting(routing)).toEqual({ mode: 'preset', difficulty: 'hard', provider: 'codex-cli', model: 'gpt-6.1-sol', effort: 'high', reason: 'preset_on_cli' });
  });

  it('says what a helper runs on and why', () => {
    expect(describeRouting(routing)).toBe('gpt-6.1-sol, high effort. From the helper settings for this difficulty.');
    expect(describeRouting({ ...routing, resolved: { ...routing.resolved, model: null, effort: null }, reason: 'explicit_request' }))
      .toBe('its default model. You or the orchestrator chose this.');
  });

  it('the built-in Orchestrator block makes no claims of cost or preference', () => {
    // The text comes from the maintainer's builder (#2902), so check what it must not say, not its wording.
    const text = fs.readFileSync(path.join(__dirname, '../main/services/managed-agents/builtin-text/orchestrator.md'), 'utf8');
    expect(text).toContain('difficulty');
    expect(text).toContain('cli: "auto"');
    expect(text).not.toMatch(/\b(cheap|cheaper|cheapest|best provider|preferred provider|free tier)\b/i);
  });
});

describe('classifyQuota', () => {
  const NOW = 1_800_000_000_000;
  const week = (usedPercent?: number, extra: object = {}): QuotaWindow => ({ name: 'week', ...(usedPercent !== undefined && { usedPercent }), resetsAt: NOW + 1000, asOf: NOW, ...extra });
  const hours = (usedPercent?: number, extra: object = {}): QuotaWindow => ({ name: '5h', ...(usedPercent !== undefined && { usedPercent }), resetsAt: NOW + 500, asOf: NOW, ...extra });

  it.each([
    [0, 'known'], [79, 'known'], [80, 'low'], [94, 'low'], [95, 'near_limit'], [100, 'near_limit'],
  ])('%i%% used is %s, and used percent alone is never exhausted', (used, state) => {
    expect(classifyQuota([week(used)], NOW).state).toBe(state);
  });

  it('exhausted only when the provider says so, at any percent', () => {
    expect(classifyQuota([week(10, { limitReached: true })], NOW)).toMatchObject({ state: 'exhausted', limitingWindow: 'weekly' });
    expect(classifyQuota([week(undefined, { limitReached: true })], NOW).state).toBe('exhausted');
  });

  it('the reported limit decides, with its own window and reset, over a fuller one', () => {
    expect(classifyQuota([week(90), hours(10, { limitReached: true })], NOW)).toMatchObject({ state: 'exhausted', limitingWindow: 'fiveHour', resetsAt: new Date(NOW + 500).toISOString() });
  });

  it('the most constrained window sets the state, and the reset comes from that window', () => {
    expect(classifyQuota([week(41), hours(85)], NOW)).toMatchObject({
      state: 'low', limitingWindow: 'fiveHour', resetsAt: new Date(NOW + 500).toISOString(),
      weekly: { usedPercent: 41 }, fiveHour: { usedPercent: 85 },
    });
  });

  it('a tie goes to the later reset', () => {
    expect(classifyQuota([hours(50), week(50)], NOW).limitingWindow).toBe('weekly');
  });

  it('an unreadable window lets the other decide, and is recorded', () => {
    expect(classifyQuota([week(41), hours()], NOW)).toMatchObject({ state: 'known', limitingWindow: 'weekly', unreadableWindows: ['fiveHour'] });
  });

  it('nothing readable is unknown, never a number', () => {
    expect(classifyQuota([week(), hours()], NOW)).toMatchObject({ state: 'unknown', unknownReason: 'read_failed' });
    expect(classifyQuota([], NOW)).toMatchObject({ state: 'unknown' });
  });

  it('a plan with no five-hour window isn\'t a missing reading', () => {
    const view = classifyQuota([week(41)], NOW);
    expect(view.fiveHour).toBeNull();
    expect(view).not.toHaveProperty('unreadableWindows');
  });

  it('a window past its reset says nothing', () => {
    expect(classifyQuota([week(99, { resetsAt: NOW - 1 }), hours(10)], NOW)).toMatchObject({ state: 'known', limitingWindow: 'fiveHour' });
  });

  it('a reading older than 15 minutes is stale, keeping its asOf', () => {
    const old = NOW - QUOTA_STALE_MS - 1;
    expect(classifyQuota([week(10, { asOf: old })], NOW)).toMatchObject({ state: 'unknown', unknownReason: 'stale', asOf: new Date(old).toISOString() });
    expect(classifyQuota([week(10, { asOf: NOW - QUOTA_STALE_MS })], NOW).state).toBe('known');
  });

  it('asOf is the oldest reading that counted', () => {
    expect(classifyQuota([week(10, { asOf: NOW - 60_000 }), hours(10)], NOW).asOf).toBe(new Date(NOW - 60_000).toISOString());
  });

  it('a model\'s limit is shown but only counts when that model is chosen, by exact name', () => {
    const windows = [week(10), { name: 'week:Fable', usedPercent: 99, resetsAt: NOW + 1000, asOf: NOW }, { name: 'week_opus', usedPercent: 96, asOf: NOW }];
    expect(classifyQuota(windows, NOW)).toMatchObject({
      state: 'known', limitingWindow: 'weekly',
      modelWindows: [{ name: 'Fable', usedPercent: 99 }, { name: 'opus', usedPercent: 96 }],
    });
    expect(classifyQuota(windows, NOW, { model: 'Fable' })).toMatchObject({ state: 'near_limit', limitingWindow: 'model:Fable' });
    expect(classifyQuota(windows, NOW, { model: 'opus' })).toMatchObject({ state: 'near_limit', limitingWindow: 'model:opus' });
    expect(classifyQuota(windows, NOW, { model: 'fable' }).state).toBe('near_limit');
    expect(classifyQuota(windows, NOW, { model: 'sonnet' }).state).toBe('known');
  });

  it('another duration still counts, named other', () => {
    expect(classifyQuota([{ name: '1d', usedPercent: 85, asOf: NOW }, week(10)], NOW)).toMatchObject({ state: 'low', limitingWindow: 'other' });
  });
});

describe('quotaRefetchDelaySeconds', () => {
  const after = (refreshAfterSeconds?: number) => ({ quota: { ...(refreshAfterSeconds !== undefined && { refreshAfterSeconds }) } });

  it('takes the soonest provider', () => {
    expect(quotaRefetchDelaySeconds({ a: after(300), b: after(60) })).toBe(60);
  });

  it('a 0, or anything under the floor, waits the floor, so a client can\'t spin', () => {
    expect(quotaRefetchDelaySeconds({ a: after(0), b: after(300) })).toBe(QUOTA_REFETCH_FLOOR_SECONDS);
    expect(quotaRefetchDelaySeconds({ a: after(3) })).toBe(QUOTA_REFETCH_FLOOR_SECONDS);
  });

  it('a provider with none asks for nothing', () => {
    expect(quotaRefetchDelaySeconds({ a: after(), b: after(60) })).toBe(60);
    expect(quotaRefetchDelaySeconds({ a: after(), b: {} })).toBeNull();
    expect(quotaRefetchDelaySeconds({})).toBeNull();
  });
});
