import { describe, expect, expectTypeOf, it } from 'vitest';
import type { SDKControlGetUsageResponse } from '@anthropic-ai/claude-agent-sdk';
import { isCodexNoPlanError, parseClaudeUsage, parseCodexRateLimits, QuotaShapeError } from './quota-probes';
import type { RateLimitSnapshot } from './adapters/codex-protocol';

const AS_OF = 1_800_000_000_000;
const RESET = '2027-01-20T08:00:00.000Z';

/** The shape one real login returned (Claude Code 2.1.312), values replaced, unrelated keys kept short. */
const CLAUDE_REPLY = {
  session: { total_cost_usd: 1.5 },
  subscription_type: 'max',
  rate_limits_available: true,
  rate_limits: {
    five_hour: null,
    seven_day: { utilization: 41, resets_at: RESET, limit_dollars: null, used_dollars: null, remaining_dollars: null, locked_reason: null },
    seven_day_oauth_apps: null,
    seven_day_opus: null,
    seven_day_sonnet: { utilization: null, resets_at: null },
    extra_usage: { is_enabled: true, monthly_limit: 100, used_credits: 3, utilization: 3, currency: 'USD' },
    spend: { percent: 3 },
    some_future_window: { utilization: 99, resets_at: RESET },
    model_scoped: [{ display_name: 'Fable', utilization: 12.6, resets_at: RESET }],
  },
  behaviors: null,
};

const CODEX_SNAPSHOT = {
  limitId: 'codex', limitName: null, normalModelSlug: null, credits: null, individualLimit: null, spendControlReached: null, planType: 'pro', rateLimitReachedType: null,
  primary: { usedPercent: 41, windowDurationMins: 10_080, resetsAt: 1_800_400_000 },
  secondary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1_800_010_000 },
};

describe('Claude get_usage', () => {
  it('the SDK still types the fields read, so a removal fails the typecheck', () => {
    expectTypeOf<SDKControlGetUsageResponse['subscription_type']>().toEqualTypeOf<string | null>();
    expectTypeOf<SDKControlGetUsageResponse['rate_limits_available']>().toEqualTypeOf<boolean>();
    type Limits = NonNullable<SDKControlGetUsageResponse['rate_limits']>;
    expectTypeOf<NonNullable<Limits['seven_day']>['utilization']>().toEqualTypeOf<number | null>();
    expectTypeOf<NonNullable<Limits['seven_day']>['resets_at']>().toEqualTypeOf<string | null>();
    expectTypeOf<NonNullable<Limits['five_hour']>['utilization']>().toEqualTypeOf<number | null>();
    expectTypeOf<NonNullable<Limits['model_scoped']>[number]['display_name']>().toEqualTypeOf<string>();
  });

  it('reads only the limits it knows, by name', () => {
    expect(parseClaudeUsage(CLAUDE_REPLY, AS_OF)).toEqual({ kind: 'windows', calibrationPlan: 'max', windows: [
      { name: 'week', usedPercent: 41, resetsAt: Date.parse(RESET), asOf: AS_OF },
      { name: 'week_sonnet', asOf: AS_OF },
      { name: 'week:Fable', usedPercent: 13, resetsAt: Date.parse(RESET), asOf: AS_OF },
    ] });
  });

  it('keeps nothing else from the reply', () => {
    const text = JSON.stringify(parseClaudeUsage(CLAUDE_REPLY, AS_OF));
    for (const word of ['cost', 'USD', 'spend', 'credits', 'future']) expect(text).not.toContain(word);
  });

  it('a login with no plan limits is not applicable, not a failure', () => {
    expect(parseClaudeUsage({ rate_limits_available: false, rate_limits: null, subscription_type: null }, AS_OF)).toEqual({ kind: 'not_applicable' });
  });

  it('a plan with no such windows is no windows', () => {
    expect(parseClaudeUsage({ rate_limits_available: true, rate_limits: {} }, AS_OF)).toEqual({ kind: 'windows', windows: [] });
  });

  it.each([
    ['nothing', undefined],
    ['null', null],
    ['a string', 'ok'],
    ['no availability flag', { rate_limits: {} }],
    ['available with no limits', { rate_limits_available: true, rate_limits: null }],
    ['a window that is not an object', { rate_limits_available: true, rate_limits: { seven_day: 41 } }],
  ])('drift reads as a shape error, not a number: %s', (_name, reply) => {
    expect(() => parseClaudeUsage(reply, AS_OF)).toThrow(QuotaShapeError);
  });

  it('a utilization of the wrong type is an unreadable window, never a number', () => {
    expect(parseClaudeUsage({ rate_limits_available: true, rate_limits: { seven_day: { utilization: '41' } } }, AS_OF))
      .toEqual({ kind: 'windows', windows: [{ name: 'week', asOf: AS_OF }] });
  });
});

