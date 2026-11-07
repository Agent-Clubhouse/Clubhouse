import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createAgentBuilder, builderSnapshotAdoption } from './builder';
import { seedBuilderTemplates, IDENTITY_TEXT } from './builder-seeds';
import { createAssetCatalogStore, installBuiltinAsset, type AssetCatalogStore } from './store';
import { composeInstructions } from './composer';
import { withSettingsSurface } from '../settings-audit';
import { getPersonaTemplate } from '../../../renderer/features/personas';
import { stripPersonaFrontMatter } from '../../../shared/persona-pattern';
import type { BuilderCommand } from '../../../shared/agent-builder-types';

vi.mock('../log-service', () => ({ appLog: vi.fn() }));
let root: string;
let store: AssetCatalogStore;
let builder: ReturnType<typeof createAgentBuilder>;
let failCommit = false;
const agentId = 'agent-builder-test';
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'builder-'));
  store = createAssetCatalogStore({ dir: path.join(root, 'catalog'), rename: async (from, to) => {
    if (failCommit && to.endsWith('catalog.json')) throw new Error('disk unavailable');
    await fs.promises.rename(from, to);
  } });
  builder = createAgentBuilder(store);
  failCommit = false;
  await seedBuilderTemplates(store);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const adoption = () => builder.compositionOf(agentId).then((c) => builderSnapshotAdoption(store, c));
const read = async () => builder.read(agentId, await adoption());
async function command(action: BuilderCommand, revision?: number) {
  return builder.command(agentId, revision ?? (await read()).revision, action, await adoption());
}
async function choose(id = 'orchestrator') {
  const templateId = `builtin-builder-${id}`;
  const preview = await command({ type: 'template', templateId, confirm: false });
  return command({ type: 'template', templateId, confirm: true, binding: preview.templateBinding });
}

