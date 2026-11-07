import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DurableAgentConfig } from '../../shared/types';
import type { BaseAdoption } from '../../shared/asset-catalog-types';

const state = vi.hoisted(() => ({ root: '', beforeRename: undefined as undefined | (() => void), beforeReadyRename: undefined as undefined | (() => void) }));
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => state.root } }));
vi.mock('./base-dir', () => ({ getBaseDirPath: () => state.root }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./agent-settings-service', () => ({
  readProjectAgentDefaults: async () => ({}), applyAgentDefaults: async () => {},
  readSourcePersonaContent: async () => '',
}));
vi.mock('./agent-system', () => ({ resolveOrchestrator: async () => ({ conventions: {}, writeInstructions: async () => {} }) }));
// Real writes/sync/rename. Hook only the owned catalog staging boundary.
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return { ...actual, rename: async (...args: Parameters<typeof actual.rename>) => {
    if (String(args[1]).endsWith(path.join('.clubhouse', 'agents.json')) && state.beforeReadyRename) {
      const records = JSON.parse(await actual.readFile(args[0], 'utf8')) as DurableAgentConfig[];
      if (records.some((record) => !record.creation)) state.beforeReadyRename();
    }
    return actual.rename(...args);
  }, open: async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args);
    if (!String(args[0]).startsWith(path.join(state.root, 'asset-catalog', 'catalog.json.tmp.'))) return handle;
    return { writeFile: handle.writeFile.bind(handle), close: handle.close.bind(handle),
      sync: async () => { await handle.sync(); state.beforeRename?.(); },
    };
  } };
});

import { clearAgentConfigCache, flushAgentConfig, recoverInterruptedCreations } from './agent-config';
import { startDurableCreation, cancelDurableCreation } from './agent-creation';
import { creationCompositionCommit } from './new-agent-composition-catalog';
import { assetCatalogDir, createAssetCatalogStore } from './asset-catalog/store';
import { emptyComposition } from './asset-catalog/planner';
import { _resetSettingsAuditForTesting } from './settings-audit';

