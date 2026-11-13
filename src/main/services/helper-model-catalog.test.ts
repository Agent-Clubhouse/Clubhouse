import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelList, OrchestratorProvider } from '../orchestrators/types';
import type { SavedPresets } from '../../shared/helper-routing';

const W = vi.hoisted(() => ({ dir: '', notices: vi.fn(), log: vi.fn(), presets: {} as SavedPresets, enabled: ['codex-cli', 'copilot-cli'] }));
vi.mock('electron', () => ({ app: { getPath: () => W.dir } }));
vi.mock('../util/ipc-broadcast', () => ({ broadcastToAllWindows: W.notices }));
vi.mock('./log-service', () => ({ appLog: W.log }));
vi.mock('./orchestration-settings', () => ({ getPresets: () => W.presets }));
vi.mock('./orchestrator-settings', () => ({ getSettings: () => ({ enabled: W.enabled }) }));
vi.mock('../telemetry/persist', () => ({ persist: { timed: (_key: string, fn: () => unknown) => fn(), recovery: vi.fn() } }));

const provider = { id: 'codex-cli', displayName: 'Codex' } as OrchestratorProvider;
const catalog = (ids: string[], fetchedAt: number, extra: Partial<ModelList> = {}): ModelList => ({
  models: ids.map((id) => ({ id, label: id.toUpperCase() })), source: 'live', via: 'handshake', fetchedAt, ...extra,
});
let observe: typeof import('./helper-model-catalog')['observeHelperModelCatalog'];

beforeEach(async () => {
  vi.resetModules();
  W.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-model-catalog-'));
  W.notices.mockClear();
  W.log.mockClear();
  W.presets = {};
  W.enabled = ['codex-cli', 'copilot-cli'];
  observe = (await import('./helper-model-catalog')).observeHelperModelCatalog;
});
afterEach(() => fs.rmSync(W.dir, { recursive: true, force: true }));