it('seeds once across stores, with original persona bodies and Identity; Custom has Identity only', async () => {
  const first = await store.read();
  await seedBuilderTemplates(store);
  await seedBuilderTemplates(createAssetCatalogStore({ dir: path.join(root, 'catalog') }));
  expect(await store.read()).toEqual(first);
  expect(Object.keys(first.assets)).toHaveLength(8);
  for (const id of ['orchestrator', 'project-manager', 'researcher']) {
    expect(await store.readRevision(`builtin-builder-${id}-role`, 1)).toEqual({ content: stripPersonaFrontMatter(getPersonaTemplate(id)!.content) });
  }
  expect((await command({ type: 'template', templateId: 'builtin-builder-custom', confirm: false })).operationalIncreases).toEqual([]);
  expect((await choose('custom')).blocks.map((b) => b.content)).toEqual([IDENTITY_TEXT]);
});
it('refuses seeding and all mutations from agent surfaces', async () => {
  await expect(withSettingsSurface('mcp', agentId, () => seedBuilderTemplates(store))).rejects.toMatchObject({ code: 'agent_not_permitted' });
  await choose();
  for (const surface of ['mcp', 'cli', 'dispatcher'] as const) {
    await expect(withSettingsSurface(surface, agentId, () => command({ type: 'append', name: 'Private', content: 'test' }))).rejects.toMatchObject({ code: 'agent_not_permitted' });
  }
});
it('previews a template replacement without persisting it', async () => {
  await choose();
  const before = await store.read();
  const preview = await command({ type: 'template', templateId: 'builtin-builder-custom', confirm: false });
  expect(preview.blocks).toHaveLength(1);
  expect(await store.read()).toEqual(before);
});
it('reorders, appends and removes, and preview exactly matches the shared composer', async () => {
  let view = await choose();
  view = await command({ type: 'append', name: 'Local rules', content: 'Keep @@AgentName intact.\n' });
  const keys = view.blocks.map((b) => b.key).reverse();
  view = await command({ type: 'order', keys });
  expect(view.blocks.map((b) => b.key)).toEqual(keys);
  expect(view.customOrder).toBe(true);
  expect(composeInstructions(view.blocks)).toMatchObject({ ok: true, text: view.text });
  expect(view.text).toContain('@@AgentName');
  view = await command({ type: 'remove', key: keys[0] });
  view = await command({ type: 'baseOrder' });
  expect(view.customOrder).toBe(false);
  expect(view.blocks.map((b) => b.key)).toEqual(['base:identity', 'base:role']);
});
it('forks exact source text with provenance; editing and returning leave shared content and another agent unchanged', async () => {
  const base = await choose();
  const sharedBefore = await store.readRevision(base.blocks[0].assetId, 1);
  let view = await command({ type: 'fork', key: base.blocks[0].key });
  expect(view.blocks[0].content).toBe(IDENTITY_TEXT);
  expect(view.blocks[0].source).toBe('Fork of Identity at revision 1');
  view = await command({ type: 'edit', key: view.blocks[0].key, content: 'Edited @@AgentName' });
  expect(view.blocks[0].content).toBe('Edited @@AgentName');
  expect(await store.readRevision(base.blocks[0].assetId, 1)).toEqual(sharedBefore);
  const other = createAgentBuilder(store);
  const otherComposition = await other.compositionOf('other-agent');
  const otherAdoption = await builderSnapshotAdoption(store, otherComposition);
  const preview = await other.command('other-agent', 0, { type: 'template', templateId: 'builtin-builder-orchestrator', confirm: false }, otherAdoption);
  await other.command('other-agent', 0, { type: 'template', templateId: 'builtin-builder-orchestrator', confirm: true, binding: preview.templateBinding }, otherAdoption);
  expect((await other.read('other-agent', await builderSnapshotAdoption(store, await other.compositionOf('other-agent')))).blocks[0].content).toBe(IDENTITY_TEXT);
  view = await command({ type: 'return', key: view.blocks[0].key });
  expect(view.blocks[0].content).toBe(IDENTITY_TEXT);
  expect(view.blocks[0].editable).toBe(false);
});
it('persists and reloads in a new store', async () => {
  await choose('researcher');
  const before = await command({ type: 'append', name: 'Notes', content: 'Remember this' });
  const reopenedStore = createAssetCatalogStore({ dir: path.join(root, 'catalog') });
  const reopened = createAgentBuilder(reopenedStore);
  expect(await reopened.read(agentId, await builderSnapshotAdoption(reopenedStore, await reopened.compositionOf(agentId)))).toEqual(before);
});
it('rejects stale writes without changing saved content', async () => {
  const before = await choose();
  await command({ type: 'append', name: 'New', content: 'new' });
  const saved = await store.read();
  await expect(command({ type: 'append', name: 'Stale', content: 'stale' }, before.revision)).rejects.toMatchObject({ code: 'stale_revision' });
  expect(await store.read()).toEqual(saved);
});
it('a failed composition commit preserves the previously saved text', async () => {
  await choose();
  const before = await command({ type: 'fork', key: 'base:identity' });
  const original = store.saveComposition;
  vi.spyOn(store, 'saveComposition').mockRejectedValueOnce(new Error('disk unavailable'));
  await expect(command({ type: 'edit', key: 'base:identity', content: 'Failed edit' })).rejects.toThrow('disk unavailable');
  store.saveComposition = original;
  expect(await read()).toEqual(before);
  failCommit = true;
  await expect(command({ type: 'order', keys: ['base:role', 'base:identity'] })).rejects.toThrow();
  expect(await read()).toEqual(before);
});
it('all filesystem mutations stay in the catalog; identity, session, wires, persona and worktree files stay byte-identical', async () => {
  const preserved = ['CLAUDE.md', '.clubhouse/agents.json', '.clubhouse/wires.json', '.clubhouse/sessions/session.json', 'worktree/CLAUDE.md', '.clubhouse/personas/custom.md'];
  for (const name of preserved) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `unchanged ${name}`);
  }
  const spies = ['writeFile', 'rename', 'mkdir', 'rm', 'unlink'] as const;
  const observed: string[] = [];
  for (const method of spies) {
    const original = fs.promises[method].bind(fs.promises);
    vi.spyOn(fs.promises, method).mockImplementation((...args: unknown[]) => {
      observed.push(String(args[0]));
      if (method === 'rename') observed.push(String(args[1]));
      return (original as (...a: unknown[]) => Promise<never>)(...args);
    });
  }
  await choose();
  await command({ type: 'fork', key: 'base:identity' });
  await command({ type: 'edit', key: 'base:identity', content: '@@AgentName keeps identity' });
  await command({ type: 'append', name: 'Rules', content: 'Local rules' });
  expect(observed.length).toBeGreaterThan(0);
  expect(observed.every((file) => file.startsWith(path.join(root, 'catalog') + path.sep))).toBe(true);
  for (const name of preserved) expect(fs.readFileSync(path.join(root, name), 'utf8')).toBe(`unchanged ${name}`);
});

