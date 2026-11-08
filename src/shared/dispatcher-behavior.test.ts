import { describe, expect, it, vi } from 'vitest';
import {
  CHECK_IN_FREQUENCIES,
  DEFAULT_DISPATCHER_BEHAVIOR,
  DISPATCHER_BEHAVIORS,
  DISPATCHER_BEHAVIOR_LABELS,
  DISPATCHER_BEHAVIOR_PLANS,
  UPKEEP_FREQUENCIES,
  behaviorAutoNote,
  canSetUpAuto,
  dispatcherBehaviorPlan,
  normalizeDispatcherBehavior,
  resolveBehaviorModels,
} from './dispatcher-behavior';
import { AUTO_LEVELS, BUILTIN_PRESETS, PRESET_PROVIDERS, isPresetProvider, type AutoLevel } from './helper-routing';

/** Resolves like services/helper-routing resolveAutoLevel with only the built-ins saved. */
async function builtinResolve(provider: string, level: AutoLevel) {
  if (!isPresetProvider(provider)) return { ok: false as const, code: 'auto_not_supported' as const, message: `${provider} has no Auto mapping.` };
  const difficulty = level === 'minimum' ? 'easy' : level === 'maximum' ? 'hard' : level;
  return { ok: true as const, ...BUILTIN_PRESETS[provider][difficulty] };
}

describe('Dispatcher Behavior levels (#3045)', () => {
  it('defaults to Standard, for anything missing or unknown', () => {
    expect(DEFAULT_DISPATCHER_BEHAVIOR).toBe('standard');
    expect(normalizeDispatcherBehavior(undefined)).toBe('standard');
    expect(normalizeDispatcherBehavior('extreme')).toBe('standard');
    expect(normalizeDispatcherBehavior('thorough')).toBe('thorough');
  });

  it('names an Auto level per agent and a frequency bucket for every level', () => {
    for (const level of DISPATCHER_BEHAVIORS) {
      const plan = DISPATCHER_BEHAVIOR_PLANS[level];
      expect(AUTO_LEVELS).toContain(plan.models.chat);
      expect(AUTO_LEVELS).toContain(plan.models.work);
      expect(CHECK_IN_FREQUENCIES).toContain(plan.checkIns);
      expect(UPKEEP_FREQUENCIES).toContain(plan.upkeep);
    }
  });

  it('Light runs no check-ins and nightly upkeep; Standard occasionally; Thorough frequently', () => {
    expect(dispatcherBehaviorPlan('light')).toMatchObject({ checkIns: 'none', upkeep: 'nightly' });
    expect(dispatcherBehaviorPlan('standard')).toMatchObject({ checkIns: 'occasionally' });
    expect(dispatcherBehaviorPlan('thorough')).toMatchObject({ checkIns: 'frequently' });
    expect(dispatcherBehaviorPlan(undefined)).toBe(DISPATCHER_BEHAVIOR_PLANS.standard);
  });

  it('never promises an exact frequency in its words', () => {
    const words = Object.values(DISPATCHER_BEHAVIOR_LABELS).flatMap((l) => [l.label, l.description]).join(' ');
    expect(words).not.toMatch(/\d|minute|hour|daily|every|night/i);
    expect(words).toContain('occasionally');
    expect(words).toContain('frequently');
    expect(words).not.toMatch(/—/);
  });
});

describe('resolveBehaviorModels: the level per provider', () => {
  it('maps each level to models on every preset provider through the Auto mapping', async () => {
    const expected: Record<string, Record<string, { chat: string; work: string }>> = {
      'claude-code': {
        light: { chat: 'haiku', work: 'haiku' },
        standard: { chat: 'sonnet', work: 'sonnet' },
        thorough: { chat: 'sonnet', work: 'opus' },
      },
      'codex-cli': {
        light: { chat: 'gpt-6-luna', work: 'gpt-6-luna' },
        standard: { chat: 'gpt-6.1-terra', work: 'gpt-6.1-terra' },
        thorough: { chat: 'gpt-6.1-terra', work: 'gpt-6.1-sol' },
      },
      'copilot-cli': {
        light: { chat: 'claude-haiku-5.5', work: 'claude-haiku-5.5' },
        standard: { chat: 'claude-sonnet-5.5', work: 'claude-sonnet-5.5' },
        thorough: { chat: 'claude-sonnet-5.5', work: 'claude-opus-5.5' },
      },
    };
    expect(Object.keys(expected).sort()).toEqual([...PRESET_PROVIDERS].sort());
    for (const provider of PRESET_PROVIDERS) {
      for (const level of DISPATCHER_BEHAVIORS) {
        const result = await resolveBehaviorModels(provider, level, builtinResolve);
        expect(result.ok).toBe(true);
        if (!result.ok) continue;
        expect({ chat: result.models.chat.model, work: result.models.work.model }).toEqual(expected[provider][level]);
      }
    }
  });

  it('gives Thorough Auto\'s maximum for the work and passes the effort along', async () => {
    const resolve = vi.fn(async (_p: string, level: AutoLevel) => ({ ok: true as const, model: `m-${level}`, effort: level === 'maximum' ? 'xhigh' : 'medium' }));
    const result = await resolveBehaviorModels('claude-code', 'thorough', resolve);
    expect(result).toEqual({ ok: true, models: { chat: { model: 'm-medium', effort: 'medium' }, work: { model: 'm-maximum', effort: 'xhigh' } } });
  });

  it('asks for each Auto level once', async () => {
    const resolve = vi.fn(builtinResolve);
    await resolveBehaviorModels('claude-code', 'standard', resolve);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith('claude-code', 'medium');
  });

  it('reports a provider with no Auto mapping rather than guessing a model', async () => {
    for (const level of DISPATCHER_BEHAVIORS) {
      const result = await resolveBehaviorModels('future-cli', level, builtinResolve);
      expect(result).toMatchObject({ ok: false, code: 'auto_not_supported' });
    }
  });

  it('is all or nothing: one level with nothing offered fails the whole level', async () => {
    const resolve = async (_p: string, level: AutoLevel) => (level === 'maximum'
      ? { ok: false as const, code: 'no_valid_mapping' as const, message: 'No maximum level is offered now' }
      : { ok: true as const, model: 'terra', effort: 'medium' });
    expect(await resolveBehaviorModels('codex-cli', 'thorough', resolve)).toMatchObject({ ok: false, code: 'no_valid_mapping' });
    expect(await resolveBehaviorModels('codex-cli', 'standard', resolve)).toMatchObject({ ok: true });
  });
});

describe('the missing-Auto line', () => {
  it('says nothing while Auto is ready', () => {
    expect(behaviorAutoNote({ ready: true }, 'Claude Code')).toBeNull();
    expect(canSetUpAuto({ ready: true })).toBe(false);
  });

  it('explains a provider Auto doesn\'t support, with nothing to set up', () => {
    const note = behaviorAutoNote({ ready: false, code: 'auto_not_supported' }, 'Future CLI');
    expect(note).toContain('Auto doesn’t support Future CLI yet');
    expect(note).not.toMatch(/coordinator|session/i);
    expect(canSetUpAuto({ ready: false, code: 'auto_not_supported' })).toBe(false);
  });

  it('offers to set up Auto where the mapping has nothing for the level', () => {
    expect(behaviorAutoNote({ ready: false, code: 'no_valid_mapping' }, 'Codex')).toContain('until Auto is set up');
    expect(canSetUpAuto({ ready: false, code: 'no_valid_mapping' })).toBe(true);
  });
});
