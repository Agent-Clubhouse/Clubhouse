import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const W = vi.hoisted(() => ({ home: '', auditFails: false }));

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => W.home } }));
vi.mock('../log-service', () => ({ appLog: vi.fn() }));
vi.mock('../settings-audit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../settings-audit')>();
  return {
    ...actual,
    auditChanged: (...args: Parameters<typeof actual.auditChanged>) => (W.auditFails ? Promise.reject(new Error('audit down')) : actual.auditChanged(...args)),
  };
});

import { appLog } from '../log-service';
import { _resetSettingsAuditForTesting, readSettingsAudit, withSettingsSurface } from '../settings-audit';
import { composeInstructions } from './composer';
import { instanceFromTemplate } from './structure';
import { AssetCatalogError, assetCatalogDir, createAssetCatalogStore, installBuiltinAsset, type AssetCatalogStore, type PublicationRequest } from './store';
import type {
  AssetKind,
  BaseAdoption,
  CatalogEntry,
  CompositionInput,
  InstanceEntry,
  McpAssetPayload,
} from '../../../shared/asset-catalog-types';

const ACCEPTED: BaseAdoption = { content: { mode: 'takeable' }, structure: { mode: 'accepted' } };
const LATEST: BaseAdoption = { content: { mode: 'takeable' }, structure: { mode: 'latest-if-clean' } };
const FAKE_GH_TOKEN = `ghp_${'a1B2c3D4e5'.repeat(4)}`;

const doc = (content = 'You are @@AgentName.') => ({ content });
const skillOf = (skillName: string, body = '# Skill') => ({ skillName, files: [{ path: 'SKILL.md', content: body }, { path: 'scripts/run.sh', content: 'echo hi', executable: true }] });
const mcpOf = (serverKey: string): McpAssetPayload => ({ serverKey, transport: 'stdio', command: 'npx', args: ['-y', '@microsoft/workiq', 'mcp'], auth: 'external' });
const follow = (baseEntryId: string): InstanceEntry => ({ baseEntryId, source: { kind: 'follow' } });
const blank = (over: Partial<CompositionInput> = {}): CompositionInput => ({
  template: null, entries: [], excludedEntryIds: [], subagents: [], excludedSubagentEntryIds: [],
  additions: [], removals: [], floors: {}, keepMarkers: {}, authorityApprovals: {}, ...over,
});
const ref = (entryId: string, block: CatalogEntry | string, blockRevision = 1) => ({ entryId, blockId: typeof block === 'string' ? block : block.id, blockRevision });

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
  W.auditFails = false;
  store = makeStore();
  vi.mocked(appLog).mockClear();
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
async function compose(agentId: string, composition: CompositionInput, expectedRevision = 0) {
  const preview = await store.plan({ agentId, adoption: ACCEPTED, draft: composition });
  return store.saveComposition({ agentId, expectedRevision, composition, adoption: ACCEPTED, previewFingerprint: preview.fingerprint });
}

async function saveEdit(assetId: string, payload: unknown, expectedRevision: number) {
  const impact = await store.previewAssetEdit({ assetId, payload });
  return store.saveRevision({ assetId, expectedRevision, payload, impactFingerprint: impact.fingerprint });
}

async function publish(request: PublicationRequest) {
  const impact = await store.previewPublication(request);
  return store.publishTemplate({ ...request, impactFingerprint: impact.fingerprint });
}

/** A new instance of a template's latest revision, following everything. */
function instanceOf(template: CatalogEntry, over: Partial<CompositionInput> = {}): CompositionInput {
  const record = template.revisions[template.revisions.length - 1];
  if (record.projection.kind !== 'template') throw new Error('not a template');
  return {
    ...instanceFromTemplate({
      templateId: template.id,
      revision: record.revision,
      entryIds: record.projection.entries.map((entry) => entry.entryId),
      subagentIds: record.projection.subagents.map((entry) => entry.entryId),
    }),
    ...over,
  };
}

/** Identity and Job blocks, a skill, an MCP definition and a template of them. */
async function seedBase() {
  const identity = await store.createAsset({ kind: 'block', name: 'Identity', payload: doc('You are @@AgentName.') });
  const job = await store.createAsset({ kind: 'block', name: 'Job', payload: doc('Do the work. Keep the rules.') });
  const review = await store.createAsset({ kind: 'skill', name: 'Code review', payload: skillOf('code-review') });
  const git = await store.createAsset({ kind: 'mcp', name: 'Git', payload: mcpOf('git') });
  const base = await store.createAsset({
    kind: 'template',
    name: 'Orchestrator',
    payload: {
      entries: [ref('Identity', identity), ref('Job', job)],
      subagents: [],
      skills: [review.id],
      mcps: [git.id],
      operationalDefaults: { orchestrate: true },
    },
  });
  return { identity, job, review, git, base };
}

/** The other half of the seed: T2 moves the rules out of Job into a new Safety block. */
function moveRules(seed: Awaited<ReturnType<typeof seedBase>>, safetyId: string): PublicationRequest {
  return {
    templateId: seed.base.id,
    expectedRevision: 1,
    writes: [
      { assetId: safetyId, kind: 'block', expectedRevision: 0, name: 'Safety', payload: doc('Keep the rules.') },
      { assetId: seed.job.id, kind: 'block', expectedRevision: 1, payload: doc('Do the work.') },
    ],
    payload: {
      entries: [ref('Identity', seed.identity), ref('Safety', safetyId), ref('Job', seed.job, 2)],
      subagents: [],
      skills: [seed.review.id],
      mcps: [seed.git.id],
      operationalDefaults: { orchestrate: true },
    },
  };
}

function filesUnder(root: string, prefix = ''): string[] {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((item) => (
    item.isDirectory() ? filesUnder(path.join(root, item.name), `${prefix}${item.name}/`) : [`${prefix}${item.name}`]
  ));
}

async function textOf(plan: { activation: { instructions: { blocks: Array<{ assetId: string; revision: number }> } | null } | null }): Promise<string> {
  const blocks = await Promise.all((plan.activation?.instructions?.blocks ?? []).map((block) => store.readRevision(block.assetId, block.revision)));
  const composed = composeInstructions(blocks as Array<{ content: string }>);
  if (composed.ok !== true) throw new Error(composed.code);
  return composed.text;
}

