import { afterEach, describe, expect, it, vi } from 'vitest';
import { abortPending } from './facade';
import { setProducingRuntime } from './__test-utils__/producing-runtime';
import { blueprintTransfer, helperAutoCooldown, helperAutoRefused, helperPresetsChanged, helperQuotaRead, helperRouted, isSettingsKey, popoutOpened, recordToolsList, settingsChanged, SETTINGS_KEYS_EXCLUDED, themeChanged } from './feature-events';
import * as definitions from '../../shared/settings-definitions';
import { byteSizeBucket, classifyFetchError } from './workspace';
import type { TelemetryRuntime } from './types';

const events: Array<{ name: string; attrs: Record<string, unknown> }> = [];

function runtime(): TelemetryRuntime {
  return {
    level: 'standard',
    event: (name: string, attrs: Array<{ key: string; value: unknown }> = []) =>
      events.push({ name, attrs: Object.fromEntries(attrs.map((a) => [a.key, a.value])) }),
    flow: vi.fn(), step: vi.fn(), count: vi.fn(), exception: vi.fn(), replaySpan: vi.fn(), replayTree: vi.fn(),
    preview: () => [], recentExports: () => [], forceFlush: async () => {}, shutdown: async () => {},
  } as unknown as TelemetryRuntime;
}

afterEach(() => {
  events.length = 0;
  setProducingRuntime(null);
  abortPending();
});

describe('feature events', () => {
  it('sends the settings key only', () => {
    setProducingRuntime(runtime());
    settingsChanged('editor');
    expect(events).toEqual([{ name: 'clubhouse.settings.changed', attrs: { 'clubhouse.settings.key': 'editor' } }]);
  });

  it('names built-in themes and hides plugin theme ids', () => {
    setProducingRuntime(runtime());
    themeChanged('dracula');
    themeChanged('acme-corp-secret-theme');
    expect(events.filter((e) => e.name === 'clubhouse.theme.changed').map((e) => e.attrs)).toEqual([
      { 'clubhouse.theme.kind': 'builtin', 'clubhouse.theme.builtin_id': 'dracula' },
      { 'clubhouse.theme.kind': 'plugin', 'clubhouse.theme.builtin_id': 'other' },
    ]);
    expect(JSON.stringify(events)).not.toContain('acme');
  });

  it('records popouts and blueprint transfers', () => {
    setProducingRuntime(runtime());
    popoutOpened('canvas');
    blueprintTransfer('exported', true);
    blueprintTransfer('imported', false);
    expect(events).toEqual([
      { name: 'clubhouse.popout.opened', attrs: { 'clubhouse.popout.type': 'canvas' } },
      { name: 'clubhouse.blueprint.exported', attrs: { 'clubhouse.outcome': 'ok' } },
      { name: 'clubhouse.blueprint.imported', attrs: { 'clubhouse.outcome': 'error' } },
    ]);
  });

  it('is silent while telemetry is off', () => {
    settingsChanged('mcp');
    expect(events).toEqual([]);
  });
});

describe('settings key coverage', () => {
  it('lists every managed-settings definition key, or excludes it on purpose', () => {
    const keys = Object.values(definitions)
      .filter((v): v is { key: string; filename: string; defaults: unknown } =>
        !!v && typeof v === 'object' && 'key' in v && 'filename' in v && 'defaults' in v)
      .map((d) => d.key);
    expect(keys.length).toBeGreaterThan(4);
    const excluded = new Set<string>(SETTINGS_KEYS_EXCLUDED);
    expect(keys.filter((k) => !isSettingsKey(k) && !excluded.has(k))).toEqual([]);
  });
});

describe('MCP tools list', () => {
  it('sends a count bucket and an empty flag, never tool names', () => {
    setProducingRuntime(runtime());
    recordToolsList(0);
    recordToolsList(23);
    expect(events).toEqual([
      { name: 'clubhouse.mcp.tools_list', attrs: { 'clubhouse.mcp.tools.count_bucket': '0', 'clubhouse.mcp.tools.empty': true } },
      { name: 'clubhouse.mcp.tools_list', attrs: { 'clubhouse.mcp.tools.count_bucket': '10-99', 'clubhouse.mcp.tools.empty': false } },
    ]);
  });
});

describe('marketplace classifiers', () => {
  it('classifies fetch failures', () => {
    expect(classifyFetchError(Object.assign(new Error('timed out'), { name: 'TimeoutError' }))).toBe('timeout');
    expect(classifyFetchError(new SyntaxError('Unexpected token <'))).toBe('invalid_json');
    expect(classifyFetchError(new Error('Failed to fetch custom registry "Acme": 404 Not Found'))).toBe('http_4xx');
    expect(classifyFetchError(new Error('Failed to fetch registry: 503 Service Unavailable'))).toBe('http_5xx');
    expect(classifyFetchError(new TypeError('fetch failed'))).toBe('network');
  });

  it('buckets download sizes', () => {
    expect([0, 500, 50_000, 500_000, 5_000_000, 50_000_000, 500_000_000].map(byteSizeBucket)).toEqual([
      '0', '<1KB', '<100KB', '<1MB', '<10MB', '<100MB', '>=100MB',
    ]);
  });
});