describe('Codex account/rateLimits/read', () => {
  it('the generated protocol still types the fields read', () => {
    expectTypeOf<RateLimitSnapshot['rateLimitReachedType']>().not.toBeNever();
    expectTypeOf<NonNullable<RateLimitSnapshot['primary']>['usedPercent']>().toEqualTypeOf<number>();
    expectTypeOf(CODEX_SNAPSHOT.primary.usedPercent).toEqualTypeOf<number>();
  });

  it('names a window by its duration, not its position', () => {
    expect(parseCodexRateLimits(CODEX_SNAPSHOT, AS_OF)).toEqual({ kind: 'windows', calibrationPlan: 'pro', windows: [
      { name: 'week', usedPercent: 41, resetsAt: 1_800_400_000_000, asOf: AS_OF },
      { name: '5h', usedPercent: 12, resetsAt: 1_800_010_000_000, asOf: AS_OF },
    ] });
    const swapped = parseCodexRateLimits({ primary: CODEX_SNAPSHOT.secondary, secondary: CODEX_SNAPSHOT.primary }, AS_OF);
    expect(swapped).toMatchObject({ windows: [{ name: '5h' }, { name: 'week' }] });
  });

  it('keeps nothing else from the snapshot', () => {
    expect(parseCodexRateLimits({ ...CODEX_SNAPSHOT, planType: 'secret-unrecognized-plan' }, AS_OF)).not.toHaveProperty('calibrationPlan');
  });

  it('a limit the provider says is reached goes on the fullest window; used percent alone never sets it', () => {
    expect(parseCodexRateLimits({ ...CODEX_SNAPSHOT, rateLimitReachedType: 'rate_limit_reached' }, AS_OF))
      .toMatchObject({ windows: [{ name: 'week', limitReached: true }, { name: '5h' }] });
    const full = parseCodexRateLimits({ ...CODEX_SNAPSHOT, primary: { ...CODEX_SNAPSHOT.primary, usedPercent: 100 } }, AS_OF);
    expect(full).toMatchObject({ windows: [{ usedPercent: 100 }, {}] });
    expect((full as { windows: Array<{ limitReached?: boolean }> }).windows[0].limitReached).toBeUndefined();
  });

  it('a limit reached with no windows still says so', () => {
    expect(parseCodexRateLimits({ primary: null, secondary: null, rateLimitReachedType: 'rate_limit_reached' }, AS_OF))
      .toEqual({ kind: 'windows', windows: [{ name: 'window', limitReached: true, asOf: AS_OF }] });
  });

  it.each([[undefined], [null], ['x']])('drift reads as a shape error: %j', (snapshot) => {
    expect(() => parseCodexRateLimits(snapshot, AS_OF)).toThrow(QuotaShapeError);
  });

  it('knows the no-plan error, and nothing else', () => {
    expect(isCodexNoPlanError(new Error('codex account authentication required to read rate limits'))).toBe(true);
    expect(isCodexNoPlanError(new Error('rpc timeout'))).toBe(false);
    expect(isCodexNoPlanError('authentication required to read rate limits')).toBe(false);
  });
});
