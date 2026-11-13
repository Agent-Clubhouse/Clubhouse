import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrchestratorConventions } from '../../orchestrators/types';

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => os.tmpdir() } }));
vi.mock('../log-service', () => ({ appLog: vi.fn() }));

import { createAssetCatalogStore, type AssetCatalogStore } from '../asset-catalog/store';
import { _resetSettingsAuditForTesting, withSettingsSurface } from '../settings-audit';
import { createManagedStateStore, type ManagedStateStore } from './state-store';
import { createManagedAgentsService, type ManagedAgentsService } from './service';
import { discoverManagedAssets } from './discovery';
import { prepareManagedAssetImport, type ManagedAssetImportRequest } from './imports';

const conventions: OrchestratorConventions = {
  configDir: '.github', skillsDir: 'skills', mcpConfigFile: '.github/mcp.json',
  localInstructionsFile: 'copilot-instructions.md', legacyInstructionsFile: 'AGENTS.md', localSettingsFile: 'settings.json',
};
let root: string, service: ManagedAgentsService, candidateId: string;
const user = <T>(fn: () => T) => withSettingsSurface('ui', undefined, fn);
const prepare = (request: ManagedAssetImportRequest) => prepareManagedAssetImport(service, { root, conventions }, request, 'project-1');
const makeService = (catalog: AssetCatalogStore, state: ManagedStateStore) => createManagedAgentsService({
  catalog, state, listProjects: async () => [], listAgents: async () => [], getAgent: async () => null,
  setManagedSetup: async () => { throw new Error('Import must not assign or convert anything.'); }, isRunning: () => false,
});

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-import-'));
  fs.mkdirSync(path.join(root, '.github/skills/review'), { recursive: true });
  fs.writeFileSync(path.join(root, '.github/skills/review/SKILL.md'), '---\nname: review\n---\nReview it.\n');
  _resetSettingsAuditForTesting(false);
  service = makeService(createAssetCatalogStore({ dir: path.join(root, 'catalog') }), createManagedStateStore(path.join(root, 'managed')));
  candidateId = (await discoverManagedAssets({ root, conventions })).candidates[0].id;
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('controlled managed library imports (#2855)', () => {
  describe('a prepared independent copy', () => {
    let plan: Awaited<ReturnType<typeof prepare>>;
    beforeEach(async () => {
      plan = await prepare({ candidateId, mode: 'copy', name: 'Imported review' });
    });

    it('previews without a write, then commits a complete independent copy with path-free provenance', async () => {
      expect(await service.listParts('skill')).toEqual([]);
      expect(plan.preview).toMatchObject({ mode: 'copy', files: [{ path: 'SKILL.md' }], dependencies: { status: 'none_declared', declared: [] }, providerLoaded: 'not_confirmed' });
      expect(JSON.stringify(plan.preview)).not.toContain('Review it.');
      expect(JSON.stringify(plan.preview)).not.toContain(root);
      const saved = await user(() => plan.commit('Dispatcher'));
      expect((await service.getPart(saved.id)).content).toMatchObject({ kind: 'skill', files: [{ path: 'SKILL.md', content: expect.stringContaining('Review it.') }] });
      expect((await service.liveEntries())[saved.id].source).toEqual({ kind: 'import', from: 'project-skill', projectId: 'project-1', nativeName: 'review' });
    }, 10_000); // Real payload, catalog and managed-state atomic writes plus readback.
  });

  it('requires explicit exact shared reuse and never edits or silently forks a matching part', async () => {
    const copied = await user(async () => (await prepare({ candidateId, mode: 'copy', name: 'Shared review' })).commit('Dispatcher'));
    const plan = await prepare({ candidateId, mode: 'reuse', partId: copied.id });
    expect(plan.preview.shared).toMatchObject({ id: copied.id, revision: copied.revision });
    expect((await user(() => plan.commit('Dispatcher'))).id).toBe(copied.id);
    expect(await service.listParts('skill')).toHaveLength(1);
    const fork = await prepare({ candidateId, mode: 'copy', name: 'Independent review' });
    expect(fork.preview.matches).toMatchObject([{ id: copied.id }]);
    const independent = await user(() => fork.commit('Dispatcher'));
    expect(independent.id).not.toBe(copied.id);
    fs.writeFileSync(path.join(root, '.github/skills/review/SKILL.md'), '---\nname: review\n---\nChanged.\n');
    await expect(prepare({ candidateId, mode: 'reuse', partId: copied.id })).rejects.toThrow('does not exactly match');
  });

  it('changes the confirmation fingerprint for source, library revisions and copy choices', async () => {
    const request = { candidateId, mode: 'copy' as const, name: 'Original name' };
    const first = await prepare(request);
    expect((await prepare({ ...request, name: 'Different name' })).fingerprint).not.toBe(first.fingerprint);
    const part = await user(() => first.commit('Dispatcher'));
    expect((await prepare(request)).fingerprint).not.toBe(first.fingerprint);
    const reuse = { candidateId, mode: 'reuse' as const, partId: part.id };
    const before = await prepare(reuse);
    await user(() => service.updatePart({ id: part.id, expectedRevision: part.revision, description: 'Updated description' }));
    expect((await prepare(reuse)).fingerprint).not.toBe(before.fingerprint);
  });

  it('revalidates source bytes at commit, not only when the confirmation plan was prepared', async () => {
    const plan = await prepare({ candidateId, mode: 'copy', name: 'Changed at effect boundary' });
    fs.writeFileSync(path.join(root, '.github/skills/review/SKILL.md'), 'Changed during import preparation.\n');
    await expect(user(() => plan.commit('Dispatcher'))).rejects.toMatchObject({ code: 'stale' });
    expect(await service.listParts('skill')).toEqual([]);
  });

  it('refuses source edits while the final library snapshot is being read', async () => {
    const plan = await prepare({ candidateId, mode: 'copy', name: 'Source edited during final snapshot' });
    const entries = service.liveEntries.bind(service);
    vi.spyOn(service, 'liveEntries').mockImplementationOnce(async () => {
      fs.writeFileSync(path.join(root, '.github/skills/review/SKILL.md'), 'Changed during the final snapshot.\n');
      return entries();
    });
    await expect(user(() => plan.commit('Dispatcher'))).rejects.toMatchObject({ code: 'stale' });
    expect(await service.listParts('skill')).toEqual([]);
  });

  it('checks matching library metadata after asynchronous authorization preparation', async () => {
    const copied = await user(async () => (await prepare({ candidateId, mode: 'copy', name: 'Original shared match' })).commit('Dispatcher'));
    const plan = await prepare({ candidateId, mode: 'copy', name: 'Library edited during authorization' });
    await expect(user(() => plan.commit('Dispatcher', async () => {
      await service.updatePart({ id: copied.id, expectedRevision: 1, description: 'Changed while authorization resolved' });
      return () => undefined;
    }))).rejects.toMatchObject({ code: 'stale' });
    expect(await service.listParts('skill')).toHaveLength(1);
  });

  it('revalidates source bytes after asynchronous payload writes, before the catalog commit', async () => {
    let changed = false;
    const catalog = createAssetCatalogStore({ dir: path.join(root, 'late-catalog'), rename: async (from, to) => {
      await fs.promises.rename(from, to);
      if (!changed && to.includes(`${path.sep}revisions${path.sep}`)) {
        changed = true;
        fs.writeFileSync(path.join(root, '.github/skills/review/SKILL.md'), 'Changed during payload IO.\n');
      }
    } });
    const late = makeService(catalog, createManagedStateStore(path.join(root, 'late-state')));
    const plan = await prepareManagedAssetImport(late, { root, conventions }, { candidateId, mode: 'copy', name: 'Late source edit' }, 'project-1');
    await expect(user(() => plan.commit('Dispatcher'))).rejects.toMatchObject({ code: 'stale' });
    expect(await late.listParts('skill')).toEqual([]);
    expect(Object.keys((await catalog.read()).assets)).toEqual([]);
  });

  it('rechecks the library snapshot after waiting in the serialized catalog write queue', async () => {
    let entered!: () => void, release!: () => void, queued!: () => void;
    const writing = new Promise<void>((resolve) => { entered = resolve; });
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const importQueued = new Promise<void>((resolve) => { queued = resolve; });
    let paused = false;
    const catalog = createAssetCatalogStore({ dir: path.join(root, 'queued-catalog'), rename: async (from, to) => {
      if (!paused && path.basename(to) === 'catalog.json') { paused = true; entered(); await wait; }
      await fs.promises.rename(from, to);
    } });
    const late = makeService(catalog, createManagedStateStore(path.join(root, 'queued-state')));
    const writer = user(() => catalog.createAsset({ kind: 'block', name: 'Concurrent library change', payload: { content: 'Unrelated block' } }));
    await writing;
    try {
      const plan = await prepareManagedAssetImport(late, { root, conventions }, { candidateId, mode: 'copy', name: 'Queued import' }, 'project-1');
      const create = catalog.createAsset.bind(catalog);
      vi.spyOn(catalog, 'createAsset').mockImplementationOnce((...args) => { const result = create(...args); queued(); return result; });
      const outcome = user(() => plan.commit('Dispatcher')).catch((error: unknown) => error);
      await importQueued;
      release(); await writer;
      expect(await outcome).toMatchObject({ code: 'stale' });
      expect(await late.listParts('skill')).toEqual([]);
    } finally { release(); await writer; }
  });

  it('reports the durable created part and unfinished metadata stage instead of a false full failure', async () => {
    const catalog = createAssetCatalogStore({ dir: path.join(root, 'partial-catalog') });
    const backing = createManagedStateStore(path.join(root, 'partial-state'));
    const failing = makeService(catalog, { read: backing.read, update: async () => { throw new Error('password=private-value at /private/state'); } });
    const plan = await prepareManagedAssetImport(failing, { root, conventions }, { candidateId, mode: 'copy', name: 'Durable partial import' }, 'project-1');
    const outcome = await user(() => plan.commit('Dispatcher')).catch((error: unknown) => error);
    const persisted = Object.values((await catalog.read()).assets).filter((entry) => !entry.deletedAt);
    expect(persisted).toHaveLength(1);
    expect(outcome).toMatchObject({
      code: 'failed',
      receipt: { partId: persisted[0].id, revision: 1, catalog: 'committed', metadata: 'not_saved', unfinishedStage: 'metadata' },
      message: expect.stringContaining('Do not retry creation'),
    });
    expect(JSON.stringify(outcome)).not.toMatch(/private-value|\/private\/state/);
    expect((await failing.getPart(persisted[0].id)).content.kind).toBe('skill');
  });

  it('distinguishes saved metadata from failed result readback without losing the durable part id', async () => {
    const catalog = createAssetCatalogStore({ dir: path.join(root, 'readback-catalog') });
    const backing = createManagedStateStore(path.join(root, 'readback-state'));
    let unreadable = false;
    const failing = makeService(catalog, {
      read: async () => { if (unreadable) throw new Error('password=private-readback'); return backing.read(); },
      update: async (fn) => { const result = await backing.update(fn); unreadable = true; return result; },
    });
    const plan = await prepareManagedAssetImport(failing, { root, conventions }, { candidateId, mode: 'copy', name: 'Readback partial import' }, 'project-1');
    const outcome = await user(() => plan.commit('Dispatcher')).catch((error: unknown) => error);
    const entry = Object.values((await catalog.read()).assets)[0];
    expect(outcome).toMatchObject({ receipt: { partId: entry.id, catalog: 'committed', metadata: 'saved', unfinishedStage: 'readback' } });
    expect(JSON.stringify(outcome)).not.toContain('private-readback');
    expect((await backing.read()).parts[entry.id]).toMatchObject({ updatedBy: 'Dispatcher' });
  });

  it.each([
    { mode: 'reuse' as const },
    { mode: 'copy' as const },
    { mode: 'copy' as const, name: 'A copy', partId: 'unasked-fork' },
    { mode: 'reuse' as const, partId: 'shared', name: 'Unasked rename' },
    { mode: 'copy' as const, name: 'password=private-value' },
  ])('refuses ambiguous shared/copy choices', async (request) => {
    await expect(prepare({ candidateId, ...request })).rejects.toThrow();
    expect(await service.listParts('skill')).toEqual([]);
  });
});
