import { describe, expect, it } from 'vitest';
import type { QuotaView } from '../../../shared/helper-routing';
import type { UsageRollupTotals } from '../../../shared/usage-rollup.mjs';
import { quotaText, roleName, usageText } from './usage-format';

const totals = (over: Partial<UsageRollupTotals>): UsageRollupTotals => ({
  turns: 2, turnsWithoutUsage: 0, turnsWithoutId: 0, uncachedInput: 100, missing: {}, sources: {},
  input: 1_200_000, cachedInput: 1_100_000, cacheWrite: null, output: 40_000, reasoning: null, ...over,
});

describe('quotaText', () => {
  const view = (over: Partial<QuotaView>): QuotaView => ({ state: 'known', source: 'cli_query', asOf: '2026-11-24T10:00:00Z', limitingWindow: 'weekly', weekly: { usedPercent: 61.6, resetsAt: null }, ...over });

  it('shows the limiting window as the provider reported it', () => {
    expect(quotaText('reader', view({}))).toBe('62% of the weekly limit used');
    expect(quotaText('reader', view({ limitingWindow: 'fiveHour', fiveHour: { usedPercent: 10, resetsAt: null, limitReached: true } }))).toBe('Limit reached');
  });

  it('says unknown, never a percentage, when the provider can’t say', () => {
    expect(quotaText('unknown', view({}))).toBe('unknown');
    expect(quotaText('reader', undefined)).toBe('unknown');
    expect(quotaText('reader', view({ state: 'unknown', unknownReason: 'read_failed' }))).toBe('unknown');
    expect(quotaText('reader', view({ weekly: { usedPercent: null, resetsAt: null } }))).toBe('unknown');
  });
});

describe('usageText', () => {
  it('keeps unknown figures unknown and a reported zero as 0', () => {
    expect(usageText(totals({}))).toBe('2 turns, 1.2M input (1.1M cached), 40K output, unknown reasoning');
    expect(usageText(totals({ input: null, cachedInput: null, output: 0, turnsWithoutUsage: 1 }))).toBe('2 turns, unknown input, 0 output, unknown reasoning. 1 reported no usage');
  });

  it('says when turns had no id, since a repeat of one can’t be told apart', () => {
    expect(usageText(totals({ turnsWithoutId: 1 }))).toBe('2 turns, 1.2M input (1.1M cached), 40K output, unknown reasoning. 1 turn had no id and may be counted twice');
    expect(usageText(totals({ turnsWithoutUsage: 1, turnsWithoutId: 2 }))).toMatch(/1 reported no usage\. 2 turns had no id and may be counted twice$/);
  });

  it('says no usage was logged rather than 0', () => {
    expect(usageText(undefined)).toBe('No usage logged');
    expect(usageText(totals({ turns: 0 }))).toBe('No usage logged');
  });

  it('names roles plainly', () => {
    expect(roleName('helper')).toBe('Helpers');
    expect(roleName('something-new')).toBe('something-new');
  });
});