const adoption: BaseAdoption = { content: { mode: 'takeable' }, structure: { mode: 'accepted' } };
let project: string;
const owned: Promise<unknown>[] = [];
function observe<T>(promise: Promise<T>) {
  const observed = promise.then(value => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
  owned.push(observed); return observed;
}
const records = (): DurableAgentConfig[] => JSON.parse(fs.readFileSync(path.join(project, '.clubhouse', 'agents.json'), 'utf8'));
const indexPath = () => path.join(assetCatalogDir(), 'catalog.json');
beforeEach(() => {
  state.root = fs.mkdtempSync(path.join(os.tmpdir(), 'creation-composition-'));
  project = path.join(state.root, 'project'); fs.mkdirSync(project);
  state.beforeRename = undefined; state.beforeReadyRename = undefined; clearAgentConfigCache(); _resetSettingsAuditForTesting(false);
});
afterEach(async () => {
  state.beforeRename = undefined; state.beforeReadyRename = undefined;
  await Promise.all(owned.splice(0));
  await flushAgentConfig(); clearAgentConfigCache(); _resetSettingsAuditForTesting(false);
  fs.rmSync(state.root, { recursive: true, force: true });
});
async function reviewed(agentId: string) {
  const composition = emptyComposition();
  const store = createAssetCatalogStore({ dir: assetCatalogDir() });
  const plan = await store.plan({ agentId, projectId: 'project-1', draft: composition, adoption });
  return { agentId, projectId: 'project-1', composition, adoption, previewFingerprint: plan.fingerprint, sourceRevisions: {} };
}

it('commits through the real store and flushes readiness only after the saved composition', async () => {
  const started = await startDurableCreation(project, { name: 'saved', color: 'blue', useWorktree: false }, {
    commitComposition: async (config, reservation) => {
      expect(records()[0].creation?.composition?.phase).toBe('prepared');
      await creationCompositionCommit(await reviewed(config.id), () => {})(config, reservation);
      expect((await createAssetCatalogStore({ dir: assetCatalogDir() }).read()).compositions[config.id].revision).toBe(1);
    },
  });
  observe(started.done);
  expect(await started.done).toBe('ready');
  await flushAgentConfig();
  expect(records()[0].creation).toBeUndefined();
});

it('refuses project mutation at the real staging-to-rename boundary', async () => {
  let current = true;
  const started = await startDurableCreation(project, { name: 'remapped', color: 'blue', useWorktree: false }, {
    commitComposition: async (config, reservation) => {
      const input = await reviewed(config.id);
      state.beforeRename = () => { current = false; };
      await creationCompositionCommit(input, () => { if (!current) throw new Error('project changed'); })(config, reservation);
    },
  });
  observe(started.done);
  expect(await started.done).toBe('failed');
  expect((await createAssetCatalogStore({ dir: assetCatalogDir() }).read()).compositions[started.agentId]).toBeUndefined();
  expect(records()[0].creation?.state).toBe('failed');
});

it('retains the real saved composition on postcommit cancellation and persisted recovery', async () => {
  let cancellation: ReturnType<typeof observe> | undefined;
  const started = await startDurableCreation(project, { name: 'cancelled', color: 'blue', useWorktree: false }, {
    commitComposition: async (config, reservation) => {
      await creationCompositionCommit(await reviewed(config.id), () => {})(config, reservation);
      cancellation = observe(cancelDurableCreation(project, config.id));
    },
  });
  observe(started.done);
  expect(await started.done).toBe('failed');
  expect((await cancellation)?.ok).toBe(false);
  const store = createAssetCatalogStore({ dir: assetCatalogDir() });
  const saved = (await store.read()).compositions[started.agentId];
  const plan = await store.plan({ agentId: started.agentId, projectId: 'project-1', adoption, draft: saved });
  await store.saveComposition({ agentId: started.agentId, projectId: 'project-1', expectedRevision: 1,
    composition: saved, adoption, previewFingerprint: plan.fingerprint });
  const bytes = fs.readFileSync(indexPath());
  const disk = records();
  disk[0].creation = { ...disk[0].creation!, state: 'creating', owner: undefined, heartbeatAt: undefined };
  fs.writeFileSync(path.join(project, '.clubhouse', 'agents.json'), JSON.stringify(disk));
  clearAgentConfigCache();
  await recoverInterruptedCreations(project);
  expect(records()[0].creation).toMatchObject({ state: 'failed', composition: { expectedRevision: 1, phase: 'committed' } });
  expect(fs.readFileSync(indexPath())).toEqual(bytes);
  expect((await store.read()).compositions[started.agentId].revision).toBe(2);
});

it('binds source revisions and leaves a newer asset untouched on refusal', async () => {
  const store = createAssetCatalogStore({ dir: assetCatalogDir() });
  const asset = await store.createAsset({ kind: 'block', name: 'Source', payload: { content: 'original' } });
  let newerBytes: Buffer | undefined;
  const started = await startDurableCreation(project, { name: 'stale-source', color: 'blue', useWorktree: false }, {
    commitComposition: async (config, reservation) => {
      const input = { ...await reviewed(config.id), sourceRevisions: { [asset.id]: 1 } };
      await store.saveRevision({ assetId: asset.id, expectedRevision: 1, payload: { content: 'newer' } });
      newerBytes = fs.readFileSync(indexPath());
      await creationCompositionCommit(input, () => {})(config, reservation);
    },
  });
  observe(started.done);
  expect(await started.done).toBe('failed');
  expect(newerBytes).toBeDefined();
  expect(fs.readFileSync(indexPath())).toEqual(newerBytes);
  expect((await store.read()).assets[asset.id].headRevision).toBe(2);
});

it('restores the journal and reports failed when cancellation arrives during readiness flush', async () => {
  let cancellation: ReturnType<typeof observe> | undefined;
  const started = await startDurableCreation(project, { name: 'flush-cancel', color: 'blue', useWorktree: false }, {
    commitComposition: async (config, reservation) => {
      await creationCompositionCommit(await reviewed(config.id), () => {})(config, reservation);
      state.beforeReadyRename = () => {
        state.beforeReadyRename = undefined;
        cancellation = observe(cancelDurableCreation(project, config.id));
      };
    },
  });
  observe(started.done);
  expect(await started.done).toBe('failed');
  expect((await cancellation)?.ok).toBe(false);
  expect(records()[0].creation).toMatchObject({ state: 'failed', composition: { phase: 'committed' } });
  expect((await createAssetCatalogStore({ dir: assetCatalogDir() }).read()).compositions[started.agentId].revision).toBe(1);
});