describe('helper routing events (#2671)', () => {
  afterEach(() => { events.length = 0; abortPending(); setProducingRuntime(null); });

  it('a decision has closed codes and a model family, never a raw model id', () => {
    setProducingRuntime(runtime());
    helperRouted({
      mode: 'preset', balanced: false, decidedAt: 'now', policyVersion: 1, fallback: 'builtin_preset', context: { status: 'none' },
      requested: { provider: null, model: null, effort: null, difficulty: 'hard' },
      resolved: { provider: 'claude-code', model: 'claude-secret-internal-9', effort: 'some-new-level', difficulty: 'hard' },
      source: { provider: 'orchestrator', model: 'builtin_mapping', effort: 'builtin_mapping' },
      reason: 'preset_on_cli',
    });
    const [event] = events;
    expect(event.name).toBe('clubhouse.helper.routed');
    expect(event.attrs).toMatchObject({
      'clubhouse.helper_routing.requested_cli': 'unset',
      'clubhouse.helper_routing.difficulty': 'hard',
      'clubhouse.helper_routing.mode': 'preset',
      'clubhouse.orchestrator': 'claude-code',
      'clubhouse.helper_routing.effort': 'other',
      'clubhouse.helper_routing.preset': 'builtin',
      'clubhouse.helper_routing.reason': 'preset_on_cli',
      'clubhouse.helper_routing.fallback': 'builtin_preset',
      'clubhouse.helper_routing.policy_version': 1,
    });
    expect(JSON.stringify(event.attrs)).not.toContain('secret');
  });

  it('a presets change has the action, surface and outcome, never values', () => {
    setProducingRuntime(runtime());
    helperPresetsChanged('reset_cell', 'mobile', false);
    expect(events[0]).toEqual({ name: 'clubhouse.helper_routing.changed', attrs: {
      'clubhouse.helper_presets.action': 'reset_cell', 'clubhouse.helper_presets.surface': 'mobile', 'clubhouse.outcome': 'error',
    } });
  });
});

describe('Auto events (#2671)', () => {
  afterEach(() => { events.length = 0; abortPending(); setProducingRuntime(null); });

  it('a decision says how it was reached, in buckets and codes', () => {
    setProducingRuntime(runtime());
    helperRouted({
      mode: 'auto', balanced: true, decidedAt: '2027-01-15T08:20:00.000Z', policyVersion: 1, fallback: 'candidate_skipped', context: { status: 'none' },
      requested: { provider: 'auto', model: null, effort: null, difficulty: 'hard' },
      resolved: { provider: 'codex-cli', model: 'gpt-6.1-sol', effort: 'high', difficulty: 'hard' },
      source: { provider: 'auto', model: 'custom_mapping', effort: 'custom_mapping' },
      reason: 'lower_load',
      load: { 'codex-cli': 3 },
      quota: { 'codex-cli': { state: 'unknown', unknownReason: 'stale', asOf: '2027-01-15T08:00:00.000Z' } },
      quotaBasis: 'unknown_scored_as_healthy',
    });
    expect(events[0].attrs).toMatchObject({
      'clubhouse.helper_routing.requested_cli': 'auto',
      'clubhouse.helper_routing.mode': 'auto',
      'clubhouse.helper_routing.preset': 'custom',
      'clubhouse.helper_routing.reason': 'lower_load',
      'clubhouse.helper_routing.fallback': 'candidate_skipped',
      'clubhouse.helper_routing.load_bucket': '2-3',
      'clubhouse.helper_routing.quota_basis': 'unknown_scored_as_healthy',
      'clubhouse.helper_routing.quota_age': 'over_15m',
      'clubhouse.helper_quota.state': 'unknown',
    });
    expect(JSON.stringify(events[0].attrs)).not.toContain('gpt-6.1-sol');
  });

  it('refusals, cooldowns and quota reads are codes', () => {
    setProducingRuntime(runtime());
    helperAutoRefused('no_candidate');
    helperAutoCooldown('claude-code', 'auth');
    helperQuotaRead('codex-cli', 'near_limit', true);
    expect(events.map((e) => e.name)).toEqual(['clubhouse.helper_auto.refused', 'clubhouse.helper_auto.cooling', 'clubhouse.helper_quota.read']);
    expect(events[0].attrs).toEqual({ 'clubhouse.helper_auto.refusal': 'no_candidate' });
    expect(events[1].attrs).toEqual({ 'clubhouse.orchestrator': 'claude-code', 'clubhouse.helper_auto.cooldown': 'auth' });
    expect(events[2].attrs).toEqual({ 'clubhouse.orchestrator': 'codex-cli', 'clubhouse.helper_quota.state': 'near_limit', 'clubhouse.outcome': 'ok' });
  });
});