it('requires the exact template preview binding at confirmation', async () => {
  const preview = await command({ type: 'template', templateId: 'builtin-builder-custom', confirm: false });
  await expect(command({ type: 'template', templateId: 'builtin-builder-custom', confirm: true })).rejects.toMatchObject({ code: 'stale_choice' });
  await expect(command({ type: 'template', templateId: 'builtin-builder-custom', confirm: true, binding: { ...preview.templateBinding!, toFingerprint: 'changed' } })).rejects.toMatchObject({ code: 'stale_choice' });
  expect((await read()).revision).toBe(0);
});

it('uses the catalog instruction preview for saved text and refuses raw previews from agent surfaces', async () => {
  await choose();
  const previewInstructions = vi.spyOn(store, 'previewInstructions');
  const view = await read();
  expect(previewInstructions).toHaveBeenCalledWith({ agentId, adoption: await adoption(), draft: await builder.compositionOf(agentId) });
  const preview = await store.previewInstructions({ agentId, adoption: await adoption() });
  expect(preview.composed).toMatchObject({ ok: true, text: view.text });
  expect(preview.blocks.map((b) => b.text)).toEqual(view.blocks.map((b) => b.content));
  await expect(withSettingsSurface('mcp', agentId, () => read())).rejects.toMatchObject({ code: 'agent_not_permitted' });
});
it('surfaces operational increases from the latest template and requires a person to acknowledge them', async () => {
  const templateId = 'builtin-builder-custom';
  const payload = await store.readRevision(templateId, 1);
  await installBuiltinAsset(store, {
    assetId: templateId, kind: 'template', name: 'Custom', builtinId: templateId, expectedRevision: 1,
    payload: { ...payload, operationalDefaults: { agentAccess: 'bypass', orchestrate: true, maxHelpers: 10 } },
  });
  const preview = await command({ type: 'template', templateId, confirm: false });
  expect(preview.operationalIncreases).toEqual(expect.arrayContaining([
    { key: 'agentAccess', value: 'bypass' }, { key: 'orchestrate', value: true }, { key: 'maxHelpers', value: 10 },
  ]));
  expect((await read()).revision).toBe(0);
  const confirm = { type: 'template' as const, templateId, confirm: true, binding: preview.templateBinding };
  await expect(command(confirm)).rejects.toMatchObject({ code: 'structure_needs_choice' });
  expect((await read()).revision).toBe(0);
  expect((await command({ ...confirm, acknowledgeOperationalIncreases: true })).revision).toBe(1);
});

