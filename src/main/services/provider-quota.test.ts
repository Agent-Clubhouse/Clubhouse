import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanQuotaReading } from '../../shared/helper-routing';

const W = vi.hoisted(() => ({
  read: null as null | ((opts?: { env?: Record<string, string> }) => Promise<unknown>),
  chat: null as null | ((event: unknown) => void),
  telemetry: [] as unknown[][],
  cooldowns: [] as unknown[][],
  logs: [] as unknown[],
  providerLookups: [] as string[],
  registrations: new Map<string, { projectPath: string; orchestrator: string }>(),
}));

vi.mock('../orchestrators', () => ({
  getProvider: (id: string) => {
    W.providerLookups.push(id);
    if (id === 'copilot-cli') return { id };
    if (id === 'claude-code') return { id, readPlanQuota: (opts: { env?: Record<string, string> }) => W.read!(opts) };
    return undefined;
  },
}));
vi.mock('./agent-registry', () => ({ agentRegistry: { get: (id: string) => W.registrations.get(id) } }));
vi.mock('./agent-runtime/chat-event-bus', () => ({ onChatEvent: (listener: (event: unknown) => void) => { W.chat = listener; return () => { W.chat = null; }; } }));
vi.mock('./log-service', () => ({ appLog: (...args: unknown[]) => { W.logs.push(args); } }));
vi.mock('../telemetry/feature-events', () => ({
  helperQuotaRead: (...args: unknown[]) => { W.telemetry.push(args); },
  helperAutoCooldown: (...args: unknown[]) => { W.cooldowns.push(args); },
}));

import {
  QUOTA_CACHE_MS, QUOTA_FAILURE_BACKOFF_MS, QUOTA_FORCED_READ_BUDGET_MS, _resetProviderQuotaForTesting, cachedProviderCapacity, classifyStartFailure, forceProviderQuota, isProviderCoolingDown, noteProviderFailure, providerStartWarning, readProviderQuota, watchSessionQuota,
} from './provider-quota';
import { AUTO_COOLDOWN_AUTH_MS, AUTO_COOLDOWN_AVAILABILITY_MS, AUTO_COOLDOWN_QUOTA_MS } from './helper-auto-policy';
import { QUOTA_STALE_MS } from '../../shared/helper-routing';

const NOW = 1_800_000_000_000;
const reading = (usedPercent: number, extra: object = {}): PlanQuotaReading => ({
  kind: 'windows', windows: [{ name: 'week', usedPercent, resetsAt: Date.now() + 86_400_000 * 3, asOf: Date.now(), ...extra }],
});

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  W.read = null;
  W.telemetry = [];
  W.cooldowns = [];
  W.logs = [];
  W.providerLookups = [];
  W.registrations = new Map();
  _resetProviderQuotaForTesting();
});

afterEach(() => { vi.useRealTimers(); });