describe('model catalog notices', () => {
  it.each(['default', 'best', 'opus', 'sonnet', 'haiku', 'fable', 'opusplan'].flatMap((alias) => [
    alias, `${alias}[1m]`, alias.toUpperCase(),
  ]))('keeps the supported Claude alias %s unknown unless its cached entry resolves canonically', async (alias) => {
    const { peekHelperCalibrationModel: peek } = await import('./helper-model-catalog');
    const claude = { ...provider, id: 'claude-code' as const };
    await observe(claude, catalog([alias], 100));
    expect(peek(claude.id, alias, 100)).toEqual({ reason: 'unresolved_model' });
    await observe(claude, catalog([], 101, { models: [{ id: alias, label: alias, resolvedId: 'claude-opus-5-5' }] }));
    expect(peek(claude.id, alias, 101)).toEqual({ model: 'claude-opus-5-5', reason: 'cached_catalog' });
    await observe(claude, catalog([], 102, { models: [{ id: alias, label: alias, resolvedId: 'fable[1m]' }] }));
    expect(peek(claude.id, alias, 102)).toEqual({ reason: 'unresolved_model' });
  });

  it('peeks existing fresh canonical evidence only, with explicit missing, fallback, stale and alias provenance', async () => {
    const { peekHelperCalibrationModel: peek, HELPER_CALIBRATION_CATALOG_MAX_AGE_MS: maxAge } = await import('./helper-model-catalog');
    expect(peek(provider.id, 'gpt-6.1-sol', 100)).toEqual({ reason: 'missing_catalog' });
    await observe(provider, catalog(['gpt-6.1-sol'], 100));
    expect(peek(provider.id, 'gpt-6.1-sol', 100)).toEqual({ model: 'gpt-6.1-sol', reason: 'cached_catalog' });
    expect(peek(provider.id, 'gpt-6.1-sol', 99)).toEqual({ reason: 'stale_catalog' });
    expect(peek(provider.id, 'gpt-6.1-sol', 101 + maxAge)).toEqual({ reason: 'stale_catalog' });
    expect(peek(provider.id, 'unlisted', 100)).toEqual({ reason: 'unresolved_model' });
    await observe(provider, catalog(['gpt-6.1-sol'], 101, { source: 'fallback' }));
    expect(peek(provider.id, 'gpt-6.1-sol', 101)).toEqual({ reason: 'fallback_catalog' });
    await observe(provider, catalog(['opus'], 102));
    expect(peek(provider.id, 'opus', 102)).toEqual({ reason: 'unresolved_model' });
    await observe(provider, catalog([], 103, { models: [{ id: 'opus', resolvedId: 'claude-opus-5-5', label: 'Opus' }] }));
    expect(peek(provider.id, 'opus', 103)).toEqual({ model: 'claude-opus-5-5', reason: 'cached_catalog' });
    await observe(provider, catalog(['gpt-6.1-sol'], 102));
    expect(peek(provider.id, 'gpt-6.1-sol', 104)).toEqual({ reason: 'stale_catalog' });
  });

  it('silently saves a first live baseline, then combines additions into one notice exactly once', async () => {
    await observe(provider, catalog(['old'], 1));
    expect(W.notices).not.toHaveBeenCalled();
    await Promise.all([observe(provider, catalog(['old', 'new', 'other'], 2)), observe(provider, catalog(['old', 'new', 'other'], 2))]);
    await observe(provider, catalog(['other', 'old', 'new'], 3));
    expect(W.notices).toHaveBeenCalledExactlyOnceWith('app:model-catalog-notice', 'New models for Codex: NEW, OTHER. Review Smart selection');
  });

  it('notifies about a removed saved or built-in model, never changing presets', async () => {
    W.presets = { 'codex-cli': { minimum: { model: 'custom', effort: null } } };
    const before = structuredClone(W.presets);
    await observe(provider, catalog(['custom', 'gpt-6.1-sol', 'other'], 1));
    await observe(provider, catalog(['other', 'new'], 2));
    expect(W.notices).toHaveBeenCalledExactlyOnceWith('app:model-catalog-notice',
      'New models for Codex: NEW. Models no longer offered for Codex: CUSTOM, GPT-6.1-SOL. Review Smart selection');
    expect(W.presets).toEqual(before);
  });

  it('does not save failed, fallback, empty or older catalogs', async () => {
    await observe(provider, catalog(['old'], 10));
    const file = path.join(W.dir, 'helper-model-catalogs.json');
    const before = fs.readFileSync(file, 'utf8');
    await observe(provider, catalog(['fallback'], 11, { source: 'fallback', via: 'static' }));
    await observe(provider, catalog(['partial'], 12, { liveError: 'interrupted' }));
    await observe(provider, catalog([], 13));
    await observe(provider, catalog(['old', 'stale'], 9));
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    await observe(provider, catalog(['old', 'new'], 14));
    expect(W.notices).toHaveBeenCalledTimes(1);
  });

  it('persists discovery and missing-model dedupe through restarts and temporary disappearance', async () => {
    W.presets = { 'codex-cli': { hard: { model: 'mapped', effort: null } } };
    await observe(provider, catalog(['old', 'mapped'], 1));
    await observe(provider, catalog(['old', 'new'], 2));
    vi.resetModules();
    observe = (await import('./helper-model-catalog')).observeHelperModelCatalog;
    await observe(provider, catalog(['old', 'new'], 3));
    await observe(provider, catalog(['old', 'mapped'], 4));
    await observe(provider, catalog(['old', 'new'], 5));
    expect(W.notices).toHaveBeenCalledTimes(1);
  });

  it('ignores label and resolved-alias changes and hidden discoveries', async () => {
    await observe(provider, catalog(['alias'], 1));
    await observe(provider, catalog([], 2, { models: [
      { id: 'alias', label: 'Renamed', resolvedId: 'new-version' }, { id: 'hidden', label: 'Hidden', hidden: true },
    ] }));
    expect(W.notices).not.toHaveBeenCalled();
  });

  it('deduplicates alias renames and concrete ids by authoritative resolved model identity across restart', async () => {
    await observe(provider, catalog([], 1, { models: [{ id: 'friendly-alias', label: 'Friendly', resolvedId: 'model-v1' }] }));
    await observe(provider, catalog([], 2, { models: [{ id: 'renamed-alias', label: 'Renamed', resolvedId: 'model-v1' }, { id: 'model-v1', label: 'Version one' }] }));
    expect(W.notices).not.toHaveBeenCalled();
    vi.resetModules(); observe = (await import('./helper-model-catalog')).observeHelperModelCatalog;
    await observe(provider, catalog(['temporary'], 3, { source: 'fallback', via: 'static' }));
    await observe(provider, catalog(['model-v1', 'model-v2'], 4));
    expect(W.notices).toHaveBeenCalledExactlyOnceWith('app:model-catalog-notice', 'New models for Codex: MODEL-V2. Review Smart selection');
    W.notices.mockClear(); // Dismissal changes no mapping and does not clear persisted seen state.
    await observe(provider, catalog(['model-v1', 'model-v2'], 5));
    expect(W.notices).not.toHaveBeenCalled();
    expect(W.presets).toEqual({});
  });

  it('updates disabled providers silently without replaying discoveries when enabled', async () => {
    await observe(provider, catalog(['old'], 1));
    W.enabled = [];
    await observe(provider, catalog(['old', 'new'], 2));
    expect(W.notices).not.toHaveBeenCalled();
    W.enabled = [provider.id];
    await observe(provider, catalog(['old', 'new'], 3));
    expect(W.notices).not.toHaveBeenCalled();
    await observe(provider, catalog(['old', 'new', 'newer'], 4));
    expect(W.notices).toHaveBeenCalledTimes(1);
  });

  it('checks built-in fallback mappings even when a saved override still exists', async () => {
    W.presets = { 'codex-cli': { hard: { model: 'custom', effort: null } } };
    await observe(provider, catalog(['custom', 'gpt-6.1-sol'], 1));
    await observe(provider, catalog(['custom'], 2));
    expect(W.notices).toHaveBeenCalledExactlyOnceWith('app:model-catalog-notice',
      'Models no longer offered for Codex: GPT-6.1-SOL. Review Smart selection');
  });

  it('bounds cumulative history without evicting returning ids or damaging the last snapshot', async () => {
    const ids = Array.from({ length: 3200 }, (_, i) => `model-${i}-${'x'.repeat(64)}`);
    await observe(provider, catalog(ids, 1));
    const file = path.join(W.dir, 'helper-model-catalogs.json');
    const before = fs.readFileSync(file, 'utf8');
    expect(Buffer.byteLength(before)).toBeLessThanOrEqual(1024 * 1024);
    await observe(provider, catalog(ids.map((id) => `${id}-next`), 2));
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(W.log).toHaveBeenCalled();
    expect(W.notices).not.toHaveBeenCalled();
    await observe(provider, catalog([ids[0]], 3));
    expect(W.notices).not.toHaveBeenCalled();
  });

  it('bounds snapshot bytes and persists only model identity fields across concurrent providers', async () => {
    await Promise.all([
      observe(provider, catalog(['old'], 1, { models: [{ id: 'old', label: 'Old', description: 'private description', efforts: ['high'] }] })),
      observe({ ...provider, id: 'copilot-cli' }, catalog(['copilot'], 1)),
    ]);
    const file = path.join(W.dir, 'helper-model-catalogs.json');
    const before = fs.readFileSync(file, 'utf8');
    expect(JSON.parse(before).providers['codex-cli'].models.old).toEqual({ label: 'Old' });
    expect(JSON.parse(before).providers['copilot-cli'].seen).toEqual(['copilot']);
    await observe(provider, catalog([], 2, { models: [{ id: 'large', label: 'x'.repeat(1024 * 1024) }] }));
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(W.notices).not.toHaveBeenCalled();
  });

  it('keeps provider identities separate and logs a persistence failure without breaking a live read', async () => {
    await observe(provider, catalog(['old'], 1));
    await observe({ ...provider, id: 'copilot-cli' }, catalog(['old', 'new'], 2));
    expect(W.notices).not.toHaveBeenCalled();
    const invalidDir = path.join(W.dir, 'missing');
    W.dir = invalidDir;
    await observe(provider, catalog(['old', 'new'], 3));
    expect(W.log).toHaveBeenCalled();
    expect(W.notices).not.toHaveBeenCalled();
    W.dir = path.dirname(invalidDir);
  });
});
