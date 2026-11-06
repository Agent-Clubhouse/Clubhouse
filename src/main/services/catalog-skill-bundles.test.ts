import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CatalogEntry, SkillAssetPayload } from '../../shared/asset-catalog-types';
import type { SkillBundleEditorBridge, SkillBundleResult } from '../../shared/skill-bundle-editor-types';

const state = vi.hoisted(() => ({ generation: 0, pending: false, config: 0, projects: [{ id: 'project-1', name: 'Synthetic', path: '/synthetic/project' }],
  agents: [{ id: 'agent-1', parentAgentId: undefined as string | undefined, disposedAt: undefined as string | undefined, creation: undefined as { state: string } | undefined }] }));
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => '/synthetic/home' } }));
vi.mock('./project-store', () => ({ peekProjects: async () => state.projects,
  projectRegistryMutationState: () => ({ generation: state.generation, pending: state.pending }) }));
vi.mock('./agent-config', () => ({ peekDurableConfigs: async () => state.agents, agentConfigGeneration: () => state.config }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
import { createCatalogSkillBundleEditor } from './catalog-skill-bundles';
import { createAssetCatalogStore, installBuiltinAsset, type AssetCatalogStore } from './asset-catalog/store';
import { withSettingsSurface, _resetSettingsAuditForTesting } from './settings-audit';

const context = { projectId: 'project-1' };
const initial: SkillAssetPayload = { skillName: 'bundle', files: [
  { path: 'SKILL.md', content: '# Bundle\nSee [guide](references/guide.md).' },
  { path: 'scripts/check.sh', content: 'printf synthetic', executable: true },
  { path: 'references/guide.md', content: '../assets/logo.bin', encoding: 'utf8', executable: false },
  { path: 'assets/logo.bin', content: 'AAH+/w==', encoding: 'base64', executable: true },
] };
const user = <T>(fn: () => T) => withSettingsSurface('ui', undefined, fn);
function value<T>(result: SkillBundleResult<T>): T { expect(result.ok).toBe(true); if (result.ok === false) throw new Error(result.code); return result.value; }
let root: string, dir: string, store: AssetCatalogStore, asset: CatalogEntry, editor: SkillBundleEditorBridge;
let savedInitial: SkillAssetPayload;
let beforeRename: ((to: string) => void) | undefined;
let failRename = false, clock = 0;
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-bundle-editor-')); dir = path.join(root, 'catalog');
  state.generation = 0; state.pending = false; state.config = 0;
  state.projects = [{ id: 'project-1', name: 'Synthetic', path: '/synthetic/project' }];
  state.agents = [{ id: 'agent-1', parentAgentId: undefined, disposedAt: undefined, creation: undefined }];
  beforeRename = undefined; failRename = false; clock = 0;
  _resetSettingsAuditForTesting(false);
  store = createAssetCatalogStore({ dir });
  asset = await user(() => store.createAsset({ kind: 'skill', name: 'Bundle', payload: initial }));
  savedInitial = await store.readRevision(asset.id, 1) as SkillAssetPayload;
  editor = createCatalogSkillBundleEditor({ now: () => clock, store: (guard) => createAssetCatalogStore({ dir,
    rename: async (from, to) => { beforeRename?.(to); guard(); if (failRename) throw new Error('synthetic'); fs.renameSync(from, to); },
  }) });
});
afterEach(() => { _resetSettingsAuditForTesting(false); fs.rmSync(root, { recursive: true, force: true }); });
async function preview(payload = { ...initial, files: initial.files.map((file) => file.path === 'SKILL.md' ? { ...file, content: 'edited' } : file) }) {
  return user(() => editor.preview({ context, assetId: asset.id, expectedRevision: 1, payload }));
}
async function save(token: string) { return user(() => editor.save({ context, assetId: asset.id, expectedRevision: 1, token })); }

