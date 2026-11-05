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
