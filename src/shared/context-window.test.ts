import { describe, expect, it } from 'vitest';
import {
  claudeContextWindowOptions, claudeModelCeiling, codexContextWindowOptions, contextWindowRefusal, copilotContextWindowOptions,
  copilotTierEntry, formatContextTokens, parseCodexContextCatalog, type ContextWindowOptions,
} from './context-window';

const ids = (o: ContextWindowOptions) => (o.configurable === false ? [] : o.choices.map((c) => c.id));

describe('Claude working window', () => {
  it('stays inside what --autocompact accepts, 100k to 1M', () => {
    const o = claudeContextWindowOptions('claude-opus-5-5');
    expect(ids(o)).toEqual(['100000', '200000', '300000', '500000', '750000', '1000000']);
    for (const id of ids(o)) expect(Number(id)).toBeGreaterThanOrEqual(100_000);
  });

  it('caps the choices at a smaller model, unless it has the [1m] tag', () => {
    expect(claudeModelCeiling('claude-haiku-4-5')).toBe(200_000);
    expect(ids(claudeContextWindowOptions('claude-haiku-4-5'))).toEqual(['100000', '200000']);
    expect(claudeModelCeiling('claude-haiku-4-5[1m]')).toBe(1_000_000);
    expect(claudeModelCeiling('claude-opus-4-5')).toBe(200_000);
    for (const m of ['claude-opus-4-8', 'claude-opus-5-5', 'haiku', 'opus', 'default', undefined]) expect(claudeModelCeiling(m)).toBe(1_000_000);
  });

  it('says it does not change the model', () => {
    const o = claudeContextWindowOptions('opus');
    if (o.configurable === false) throw new Error('expected configurable');
    expect(o.kind).toBe('working_window');
    expect(o.label).toBe('Working context');
    expect(o.description).toContain('doesn\'t change the model');
  });
});

describe('Codex context window', () => {
  const astra = { slug: 'gpt-6-astra', contextWindow: 272_000, maxContextWindow: 872_000, effectivePercent: 95 };

  it('offers sizes up to the validated max, with what is usable', () => {
    const o = codexContextWindowOptions(astra);
    if (o.configurable === false) throw new Error('expected configurable');
    expect(o.choices.map((c) => c.id)).toEqual(['128000', '200000', '400000', '600000', '872000']);
    expect(o.defaultTokens).toBe(258_400);
    expect(o.maxTokens).toBe(828_400);
    expect(o.choices.find((c) => c.id === '872000')?.tokens).toBe(828_400);
  });

  it('is not configurable for a one-size model or one it does not list', () => {
    expect(codexContextWindowOptions({ ...astra, maxContextWindow: 272_000 })).toMatchObject({ configurable: false, state: 'unsupported' });
    expect(codexContextWindowOptions(undefined)).toMatchObject({ configurable: false, state: 'unsupported' });
  });

  it('parses the catalog, the default model first', () => {
    const out = JSON.stringify({ models: [
      { slug: 'hidden', visibility: 'hide', priority: 0, context_window: 1 },
      { slug: 'b', visibility: 'list', priority: 2, context_window: 2 },
      { slug: 'a', visibility: 'list', priority: 1, context_window: 272000, max_context_window: 872000, effective_context_window_percent: 95 },
      { slug: 'no-window' },
    ] });
    const parsed = parseCodexContextCatalog(out)!;
    expect(parsed.map((e) => e.slug)).toEqual(['a', 'b', 'hidden']);
    expect(parsed[0]).toEqual({ slug: 'a', contextWindow: 272000, maxContextWindow: 872000, effectivePercent: 95 });
    expect(parseCodexContextCatalog('nope')).toBeNull();
    expect(parseCodexContextCatalog('{}')).toBeNull();
  });
});

describe('Copilot context tier', () => {
  const entry = copilotTierEntry({ id: 'm', billing: { tokenPrices: { maxPromptTokens: 200_000, inputPrice: 1, longContext: { maxPromptTokens: 900_000, inputPrice: 2 } } } })!;

  it('offers the tiers a model has, with what the larger costs', () => {
    const o = copilotContextWindowOptions('m', [entry]);
    if (o.configurable === false) throw new Error('expected configurable');
    expect(o.kind).toBe('tier');
    expect(o.choices.map((c) => c.id)).toEqual(['default', 'long_context']);
    expect(o.choices[1].tokens).toBe(900_000);
    expect(o.costNote).toContain('2 AI credits');
  });

  it('reads a tier declared without pricing', () => {
    expect(copilotTierEntry({ id: 'x', supportedContextTiers: ['long_context'] })?.hasLongContext).toBe(true);
    expect(copilotTierEntry({ id: 'x' })?.hasLongContext).toBe(false);
    expect(copilotTierEntry({})).toBeNull();
  });

  it('does not pretend: no tier, no model chosen, or no catalog', () => {
    expect(copilotContextWindowOptions('m', [{ ...entry, hasLongContext: false }])).toMatchObject({ configurable: false, state: 'unsupported' });
    for (const m of ['default', 'auto', undefined]) expect(copilotContextWindowOptions(m, [entry])).toMatchObject({ configurable: false, state: 'pick_model' });
    expect(copilotContextWindowOptions('m', null)).toMatchObject({ configurable: false, state: 'unavailable' });
    expect(copilotContextWindowOptions('other', [entry])).toMatchObject({ configurable: false, state: 'unavailable' });
  });
});

describe('contextWindowRefusal', () => {
  it('refuses what is not on offer, and says nothing when the catalog cannot say', () => {
    const o = claudeContextWindowOptions('claude-haiku-4-5');
    expect(contextWindowRefusal('200000', o)).toBeNull();
    expect(contextWindowRefusal('500000', o)).toMatch(/isn't one/);
    expect(contextWindowRefusal('x', { configurable: false, state: 'unsupported', label: 'L', reason: 'no' })).toBe('no');
    expect(contextWindowRefusal('x', { configurable: false, state: 'unavailable', label: 'L', reason: 'no' })).toBeNull();
    expect(contextWindowRefusal('x', { configurable: false, state: 'pick_model', label: 'L', reason: 'no' })).toBeNull();
  });
});

it('formats tokens', () => {
  expect(formatContextTokens(272_000)).toBe('272K');
  expect(formatContextTokens(1_000_000)).toBe('1M');
});
