import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelInfo, ModelList } from '../orchestrators';

const W = vi.hoisted(() => ({
  lists: new Map<string, unknown>(),
  personas: new Map<string, string>(),
  saved: {} as Record<string, Record<string, { model: string; effort: string | null }>>,
  revision: 0,
  audit: [] as Array<Record<string, unknown>>,
  telemetry: [] as unknown[][],
}));

vi.mock('../orchestrators', () => {
  const provider = (id: string) => ({
    id,
    listModels: async () => { const list = W.lists.get(id); if (list instanceof Error) throw list; return list ?? null; },
    acceptsModel: (m: string, l: { models: Array<{ id: string; resolvedId?: string }> }) => m === 'default' || l.models.some((e) => e.id === m || e.resolvedId === m),
  });
  const all = ['claude-code', 'codex-cli', 'copilot-cli'].map(provider);
  return { getProvider: (id: string) => all.find((p) => p.id === id), getAllProviders: () => all };
});
vi.mock('./agent-system', () => ({ resolveProfileEnv: vi.fn(async () => undefined) }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./materialization-service', () => ({ readLayeredPersonaRaw: async (_p: string, id: string) => W.personas.get(id) }));
vi.mock('./orchestration-settings', () => ({
  getPresets: () => W.saved,
  getPresetsRevision: () => W.revision,
  savePresets: async (presets: typeof W.saved) => { W.saved = presets; W.revision++; },
}));
vi.mock('./agent-runtime/chat-event-bus', () => ({ onChatEvent: () => () => undefined }));
vi.mock('./settings-audit', () => ({ appendSettingsAudit: async (row: Record<string, unknown>) => { W.audit.push(row); return true; } }));
vi.mock('../telemetry/feature-events', () => ({ helperPresetsChanged: (...args: unknown[]) => { W.telemetry.push(args); } }));

import { resolveProfileEnv } from './agent-system';
import {
  HelperRoutingError,
  _resetHelperRoutingForTesting,
  helperRoutingRevision,
  onHelperRoutingChanged,
  planHelperStart,
  readHelperRouting,
  updateHelperPresets,
} from './helper-routing';

const m = (id: string, efforts: string[] = ['low', 'medium', 'high'], extra: Partial<ModelInfo> = {}): ModelInfo => ({ id, label: id, efforts, ...extra });
const live = (models: ModelInfo[]): ModelList => ({ models, source: 'live', via: 'handshake', fetchedAt: 1000 });
const fallback = (models: ModelInfo[]): ModelList => ({ models, source: 'fallback', via: 'static', fetchedAt: 1000 });
const CLAUDE = [m('default', ['low', 'medium'], { isDefault: true }), m('opus'), m('sonnet'), m('haiku')];
const CODEX = [m('gpt-6.1-sol'), m('gpt-6.1-terra'), m('gpt-6-luna')];
const base = { orchestratorCli: 'claude-code', projectPath: '/p' };

async function plan(request: Partial<Parameters<typeof planHelperStart>[0]>) {
  const result = await planHelperStart({ ...base, ...request });
  if (result.ok === false) throw new Error(`refused: ${result.message}`);
  return result.plan;
}

beforeEach(() => {
  W.lists = new Map<string, unknown>([['claude-code', live(CLAUDE)], ['codex-cli', live(CODEX)]]);
  W.personas = new Map();
  W.saved = {};
  W.revision = 0;
  W.audit = [];
  W.telemetry = [];
  _resetHelperRoutingForTesting();
});

afterEach(() => { vi.restoreAllMocks(); });

describe('planHelperStart: precedence', () => {
  it('a start that asks for nothing has no plan: today\'s path, and it records nothing', async () => {
    expect(await plan({})).toBeNull();
    // A persona alone doesn't make one either.
    W.personas.set('pinned', '---\nmodel: opus\n---\nBody');
    expect(await plan({ persona: 'pinned' })).toBeNull();
  });

  it('a difficulty alone stays on the orchestrator\'s CLI and uses the built-in', async () => {
    const result = await plan({ difficulty: 'hard', orchestratorCli: 'codex-cli' });
    expect(result).toMatchObject({ provider: 'codex-cli', model: 'gpt-6.1-sol', effort: 'high', keep: [] });
    expect(result!.routing).toMatchObject({
      mode: 'preset', balanced: false, policyVersion: 1, reason: 'preset_on_cli', fallback: 'none',
      requested: { provider: null, model: null, effort: null, difficulty: 'hard' },
      resolved: { provider: 'codex-cli', model: 'gpt-6.1-sol', effort: 'high', difficulty: 'hard' },
      source: { provider: 'orchestrator', model: 'builtin_mapping', effort: 'builtin_mapping' },
    });
  });

  it('a difficulty with a named CLI uses that CLI\'s preset, and never moves away from it', async () => {
    const result = await plan({ difficulty: 'easy', cli: 'codex-cli' });
    expect(result).toMatchObject({ provider: 'codex-cli', model: 'gpt-6-luna', effort: 'low', keep: ['orchestrator'] });
    expect(result!.routing.source.provider).toBe('request');
  });

  it('a saved preset wins over the built-in', async () => {
    W.saved = { 'claude-code': { easy: { model: 'sonnet', effort: 'low' } } };
    const result = await plan({ difficulty: 'easy' });
    expect(result).toMatchObject({ model: 'sonnet', effort: 'low' });
    expect(result!.routing.source.model).toBe('custom_mapping');
  });

  it('an explicit model stays authoritative, and a preset\'s effort isn\'t applied to it', async () => {
    const result = await plan({ difficulty: 'hard', model: 'sonnet', cli: 'claude-code' });
    expect(result).toMatchObject({ model: 'sonnet', keep: ['orchestrator', 'model'] });
    expect(result!.effort).toBeUndefined();
    expect(result!.routing).toMatchObject({ reason: 'explicit_request', source: { model: 'request', effort: 'cli_default' } });
  });

  it('an explicit effort wins over the preset\'s, on the preset\'s model', async () => {
    const result = await plan({ difficulty: 'hard', effort: 'low' });
    expect(result).toMatchObject({ model: 'opus', effort: 'low' });
    expect(result!.routing).toMatchObject({ reason: 'preset_on_cli', source: { model: 'builtin_mapping', effort: 'request' } });
  });

  it('explicit Sol is what runs, whatever the presets say, and is recorded as asked', async () => {
    W.saved = { 'codex-cli': { hard: { model: 'gpt-6-luna', effort: 'low' } } };
    const result = await plan({ cli: 'codex-cli', model: 'gpt-6.1-sol', effort: 'high' });
    expect(result).toMatchObject({ provider: 'codex-cli', model: 'gpt-6.1-sol', effort: 'high', keep: ['orchestrator', 'model'] });
    expect(result!.routing).toMatchObject({
      mode: 'explicit', balanced: false, reason: 'explicit_request',
      requested: { provider: 'codex-cli', model: 'gpt-6.1-sol', effort: 'high', difficulty: null },
      source: { provider: 'request', model: 'request', effort: 'request' },
    });
  });

  it('a persona\'s pins fill what the request left open, and beat a preset', async () => {
    W.personas.set('pinned', '---\nmodel: sonnet\norchestrator: claude-code\n---\nBody');
    const result = await plan({ difficulty: 'easy', persona: 'pinned', orchestratorCli: 'codex-cli' });
    expect(result).toMatchObject({ provider: 'claude-code', model: 'sonnet', keep: [] });
    expect(result!.effort).toBeUndefined();
    expect(result!.routing).toMatchObject({ reason: 'persona_pinned', source: { provider: 'persona', model: 'persona', effort: 'cli_default' } });
  });

  it('a persona pinning a CLI only: the preset comes from that CLI', async () => {
    W.personas.set('pinned', '---\norchestrator: codex-cli\n---\nBody');
    const result = await plan({ difficulty: 'easy', persona: 'pinned' });
    expect(result).toMatchObject({ provider: 'codex-cli', model: 'gpt-6-luna', effort: 'low' });
    expect(result!.routing.source).toMatchObject({ provider: 'persona', model: 'builtin_mapping' });
  });

  it('explicit fields keep what the persona would set, and say so to the persona step', async () => {
    W.personas.set('pinned', '---\nmodel: sonnet\norchestrator: codex-cli\n---\nBody');
    const result = await plan({ cli: 'claude-code', model: 'opus', persona: 'pinned' });
    expect(result).toMatchObject({ provider: 'claude-code', model: 'opus', keep: ['orchestrator', 'model'] });
  });

  it('a persona\'s model isn\'t run on another CLI the request named', async () => {
    W.personas.set('pinned', '---\nmodel: gpt-6.1-sol\norchestrator: codex-cli\n---\nBody');
    const plain = await plan({ cli: 'claude-code', persona: 'pinned' });
    expect(plain).toMatchObject({ provider: 'claude-code', keep: ['orchestrator', 'model'] });
    expect(plain!.model).toBeUndefined();
    expect(plain!.routing).toMatchObject({ reason: 'explicit_request', source: { model: 'cli_default' } });

    const preset = await plan({ cli: 'claude-code', difficulty: 'easy', persona: 'pinned' });
    expect(preset).toMatchObject({ provider: 'claude-code', model: 'haiku', effort: 'low', keep: ['orchestrator', 'model'] });
  });

  it('refuses a persona\'s model the helper\'s CLI doesn\'t list, in preset mode, instead of launching it', async () => {
    W.personas.set('pinned', '---\nmodel: opus\n---\nBody');
    const result = await planHelperStart({ ...base, orchestratorCli: 'codex-cli', difficulty: 'hard', persona: 'pinned' });
    expect(result).toMatchObject({ ok: false, code: 'no_valid_mapping' });
    if (result.ok === false) {
      expect(result.message).toContain('persona');
      expect(result.message).toContain('opus');
      expect(result.userReason).toContain('persona');
    }
  });

  it('a persona\'s model the list may just not know yet is used, and says so', async () => {
    W.personas.set('pinned', '---\nmodel: new-model\n---\nBody');
    W.lists.set('codex-cli', fallback([m('gpt-5')]));
    const result = await plan({ orchestratorCli: 'codex-cli', difficulty: 'hard', persona: 'pinned' });
    expect(result).toMatchObject({ model: 'new-model' });
    expect(result!.routing).toMatchObject({ reason: 'persona_pinned', fallback: 'model_unverified' });
    expect(result!.warning).toContain('fallback model list');
  });

  it('outside preset mode, a persona\'s model the CLI doesn\'t list only warns: the request didn\'t ask for a preset', async () => {
    W.personas.set('pinned', '---\nmodel: opus\n---\nBody');
    const result = await plan({ cli: 'codex-cli', persona: 'pinned' });
    expect(result).toMatchObject({ provider: 'codex-cli', model: 'opus' });
    expect(result!.warning).toContain('opus');
  });

  it('a persona\'s model the CLI lists is used with no warning', async () => {
    W.personas.set('pinned', '---\nmodel: sonnet\n---\nBody');
    const result = await plan({ difficulty: 'hard', persona: 'pinned' });
    expect(result).toMatchObject({ model: 'sonnet' });
    expect(result!.warning).toBeUndefined();
    expect(result!.routing.fallback).toBe('none');
  });

  it('a persona that can\'t be read pins nothing', async () => {
    const result = await plan({ difficulty: 'easy', persona: 'missing' });
    expect(result).toMatchObject({ provider: 'claude-code', model: 'haiku' });
  });

  it('refuses a difficulty on a CLI with no presets, with a reason', async () => {
    const result = await planHelperStart({ ...base, cli: 'copilot-cli', difficulty: 'easy' });
    expect(result).toMatchObject({ ok: false, code: 'auto_not_supported' });
  });
});

describe('planHelperStart: stale and unverified presets', () => {
  it('uses the built-in for a stale saved model, and says so', async () => {
    W.saved = { 'codex-cli': { hard: { model: 'gone', effort: 'high' } } };
    const result = await plan({ difficulty: 'hard', cli: 'codex-cli' });
    expect(result).toMatchObject({ model: 'gpt-6.1-sol', effort: 'high' });
    expect(result!.routing).toMatchObject({ fallback: 'builtin_preset', source: { model: 'builtin_mapping' } });
    expect(W.saved['codex-cli'].hard.model).toBe('gone');
  });

  it('validates effort too: a good model with a bad effort is stale, never run at a default', async () => {
    W.saved = { 'codex-cli': { hard: { model: 'gpt-6-luna', effort: 'ultra' } } };
    const result = await plan({ difficulty: 'hard', cli: 'codex-cli' });
    expect(result).toMatchObject({ model: 'gpt-6.1-sol', effort: 'high' });
    expect(result!.routing.fallback).toBe('builtin_preset');
  });

  it('refuses with no_valid_mapping when nothing valid is left, naming why, and never picks the CLI default', async () => {
    W.lists.set('codex-cli', live([m('gpt-6-luna')]));
    W.saved = { 'codex-cli': { hard: { model: 'gone', effort: 'high' } } };
    const result = await planHelperStart({ ...base, difficulty: 'hard', cli: 'codex-cli' });
    expect(result).toMatchObject({ ok: false, code: 'no_valid_mapping' });
    if (result.ok === false) {
      expect(result.message).toContain('your saved choice');
      expect(result.message).toContain('the default');
      expect(result.message).toContain('gone');
    }
  });

  it('a list that may be stale doesn\'t refuse: usable, and it says so', async () => {
    W.lists.set('codex-cli', fallback([m('gpt-5')]));
    const result = await plan({ difficulty: 'hard', cli: 'codex-cli' });
    expect(result).toMatchObject({ model: 'gpt-6.1-sol', effort: 'high' });
    expect(result!.routing.fallback).toBe('model_unverified');
    expect(result!.warning).toContain('fallback model list');
  });

  it('a list that can\'t be read doesn\'t refuse either', async () => {
    W.lists.set('codex-cli', new Error('handshake timed out'));
    const result = await plan({ difficulty: 'hard', cli: 'codex-cli' });
    expect(result!.routing.fallback).toBe('model_unverified');
    expect(result!.warning).toContain('handshake timed out');
  });

  it('a saved "default" is stale, so a hard start never runs on an unknown default', async () => {
    W.saved = { 'codex-cli': { hard: { model: 'default', effort: null } } };
    const result = await plan({ difficulty: 'hard', cli: 'codex-cli' });
    expect(result).toMatchObject({ model: 'gpt-6.1-sol', effort: 'high' });
    expect(result!.routing).toMatchObject({ fallback: 'builtin_preset', source: { model: 'builtin_mapping' } });
  });

  it('a cell can leave the level to the CLI', async () => {
    W.saved = { 'claude-code': { hard: { model: 'opus', effort: null } } };
    const result = await plan({ difficulty: 'hard' });
    expect(result!.model).toBe('opus');
    expect(result!.effort).toBeUndefined();
    expect(result!.routing.source.effort).toBe('cli_default');
  });
});

describe('readHelperRouting', () => {
  it('returns every provider, with Copilot excluded and a reason', async () => {
    const settings = await readHelperRouting();
    expect(Object.keys(settings.providers).sort()).toEqual(['claude-code', 'codex-cli', 'copilot-cli']);
    expect(settings.providers['copilot-cli']).toEqual({
      autoEligible: false, reason: 'auto_not_supported', cells: null, quota: { state: 'unknown', unknownReason: 'not_supported', source: 'none', asOf: null },
    });
    expect(settings.serverTime).toEqual(expect.any(String));
    expect(settings.providers['codex-cli']).toMatchObject({
      autoEligible: true,
      choices: { source: 'live', asOf: new Date(1000).toISOString() },
      cells: { easy: { state: 'valid', source: 'builtin', custom: null, editable: true, effective: { model: 'gpt-6-luna', effort: 'low' } } },
    });
    expect(Object.keys(settings.labels)).toEqual(['reason', 'fallback', 'skipped', 'quota', 'unknown', 'window', 'cell', 'generic']);
  });

  it('shows a stale saved choice with what is used instead, and nothing when nothing is left', async () => {
    W.saved = { 'codex-cli': { hard: { model: 'gone', effort: 'high' } } };
    let view = (await readHelperRouting()).providers['codex-cli'];
    if (!view.autoEligible) throw new Error('eligible');
    expect(view.cells.hard).toMatchObject({ state: 'stale', staleReason: 'model_unavailable', fallback: 'builtin_preset', source: 'builtin', custom: { model: 'gone' }, effective: { model: 'gpt-6.1-sol' } });
    W.lists.set('codex-cli', live([m('gpt-6-luna')]));
    view = (await readHelperRouting()).providers['codex-cli'];
    if (!view.autoEligible) throw new Error('eligible');
    expect(view.cells.hard).toMatchObject({ state: 'stale', effective: null, source: 'custom' });
  });

  it('shows a saved "default" as stale, and doesn\'t offer default as a choice', async () => {
    W.lists.set('claude-code', live([m('default', ['low'], { isDefault: true }), ...CLAUDE.slice(1)]));
    W.saved = { 'claude-code': { hard: { model: 'default', effort: null } } };
    const view = (await readHelperRouting()).providers['claude-code'];
    if (!view.autoEligible) throw new Error('eligible');
    expect(view.choices.models.map((c) => c.id)).not.toContain('default');
    expect(view.cells.hard).toMatchObject({ state: 'stale', staleReason: 'model_unavailable', fallback: 'builtin_preset', effective: { model: 'opus' } });
  });

  it('choices are what a write accepts: app-wide, even when cells are read under a project\'s profile', async () => {
    const { getProvider } = await import('../orchestrators');
    const provider = getProvider('codex-cli' as never)!;
    const asked: Array<unknown> = [];
    const original = provider.listModels;
    provider.listModels = async (options?: { env?: unknown }) => { asked.push(options?.env ?? null); return options?.env ? live([m('gpt-6-luna')]) : live(CODEX); };
    vi.mocked(resolveProfileEnv).mockResolvedValue({ CODEX_HOME: '/profile' });
    try {
      const view = (await readHelperRouting({ projectPath: '/p' })).providers['codex-cli'];
      if (!view.autoEligible) throw new Error('eligible');
      expect(view.choices.models.map((c) => c.id)).toEqual(CODEX.map((c) => c.id));
      // The state says what a start in that project would do.
      expect(view.cells.hard).toMatchObject({ state: 'stale', effective: null });
      // So a value picked from the choices is one the write takes.
      await updateHelperPresets({ revision: helperRoutingRevision(), cells: [{ provider: 'codex-cli', difficulty: 'hard', model: 'gpt-6.1-terra', effort: 'high' }] } as never, { surface: 'mobile' });
      expect(W.saved['codex-cli'].hard.model).toBe('gpt-6.1-terra');
    } finally {
      provider.listModels = original;
      vi.mocked(resolveProfileEnv).mockReset();
      vi.mocked(resolveProfileEnv).mockResolvedValue(undefined);
    }
  });

  it('moves the revision when a cell\'s state changes, once, and tells listeners, with no write', async () => {
    const changed: string[] = [];
    onHelperRoutingChanged((revision) => changed.push(revision));
    const first = (await readHelperRouting()).revision;
    expect((await readHelperRouting()).revision).toBe(first);
    W.lists.set('codex-cli', live([m('gpt-6-luna')]));
    const second = (await readHelperRouting()).revision;
    expect(second).not.toBe(first);
    expect(changed).toEqual([second]);
    expect(W.revision).toBe(0);
  });

  it('a read under a project\'s profile doesn\'t move it: another login can list other models', async () => {
    const first = (await readHelperRouting()).revision;
    W.lists.set('codex-cli', live([m('gpt-6-luna')]));
    expect((await readHelperRouting({ projectPath: '/p' })).revision).toBe(first);
  });
});

describe('updateHelperPresets', () => {
  const cell = (fields: Record<string, unknown> = {}) => ({ provider: 'codex-cli', difficulty: 'easy', model: 'gpt-6.1-terra', effort: 'low', ...fields });
  const update = (fields: Record<string, unknown>) => updateHelperPresets({ revision: helperRoutingRevision(), ...fields } as never, { surface: 'mobile' });
  const refusal = async (promise: Promise<unknown>) => promise.then(() => { throw new Error('not refused'); }, (err: HelperRoutingError) => err);

  it('saves a change, moves the revision, audits and tells listeners', async () => {
    const changed: string[] = [];
    onHelperRoutingChanged((revision) => changed.push(revision));
    const settings = await update({ cells: [cell()] });
    expect(W.saved).toEqual({ 'codex-cli': { easy: { model: 'gpt-6.1-terra', effort: 'low' } } });
    expect(W.revision).toBe(1);
    expect(settings.revision).toBe(helperRoutingRevision());
    expect(changed).toEqual([settings.revision]);
    expect(W.audit).toEqual([{ surface: 'mobile', scope: 'app', key: 'helper_presets.codex-cli.easy', before: null, after: 'gpt-6.1-terra/low', outcome: 'ok' }]);
    expect(W.telemetry).toEqual([['set', 'mobile', true]]);
  });

  it('doesn\'t keep a value equal to the built-in', async () => {
    W.saved = { 'codex-cli': { easy: { model: 'gpt-6.1-terra', effort: 'low' } } };
    await update({ cells: [cell({ model: 'gpt-6-luna', effort: 'low' })] });
    expect(W.saved).toEqual({});
  });

  it('refuses a stale write, changes nothing, and returns fresh values', async () => {
    const old = helperRoutingRevision();
    await update({ cells: [cell()] });
    const saved = JSON.stringify(W.saved);
    const err = await refusal(updateHelperPresets({ revision: old, cells: [cell({ model: 'gpt-6-luna' })] } as never, { surface: 'ui' }));
    expect(err).toBeInstanceOf(HelperRoutingError);
    expect((err as HelperRoutingError).code).toBe('helper_routing_stale');
    expect((err as HelperRoutingError).settings?.revision).toBe(helperRoutingRevision());
    expect(JSON.stringify(W.saved)).toBe(saved);
    expect(W.audit.at(-1)).toMatchObject({ outcome: 'refused', code: 'helper_routing_stale' });
    expect(W.telemetry.at(-1)).toEqual(['set', 'ui', false]);
  });

  it('a list changing state doesn\'t make an open page\'s write stale', async () => {
    await readHelperRouting();
    const open = helperRoutingRevision();
    W.lists.set('claude-code', live([m('sonnet')]));
    await readHelperRouting();
    expect(helperRoutingRevision()).not.toBe(open);
    await updateHelperPresets({ revision: open, cells: [cell()] } as never, { surface: 'ui' });
    expect(W.revision).toBe(1);
  });

  it('runs writes one at a time, so a second from the same revision is stale', async () => {
    const revision = helperRoutingRevision();
    const [a, b] = await Promise.allSettled([
      updateHelperPresets({ revision, cells: [cell()] } as never, { surface: 'ui' }),
      updateHelperPresets({ revision, cells: [cell({ model: 'gpt-6.1-sol' })] } as never, { surface: 'ui' }),
    ]);
    expect(a.status).toBe('fulfilled');
    expect(b).toMatchObject({ status: 'rejected', reason: { code: 'helper_routing_stale' } });
  });

  it.each([
    [{ model: 'gone' }, 'model_unavailable'],
    [{ effort: 'ultra' }, 'effort_unavailable'],
  ])('refuses %j against a live list', async (fields, code) => {
    expect(await refusal(update({ cells: [cell(fields)] }))).toMatchObject({ code });
    expect(W.saved).toEqual({});
  });

  it('accepts a value a fallback list lacks, shown as unverified', async () => {
    W.lists.set('codex-cli', fallback([m('old')]));
    const view = (await update({ cells: [cell({ model: 'new-model' })] })).providers['codex-cli'];
    if (!view.autoEligible) throw new Error('eligible');
    expect(view.cells.easy).toMatchObject({ state: 'unverified', fallback: 'model_unverified', effective: { model: 'new-model' } });
  });

  it.each([
    ['Copilot', { cells: [cell({ provider: 'copilot-cli' })] }],
    ['a bad difficulty', { cells: [cell({ difficulty: 'extreme' })] }],
    ['a model that could be an argument', { cells: [cell({ model: '-c' })] }],
    ['the CLI\'s default, which a preset can\'t be', { cells: [cell({ model: 'default', effort: null })] }],
    ['a bad effort', { cells: [cell({ effort: 'a b' })] }],
    ['nothing to do', {}],
    ['a difficulty reset with no provider', { reset: { difficulty: 'easy' } }],
    ['a reset of an unknown provider', { reset: { provider: 'copilot-cli' } }],
  ])('refuses %s', async (_name, fields) => {
    expect(await refusal(update(fields))).toMatchObject({ code: 'invalid_helper_routing' });
    expect(W.revision).toBe(0);
  });

  it('refuses a missing or malformed revision', async () => {
    expect(await refusal(updateHelperPresets({ revision: 'nope', cells: [cell()] } as never, { surface: 'ui' }))).toMatchObject({ code: 'invalid_helper_routing' });
  });

  it('resets one cell, one provider or all', async () => {
    W.saved = {
      'codex-cli': { easy: { model: 'a', effort: null }, hard: { model: 'b', effort: null } },
      'claude-code': { easy: { model: 'c', effort: null } },
    };
    await update({ reset: { provider: 'codex-cli', difficulty: 'easy' } });
    expect(W.saved).toEqual({ 'codex-cli': { hard: { model: 'b', effort: null } }, 'claude-code': { easy: { model: 'c', effort: null } } });
    expect(W.telemetry.at(-1)).toEqual(['reset_cell', 'mobile', true]);
    await update({ reset: { provider: 'codex-cli' } });
    expect(W.saved).toEqual({ 'claude-code': { easy: { model: 'c', effort: null } } });
    expect(W.telemetry.at(-1)).toEqual(['reset_provider', 'mobile', true]);
    await update({ reset: {} });
    expect(W.saved).toEqual({});
    expect(W.telemetry.at(-1)).toEqual(['reset_all', 'mobile', true]);
    expect(W.audit.filter((r) => r.after === null).map((r) => r.key)).toEqual([
      'helper_presets.codex-cli.easy', 'helper_presets.codex-cli.hard', 'helper_presets.claude-code.easy',
    ]);
  });
});
