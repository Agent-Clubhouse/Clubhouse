import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelInfo, ModelList } from '../orchestrators';

const W = vi.hoisted(() => ({
  lists: new Map<string, unknown>(),
  /** What a provider's own cache holds. Only a forced read goes past it. */
  listCache: new Map<string, unknown>(),
  listCalls: [] as Array<{ provider: string; refresh: boolean }>,
  forcedQuota: [] as string[],
  forcedOutcome: 'ok' as string,
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
    listModels: async (opts: { refresh?: boolean } = {}) => {
      W.listCalls.push({ provider: id, refresh: opts.refresh === true });
      if (!opts.refresh && W.listCache.has(id)) return W.listCache.get(id);
      const list = W.lists.get(id);
      if (list instanceof Error) throw list;
      if (W.listCache.has(id)) W.listCache.set(id, list);
      return list ?? null;
    },
    acceptsModel: (m: string, l: { models: Array<{ id: string; resolvedId?: string }> }) => m === 'default' || l.models.some((e) => e.id === m || e.resolvedId === m),
  });
  const all = ['claude-code', 'codex-cli', 'copilot-cli'].map(provider);
  return { getProvider: (id: string) => all.find((p) => p.id === id), getAllProviders: () => all };
});
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./settings-store', () => ({
  createSettingsStore: <T>(_file: string, defaults: T) => {
    let value = JSON.parse(JSON.stringify(defaults)) as T;
    return { get: () => value, save: async (next: T) => { value = next; }, update: async (fn: (v: T) => T) => (value = fn(value)) };
  },
}));
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
  forceProviderQuota: async (provider: string) => {
    W.forcedQuota.push(provider);
    return { quota: W.quota.get(provider) ?? { state: 'unknown', unknownReason: 'not_supported', source: 'none', asOf: null }, outcome: W.forcedOutcome };
  },
  isProviderCoolingDown: async (provider: string) => W.cooling.has(provider),
}));
vi.mock('./agent-runtime/chat-event-bus', () => ({ onChatEvent: () => () => undefined }));
vi.mock('./settings-audit', async (importOriginal) => ({
  ...await importOriginal<typeof import('./settings-audit')>(),
  appendSettingsAudit: async (row: Record<string, unknown>) => { W.audit.push(row); return true; },
}));
vi.mock('../telemetry/feature-events', () => ({ helperAutoRefused: () => undefined, helperPresetsChanged: (...args: unknown[]) => { W.telemetry.push(args); } }));

import { appLog } from './log-service';
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
  resolveAutoLevel,
  resolveProviderMaximum,
  resolveProviderMinimum,
  startDecisionRecord,
  updateHelperPresets,
} from './helper-routing';
import { commitAutoDecision, reservedLoad, rotationCursors, settleAutoDecision } from './helper-auto-state';
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
  W.listCache = new Map();
  W.listCalls = [];
  W.forcedQuota = [];
  W.forcedOutcome = 'ok';
  vi.mocked(appLog).mockClear();
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
  });

  it('a difficulty alone stays on the orchestrator\'s CLI and uses the built-in', async () => {
    const result = await plan({ difficulty: 'hard', orchestratorCli: 'codex-cli' });
    expect(result).toMatchObject({ provider: 'codex-cli', model: 'gpt-6.1-sol', effort: 'high' });
    expect(result!.routing).toMatchObject({
      mode: 'preset', balanced: false, policyVersion: 2, reason: 'preset_on_cli', fallback: 'none',
      requested: { provider: null, model: null, effort: null, difficulty: 'hard' },
      resolved: { provider: 'codex-cli', model: 'gpt-6.1-sol', effort: 'high', difficulty: 'hard' },
      source: { provider: 'orchestrator', model: 'builtin_mapping', effort: 'builtin_mapping' },
    });
  });

  it('a difficulty with a named CLI uses that CLI\'s preset, and never moves away from it', async () => {
    const result = await plan({ difficulty: 'easy', cli: 'codex-cli' });
    expect(result).toMatchObject({ provider: 'codex-cli', model: 'gpt-6-luna', effort: 'low' });
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
    expect(result).toMatchObject({ model: 'sonnet' });
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
    expect(result).toMatchObject({ provider: 'codex-cli', model: 'gpt-6.1-sol', effort: 'high' });
    expect(result!.routing).toMatchObject({
      mode: 'explicit', balanced: false, reason: 'explicit_request',
      requested: { provider: 'codex-cli', model: 'gpt-6.1-sol', effort: 'high', difficulty: null },
      source: { provider: 'request', model: 'request', effort: 'request' },
    });
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

  it('a read for a project doesn\'t move it', async () => {
    const first = (await readHelperRouting()).revision;
    W.lists.set('codex-cli', live([m('gpt-6-luna')]));
    expect((await readHelperRouting({ projectPath: '/p' })).revision).toBe(first);
  });
});

