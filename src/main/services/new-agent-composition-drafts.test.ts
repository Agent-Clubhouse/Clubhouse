import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ root: '', generation: 0, pending: false }));
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => state.root } }));
vi.mock('./base-dir', () => ({ getBaseDirPath: () => state.root }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./project-store', () => ({
  peekProjects: async () => [{ id: 'project-1', path: path.join(state.root, 'project') }],
  projectRegistryMutationState: () => ({ generation: state.generation, pending: state.pending }),
}));
import { seedBuilderTemplates } from './asset-catalog/builder-seeds';
import { createAssetCatalogStore, assetCatalogDir } from './asset-catalog/store';
import { withSettingsSurface, _resetSettingsAuditForTesting } from './settings-audit';
import { previewNewAgentComposition, consumeNewAgentComposition, discardNewAgentComposition } from './new-agent-composition-drafts';

const params = { name: 'new-agent', color: 'blue', useWorktree: false };
const tokens: string[] = [];
const ui = <T,>(fn: () => T): T => withSettingsSurface('ui', undefined, fn);
async function preview(sender = 1) {
  const result = await ui(() => previewNewAgentComposition(sender, 'project-1', 'builtin-builder-custom', []));
  tokens.push(result.token); return result;
}
beforeEach(async () => {
  state.root = fs.mkdtempSync(path.join(os.tmpdir(), 'new-composition-drafts-'));
  state.generation = 0; state.pending = false;
  _resetSettingsAuditForTesting(false);
  await withSettingsSurface('system', undefined, () => seedBuilderTemplates(createAssetCatalogStore({ dir: assetCatalogDir() })));
});
afterEach(() => {
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