it('previews exact complete shared skills without writes, requires fingerprint confirmation and removes references only', async () => {
  await choose('custom');
  const payload = { skillName: 'complete', files: [{ path: 'SKILL.md', content: 'Read supporting files' },
    { path: 'scripts/check.sh', content: 'exit 7', executable: true },
    { path: 'assets/a.bin', content: 'AAH+/w==', encoding: 'base64' as const, executable: true }] };
  const asset = await store.createAsset({ kind: 'skill', name: 'Complete', payload });
  const before = await store.read();
  const select = { type: 'skill' as const, assetId: asset.id, expectedRevision: 1, confirm: false };
  const preview = await command(select);
  expect(await store.read()).toEqual(before);
  expect(preview.skills![0]).toMatchObject({ assetId: asset.id, revision: 1, payload: await store.readRevision(asset.id, 1) });
  await expect(command({ ...select, confirm: true, fingerprint: 'wrong' })).rejects.toMatchObject({ code: 'stale_preview' });
  let saved = await command({ ...select, confirm: true, fingerprint: preview.skillFingerprint });
  expect(saved.skills).toHaveLength(1);
  const removal = await command({ type: 'removeSkill', assetId: asset.id, confirm: false });
  expect((await read()).skills).toHaveLength(1);
  saved = await command({ type: 'removeSkill', assetId: asset.id, confirm: true, fingerprint: removal.skillFingerprint });
  expect(saved.skills).toEqual([]);
  expect((await store.read()).assets[asset.id].deletedAt).toBeUndefined();
  expect(await store.readRevision(asset.id, 1)).toEqual(preview.skills![0].payload);
});
it('refuses stale source revisions, foreign ownership and skill destination collisions without changing composition', async () => {
  await choose('custom');
  const skill = (owner?: { kind: 'agent'; agentId: string }) => store.createAsset({ kind: 'skill', name: 'Same name', owner,
    payload: { skillName: 'same', files: [{ path: 'SKILL.md', content: 'test' }] } });
  const first = await skill();
  const preview = await command({ type: 'skill', assetId: first.id, expectedRevision: 1, confirm: false });
  await store.saveRevision({ assetId: first.id, expectedRevision: 1, payload: { skillName: 'same', files: [{ path: 'SKILL.md', content: 'new' }] } });
  await expect(command({ type: 'skill', assetId: first.id, expectedRevision: 1, confirm: true, fingerprint: preview.skillFingerprint })).rejects.toMatchObject({ code: 'stale_revision' });
  const foreign = await skill({ kind: 'agent', agentId: 'other' });
  await expect(command({ type: 'skill', assetId: foreign.id, expectedRevision: 1, confirm: false })).rejects.toThrow();
  const current = await command({ type: 'skill', assetId: first.id, expectedRevision: 2, confirm: false });
  await command({ type: 'skill', assetId: first.id, expectedRevision: 2, confirm: true, fingerprint: current.skillFingerprint });
  const before = await builder.compositionOf(agentId);
  const second = await skill();
  await expect(command({ type: 'skill', assetId: second.id, expectedRevision: 1, confirm: false })).rejects.toThrow();
  expect(await builder.compositionOf(agentId)).toEqual(before);
});
it('excludes and restores template skill references while preserving other consumers', async () => {
  const skill = await store.createAsset({ kind: 'skill', name: 'Template skill', payload: { skillName: 'base-skill', files: [{ path: 'SKILL.md', content: 'base' }] } });
  const templateId = 'builtin-builder-custom';
  const payload = await store.readRevision(templateId, 1);
  await installBuiltinAsset(store, { assetId: templateId, kind: 'template', name: 'Custom', builtinId: templateId, expectedRevision: 1,
    payload: { ...payload, skills: [skill.id] } });
  await choose('custom');
  const otherComposition = { ...await builder.compositionOf('other-agent'), additions: [skill.id], floors: { [skill.id]: 1 } };
  const otherAdoption = await builderSnapshotAdoption(store, otherComposition);
  const otherPlan = await store.plan({ agentId: 'other-agent', draft: otherComposition, adoption: otherAdoption });
  await store.saveComposition({ agentId: 'other-agent', expectedRevision: 0, composition: otherComposition, adoption: otherAdoption, previewFingerprint: otherPlan.fingerprint });
  const otherBefore = (await store.read()).compositions['other-agent'];
  const remove = await command({ type: 'removeSkill', assetId: skill.id, confirm: false });
  expect(remove.skills).toEqual([]); expect(remove.excludedSkills).toEqual([{ assetId: skill.id, name: 'Template skill' }]);
  await command({ type: 'removeSkill', assetId: skill.id, confirm: true, fingerprint: remove.skillFingerprint });
  expect((await builder.compositionOf(agentId)).removals).toEqual([skill.id]);
  const restore = await command({ type: 'skill', assetId: skill.id, expectedRevision: 1, confirm: false });
  const saved = await command({ type: 'skill', assetId: skill.id, expectedRevision: 1, confirm: true, fingerprint: restore.skillFingerprint });
  expect(saved.skills![0].provenance[0].via).toBe('base');
  expect((await builder.compositionOf(agentId)).removals).toEqual([]);
  expect((await store.read()).compositions['other-agent']).toEqual(otherBefore);
  expect((await store.read()).assets[skill.id].headRevision).toBe(1);
  expect((await store.readRevision(templateId, 2) as { skills: string[] }).skills).toEqual([skill.id]);
});
it('refuses a source change between confirmation planning and serialized composition commit', async () => {
  await choose('custom');
  const asset = await store.createAsset({ kind: 'skill', name: 'Race', payload: { skillName: 'race', files: [{ path: 'SKILL.md', content: 'reviewed' }] } });
  const preview = await command({ type: 'skill', assetId: asset.id, expectedRevision: 1, confirm: false });
  const save = store.saveComposition;
  vi.spyOn(store, 'saveComposition').mockImplementationOnce(async (input) => {
    await store.saveRevision({ assetId: asset.id, expectedRevision: 1, payload: { skillName: 'race', files: [{ path: 'SKILL.md', content: 'changed' }] } });
    return save(input);
  });
  await expect(command({ type: 'skill', assetId: asset.id, expectedRevision: 1, confirm: true, fingerprint: preview.skillFingerprint })).rejects.toMatchObject({ code: 'stale_revision' });
  expect((await read()).skills).toEqual([]);
});

