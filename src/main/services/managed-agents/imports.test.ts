import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrchestratorConventions } from '../../orchestrators/types';

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => os.tmpdir() } }));
vi.mock('../log-service', () => ({ appLog: vi.fn() }));

import { createAssetCatalogStore } from '../asset-catalog/store';
import { _resetSettingsAuditForTesting, withSettingsSurface } from '../settings-audit';
import { createManagedStateStore } from './state-store';
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

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-import-'));
  fs.mkdirSync(path.join(root, '.github/skills/review'), { recursive: true });
  fs.writeFileSync(path.join(root, '.github/skills/review/SKILL.md'), '---\nname: review\n---\nReview it.\n');
  _resetSettingsAuditForTesting(false);
  service = createManagedAgentsService({
    catalog: createAssetCatalogStore({ dir: path.join(root, 'catalog') }),
    state: createManagedStateStore(path.join(root, 'managed')),
    listProjects: async () => [], listAgents: async () => [], getAgent: async () => null,
    setManagedSetup: async () => { throw new Error('Import must not assign or convert anything.'); }, isRunning: () => false,
  });
  candidateId = (await discoverManagedAssets({ root, conventions })).candidates[0].id;
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('controlled managed library imports (#2855)', () => {
  it('previews without a write, then commits a complete independent copy with path-free provenance', async () => {
    const plan = await prepare({ candidateId, mode: 'copy', name: 'Imported review' });
    expect(await service.listParts('skill')).toEqual([]);
    expect(plan.preview).toMatchObject({ mode: 'copy', files: [{ path: 'SKILL.md' }], dependencies: 'not_confirmed', providerLoaded: 'not_confirmed' });
    expect(JSON.stringify(plan.preview)).not.toContain('Review it.');
    expect(JSON.stringify(plan.preview)).not.toContain(root);
    const saved = await user(() => plan.commit('Dispatcher'));
    expect((await service.getPart(saved.id)).content).toMatchObject({ kind: 'skill', files: [{ path: 'SKILL.md', content: expect.stringContaining('Review it.') }] });
    expect((await service.liveEntries())[saved.id].source).toEqual({ kind: 'import', from: 'project-skill', projectId: 'project-1', nativeName: 'review' });
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