describe('readHelperRouting with refresh (#2786)', () => {
  const forcedLines = () => vi.mocked(appLog).mock.calls.filter(([, , message]) => message === 'Helper presets: asked a CLI again');
  const SONNET_SAVED = { 'claude-code': { hard: { model: 'sonnet', effort: 'high' } } };

  it('forces each preset CLI\'s list once, and its quota, and leaves Copilot alone', async () => {
    await readHelperRouting({ refresh: true });
    expect(W.listCalls.filter((c) => c.refresh).map((c) => c.provider).sort()).toEqual(['claude-code', 'codex-cli']);
    expect([...W.forcedQuota].sort()).toEqual(['claude-code', 'codex-cli']);
  });

  it('without it, nothing is forced and the cached list is what cells use', async () => {
    W.listCache.set('claude-code', live([m('opus')]));
    W.saved = SONNET_SAVED;
    const settings = await readHelperRouting();
    expect(W.listCalls.some((c) => c.refresh)).toBe(false);
    expect(W.forcedQuota).toEqual([]);
    expect(forcedLines()).toEqual([]);
    const claude = settings.providers['claude-code'];
    expect(claude.autoEligible && claude.cells.hard.state).toBe('stale');
  });

  it('a cell stale from an old live list is valid after a refresh, and the revision moves', async () => {
    // The state modelled: `stale` with `model_unavailable`, which the page words as
    // "No longer offered". What the #2786 report really showed isn't identified, so
    // this pins what a refresh does for this state, not that it was the report's.
    W.listCache.set('claude-code', live([m('opus'), m('haiku')]));
    W.saved = SONNET_SAVED;
    const before = await readHelperRouting();
    const old = before.providers['claude-code'];
    expect(old.autoEligible && old.cells.hard).toMatchObject({ state: 'stale', staleReason: 'model_unavailable', fallback: 'builtin_preset', custom: { model: 'sonnet' } });
    expect(old.autoEligible && old.choices.models.map((c) => c.id)).toEqual(['opus', 'haiku']);

    const changed: string[] = [];
    onHelperRoutingChanged((revision) => changed.push(revision));
    const after = await readHelperRouting({ refresh: true });
    const fresh = after.providers['claude-code'];
    expect(fresh.autoEligible && fresh.cells.hard).toMatchObject({ state: 'valid', source: 'custom', effective: { model: 'sonnet', effort: 'high' } });
    expect(fresh.autoEligible && fresh.choices.models.map((c) => c.id)).toContain('sonnet');
    expect(after.revision).not.toBe(before.revision);
    expect(changed).toEqual([after.revision]);
  });

  it('changes no saved value and audits nothing', async () => {
    W.saved = SONNET_SAVED;
    await readHelperRouting({ refresh: true });
    expect(W.saved).toEqual(SONNET_SAVED);
    expect(W.revision).toBe(0);
    expect(W.audit).toEqual([]);
    expect(W.telemetry).toEqual([]);
  });

  it('a list that can\'t be read doesn\'t fail the page, and the other CLI still answers', async () => {
    W.lists.set('codex-cli', new Error('probe blew up'));
    const settings = await readHelperRouting({ refresh: true });
    expect(settings.providers['codex-cli']).toMatchObject({ autoEligible: true, choices: { source: 'fallback', models: [] } });
    expect(settings.providers['claude-code']).toMatchObject({ autoEligible: true, choices: { source: 'live' } });
  });

  it('logs one line per provider, with its source, a count and the outcome, and no model names', async () => {
    W.lists.set('codex-cli', new Error('probe blew up'));
    W.forcedOutcome = 'failed';
    await readHelperRouting({ refresh: true });
    const metas = forcedLines().map(([namespace, level, , options]) => ({ namespace, level, ...options?.meta }));
    expect(metas).toHaveLength(2);
    expect(metas).toEqual(expect.arrayContaining([
      { namespace: 'core:mcp', level: 'info', provider: 'claude-code', source: 'live', models: CLAUDE.length, outcome: 'quota_failed' },
      { namespace: 'core:mcp', level: 'info', provider: 'codex-cli', source: 'none', models: 0, outcome: 'list_failed+quota_failed' },
    ]));
    W.lists.set('codex-cli', live(CODEX));
    W.forcedOutcome = 'not_supported';
    vi.mocked(appLog).mockClear();
    await readHelperRouting({ refresh: true });
    expect(forcedLines().map(([, , , options]) => options?.meta?.outcome)).toEqual(['ok', 'ok']);
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

describe('Auto minimum and maximum (#3044)', () => {
  it('an unset minimum uses Easy and an unset maximum uses Hard, as built in', async () => {
    expect(await resolveProviderMinimum('claude-code')).toEqual({
      ok: true, provider: 'claude-code', level: 'minimum', model: 'haiku', effort: 'low', source: 'builtin_mapping', fallback: 'none', follows: 'easy',
    });
    expect(await resolveProviderMaximum('codex-cli')).toEqual({
      ok: true, provider: 'codex-cli', level: 'maximum', model: 'gpt-6.1-sol', effort: 'high', source: 'builtin_mapping', fallback: 'none', follows: 'hard',
    });
  });

  it('an unset minimum follows the person\'s own Easy choice', async () => {
    W.saved = { 'claude-code': { easy: { model: 'sonnet', effort: 'medium' } } };
    expect(await resolveProviderMinimum('claude-code')).toMatchObject({ ok: true, model: 'sonnet', effort: 'medium', source: 'custom_mapping', follows: 'easy' });
  });

  it('a saved minimum or maximum is used as chosen', async () => {
    W.saved = { 'codex-cli': { minimum: { model: 'gpt-6-luna', effort: 'medium' }, maximum: { model: 'gpt-6.1-sol', effort: null } } };
    const min = await resolveProviderMinimum('codex-cli');
    expect(min).toEqual({ ok: true, provider: 'codex-cli', level: 'minimum', model: 'gpt-6-luna', effort: 'medium', source: 'custom_mapping', fallback: 'none' });
    expect(await resolveProviderMaximum('codex-cli')).toMatchObject({ ok: true, model: 'gpt-6.1-sol', effort: null, source: 'custom_mapping' });
  });

  it('a saved minimum no longer offered falls back to Easy, and says so', async () => {
    W.saved = { 'codex-cli': { minimum: { model: 'gone', effort: null } } };
    expect(await resolveProviderMinimum('codex-cli')).toMatchObject({ ok: true, model: 'gpt-6-luna', effort: 'low', fallback: 'builtin_preset', follows: 'easy' });
  });

  it('a minimum a fallback list can\'t check is used, with a warning', async () => {
    W.lists.set('codex-cli', fallback([m('old')]));
    W.saved = { 'codex-cli': { minimum: { model: 'new-model', effort: null } } };
    expect(await resolveProviderMinimum('codex-cli')).toMatchObject({ ok: true, model: 'new-model', fallback: 'model_unverified', warning: expect.any(String) });
  });

  it('refuses when nothing valid is left, naming why, and never picks the CLI default', async () => {
    W.lists.set('codex-cli', live([m('gpt-6.1-terra')]));
    W.saved = { 'codex-cli': { minimum: { model: 'gone', effort: null } } };
    const result = await resolveProviderMinimum('codex-cli');
    expect(result).toMatchObject({ ok: false, code: 'no_valid_mapping' });
    if (result.ok) throw new Error('refused');
    expect(result.message).toMatch(/saved minimum/);
    expect(result.message).toMatch(/easy: the default/);
  });

  it('a provider without presets, or an unknown one, is auto_not_supported, so the caller picks its own fallback', async () => {
    expect(await resolveProviderMinimum('copilot-cli')).toMatchObject({ ok: false, code: 'auto_not_supported' });
    expect(await resolveAutoLevel('nope', 'maximum')).toMatchObject({ ok: false, code: 'auto_not_supported' });
    expect(await resolveAutoLevel('claude-code', 'extreme' as never)).toMatchObject({ ok: false, code: 'no_valid_mapping' });
  });

  it('every level resolves, the difficulties as a helper start would', async () => {
    for (const [level, model] of [['easy', 'haiku'], ['medium', 'sonnet'], ['hard', 'opus']] as const) {
      const result = await resolveAutoLevel('claude-code', level);
      expect(result).toMatchObject({ ok: true, model, source: 'builtin_mapping' });
      expect(result).not.toHaveProperty('follows');
    }
  });

  it('a minimum isn\'t a start_helper difficulty, so it never picks a preset there', async () => {
    const result = await planHelperStart({ ...base, difficulty: 'minimum' });
    expect(result).toMatchObject({ ok: true, plan: { routing: { mode: 'explicit', resolved: { difficulty: null, model: null } } } });
  });

  it('cli "auto" refuses a minimum or maximum, and reads nothing', async () => {
    const on = { effective: true, source: 'app' as const, scopes: { app: { value: true, editable: true } } };
    for (const difficulty of ['minimum', 'maximum', undefined]) {
      expect(await planHelperStart({ ...base, cli: 'auto', difficulty, auto: on })).toMatchObject({ ok: false, code: 'no_valid_mapping' });
    }
    expect(W.listCalls).toEqual([]);
  });

  it('the page shows every level, with an unset minimum and maximum following Easy and Hard', async () => {
    W.saved = { 'claude-code': { easy: { model: 'sonnet', effort: 'low' } } };
    const view = (await readHelperRouting()).providers['claude-code'];
    if (!view.autoEligible) throw new Error('eligible');
    expect(Object.keys(view.cells)).toEqual(['minimum', 'easy', 'medium', 'hard', 'maximum']);
    expect(view.cells.minimum).toEqual({ ...view.cells.easy, custom: null, follows: 'easy' });
    expect(view.cells.minimum).toMatchObject({ effective: { model: 'sonnet', effort: 'low' }, source: 'custom' });
    expect(view.cells.maximum).toMatchObject({ effective: { model: 'opus', effort: 'high' }, source: 'builtin', custom: null, follows: 'hard', state: 'valid' });
  });

  it('the page shows a saved minimum as its own, and a stale one with what is used instead', async () => {
    W.saved = { 'codex-cli': { minimum: { model: 'gpt-6.1-terra', effort: 'low' }, maximum: { model: 'gone', effort: 'high' } } };
    const view = (await readHelperRouting()).providers['codex-cli'];
    if (!view.autoEligible) throw new Error('eligible');
    expect(view.cells.minimum).toEqual({
      effective: { model: 'gpt-6.1-terra', effort: 'low' }, source: 'custom', state: 'valid', custom: { model: 'gpt-6.1-terra', effort: 'low' },
      builtin: { model: 'gpt-6-luna', effort: 'low' }, editable: true,
    });
    expect(view.cells.maximum).toMatchObject({
      state: 'stale', staleReason: 'model_unavailable', fallback: 'builtin_preset', custom: { model: 'gone' }, effective: { model: 'gpt-6.1-sol' }, follows: 'hard',
    });
  });

  it('saves a minimum even when it matches Easy\'s built-in, audits it, and a reset makes it follow again', async () => {
    const write = (fields: Record<string, unknown>) => updateHelperPresets({ revision: helperRoutingRevision(), ...fields } as never, { surface: 'ui' });
    const view = (await write({ cells: [{ provider: 'claude-code', difficulty: 'minimum', model: 'haiku', effort: 'low' }] })).providers['claude-code'];
    expect(W.saved).toEqual({ 'claude-code': { minimum: { model: 'haiku', effort: 'low' } } });
    if (!view.autoEligible) throw new Error('eligible');
    expect(view.cells.minimum).not.toHaveProperty('follows');
    expect(W.audit).toEqual([{ surface: 'ui', scope: 'app', key: 'helper_presets.claude-code.minimum', before: null, after: 'haiku/low', outcome: 'ok' }]);
    await write({ cells: [{ provider: 'claude-code', difficulty: 'maximum', model: 'gone', effort: null }] }).catch((err: HelperRoutingError) => {
      expect(err.code).toBe('model_unavailable');
    });
    expect(W.saved).toEqual({ 'claude-code': { minimum: { model: 'haiku', effort: 'low' } } });
    const reset = (await write({ reset: { provider: 'claude-code', difficulty: 'minimum' } })).providers['claude-code'];
    expect(W.saved).toEqual({});
    if (!reset.autoEligible) throw new Error('eligible');
    expect(reset.cells.minimum).toMatchObject({ custom: null, follows: 'easy' });
  });

  it('moves the revision when a minimum\'s state changes with no write', async () => {
    W.saved = { 'codex-cli': { minimum: { model: 'gpt-6.1-terra', effort: null } } };
    const first = (await readHelperRouting()).revision;
    W.lists.set('codex-cli', live([m('gpt-6-luna'), m('gpt-6.1-sol')]));
    expect((await readHelperRouting()).revision).not.toBe(first);
  });
});

describe('Auto (#2671)', () => {
  const on = { effective: true, source: 'app' as const, scopes: { app: { value: true, editable: true } } };
  const off = { effective: false, source: 'project' as const, reason: 'project_off' as const, scopes: { app: { value: true, editable: true } } };
  const auto = (extra: Record<string, unknown> = {}) => planHelperStart({
    ...base, cli: 'auto', difficulty: 'hard', auto: on, orchestratorId: 'orch', orchestratorCli: 'claude-code', ...extra,
  });
  const known = {
    state: 'known', source: 'cli_query', asOf: '2027-01-15T08:00:00.000Z', limitingWindow: 'weekly',
    weekly: { usedPercent: 20, resetsAt: '2027-01-20T08:00:00.000Z' },
  };
  const asLoad = (live: Record<string, number>) => Object.fromEntries(Object.entries(live).map(([p, n]) => [p, { live: n, reserved: 0 }]));
  const decided = async (load: Record<string, number> = {}, extra: Record<string, unknown> = {}) => {
    const prepared = await auto(extra);
    if (prepared.ok === false) throw new Error(prepared.message);
    const result = decideAutoPlan(prepared.plan!, asLoad(load));
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
    expect(plan).toMatchObject({ provider: 'codex-cli', model: 'gpt-6.1-sol', effort: 'high' });
    expect(plan.routing).toMatchObject({
      mode: 'auto', balanced: true, policyVersion: 2, reason: 'lower_load', fallback: 'none', quotaBasis: 'known',
      decisionId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      requested: { provider: 'auto', model: null, effort: null, difficulty: 'hard' },
      resolved: { provider: 'codex-cli', model: 'gpt-6.1-sol', effort: 'high', difficulty: 'hard' },
      source: { provider: 'auto', model: 'builtin_mapping', effort: 'builtin_mapping' },
      load: { 'claude-code': 2, 'codex-cli': 0 },
      quota: { 'codex-cli': { state: 'known', asOf: known.asOf, limitingWindow: 'weekly' }, 'claude-code': { state: 'known' } },
    });
  });

  it('its record has every provider, the readings in basis points, the scores and the tie', async () => {
    const plan = await decided({ 'claude-code': 2 });
    const record = plan.decision!;
    expect(record).toMatchObject({
      decisionId: plan.routing.decisionId, policyVersion: 2, mode: 'auto', outcome: 'chosen', orchestratorProvider: 'claude-code',
      requested: { provider: 'auto', difficulty: 'hard' }, resolved: { provider: 'codex-cli', model: 'gpt-6.1-sol' },
      reason: 'lower_load', mappingKind: 'builtin', mappingRevision: helperRoutingRevision(),
      tie: { setSize: 2, bandBp: 0, reason: 'lower_load', byLoad: true },
    });
    expect(record.mappingFingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(record.candidates.map((c) => c.provider)).toEqual(['claude-code', 'codex-cli', 'copilot-cli']);
    expect(record.candidates[1]).toMatchObject({
      eligible: true, chosen: true, accountKnown: false, load: { live: 0, reserved: 0 },
      mapped: { model: 'gpt-6.1-sol', effort: 'high', source: 'builtin_mapping', verified: true },
      quota: { state: 'known', source: 'cli_query', asOfMs: Date.parse(known.asOf), quality: 'fresh', windows: [{ name: 'weekly', usedBp: 2000, resetsAtMs: Date.parse(known.weekly.resetsAt) }] },
      score: { basis: 'weekly_used', weeklyUsedBp: 2000, pressureBp: 2000 },
    });
    expect(record.candidates[0]).toMatchObject({ load: { live: 2, reserved: 0 } });
    expect(record.candidates[0].chosen).toBeUndefined();
    expect(record.candidates[2]).toEqual({ provider: 'copilot-cli', eligible: false, excluded: 'auto_not_supported', load: { live: 0, reserved: 0 } });
  });

  it('unknown quota waits behind measured headroom and is never scored', async () => {
    W.quota.set('claude-code', { state: 'unknown', unknownReason: 'read_failed', source: 'none', asOf: null });
    const plan = await decided();
    expect(plan.provider).toBe('codex-cli');
    expect(plan.decision!.candidates[0]).toMatchObject({ quota: { state: 'unknown', unknownReason: 'read_failed', quality: 'unknown' }, score: { basis: 'unmeasured' } });
    expect(plan.decision!.candidates[0].quota!.asOfMs).toBeUndefined();
    expect(plan.decision!.candidates[0].score!.pressureBp).toBeUndefined();
  });

  it('unknown quota is used once the measured ones are past the low mark, and says so', async () => {
    W.quota.set('claude-code', { state: 'unknown', unknownReason: 'read_failed', source: 'none', asOf: null });
    W.quota.set('codex-cli', { ...known, state: 'low', weekly: { usedPercent: 85, resetsAt: known.weekly.resetsAt } });
    const plan = await decided();
    expect(plan.provider).toBe('claude-code');
    expect(plan.routing).toMatchObject({ reason: 'unknown_fallback', quotaBasis: 'unknown_fallback', quota: { 'claude-code': { state: 'unknown', unknownReason: 'read_failed', asOf: null } } });
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

  it('a start Auto didn\'t decide gets a record of what it resolved, and compares nothing', async () => {
    const preset = await plan({ difficulty: 'hard' });
    expect(startDecisionRecord(preset!.routing, {}, 1_000)).toMatchObject({
      decidedAtMs: 1_000, mode: 'preset', outcome: 'chosen', reason: 'preset_on_cli', candidates: [],
      resolved: { provider: 'claude-code', model: 'opus', effort: 'high', difficulty: 'hard' },
    });
    const bare = startDecisionRecord(undefined, { provider: 'codex-cli' });
    expect(bare).toMatchObject({ mode: 'explicit', source: { provider: 'orchestrator' }, resolved: { provider: 'codex-cli', model: null, effort: null, difficulty: null }, candidates: [] });
    expect(bare.reason).toBeUndefined();
  });

  describe('no anchor', () => {
    it('who asks, and from which CLI, changes nothing', async () => {
      const a = await decided({}, { orchestratorId: 'one', orchestratorCli: 'codex-cli' });
      _resetHelperRoutingForTesting();
      const b = await decided({}, { orchestratorId: 'two', orchestratorCli: 'claude-code' });
      expect(a.provider).toBe(b.provider);
    });

    it('equal readings take turns across starts, whoever asks, once each decision commits', async () => {
      const picks: string[] = [];
      for (const orchestratorId of ['one', 'two', 'one', 'two']) {
        const plan = await decided({}, { orchestratorId });
        commitAutoDecision(plan.routing.decisionId!, `h-${picks.length}`);
        settleAutoDecision(plan.routing.decisionId!, 'spawn_failed');
        picks.push(plan.provider!);
      }
      expect(picks).toEqual(['claude-code', 'codex-cli', 'claude-code', 'codex-cli']);
      expect(Object.values(rotationCursors())).toEqual(['codex-cli:default']);
    });

    it('a decision that never commits doesn\'t take a turn', async () => {
      const first = await decided();
      settleAutoDecision(first.routing.decisionId!, 'creation_refused');
      expect((await decided()).provider).toBe(first.provider);
    });
  });

  describe('reservations', () => {
    it('a decision holds its provider until it settles', async () => {
      const plan = await decided();
      expect(reservedLoad({ live: new Set(), notRunning: new Set() })).toEqual({ [plan.provider!]: 1 });
      settleAutoDecision(plan.routing.decisionId!, 'creation_refused');
      expect(reservedLoad({ live: new Set(), notRunning: new Set() })).toEqual({});
    });

    it('a refusal holds nothing, and has a record', async () => {
      W.cooling.add('claude-code');
      W.quota.set('codex-cli', { ...known, state: 'near_limit' });
      const result = await auto();
      expect(result).toMatchObject({ ok: false, decision: { outcome: 'refused', refusalCode: 'no_candidate', fallback: 'candidate_skipped' } });
      if (result.ok === false) {
        expect(result.decision!.reason).toBeUndefined();
        expect(result.decision!.candidates.find((c) => c.provider === 'codex-cli')).toMatchObject({ eligible: false, excluded: 'quota_near_limit' });
      }
      expect(reservedLoad({ live: new Set(), notRunning: new Set() })).toEqual({});
    });
  });

  describe('readHelperAuto', () => {
    const config = (autoHelpers?: boolean) => ({ id: 'a', orchestration: autoHelpers === undefined ? {} : { autoHelpers } }) as never;
    const policy = (agent: object = { orchestrate: true }) => resolveOrchestrationPolicy(agent);
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

    it('keeps the retired persona scope, always null (#2901)', async () => {
      W.appAuto = true;
      expect(await read(undefined, policy({ orchestrate: true }))).toMatchObject({ effective: true, source: 'app', scopes: { persona: { value: null, editable: false } } });
    });

    it('an agent that doesn\'t orchestrate can\'t use it', async () => {
      W.appAuto = true;
      expect(await read(undefined, policy({ orchestrate: false }))).toMatchObject({ effective: false, reason: 'orchestration_off' });
    });

    it('the Dispatcher is locked', async () => {
      W.appAuto = true;
      expect(await readHelperAuto({ dispatcher: true })).toMatchObject({ effective: false, source: 'dispatcher_locked', reason: 'dispatcher_locked', scopes: { app: { editable: false }, agent: { value: null, editable: false } } });
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