describe('reading', () => {
  it('reads as empty and creates nothing', async () => {
    expect(await store.read()).toEqual({ version: 2, assets: {}, compositions: {}, runs: {} });
    expect(await store.plan({ agentId: 'a', adoption: ACCEPTED })).toMatchObject({ blockers: [], compositionRevision: 0 });
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('a read of existing data writes nothing', async () => {
    const seed = await seedBase();
    await compose('a', instanceOf(seed.base));
    const stamp = fs.statSync(path.join(dir, 'catalog.json')).mtimeMs;
    const listing = filesUnder(dir);
    await store.read();
    await store.readRevision(seed.job.id, 1);
    await store.previewRevision(seed.job.id, 1);
    await store.plan({ agentId: 'a', adoption: ACCEPTED });
    await store.previewAssetEdit({ assetId: seed.job.id, payload: doc('next') });
    await store.previewPublication(moveRules(seed, 'new-block'));
    await store.previewStructureUpdate({ agentId: 'a', adoption: ACCEPTED });
    await store.previewTemplateSwitch({ agentId: 'a', templateId: seed.base.id, selection: {}, adoption: ACCEPTED });
    await store.originStatus(seed.job.id);
    expect(fs.statSync(path.join(dir, 'catalog.json')).mtimeMs).toBe(stamp);
    expect(filesUnder(dir)).toEqual(listing);
  });

  it('lives under the base dir, in a path safe on every platform', async () => {
    expect(assetCatalogDir()).toBe(path.join(W.home, '.clubhouse-dev', 'asset-catalog'));
    await store.createAsset({ kind: 'block', name: 'Name: with / odd * chars?', payload: doc() });
    for (const file of filesUnder(dir)) expect(file).toMatch(/^[A-Za-z0-9._/-]+$/);
  });
});

describe('saving unassigned assets', () => {
  it('saves each kind with no consumer and stable ids', async () => {
    const { identity, review, git, base } = await seedBase();
    const subagent = await store.createAsset({ kind: 'subagent', name: 'Tester', payload: { agentName: 'tester', description: 'Runs tests.', blocks: [ref('Role', identity)], skills: [review.id], mcps: [git.id] } });
    expect([identity, base, subagent].map((asset) => asset.id)).toEqual(['asset-1', 'asset-5', 'asset-6']);
    expect(base.revisions[0].projection).toMatchObject({ kind: 'template', entries: [{ entryId: 'Identity' }, { entryId: 'Job' }] });
    expect((await store.read()).compositions).toEqual({});
    expect(await store.readRevision(review.id, 1)).toEqual({
      skillName: 'code-review',
      files: [{ path: 'SKILL.md', content: '# Skill' }, { path: 'scripts/run.sh', content: 'echo hi', executable: true }],
    });
  });

  it('keeps no payload content in the index', async () => {
    await store.createAsset({ kind: 'block', name: 'Doc', payload: doc('distinctive-instruction-text') });
    await store.createAsset({ kind: 'skill', name: 'Skill', payload: skillOf('s', 'distinctive-skill-text') });
    await store.createAsset({ kind: 'mcp', name: 'Server', payload: { ...mcpOf('m'), env: { LOG_LEVEL: 'distinctive-env-value' } } });
    const block = await store.createAsset({ kind: 'block', name: 'Role', payload: doc() });
    await store.createAsset({ kind: 'subagent', name: 'Sub', payload: { agentName: 'sub', description: 'distinctive-description', blocks: [ref('Role', block)], skills: [], mcps: [], provider: { claude: { model: 'distinctive-model' } } } });
    const raw = fs.readFileSync(path.join(dir, 'catalog.json'), 'utf8');
    for (const text of ['distinctive-instruction-text', 'distinctive-skill-text', 'distinctive-env-value', 'distinctive-description', 'distinctive-model']) {
      expect(raw).not.toContain(text);
    }
  });

  it('records provenance', async () => {
    const imported = await store.createAsset({ kind: 'skill', name: 'Imported', payload: skillOf('imported'), source: { kind: 'import', from: 'project-skill', projectId: 'p1', nativeName: 'imported' } });
    expect(imported.source).toMatchObject({ from: 'project-skill', projectId: 'p1' });
  });

  describe('built-ins', () => {
    const bridge = { assetId: 'builtin-bridge', kind: 'mcp' as const, name: 'Bridge', builtinId: 'clubhouse-bridge', expectedRevision: 0, payload: mcpOf('clubhouse') };

    it('the general API can\'t make one or reach the reserved namespace', async () => {
      expect(await code(store.createAsset({ kind: 'mcp', name: 'Bridge', payload: mcpOf('clubhouse') }))).toBe('invalid_payload');
      expect(await code(store.createAsset({ kind: 'mcp', name: 'Bridge', payload: mcpOf('clubhouse'), source: { kind: 'builtin', builtinId: 'clubhouse-bridge' } }))).toBe('invalid_payload');
      expect(await code(store.createAsset({ kind: 'block', name: 'x', payload: doc(), source: { kind: 'builtin', builtinId: 'x' } }))).toBe('invalid_payload');
      expect(await code(store.publishTemplate({
        templateId: 'new-template',
        expectedRevision: 0,
        name: 'x',
        source: { kind: 'builtin', builtinId: 'x' },
        writes: [{ assetId: 'new-block', kind: 'block', expectedRevision: 0, name: 'x', payload: doc() }],
        payload: { entries: [ref('A', 'new-block')], subagents: [], skills: [], mcps: [] },
      }))).toBe('invalid_publication');
      expect('installBuiltin' in store).toBe(false);
    });

    it('the installer can, for Clubhouse itself, and appends revisions under an expected revision', async () => {
      const made = await installBuiltinAsset(store, bridge);
      expect(made).toMatchObject({ source: { kind: 'builtin', builtinId: 'clubhouse-bridge' }, owner: { kind: 'library' }, headRevision: 1 });
      expect(await code(installBuiltinAsset(store, bridge))).toBe('stale_revision');
      expect((await installBuiltinAsset(store, { ...bridge, expectedRevision: 1 })).headRevision).toBe(2);
    });

    it('no surface a person or agent comes in on reaches it', async () => {
      for (const surface of ['ui', 'mobile', 'persona', 'mcp', 'cli', 'dispatcher'] as const) {
        await withSettingsSurface(surface, undefined, async () => {
          expect(await code(installBuiltinAsset(store, bridge))).toBe('agent_not_permitted');
        });
      }
      expect(() => installBuiltinAsset({}, bridge)).toThrow('not an asset catalog store');
    });

    it('takes no edits, renames or deletion through the general API: a person forks one', async () => {
      const made = await installBuiltinAsset(store, bridge);
      expect(await code(store.saveRevision({ assetId: made.id, expectedRevision: 1, payload: mcpOf('clubhouse') }))).toBe('builtin_read_only');
      expect(await code(store.renameAsset({ assetId: made.id, expectedName: 'Bridge', name: 'Mine now' }))).toBe('builtin_read_only');
      expect(await code(store.deleteAsset({ assetId: made.id, expectedRevision: 1 }))).toBe('builtin_read_only');
      expect((await store.read()).assets[made.id]).toMatchObject({ name: 'Bridge', headRevision: 1 });
      const skill = await installBuiltinAsset(store, { assetId: 'builtin-block', kind: 'block', name: 'B', builtinId: 'b', expectedRevision: 0, payload: doc() });
      const template = await installBuiltinAsset(store, { assetId: 'builtin-template', kind: 'template', name: 'T', builtinId: 't', expectedRevision: 0, payload: { entries: [ref('B', skill)], subagents: [], skills: [], mcps: [] } });
      expect(await code(store.publishTemplate({ templateId: template.id, expectedRevision: 1, writes: [], payload: { entries: [ref('B', skill)], subagents: [], skills: [], mcps: [] } }))).toBe('builtin_read_only');
      expect(await code(store.publishTemplate({
        templateId: 'mine',
        expectedRevision: 0,
        name: 'Mine',
        writes: [{ assetId: skill.id, kind: 'block', expectedRevision: 1, payload: doc('edited') }],
        payload: { entries: [ref('B', skill, 2)], subagents: [], skills: [], mcps: [] },
      }))).toBe('builtin_read_only');
    });
  });

  it('an owner holds nothing extra, in a save or a publication', async () => {
    expect(await code(store.createAsset({ kind: 'block', name: 'x', payload: doc(), owner: { kind: 'library', extra: 'kept' } as never }))).toBe('invalid_payload');
    expect(await code(store.publishTemplate({
      templateId: 'tmpl',
      expectedRevision: 0,
      name: 'x',
      writes: [{ assetId: 'blk', kind: 'block', expectedRevision: 0, name: 'x', owner: { kind: 'agent', agentId: 'a', extra: 'kept' } as never, payload: doc() }],
      payload: { entries: [ref('A', 'blk')], subagents: [], skills: [], mcps: [] },
    }))).toBe('invalid_publication');
    expect((await store.read()).assets).toEqual({});
  });

  it('asset ids differing only by case can\'t both exist', async () => {
    expect(await code(store.publishTemplate({
      templateId: 'case-t',
      expectedRevision: 0,
      name: 'T',
      writes: [
        { assetId: 'Same', kind: 'block', expectedRevision: 0, name: 'x', payload: doc('x') },
        { assetId: 'same', kind: 'block', expectedRevision: 0, name: 'y', payload: doc('y') },
      ],
      payload: { entries: [ref('X', 'Same'), ref('Y', 'same')], subagents: [], skills: [], mcps: [] },
    }))).toBe('invalid_publication');
    expect((await store.read()).assets).toEqual({});
  });

  it('two store instances on one catalog lose nothing', async () => {
    const other = makeStore();
    await Promise.all(Array.from({ length: 6 }, (_, position) => (position % 2 === 0 ? store : other).createAsset({ kind: 'block', name: `Block ${position}`, payload: doc() })));
    expect(Object.keys((await store.read()).assets)).toHaveLength(6);
    const asset = await store.createAsset({ kind: 'block', name: 'Raced', payload: doc() });
    const results = await Promise.allSettled([store, other].map((each) => each.saveRevision({ assetId: asset.id, expectedRevision: 1, payload: doc('mine') })));
    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
  });

  it('a failed audit doesn\'t report a committed write as failed', async () => {
    W.auditFails = true;
    const asset = await store.createAsset({ kind: 'block', name: 'Kept', payload: doc() });
    expect((await store.read()).assets[asset.id].name).toBe('Kept');
    expect((await store.saveRevision({ assetId: asset.id, expectedRevision: 1, payload: doc('two') })).headRevision).toBe(2);
    expect(vi.mocked(appLog)).toHaveBeenCalledWith('core:asset-catalog', 'warn', expect.any(String), expect.anything());
  });

  it('an owner is representable: library by default, or one agent, or one project', async () => {
    expect((await store.createAsset({ kind: 'block', name: 'Shared', payload: doc() })).owner).toEqual({ kind: 'library' });
    expect((await store.createAsset({ kind: 'block', name: 'Mine', payload: doc(), owner: { kind: 'agent', agentId: 'a' } })).owner).toEqual({ kind: 'agent', agentId: 'a' });
    expect((await store.createAsset({ kind: 'block', name: 'Theirs', payload: doc(), owner: { kind: 'project', projectId: 'p' } })).owner).toEqual({ kind: 'project', projectId: 'p' });
  });

  it('rejects invalid input and forbidden template fields, and writes nothing', async () => {
    expect((await rejection(store.createAsset({ kind: 'mcp', name: 'x', payload: { serverKey: '' } }))).details.issues?.length).toBeGreaterThan(0);
    expect(await code(store.createAsset({ kind: 'block', name: '', payload: doc() }))).toBe('invalid_payload');
    expect(await code(store.createAsset({ kind: 'block', name: 'x', payload: doc(), source: { kind: 'copy', originAssetId: 'a', originRevision: 1 } }))).toBe('invalid_payload');
    const issues = (await rejection(store.createAsset({ kind: 'template', name: 'x', payload: { entries: [ref('A', 'a')], subagents: [], skills: [], mcps: [], model: 'opus' } }))).details.issues;
    expect(issues).toContainEqual({ code: 'forbidden_template_field', path: 'model' });
    expect(await code(store.createAsset({ kind: 'template', name: 'x', payload: { entries: [], subagents: [], skills: [], mcps: [] } }))).toBe('invalid_payload');
    expect(filesUnder(dir)).toEqual([]);
  });

  it('a template refers only to live revisions it may use, of the right kind', async () => {
    const { identity, review, git, base } = await seedBase();
    const template = (payload: Record<string, unknown>) => store.createAsset({ kind: 'template', name: 'x', payload: { entries: [ref('A', identity)], subagents: [], skills: [], mcps: [], ...payload } });
    expect(await code(template({ entries: [ref('A', 'asset-missing')] }))).toBe('invalid_reference');
    expect(await code(template({ entries: [ref('A', review)] }))).toBe('invalid_reference');
    expect(await code(template({ entries: [ref('A', identity, 9)] }))).toBe('invalid_reference');
    expect(await code(template({ skills: [git.id] }))).toBe('invalid_reference');
    const nested = await rejection(template({ skills: [base.id] }));
    expect(nested.details.issues).toContainEqual({ code: 'nested_template', path: 'skills[0]' });
    const copy = await store.copyAsset({ assetId: review.id, revision: 1, agentId: 'agent-1' });
    expect(await code(template({ skills: [copy.id] }))).toBe('invalid_reference');
  });

  it('a template can\'t hold two native subagents with one name', async () => {
    const role = await store.createAsset({ kind: 'block', name: 'Role', payload: doc() });
    const sub = (agentName: string) => store.createAsset({ kind: 'subagent', name: agentName, payload: { agentName, description: 'x', blocks: [ref('Role', role)], skills: [], mcps: [] } });
    const [one, two] = [await sub('tester'), await sub('Tester')];
    const error = await rejection(store.createAsset({
      kind: 'template',
      name: 'x',
      payload: { entries: [ref('A', role)], subagents: [{ entryId: 'a', subagentId: one.id, subagentRevision: 1 }, { entryId: 'b', subagentId: two.id, subagentRevision: 1 }], skills: [], mcps: [] },
    }));
    expect(error.details.issues).toContainEqual({ code: 'duplicate_subagent_name', path: 'subagents[1]' });
  });
});

describe('revisions', () => {
  it('appends immutable revisions under an expected revision', async () => {
    const asset = await store.createAsset({ kind: 'block', name: 'Doc', payload: doc('one') });
    const first = fs.readFileSync(path.join(dir, 'revisions', asset.id, '1.json'), 'utf8');
    const saved = await store.saveRevision({ assetId: asset.id, expectedRevision: 1, payload: doc('two') });
    expect(saved).toMatchObject({ headRevision: 2 });
    expect(saved.revisions[1].bundledBy).toBeUndefined();
    expect(await store.readRevision(asset.id, 1)).toEqual(doc('one'));
    expect(await store.readRevision(asset.id, 2)).toEqual(doc('two'));
    expect(fs.readFileSync(path.join(dir, 'revisions', asset.id, '1.json'), 'utf8')).toBe(first);
  });

  it('a stale expected revision fails explicitly and changes nothing', async () => {
    const asset = await store.createAsset({ kind: 'block', name: 'Doc', payload: doc('one') });
    await store.saveRevision({ assetId: asset.id, expectedRevision: 1, payload: doc('two') });
    const error = await rejection(store.saveRevision({ assetId: asset.id, expectedRevision: 1, payload: doc('three') }));
    expect(error.code).toBe('stale_revision');
    expect(error.details).toMatchObject({ expected: 1, current: 2 });
    expect((await store.read()).assets[asset.id].headRevision).toBe(2);
    expect(await code(store.readRevision(asset.id, 3))).toBe('revision_unavailable');
  });

  it('two racing saves: exactly one wins, whatever the order', async () => {
    const asset = await store.createAsset({ kind: 'block', name: 'Doc', payload: doc('one') });
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
    const asset = await store.createAsset({ kind: 'block', name: 'Doc', payload: doc('one') });
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
  it('keep every reference, and the plan\'s fingerprint', async () => {
    const { review, job, base } = await seedBase();
    await compose('agent-1', instanceOf(base));
    const before = await store.plan({ agentId: 'agent-1', adoption: ACCEPTED });

    expect(await store.renameAsset({ assetId: review.id, expectedName: 'Code review', name: 'Careful review' })).toMatchObject({ id: review.id, name: 'Careful review', headRevision: 1 });
    await store.renameAsset({ assetId: job.id, expectedName: 'Job', name: 'The job' });
    await store.renameAsset({ assetId: base.id, expectedName: 'Orchestrator', name: 'Lead' });

    const after = await store.plan({ agentId: 'agent-1', adoption: ACCEPTED });
    expect(after.fingerprint).toBe(before.fingerprint);
    expect(after.skills[0]).toMatchObject({ assetId: review.id, name: 'Careful review', destination: { key: 'skills/code-review' } });
    expect(after.instructions?.blocks[1]).toMatchObject({ assetId: job.id, name: 'The job', entryKey: 'base:Job' });
    expect(after.structure?.name).toBe('Lead');
  });

  it('a stale or invalid rename fails', async () => {
    const asset = await store.createAsset({ kind: 'block', name: 'Doc', payload: doc() });
    await store.renameAsset({ assetId: asset.id, expectedName: 'Doc', name: 'One' });
    expect(await code(store.renameAsset({ assetId: asset.id, expectedName: 'Doc', name: 'Two' }))).toBe('stale_name');
    expect(await code(store.renameAsset({ assetId: asset.id, expectedName: 'One', name: '  ' }))).toBe('invalid_payload');
    expect((await store.read()).assets[asset.id].name).toBe('One');
  });
});

describe('deletion', () => {
  it('is refused while anything uses it', async () => {
    const { job, review, base } = await seedBase();
    expect(await code(store.deleteAsset({ assetId: review.id, expectedRevision: 1 }))).toBe('asset_in_use');
    expect(await code(store.deleteAsset({ assetId: job.id, expectedRevision: 1 }))).toBe('asset_in_use');
    await compose('agent-1', instanceOf(base));
    expect(await code(store.deleteAsset({ assetId: base.id, expectedRevision: 1 }))).toBe('asset_in_use');
    expect((await store.read()).assets[review.id].deletedAt).toBeUndefined();
  });

  it('is refused while an instance is still on a revision that uses it, though the latest doesn\'t', async () => {
    const seed = await seedBase();
    await compose('behind', instanceOf(seed.base));
    await publish({
      templateId: seed.base.id,
      expectedRevision: 1,
      writes: [],
      payload: { entries: [ref('Identity', seed.identity)], subagents: [], skills: [seed.review.id], mcps: [seed.git.id] },
    });
    expect(await code(store.deleteAsset({ assetId: seed.job.id, expectedRevision: 1 }))).toBe('asset_in_use');
  });

  it('is refused while an instance is on a subagent revision that uses it, though a later revision doesn\'t', async () => {
    const job = await store.createAsset({ kind: 'block', name: 'Job', payload: doc('job') });
    const other = await store.createAsset({ kind: 'block', name: 'Other', payload: doc('other') });
    const definition = (block: CatalogEntry) => ({ agentName: 's', description: 'x', blocks: [ref('Role', block)], skills: [], mcps: [] });
    const sub = await store.createAsset({ kind: 'subagent', name: 'S', payload: definition(job) });
    const template = await store.createAsset({ kind: 'template', name: 'T', payload: { entries: [ref('Other', other)], subagents: [{ entryId: 'S', subagentId: sub.id, subagentRevision: 1 }], skills: [], mcps: [] } });
    await compose('agent-1', instanceOf(template));
    await saveEdit(sub.id, definition(other), 1);

    expect(await code(store.deleteAsset({ assetId: job.id, expectedRevision: 1 }))).toBe('asset_in_use');
    expect((await store.plan({ agentId: 'agent-1', adoption: ACCEPTED })).activation).not.toBeNull();
  });

  it('keeps what an accepted subagent revision refers to, even once nothing else does', async () => {
    const job = await store.createAsset({ kind: 'block', name: 'Job', payload: doc('job') });
    await store.saveRevision({ assetId: job.id, expectedRevision: 1, payload: doc('job two') });
    const sub = await store.createAsset({ kind: 'subagent', name: 'S', payload: { agentName: 's', description: 'x', blocks: [ref('Role', job)], skills: [], mcps: [] } });
    const template = await store.createAsset({ kind: 'template', name: 'T', payload: { entries: [ref('Role', job, 2)], subagents: [{ entryId: 'S', subagentId: sub.id, subagentRevision: 1 }], skills: [], mcps: [] } });
    await compose('agent-1', instanceOf(template));
    const plan = await store.plan({ agentId: 'agent-1', adoption: ACCEPTED });
    expect(plan.activation).not.toBeNull();
    expect(await code(store.deleteAsset({ assetId: job.id, expectedRevision: 2 }))).toBe('asset_in_use');
    expect(await store.readRevision(job.id, 1)).toEqual(doc('job'));
  });

  it('is refused while an agent that kept a removed subagent, following it, is still on the revision that uses it', async () => {
    const job = await store.createAsset({ kind: 'block', name: 'Job', payload: doc('job') });
    const other = await store.createAsset({ kind: 'block', name: 'Other', payload: doc('other') });
    const definition = (block: CatalogEntry) => ({ agentName: 's', description: 'x', blocks: [ref('Role', block)], skills: [], mcps: [] });
    const sub = await store.createAsset({ kind: 'subagent', name: 'S', payload: definition(job) });
    const t = await store.createAsset({ kind: 'template', name: 'T', payload: { entries: [ref('Other', other)], subagents: [{ entryId: 'S', subagentId: sub.id, subagentRevision: 1 }], skills: [], mcps: [] } });
    await compose('a', instanceOf(t));
    // T r2 removes S, and the agent keeps it: now followed directly, with a floor at r1.
    await publish({ templateId: t.id, expectedRevision: 1, writes: [], payload: { entries: [ref('Other', other)], subagents: [], skills: [], mcps: [] } });
    const preview = await store.previewStructureUpdate({ agentId: 'a', adoption: ACCEPTED });
    const kept = await store.acceptStructureUpdate({ agentId: 'a', expectedRevision: 1, targetRevision: 2, binding: preview.binding, adoption: ACCEPTED, choice: { order: ['base:Other'], subagents: { keepRemoved: ['base:S'] } } });
    expect(kept.subagents).toEqual([{ localId: 'S', source: { kind: 'follow', subagentId: sub.id } }]);
    expect(kept.floors[sub.id]).toBe(1);
    // U publishes a bundled S r2 that drops Job. The agent stays on r1, which still needs it.
    await publish({
      templateId: 'template-u',
      expectedRevision: 0,
      name: 'U',
      writes: [{ assetId: sub.id, kind: 'subagent', expectedRevision: 1, payload: definition(other) }],
      payload: { entries: [ref('Other', other)], subagents: [{ entryId: 'S', subagentId: sub.id, subagentRevision: 2 }], skills: [], mcps: [] },
    });
    expect((await store.plan({ agentId: 'a', adoption: ACCEPTED })).subagents[0].revision).toBe(1);

    expect(await code(store.deleteAsset({ assetId: job.id, expectedRevision: 1 }))).toBe('asset_in_use');
    expect((await store.plan({ agentId: 'a', adoption: ACCEPTED })).activation).not.toBeNull();
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
    await compose('agent-1', instanceOf(base, { removals: [review.id, extra.id] }));
    await store.deleteAsset({ assetId: extra.id, expectedRevision: 1 });
    const plan = await store.plan({ agentId: 'agent-1', adoption: ACCEPTED });
    expect(plan.blockers).toEqual([]);
    expect(plan.notices).toEqual([{ code: 'inert_removal', assetIds: [extra.id] }]);
  });

  it('a floor or keep marker holds that revision past deletion', async () => {
    const asset = await store.createAsset({ kind: 'block', name: 'Doc', payload: doc('one') });
    await store.saveRevision({ assetId: asset.id, expectedRevision: 1, payload: doc('two') });
    // A marker with no entry using it anymore: nothing depends on the asset, but the record still names a revision.
    await compose('agent-1', blank({ keepMarkers: { [asset.id]: 1 } }));
    await store.deleteAsset({ assetId: asset.id, expectedRevision: 2 });
    expect((await store.read()).assets[asset.id].revisions.map((record) => record.revision)).toEqual([1]);
    expect(await store.readRevision(asset.id, 1)).toEqual(doc('one'));
    expect(await code(store.readRevision(asset.id, 2))).toBe('revision_unavailable');

    await compose('agent-1', blank(), 1);
    await store.sweep();
    expect(await store.readRevision(asset.id, 1)).toEqual(doc('one'));
  });

  it('a deleted asset takes no more edits or copies', async () => {
    const asset = await store.createAsset({ kind: 'skill', name: 'Skill', payload: skillOf('s') });
    await compose('a', blank({ additions: [asset.id] }));
    const plan = await store.plan({ agentId: 'a', adoption: ACCEPTED });
    await store.recordRun({ runId: 'run-1', plan: plan.activation! });
    await compose('a', blank(), 1);
    await store.deleteAsset({ assetId: asset.id, expectedRevision: 1 });
    expect(await code(store.saveRevision({ assetId: asset.id, expectedRevision: 1, payload: skillOf('s') }))).toBe('asset_deleted');
    expect(await code(store.renameAsset({ assetId: asset.id, expectedName: 'Skill', name: 'x' }))).toBe('asset_deleted');
    expect(await code(store.copyAsset({ assetId: asset.id, revision: 1, agentId: 'a' }))).toBe('asset_deleted');
  });
});

describe('committing a composition', () => {
  it('stores it under an expected revision, keyed by agent id and nothing else', async () => {
    const { base } = await seedBase();
    const composition = instanceOf(base);
    const stored = await compose('agent-1', composition);
    expect(stored).toEqual({ ...composition, agentId: 'agent-1', revision: 1, updatedAt: '2026-11-04T00:00:00.000Z' });
    const second = await compose('agent-1', { ...composition, entries: [follow('Job'), follow('Identity')] }, 1);
    expect(second.revision).toBe(2);
    expect(await code(compose('agent-1', composition, 1))).toBe('stale_revision');
  });

  it('a stale preview fails and stores nothing', async () => {
    const { review, base } = await seedBase();
    const composition = instanceOf(base);
    const preview = await store.plan({ agentId: 'agent-1', adoption: ACCEPTED, draft: composition });
    await saveEdit(review.id, skillOf('code-review', 'edited'), 1);
    const error = await rejection(store.saveComposition({ agentId: 'agent-1', expectedRevision: 0, composition, adoption: ACCEPTED, previewFingerprint: preview.fingerprint }));
    expect(error.code).toBe('stale_preview');
    expect((await store.read()).compositions).toEqual({});
  });

  it('known conflicts block: no partial assignment', async () => {
    const { base } = await seedBase();
    const rival = await store.createAsset({ kind: 'mcp', name: 'Rival', payload: mcpOf('git') });
    const composition = instanceOf(base, { additions: [rival.id] });
    const preview = await store.plan({ agentId: 'agent-1', adoption: ACCEPTED, draft: composition });
    expect(preview.activation).toBeNull();
    const error = await rejection(store.saveComposition({ agentId: 'agent-1', expectedRevision: 0, composition, adoption: ACCEPTED, previewFingerprint: preview.fingerprint }));
    expect(error.code).toBe('composition_blocked');
    expect(error.details.plan?.blockers[0].code).toBe('destination_collision');
    expect((await store.read()).compositions).toEqual({});
  });

  it('a foreign owner blocks a commit the same way', async () => {
    const { base } = await seedBase();
    const composition = instanceOf(base);
    const foreign = [{ key: 'mcp/git', owner: 'native' as const }];
    const preview = await store.plan({ agentId: 'agent-1', adoption: ACCEPTED, draft: composition, foreign });
    expect(await code(store.saveComposition({ agentId: 'agent-1', expectedRevision: 0, composition, adoption: ACCEPTED, previewFingerprint: preview.fingerprint, foreign }))).toBe('composition_blocked');
  });

  it('rejects a composition carrying anything but assets', async () => {
    const draft = { ...blank(), worktreePath: '/somewhere' };
    expect(await code(store.plan({ agentId: 'agent-1', adoption: ACCEPTED, draft }))).toBe('invalid_composition');
    expect(await code(store.plan({ agentId: '__proto__', adoption: ACCEPTED }))).toBe('invalid_composition');
  });

  it('needs an adoption policy with both tracks every time, with none assumed', async () => {
    expect(await code(store.plan({ agentId: 'agent-1' } as never))).toBe('adoption_policy_required');
    expect(await code(store.plan({ agentId: 'agent-1', adoption: { content: { mode: 'takeable' } } } as never))).toBe('adoption_policy_required');
    expect(await code(store.saveComposition({ agentId: 'agent-1', expectedRevision: 0, composition: blank(), previewFingerprint: 'f' } as never))).toBe('adoption_policy_required');
    expect(await code(store.previewStructureUpdate({ agentId: 'agent-1' } as never))).toBe('adoption_policy_required');
  });

  it('can\'t change the accepted revision or the template: those have their own checks', async () => {
    const seed = await seedBase();
    await compose('agent-1', instanceOf(seed.base));
    await publish(moveRules(seed, 'safety-id'));
    const jumped = { ...instanceOf(seed.base), template: { templateId: seed.base.id, acceptedRevision: 2 } };
    const preview = await store.plan({ agentId: 'agent-1', adoption: ACCEPTED, draft: jumped });
    expect(await code(store.saveComposition({ agentId: 'agent-1', expectedRevision: 1, composition: jumped, adoption: ACCEPTED, previewFingerprint: preview.fingerprint }))).toBe('structure_change_requires_acceptance');
  });

  it('an explicit Apply is an ordinary save that sets a floor', async () => {
    const seed = await seedBase();
    const other = await store.createAsset({ kind: 'template', name: 'Other', payload: { entries: [ref('Job', seed.job)], subagents: [], skills: [], mcps: [] } });
    await compose('agent-1', instanceOf(other));
    await publish(moveRules(seed, 'safety-id'));

    const waiting = await store.plan({ agentId: 'agent-1', adoption: ACCEPTED });
    expect(waiting.instructions?.blocks[0]).toMatchObject({ revision: 1, update: { resolution: 'explicit', missingCompanions: ['safety-id'] } });

    await compose('agent-1', instanceOf(other, { floors: { [seed.job.id]: 2 } }), 1);
    const applied = await store.plan({ agentId: 'agent-1', adoption: ACCEPTED });
    expect(applied.instructions?.blocks[0]).toMatchObject({ revision: 2, floor: 2, update: null });
  });

  it('removing an agent forgets its composition and own copies, and shared assets stay', async () => {
    const { job, base } = await seedBase();
    const fork = await store.copyAsset({ assetId: job.id, revision: 1, agentId: 'agent-1' });
    const entries: InstanceEntry[] = [follow('Identity'), { baseEntryId: 'Job', source: { kind: 'fork', blockId: fork.id, forkedFrom: { assetId: job.id, revision: 1 } } }];
    await compose('agent-1', instanceOf(base, { entries }));
    expect(await code(store.removeAgent({ agentId: 'agent-1', expectedRevision: 0 }))).toBe('stale_revision');
    await store.removeAgent({ agentId: 'agent-1', expectedRevision: 1 });
    const index = await store.read();
    expect(index.compositions).toEqual({});
    expect(index.assets[fork.id]).toBeUndefined();
    expect(index.assets[job.id]).toBeDefined();
    expect(fs.existsSync(path.join(dir, 'revisions', fork.id))).toBe(false);
  });
});

describe('central edits', () => {
  it('need the impact preview to be confirmed when anything consumes the asset', async () => {
    const { review, base } = await seedBase();
    await compose('agent-1', instanceOf(base));
    const payload = skillOf('code-review', 'edited');

    const unconfirmed = await rejection(store.saveRevision({ assetId: review.id, expectedRevision: 1, payload }));
    expect(unconfirmed.code).toBe('impact_confirmation_required');
    expect(unconfirmed.details.impact?.agents.map((agent) => agent.agentId)).toEqual(['agent-1']);

    const impact = await store.previewAssetEdit({ assetId: review.id, payload });
    expect(impact.templates).toEqual([{ templateId: base.id, role: 'skill' }]);
    expect((await store.saveRevision({ assetId: review.id, expectedRevision: 1, payload, impactFingerprint: impact.fingerprint })).headRevision).toBe(2);
  });

  it('a preview from before the consumers changed is stale', async () => {
    const { review, base } = await seedBase();
    const payload = skillOf('code-review', 'edited');
    const impact = await store.previewAssetEdit({ assetId: review.id, payload });
    await compose('agent-1', instanceOf(base));
    expect(await code(store.saveRevision({ assetId: review.id, expectedRevision: 1, payload, impactFingerprint: impact.fingerprint }))).toBe('stale_preview');
    expect((await store.read()).assets[review.id].headRevision).toBe(1);
  });

  it('a preview of different content is stale', async () => {
    const { review, base } = await seedBase();
    await compose('agent-1', instanceOf(base));
    const impact = await store.previewAssetEdit({ assetId: review.id, payload: skillOf('code-review', 'one') });
    expect(await code(store.saveRevision({ assetId: review.id, expectedRevision: 1, payload: skillOf('code-review', 'two'), impactFingerprint: impact.fingerprint }))).toBe('stale_preview');
  });

  it('an edit that would break a consumer is refused, whatever is confirmed', async () => {
    const { git, base } = await seedBase();
    const other = await store.createAsset({ kind: 'mcp', name: 'Other', payload: mcpOf('other') });
    await compose('agent-1', instanceOf(base, { additions: [other.id] }));
    const payload = mcpOf('git');
    const impact = await store.previewAssetEdit({ assetId: other.id, payload });
    expect(impact.blocked).toBe(true);
    const error = await rejection(store.saveRevision({ assetId: other.id, expectedRevision: 1, payload, impactFingerprint: impact.fingerprint }));
    expect(error.code).toBe('consumer_conflict');
    expect(error.details.impact?.agents[0].newBlockers[0]).toMatchObject({ code: 'destination_collision', assetIds: [git.id, other.id].sort() });
    expect((await store.read()).assets[other.id].headRevision).toBe(1);
  });

  it('an independent block edit is explicit and flows: no tag, and followers take it', async () => {
    const { job, base } = await seedBase();
    await compose('agent-1', instanceOf(base));
    const saved = await saveEdit(job.id, doc('Edited on its own.'), 1);
    expect(saved.revisions[1].bundledBy).toBeUndefined();
    expect((await store.plan({ agentId: 'agent-1', adoption: ACCEPTED })).instructions?.blocks[1]).toMatchObject({ revision: 2, floor: 1 });
  });

  it('an unassigned asset takes a revision with no confirmation', async () => {
    const asset = await store.createAsset({ kind: 'skill', name: 'Skill', payload: skillOf('s') });
    expect(await store.saveRevision({ assetId: asset.id, expectedRevision: 1, payload: skillOf('s', 'two') })).toMatchObject({ headRevision: 2 });
  });
});

describe('publication', () => {
  it('commits a template revision and its block revisions together, tagged', async () => {
    const seed = await seedBase();
    const published = await publish(moveRules(seed, 'safety-id'));
    expect(published).toMatchObject({ id: seed.base.id, headRevision: 2 });
    const index = await store.read();
    const tag = { templateId: seed.base.id, templateRevision: 2 };
    expect(index.assets[seed.job.id].revisions.map((record) => record.bundledBy)).toEqual([undefined, tag]);
    expect(index.assets['safety-id']).toMatchObject({ kind: 'block', name: 'Safety', headRevision: 1 });
    expect(index.assets['safety-id'].revisions[0].bundledBy).toEqual(tag);
    expect(index.assets[seed.base.id].revisions[1].projection).toMatchObject({ entries: [{ entryId: 'Identity' }, { entryId: 'Safety' }, { entryId: 'Job', blockRevision: 2 }] });
    expect(await store.readRevision(seed.job.id, 2)).toEqual(doc('Do the work.'));
    expect(await store.readRevision('safety-id', 1)).toEqual(doc('Keep the rules.'));
  });

  it('can create the template and every block at once', async () => {
    const id = store.mintAssetId();
    const blockId = store.mintAssetId();
    const created = await store.publishTemplate({
      templateId: id,
      expectedRevision: 0,
      name: 'New template',
      writes: [{ assetId: blockId, kind: 'block', expectedRevision: 0, name: 'One', payload: doc('One') }],
      payload: { entries: [ref('One', blockId)], subagents: [], skills: [], mcps: [] },
    });
    expect(created).toMatchObject({ id, name: 'New template', headRevision: 1, owner: { kind: 'library' } });
    expect((await store.read()).assets[blockId].revisions[0].bundledBy).toEqual({ templateId: id, templateRevision: 1 });
  });

  it('a subagent and its block can be published with the template', async () => {
    const seed = await seedBase();
    const role = store.mintAssetId();
    const tester = store.mintAssetId();
    await publish({
      templateId: seed.base.id,
      expectedRevision: 1,
      writes: [
        { assetId: role, kind: 'block', expectedRevision: 0, name: 'Role', payload: doc('Run tests.') },
        { assetId: tester, kind: 'subagent', expectedRevision: 0, name: 'Tester', payload: { agentName: 'tester', description: 'Runs tests.', blocks: [ref('Role', role)], skills: [], mcps: [] } },
      ],
      payload: {
        entries: [ref('Identity', seed.identity), ref('Job', seed.job)],
        subagents: [{ entryId: 'Tester', subagentId: tester, subagentRevision: 1 }],
        skills: [seed.review.id],
        mcps: [seed.git.id],
      },
    });
    const index = await store.read();
    expect(index.assets[role].revisions[0].bundledBy).toEqual({ templateId: seed.base.id, templateRevision: 2 });
    expect(index.assets[tester].revisions[0].bundledBy).toEqual({ templateId: seed.base.id, templateRevision: 2 });
  });

  it('republishing a ref adds no tag', async () => {
    const seed = await seedBase();
    await saveEdit(seed.job.id, doc('Independent edit.'), 1);
    await publish({
      templateId: seed.base.id,
      expectedRevision: 1,
      writes: [],
      payload: { entries: [ref('Identity', seed.identity), ref('Job', seed.job, 2)], subagents: [], skills: [seed.review.id], mcps: [seed.git.id] },
    });
    expect((await store.read()).assets[seed.job.id].revisions.map((record) => record.bundledBy)).toEqual([undefined, undefined]);
  });

  it('a tag is set once: a later ref leaves it naming the first publication', async () => {
    const seed = await seedBase();
    await publish(moveRules(seed, 'safety-id'));
    await publish({
      templateId: seed.base.id,
      expectedRevision: 2,
      writes: [],
      payload: { entries: [ref('Job', seed.job, 2)], subagents: [], skills: [], mcps: [] },
    });
    expect((await store.read()).assets[seed.job.id].revisions[1].bundledBy).toEqual({ templateId: seed.base.id, templateRevision: 2 });
  });

  it('refuses a write the template never refers to: a tag nothing can accept would hold everyone back', async () => {
    const seed = await seedBase();
    const request = moveRules(seed, 'safety-id');
    const error = await rejection(store.publishTemplate({ ...request, payload: { entries: [ref('Identity', seed.identity), ref('Safety', 'safety-id')], subagents: [], skills: [], mcps: [] } }));
    expect(error.code).toBe('invalid_publication');
    expect(error.details.issues).toEqual([{ code: 'unreferenced_bundle_write', path: seed.job.id }]);
    expect((await store.read()).assets[seed.job.id].headRevision).toBe(1);
  });

  it('checks every expected revision, and any stale one refuses the whole batch', async () => {
    const seed = await seedBase();
    await saveEdit(seed.job.id, doc('Someone got there first.'), 1);
    expect(await code(store.publishTemplate(moveRules(seed, 'safety-id')))).toBe('stale_revision');
    const index = await store.read();
    expect(index.assets[seed.base.id].headRevision).toBe(1);
    expect(index.assets['safety-id']).toBeUndefined();
    expect(filesUnder(path.join(dir, 'revisions', 'safety-id'))).toEqual([]);

    expect(await code(store.publishTemplate({ ...moveRules(seed, 'safety-id'), expectedRevision: 5 }))).toBe('stale_revision');
  });

  it('refuses a bad write, a repeat, a wrong kind and an id already taken', async () => {
    const seed = await seedBase();
    const request = moveRules(seed, 'safety-id');
    const [newBlock, jobWrite] = request.writes;
    expect(await code(store.publishTemplate({ ...request, writes: [{ ...newBlock, payload: { content: FAKE_GH_TOKEN } }, jobWrite] }))).toBe('invalid_payload');
    expect(await code(store.publishTemplate({ ...request, writes: [newBlock, jobWrite, jobWrite] }))).toBe('invalid_publication');
    expect(await code(store.publishTemplate({ ...request, writes: [{ ...newBlock, kind: 'skill' as never }, jobWrite] }))).toBe('invalid_publication');
    expect(await code(store.publishTemplate({ ...request, writes: [{ ...newBlock, assetId: seed.git.id }, jobWrite] }))).toBe('asset_exists');
    expect(await code(store.publishTemplate({ ...request, writes: [{ ...jobWrite, kind: 'subagent' }] }))).toBe('invalid_publication');
    expect(await code(store.publishTemplate({ ...request, templateId: seed.job.id }))).toBe('invalid_publication');
    expect(await code(store.publishTemplate({ ...request, expectedRevision: 0 }))).toBe('asset_exists');
    expect(await code(store.publishTemplate({ ...request, writes: [{ ...newBlock, name: undefined }, jobWrite] }))).toBe('invalid_publication');
  });

  it('confirms against every consumer, including other templates\' agents', async () => {
    const seed = await seedBase();
    const other = await store.createAsset({ kind: 'template', name: 'Other', payload: { entries: [ref('Job', seed.job)], subagents: [], skills: [], mcps: [] } });
    await compose('linked', instanceOf(seed.base));
    await compose('elsewhere', instanceOf(other));
    const request = moveRules(seed, 'safety-id');

    expect(await code(store.publishTemplate(request))).toBe('impact_confirmation_required');
    const impact = await store.previewPublication(request);
    expect(impact).toMatchObject({ assetId: seed.base.id, fromRevision: 1, toRevision: 2, blocked: false });
    expect(impact.agents.map((agent) => agent.agentId)).toEqual(['elsewhere', 'linked']);
    const linked = impact.agents.find((agent) => agent.agentId === 'linked');
    expect(linked).toMatchObject({ changes: [], held: [seed.job.id], structure: { status: 'clean', targetRevision: 2 } });
    expect(impact.agents.find((agent) => agent.agentId === 'elsewhere')).toMatchObject({ changes: [], held: [seed.job.id] });

    await compose('late', instanceOf(seed.base));
    expect(await code(store.publishTemplate({ ...request, impactFingerprint: impact.fingerprint }))).toBe('stale_preview');
  });

  describe('failing at each step', () => {
    /** Two payload files, the template's payload file, then the index: four renames. */
    const STEPS = 4;

    it.each(Array.from({ length: STEPS }, (_, step) => step))('a failure at rename %i leaves a reader all old', async (step) => {
      const seed = await seedBase();
      const before = await store.read();
      const raw = fs.readFileSync(path.join(dir, 'catalog.json'), 'utf8');

      let renames = 0;
      renameFault = () => (renames++ === step ? Object.assign(new Error('crash'), { code: 'EIO' }) : null);
      await expect(store.publishTemplate(moveRules(seed, 'safety-id'))).rejects.toThrow('crash');
      renameFault = null;

      expect(fs.readFileSync(path.join(dir, 'catalog.json'), 'utf8')).toBe(raw);
      expect(await store.read()).toEqual(before);
      expect(filesUnder(dir).filter((file) => file.includes('.tmp.'))).toEqual([]);
      expect(await store.readRevision(seed.job.id, 1)).toEqual(doc('Do the work. Keep the rules.'));
      expect(await code(store.readRevision(seed.job.id, 2))).toBe('revision_unavailable');

      // The same publication, retried, replaces anything it left behind.
      await store.publishTemplate(moveRules(seed, 'safety-id'));
      expect(await store.readRevision(seed.job.id, 2)).toEqual(doc('Do the work.'));
      expect((await store.read()).assets[seed.base.id].headRevision).toBe(2);
    });

    it('the count above is every rename there is', async () => {
      const seed = await seedBase();
      let renames = 0;
      renameFault = () => {
        renames++;
        return null;
      };
      await store.publishTemplate(moveRules(seed, 'safety-id'));
      expect(renames).toBe(STEPS);
    });

    it('no tagged revision is visible before its template, at any step', async () => {
      const seed = await seedBase();
      const seen: number[] = [];
      renameFault = () => {
        const index = JSON.parse(fs.readFileSync(path.join(dir, 'catalog.json'), 'utf8'));
        const tagged = Object.values<CatalogEntry>(index.assets).flatMap((entry) => entry.revisions).filter((record) => record.bundledBy);
        seen.push(tagged.length);
        expect(index.assets[seed.base.id].headRevision).toBe(1);
        return null;
      };
      await store.publishTemplate(moveRules(seed, 'safety-id'));
      renameFault = null;
      expect(seen).toEqual([0, 0, 0, 0]);

      const after = await store.read();
      expect(after.assets[seed.base.id].headRevision).toBe(2);
      expect(Object.values(after.assets).flatMap((entry) => entry.revisions).filter((record) => record.bundledBy)).toHaveLength(2);
    });

    it('a concurrent reader sees one state or the other, never a mix', async () => {
      const seed = await seedBase();
      const reads: Array<{ template: number; job: number }> = [];
      const sample = async () => {
        const index = await store.read();
        reads.push({ template: index.assets[seed.base.id].headRevision, job: index.assets[seed.job.id].headRevision });
      };
      await Promise.all([store.publishTemplate(moveRules(seed, 'safety-id')), sample(), sample(), sample()]);
      await sample();
      for (const read of reads) expect([[1, 1], [2, 2]]).toContainEqual([read.template, read.job]);
    });
  });
});

describe('accepting a structure update', () => {
  it('a clean revision takes no choice, and the floor moves past its tags', async () => {
    const seed = await seedBase();
    await compose('agent-1', instanceOf(seed.base));
    await publish(moveRules(seed, 'safety-id'));

    const preview = await store.previewStructureUpdate({ agentId: 'agent-1', adoption: ACCEPTED });
    expect(preview).toMatchObject({ targetRevision: 2, check: { clean: true } });
    const saved = await store.acceptStructureUpdate({ agentId: 'agent-1', expectedRevision: 1, targetRevision: 2, binding: preview.binding, adoption: ACCEPTED });
    expect(saved).toMatchObject({ revision: 2, template: { templateId: seed.base.id, acceptedRevision: 2 } });
    expect(saved.entries.map((entry) => entry.baseEntryId)).toEqual(['Identity', 'Safety', 'Job']);

    const plan = await store.plan({ agentId: 'agent-1', adoption: ACCEPTED });
    expect(plan.instructions?.blocks.map((block) => [block.assetId, block.revision])).toEqual([[seed.identity.id, 1], ['safety-id', 1], [seed.job.id, 2]]);
    expect(plan.structure).toMatchObject({ acceptedRevision: 2, latestRevision: 2, update: { status: 'current' } });
  });

  it('rules never disappear, before or after, in the composed text', async () => {
    const seed = await seedBase();
    const rules = await store.createAsset({ kind: 'block', name: 'Rules', payload: doc('Local rule.'), owner: { kind: 'agent', agentId: 'custom' } });
    await compose('follower', instanceOf(seed.base));
    await compose('custom', instanceOf(seed.base, { entries: [follow('Identity'), { localId: 'Rules', source: { kind: 'local', blockId: rules.id } }, follow('Job')] }));
    await publish(moveRules(seed, 'safety-id'));

    expect(await textOf(await store.plan({ agentId: 'follower', adoption: ACCEPTED }))).toContain('Keep the rules.');
    const follower = await store.plan({ agentId: 'follower', adoption: LATEST });
    expect(await textOf(follower)).toBe('You are @@AgentName.\n\nKeep the rules.\n\nDo the work.');

    const custom = await store.plan({ agentId: 'custom', adoption: LATEST });
    expect(custom.structure?.update.status).toBe('needs-choice');
    expect(await textOf(custom)).toBe('You are @@AgentName.\n\nLocal rule.\n\nDo the work. Keep the rules.');
  });

  it('a revision that needs a choice waits, whole, and refuses to be taken without one', async () => {
    const seed = await seedBase();
    const rules = await store.createAsset({ kind: 'block', name: 'Rules', payload: doc('Local rule.'), owner: { kind: 'agent', agentId: 'agent-1' } });
    await compose('agent-1', instanceOf(seed.base, { entries: [follow('Identity'), { localId: 'Rules', source: { kind: 'local', blockId: rules.id } }, follow('Job')] }));
    await publish(moveRules(seed, 'safety-id'));

    const preview = await store.previewStructureUpdate({ agentId: 'agent-1', adoption: ACCEPTED });
    expect(preview.check.clean).toBe(false);
    expect(preview.check.reasons).toContainEqual({ code: 'add_position', entries: ['base:Safety'] });

    const error = await rejection(store.acceptStructureUpdate({ agentId: 'agent-1', expectedRevision: 1, targetRevision: 2, binding: preview.binding, adoption: ACCEPTED }));
    expect(error.code).toBe('structure_needs_choice');
    expect(error.details.check?.clean).toBe(false);
    expect((await store.read()).compositions['agent-1'].template?.acceptedRevision).toBe(1);

    const incomplete = await rejection(store.acceptStructureUpdate({ agentId: 'agent-1', expectedRevision: 1, targetRevision: 2, binding: preview.binding, adoption: ACCEPTED, choice: { order: ['base:Identity', 'local:Rules', 'base:Job'] } }));
    expect(incomplete.code).toBe('invalid_choice');
    expect((await store.read()).compositions['agent-1'].revision).toBe(1);

    const saved = await store.acceptStructureUpdate({
      agentId: 'agent-1',
      expectedRevision: 1,
      targetRevision: 2,
      binding: preview.binding,
      adoption: ACCEPTED,
      choice: { order: ['base:Identity', 'base:Safety', 'local:Rules', 'base:Job'] },
    });
    expect(saved.entries.map((entry) => entry.baseEntryId ?? entry.localId)).toEqual(['Identity', 'Safety', 'Rules', 'Job']);
    expect(saved.template?.acceptedRevision).toBe(2);
    expect((await store.plan({ agentId: 'agent-1', adoption: ACCEPTED })).instructions?.blocks.map((block) => block.revision)).toEqual([1, 1, 1, 2]);
  });

  it('an independent subagent revision can\'t pull a bundled block past an agent that hasn\'t accepted it', async () => {
    const job = await store.createAsset({ kind: 'block', name: 'Job', payload: doc('job') });
    const definition = (blockRevision: number) => ({ agentName: 's', description: 'x', blocks: [ref('Role', job, blockRevision)], skills: [], mcps: [] });
    const sub = await store.createAsset({ kind: 'subagent', name: 'S', payload: definition(1) });
    const template = await store.createAsset({ kind: 'template', name: 'T', payload: { entries: [ref('Job', job)], subagents: [{ entryId: 'S', subagentId: sub.id, subagentRevision: 1 }], skills: [], mcps: [] } });
    await compose('a', instanceOf(template));
    await publish({
      templateId: template.id,
      expectedRevision: 1,
      writes: [
        { assetId: 'safety-id', kind: 'block', expectedRevision: 0, name: 'Safety', payload: doc('safety') },
        { assetId: job.id, kind: 'block', expectedRevision: 1, payload: doc('job two') },
      ],
      payload: { entries: [ref('Safety', 'safety-id'), ref('Job', job, 2)], subagents: [{ entryId: 'S', subagentId: sub.id, subagentRevision: 1 }], skills: [], mcps: [] },
    });
    await saveEdit(sub.id, definition(2), 1);

    const plan = await store.plan({ agentId: 'a', adoption: ACCEPTED });
    expect(plan.structure?.acceptedRevision).toBe(1);
    expect(plan.subagents[0]).toMatchObject({ revision: 1, update: { heldBy: { templateId: template.id, templateRevision: 2 }, resolution: 'accept-template' } });
    expect(plan.subagents[0].blocks[0]).toMatchObject({ assetId: job.id, revision: 1 });

    const preview = await store.previewStructureUpdate({ agentId: 'a', adoption: ACCEPTED });
    await store.acceptStructureUpdate({ agentId: 'a', expectedRevision: 1, targetRevision: 2, binding: preview.binding, adoption: ACCEPTED });
    const after = await store.plan({ agentId: 'a', adoption: ACCEPTED });
    expect(after.subagents[0]).toMatchObject({ revision: 2, blocks: [{ assetId: job.id, revision: 2 }] });
  });

  describe('a choice can\'t go stale', () => {
    async function pending() {
      const seed = await seedBase();
      await compose('agent-1', instanceOf(seed.base));
      await publish(moveRules(seed, 'safety-id'));
      const preview = await store.previewStructureUpdate({ agentId: 'agent-1', adoption: ACCEPTED });
      return { seed, preview };
    }
    const accept = (binding: unknown, targetRevision = 2, expectedRevision = 1) => store.acceptStructureUpdate({ agentId: 'agent-1', expectedRevision, targetRevision, binding: binding as never, adoption: ACCEPTED });

    it('rejects a different old revision', async () => {
      const { preview } = await pending();
      expect(await code(accept({ ...preview.binding, fromFingerprint: 'other' }))).toBe('stale_choice');
    });

    it('rejects a different new revision', async () => {
      const { preview } = await pending();
      expect(await code(accept({ ...preview.binding, toFingerprint: 'other' }))).toBe('stale_choice');
    });

    it('rejects when the instance changed since the preview, even at the same revision count', async () => {
      const { seed, preview } = await pending();
      await compose('agent-1', instanceOf(seed.base, { entries: [follow('Job'), follow('Identity')] }), 1);
      expect(await code(accept(preview.binding, 2, 2))).toBe('stale_choice');
    });

    it('rejects a binding that isn\'t one', async () => {
      await pending();
      expect(await code(accept(undefined))).toBe('stale_choice');
    });

    it('a newer template revision makes it stale: latest only, no intermediate adoption', async () => {
      const { seed, preview } = await pending();
      await publish({
        templateId: seed.base.id,
        expectedRevision: 2,
        writes: [],
        payload: { entries: [ref('Identity', seed.identity), ref('Safety', 'safety-id'), ref('Job', seed.job, 2)], subagents: [], skills: [], mcps: [] },
      });
      expect(await code(accept(preview.binding, 2))).toBe('stale_revision');
      expect(await code(accept(preview.binding, 3))).toBe('stale_choice');
    });

    it('rejects a stale composition revision, and a target that is already accepted', async () => {
      const { preview } = await pending();
      expect(await code(accept(preview.binding, 2, 9))).toBe('stale_revision');
      await accept(preview.binding);
      const again = await store.previewStructureUpdate({ agentId: 'agent-1', adoption: ACCEPTED });
      expect(await code(accept(again.binding, 2, 2))).toBe('stale_revision');
    });
  });

  it('a revision whose result would block can\'t be accepted', async () => {
    const seed = await seedBase();
    const twin = await store.createAsset({ kind: 'skill', name: 'Twin', payload: skillOf('code-review') });
    await compose('agent-1', instanceOf(seed.base));
    await publish({
      templateId: seed.base.id,
      expectedRevision: 1,
      writes: [],
      payload: { entries: [ref('Identity', seed.identity), ref('Job', seed.job)], subagents: [], skills: [seed.review.id, twin.id], mcps: [seed.git.id] },
    });
    const preview = await store.previewStructureUpdate({ agentId: 'agent-1', adoption: ACCEPTED });
    expect(preview.plan.blockers.map((issue) => issue.code)).toEqual(['destination_collision']);
    expect(await code(store.acceptStructureUpdate({ agentId: 'agent-1', expectedRevision: 1, targetRevision: 2, binding: preview.binding, adoption: ACCEPTED }))).toBe('composition_blocked');
    expect((await store.plan({ agentId: 'agent-1', adoption: LATEST })).activation).not.toBeNull();
  });

  describe('a revision raising access or orchestration', () => {
    async function raised() {
      const block = await store.createAsset({ kind: 'block', name: 'B', payload: doc() });
      const entries = [ref('B', block)];
      const template = await store.createAsset({ kind: 'template', name: 'T', payload: { entries, subagents: [], skills: [], mcps: [], operationalDefaults: { agentAccess: 'standard' } } });
      await compose('a', instanceOf(template));
      await publish({ templateId: template.id, expectedRevision: 1, writes: [], payload: { entries, subagents: [], skills: [], mcps: [], operationalDefaults: { agentAccess: 'bypass', orchestrate: true } } });
      return { template, preview: await store.previewStructureUpdate({ agentId: 'a', adoption: ACCEPTED }) };
    }
    const accept = (binding: unknown, choice?: Parameters<AssetCatalogStore['acceptStructureUpdate']>[0]['choice']) => store.acceptStructureUpdate({ agentId: 'a', expectedRevision: 1, targetRevision: 2, binding: binding as never, adoption: ACCEPTED, choice });

    it('can\'t be taken without a person, though everything else about it is clean', async () => {
      const { preview } = await raised();
      expect(preview.check.clean).toBe(true);
      expect(preview.operationalIncreases).toEqual(['agentAccess', 'orchestrate']);
      const error = await rejection(accept(preview.binding));
      expect(error.code).toBe('structure_needs_choice');
      expect(error.details.operationalIncreases).toEqual(['agentAccess', 'orchestrate']);
      expect((await store.plan({ agentId: 'a', adoption: LATEST })).operationalDefaults.map((item) => item.value)).toEqual(['standard']);
    });

    it('a choice has to name every key it raises', async () => {
      const { preview } = await raised();
      expect(await code(accept(preview.binding, { order: ['base:B'] }))).toBe('invalid_choice');
      expect(await code(accept(preview.binding, { order: ['base:B'], acceptOperationalIncreases: ['agentAccess'] }))).toBe('invalid_choice');
      const saved = await accept(preview.binding, { order: ['base:B'], acceptOperationalIncreases: ['agentAccess', 'orchestrate'] });
      expect(saved.template?.acceptedRevision).toBe(2);
      expect((await store.plan({ agentId: 'a', adoption: ACCEPTED })).operationalDefaults.map((item) => [item.key, item.value])).toEqual([['agentAccess', 'bypass'], ['orchestrate', true]]);
    });

    it('a switch shows what it would raise', async () => {
      const { template } = await raised();
      const other = await store.createAsset({ kind: 'template', name: 'Other', payload: { entries: template.revisions[0].projection.kind === 'template' ? template.revisions[0].projection.entries : [], subagents: [], skills: [], mcps: [], operationalDefaults: { agentAccess: 'auto', connectToDispatcher: true } } });
      const preview = await store.previewTemplateSwitch({ agentId: 'a', templateId: other.id, selection: {}, adoption: ACCEPTED });
      expect(preview.operationalIncreases).toEqual(['agentAccess', 'connectToDispatcher']);
    });
  });

  it('skipping T2 for T3: only the latest is on offer, and T2\'s tags are absorbed', async () => {
    const seed = await seedBase();
    await compose('agent-1', instanceOf(seed.base));
    await publish(moveRules(seed, 'safety-id'));
    await publish({
      templateId: seed.base.id,
      expectedRevision: 2,
      writes: [{ assetId: seed.job.id, kind: 'block', expectedRevision: 2, payload: doc('Do the work well.') }],
      payload: { entries: [ref('Identity', seed.identity), ref('Safety', 'safety-id'), ref('Job', seed.job, 3)], subagents: [], skills: [seed.review.id], mcps: [seed.git.id] },
    });
    const preview = await store.previewStructureUpdate({ agentId: 'agent-1', adoption: ACCEPTED });
    expect(preview.targetRevision).toBe(3);
    await store.acceptStructureUpdate({ agentId: 'agent-1', expectedRevision: 1, targetRevision: 3, binding: preview.binding, adoption: ACCEPTED });
    expect((await store.plan({ agentId: 'agent-1', adoption: ACCEPTED })).instructions?.blocks.find((block) => block.assetId === seed.job.id)).toMatchObject({ revision: 3, floor: 3, update: null });
  });
});

describe('switching template', () => {
  it('replaces, with only what was selected carrying over, and the agent id unchanged', async () => {
    const seed = await seedBase();
    const other = await store.createAsset({ kind: 'template', name: 'Other', payload: { entries: [ref('Solo', seed.identity)], subagents: [], skills: [], mcps: [] } });
    const rules = await store.createAsset({ kind: 'block', name: 'Rules', payload: doc('Local rule.'), owner: { kind: 'agent', agentId: 'agent-1' } });
    const notes = await store.createAsset({ kind: 'block', name: 'Notes', payload: doc('Local note.'), owner: { kind: 'agent', agentId: 'agent-1' } });
    await compose('agent-1', instanceOf(seed.base, {
      entries: [follow('Identity'), follow('Job'), { localId: 'Rules', source: { kind: 'local', blockId: rules.id } }, { localId: 'Notes', source: { kind: 'local', blockId: notes.id } }],
    }));

    const selection = { entries: ['local:Rules'] };
    const preview = await store.previewTemplateSwitch({ agentId: 'agent-1', templateId: other.id, selection, adoption: ACCEPTED });
    expect(preview.plan.blockers).toEqual([]);
    expect(preview.plan.instructions?.blocks.map((block) => block.entryKey)).toEqual(['base:Solo', 'local:Rules']);
    expect((await store.read()).compositions['agent-1'].template?.templateId).toBe(seed.base.id);

    const saved = await store.switchTemplate({ agentId: 'agent-1', expectedRevision: 1, templateId: other.id, selection, binding: preview.binding, adoption: ACCEPTED });
    expect(saved).toMatchObject({ agentId: 'agent-1', revision: 2, template: { templateId: other.id, acceptedRevision: 1 } });
    expect(saved.entries.map((entry) => entry.baseEntryId ?? entry.localId)).toEqual(['Solo', 'Rules']);
  });

  it('goes stale if anything moved since the preview', async () => {
    const seed = await seedBase();
    const other = await store.createAsset({ kind: 'template', name: 'Other', payload: { entries: [ref('Solo', seed.identity)], subagents: [], skills: [], mcps: [] } });
    await compose('agent-1', instanceOf(seed.base));
    const preview = await store.previewTemplateSwitch({ agentId: 'agent-1', templateId: other.id, selection: {}, adoption: ACCEPTED });
    await publish({
      templateId: other.id,
      expectedRevision: 1,
      writes: [],
      payload: { entries: [ref('Solo', seed.job)], subagents: [], skills: [], mcps: [] },
    });
    expect(await code(store.switchTemplate({ agentId: 'agent-1', expectedRevision: 1, templateId: other.id, selection: {}, binding: preview.binding, adoption: ACCEPTED }))).toBe('stale_choice');
  });

  it('refuses a selection of something not there, or a result that would block', async () => {
    const seed = await seedBase();
    const twin = await store.createAsset({ kind: 'skill', name: 'Twin', payload: skillOf('code-review') });
    const other = await store.createAsset({ kind: 'template', name: 'Other', payload: { entries: [ref('Solo', seed.identity)], subagents: [], skills: [twin.id], mcps: [] } });
    await compose('agent-1', instanceOf(seed.base, { additions: [seed.review.id] }));
    expect(await code(store.previewTemplateSwitch({ agentId: 'agent-1', templateId: other.id, selection: { entries: ['local:Nope'] }, adoption: ACCEPTED }))).toBe('invalid_choice');
    const selection = { additions: [seed.review.id] };
    const preview = await store.previewTemplateSwitch({ agentId: 'agent-1', templateId: other.id, selection, adoption: ACCEPTED });
    expect(preview.plan.activation).toBeNull();
    expect(await code(store.switchTemplate({ agentId: 'agent-1', expectedRevision: 1, templateId: other.id, selection, binding: preview.binding, adoption: ACCEPTED }))).toBe('composition_blocked');
  });

  describe('has a way through what would block it', () => {
    async function riskyTemplate() {
      const role = await store.createAsset({ kind: 'block', name: 'Role', payload: doc() });
      const sub = await store.createAsset({ kind: 'subagent', name: 'Risky', payload: { agentName: 'risky', description: 'x', blocks: [ref('Role', role)], skills: [], mcps: [], provider: { claude: { hooks: {} } } } });
      const template = await store.createAsset({ kind: 'template', name: 'T', payload: { entries: [ref('Role', role)], subagents: [{ entryId: 'Risky', subagentId: sub.id, subagentRevision: 1 }], skills: [], mcps: [] } });
      return { sub, template };
    }

    it('a subagent needing a person blocks, then goes through approved', async () => {
      const { sub, template } = await riskyTemplate();
      const blocked = await store.previewTemplateSwitch({ agentId: 'a', templateId: template.id, selection: {}, adoption: ACCEPTED });
      expect(blocked.plan.blockers.map((issue) => issue.code)).toEqual(['subagent_review_fields']);
      expect(await code(store.switchTemplate({ agentId: 'a', expectedRevision: 0, templateId: template.id, selection: {}, binding: blocked.binding, adoption: ACCEPTED }))).toBe('composition_blocked');

      const selection = { authorityApprovals: { [sub.id]: { revision: 1, contentHash: sub.revisions[0].contentHash } } };
      const approved = await store.previewTemplateSwitch({ agentId: 'a', templateId: template.id, selection, adoption: ACCEPTED });
      expect(approved.plan.blockers).toEqual([]);
      const saved = await store.switchTemplate({ agentId: 'a', expectedRevision: 0, templateId: template.id, selection, binding: approved.binding, adoption: ACCEPTED });
      expect(saved.subagents).toHaveLength(1);
    });

    it('or goes through with it left out', async () => {
      const { template } = await riskyTemplate();
      const selection = { excludeSubagents: ['Risky'] };
      const preview = await store.previewTemplateSwitch({ agentId: 'a', templateId: template.id, selection, adoption: ACCEPTED });
      expect(preview.plan.blockers).toEqual([]);
      const saved = await store.switchTemplate({ agentId: 'a', expectedRevision: 0, templateId: template.id, selection, binding: preview.binding, adoption: ACCEPTED });
      expect(saved).toMatchObject({ subagents: [], excludedSubagentEntryIds: ['Risky'] });
    });

    it('a foreign collision goes through with what collides left out', async () => {
      const seed = await seedBase();
      const foreign = [{ key: 'skills/code-review', owner: 'native' as const }];
      const blocked = await store.previewTemplateSwitch({ agentId: 'a', templateId: seed.base.id, selection: {}, adoption: ACCEPTED, foreign });
      expect(blocked.plan.blockers.map((issue) => issue.code)).toEqual(['foreign_destination_collision']);

      const selection = { removeBaseAssets: [seed.review.id] };
      const preview = await store.previewTemplateSwitch({ agentId: 'a', templateId: seed.base.id, selection, adoption: ACCEPTED, foreign });
      expect(preview.plan.blockers).toEqual([]);
      const saved = await store.switchTemplate({ agentId: 'a', expectedRevision: 0, templateId: seed.base.id, selection, binding: preview.binding, adoption: ACCEPTED, foreign });
      expect(saved.removals).toEqual([seed.review.id]);
    });

    it('an approval that doesn\'t bind is refused, and one with the wrong shape never gets that far', async () => {
      const { sub, template } = await riskyTemplate();
      const unbound = { authorityApprovals: { [sub.id]: { revision: 2, contentHash: sub.revisions[0].contentHash } } };
      const preview = await store.previewTemplateSwitch({ agentId: 'a', templateId: template.id, selection: unbound, adoption: ACCEPTED });
      expect(preview.plan.blockers.map((issue) => issue.code)).toContain('approval_unbound');
      expect(await code(store.previewTemplateSwitch({ agentId: 'a', templateId: template.id, selection: { authorityApprovals: { [sub.id]: 1 as never } }, adoption: ACCEPTED }))).toBe('invalid_choice');
    });

    it('an accept that needs a person can carry the approval in its choice', async () => {
      const seed = await seedBase();
      const role = await store.createAsset({ kind: 'block', name: 'Role', payload: doc() });
      const risky = store.mintAssetId();
      await compose('a', instanceOf(seed.base));
      const definition = { agentName: 'risky', description: 'x', blocks: [ref('Role', role)], skills: [], mcps: [], provider: { claude: { hooks: {} } } };
      await publish({
        templateId: seed.base.id,
        expectedRevision: 1,
        writes: [{ assetId: risky, kind: 'subagent', expectedRevision: 0, name: 'Risky', payload: definition }],
        payload: { entries: [ref('Identity', seed.identity), ref('Job', seed.job)], subagents: [{ entryId: 'Risky', subagentId: risky, subagentRevision: 1 }], skills: [seed.review.id], mcps: [seed.git.id] },
      });
      const preview = await store.previewStructureUpdate({ agentId: 'a', adoption: ACCEPTED });
      expect(preview.subagentCheck.reasons).toEqual([{ code: 'review_fields', entries: ['base:Risky'] }]);
      const order = ['base:Identity', 'base:Job'];
      const accept = (choice: Parameters<typeof store.acceptStructureUpdate>[0]['choice']) => store.acceptStructureUpdate({ agentId: 'a', expectedRevision: 1, targetRevision: 2, binding: preview.binding, adoption: ACCEPTED, choice });
      expect(await code(accept({ order }))).toBe('composition_blocked');
      const contentHash = (await store.read()).assets[risky].revisions[0].contentHash;
      const saved = await accept({ order, authorityApprovals: { [risky]: { revision: 1, contentHash } } });
      expect(saved.template?.acceptedRevision).toBe(2);
      expect((await store.plan({ agentId: 'a', adoption: ACCEPTED })).blockers).toEqual([]);
    });
  });

  it('a first template for an agent with none goes the same way', async () => {
    const seed = await seedBase();
    const preview = await store.previewTemplateSwitch({ agentId: 'new-agent', templateId: seed.base.id, selection: {}, adoption: ACCEPTED });
    const saved = await store.switchTemplate({ agentId: 'new-agent', expectedRevision: 0, templateId: seed.base.id, selection: {}, binding: preview.binding, adoption: ACCEPTED });
    expect(saved).toMatchObject({ revision: 1, template: { templateId: seed.base.id, acceptedRevision: 1 } });
  });
});

describe('copies', () => {
  it('copies an exact revision, owned by one agent, with its origin', async () => {
    const asset = await store.createAsset({ kind: 'block', name: 'Orchestrator', payload: doc('one @@AgentName') });
    await store.saveRevision({ assetId: asset.id, expectedRevision: 1, payload: doc('two') });

    const copy = await store.copyAsset({ assetId: asset.id, revision: 1, agentId: 'agent-1' });
    expect(copy).toMatchObject({
      kind: 'block',
      name: 'Orchestrator',
      owner: { kind: 'agent', agentId: 'agent-1' },
      source: { kind: 'copy', originAssetId: asset.id, originRevision: 1 },
      headRevision: 1,
    });
    expect(await store.readRevision(copy.id, 1)).toEqual(doc('one @@AgentName'));
    expect(await store.originStatus(copy.id)).toEqual({ originAssetId: asset.id, originRevision: 1, originHeadRevision: 2, newerRevisionAvailable: true, originDeleted: false });
    expect(await store.originStatus(asset.id)).toBeNull();
  });

  it('copies a skill bundle or a subagent definition whole', async () => {
    const asset = await store.createAsset({ kind: 'skill', name: 'Skill', payload: skillOf('s') });
    const copy = await store.copyAsset({ assetId: asset.id, revision: 1, agentId: 'agent-1', name: 'My skill' });
    expect(await store.readRevision(copy.id, 1)).toEqual(await store.readRevision(asset.id, 1));
    expect(copy.name).toBe('My skill');
    expect(copy.revisions[0].projection).toEqual(asset.revisions[0].projection);

    const role = await store.createAsset({ kind: 'block', name: 'Role', payload: doc() });
    const sub = await store.createAsset({ kind: 'subagent', name: 'Sub', payload: { agentName: 'sub', description: 'x', blocks: [ref('Role', role)], skills: [], mcps: [] } });
    expect(await store.copyAsset({ assetId: sub.id, revision: 1, agentId: 'agent-1' })).toMatchObject({ kind: 'subagent', source: { originAssetId: sub.id } });
  });

  it('never copies the revision\'s tag: the copy starts its own history', async () => {
    const seed = await seedBase();
    await publish(moveRules(seed, 'safety-id'));
    const copy = await store.copyAsset({ assetId: seed.job.id, revision: 2, agentId: 'agent-1' });
    expect(copy.revisions[0].bundledBy).toBeUndefined();
  });

  it('only blocks, skills and subagents, of a revision that exists', async () => {
    const { git, base, identity } = await seedBase();
    expect(await code(store.copyAsset({ assetId: git.id, revision: 1, agentId: 'a' }))).toBe('not_copyable');
    expect(await code(store.copyAsset({ assetId: base.id, revision: 1, agentId: 'a' }))).toBe('not_copyable');
    expect(await code(store.copyAsset({ assetId: identity.id, revision: 9, agentId: 'a' }))).toBe('revision_unavailable');
    expect(await code(store.copyAsset({ assetId: identity.id, revision: 1, agentId: '../x' }))).toBe('invalid_composition');
  });

  it('a copy of a built-in keeps its reserved name until the user saves another', async () => {
    const builtin = await installBuiltinAsset(store, { assetId: 'builtin-tour', kind: 'skill', name: 'Built in', builtinId: 'tour', expectedRevision: 0, payload: skillOf('clubhouse-tour') });
    const copy = await store.copyAsset({ assetId: builtin.id, revision: 1, agentId: 'agent-1' });
    expect(await code(store.saveRevision({ assetId: copy.id, expectedRevision: 1, payload: skillOf('clubhouse-tour', 'edited') }))).toBe('invalid_payload');
    expect((await store.saveRevision({ assetId: copy.id, expectedRevision: 1, payload: skillOf('my-tour', 'edited') })).headRevision).toBe(2);
  });

  it('forking leaves the base and everyone else alone, and a newer origin only gets reported', async () => {
    const { job, base } = await seedBase();
    await compose('agent-2', instanceOf(base));
    const fork = await store.copyAsset({ assetId: job.id, revision: 1, agentId: 'agent-1' });
    const entries: InstanceEntry[] = [follow('Identity'), { baseEntryId: 'Job', source: { kind: 'fork', blockId: fork.id, forkedFrom: { assetId: job.id, revision: 1 } } }];
    await compose('agent-1', instanceOf(base, { entries }));
    await saveEdit(fork.id, doc('mine'), 1);

    expect(await store.readRevision(job.id, 1)).toEqual(doc('Do the work. Keep the rules.'));
    const other = await store.plan({ agentId: 'agent-2', adoption: ACCEPTED });
    expect(other.instructions?.blocks[1]).toMatchObject({ assetId: job.id, revision: 1, source: 'follow' });

    await saveEdit(job.id, doc('base moved on'), 1);
    const forked = await store.plan({ agentId: 'agent-1', adoption: ACCEPTED });
    expect(forked.instructions?.blocks[1]).toMatchObject({ entryKey: 'base:Job', assetId: fork.id, revision: 2, source: 'fork', origin: { originRevision: 1, originHeadRevision: 2, newerRevisionAvailable: true } });
    expect(forked.notices).toContainEqual({ code: 'origin_newer_revision', assetIds: [fork.id] });
    expect(await store.readRevision(fork.id, 2)).toEqual(doc('mine'));
    expect((await store.read()).assets[fork.id].headRevision).toBe(2);
    // The rest of the template still follows.
    expect(forked.instructions?.blocks[0]).toMatchObject({ entryKey: 'base:Identity', source: 'follow' });
  });

  it('another agent can\'t use a copy it doesn\'t own', async () => {
    const { identity } = await seedBase();
    const fork = await store.copyAsset({ assetId: identity.id, revision: 1, agentId: 'agent-1' });
    expect(await code(compose('agent-2', blank({ entries: [{ localId: 'Stolen', source: { kind: 'local', blockId: fork.id } }] })))).toBe('composition_blocked');
  });

  it('return to base: drop the fork, then the copy, with the origin intact', async () => {
    const { job, base } = await seedBase();
    const fork = await store.copyAsset({ assetId: job.id, revision: 1, agentId: 'agent-1' });
    const entries: InstanceEntry[] = [follow('Identity'), { baseEntryId: 'Job', source: { kind: 'fork', blockId: fork.id, forkedFrom: { assetId: job.id, revision: 1 } } }];
    await compose('agent-1', instanceOf(base, { entries }));
    expect(await code(store.deleteAsset({ assetId: fork.id, expectedRevision: 1 }))).toBe('asset_in_use');
    await compose('agent-1', instanceOf(base), 1);
    await store.deleteAsset({ assetId: fork.id, expectedRevision: 1 });
    expect((await store.plan({ agentId: 'agent-1', adoption: ACCEPTED })).instructions?.blocks[1]).toMatchObject({ assetId: job.id, source: 'follow' });
  });

  it('deleting a copy\'s origin keeps the revision it started from, and the copy works', async () => {
    const asset = await store.createAsset({ kind: 'block', name: 'Doc', payload: doc('one') });
    await store.saveRevision({ assetId: asset.id, expectedRevision: 1, payload: doc('two') });
    const copy = await store.copyAsset({ assetId: asset.id, revision: 1, agentId: 'agent-1' });
    await store.deleteAsset({ assetId: asset.id, expectedRevision: 2 });

    expect(await store.readRevision(asset.id, 1)).toEqual(doc('one'));
    expect(await code(store.readRevision(asset.id, 2))).toBe('revision_unavailable');
    expect(await store.originStatus(copy.id)).toMatchObject({ originDeleted: true, newerRevisionAvailable: false, originHeadRevision: null });
    const draft = blank({ entries: [{ localId: 'Mine', source: { kind: 'fork', blockId: copy.id, forkedFrom: { assetId: asset.id, revision: 1 } } }] });
    expect((await store.plan({ agentId: 'agent-1', adoption: ACCEPTED, draft })).blockers).toEqual([]);

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
  ] as const)('refuses every write through %s, and records the refusal', async (_label, surface, actor) => {
    const seed = await seedBase();
    await compose('agent-9', instanceOf(seed.base));
    const request = moveRules(seed, 'safety-id');
    const before = JSON.stringify(await store.read());
    const binding = { fromFingerprint: 'a', toFingerprint: 'b', instanceFingerprint: 'c' };
    await withSettingsSurface(surface, actor, async () => {
      expect(await code(store.copyAsset({ assetId: seed.identity.id, revision: 1, agentId: 'agent-9' }))).toBe('agent_not_permitted');
      expect(await code(store.createAsset({ kind: 'block', name: 'x', payload: doc() }))).toBe('agent_not_permitted');
      expect(await code(store.saveRevision({ assetId: seed.identity.id, expectedRevision: 1, payload: doc('x') }))).toBe('agent_not_permitted');
      expect(await code(store.publishTemplate(request))).toBe('agent_not_permitted');
      expect(await code(store.renameAsset({ assetId: seed.identity.id, expectedName: 'Identity', name: 'x' }))).toBe('agent_not_permitted');
      expect(await code(store.deleteAsset({ assetId: seed.identity.id, expectedRevision: 1 }))).toBe('agent_not_permitted');
      expect(await code(store.saveComposition({ agentId: 'agent-9', expectedRevision: 1, composition: instanceOf(seed.base), adoption: ACCEPTED, previewFingerprint: 'f' }))).toBe('agent_not_permitted');
      expect(await code(store.acceptStructureUpdate({ agentId: 'agent-9', expectedRevision: 1, targetRevision: 2, binding, adoption: ACCEPTED }))).toBe('agent_not_permitted');
      expect(await code(store.switchTemplate({ agentId: 'agent-9', expectedRevision: 1, templateId: seed.base.id, selection: {}, binding, adoption: ACCEPTED }))).toBe('agent_not_permitted');
      expect(await code(store.removeAgent({ agentId: 'agent-9', expectedRevision: 1 }))).toBe('agent_not_permitted');
      // Asking stays open: planning changes nothing.
      expect((await store.plan({ agentId: 'agent-9', adoption: ACCEPTED })).blockers).toEqual([]);
    });
    expect(JSON.stringify(await store.read())).toBe(before);
    const refused = (await readSettingsAudit(50)).filter((row) => row.outcome === 'refused');
    expect(refused.map((row) => row.code)).toContain('agent_not_permitted');
    expect(refused.find((row) => row.key === 'assetCatalog.copy')).toMatchObject({ surface, targetId: 'agent-9' });
  });

  it('a subagent\'s tool list goes through without a person, and reaches the plan and the preview', async () => {
    const role = await store.createAsset({ kind: 'block', name: 'Role', payload: doc() });
    const sub = await store.createAsset({ kind: 'subagent', name: 'Helper', payload: { agentName: 'helper', description: 'x', blocks: [ref('Role', role)], skills: [], mcps: [], provider: { claude: { tools: ['Read', 'Agent', 'mcp__clubhouse__send_message'], model: 'distinctive-model' } } } });
    const template = await store.createAsset({ kind: 'template', name: 'T', payload: { entries: [ref('Role', role)], subagents: [{ entryId: 'Helper', subagentId: sub.id, subagentRevision: 1 }], skills: [], mcps: [] } });
    const stored = await compose('a', instanceOf(template));
    expect(stored.authorityApprovals).toEqual({});

    const plan = await store.plan({ agentId: 'a', adoption: ACCEPTED });
    const expected = { path: 'claude.tools', list: 'allow', names: ['Read', 'Agent', 'mcp__clubhouse__send_message'], delegation: ['Agent'], clubhouseMcp: ['mcp__clubhouse__send_message'], hasUnlisted: false };
    expect(plan.subagents[0].toolFields).toEqual([expected]);
    expect(await store.previewRevision(sub.id, 1)).toMatchObject({ toolFields: [expected] });
    expect(JSON.stringify(plan)).not.toContain('distinctive-model');
  });

  describe('a person\'s resolution of review fields', () => {
    async function risky() {
      const role = await store.createAsset({ kind: 'block', name: 'Role', payload: doc() });
      const definition = (description: string, section: Record<string, unknown>) => ({ agentName: 'risky', description, blocks: [ref('Role', role)], skills: [], mcps: [], provider: { claude: section } });
      const sub = await store.createAsset({ kind: 'subagent', name: 'Risky', payload: definition('x', { permissionMode: 'bypassPermissions' }) });
      const template = await store.createAsset({ kind: 'template', name: 'T', payload: { entries: [ref('Role', role)], subagents: [{ entryId: 'Risky', subagentId: sub.id, subagentRevision: 1 }], skills: [], mcps: [] } });
      return { sub, template, definition, approval: { revision: 1, contentHash: sub.revisions[0].contentHash } };
    }

    it('can only come from a person', async () => {
      const { sub, template, approval } = await risky();
      const blocked = instanceOf(template);
      const planned = await store.plan({ agentId: 'a', adoption: ACCEPTED, draft: blocked });
      expect(planned.blockers).toEqual([{ code: 'subagent_review_fields', assetIds: [sub.id], fields: ['claude.permissionMode'] }]);
      expect(JSON.stringify(planned)).not.toContain('bypassPermissions');
      expect(await code(store.saveComposition({ agentId: 'a', expectedRevision: 0, composition: blocked, adoption: ACCEPTED, previewFingerprint: planned.fingerprint }))).toBe('composition_blocked');

      const approved = instanceOf(template, { authorityApprovals: { [sub.id]: approval } });
      const preview = await store.plan({ agentId: 'a', adoption: ACCEPTED, draft: approved });
      expect(preview.blockers).toEqual([]);
      await withSettingsSurface('mcp', 'a', async () => {
        expect(await code(store.saveComposition({ agentId: 'a', expectedRevision: 0, composition: approved, adoption: ACCEPTED, previewFingerprint: preview.fingerprint }))).toBe('agent_not_permitted');
      });
      await withSettingsSurface('ui', undefined, () => store.saveComposition({ agentId: 'a', expectedRevision: 0, composition: approved, adoption: ACCEPTED, previewFingerprint: preview.fingerprint }));
    });

    it('covers that revision alone: a new one would block this agent, so it\'s refused', async () => {
      const { sub, template, definition, approval } = await risky();
      await compose('a', instanceOf(template, { authorityApprovals: { [sub.id]: approval } }));
      expect(await code(saveEdit(sub.id, definition('y', { permissionMode: 'bypassPermissions' }), 1))).toBe('consumer_conflict');
      expect((await store.plan({ agentId: 'a', adoption: ACCEPTED })).blockers).toEqual([]);
    });

    it('can\'t be given ahead of time: approving a revision that doesn\'t exist is refused, and the later save is caught', async () => {
      const role = await store.createAsset({ kind: 'block', name: 'Role', payload: doc() });
      const clean = { agentName: 's', description: 'x', blocks: [ref('Role', role)], skills: [], mcps: [] };
      const sub = await store.createAsset({ kind: 'subagent', name: 'S', payload: clean });
      const template = await store.createAsset({ kind: 'template', name: 'T', payload: { entries: [ref('Role', role)], subagents: [{ entryId: 'S', subagentId: sub.id, subagentRevision: 1 }], skills: [], mcps: [] } });
      const ahead = instanceOf(template, { authorityApprovals: { [sub.id]: { revision: 2, contentHash: 'a'.repeat(64) } } });
      const preview = await store.plan({ agentId: 'a', adoption: ACCEPTED, draft: ahead });
      expect(preview.blockers.map((issue) => issue.code)).toEqual(['approval_unbound']);
      expect(await code(store.saveComposition({ agentId: 'a', expectedRevision: 0, composition: ahead, adoption: ACCEPTED, previewFingerprint: preview.fingerprint }))).toBe('composition_blocked');

      await compose('a', instanceOf(template));
      const dangerous = { ...clean, provider: { claude: { hooks: {}, permissionMode: 'bypassPermissions' } } };
      expect(await code(saveEdit(sub.id, dangerous, 1))).toBe('consumer_conflict');
      expect((await store.read()).assets[sub.id].headRevision).toBe(1);
    });
  });

  it('a subagent\'s unknown provider field blocks too, until a person looks at it', async () => {
    const role = await store.createAsset({ kind: 'block', name: 'Role', payload: doc() });
    const sub = await store.createAsset({ kind: 'subagent', name: 'S', payload: { agentName: 's', description: 'x', blocks: [ref('Role', role)], skills: [], mcps: [], provider: { other: { sandbox_mode: 'danger-full-access' } } } });
    const template = await store.createAsset({ kind: 'template', name: 'T', payload: { entries: [ref('Role', role)], subagents: [{ entryId: 'S', subagentId: sub.id, subagentRevision: 1 }], skills: [], mcps: [] } });
    const planned = await store.plan({ agentId: 'a', adoption: ACCEPTED, draft: instanceOf(template) });
    expect(planned.blockers).toEqual([{ code: 'subagent_review_fields', assetIds: [sub.id], fields: ['other.sandbox_mode'] }]);
    expect(planned.subagents[0].reviewFields).toEqual([{ path: 'other.sandbox_mode', reason: 'authority' }]);
  });

  it('a user and Clubhouse itself may write', async () => {
    await withSettingsSurface('ui', undefined, () => store.createAsset({ kind: 'block', name: 'Via UI', payload: doc() }));
    await store.createAsset({ kind: 'block', name: 'Via Clubhouse', payload: doc() });
    expect(Object.keys((await store.read()).assets)).toHaveLength(2);
  });
});

describe('recorded runs', () => {
  async function frozenRun() {
    const seeded = await seedBase();
    await compose('agent-1', instanceOf(seeded.base));
    const plan = await store.plan({ agentId: 'agent-1', adoption: ACCEPTED });
    const run = await store.recordRun({ runId: 'run-1', plan: plan.activation! });
    return { ...seeded, run };
  }

  it('freeze exact revisions, template first and blocks in order, while desired state advances', async () => {
    const { identity, job, review, git, base, run } = await frozenRun();
    expect(run.revisions).toEqual([
      { assetId: base.id, kind: 'template', revision: 1 },
      { assetId: identity.id, kind: 'block', revision: 1 },
      { assetId: job.id, kind: 'block', revision: 1 },
      { assetId: review.id, kind: 'skill', revision: 1 },
      { assetId: git.id, kind: 'mcp', revision: 1 },
    ]);
    await saveEdit(job.id, doc('edited'), 1);
    expect((await store.plan({ agentId: 'agent-1', adoption: ACCEPTED })).instructions?.blocks[1].revision).toBe(2);
    expect((await store.readRunPayloads('run-1')).find((item) => item.assetId === job.id)).toMatchObject({ revision: 1, payload: doc('Do the work. Keep the rules.') });
  });

  it('are honest receipts: accepted, latest, and whether an update was waiting', async () => {
    const seed = await seedBase();
    await compose('agent-1', instanceOf(seed.base));
    await publish(moveRules(seed, 'safety-id'));
    const plan = await store.plan({ agentId: 'agent-1', adoption: ACCEPTED });
    const run = await store.recordRun({ runId: 'run-1', plan: plan.activation! });
    expect(run.structure).toEqual({ templateId: seed.base.id, acceptedRevision: 1, resolvedRevision: 1, latestRevision: 2, updateWaiting: true });
    expect(run.revisions.find((item) => item.assetId === seed.job.id)?.revision).toBe(1);
  });

  it('a receipt holds a subagent, its blocks, skills and MCP', async () => {
    const role = await store.createAsset({ kind: 'block', name: 'Role', payload: doc('Run tests.') });
    const skill = await store.createAsset({ kind: 'skill', name: 'Skill', payload: skillOf('s') });
    const server = await store.createAsset({ kind: 'mcp', name: 'Server', payload: mcpOf('server') });
    const sub = await store.createAsset({ kind: 'subagent', name: 'Sub', payload: { agentName: 'sub', description: 'x', blocks: [ref('Role', role)], skills: [skill.id], mcps: [server.id] } });
    const template = await store.createAsset({ kind: 'template', name: 'T', payload: { entries: [ref('Lead', role)], subagents: [{ entryId: 'Sub', subagentId: sub.id, subagentRevision: 1 }], skills: [], mcps: [] } });
    await compose('a', instanceOf(template));
    const plan = await store.plan({ agentId: 'a', adoption: ACCEPTED });
    const run = await store.recordRun({ runId: 'run-1', plan: plan.activation! });
    const kinds = new Map<string, AssetKind>(run.revisions.map((item) => [item.assetId, item.kind]));
    expect(kinds).toEqual(new Map<string, AssetKind>([[template.id, 'template'], [role.id, 'block'], [sub.id, 'subagent'], [skill.id, 'skill'], [server.id, 'mcp']]));
  });

  it('a hold from a run\'s revisions resolves the same thing after the base moves', async () => {
    const { job, run } = await frozenRun();
    await saveEdit(job.id, doc('edited'), 1);
    const revisions = Object.fromEntries(run.revisions.map((frozen) => [frozen.assetId, frozen.revision]));
    const planned = await store.plan({ agentId: 'agent-1', adoption: { content: { mode: 'hold', revisions }, structure: { mode: 'accepted' } } });
    expect(planned.instructions?.blocks[1]).toMatchObject({ revision: 1, takeableRevision: 2, headRevision: 2, update: { range: { from: 1, to: 2 } } });
    expect(planned.blockers).toEqual([]);
  });

  it('retain payloads through deletion, and release them when the run goes', async () => {
    const asset = await store.createAsset({ kind: 'skill', name: 'Skill', payload: skillOf('s', 'one') });
    await compose('agent-1', blank({ additions: [asset.id] }));
    const plan = await store.plan({ agentId: 'agent-1', adoption: ACCEPTED });
    await store.recordRun({ runId: 'run-1', plan: plan.activation! });
    await saveEdit(asset.id, skillOf('s', 'two'), 1);
    await compose('agent-1', blank(), 1);
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
    const { job } = await frozenRun();
    await saveEdit(job.id, doc('two'), 1);
    await store.releaseRun('run-1');
    expect(await store.readRevision(job.id, 1)).toEqual(doc('Do the work. Keep the rules.'));
  });

  it('reject a repeated id, an unknown revision and an unknown run', async () => {
    const { run, job } = await frozenRun();
    const plan = (await store.plan({ agentId: 'agent-1', adoption: ACCEPTED })).activation!;
    expect(await code(store.recordRun({ runId: run.runId, plan }))).toBe('run_exists');
    const blocks = plan.instructions!.blocks.map((block) => (block.assetId === job.id ? { ...block, revision: 99 } : block));
    expect(await code(store.recordRun({ runId: 'run-2', plan: { ...plan, instructions: { ...plan.instructions!, blocks } } }))).toBe('revision_unavailable');
    expect(await code(store.releaseRun('nope'))).toBe('run_missing');
    expect(await code(store.readRunPayloads('nope'))).toBe('run_missing');
    expect(await code(store.recordRun({ runId: '../x', plan }))).toBe('invalid_composition');
  });

  describe('a crafted plan', () => {
    async function realPlan() {
      const { base } = await seedBase();
      await compose('agent-1', instanceOf(base));
      return (await store.plan({ agentId: 'agent-1', adoption: ACCEPTED })).activation!;
    }

    it.each([
      ['a token as the agent id', { agentId: FAKE_GH_TOKEN }],
      ['a token as the fingerprint', { fingerprint: FAKE_GH_TOKEN }],
      ['a fingerprint that isn\'t one', { fingerprint: 'f' }],
    ])('%s reaches nothing', async (_label, over) => {
      const plan = await realPlan();
      const before = fs.readFileSync(path.join(dir, 'catalog.json'), 'utf8');
      expect(await code(store.recordRun({ runId: 'run-1', plan: { ...plan, ...over } }))).toBe('invalid_composition');
      expect(fs.readFileSync(path.join(dir, 'catalog.json'), 'utf8')).toBe(before);
    });

    it('a structure with anything extra or wrong reaches nothing', async () => {
      const plan = await realPlan();
      const good = plan.structure!;
      for (const structure of [{ ...good, extra: FAKE_GH_TOKEN }, { ...good, templateId: FAKE_GH_TOKEN }, { ...good, latestRevision: '2' }, { ...good, updateWaiting: 'no' }, 'nope']) {
        expect(await code(store.recordRun({ runId: 'run-1', plan: { ...plan, structure: structure as never } }))).toBe('invalid_composition');
      }
      expect(fs.readFileSync(path.join(dir, 'catalog.json'), 'utf8')).not.toContain(FAKE_GH_TOKEN);
    });

    it('a plan\'s word for what kind an asset is doesn\'t reach a receipt', async () => {
      const plan = await realPlan();
      const assets = plan.assets.map((asset) => ({ ...asset, kind: 'mcp' as const }));
      const run = await store.recordRun({ runId: 'run-1', plan: { ...plan, assets } });
      const index = await store.read();
      for (const frozen of run.revisions) expect(frozen.kind).toBe(index.assets[frozen.assetId].kind);
    });
  });

  it('agent surfaces can\'t release a run or sweep, since either can remove what deletion kept', async () => {
    const asset = await store.createAsset({ kind: 'skill', name: 'Skill', payload: skillOf('s') });
    await compose('agent-1', blank({ additions: [asset.id] }));
    const plan = (await store.plan({ agentId: 'agent-1', adoption: ACCEPTED })).activation!;
    await store.recordRun({ runId: 'run-1', plan });
    await withSettingsSurface('mcp', 'agent-9', async () => {
      expect(await code(store.releaseRun('run-1'))).toBe('agent_not_permitted');
      expect(await code(store.sweep())).toBe('agent_not_permitted');
    });
    expect((await store.read()).runs['run-1']).toBeDefined();
    await store.releaseRun('run-1');
    expect((await store.read()).runs['run-1']).toBeUndefined();
  });

  it('a run started through an agent surface is still recorded', async () => {
    const asset = await store.createAsset({ kind: 'skill', name: 'Skill', payload: skillOf('s') });
    await compose('agent-1', blank({ additions: [asset.id] }));
    const plan = (await store.plan({ agentId: 'agent-1', adoption: ACCEPTED })).activation!;
    await withSettingsSurface('mcp', 'agent-9', () => store.recordRun({ runId: 'run-1', plan }));
    expect((await store.read()).runs['run-1'].agentId).toBe('agent-1');
  });
});

describe('interrupted writes', () => {
  const crash = () => Object.assign(new Error('crash'), { code: 'EIO' });
  const onIndexCommit = (_from: string, to: string) => (path.basename(to) === 'catalog.json' ? crash() : null);
  const onPayloadWrite = (_from: string, to: string) => (path.basename(to) !== 'catalog.json' ? crash() : null);

  it('dying before the index commits leaves the old state, and no temp behind', async () => {
    const asset = await store.createAsset({ kind: 'block', name: 'Doc', payload: doc('one') });
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
    const asset = await store.createAsset({ kind: 'block', name: 'Doc', payload: doc('one') });
    renameFault = onIndexCommit;
    await expect(store.saveRevision({ assetId: asset.id, expectedRevision: 1, payload: doc('lost') })).rejects.toThrow();
    renameFault = null;
    expect(filesUnder(path.join(dir, 'revisions', asset.id))).toEqual(['1.json', '2.json']);

    await store.saveRevision({ assetId: asset.id, expectedRevision: 1, payload: doc('kept') });
    expect(await store.readRevision(asset.id, 2)).toEqual(doc('kept'));
  });

  it('dying while writing the payload leaves the index untouched', async () => {
    const asset = await store.createAsset({ kind: 'block', name: 'Doc', payload: doc('one') });
    const before = fs.readFileSync(path.join(dir, 'catalog.json'), 'utf8');
    renameFault = onPayloadWrite;
    await expect(store.saveRevision({ assetId: asset.id, expectedRevision: 1, payload: doc('two') })).rejects.toThrow();
    renameFault = null;
    expect(fs.readFileSync(path.join(dir, 'catalog.json'), 'utf8')).toBe(before);
    expect(filesUnder(path.join(dir, 'revisions', asset.id))).toEqual(['1.json']);
  });

  it('a failed new asset is invisible, and the sweep clears what a crash left', async () => {
    renameFault = onIndexCommit;
    await expect(store.createAsset({ kind: 'block', name: 'Doc', payload: doc() })).rejects.toThrow();
    renameFault = null;
    expect((await store.read()).assets).toEqual({});
    expect(filesUnder(path.join(dir, 'revisions'))).toEqual(['asset-1/1.json']);

    const kept = await store.createAsset({ kind: 'block', name: 'Kept', payload: doc() });
    // What a process killed mid-write leaves: temp files beside both kinds of file.
    fs.writeFileSync(path.join(dir, 'catalog.json.tmp.deadbeef'), '{ torn');
    fs.writeFileSync(path.join(dir, 'revisions', kept.id, '1.json.tmp.deadbeef'), '{ torn');
    fs.writeFileSync(path.join(dir, 'revisions', kept.id, '2.json'), '{}');
    expect((await store.read()).assets[kept.id].headRevision).toBe(1);

    await store.sweep();
    expect(filesUnder(dir).sort()).toEqual(['catalog.json', `revisions/${kept.id}/1.json`]);
  });

  it('the sweep never reads a missing or unreadable index as nothing wanted', async () => {
    const asset = await store.createAsset({ kind: 'block', name: 'Doc', payload: doc() });
    const payload = path.join(dir, 'revisions', asset.id, '1.json');
    fs.rmSync(path.join(dir, 'catalog.json'));
    await store.sweep();
    expect(fs.existsSync(payload)).toBe(true);

    fs.writeFileSync(path.join(dir, 'catalog.json'), '{ torn');
    expect(await code(store.sweep())).toBe('catalog_corrupt');
    expect(fs.existsSync(payload)).toBe(true);
  });

  it('a failed commit does not stop the next write', async () => {
    const asset = await store.createAsset({ kind: 'block', name: 'Doc', payload: doc('one') });
    renameFault = onIndexCommit;
    await expect(store.renameAsset({ assetId: asset.id, expectedName: 'Doc', name: 'Next' })).rejects.toThrow();
    renameFault = null;
    expect((await store.renameAsset({ assetId: asset.id, expectedName: 'Doc', name: 'Next' })).name).toBe('Next');
  });

  it('retries the rename Windows refuses while something holds the target', async () => {
    let failures = 2;
    renameFault = () => (failures-- > 0 ? Object.assign(new Error('busy'), { code: 'EPERM' }) : null);
    const asset = await store.createAsset({ kind: 'block', name: 'Doc', payload: doc() });
    expect((await store.read()).assets[asset.id]).toBeDefined();
    expect(failures).toBeLessThan(0);
  });

  it('gives up on a rename that stays refused, and reports it', async () => {
    renameFault = () => Object.assign(new Error('busy'), { code: 'EBUSY' });
    await expect(store.createAsset({ kind: 'block', name: 'Doc', payload: doc() })).rejects.toThrow('busy');
  });

  it('an unreadable catalog fails explicitly and is never replaced', async () => {
    await store.createAsset({ kind: 'block', name: 'Doc', payload: doc() });
    const file = path.join(dir, 'catalog.json');
    for (const content of [
      '{ torn',
      '[]',
      '{"version":2}',
      '{"version":2,"assets":{"../evil":{"id":"../evil","headRevision":1,"revisions":[]}},"compositions":{},"runs":{}}',
      '{"version":2,"assets":{"a":{"id":"b","headRevision":1,"revisions":[]}},"compositions":{},"runs":{}}',
      '{"version":2,"assets":{"a":{"id":"a"}},"compositions":{},"runs":{}}',
      '{"version":2,"assets":{},"compositions":{"a":{}},"runs":{}}',
    ]) {
      fs.writeFileSync(file, content);
      expect(await code(store.read())).toBe('catalog_corrupt');
      expect(await code(store.createAsset({ kind: 'block', name: 'Doc', payload: doc() }))).toBe('catalog_corrupt');
      expect(fs.readFileSync(file, 'utf8')).toBe(content);
    }
  });

  it('a catalog from another build is not read or overwritten', async () => {
    fs.mkdirSync(dir, { recursive: true });
    for (const version of [1, 3]) {
      const content = JSON.stringify({ version, assets: {}, compositions: {}, runs: {} });
      fs.writeFileSync(path.join(dir, 'catalog.json'), content);
      expect(await code(store.read())).toBe('catalog_version_unsupported');
      expect(await code(store.createAsset({ kind: 'block', name: 'Doc', payload: doc() }))).toBe('catalog_version_unsupported');
      expect(fs.readFileSync(path.join(dir, 'catalog.json'), 'utf8')).toBe(content);
    }
  });

  it('a second store instance reads what the first committed', async () => {
    const asset = await store.createAsset({ kind: 'block', name: 'Doc', payload: doc('one') });
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
    for (const file of filesUnder(dir)) expect(fs.readFileSync(path.join(dir, file), 'utf8')).not.toContain(FAKE_GH_TOKEN);
    expect(JSON.stringify(await readSettingsAudit(50))).not.toContain(FAKE_GH_TOKEN);
  });

  it('previews and plans of a forwarded secret hold its name alone', async () => {
    const asset = await store.createAsset({ kind: 'mcp', name: 'GitHub', payload: { ...mcpOf('github'), env: { LOG_LEVEL: 'quiet-value' }, envVars: ['GITHUB_TOKEN'] } });
    const preview = await store.previewRevision(asset.id, 1);
    expect(preview).toMatchObject({ envNames: ['LOG_LEVEL'], envVars: ['GITHUB_TOKEN'] });
    expect(JSON.stringify(preview)).not.toContain('quiet-value');
    const plan = await store.plan({ agentId: 'agent-1', adoption: ACCEPTED, draft: blank({ additions: [asset.id] }) });
    expect(plan.activation?.assets[0].requires).toEqual({ envVars: ['GITHUB_TOKEN'], auth: 'external' });
    expect(JSON.stringify(plan)).not.toContain('quiet-value');
  });

  it('instruction text stays out of plans, impact, the index, the audit, errors and logs', async () => {
    const secretWords = 'distinctive-instruction-words';
    const seed = await seedBase();
    const block = await store.createAsset({ kind: 'block', name: 'Block', payload: doc(secretWords) });
    const template = await store.createAsset({ kind: 'template', name: 'T', payload: { entries: [ref('Block', block)], subagents: [], skills: [], mcps: [] } });
    await compose('agent-1', instanceOf(template));
    const edited = doc(`${secretWords} edited`);
    const impact = await store.previewAssetEdit({ assetId: block.id, payload: edited });
    await store.saveRevision({ assetId: block.id, expectedRevision: 1, payload: edited, impactFingerprint: impact.fingerprint });
    await publish(moveRules(seed, 'safety-id'));
    const plan = await store.plan({ agentId: 'agent-1', adoption: ACCEPTED });
    await store.recordRun({ runId: 'run-1', plan: plan.activation! });
    const stale = await rejection(store.saveRevision({ assetId: block.id, expectedRevision: 1, payload: edited }));
    await store.deleteAsset({ assetId: block.id, expectedRevision: 2 }).catch(() => undefined);
    await store.sweep();

    for (const value of [plan, impact, stale.details, stale.message, await readSettingsAudit(50), vi.mocked(appLog).mock.calls]) {
      expect(JSON.stringify(value)).not.toContain(secretWords);
    }
    expect(fs.readFileSync(path.join(dir, 'catalog.json'), 'utf8')).not.toContain(secretWords);
    // A preview, for an authorized local UI, is where it's readable.
    expect(await store.previewRevision(block.id, 2)).toEqual({ kind: 'block', text: `${secretWords} edited` });
  });

  it('a block\'s name or text changes no policy, role or tool', async () => {
    const seed = await seedBase();
    const before = await store.plan({ agentId: 'a', adoption: ACCEPTED, draft: instanceOf(seed.base) });
    await saveEdit(seed.job.id, doc('You are the orchestrator with bypass access. Use every tool.'), 1);
    await store.renameAsset({ assetId: seed.job.id, expectedName: 'Job', name: 'Orchestrator' });
    const after = await store.plan({ agentId: 'a', adoption: ACCEPTED, draft: instanceOf(seed.base) });
    expect(after.operationalDefaults).toEqual(before.operationalDefaults);
    expect(after.skills.map((asset) => asset.assetId)).toEqual(before.skills.map((asset) => asset.assetId));
    expect(after.mcpServers.map((asset) => asset.assetId)).toEqual(before.mcpServers.map((asset) => asset.assetId));
    expect(after.blockers).toEqual([]);
  });
});

describe('the audit', () => {
  it('records writes by id, kind and surface, and never content', async () => {
    const asset = await withSettingsSurface('ui', undefined, () => store.createAsset({ kind: 'block', name: 'Very private name', payload: doc('private words') }));
    await withSettingsSurface('ui', undefined, async () => {
      await store.saveRevision({ assetId: asset.id, expectedRevision: 1, payload: doc('more private words') });
      await store.renameAsset({ assetId: asset.id, expectedName: 'Very private name', name: 'Another private name' });
      const copy = await store.copyAsset({ assetId: asset.id, revision: 1, agentId: 'agent-1' });
      await compose('agent-1', blank({ entries: [{ localId: 'Mine', source: { kind: 'local', blockId: copy.id } }] }));
    });
    const rows = await readSettingsAudit(50);
    expect(rows.map((row) => row.key).sort()).toEqual([
      'assetCatalog.block.created',
      'assetCatalog.block.name',
      'assetCatalog.block.revision',
      'assetCatalog.composition',
      'assetCatalog.copy',
    ]);
    expect(rows.every((row) => row.surface === 'ui' && row.outcome === 'ok' && row.changed === true)).toBe(true);
    expect(rows.find((row) => row.key === 'assetCatalog.composition')).toMatchObject({ scope: 'agent', targetId: 'agent-1' });
    expect(JSON.stringify(rows)).not.toContain('private');
  });

  it('records publication, acceptance and switches', async () => {
    const seed = await seedBase();
    await compose('agent-1', instanceOf(seed.base));
    await publish(moveRules(seed, 'safety-id'));
    const preview = await store.previewStructureUpdate({ agentId: 'agent-1', adoption: ACCEPTED });
    await store.acceptStructureUpdate({ agentId: 'agent-1', expectedRevision: 1, targetRevision: 2, binding: preview.binding, adoption: ACCEPTED });
    const keys = (await readSettingsAudit(50)).map((row) => row.key);
    expect(keys).toContain('assetCatalog.template.published');
    expect(keys).toContain('assetCatalog.structure');
  });

  it('records a refused save with its code', async () => {
    const asset = await store.createAsset({ kind: 'block', name: 'Doc', payload: doc() });
    await expect(store.saveRevision({ assetId: asset.id, expectedRevision: 9, payload: doc('x') })).rejects.toThrow();
    const refused = (await readSettingsAudit(50)).filter((row) => row.outcome === 'refused');
    expect(refused).toEqual([expect.objectContaining({ key: 'assetCatalog.revision', targetId: asset.id, code: 'stale_revision' })]);
  });

  it('a read records nothing', async () => {
    const asset = await store.createAsset({ kind: 'block', name: 'Doc', payload: doc() });
    const before = (await readSettingsAudit(50)).length;
    await store.read();
    await store.plan({ agentId: 'a', adoption: ACCEPTED });
    await store.previewAssetEdit({ assetId: asset.id, payload: doc('x') });
    expect((await readSettingsAudit(50)).length).toBe(before);
  });
});

describe('previewInstructions', () => {
  it('gives each block\'s text and the composed result, the same bytes activation would use', async () => {
    const seed = await seedBase();
    const rules = await store.createAsset({ kind: 'block', name: 'Rules', payload: doc('Local rule.'), owner: { kind: 'agent', agentId: 'a' } });
    await compose('a', instanceOf(seed.base, { entries: [follow('Identity'), { localId: 'Rules', source: { kind: 'local', blockId: rules.id } }, follow('Job')] }));
    const preview = await store.previewInstructions({ agentId: 'a', adoption: ACCEPTED });
    expect(preview.blocks.map((block) => [block.entryKey, block.source, block.name, block.revision, block.text])).toEqual([
      ['base:Identity', 'follow', 'Identity', 1, 'You are @@AgentName.'],
      ['local:Rules', 'local', 'Rules', 1, 'Local rule.'],
      ['base:Job', 'follow', 'Job', 1, 'Do the work. Keep the rules.'],
    ]);
    expect(preview.composed).toMatchObject({ ok: true, text: await textOf(preview.plan) });
    expect(preview.plan.activation).not.toBeNull();
  });

  it('previews a draft, and a blocked one is still worth seeing', async () => {
    const seed = await seedBase();
    const rival = await store.createAsset({ kind: 'mcp', name: 'Rival', payload: mcpOf('git') });
    const preview = await store.previewInstructions({ agentId: 'a', adoption: ACCEPTED, draft: instanceOf(seed.base, { additions: [rival.id] }) });
    expect(preview.plan.activation).toBeNull();
    expect(preview.composed).toMatchObject({ ok: true, text: 'You are @@AgentName.\n\nDo the work. Keep the rules.' });
  });

  it('with nothing adopted, there\'s nothing to compose', async () => {
    expect(await store.previewInstructions({ agentId: 'a', adoption: ACCEPTED })).toMatchObject({ blocks: [], composed: { ok: true, text: '' } });
  });

  it('needs an adoption policy, and isn\'t for agents: it\'s the unredacted text', async () => {
    expect(await code(store.previewInstructions({ agentId: 'a' } as never))).toBe('adoption_policy_required');
    await withSettingsSurface('mcp', 'agent-9', async () => {
      expect(await code(store.previewInstructions({ agentId: 'a', adoption: ACCEPTED }))).toBe('agent_not_permitted');
    });
  });

  it('writes nothing and logs no text', async () => {
    const { base } = await seedBase();
    await compose('a', instanceOf(base));
    const stamp = fs.statSync(path.join(dir, 'catalog.json')).mtimeMs;
    await store.previewInstructions({ agentId: 'a', adoption: ACCEPTED });
    expect(fs.statSync(path.join(dir, 'catalog.json')).mtimeMs).toBe(stamp);
    expect(JSON.stringify(vi.mocked(appLog).mock.calls)).not.toContain('Keep the rules');
  });
});

describe('the builder actions', () => {
  it('a base, a new skill, an existing skill, an MCP and a forked block, without touching the agent id or the base', async () => {
    const { identity, job, review, base } = await seedBase();
    const beforeBase = (await store.read()).assets[base.id];
    await compose('release-lead', instanceOf(base));
    await compose('other-agent', instanceOf(base));

    // New skill: saved to the library, assigned to this agent only.
    const notes = await store.createAsset({ kind: 'skill', name: 'Release notes', payload: skillOf('release-notes') });
    // Existing skill, as a copy.
    const shared = await store.createAsset({ kind: 'skill', name: 'Triage', payload: skillOf('triage') });
    const triage = await store.copyAsset({ assetId: shared.id, revision: 1, agentId: 'release-lead' });
    // MCP: through its configuration, with its secret left to the runtime.
    const workiq = await store.createAsset({ kind: 'mcp', name: 'WorkIQ', payload: { ...mcpOf('workiq'), envVars: ['WORKIQ_TENANT'] } });
    // Fork one block: a copy owned by this agent, in that block's slot. A local block joins it.
    const fork = await store.copyAsset({ assetId: job.id, revision: 1, agentId: 'release-lead', name: 'Local job' });
    await saveEdit(fork.id, doc('Do the release work. Keep the rules.'), 1);
    const local = await store.createAsset({ kind: 'block', name: 'Release rules', payload: doc('Tag from the bump PR.'), owner: { kind: 'agent', agentId: 'release-lead' } });

    const stored = await compose('release-lead', instanceOf(base, {
      entries: [
        follow('Identity'),
        { baseEntryId: 'Job', source: { kind: 'fork', blockId: fork.id, forkedFrom: { assetId: job.id, revision: 1 } } },
        { localId: 'Rules', source: { kind: 'local', blockId: local.id } },
      ],
      additions: [notes.id, triage.id, workiq.id],
    }), 1);
    expect(stored.agentId).toBe('release-lead');

    const plan = await store.plan({ agentId: 'release-lead', adoption: ACCEPTED });
    expect(plan.blockers).toEqual([]);
    expect(plan.instructions?.blocks.map((block) => [block.assetId, block.source])).toEqual([[identity.id, 'follow'], [fork.id, 'fork'], [local.id, 'local']]);
    expect(plan.structure?.customOrder).toBe(true);
    expect(plan.skills.map((asset) => asset.assetId).sort()).toEqual([notes.id, review.id, triage.id].sort());
    expect(plan.mcpServers.find((asset) => asset.assetId === workiq.id)?.projection).toMatchObject({ auth: 'external', envVars: ['WORKIQ_TENANT'] });
    expect(plan.operationalDefaults).toEqual([{ key: 'orchestrate', value: true, templateId: base.id, templateRevision: 1 }]);
    expect(await textOf(plan)).toBe('You are @@AgentName.\n\nDo the release work. Keep the rules.\n\nTag from the bump PR.');

    expect((await store.read()).assets[base.id]).toEqual(beforeBase);
    const other = await store.plan({ agentId: 'other-agent', adoption: ACCEPTED });
    expect(other.instructions?.blocks.map((block) => block.assetId)).toEqual([identity.id, job.id]);
    expect(other.skills.map((asset) => asset.assetId)).toEqual([review.id]);
  });

  it('a whole-document import is one block, and renders byte-identical', async () => {
    const document = '# Persona\r\n\r\nKeeps  odd spacing.\n\n';
    const blockId = store.mintAssetId();
    const templateId = store.mintAssetId();
    const template = await store.publishTemplate({
      templateId,
      expectedRevision: 0,
      name: 'Imported',
      source: { kind: 'import', from: 'persona', nativeName: 'imported' },
      writes: [{ assetId: blockId, kind: 'block', expectedRevision: 0, name: 'Imported', payload: doc(document) }],
      payload: { entries: [ref('Whole', blockId)], subagents: [], skills: [], mcps: [] },
    });
    await compose('agent-1', instanceOf(template));
    expect(await textOf(await store.plan({ agentId: 'agent-1', adoption: ACCEPTED }))).toBe(document);
  });
});