it('edits one member, preserves complete binary/text/metadata, and reloads after a new service instance', async () => {
  const candidate = value(await preview());
  expect(candidate.blocked).toBe(false);
  const saved = value(await save(candidate.token));
  expect(saved.revision).toBe(2);
  expect(saved.payload.files.filter((file) => file.path !== 'SKILL.md')).toEqual(savedInitial.files.filter((file) => file.path !== 'SKILL.md'));
  const reopened = createCatalogSkillBundleEditor({ store: () => createAssetCatalogStore({ dir }) });
  expect(value(await user(() => reopened.read(context, asset.id)))).toEqual(saved);
  expect((await store.read()).compositions).toEqual({});
  expect((await store.read()).runs).toEqual({});
});
it('writes only catalog files while synthetic identity/session/worktree/wires stay exact', async () => {
  const protectedFiles = ['project/CLAUDE.md', 'worktree/.claude/settings.json', 'identity.json', 'sessions/run.json', 'wires.json'];
  for (const name of protectedFiles) { fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), `synthetic:${name}`); }
  const before = new Map(protectedFiles.map((name) => [name, fs.readFileSync(path.join(root, name))]));
  const candidate = value(await preview()); value(await save(candidate.token));
  for (const [name, bytes] of before) expect(fs.readFileSync(path.join(root, name))).toEqual(bytes);
  expect(fs.readdirSync(root).sort()).toEqual(['catalog', 'identity.json', 'project', 'sessions', 'wires.json', 'worktree']);
});
it.each(['system', 'mcp', 'cli', 'dispatcher', 'mobile'] as const)('refuses %s before context or payload access', async (surface) => {
  expect(await withSettingsSurface(surface, undefined, () => editor.read(context, asset.id))).toEqual({ ok: false, code: 'local_user_only' });
});
it('refuses an acting agent even on UI origin and rejects missing/remapped/pending contexts', async () => {
  expect(await withSettingsSurface('ui', 'agent-1', () => editor.list(context))).toEqual({ ok: false, code: 'local_user_only' });
  state.projects = []; expect(await user(() => editor.list(context))).toEqual({ ok: false, code: 'target_changed' });
  state.pending = true; expect(await user(() => editor.list(context))).toEqual({ ok: false, code: 'target_changed' });
});
it('keeps builtins readonly, restricts owner scope and refuses disposed/helpers', async () => {
  const builtin = await installBuiltinAsset(store, { assetId: 'builtin-skill', expectedRevision: 0, kind: 'skill', name: 'Built-in', builtinId: 'b', payload: initial });
  const other = await user(() => store.createAsset({ kind: 'skill', name: 'Other', payload: initial, owner: { kind: 'project', projectId: 'project-2' } }));
  expect(value(await user(() => editor.list(context))).map((entry) => entry.assetId)).toEqual([asset.id, builtin.id]);
  expect(await user(() => editor.read(context, other.id))).toEqual({ ok: false, code: 'not_found' });
  expect(value(await user(() => editor.read(context, builtin.id))).readOnly).toBe(true);
  expect(await user(() => editor.preview({ context, assetId: builtin.id, expectedRevision: 1, payload: initial }))).toEqual({ ok: false, code: 'read_only' });
  state.agents[0].parentAgentId = 'parent';
  expect(await user(() => editor.list({ ...context, agentId: 'agent-1' }))).toEqual({ ok: false, code: 'target_changed' });
  state.agents[0].parentAgentId = undefined; state.agents[0].disposedAt = 'synthetic';
  expect(await user(() => editor.list({ ...context, agentId: 'agent-1' }))).toEqual({ ok: false, code: 'target_changed' });
});
it('blocks shared template consumers with actual catalog impact and no save token', async () => {
  const block = await user(() => store.createAsset({ kind: 'block', name: 'Role', payload: { content: 'Role' } }));
  await user(() => store.createAsset({ kind: 'template', name: 'Template', payload: { entries: [{ entryId: 'Role', blockId: block.id, blockRevision: 1 }], subagents: [], skills: [asset.id], mcps: [] } }));
  const result = value(await preview());
  expect(result.blocked).toBe(true); expect(result.token).toBe(''); expect(result.impact.templates).toHaveLength(1);
  expect(await save('')).toEqual({ ok: false, code: 'stale_preview' });
  expect((await store.read()).assets[asset.id].headRevision).toBe(1);
});
it('retains exact preview bytes despite caller draft mutation; binds token to revision/target and one use', async () => {
  const payload = structuredClone(initial); payload.files[0].content = 'reviewed';
  const candidate = value(await preview(payload)); payload.files[0].content = 'unreviewed';
  const saved = value(await save(candidate.token));
  expect(saved.payload.files.find((file) => file.path === 'SKILL.md')!.content).toBe('reviewed');
  expect(await save(candidate.token)).toEqual({ ok: false, code: 'stale_preview' });
  expect(await preview()).toEqual({ ok: false, code: 'stale_revision' });
});
it('expires previews and refuses target change after preview or at final rename', async () => {
  const expired = value(await preview()); clock = 120_001;
  expect(await save(expired.token)).toEqual({ ok: false, code: 'stale_preview' });
  const changed = value(await preview()); state.generation++;
  expect(await save(changed.token)).toEqual({ ok: false, code: 'target_changed' });
  const pending = value(await preview());
  beforeRename = (to) => { if (to.endsWith('catalog.json')) state.pending = true; };
  expect(await save(pending.token)).toEqual({ ok: false, code: 'target_changed' });
  expect((await store.read()).assets[asset.id].headRevision).toBe(1);
});
it('fails atomic save without losing old revision or echoing raw errors', async () => {
  const candidate = value(await preview()); failRename = true;
  expect(await save(candidate.token)).toEqual({ ok: false, code: 'save_failed' });
  expect((await store.read()).assets[asset.id].headRevision).toBe(1);
  expect(await store.readRevision(asset.id, 1)).toEqual(savedInitial);
});
it.each([
  { ...initial, files: [...initial.files, { path: '../outside', content: 'x' }] },
  { ...initial, files: [...initial.files, { path: 'ASSETS/logo.bin', content: 'duplicate' }] },
  { ...initial, files: initial.files.filter((file) => file.path !== 'SKILL.md') },
  { ...initial, files: initial.files.map((file) => file.encoding === 'base64' ? { ...file, content: '**invalid**' } : file) },
])('uses catalog validation for entire bundle without partial saves', async (payload) => {
  expect(await preview(payload)).toEqual({ ok: false, code: 'invalid_payload' });
  expect((await store.read()).assets[asset.id].headRevision).toBe(1);
});

it.each(['creating', 'failed'])('refuses an agent with partial creation state %s', async (creation) => {
  state.agents[0].creation = { state: creation };
  expect(await user(() => editor.list({ ...context, agentId: 'agent-1' }))).toEqual({ ok: false, code: 'target_changed' });
});