describe('observational cached capacity', () => {
  it('does not resolve providers or invoke quota/login reads for known or unknown provider ids', () => {
    W.read = vi.fn(async () => reading(41));
    for (const id of ['claude-code', 'copilot-cli', 'unknown-provider']) expect(cachedProviderCapacity(id)).toBe('unknown');
    expect(W.providerLookups).toEqual([]);
    expect(W.read).not.toHaveBeenCalled();
  });

  it('uses prior evidence without resolving providers again, then keeps stale evidence unknown', async () => {
    const read = vi.fn(async () => reading(41));
    W.read = read;
    await readProviderQuota('claude-code');
    const lookups = [...W.providerLookups];
    expect(cachedProviderCapacity('claude-code')).toBe('available');
    vi.setSystemTime(NOW + QUOTA_STALE_MS + 1);
    expect(cachedProviderCapacity('claude-code')).toBe('unknown');
    expect(W.providerLookups).toEqual(lookups);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it.each([[95, 'limited'], [100, 'unavailable']] as const)('maps cached utilization %s to %s without more reads', async (percent, expected) => {
    const read = vi.fn(async () => reading(percent, percent === 100 ? { limitReached: true } : {}));
    W.read = read;
    await readProviderQuota('claude-code');
    const lookups = [...W.providerLookups];
    expect(cachedProviderCapacity('claude-code')).toBe(expected);
    expect(W.providerLookups).toEqual(lookups);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('observes active and expired cooldowns and never claims capacity from not-applicable evidence', async () => {
    const read = vi.fn(async (): Promise<PlanQuotaReading> => ({ kind: 'not_applicable' }));
    W.read = read;
    await noteProviderFailure('claude-code', 'auth');
    expect(cachedProviderCapacity('claude-code')).toBe('unavailable');
    vi.setSystemTime(NOW + AUTO_COOLDOWN_AUTH_MS + 1);
    expect(cachedProviderCapacity('claude-code')).toBe('unknown');
    expect(W.providerLookups).toEqual([]);
    expect(read).not.toHaveBeenCalled();
    await readProviderQuota('claude-code');
    const lookups = [...W.providerLookups];
    expect(cachedProviderCapacity('claude-code')).toBe('unknown');
    expect(W.providerLookups).toEqual(lookups);
    expect(read).toHaveBeenCalledTimes(1);
  });
});

describe('readProviderQuota', () => {
  it('a provider that can\'t report is not_supported, and nothing is read', async () => {
    expect(await readProviderQuota('copilot-cli')).toEqual({ state: 'unknown', unknownReason: 'not_supported', source: 'none', asOf: null });
    expect(await readProviderQuota('nobody')).toMatchObject({ unknownReason: 'not_supported' });
  });

  it('reports the state, source and age', async () => {
    W.read = async () => reading(41);
    expect(await readProviderQuota('claude-code')).toMatchObject({
      state: 'known', source: 'cli_query', asOf: new Date(NOW).toISOString(), limitingWindow: 'weekly', weekly: { usedPercent: 41 },
      refreshAfterSeconds: QUOTA_CACHE_MS / 1000,
    });
    expect(W.telemetry).toEqual([['claude-code', 'known', true]]);
  });

  it('a login with no plan is unknown, for that reason', async () => {
    W.read = async () => ({ kind: 'not_applicable' });
    expect(await readProviderQuota('claude-code')).toMatchObject({ state: 'unknown', unknownReason: 'not_applicable', source: 'cli_query', asOf: new Date(NOW).toISOString() });
  });

  it('asks once while cached, and again after', async () => {
    const read = vi.fn(async () => reading(41));
    W.read = read;
    await readProviderQuota('claude-code');
    vi.setSystemTime(NOW + QUOTA_CACHE_MS - 1);
    await readProviderQuota('claude-code');
    expect(read).toHaveBeenCalledTimes(1);
    vi.setSystemTime(NOW + QUOTA_CACHE_MS);
    await readProviderQuota('claude-code');
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('a burst shares one read', async () => {
    const read = vi.fn(async () => reading(41));
    W.read = read;
    await Promise.all([readProviderQuota('claude-code'), readProviderQuota('claude-code'), readProviderQuota('claude-code')]);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('a slow read returns not_read within the budget, and the next look has the answer', async () => {
    let finish!: (r: PlanQuotaReading) => void;
    W.read = () => new Promise((resolve) => { finish = resolve; });
    const first = readProviderQuota('claude-code', { budgetMs: 3000 });
    await vi.advanceTimersByTimeAsync(3000);
    expect(await first).toMatchObject({ state: 'unknown', unknownReason: 'not_read', asOf: null, refreshAfterSeconds: 3 });
    finish(reading(41));
    await vi.advanceTimersByTimeAsync(0);
    expect(await readProviderQuota('claude-code')).toMatchObject({ state: 'known' });
  });

  it('a failed read is read_failed, never throws, backs off, and logs no message from the CLI', async () => {
    const read = vi.fn(async () => { throw new Error('sk-secret-in-a-cli-error'); });
    W.read = read;
    expect(await readProviderQuota('claude-code')).toMatchObject({ state: 'unknown', unknownReason: 'read_failed', asOf: null, refreshAfterSeconds: QUOTA_FAILURE_BACKOFF_MS / 1000 });
    expect(W.telemetry).toEqual([['claude-code', 'unknown', false]]);
    expect(JSON.stringify(W.logs)).not.toContain('secret');
    vi.setSystemTime(NOW + QUOTA_FAILURE_BACKOFF_MS - 1);
    await readProviderQuota('claude-code');
    expect(read).toHaveBeenCalledTimes(1);
    vi.setSystemTime(NOW + QUOTA_FAILURE_BACKOFF_MS);
    await readProviderQuota('claude-code');
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('a read that fails after a good one keeps the last reading until it is stale, then says stale with its asOf', async () => {
    W.read = async () => reading(41);
    await readProviderQuota('claude-code');
    W.read = async () => { throw new Error('nope'); };
    vi.setSystemTime(NOW + QUOTA_CACHE_MS);
    expect(await readProviderQuota('claude-code')).toMatchObject({ state: 'known', asOf: new Date(NOW).toISOString() });
    vi.setSystemTime(NOW + QUOTA_STALE_MS + 1);
    expect(await readProviderQuota('claude-code')).toMatchObject({ state: 'unknown', unknownReason: 'stale', asOf: new Date(NOW).toISOString() });
  });

  it('a successful reply of an unknown shape is read_failed, through the same path', async () => {
    W.read = async () => { throw Object.assign(new Error('get_usage had no rate_limits_available'), { name: 'QuotaShapeError' }); };
    expect(await readProviderQuota('claude-code')).toMatchObject({ state: 'unknown', unknownReason: 'read_failed' });
  });
});

describe('forceProviderQuota (#2786)', () => {
  it('reads inside the cache and the failure backoff', async () => {
    const read = vi.fn(async () => reading(41));
    W.read = read;
    await readProviderQuota('claude-code');
    read.mockImplementation(async () => reading(70));
    expect(await forceProviderQuota('claude-code')).toMatchObject({ outcome: 'ok', quota: { weekly: { usedPercent: 70 } } });
    expect(read).toHaveBeenCalledTimes(2);

    read.mockImplementation(async () => { throw new Error('no'); });
    expect((await forceProviderQuota('claude-code')).outcome).toBe('failed');
    read.mockImplementation(async () => reading(12));
    expect((await readProviderQuota('claude-code')).weekly?.usedPercent).toBe(70);
    expect((await forceProviderQuota('claude-code')).quota.weekly?.usedPercent).toBe(12);
    expect(read).toHaveBeenCalledTimes(4);
  });

  it('shares a read already going', async () => {
    let finish!: (value: PlanQuotaReading) => void;
    const read = vi.fn(() => new Promise<PlanQuotaReading>((resolve) => { finish = resolve; }));
    W.read = read;
    const plain = readProviderQuota('claude-code');
    const forced = [forceProviderQuota('claude-code'), forceProviderQuota('claude-code')];
    await vi.advanceTimersByTimeAsync(0);
    finish(reading(41));
    await Promise.all([plain, ...forced]);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('a provider that can\'t report is not_supported, and nothing is read', async () => {
    expect(await forceProviderQuota('copilot-cli')).toMatchObject({ outcome: 'not_supported', quota: { unknownReason: 'not_supported' } });
  });

  it('success ends an auth cooldown, and Auto and an explicit start see that', async () => {
    W.read = async () => reading(41);
    await noteProviderFailure('claude-code', 'auth');
    expect(await providerStartWarning('claude-code')).toMatchObject({ code: 'cooling_down' });
    await forceProviderQuota('claude-code');
    expect(await isProviderCoolingDown('claude-code')).toBe(false);
    expect(await providerStartWarning('claude-code')).toBeUndefined();
  });

  it.each(['quota', 'availability'] as const)('success leaves a %s cooldown', async (kind) => {
    W.read = async () => reading(41);
    await noteProviderFailure('claude-code', kind);
    await forceProviderQuota('claude-code');
    expect(await isProviderCoolingDown('claude-code')).toBe(true);
  });

  it.each([
    ['quota', AUTO_COOLDOWN_QUOTA_MS],
    ['availability', AUTO_COOLDOWN_AVAILABILITY_MS],
  ] as const)('ends only the auth part when %s was noted too, whichever came last', async (kind, ms) => {
    W.read = async () => reading(41);
    await noteProviderFailure('claude-code', kind);
    await noteProviderFailure('claude-code', 'auth');
    await forceProviderQuota('claude-code');
    expect(await isProviderCoolingDown('claude-code')).toBe(true);
    vi.setSystemTime(NOW + ms);
    expect(await isProviderCoolingDown('claude-code')).toBe(false);
  });

  it('a warning left after the auth part ends says how old what remains is', async () => {
    W.read = async () => reading(41);
    await noteProviderFailure('claude-code', 'availability');
    vi.setSystemTime(NOW + 1000);
    await noteProviderFailure('claude-code', 'auth');
    await forceProviderQuota('claude-code');
    expect(await providerStartWarning('claude-code')).toMatchObject({ code: 'cooling_down', asOf: new Date(NOW).toISOString() });
  });

  it('a failed read clears nothing', async () => {
    W.read = async () => { throw new Error('still logged out'); };
    await noteProviderFailure('claude-code', 'auth');
    expect((await forceProviderQuota('claude-code')).outcome).toBe('failed');
    expect(await isProviderCoolingDown('claude-code')).toBe(true);
  });

  it('not_applicable doesn\'t prove a login, so it clears nothing', async () => {
    W.read = async () => ({ kind: 'not_applicable' });
    await noteProviderFailure('claude-code', 'auth');
    expect((await forceProviderQuota('claude-code')).outcome).toBe('ok');
    expect(await isProviderCoolingDown('claude-code')).toBe(true);
  });

  it('an ordinary read clears nothing', async () => {
    W.read = async () => reading(41);
    await noteProviderFailure('claude-code', 'auth');
    await readProviderQuota('claude-code');
    expect(await isProviderCoolingDown('claude-code')).toBe(true);
  });

  it('a failure noted while the read was going isn\'t answered by it', async () => {
    let finish!: (value: PlanQuotaReading) => void;
    W.read = () => new Promise<PlanQuotaReading>((resolve) => { finish = resolve; });
    const forced = forceProviderQuota('claude-code');
    await vi.advanceTimersByTimeAsync(1000);
    await noteProviderFailure('claude-code', 'auth');
    finish(reading(41));
    await forced;
    expect(await isProviderCoolingDown('claude-code')).toBe(true);
  });

  it('a read past the budget returns timed_out, and still ends the cooldown when it succeeds', async () => {
    let finish!: (value: PlanQuotaReading) => void;
    W.read = () => new Promise<PlanQuotaReading>((resolve) => { finish = resolve; });
    await noteProviderFailure('claude-code', 'auth');
    const forced = forceProviderQuota('claude-code');
    await vi.advanceTimersByTimeAsync(QUOTA_FORCED_READ_BUDGET_MS);
    expect((await forced).outcome).toBe('timed_out');
    expect(await isProviderCoolingDown('claude-code')).toBe(true);
    finish(reading(41));
    await vi.advanceTimersByTimeAsync(0);
    expect(await isProviderCoolingDown('claude-code')).toBe(false);
  });

});

describe('watchSessionQuota', () => {
  const usage = (limits: unknown[], agentId = 'a1') => W.chat!({ type: 'usage', agentId, data: { scope: 'session', limits } });
  const settle = () => vi.advanceTimersByTimeAsync(0);

  beforeEach(() => {
    watchSessionQuota();
    W.registrations.set('a1', { projectPath: '/p', orchestrator: 'claude-code' });
  });

  it('fills in between reads, saying where it came from, and asks the CLI nothing until the cache ends', async () => {
    const read = vi.fn(async () => reading(10));
    W.read = read;
    await readProviderQuota('claude-code');
    usage([{ window: 'week', utilization: 0.97, resetsAt: NOW + 5000 }]);
    await settle();
    expect(await readProviderQuota('claude-code')).toMatchObject({ state: 'near_limit', source: 'session_event', weekly: { usedPercent: 97 } });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('the provider\'s word is exhausted, and a later ok clears it', async () => {
    W.read = async () => reading(10);
    await readProviderQuota('claude-code');
    usage([{ window: 'week', status: 'exceeded' }]);
    await settle();
    expect(await readProviderQuota('claude-code')).toMatchObject({ state: 'exhausted', weekly: { usedPercent: 10 } });
    usage([{ window: 'week', status: 'ok' }]);
    await settle();
    expect(await readProviderQuota('claude-code')).toMatchObject({ state: 'known' });
  });

  it('leaves out what isn\'t a limit on work', async () => {
    W.read = async () => reading(10);
    await readProviderQuota('claude-code');
    usage([{ window: 'overage', utilization: 1 }, { window: 'week_oauth_apps', utilization: 1 }, { window: 'week_overage_included', utilization: 1 }]);
    await settle();
    expect(await readProviderQuota('claude-code')).toMatchObject({ state: 'known', source: 'cli_query' });
  });

  it('ignores other events, and agents it doesn\'t know', async () => {
    W.read = async () => reading(10);
    W.chat!({ type: 'text', agentId: 'a1', data: {} });
    usage([], 'a1');
    usage([{ window: 'week', utilization: 1 }], 'nobody');
    await settle();
    expect(await readProviderQuota('claude-code')).toMatchObject({ state: 'known', weekly: { usedPercent: 10 } });
  });
});

describe('failures and cooldowns', () => {
  it.each<[unknown, string]>([
    [Object.assign(new Error('x'), { code: 'auth_required' }), 'auth'],
    [Object.assign(new Error('x'), { code: 'account_issue' }), 'auth'],
    [new Error('You are not logged in'), 'auth'],
    [Object.assign(new Error('x'), { code: 'rate_limited' }), 'quota'],
    [new Error('Usage limit reached for the week'), 'quota'],
    [new Error('spawn ENOENT'), 'availability'],
    ['anything else', 'availability'],
  ])('classifies %s as %s', (err, kind) => {
    expect(classifyStartFailure(err)).toBe(kind);
  });

  it.each([
    ['auth', AUTO_COOLDOWN_AUTH_MS],
    ['availability', AUTO_COOLDOWN_AVAILABILITY_MS],
  ] as const)('%s cools down for a fixed while, and nothing about quota changes', async (kind, ms) => {
    await noteProviderFailure('claude-code', kind);
    expect(await isProviderCoolingDown('claude-code')).toBe(true);
    expect(W.cooldowns).toEqual([['claude-code', kind]]);
    vi.setSystemTime(NOW + ms - 1);
    expect(await isProviderCoolingDown('claude-code')).toBe(true);
    vi.setSystemTime(NOW + ms);
    expect(await isProviderCoolingDown('claude-code')).toBe(false);
  });

  it('a quota failure is the provider saying so: exhausted, until the cooldown ends or a read disagrees', async () => {
    await noteProviderFailure('claude-code', 'quota');
    W.read = async () => { throw new Error('no read'); };
    expect(await readProviderQuota('claude-code')).toMatchObject({ state: 'exhausted', source: 'session_event' });
    vi.setSystemTime(NOW + AUTO_COOLDOWN_QUOTA_MS);
    expect(await isProviderCoolingDown('claude-code')).toBe(false);
    expect((await readProviderQuota('claude-code')).state).not.toBe('exhausted');
  });

  it('a quota failure with a known reset waits until then', async () => {
    await noteProviderFailure('claude-code', 'quota', NOW + 1000);
    vi.setSystemTime(NOW + 1000);
    expect(await isProviderCoolingDown('claude-code')).toBe(false);
  });

  it('a quota failure with no reset of its own uses a known limit\'s', async () => {
    W.read = async () => ({ kind: 'windows', windows: [{ name: 'week', usedPercent: 90, limitReached: true, resetsAt: NOW + AUTO_COOLDOWN_QUOTA_MS * 3, asOf: NOW }] });
    await readProviderQuota('claude-code');
    await noteProviderFailure('claude-code', 'quota');
    vi.setSystemTime(NOW + AUTO_COOLDOWN_QUOTA_MS * 2);
    expect(await isProviderCoolingDown('claude-code')).toBe(true);
    vi.setSystemTime(NOW + AUTO_COOLDOWN_QUOTA_MS * 3);
    expect(await isProviderCoolingDown('claude-code')).toBe(false);
  });

  it('warns an explicit start from what is known, asking the CLI nothing', async () => {
    const read = vi.fn(async () => reading(96));
    W.read = read;
    expect(await providerStartWarning('claude-code')).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
    await readProviderQuota('claude-code');
    expect(await providerStartWarning('claude-code')).toMatchObject({ code: 'quota_near_limit', asOf: new Date(NOW).toISOString(), message: expect.stringContaining('close to its plan limit') });
    await noteProviderFailure('claude-code', 'auth');
    expect(await providerStartWarning('claude-code')).toMatchObject({ code: 'cooling_down', asOf: new Date(NOW).toISOString() });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('a shorter failure of any kind doesn\'t shorten what is already running', async () => {
    await noteProviderFailure('claude-code', 'quota', NOW + AUTO_COOLDOWN_QUOTA_MS * 3);
    await noteProviderFailure('claude-code', 'quota', NOW + 1000);
    await noteProviderFailure('claude-code', 'availability');
    await noteProviderFailure('claude-code', 'auth');
    vi.setSystemTime(NOW + AUTO_COOLDOWN_QUOTA_MS * 3 - 1);
    expect(await isProviderCoolingDown('claude-code')).toBe(true);
    vi.setSystemTime(NOW + AUTO_COOLDOWN_QUOTA_MS * 3);
    expect(await isProviderCoolingDown('claude-code')).toBe(false);
  });

  it('a session finding a limit or a logged-out CLI tells Auto; a task\'s own error doesn\'t', async () => {
    watchSessionQuota();
    W.registrations.set('a1', { projectPath: '/p', orchestrator: 'claude-code' });
    W.chat!({ type: 'error', agentId: 'a1', data: { code: 'tool_failed', message: 'x' } });
    W.chat!({ type: 'error', agentId: 'a1', data: { code: 'context_overflow', message: 'x' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(await isProviderCoolingDown('claude-code')).toBe(false);
    W.chat!({ type: 'error', agentId: 'a1', data: { code: 'rate_limited', message: 'x' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(await isProviderCoolingDown('claude-code')).toBe(true);
    expect(W.cooldowns).toEqual([['claude-code', 'quota']]);
  });

  it.each([
    ['auth_required', 'auth', AUTO_COOLDOWN_AUTH_MS],
    ['rate_limited', 'quota', AUTO_COOLDOWN_QUOTA_MS],
  ] as const)('Copilot %s session errors cool down future Auto starts even without readable quota', async (code, kind, duration) => {
    watchSessionQuota();
    W.registrations.set('copilot', { projectPath: '/p', orchestrator: 'copilot-cli' });
    W.chat!({ type: 'error', agentId: 'copilot', data: { code, message: 'x' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(await isProviderCoolingDown('copilot-cli')).toBe(true);
    expect(W.cooldowns).toEqual([['copilot-cli', kind]]);
    expect(await readProviderQuota('copilot-cli')).toMatchObject({ state: 'unknown', unknownReason: 'not_supported' });
    vi.setSystemTime(NOW + duration);
    expect(await isProviderCoolingDown('copilot-cli')).toBe(false);
  });
});
