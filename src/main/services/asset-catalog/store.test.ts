import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const W = vi.hoisted(() => ({ home: '' }));

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => W.home } }));
vi.mock('../log-service', () => ({ appLog: vi.fn() }));

import { _resetSettingsAuditForTesting, readSettingsAudit, withSettingsSurface } from '../settings-audit';
import { AssetCatalogError, assetCatalogDir, createAssetCatalogStore, type AssetCatalogStore } from './store';
import type { BaseAdoption, CompositionInput, McpAssetPayload } from '../../../shared/asset-catalog-types';

const LATEST: BaseAdoption = { mode: 'latest' };
const FAKE_GH_TOKEN = `ghp_${'a1B2c3D4e5'.repeat(4)}`;

const doc = (content = 'You are @@AgentName.') => ({ content });
const skillOf = (skillName: string, body = '# Skill') => ({ skillName, files: [{ path: 'SKILL.md', content: body }, { path: 'scripts/run.sh', content: 'echo hi', executable: true }] });
const mcpOf = (serverKey: string): McpAssetPayload => ({ serverKey, transport: 'stdio', command: 'npx', args: ['-y', '@microsoft/workiq', 'mcp'], auth: 'external' });
const compositionOf = (input: Partial<CompositionInput> = {}): CompositionInput => ({ basePresetId: null, additions: [], removals: [], instructionAssetId: null, ...input });

let dir: string;
let store: AssetCatalogStore;
let nextId: number;
let renameFault: ((from: string, to: string) => Error | null) | null;

function makeStore(): AssetCatalogStore {
  return createAssetCatalogStore({
    dir,
    newId: () => `asset-${++nextId}`,
    now: () => '2026-11-04T00:00:00.000Z',
    rename: async (from, to) => {
      const fault = renameFault?.(from, to);
      if (fault) throw fault;
      await fs.promises.rename(from, to);
    },
  });
}

beforeEach(() => {
  W.home = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-catalog-'));
  dir = path.join(W.home, 'catalog');
  nextId = 0;
  renameFault = null;
  store = makeStore();
  _resetSettingsAuditForTesting(true);
});

afterEach(() => {
  _resetSettingsAuditForTesting(false);
  fs.rmSync(W.home, { recursive: true, force: true });
});

async function rejection(promise: Promise<unknown>): Promise<AssetCatalogError> {
  const result = await promise.then(() => null, (err: unknown) => err);
  expect(result).toBeInstanceOf(AssetCatalogError);
  return result as AssetCatalogError;
}

const code = async (promise: Promise<unknown>): Promise<string> => (await rejection(promise)).code;

/** Compose through the path a user takes: preview, then commit that preview. */
async function compose(agentId: string, input: Partial<CompositionInput>, expectedRevision = 0) {
  const composition = compositionOf(input);
  const preview = await store.plan({ agentId, adoption: LATEST, draft: composition });
  return store.saveComposition({ agentId, expectedRevision, composition, adoption: LATEST, previewFingerprint: preview.fingerprint });
}

async function saveEdit(assetId: string, payload: unknown, expectedRevision: number) {
  const impact = await store.previewAssetEdit({ assetId, payload });
  return store.saveRevision({ assetId, expectedRevision, payload, impactFingerprint: impact.fingerprint });
}

/** Asset ids in the order they were made: doc, review, git, base. */
async function seedBase() {
  const instruction = await store.createAsset({ kind: 'instruction', name: 'Orchestrator', payload: doc() });
  const review = await store.createAsset({ kind: 'skill', name: 'Code review', payload: skillOf('code-review') });
  const git = await store.createAsset({ kind: 'mcp', name: 'Git', payload: mcpOf('git') });
  const base = await store.createAsset({
    kind: 'preset',
    name: 'Orchestrator',
    payload: { instruction: instruction.id, skills: [review.id], mcps: [git.id], operationalDefaults: { orchestrate: true } },
  });
  return { instruction, review, git, base };
}

/** Every file below `root`, relative to it, with `/` separators on every platform. */
function filesUnder(root: string, prefix = ''): string[] {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((item) => (
    item.isDirectory() ? filesUnder(path.join(root, item.name), `${prefix}${item.name}/`) : [`${prefix}${item.name}`]
  ));
}

