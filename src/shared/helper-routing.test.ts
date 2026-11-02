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
  describeRouting,
  isPresetModel,
  minimalRouting,
  normalizeSavedPresets,
  routingLabel,
  type HelperRouting,
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

  it('the snapshot form is codes only', () => {
    expect(minimalRouting(routing)).toEqual({ mode: 'preset', difficulty: 'hard', provider: 'codex-cli', model: 'gpt-6.1-sol', effort: 'high', reason: 'preset_on_cli' });
  });

  it('says what a helper runs on and why', () => {
    expect(describeRouting(routing)).toBe('gpt-6.1-sol, high effort. From the helper settings for this difficulty.');
    expect(describeRouting({ ...routing, resolved: { ...routing.resolved, model: null, effort: null }, reason: 'explicit_request' }))
      .toBe('its default model. You or the orchestrator chose this.');
  });

  it('the orchestrator persona makes no claims of cost or preference', () => {
    const persona = fs.readFileSync(path.join(__dirname, '../renderer/features/personas/orchestrator.md'), 'utf8');
    expect(persona).toContain('`difficulty` keeps the helper on its CLI.');
    expect(persona).toContain('Don\'t claim a choice is cheapest, best or preferred');
    expect(persona).not.toContain('cli: "auto"');
  });
});
