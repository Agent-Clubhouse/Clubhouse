import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelInfo, ModelList } from '../orchestrators';

const W = vi.hoisted(() => ({
  lists: new Map<string, unknown>(),
  personas: new Map<string, string>(),
  saved: {} as Record<string, Record<string, { model: string; effort: string | null }>>,
  revision: 0,
  audit: [] as Array<Record<string, unknown>>,
  telemetry: [] as unknown[][],
  appAuto: false,
  enabled: [] as string[],
  projects: new Map<string, Record<string, unknown>>(),
  quota: new Map<string, unknown>(),
  cooling: new Set<string>(),
  unavailable: new Set<string>(),
}));

vi.mock('../orchestrators', () => {
  const provider = (id: string) => ({
    id,
    checkAvailability: async () => ({ available: !W.unavailable.has(id) }),
    listModels: async () => { const list = W.lists.get(id); if (list instanceof Error) throw list; return list ?? null; },
    acceptsModel: (m: string, l: { models: Array<{ id: string; resolvedId?: string }> }) => m === 'default' || l.models.some((e) => e.id === m || e.resolvedId === m),
  });
  const all = ['claude-code', 'codex-cli', 'copilot-cli'].map(provider);
  return { getProvider: (id: string) => all.find((p) => p.id === id), getAllProviders: () => all };
});
vi.mock('./agent-system', () => ({ resolveProfileEnv: vi.fn(async () => undefined) }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./mcp-settings', () => ({ onMcpEnablementChanged: () => () => undefined }));
vi.mock('./materialization-service', () => ({ readLayeredPersonaRaw: async (_p: string, id: string) => W.personas.get(id) }));
vi.mock('./orchestration-settings', () => ({
  getPresets: () => W.saved,
  getPresetsRevision: () => W.revision,
  savePresets: async (presets: typeof W.saved) => { W.saved = presets; W.revision++; },
  getAutoHelpers: () => W.appAuto,
  saveAutoHelpers: async (on: boolean) => { W.appAuto = on; W.revision++; },
  bumpPresetsRevision: async () => { W.revision++; },
}));
vi.mock('./orchestrator-settings', () => ({ getSettings: () => ({ enabled: W.enabled }) }));
vi.mock('./agent-settings-service', () => ({
  readProjectAgentDefaults: async (path: string) => W.projects.get(path) ?? {},
  // As the real one does, for a change that decides Auto.
  writeProjectAgentDefaults: async (path: string, defaults: Record<string, unknown>) => {
    const changed = W.projects.get(path)?.helperAuto !== defaults.helperAuto;
    W.projects.set(path, defaults);
    if (changed) noteRoutingPolicyChanged();
  },
}));
vi.mock('./provider-quota', () => ({
  readProviderQuota: async (provider: string) => W.quota.get(provider) ?? { state: 'unknown', unknownReason: 'not_supported', source: 'none', asOf: null },
  isProviderCoolingDown: async (provider: string) => W.cooling.has(provider),
}));
vi.mock('./agent-runtime/chat-event-bus', () => ({ onChatEvent: () => () => undefined }));
vi.mock('./settings-audit', async (importOriginal) => ({
  ...await importOriginal<typeof import('./settings-audit')>(),
  appendSettingsAudit: async (row: Record<string, unknown>) => { W.audit.push(row); return true; },
}));
vi.mock('../telemetry/feature-events', () => ({ helperAutoRefused: () => undefined, helperPresetsChanged: (...args: unknown[]) => { W.telemetry.push(args); } }));

import { resolveProfileEnv } from './agent-system';
import {
  HelperRoutingError,
  _resetHelperRoutingForTesting,
  _settleHelperRoutingForTesting,
  decideAutoPlan,
  helperRoutingRevision,
  onHelperRoutingChanged,
  planHelperStart,
  readHelperAuto,
  readHelperRouting,
  releaseAutoHelper,
  reserveAutoHelper,
  reservedLoad,
  updateHelperPresets,
} from './helper-routing';
import { AUTO_RESERVATION_MS, AUTO_STICKY_MS } from './helper-auto-policy';
import { noteRoutingPolicyChanged } from './helper-routing-changes';
import { resolveOrchestrationPolicy } from '../../shared/orchestration-policy';

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
  W.appAuto = false;
  W.enabled = [];
  W.projects = new Map();
  W.quota = new Map();
  W.cooling = new Set();
  W.unavailable = new Set();
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
    expect(Object.keys(settings.labels)).toEqual(['reason', 'fallback', 'skipped', 'quota', 'unknown', 'window', 'autoSource', 'autoOff', 'cell', 'generic']);
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

describe('Auto (#2671)', () => {
  const on = { effective: true, source: 'app' as const, scopes: { app: { value: true, editable: true } } };
  const off = { effective: false, source: 'project' as const, reason: 'project_off' as const, scopes: { app: { value: true, editable: true } } };
  const auto = (extra: Record<string, unknown> = {}) => planHelperStart({
    ...base, cli: 'auto', difficulty: 'hard', auto: on, orchestratorId: 'orch', orchestratorCli: 'claude-code', ...extra,
  });
  const known = { state: 'known', source: 'cli_query', asOf: '2027-01-15T08:00:00.000Z', limitingWindow: 'weekly' };
  const decided = async (load: Record<string, number> = {}, extra: Record<string, unknown> = {}) => {
    const prepared = await auto(extra);
    if (prepared.ok === false) throw new Error(prepared.message);
    const result = decideAutoPlan(prepared.plan!, load);
    if (result.ok === false) throw new Error(result.message);
    return result.plan!;
  };

  beforeEach(() => {
    W.quota.set('claude-code', known);
    W.quota.set('codex-cli', known);
  });

  it('refuses when Auto is off, saying why, and reads nothing', async () => {
    const result = await planHelperStart({ ...base, cli: 'auto', difficulty: 'hard', auto: off });
    expect(result).toMatchObject({ ok: false, code: 'auto_off' });
    if (result.ok === false) expect(result.message).toContain('This project turned it off');
  });

  it('decides under the lock: nothing is chosen until then', async () => {
    const prepared = await auto();
    if (prepared.ok === false) throw new Error('refused');
    expect(prepared.plan!.pendingAuto).toBeDefined();
    expect(prepared.plan!.provider).toBeUndefined();
  });

  it('records the whole decision', async () => {
    const plan = await decided({ 'claude-code': 2 });
    expect(plan).toMatchObject({ provider: 'codex-cli', model: 'gpt-6.1-sol', effort: 'high', keep: ['orchestrator', 'model'] });
    expect(plan.routing).toMatchObject({
      mode: 'auto', balanced: true, policyVersion: 1, reason: 'lower_load', fallback: 'none', quotaBasis: 'known',
      requested: { provider: 'auto', model: null, effort: null, difficulty: 'hard' },
      resolved: { provider: 'codex-cli', model: 'gpt-6.1-sol', effort: 'high', difficulty: 'hard' },
      source: { provider: 'auto', model: 'builtin_mapping', effort: 'builtin_mapping' },
      load: { 'claude-code': 2, 'codex-cli': 0 },
      quota: { 'codex-cli': { state: 'known', asOf: known.asOf, limitingWindow: 'weekly' }, 'claude-code': { state: 'known' } },
    });
  });

  it('unknown quota can win, says so, and is never recorded as anything else', async () => {
    W.quota.set('claude-code', { state: 'unknown', unknownReason: 'read_failed', source: 'none', asOf: null });
    const plan = await decided();
    expect(plan.provider).toBe('claude-code');
    expect(plan.routing).toMatchObject({ quotaBasis: 'unknown_scored_as_healthy', quota: { 'claude-code': { state: 'unknown', unknownReason: 'read_failed', asOf: null } } });
  });

  it('a persona\'s pin decides, so nothing claims Auto balanced it', async () => {
    W.personas.set('pinned', '---\nmodel: gpt-6.1-terra\norchestrator: codex-cli\n---\nBody');
    const result = await auto({ persona: 'pinned' });
    if (result.ok === false) throw new Error('refused');
    expect(result.plan!.pendingAuto).toBeUndefined();
    expect(result.plan).toMatchObject({ provider: 'codex-cli', model: 'gpt-6.1-terra' });
    expect(result.plan!.routing).toMatchObject({ mode: 'auto', balanced: false, reason: 'persona_pinned', requested: { provider: 'auto' }, source: { provider: 'persona', model: 'persona' } });
  });

  it.each([
    ['cli_disabled', () => { W.enabled = ['claude-code']; }],
    ['cli_unavailable', () => { W.unavailable.add('codex-cli'); }],
    ['cooling_down', () => { W.cooling.add('codex-cli'); }],
    ['no_valid_mapping', () => { W.lists.set('codex-cli', live([m('other')])); }],
    ['quota_exhausted', () => { W.quota.set('codex-cli', { ...known, state: 'exhausted' }); }],
    ['quota_near_limit', () => { W.quota.set('codex-cli', { ...known, state: 'near_limit' }); }],
  ])('skips a provider for %s, and says so', async (code, setup) => {
    setup();
    const plan = await decided({ 'claude-code': 9 });
    expect(plan.provider).toBe('claude-code');
    expect(plan.routing.skipped).toMatchObject({ 'codex-cli': code });
    expect(plan.routing).toMatchObject({ fallback: 'candidate_skipped', balanced: true });
  });

  it('lists Copilot as skipped with its reason', async () => {
    const plan = await decided();
    expect(plan.routing.skipped).toEqual({ 'copilot-cli': 'auto_not_supported' });
  });

  it('with nothing left, refuses at once, naming each provider, and queues nothing', async () => {
    W.cooling.add('claude-code');
    W.quota.set('codex-cli', { ...known, state: 'near_limit' });
    const result = await auto();
    expect(result).toMatchObject({ ok: false, code: 'no_candidate' });
    if (result.ok === false) {
      expect(result.message).toContain('claude-code: It failed to start recently');
      expect(result.message).toContain('codex-cli: Close to its limit');
      expect(result.message).toContain('Don\'t retry in a loop');
      expect(result.userReason).not.toContain('retry');
    }
  });

  it('a saved preset that went stale falls back to the built-in, and says that over skips', async () => {
    W.saved = { 'codex-cli': { hard: { model: 'gone', effort: 'high' } } };
    const plan = await decided({ 'claude-code': 2 });
    expect(plan.routing).toMatchObject({ fallback: 'builtin_preset', resolved: { model: 'gpt-6.1-sol' } });
  });

  describe('sticky', () => {
    it('holds for the same orchestrator and difficulty, then expires', async () => {
      vi.useFakeTimers({ now: 1_800_000_000_000 });
      try {
        expect((await decided({ 'claude-code': 2 })).provider).toBe('codex-cli');
        const held = await decided({ 'claude-code': 2, 'codex-cli': 1 });
        expect(held).toMatchObject({ provider: 'codex-cli', routing: { reason: 'sticky' } });
        // Another orchestrator or difficulty isn't held.
        expect((await decided({}, { orchestratorId: 'other' })).provider).toBe('claude-code');
        expect((await decided({}, { difficulty: 'easy' })).provider).toBe('claude-code');
        vi.setSystemTime(1_800_000_000_000 + AUTO_STICKY_MS + 1);
        expect((await decided()).provider).toBe('claude-code');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('reservations', () => {
    it('counts a chosen helper until it is seen live or released, without counting it twice', () => {
      reserveAutoHelper('h1', 'codex-cli');
      reserveAutoHelper('h2', 'codex-cli');
      expect(reservedLoad(new Set())).toEqual({ 'codex-cli': 2 });
      expect(reservedLoad(new Set(['h1']))).toEqual({ 'codex-cli': 1 });
      releaseAutoHelper('h2');
      expect(reservedLoad(new Set())).toEqual({ 'codex-cli': 1 });
    });

    it('has a backstop', () => {
      vi.useFakeTimers({ now: 1_800_000_000_000 });
      try {
        reserveAutoHelper('h1', 'codex-cli');
        vi.setSystemTime(1_800_000_000_000 + AUTO_RESERVATION_MS);
        expect(reservedLoad(new Set())).toEqual({});
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('readHelperAuto', () => {
    const config = (autoHelpers?: boolean) => ({ id: 'a', orchestration: autoHelpers === undefined ? {} : { autoHelpers } }) as never;
    const policy = (agent: object = { orchestrate: true }, persona: object = {}, options: object = {}) => resolveOrchestrationPolicy(agent, persona, options);
    const read = (autoHelpers: boolean | undefined, p = policy(), projectPath?: string) => readHelperAuto({ agent: { config: config(autoHelpers), policy: p }, ...(projectPath && { projectPath }) });

    it('is off by default, and follows the app', async () => {
      expect(await readHelperAuto()).toMatchObject({ effective: false, source: 'default', reason: 'not_enabled', scopes: { app: { value: false, editable: true } } });
      W.appAuto = true;
      expect(await readHelperAuto()).toMatchObject({ effective: true, source: 'app' });
    });

    it('the orchestrator\'s own choice wins over the app, either way', async () => {
      W.appAuto = true;
      expect(await read(false, policy({ orchestrate: true, autoHelpers: false }))).toMatchObject({ effective: false, source: 'agent', reason: 'not_enabled' });
      W.appAuto = false;
      expect(await read(true, policy({ orchestrate: true, autoHelpers: true }))).toMatchObject({ effective: true, source: 'agent', scopes: { agent: { value: true, editable: true } } });
    });

    it('a project can turn it off over everything, and never on', async () => {
      W.appAuto = true;
      W.projects.set('/p', { helperAuto: 'off' });
      expect(await read(true, policy({ orchestrate: true, autoHelpers: true }), '/p')).toMatchObject({ effective: false, source: 'project', reason: 'project_off', scopes: { project: { value: 'off', editable: true } } });
      // Nothing a project file can say turns it on.
      W.appAuto = false;
      W.projects.set('/p', { helperAuto: 'on' });
      expect(await readHelperAuto({ projectPath: '/p' })).toMatchObject({ effective: false, source: 'default' });
    });

    it('a persona can turn it off and never on', async () => {
      W.appAuto = true;
      expect(await read(undefined, policy({ orchestrate: true }, { autoHelpers: false }))).toMatchObject({ effective: false, source: 'persona', reason: 'persona_off', scopes: { persona: { value: false, editable: false } } });
      W.appAuto = false;
      expect(await read(undefined, policy({ orchestrate: true }, { autoHelpers: true }))).toMatchObject({ effective: false, source: 'default' });
    });

    it('no MCP, no Auto, whatever is saved', async () => {
      W.appAuto = true;
      expect(await read(true, policy({ orchestrate: true, autoHelpers: true }, {}, { mcpOff: true }))).toMatchObject({ effective: false, source: 'mcp_off', reason: 'mcp_off', scopes: { agent: { value: true, editable: true } } });
    });

    it('an agent that doesn\'t orchestrate can\'t use it', async () => {
      W.appAuto = true;
      expect(await read(undefined, policy({ orchestrate: false }))).toMatchObject({ effective: false, reason: 'orchestration_off' });
    });

    it('the Dispatcher is locked', async () => {
      W.appAuto = true;
      expect(await readHelperAuto({ dispatcher: true })).toMatchObject({ effective: false, source: 'dispatcher_locked', reason: 'dispatcher_locked', scopes: { app: { editable: false }, agent: { value: null, editable: false } } });
    });

    it('a persona\'s off beats the agent\'s own on, whose value stays', async () => {
      const result = await read(true, policy({ orchestrate: true, autoHelpers: true }, { autoHelpers: false }));
      expect(result).toMatchObject({ effective: false, source: 'persona', reason: 'persona_off', scopes: { persona: { value: false }, agent: { value: true } } });
    });
  });

  describe('writing it', () => {
    const write = (fields: Record<string, unknown>, origin: Record<string, unknown> = {}) => updateHelperPresets({ revision: helperRoutingRevision(), ...fields } as never, { surface: 'mobile', ...origin });
    const refused = (promise: Promise<unknown>) => promise.then(() => { throw new Error('not refused'); }, (err: HelperRoutingError) => err);

    it('app-wide takes a boolean, moves the revision, audits and returns fresh values', async () => {
      const settings = await write({ auto: true });
      expect(W.appAuto).toBe(true);
      expect(W.revision).toBe(1);
      expect(settings.auto).toMatchObject({ effective: true, source: 'app' });
      expect(W.audit).toEqual([{ surface: 'mobile', scope: 'app', key: 'helper_auto', before: false, after: true, outcome: 'ok' }]);
      expect(W.telemetry).toEqual([['toggle', 'mobile', true]]);
    });

    it('a project takes only off or null, keeps its other defaults, and moves the revision', async () => {
      W.projects.set('/p', { persona: 'qa' });
      let settings = await write({ auto: 'off' }, { projectPath: '/p' });
      expect(W.projects.get('/p')).toEqual({ persona: 'qa', helperAuto: 'off' });
      expect(settings.auto).toMatchObject({ effective: false, source: 'project', reason: 'project_off' });
      await _settleHelperRoutingForTesting();
      expect(W.revision).toBe(1);
      settings = await write({ auto: null }, { projectPath: '/p' });
      await _settleHelperRoutingForTesting();
      expect(W.projects.get('/p')).toEqual({ persona: 'qa' });
      expect(settings.auto.scopes.project?.value).toBeNull();
      expect(await refused(write({ auto: true }, { projectPath: '/p' }))).toMatchObject({ code: 'invalid_helper_routing' });
      expect(await refused(write({ reset: {} }, { projectPath: '/p' }))).toMatchObject({ code: 'invalid_helper_routing' });
    });

    it('a change made elsewhere moves the revision, tells open pages once, and makes an older write stale with fresh values', async () => {
      const changed: string[] = [];
      onHelperRoutingChanged((revision) => changed.push(revision));
      const old = helperRoutingRevision();
      // What the desktop's project defaults save does.
      W.projects.set('/p', { helperAuto: 'off' });
      noteRoutingPolicyChanged();
      await _settleHelperRoutingForTesting();
      expect(helperRoutingRevision()).not.toBe(old);
      expect(changed).toEqual([helperRoutingRevision()]);
      const err = await refused(updateHelperPresets({ revision: old, auto: true } as never, { surface: 'mobile' }));
      expect(err).toMatchObject({ code: 'helper_routing_stale', settings: { revision: helperRoutingRevision() } });
      expect(W.appAuto).toBe(false);
    });

    it('a project write through here moves the revision once and tells pages once', async () => {
      const changed: string[] = [];
      onHelperRoutingChanged((revision) => changed.push(revision));
      await write({ auto: 'off' }, { projectPath: '/p' });
      await _settleHelperRoutingForTesting();
      expect(W.revision).toBe(1);
      expect(changed).toHaveLength(1);
    });

    it('a stale write at a project\'s scope gets that project\'s fresh values, not the app\'s', async () => {
      const old = helperRoutingRevision();
      W.projects.set('/p', { helperAuto: 'off' });
      noteRoutingPolicyChanged();
      await _settleHelperRoutingForTesting();
      // The phone read null and the desktop set off: this null must not clear it.
      const err = await refused(updateHelperPresets({ revision: old, auto: null } as never, { surface: 'mobile', projectPath: '/p' }));
      expect(err).toMatchObject({ code: 'helper_routing_stale', settings: { auto: { source: 'project', reason: 'project_off', scopes: { project: { value: 'off' } } } } });
      expect(W.projects.get('/p')).toEqual({ helperAuto: 'off' });
    });

    it('a project\'s null removes its override, and never enables: the app still decides', async () => {
      W.projects.set('/p', { helperAuto: 'off' });
      const settings = await write({ auto: null }, { projectPath: '/p' });
      expect(settings.auto).toMatchObject({ effective: false, source: 'default', reason: 'not_enabled', scopes: { project: { value: null } } });
    });

    it('app-wide refuses a project\'s values', async () => {
      expect(await refused(write({ auto: 'off' }))).toMatchObject({ code: 'invalid_helper_routing' });
    });

    it('a stale write changes nothing here too', async () => {
      const old = helperRoutingRevision();
      await write({ auto: true });
      expect(await refused(updateHelperPresets({ revision: old, auto: false } as never, { surface: 'ui' }))).toMatchObject({ code: 'helper_routing_stale' });
      expect(W.appAuto).toBe(true);
    });
  });
});