it('holds direct/base skills consistently without changing the preserved block snapshot rules', async () => {
  const skill = await store.createAsset({ kind: 'skill', name: 'Pinned skill', payload: { skillName: 'pinned', files: [{ path: 'SKILL.md', content: 'first' }] } });
  await store.saveRevision({ assetId: skill.id, expectedRevision: 1, payload: { skillName: 'pinned', files: [{ path: 'SKILL.md', content: 'second' }] } });
  const templateId = 'builtin-builder-custom';
  const payload = await store.readRevision(templateId, 1);
  await installBuiltinAsset(store, { assetId: templateId, kind: 'template', name: 'Custom', builtinId: templateId, expectedRevision: 1,
    payload: { ...payload, skills: [skill.id] } });
  await choose('custom');
  const composition = await builder.compositionOf(agentId);
  composition.additions.push(skill.id); composition.floors[skill.id] = 1;
  const snapshot = await builderSnapshotAdoption(store, composition);
  expect(snapshot).toEqual({ content: { mode: 'hold', revisions: { [skill.id]: 1, 'builtin-builder-identity': 1 } }, structure: { mode: 'accepted' } });
  const preview = await builder.read(agentId, snapshot, composition);
  expect(preview.skills).toHaveLength(1);
  expect(preview.skills![0]).toMatchObject({ revision: 1, provenance: expect.arrayContaining([{ via: 'addition' }, expect.objectContaining({ via: 'base' })]) });
});
it.each(['mcp', 'native'] as const)('refuses %s references in an accepted template even when excluded, without synthesizing holds', async (kind) => {
  const templateId = 'builtin-builder-custom';
  const payload = await store.readRevision(templateId, 1);
  const asset = kind === 'mcp'
    ? await store.createAsset({ kind: 'mcp', name: 'Unsupported MCP', payload: { serverKey: 'unsupported', transport: 'stdio', command: 'fixture' } })
    : await store.createAsset({ kind: 'subagent', name: 'Unsupported native', payload: { agentName: 'unsupported', description: 'fixture', blocks: [{ entryId: 'role', blockId: 'builtin-builder-identity', blockRevision: 1 }], skills: [], mcps: [] } });
  await installBuiltinAsset(store, { assetId: templateId, kind: 'template', name: 'Custom', builtinId: templateId, expectedRevision: 1,
    payload: { ...payload, ...(kind === 'mcp' ? { mcps: [asset.id] } : { subagents: [{ entryId: 'native', subagentId: asset.id, subagentRevision: 1 }] }) } });
  const composition = await builder.compositionOf(agentId);
  composition.template = { templateId, acceptedRevision: 2 };
  composition.entries = [{ baseEntryId: 'identity', source: { kind: 'follow' } }];
  if (kind === 'mcp') composition.removals.push(asset.id); else composition.excludedSubagentEntryIds.push('native');
  const before = await store.read();
  const explicit = { content: { mode: 'takeable' as const }, structure: { mode: 'accepted' as const } };
  await expect(builderSnapshotAdoption(store, composition)).rejects.toMatchObject({ code: 'unsupported' });
  await expect(builder.read(agentId, explicit, composition)).rejects.toMatchObject({ code: 'unsupported' });
  await expect(builder.command(agentId, 0, { type: 'template', templateId, confirm: false }, explicit)).rejects.toMatchObject({ code: 'unsupported' });
  expect(await store.read()).toEqual(before);
});
it('forks and returns a direct shared block without changing its source or another consumer', async () => {
  await choose('custom');
  const shared = await store.createAsset({ kind: 'block', name: 'Shared guidance', owner: { kind: 'library' }, payload: { content: 'SHARED_CONTENT' } });
  const composition = await builder.compositionOf(agentId);
  composition.entries.push({ localId: 'shared-entry', source: { kind: 'follow', blockId: shared.id } });
  composition.floors[shared.id] = shared.headRevision;
  const held = await builderSnapshotAdoption(store, composition);
  const plan = await store.plan({ agentId, draft: composition, adoption: held });
  await store.saveComposition({ agentId, expectedRevision: 1, composition, adoption: held, previewFingerprint: plan.fingerprint });
  const otherPlan = await store.plan({ agentId: 'other-consumer', draft: composition, adoption: held });
  await store.saveComposition({ agentId: 'other-consumer', expectedRevision: 0, composition, adoption: held, previewFingerprint: otherPlan.fingerprint });
  const before = await store.read();
  expect((await read()).blocks.at(-1)?.source).toBe('Shared block reference');
  let view = await command({ type: 'fork', key: 'local:shared-entry' });
  expect(view.blocks.at(-1)?.entry.source).toMatchObject({ kind: 'fork', forkedFrom: { assetId: shared.id, revision: 1 } });
  expect(view.blocks.at(-1)?.content).toBe('SHARED_CONTENT');
  view = await command({ type: 'edit', key: 'local:shared-entry', content: 'PRIVATE_EDIT' });
  expect(view.blocks.at(-1)?.content).toBe('PRIVATE_EDIT');
  view = await command({ type: 'return', key: 'local:shared-entry' });
  expect(view.blocks.at(-1)?.entry.source).toEqual({ kind: 'follow', blockId: shared.id });
  expect(view.blocks.at(-1)?.content).toBe('SHARED_CONTENT');
  expect(view.blocks.at(-1)?.editable).toBe(false);
  const after = await store.read();
  expect(after.assets[shared.id]).toEqual(before.assets[shared.id]);
  expect(after.compositions['other-consumer']).toEqual(before.compositions['other-consumer']);
});