describe('reading', () => {
  it('reads as empty and creates nothing', async () => {
    expect(await store.read()).toEqual({ version: 1, assets: {}, compositions: {}, runs: {} });
    expect(await store.plan({ agentId: 'a', adoption: LATEST })).toMatchObject({ blockers: [], compositionRevision: 0 });
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('a read of existing data writes nothing', async () => {
    const asset = await store.createAsset({ kind: 'instruction', name: 'Doc', payload: doc() });
    const stamp = fs.statSync(path.join(dir, 'catalog.json')).mtimeMs;
    const listing = filesUnder(dir);
    await store.read();
    await store.readRevision(asset.id, 1);
    await store.previewRevision(asset.id, 1);
    await store.plan({ agentId: 'a', adoption: LATEST, draft: compositionOf({ instructionAssetId: asset.id }) });
    await store.previewAssetEdit({ assetId: asset.id, payload: doc('next') });
    await store.originStatus(asset.id);
    expect(fs.statSync(path.join(dir, 'catalog.json')).mtimeMs).toBe(stamp);
    expect(filesUnder(dir)).toEqual(listing);
  });

  it('lives under the base dir, in a path safe on every platform', async () => {
    expect(assetCatalogDir()).toBe(path.join(W.home, '.clubhouse-dev', 'asset-catalog'));
    await store.createAsset({ kind: 'instruction', name: 'Name: with / odd * chars?', payload: doc() });
    for (const file of filesUnder(dir)) {
      expect(file).toMatch(/^[A-Za-z0-9._/-]+$/);
    }
  });
});

describe('saving unassigned assets', () => {
  it('saves each kind with no consumer and stable ids', async () => {
    const { instruction, review, git, base } = await seedBase();
    expect([instruction, review, git, base].map((asset) => asset.id)).toEqual(['asset-1', 'asset-2', 'asset-3', 'asset-4']);
    expect(base.revisions[0].projection).toMatchObject({ kind: 'preset', instruction: instruction.id });
    const index = await store.read();
    expect(index.compositions).toEqual({});
    expect(index.assets[git.id].source).toEqual({ kind: 'user' });
    expect(await store.readRevision(review.id, 1)).toEqual({
      skillName: 'code-review',
      files: [{ path: 'SKILL.md', content: '# Skill' }, { path: 'scripts/run.sh', content: 'echo hi', executable: true }],
    });
  });

  it('keeps no payload content in the index', async () => {
    await store.createAsset({ kind: 'instruction', name: 'Doc', payload: doc('distinctive-instruction-text') });
    await store.createAsset({ kind: 'skill', name: 'Skill', payload: skillOf('s', 'distinctive-skill-text') });
    await store.createAsset({ kind: 'mcp', name: 'Server', payload: { ...mcpOf('m'), env: { LOG_LEVEL: 'distinctive-env-value' } } });
    const raw = fs.readFileSync(path.join(dir, 'catalog.json'), 'utf8');
    for (const text of ['distinctive-instruction-text', 'distinctive-skill-text', 'distinctive-env-value']) {
      expect(raw).not.toContain(text);
    }
  });

  it('records provenance, and a built-in may use the reserved namespace', async () => {
    expect(await code(store.createAsset({ kind: 'mcp', name: 'Bridge', payload: mcpOf('clubhouse') }))).toBe('invalid_payload');
    const bridge = await store.createAsset({ kind: 'mcp', name: 'Bridge', payload: mcpOf('clubhouse'), source: { kind: 'builtin', builtinId: 'clubhouse-bridge' } });
    expect(bridge.source).toEqual({ kind: 'builtin', builtinId: 'clubhouse-bridge' });
    const imported = await store.createAsset({
      kind: 'skill',
      name: 'Imported',
      payload: skillOf('imported'),
      source: { kind: 'import', from: 'project-skill', projectId: 'p1', nativeName: 'imported' },
    });
    expect(imported.source).toMatchObject({ from: 'project-skill', projectId: 'p1' });
  });

  it('rejects invalid input, forbidden preset fields and invalid cardinality, and writes nothing', async () => {
    expect((await rejection(store.createAsset({ kind: 'mcp', name: 'x', payload: { serverKey: '' } }))).details.issues?.length).toBeGreaterThan(0);
    expect(await code(store.createAsset({ kind: 'instruction', name: '', payload: doc() }))).toBe('invalid_payload');
    expect(await code(store.createAsset({ kind: 'instruction', name: 'x', payload: doc(), source: { kind: 'copy', originAssetId: 'a', originRevision: 1 } }))).toBe('invalid_payload');
    const issues = (await rejection(store.createAsset({ kind: 'preset', name: 'x', payload: { instruction: 'a', skills: [], mcps: [], model: 'opus' } }))).details.issues;
    expect(issues).toContainEqual({ code: 'forbidden_preset_field', path: 'model' });
    expect(await code(store.createAsset({ kind: 'preset', name: 'x', payload: { instructions: ['a', 'b'], skills: [], mcps: [] } }))).toBe('invalid_payload');
    expect(filesUnder(dir)).toEqual([]);
  });

  it('a preset refers only to live library assets of the right kind', async () => {
    const { instruction, review, git, base } = await seedBase();
    const preset = (payload: Record<string, unknown>) => store.createAsset({ kind: 'preset', name: 'x', payload: { instruction: instruction.id, skills: [], mcps: [], ...payload } });
    expect(await code(preset({ instruction: 'asset-missing' }))).toBe('invalid_reference');
    expect(await code(preset({ instruction: review.id }))).toBe('invalid_reference');
    expect(await code(preset({ skills: [git.id] }))).toBe('invalid_reference');
    const nested = await rejection(preset({ skills: [base.id] }));
    expect(nested.details.issues).toContainEqual({ code: 'nested_preset', path: 'skills[0]' });
    const copy = await store.copyAsset({ assetId: review.id, revision: 1, agentId: 'agent-1' });
    expect(await code(preset({ skills: [copy.id] }))).toBe('invalid_reference');
  });
});

describe('revisions', () => {
  it('appends immutable revisions under an expected revision', async () => {
    const asset = await store.createAsset({ kind: 'instruction', name: 'Doc', payload: doc('one') });
    const first = fs.readFileSync(path.join(dir, 'revisions', asset.id, '1.json'), 'utf8');
    const saved = await store.saveRevision({ assetId: asset.id, expectedRevision: 1, payload: doc('two') });
    expect(saved).toMatchObject({ headRevision: 2 });
    expect(await store.readRevision(asset.id, 1)).toEqual(doc('one'));
    expect(await store.readRevision(asset.id, 2)).toEqual(doc('two'));
    expect(fs.readFileSync(path.join(dir, 'revisions', asset.id, '1.json'), 'utf8')).toBe(first);
  });

  it('a stale expected revision fails explicitly and changes nothing', async () => {
    const asset = await store.createAsset({ kind: 'instruction', name: 'Doc', payload: doc('one') });
    await store.saveRevision({ assetId: asset.id, expectedRevision: 1, payload: doc('two') });
    const error = await rejection(store.saveRevision({ assetId: asset.id, expectedRevision: 1, payload: doc('three') }));
    expect(error.code).toBe('stale_revision');
    expect(error.details).toMatchObject({ expected: 1, current: 2 });
    expect((await store.read()).assets[asset.id].headRevision).toBe(2);
    expect(await code(store.readRevision(asset.id, 3))).toBe('revision_unavailable');
  });

  it('two racing saves: exactly one wins, whatever the order', async () => {
    const asset = await store.createAsset({ kind: 'instruction', name: 'Doc', payload: doc('one') });
    const results = await Promise.allSettled([
      store.saveRevision({ assetId: asset.id, expectedRevision: 1, payload: doc('a') }),
      store.saveRevision({ assetId: asset.id, expectedRevision: 1, payload: doc('b') }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect((await store.read()).assets[asset.id].headRevision).toBe(2);
  });

  it('a revision that fails validation adds nothing', async () => {
    const asset = await store.createAsset({ kind: 'mcp', name: 'Server', payload: mcpOf('a') });
    expect(await code(store.saveRevision({ assetId: asset.id, expectedRevision: 1, payload: { ...mcpOf('a'), env: { API_KEY: 'x' } } }))).toBe('invalid_payload');
    expect((await store.read()).assets[asset.id].headRevision).toBe(1);
    expect(filesUnder(path.join(dir, 'revisions', asset.id))).toEqual(['1.json']);
  });

  it('a damaged payload file fails rather than handing back altered content', async () => {
    const asset = await store.createAsset({ kind: 'instruction', name: 'Doc', payload: doc('one') });
    const file = path.join(dir, 'revisions', asset.id, '1.json');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('one', 'two'));
    expect(await code(store.readRevision(asset.id, 1))).toBe('payload_corrupt');
    fs.writeFileSync(file, '{ not json');
    expect(await code(store.readRevision(asset.id, 1))).toBe('payload_corrupt');
    fs.rmSync(file);
    expect(await code(store.readRevision(asset.id, 1))).toBe('revision_unavailable');
  });
});

describe('renames', () => {
  it('keeps every reference, and the projected destination', async () => {
    const { review, base } = await seedBase();
    await compose('agent-1', { basePresetId: base.id, additions: [] });
    const before = await store.plan({ agentId: 'agent-1', adoption: LATEST });

    const renamed = await store.renameAsset({ assetId: review.id, expectedName: 'Code review', name: 'Careful review' });
    expect(renamed).toMatchObject({ id: review.id, name: 'Careful review', headRevision: 1 });
    const renamedBase = await store.renameAsset({ assetId: base.id, expectedName: 'Orchestrator', name: 'Lead' });
    expect(renamedBase.id).toBe(base.id);

    const after = await store.plan({ agentId: 'agent-1', adoption: LATEST });
    expect(after.fingerprint).toBe(before.fingerprint);
    expect(after.skills[0]).toMatchObject({ assetId: review.id, name: 'Careful review', destination: { key: 'skills/code-review' } });
    expect(after.base?.name).toBe('Lead');
  });

  it('a stale or invalid rename fails', async () => {
    const asset = await store.createAsset({ kind: 'instruction', name: 'Doc', payload: doc() });
    await store.renameAsset({ assetId: asset.id, expectedName: 'Doc', name: 'One' });
    expect(await code(store.renameAsset({ assetId: asset.id, expectedName: 'Doc', name: 'Two' }))).toBe('stale_name');
    expect(await code(store.renameAsset({ assetId: asset.id, expectedName: 'One', name: '  ' }))).toBe('invalid_payload');
    expect((await store.read()).assets[asset.id].name).toBe('One');
  });
});

describe('deletion', () => {
  it('refuses while anything uses it, naming nothing but the asset', async () => {
    const { instruction, review, base } = await seedBase();
    expect(await code(store.deleteAsset({ assetId: review.id, expectedRevision: 1 }))).toBe('asset_in_use');
    expect(await code(store.deleteAsset({ assetId: instruction.id, expectedRevision: 1 }))).toBe('asset_in_use');
    await compose('agent-1', { basePresetId: base.id });
    expect(await code(store.deleteAsset({ assetId: base.id, expectedRevision: 1 }))).toBe('asset_in_use');
    expect((await store.read()).assets[review.id].deletedAt).toBeUndefined();
  });

  it('removes an unreferenced asset and its payloads', async () => {
    const asset = await store.createAsset({ kind: 'skill', name: 'Skill', payload: skillOf('s') });
    await store.saveRevision({ assetId: asset.id, expectedRevision: 1, payload: skillOf('s', 'two') });
    expect(await code(store.deleteAsset({ assetId: asset.id, expectedRevision: 1 }))).toBe('stale_revision');
    await store.deleteAsset({ assetId: asset.id, expectedRevision: 2 });
    expect((await store.read()).assets[asset.id]).toBeUndefined();
    expect(filesUnder(path.join(dir, 'revisions'))).toEqual([]);
    expect(await code(store.readRevision(asset.id, 1))).toBe('asset_missing');
  });

  it('an agent merely excluding it does not hold it, and the removal turns inert', async () => {
    const { review, base } = await seedBase();
    const extra = await store.createAsset({ kind: 'skill', name: 'Extra', payload: skillOf('extra') });
    await compose('agent-1', { basePresetId: base.id, removals: [review.id, extra.id] });
    await store.deleteAsset({ assetId: extra.id, expectedRevision: 1 });
    const plan = await store.plan({ agentId: 'agent-1', adoption: LATEST });
    expect(plan.blockers).toEqual([]);
    expect(plan.notices).toEqual([{ code: 'inert_removal', assetIds: [extra.id] }]);
  });

  it('a deleted asset takes no more edits or copies', async () => {
    const asset = await store.createAsset({ kind: 'skill', name: 'Skill', payload: skillOf('s') });
    await store.recordRun({ runId: 'run-1', plan: { agentId: 'a', compositionRevision: 1, fingerprint: 'f', base: null, assets: [{ assetId: asset.id, kind: 'skill', revision: 1, contentHash: 'h', destination: { kind: 'skill-directory', key: 'skills/s' } }], operationalDefaults: [] } });
    await store.deleteAsset({ assetId: asset.id, expectedRevision: 1 });
    expect(await code(store.saveRevision({ assetId: asset.id, expectedRevision: 1, payload: skillOf('s') }))).toBe('asset_deleted');
    expect(await code(store.renameAsset({ assetId: asset.id, expectedName: 'Skill', name: 'x' }))).toBe('asset_deleted');
    expect(await code(store.copyAsset({ assetId: asset.id, revision: 1, agentId: 'a' }))).toBe('asset_deleted');
  });
});

describe('committing a composition', () => {
  it('stores it under an expected revision, keyed by agent id and nothing else', async () => {
    const { base } = await seedBase();
    const stored = await compose('agent-1', { basePresetId: base.id });
    expect(stored).toEqual({
      agentId: 'agent-1',
      revision: 1,
      updatedAt: '2026-11-04T00:00:00.000Z',
      basePresetId: base.id,
      additions: [],
      removals: [],
      instructionAssetId: null,
    });
    const second = await compose('agent-1', { basePresetId: null }, 1);
    expect(second.revision).toBe(2);
    expect(await code(compose('agent-1', { basePresetId: base.id }, 1))).toBe('stale_revision');
  });

  it('a stale preview fails and stores nothing', async () => {
    const { review, base } = await seedBase();
    const composition = compositionOf({ basePresetId: base.id });
    const preview = await store.plan({ agentId: 'agent-1', adoption: LATEST, draft: composition });
    await store.saveRevision({
      assetId: review.id,
      expectedRevision: 1,
      payload: skillOf('code-review', 'edited'),
      impactFingerprint: (await store.previewAssetEdit({ assetId: review.id, payload: skillOf('code-review', 'edited') })).fingerprint,
    });
    const error = await rejection(store.saveComposition({ agentId: 'agent-1', expectedRevision: 0, composition, adoption: LATEST, previewFingerprint: preview.fingerprint }));
    expect(error.code).toBe('stale_preview');
    expect((await store.read()).compositions).toEqual({});
  });

  it('known conflicts block: no partial assignment', async () => {
    const { base } = await seedBase();
    const rival = await store.createAsset({ kind: 'mcp', name: 'Rival', payload: mcpOf('git') });
    const composition = compositionOf({ basePresetId: base.id, additions: [rival.id] });
    const preview = await store.plan({ agentId: 'agent-1', adoption: LATEST, draft: composition });
    expect(preview.activation).toBeNull();
    const error = await rejection(store.saveComposition({ agentId: 'agent-1', expectedRevision: 0, composition, adoption: LATEST, previewFingerprint: preview.fingerprint }));
    expect(error.code).toBe('composition_blocked');
    expect(error.details.plan?.blockers[0].code).toBe('destination_collision');
    expect((await store.read()).compositions).toEqual({});
  });

  it('a foreign owner blocks a commit the same way', async () => {
    const { base } = await seedBase();
    const composition = compositionOf({ basePresetId: base.id });
    const foreign = [{ key: 'mcp/git', owner: 'native' as const }];
    const preview = await store.plan({ agentId: 'agent-1', adoption: LATEST, draft: composition, foreign });
    expect(await code(store.saveComposition({ agentId: 'agent-1', expectedRevision: 0, composition, adoption: LATEST, previewFingerprint: preview.fingerprint, foreign }))).toBe('composition_blocked');
  });

  it('rejects a composition carrying anything but assets', async () => {
    const draft = { ...compositionOf(), worktreePath: '/somewhere' };
    expect(await code(store.plan({ agentId: 'agent-1', adoption: LATEST, draft }))).toBe('invalid_composition');
    expect(await code(store.plan({ agentId: '__proto__', adoption: LATEST }))).toBe('invalid_composition');
  });

  it('needs an adoption policy every time, with none assumed', async () => {
    expect(await code(store.plan({ agentId: 'agent-1' } as never))).toBe('adoption_policy_required');
    expect(await code(store.saveComposition({ agentId: 'agent-1', expectedRevision: 0, composition: compositionOf(), previewFingerprint: 'f' } as never))).toBe('adoption_policy_required');
  });

  it('removing an agent forgets its composition and own copies, and shared assets stay', async () => {
    const { instruction, base } = await seedBase();
    const fork = await store.copyAsset({ assetId: instruction.id, revision: 1, agentId: 'agent-1' });
    await compose('agent-1', { basePresetId: base.id, instructionAssetId: fork.id });
    expect(await code(store.removeAgent({ agentId: 'agent-1', expectedRevision: 0 }))).toBe('stale_revision');
    await store.removeAgent({ agentId: 'agent-1', expectedRevision: 1 });
    const index = await store.read();
    expect(index.compositions).toEqual({});
    expect(index.assets[fork.id]).toBeUndefined();
    expect(index.assets[instruction.id]).toBeDefined();
    expect(filesUnder(path.join(dir, 'revisions', instruction.id))).toEqual(['1.json']);
    expect(fs.existsSync(path.join(dir, 'revisions', fork.id))).toBe(false);
  });
});

describe('central edits', () => {
  it('need the impact preview to be confirmed when anything consumes the asset', async () => {
    const { review, base } = await seedBase();
    await compose('agent-1', { basePresetId: base.id });
    const payload = skillOf('code-review', 'edited');

    const unconfirmed = await rejection(store.saveRevision({ assetId: review.id, expectedRevision: 1, payload }));
    expect(unconfirmed.code).toBe('impact_confirmation_required');
    expect(unconfirmed.details.impact?.agents.map((agent) => agent.agentId)).toEqual(['agent-1']);

    const impact = await store.previewAssetEdit({ assetId: review.id, payload });
    expect(impact.presets).toEqual([{ presetId: base.id, role: 'skill' }]);
    const saved = await store.saveRevision({ assetId: review.id, expectedRevision: 1, payload, impactFingerprint: impact.fingerprint });
    expect(saved.headRevision).toBe(2);
  });

  it('a preview from before the consumers changed is stale', async () => {
    const { review, base } = await seedBase();
    const payload = skillOf('code-review', 'edited');
    const impact = await store.previewAssetEdit({ assetId: review.id, payload });
    await compose('agent-1', { basePresetId: base.id });
    expect(await code(store.saveRevision({ assetId: review.id, expectedRevision: 1, payload, impactFingerprint: impact.fingerprint }))).toBe('stale_preview');
    expect((await store.read()).assets[review.id].headRevision).toBe(1);
  });

  it('a preview of different content is stale', async () => {
    const { review, base } = await seedBase();
    await compose('agent-1', { basePresetId: base.id });
    const impact = await store.previewAssetEdit({ assetId: review.id, payload: skillOf('code-review', 'one') });
    expect(await code(store.saveRevision({ assetId: review.id, expectedRevision: 1, payload: skillOf('code-review', 'two'), impactFingerprint: impact.fingerprint }))).toBe('stale_preview');
  });

  it('an edit that would break a consumer is refused, whatever is confirmed', async () => {
    const { git, base } = await seedBase();
    const other = await store.createAsset({ kind: 'mcp', name: 'Other', payload: mcpOf('other') });
    await compose('agent-1', { basePresetId: base.id, additions: [other.id] });
    const payload = mcpOf('git');
    const impact = await store.previewAssetEdit({ assetId: other.id, payload });
    expect(impact.blocked).toBe(true);
    const error = await rejection(store.saveRevision({ assetId: other.id, expectedRevision: 1, payload, impactFingerprint: impact.fingerprint }));
    expect(error.code).toBe('consumer_conflict');
    expect(error.details.impact?.agents[0].newBlockers[0]).toMatchObject({ code: 'destination_collision', assetIds: [git.id, other.id].sort() });
    expect((await store.read()).assets[other.id].headRevision).toBe(1);
  });

  it('a change of an MCP server key is a new revision that consumers see', async () => {
    const { git, base } = await seedBase();
    await compose('agent-1', { basePresetId: base.id });
    await saveEdit(git.id, mcpOf('git-2'), 1);
    const plan = await store.plan({ agentId: 'agent-1', adoption: LATEST });
    expect(plan.mcpServers[0]).toMatchObject({ assetId: git.id, revision: 2, destination: { key: 'mcp/git-2' } });
  });

  it('an unassigned asset takes a revision with no confirmation', async () => {
    const asset = await store.createAsset({ kind: 'skill', name: 'Skill', payload: skillOf('s') });
    expect(await store.saveRevision({ assetId: asset.id, expectedRevision: 1, payload: skillOf('s', 'two') })).toMatchObject({ headRevision: 2 });
  });
});

describe('copies', () => {
  it('copies an exact revision, owned by one agent, with its origin', async () => {
    const asset = await store.createAsset({ kind: 'instruction', name: 'Orchestrator', payload: doc('one @@AgentName') });
    await store.saveRevision({ assetId: asset.id, expectedRevision: 1, payload: doc('two') });

    const copy = await store.copyAsset({ assetId: asset.id, revision: 1, agentId: 'agent-1' });
    expect(copy).toMatchObject({
      kind: 'instruction',
      name: 'Orchestrator',
      owner: { kind: 'agent', agentId: 'agent-1' },
      source: { kind: 'copy', originAssetId: asset.id, originRevision: 1 },
      headRevision: 1,
    });
    expect(await store.readRevision(copy.id, 1)).toEqual(doc('one @@AgentName'));
    expect(await store.originStatus(copy.id)).toEqual({
      originAssetId: asset.id,
      originRevision: 1,
      originHeadRevision: 2,
      newerRevisionAvailable: true,
      originDeleted: false,
    });
    expect(await store.originStatus(asset.id)).toBeNull();
  });

  it('copies a skill bundle whole', async () => {
    const asset = await store.createAsset({ kind: 'skill', name: 'Skill', payload: skillOf('s') });
    const copy = await store.copyAsset({ assetId: asset.id, revision: 1, agentId: 'agent-1', name: 'My skill' });
    expect(await store.readRevision(copy.id, 1)).toEqual(await store.readRevision(asset.id, 1));
    expect(copy.name).toBe('My skill');
    expect(copy.revisions[0].projection).toEqual(asset.revisions[0].projection);
  });

  it('only instruction documents and skills, of a revision that exists', async () => {
    const { git, base, instruction } = await seedBase();
    expect(await code(store.copyAsset({ assetId: git.id, revision: 1, agentId: 'a' }))).toBe('not_copyable');
    expect(await code(store.copyAsset({ assetId: base.id, revision: 1, agentId: 'a' }))).toBe('not_copyable');
    expect(await code(store.copyAsset({ assetId: instruction.id, revision: 9, agentId: 'a' }))).toBe('revision_unavailable');
    expect(await code(store.copyAsset({ assetId: instruction.id, revision: 1, agentId: '../x' }))).toBe('invalid_composition');
  });

  it('a copy of a built-in keeps its reserved name until the user saves another', async () => {
    const builtin = await store.createAsset({ kind: 'skill', name: 'Built in', payload: skillOf('clubhouse-tour'), source: { kind: 'builtin', builtinId: 'tour' } });
    const copy = await store.copyAsset({ assetId: builtin.id, revision: 1, agentId: 'agent-1' });
    expect(await code(store.saveRevision({ assetId: copy.id, expectedRevision: 1, payload: skillOf('clubhouse-tour', 'edited') }))).toBe('invalid_payload');
    expect((await store.saveRevision({ assetId: copy.id, expectedRevision: 1, payload: skillOf('my-tour', 'edited') })).headRevision).toBe(2);
  });

  it('forking leaves the base and everyone else alone, and a newer origin only gets reported', async () => {
    const { instruction, base } = await seedBase();
    await compose('agent-2', { basePresetId: base.id });
    const fork = await store.copyAsset({ assetId: instruction.id, revision: 1, agentId: 'agent-1' });
    await compose('agent-1', { basePresetId: base.id, instructionAssetId: fork.id });
    await store.saveRevision({ assetId: fork.id, expectedRevision: 1, payload: doc('mine'), impactFingerprint: (await store.previewAssetEdit({ assetId: fork.id, payload: doc('mine') })).fingerprint });

    expect(await store.readRevision(instruction.id, 1)).toEqual(doc());
    const other = await store.plan({ agentId: 'agent-2', adoption: LATEST });
    expect(other.instruction).toMatchObject({ assetId: instruction.id, revision: 1 });

    await saveEdit(instruction.id, doc('base moved on'), 1);
    const forked = await store.plan({ agentId: 'agent-1', adoption: LATEST });
    expect(forked.instruction).toMatchObject({ assetId: fork.id, revision: 2, origin: { originRevision: 1, originHeadRevision: 2, newerRevisionAvailable: true } });
    expect(forked.notices).toContainEqual({ code: 'origin_newer_revision', assetIds: [fork.id] });
    expect(forked.replacedInstruction).toEqual({ assetId: instruction.id, revision: 2 });
    expect(await store.readRevision(fork.id, 2)).toEqual(doc('mine'));
    expect((await store.read()).assets[fork.id].headRevision).toBe(2);
  });

  it('another agent can neither compose nor be handed a copy it does not own', async () => {
    const { instruction } = await seedBase();
    const fork = await store.copyAsset({ assetId: instruction.id, revision: 1, agentId: 'agent-1' });
    expect(await code(compose('agent-2', { instructionAssetId: fork.id }))).toBe('composition_blocked');
  });

  it('return to base: drop the replacement, then the copy, with the origin revision intact', async () => {
    const { instruction, base } = await seedBase();
    const fork = await store.copyAsset({ assetId: instruction.id, revision: 1, agentId: 'agent-1' });
    await compose('agent-1', { basePresetId: base.id, instructionAssetId: fork.id });
    expect(await code(store.deleteAsset({ assetId: fork.id, expectedRevision: 1 }))).toBe('asset_in_use');
    await compose('agent-1', { basePresetId: base.id }, 1);
    await store.deleteAsset({ assetId: fork.id, expectedRevision: 1 });
    const plan = await store.plan({ agentId: 'agent-1', adoption: LATEST });
    expect(plan.instruction?.assetId).toBe(instruction.id);
    expect(plan.replacedInstruction).toBeNull();
  });

  it("deleting a copy's origin keeps the revision it started from, and the copy works", async () => {
    const asset = await store.createAsset({ kind: 'instruction', name: 'Doc', payload: doc('one') });
    await store.saveRevision({ assetId: asset.id, expectedRevision: 1, payload: doc('two') });
    const copy = await store.copyAsset({ assetId: asset.id, revision: 1, agentId: 'agent-1' });
    await store.deleteAsset({ assetId: asset.id, expectedRevision: 2 });

    expect(await store.readRevision(asset.id, 1)).toEqual(doc('one'));
    expect(await code(store.readRevision(asset.id, 2))).toBe('revision_unavailable');
    expect(await store.originStatus(copy.id)).toMatchObject({ originDeleted: true, newerRevisionAvailable: false, originHeadRevision: null });
    expect((await store.plan({ agentId: 'agent-1', adoption: LATEST, draft: compositionOf({ instructionAssetId: copy.id }) })).blockers).toEqual([]);

    // The copy going is what frees the origin's last kept revision.
    await store.deleteAsset({ assetId: copy.id, expectedRevision: 1 });
    expect((await store.read()).assets[asset.id]).toBeUndefined();
    expect(fs.existsSync(path.join(dir, 'revisions', asset.id))).toBe(false);
  });
});

describe('agents can only read', () => {
  it.each([
    ['the MCP surface', 'mcp', 'agent-9'],
    ['the agent CLI', 'cli', undefined],
    ['the Dispatcher', 'dispatcher', undefined],
    ['any surface with an acting agent', 'ui', 'agent-9'],
  ] as const)('refuses asset and composition writes through %s, and records the refusal', async (_label, surface, actor) => {
    const { instruction, base } = await seedBase();
    const before = JSON.stringify(await store.read());
    await withSettingsSurface(surface, actor, async () => {
      expect(await code(store.copyAsset({ assetId: instruction.id, revision: 1, agentId: 'agent-9' }))).toBe('agent_not_permitted');
      expect(await code(store.createAsset({ kind: 'instruction', name: 'x', payload: doc() }))).toBe('agent_not_permitted');
      expect(await code(store.saveRevision({ assetId: instruction.id, expectedRevision: 1, payload: doc('x') }))).toBe('agent_not_permitted');
      expect(await code(store.renameAsset({ assetId: instruction.id, expectedName: 'Orchestrator', name: 'x' }))).toBe('agent_not_permitted');
      expect(await code(store.deleteAsset({ assetId: instruction.id, expectedRevision: 1 }))).toBe('agent_not_permitted');
      expect(await code(store.saveComposition({ agentId: 'agent-9', expectedRevision: 0, composition: compositionOf({ basePresetId: base.id }), adoption: LATEST, previewFingerprint: 'f' }))).toBe('agent_not_permitted');
      expect(await code(store.removeAgent({ agentId: 'agent-9', expectedRevision: 0 }))).toBe('agent_not_permitted');
      // Asking stays open: planning changes nothing.
      expect((await store.plan({ agentId: 'agent-9', adoption: LATEST })).blockers).toEqual([]);
    });
    expect(JSON.stringify(await store.read())).toBe(before);
    const refused = (await readSettingsAudit(50)).filter((row) => row.outcome === 'refused');
    expect(refused.map((row) => row.code)).toContain('agent_not_permitted');
    expect(refused.find((row) => row.key === 'assetCatalog.copy')).toMatchObject({ surface, targetId: 'agent-9' });
  });

  it('a user and Clubhouse itself may write', async () => {
    await withSettingsSurface('ui', undefined, () => store.createAsset({ kind: 'instruction', name: 'Via UI', payload: doc() }));
    await store.createAsset({ kind: 'instruction', name: 'Via Clubhouse', payload: doc() });
    expect(Object.keys((await store.read()).assets)).toHaveLength(2);
  });
});

describe('recorded runs', () => {
  async function frozenRun() {
    const seeded = await seedBase();
    await compose('agent-1', { basePresetId: seeded.base.id });
    const plan = await store.plan({ agentId: 'agent-1', adoption: LATEST });
    const run = await store.recordRun({ runId: 'run-1', plan: plan.activation! });
    return { ...seeded, run };
  }

  it('freeze exact revisions, base included, while desired state advances', async () => {
    const { instruction, review, base, run } = await frozenRun();
    expect(run.revisions.map((frozen) => [frozen.assetId, frozen.revision])).toEqual(
      [[base.id, 1], [instruction.id, 1], [review.id, 1], [(await store.read()).assets['asset-3'].id, 1]],
    );

    await saveEdit(review.id, skillOf('code-review', 'edited'), 1);
    const desired = await store.plan({ agentId: 'agent-1', adoption: LATEST });
    expect(desired.skills[0].revision).toBe(2);

    const frozen = await store.readRunPayloads('run-1');
    expect(frozen.find((item) => item.assetId === review.id)).toMatchObject({ revision: 1, payload: skillOf('code-review') });
  });

  it('a held plan from the same run can resolve the old base after it moves', async () => {
    const { review, run } = await frozenRun();
    await saveEdit(review.id, skillOf('code-review', 'edited'), 1);
    const revisions = Object.fromEntries(run.revisions.map((frozen) => [frozen.assetId, frozen.revision]));
    const held = await store.plan({ agentId: 'agent-1', adoption: { mode: 'hold', revisions } });
    expect(held.skills[0].revision).toBe(1);
    expect(held.base?.updates).toEqual([{ assetId: review.id, kind: 'skill', resolvedRevision: 1, headRevision: 2 }]);
  });

  it('retain payloads through deletion, and release them when the run goes', async () => {
    const asset = await store.createAsset({ kind: 'skill', name: 'Skill', payload: skillOf('s', 'one') });
    await compose('agent-1', { additions: [asset.id] });
    const plan = await store.plan({ agentId: 'agent-1', adoption: LATEST });
    await store.recordRun({ runId: 'run-1', plan: plan.activation! });
    await saveEdit(asset.id, skillOf('s', 'two'), 1);
    await compose('agent-1', {}, 1);
    await store.deleteAsset({ assetId: asset.id, expectedRevision: 2 });

    const index = await store.read();
    expect(index.assets[asset.id].deletedAt).toBeDefined();
    expect(index.assets[asset.id].revisions.map((record) => record.revision)).toEqual([1]);
    expect(filesUnder(path.join(dir, 'revisions', asset.id))).toEqual(['1.json']);
    expect((await store.readRunPayloads('run-1'))[0].payload).toEqual(skillOf('s', 'one'));

    await store.recordRun({ runId: 'run-2', plan: plan.activation! });
    await store.releaseRun('run-1');
    expect((await store.read()).assets[asset.id]).toBeDefined();
    await store.releaseRun('run-2');
    expect((await store.read()).assets[asset.id]).toBeUndefined();
    expect(fs.existsSync(path.join(dir, 'revisions', asset.id))).toBe(false);
  });

  it('keep the revisions of a live asset too', async () => {
    const { review } = await frozenRun();
    await saveEdit(review.id, skillOf('code-review', 'two'), 1);
    await store.releaseRun('run-1');
    expect(await store.readRevision(review.id, 1)).toEqual(skillOf('code-review'));
  });

  it('reject a repeated id, an unknown revision and an unknown run', async () => {
    const { run } = await frozenRun();
    const plan = (await store.plan({ agentId: 'agent-1', adoption: LATEST })).activation!;
    expect(await code(store.recordRun({ runId: run.runId, plan }))).toBe('run_exists');
    const bad = { ...plan, assets: [{ ...plan.assets[0], revision: 99 }] };
    expect(await code(store.recordRun({ runId: 'run-2', plan: bad }))).toBe('revision_unavailable');
    expect(await code(store.releaseRun('nope'))).toBe('run_missing');
    expect(await code(store.readRunPayloads('nope'))).toBe('run_missing');
    expect(await code(store.recordRun({ runId: '../x', plan }))).toBe('invalid_composition');
  });

  it('a run started through an agent surface is still recorded', async () => {
    const asset = await store.createAsset({ kind: 'skill', name: 'Skill', payload: skillOf('s') });
    await compose('agent-1', { additions: [asset.id] });
    const plan = (await store.plan({ agentId: 'agent-1', adoption: LATEST })).activation!;
    await withSettingsSurface('mcp', 'agent-9', () => store.recordRun({ runId: 'run-1', plan }));
    expect((await store.read()).runs['run-1'].agentId).toBe('agent-1');
  });
});

describe('interrupted writes', () => {
  const crash = () => Object.assign(new Error('crash'), { code: 'EIO' });
  const onIndexCommit = (from: string, to: string) => (path.basename(to) === 'catalog.json' ? crash() : null);
  const onPayloadWrite = (from: string, to: string) => (path.basename(to) !== 'catalog.json' ? crash() : null);

  it('dying before the index commits leaves the old state, and no temp behind', async () => {
    const asset = await store.createAsset({ kind: 'instruction', name: 'Doc', payload: doc('one') });
    const before = fs.readFileSync(path.join(dir, 'catalog.json'), 'utf8');

    renameFault = onIndexCommit;
    await expect(store.saveRevision({ assetId: asset.id, expectedRevision: 1, payload: doc('two') })).rejects.toThrow('crash');
    renameFault = null;

    expect(fs.readFileSync(path.join(dir, 'catalog.json'), 'utf8')).toBe(before);
    expect((await store.read()).assets[asset.id].headRevision).toBe(1);
    expect(filesUnder(dir).filter((file) => file.includes('.tmp.'))).toEqual([]);
    expect(await store.readRevision(asset.id, 1)).toEqual(doc('one'));
    expect(await code(store.readRevision(asset.id, 2))).toBe('revision_unavailable');
  });

  it('a retry replaces the orphan payload the interrupted save left', async () => {
    const asset = await store.createAsset({ kind: 'instruction', name: 'Doc', payload: doc('one') });
    renameFault = onIndexCommit;
    await expect(store.saveRevision({ assetId: asset.id, expectedRevision: 1, payload: doc('lost') })).rejects.toThrow();
    renameFault = null;
    expect(filesUnder(path.join(dir, 'revisions', asset.id))).toEqual(['1.json', '2.json']);

    await store.saveRevision({ assetId: asset.id, expectedRevision: 1, payload: doc('kept') });
    expect(await store.readRevision(asset.id, 2)).toEqual(doc('kept'));
  });

  it('dying while writing the payload leaves the index untouched', async () => {
    const asset = await store.createAsset({ kind: 'instruction', name: 'Doc', payload: doc('one') });
    const before = fs.readFileSync(path.join(dir, 'catalog.json'), 'utf8');
    renameFault = onPayloadWrite;
    await expect(store.saveRevision({ assetId: asset.id, expectedRevision: 1, payload: doc('two') })).rejects.toThrow();
    renameFault = null;
    expect(fs.readFileSync(path.join(dir, 'catalog.json'), 'utf8')).toBe(before);
    expect(filesUnder(path.join(dir, 'revisions', asset.id))).toEqual(['1.json']);
  });

  it('a failed new asset is invisible, and the sweep clears what a crash left', async () => {
    renameFault = onIndexCommit;
    await expect(store.createAsset({ kind: 'instruction', name: 'Doc', payload: doc() })).rejects.toThrow();
    renameFault = null;
    expect((await store.read()).assets).toEqual({});
    expect(filesUnder(path.join(dir, 'revisions'))).toEqual(['asset-1/1.json']);

    const kept = await store.createAsset({ kind: 'instruction', name: 'Kept', payload: doc() });
    // What a process killed mid-write leaves: temp files beside both kinds of file.
    fs.writeFileSync(path.join(dir, 'catalog.json.tmp.deadbeef'), '{ torn');
    fs.writeFileSync(path.join(dir, 'revisions', kept.id, '1.json.tmp.deadbeef'), '{ torn');
    fs.writeFileSync(path.join(dir, 'revisions', kept.id, '2.json'), '{}');
    expect((await store.read()).assets[kept.id].headRevision).toBe(1);

    await store.sweep();
    expect(filesUnder(dir).sort()).toEqual(['catalog.json', `revisions/${kept.id}/1.json`]);
  });

  it('the sweep never reads a missing or unreadable index as nothing wanted', async () => {
    const asset = await store.createAsset({ kind: 'instruction', name: 'Doc', payload: doc() });
    const payload = path.join(dir, 'revisions', asset.id, '1.json');
    fs.rmSync(path.join(dir, 'catalog.json'));
    await store.sweep();
    expect(fs.existsSync(payload)).toBe(true);

    fs.writeFileSync(path.join(dir, 'catalog.json'), '{ torn');
    expect(await code(store.sweep())).toBe('catalog_corrupt');
    expect(fs.existsSync(payload)).toBe(true);
  });

  it('a failed commit does not stop the next write', async () => {
    const asset = await store.createAsset({ kind: 'instruction', name: 'Doc', payload: doc('one') });
    renameFault = onIndexCommit;
    await expect(store.renameAsset({ assetId: asset.id, expectedName: 'Doc', name: 'Next' })).rejects.toThrow();
    renameFault = null;
    expect((await store.renameAsset({ assetId: asset.id, expectedName: 'Doc', name: 'Next' })).name).toBe('Next');
  });

  it('retries the rename Windows refuses while something holds the target', async () => {
    let failures = 2;
    renameFault = () => (failures-- > 0 ? Object.assign(new Error('busy'), { code: 'EPERM' }) : null);
    const asset = await store.createAsset({ kind: 'instruction', name: 'Doc', payload: doc() });
    expect((await store.read()).assets[asset.id]).toBeDefined();
    expect(failures).toBeLessThan(0);
  });

  it('gives up on a rename that stays refused, and reports it', async () => {
    renameFault = () => Object.assign(new Error('busy'), { code: 'EBUSY' });
    await expect(store.createAsset({ kind: 'instruction', name: 'Doc', payload: doc() })).rejects.toThrow('busy');
  });

  it('an unreadable catalog fails explicitly and is never replaced', async () => {
    await store.createAsset({ kind: 'instruction', name: 'Doc', payload: doc() });
    const file = path.join(dir, 'catalog.json');
    for (const content of [
      '{ torn',
      '[]',
      '{"version":1}',
      '{"version":1,"assets":{"../evil":{"id":"../evil","headRevision":1,"revisions":[]}},"compositions":{},"runs":{}}',
      '{"version":1,"assets":{"a":{"id":"b","headRevision":1,"revisions":[]}},"compositions":{},"runs":{}}',
      '{"version":1,"assets":{"a":{"id":"a"}},"compositions":{},"runs":{}}',
      '{"version":1,"assets":{},"compositions":{"a":{}},"runs":{}}',
    ]) {
      fs.writeFileSync(file, content);
      expect(await code(store.read())).toBe('catalog_corrupt');
      expect(await code(store.createAsset({ kind: 'instruction', name: 'Doc', payload: doc() }))).toBe('catalog_corrupt');
      expect(fs.readFileSync(file, 'utf8')).toBe(content);
    }
  });

  it('a catalog from a newer build is not read or overwritten', async () => {
    fs.mkdirSync(dir, { recursive: true });
    const content = JSON.stringify({ version: 2, assets: {}, compositions: {}, runs: {} });
    fs.writeFileSync(path.join(dir, 'catalog.json'), content);
    expect(await code(store.read())).toBe('catalog_version_unsupported');
    expect(await code(store.createAsset({ kind: 'instruction', name: 'Doc', payload: doc() }))).toBe('catalog_version_unsupported');
    expect(fs.readFileSync(path.join(dir, 'catalog.json'), 'utf8')).toBe(content);
  });

  it('a second store instance reads what the first committed', async () => {
    const asset = await store.createAsset({ kind: 'instruction', name: 'Doc', payload: doc('one') });
    expect((await makeStore().read()).assets[asset.id].name).toBe('Doc');
    expect(await makeStore().readRevision(asset.id, 1)).toEqual(doc('one'));
  });
});

describe('redaction end to end', () => {
  it('a refused secret reaches no file, plan, error or audit row', async () => {
    const payload = { ...mcpOf('leaky'), env: { API_TOKEN: FAKE_GH_TOKEN } };
    const error = await rejection(store.createAsset({ kind: 'mcp', name: 'Leaky', payload }));
    expect(error.code).toBe('invalid_payload');
    expect(JSON.stringify(error.details)).not.toContain(FAKE_GH_TOKEN);
    expect(error.message).not.toContain(FAKE_GH_TOKEN);

    const asset = await store.createAsset({ kind: 'mcp', name: 'Clean', payload: mcpOf('clean') });
    await expect(store.saveRevision({ assetId: asset.id, expectedRevision: 1, payload })).rejects.toThrow();
    for (const file of filesUnder(dir)) {
      expect(fs.readFileSync(path.join(dir, file), 'utf8')).not.toContain(FAKE_GH_TOKEN);
    }
    expect(JSON.stringify(await readSettingsAudit(50))).not.toContain(FAKE_GH_TOKEN);
  });

  it('previews and plans of a forwarded secret hold its name alone', async () => {
    const asset = await store.createAsset({ kind: 'mcp', name: 'GitHub', payload: { ...mcpOf('github'), env: { LOG_LEVEL: 'quiet-value' }, envVars: ['GITHUB_TOKEN'] } });
    const preview = await store.previewRevision(asset.id, 1);
    expect(preview).toMatchObject({ envNames: ['LOG_LEVEL'], envVars: ['GITHUB_TOKEN'] });
    expect(JSON.stringify(preview)).not.toContain('quiet-value');
    const plan = await store.plan({ agentId: 'agent-1', adoption: LATEST, draft: compositionOf({ additions: [asset.id] }) });
    expect(plan.activation?.assets[0].requires).toEqual({ envVars: ['GITHUB_TOKEN'], auth: 'external' });
    expect(JSON.stringify(plan)).not.toContain('quiet-value');
  });
});

describe('the audit', () => {
  it('records writes by id, kind and surface, and never content', async () => {
    const asset = await withSettingsSurface('ui', undefined, () => store.createAsset({ kind: 'instruction', name: 'Very private name', payload: doc('private words') }));
    await withSettingsSurface('ui', undefined, async () => {
      await store.saveRevision({ assetId: asset.id, expectedRevision: 1, payload: doc('more private words') });
      await store.renameAsset({ assetId: asset.id, expectedName: 'Very private name', name: 'Another private name' });
      const copy = await store.copyAsset({ assetId: asset.id, revision: 1, agentId: 'agent-1' });
      await compose('agent-1', { instructionAssetId: copy.id });
    });
    const rows = await readSettingsAudit(50);
    expect(rows.map((row) => row.key).sort()).toEqual([
      'assetCatalog.composition',
      'assetCatalog.copy',
      'assetCatalog.instruction.created',
      'assetCatalog.instruction.name',
      'assetCatalog.instruction.revision',
    ]);
    expect(rows.every((row) => row.surface === 'ui' && row.outcome === 'ok' && row.changed === true)).toBe(true);
    expect(rows.find((row) => row.key === 'assetCatalog.composition')).toMatchObject({ scope: 'agent', targetId: 'agent-1' });
    expect(JSON.stringify(rows)).not.toContain('private');
  });

  it('records a refused save with its code', async () => {
    const asset = await store.createAsset({ kind: 'instruction', name: 'Doc', payload: doc() });
    await expect(store.saveRevision({ assetId: asset.id, expectedRevision: 9, payload: doc('x') })).rejects.toThrow();
    const refused = (await readSettingsAudit(50)).filter((row) => row.outcome === 'refused');
    expect(refused).toEqual([expect.objectContaining({ key: 'assetCatalog.revision', targetId: asset.id, code: 'stale_revision' })]);
  });

  it('a read records nothing', async () => {
    const asset = await store.createAsset({ kind: 'instruction', name: 'Doc', payload: doc() });
    const before = (await readSettingsAudit(50)).length;
    await store.read();
    await store.plan({ agentId: 'a', adoption: LATEST, draft: compositionOf({ instructionAssetId: asset.id }) });
    await store.previewAssetEdit({ assetId: asset.id, payload: doc('x') });
    expect((await readSettingsAudit(50)).length).toBe(before);
  });
});

describe('the four builder actions', () => {
  it('new skill, existing skill, MCP and a forked instruction, without touching the agent id or the base', async () => {
    const { instruction, review, base } = await seedBase();
    const beforeBase = (await store.read()).assets[base.id];
    await compose('release-lead', { basePresetId: base.id });
    await compose('other-agent', { basePresetId: base.id });

    // New skill: saved to the library, assigned to this agent only.
    const notes = await store.createAsset({ kind: 'skill', name: 'Release notes', payload: skillOf('release-notes') });
    // Existing skill, as a copy.
    const shared = await store.createAsset({ kind: 'skill', name: 'Triage', payload: skillOf('triage') });
    const triage = await store.copyAsset({ assetId: shared.id, revision: 1, agentId: 'release-lead' });
    // MCP: through its configuration, with its secret left to the runtime.
    const adoptedKey = 'workiq';
    const workiq = await store.createAsset({ kind: 'mcp', name: 'WorkIQ', payload: { ...mcpOf(adoptedKey), envVars: ['WORKIQ_TENANT'] } });
    // Fork: a copy owned by this agent, which takes over the instruction.
    const fork = await store.copyAsset({ assetId: instruction.id, revision: 1, agentId: 'release-lead', name: 'Local fork' });

    const stored = await compose('release-lead', {
      basePresetId: base.id,
      additions: [notes.id, triage.id, workiq.id],
      instructionAssetId: fork.id,
    }, 1);
    expect(stored.agentId).toBe('release-lead');

    const plan = await store.plan({ agentId: 'release-lead', adoption: LATEST });
    expect(plan.blockers).toEqual([]);
    expect(plan.instruction).toMatchObject({ assetId: fork.id, owner: { kind: 'agent', agentId: 'release-lead' } });
    expect(plan.replacedInstruction).toEqual({ assetId: instruction.id, revision: 1 });
    expect(plan.skills.map((asset) => asset.assetId).sort()).toEqual([notes.id, review.id, triage.id].sort());
    expect(plan.mcpServers.find((asset) => asset.assetId === workiq.id)?.projection).toMatchObject({ auth: 'external', envVars: ['WORKIQ_TENANT'] });
    expect(plan.operationalDefaults).toEqual([{ key: 'orchestrate', value: true, presetId: base.id, presetRevision: 1 }]);

    expect((await store.read()).assets[base.id]).toEqual(beforeBase);
    const other = await store.plan({ agentId: 'other-agent', adoption: LATEST });
    expect(other.instruction?.assetId).toBe(instruction.id);
    expect(other.skills.map((asset) => asset.assetId)).toEqual([review.id]);
  });
});
