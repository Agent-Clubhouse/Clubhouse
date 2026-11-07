import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ root: '', generation: 0, pending: false }));
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => state.root } }));
vi.mock('./base-dir', () => ({ getBaseDirPath: () => state.root }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./agent-settings-service', () => ({ readProjectAgentDefaults: async () => ({}), applyAgentDefaults: async () => {}, readSourcePersonaContent: async () => '' }));
vi.mock('./agent-system', () => ({ resolveOrchestrator: async () => ({ conventions: {}, writeInstructions: async () => {} }) }));
vi.mock('./project-store', () => ({
  peekProjects: async () => [{ id: 'project-1', path: path.join(state.root, 'project') }],
  projectRegistryMutationState: () => ({ generation: state.generation, pending: state.pending }),
}));
import { seedBuilderTemplates } from './asset-catalog/builder-seeds';
import { createAssetCatalogStore, assetCatalogDir } from './asset-catalog/store';
import { withSettingsSurface, _resetSettingsAuditForTesting } from './settings-audit';
import { previewNewAgentComposition, consumeNewAgentComposition, discardNewAgentComposition } from './new-agent-composition-drafts';

import { startDurableCreation } from './agent-creation';
import { clearAgentConfigCache, flushAgentConfig } from './agent-config';
const owned: Promise<unknown>[] = [];
const params = { name: 'new-agent', color: 'blue', useWorktree: false };
const tokens: string[] = [];
const ui = <T,>(fn: () => T): T => withSettingsSurface('ui', undefined, fn);
async function preview(sender = 1) {
  const result = await ui(() => previewNewAgentComposition(sender, 'project-1', 'builtin-builder-custom', []));
  tokens.push(result.token); return result;
}
beforeEach(async () => {
  state.root = fs.mkdtempSync(path.join(os.tmpdir(), 'new-composition-drafts-'));
  fs.mkdirSync(path.join(state.root, 'project'));
  clearAgentConfigCache();
  state.generation = 0; state.pending = false;
  _resetSettingsAuditForTesting(false);
  await withSettingsSurface('system', undefined, () => seedBuilderTemplates(createAssetCatalogStore({ dir: assetCatalogDir() })));
});
afterEach(async () => {
  await Promise.all(owned.splice(0));
  await flushAgentConfig(path.join(state.root, 'project')); clearAgentConfigCache();
  vi.restoreAllMocks();
  for (const token of tokens.splice(0)) for (const sender of [1, 2]) ui(() => discardNewAgentComposition(sender, token));
  _resetSettingsAuditForTesting(false);
  fs.rmSync(state.root, { recursive: true, force: true });
});
it('previews without composition writes and consumes the same reserved ID once', async () => {
  const result = await preview();
  const store = createAssetCatalogStore({ dir: assetCatalogDir() });
  expect(Object.keys((await store.read()).compositions)).toEqual([]);
  const consumed = ui(() => consumeNewAgentComposition(1, result.token, path.join(state.root, 'project'), params));
  try {
    expect(consumed.options.idReservation?.agentId).toMatch(/^durable_/);
    expect(consumed.options.commitComposition).toBeTypeOf('function');
    expect(() => ui(() => consumeNewAgentComposition(1, result.token, path.join(state.root, 'project'), params))).toThrow();
  } finally { consumed.release(); }
});
it('rejects another sender or project without consuming the rightful preview', async () => {
  const result = await preview();
  expect(() => ui(() => consumeNewAgentComposition(2, result.token, path.join(state.root, 'project'), params))).toThrow();
  expect(() => ui(() => consumeNewAgentComposition(1, result.token, '/wrong-project', params))).toThrow();
  const consumed = ui(() => consumeNewAgentComposition(1, result.token, path.join(state.root, 'project'), params));
  consumed.release();
});
it('expires by main time and refuses a changed registry', async () => {
  const expired = await preview();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(expired.expiresAt);
  expect(() => ui(() => consumeNewAgentComposition(1, expired.token, path.join(state.root, 'project'), params))).toThrow();
  clock.mockRestore();
  const changed = await preview(); state.generation++;
  expect(() => ui(() => consumeNewAgentComposition(1, changed.token, path.join(state.root, 'project'), params))).toThrow();
});
it('supersedes same-window previews and explicitly discards unused previews', async () => {
  const old = await preview(); const current = await preview();
  expect(() => ui(() => consumeNewAgentComposition(1, old.token, path.join(state.root, 'project'), params))).toThrow();
  ui(() => discardNewAgentComposition(1, current.token));
  expect(() => ui(() => consumeNewAgentComposition(1, current.token, path.join(state.root, 'project'), params))).toThrow();
});
it('refuses legacy persona and MCP combinations without any composition write', async () => {
  for (const extra of [{ persona: 'researcher' }, { mcpIds: ['server'] }, { parentAgentId: 'helper-parent' }]) {
    const result = await preview();
    expect(() => ui(() => consumeNewAgentComposition(1, result.token, path.join(state.root, 'project'), { ...params, ...extra }))).toThrow();
  }
  expect(Object.keys((await createAssetCatalogStore({ dir: assetCatalogDir() }).read()).compositions)).toEqual([]);
});
it('previews shared blocks in selection order without writing assets or composition', async () => {
  const store = createAssetCatalogStore({ dir: assetCatalogDir() });
  const first = await store.createAsset({ kind: 'block', name: 'First shared block', owner: { kind: 'library' }, payload: { content: 'FIRST_SHARED' } });
  const second = await store.createAsset({ kind: 'block', name: 'Second project block', owner: { kind: 'project', projectId: 'project-1' }, payload: { content: 'SECOND_SHARED' } });
  const before = await store.read();
  const result = await ui(() => previewNewAgentComposition(1, 'project-1', 'builtin-builder-custom', [], [second.id, first.id]));
  tokens.push(result.token);
  expect(result.availableBlocks).toEqual(expect.arrayContaining([{ id: first.id, name: first.name }, { id: second.id, name: second.name }]));
  expect(result.text).toContain('FIRST_SHARED');
  expect(result.text.indexOf('SECOND_SHARED')).toBeLessThan(result.text.indexOf('FIRST_SHARED'));
  expect(await store.read()).toEqual(before);
});
it('refuses duplicate, foreign-project, agent-owned and non-block selections before writes', async () => {
  const store = createAssetCatalogStore({ dir: assetCatalogDir() });
  const shared = await store.createAsset({ kind: 'block', name: 'Shared', owner: { kind: 'library' }, payload: { content: 'shared' } });
  const foreign = await store.createAsset({ kind: 'block', name: 'Foreign', owner: { kind: 'project', projectId: 'elsewhere' }, payload: { content: 'foreign' } });
  const privateBlock = await store.createAsset({ kind: 'block', name: 'Private', owner: { kind: 'agent', agentId: 'another-agent' }, payload: { content: 'private' } });
  const before = await store.read();
  for (const ids of [[shared.id, shared.id], [foreign.id], [privateBlock.id], ['builtin-builder-custom'], ['missing']]) {
    await expect(ui(() => previewNewAgentComposition(1, 'project-1', 'builtin-builder-custom', [], ids))).rejects.toThrow('Selected block is unavailable');
  }
  expect(await store.read()).toEqual(before);
});

it.each([false, true])('binds selected block revisions through real creation (source changed: %s)', async (changed) => {
  const store = createAssetCatalogStore({ dir: assetCatalogDir() });
  const block = await store.createAsset({ kind: 'block', name: 'Shared creation input', owner: { kind: 'library' }, payload: { content: 'REVIEWED_CONTENT' } });
  const result = await ui(() => previewNewAgentComposition(1, 'project-1', 'builtin-builder-custom', [], [block.id]));
  tokens.push(result.token);
  if (changed) await store.saveRevision({ assetId: block.id, expectedRevision: 1, payload: { content: 'NEWER_CONTENT' } });
  const before = await store.read();
  const consumed = ui(() => consumeNewAgentComposition(1, result.token, path.join(state.root, 'project'), params));
  try {
    const run = await startDurableCreation(path.join(state.root, 'project'), params, consumed.options);
    const observed = run.done.then((value) => ({ value }), (error: unknown) => ({ error }));
    owned.push(observed);
    expect(await run.done).toBe(changed ? 'failed' : 'ready');
    const after = await store.read();
    expect(after.assets).toEqual(before.assets);
    const records = JSON.parse(fs.readFileSync(path.join(state.root, 'project', '.clubhouse', 'agents.json'), 'utf8'));
    if (changed) {
      expect(after.compositions[run.agentId]).toBeUndefined();
      expect(records.find((row: { id: string }) => row.id === run.agentId).creation.state).toBe('failed');
    } else {
      expect(after.compositions[run.agentId].entries.at(-1)?.source).toEqual({ kind: 'follow', blockId: block.id });
      expect(records.find((row: { id: string }) => row.id === run.agentId).creation).toBeUndefined();
    }
  } finally { consumed.release(); }
});
