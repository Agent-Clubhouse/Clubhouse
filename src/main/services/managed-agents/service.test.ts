import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DurableAgentConfig } from '../../../shared/types';
import type { ManagedAgentSetup } from '../../../shared/managed-agents-types';
import { CLUBHOUSE_MCP_PART_ID } from '../../../shared/managed-agents-types';

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => os.tmpdir() } }));
vi.mock('../log-service', () => ({ appLog: vi.fn() }));

import { createAssetCatalogStore } from '../asset-catalog/store';
import { withSettingsSurface, _resetSettingsAuditForTesting } from '../settings-audit';
import { createManagedStateStore } from './state-store';
import { createManagedAgentsService, diffTemplates, ManagedError, type ManagedAgentsService } from './service';
import { BUILTIN_BLOCK_IDS, builtinParts } from './builtins';

const user = <T>(fn: () => T) => withSettingsSurface('ui', undefined, fn);

let root: string;
let agents: Map<string, DurableAgentConfig>;
let running: Set<string>;
let service: ManagedAgentsService;

function agent(id: string, setup?: Partial<ManagedAgentSetup>): DurableAgentConfig {
  const a: DurableAgentConfig = { id, name: id, color: 'indigo', createdAt: '2026-11-07T00:00:00.000Z', worktreePath: `/p/.clubhouse/agents/${id}` };
  if (setup) a.managed = { version: 1, blocks: [], skills: [], mcps: [], ...setup };
  agents.set(id, a);
  return a;
}

async function expectCode(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toBeInstanceOf(ManagedError);
  await p.catch((err) => expect((err as ManagedError).code).toBe(code));
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-agents-'));
  _resetSettingsAuditForTesting(false);
  agents = new Map();
  running = new Set();
  service = createManagedAgentsService({
    catalog: createAssetCatalogStore({ dir: path.join(root, 'catalog') }),
    state: createManagedStateStore(path.join(root, 'managed')),
    listProjects: async () => [{ path: '/p', name: 'Project' }],
    listAgents: async () => [...agents.values()],
    getAgent: async (_p, id) => agents.get(id) ?? null,
    setManagedSetup: async (_p, id, setup) => {
      const a = agents.get(id);
      if (!a) throw new Error('missing');
      if (setup) a.managed = setup; else delete a.managed;
    },
    isRunning: (id) => running.has(id),
  });
  await service.ensureBuiltins();
});

describe('built-ins', () => {
  it('installs every built-in once and leaves an unchanged one alone on a second run', async () => {
    const blocks = await user(() => service.listParts('block'));
    expect(blocks.filter((b) => b.builtin).map((b) => b.id).sort()).toEqual(builtinParts().filter((p) => p.kind === 'block').map((p) => p.id).sort());
    const before = (await user(() => service.getPart(BUILTIN_BLOCK_IDS.identity))).revision;
    await service.ensureBuiltins();
    expect((await user(() => service.getPart(BUILTIN_BLOCK_IDS.identity))).revision).toBe(before);
  });

  it('refuses edits to a built-in but lets it be forked', async () => {
    const identity = await user(() => service.getPart(BUILTIN_BLOCK_IDS.identity));
    await expectCode(user(() => service.updatePart({ id: identity.id, expectedRevision: identity.revision, content: { kind: 'block', content: 'x' } })), 'builtin_read_only');
    const copy = await user(() => service.forkPart({ id: identity.id }));
    expect(copy.builtin).toBe(false);
    expect(copy.name).toBe('Identity copy');
    expect(copy.forkedFrom).toBe(identity.id);
  });
});

describe('parts by reference', () => {
  it('lists who uses a part and refuses a duplicate name', async () => {
    const part = await user(() => service.createPart({ name: 'Coding standards', description: 'Rules', content: { kind: 'block', content: 'Use strict mode.' } }));
    agent('a', { blocks: [part.id] });
    agent('b', { blocks: [part.id] });
    agent('c', { blocks: [] });
    running.add('a');
    const listed = (await user(() => service.listParts('block'))).find((p) => p.id === part.id)!;
    expect(listed.usedBy.map((u) => u.agentId).sort()).toEqual(['a', 'b']);
    expect(listed.usedBy.find((u) => u.agentId === 'a')?.running).toBe(true);
    expect(listed.description).toBe('Rules');
    await expectCode(user(() => service.createPart({ name: 'coding standards', content: { kind: 'block', content: 'x' } })), 'name_taken');
  });

  it('edits once for everyone, and a stale edit is refused', async () => {
    const part = await user(() => service.createPart({ name: 'Rules', content: { kind: 'block', content: 'one' } }));
    const edited = await user(() => service.updatePart({ id: part.id, expectedRevision: part.revision, content: { kind: 'block', content: 'two' } }));
    expect(edited.revision).toBe(part.revision + 1);
    expect((await user(() => service.getPart(part.id))).content).toEqual({ kind: 'block', content: 'two' });
    await expectCode(user(() => service.updatePart({ id: part.id, expectedRevision: part.revision, content: { kind: 'block', content: 'three' } })), 'stale');
  });

  it('forks for one agent: that agent switches, others stay shared, and back to shared restores it', async () => {
    const part = await user(() => service.createPart({ name: 'Rules', content: { kind: 'block', content: 'shared' } }));
    agent('a', { blocks: [BUILTIN_BLOCK_IDS.identity, part.id] });
    agent('b', { blocks: [part.id] });
    const fork = await user(() => service.forkPart({ id: part.id, agent: { projectPath: '/p', agentId: 'a' } }));
    expect(fork.name).toBe('Rules, a');
    expect(agents.get('a')!.managed!.blocks).toEqual([BUILTIN_BLOCK_IDS.identity, fork.id]);
    expect(agents.get('b')!.managed!.blocks).toEqual([part.id]);
    await user(() => service.backToShared({ projectPath: '/p', agentId: 'a', id: fork.id }));
    expect(agents.get('a')!.managed!.blocks).toEqual([BUILTIN_BLOCK_IDS.identity, part.id]);
  });

  it('back to shared never leaves the origin twice', async () => {
    const part = await user(() => service.createPart({ name: 'Rules', content: { kind: 'block', content: 'shared' } }));
    agent('a', { blocks: [part.id] });
    const fork = await user(() => service.forkPart({ id: part.id, agent: { projectPath: '/p', agentId: 'a' } }));
    agents.get('a')!.managed!.blocks = [fork.id, part.id];
    await user(() => service.backToShared({ projectPath: '/p', agentId: 'a', id: fork.id }));
    expect(agents.get('a')!.managed!.blocks).toEqual([part.id]);
  });

  it('a stale delete changes nothing', async () => {
    const part = await user(() => service.createPart({ name: 'Rules', content: { kind: 'block', content: 'one' } }));
    agent('a', { blocks: [part.id] });
    await user(() => service.updatePart({ id: part.id, expectedRevision: part.revision, content: { kind: 'block', content: 'two' } }));
    await expectCode(user(() => service.deletePart({ id: part.id, expectedRevision: part.revision, mode: 'remove' })), 'stale');
    expect(agents.get('a')!.managed!.blocks).toEqual([part.id]);
  });

  it('refuses literal env values on create and edit: MCP parts keep names only (D46)', async () => {
    const err = await user(() => service.createPart({ name: 'Svc', content: { kind: 'mcp', serverKey: 'svc', transport: 'stdio', command: 'svc', env: { MODE: 'fast' } } })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ManagedError);
    expect((err as ManagedError).code).toBe('invalid');
    expect((err as ManagedError).message).toMatch(/variable names only.*MODE/);
    const mcp = await user(() => service.createPart({ name: 'Svc', content: { kind: 'mcp', serverKey: 'svc', transport: 'stdio', command: 'svc', envVars: ['MODE'] } }));
    await expectCode(user(() => service.updatePart({ id: mcp.id, expectedRevision: mcp.revision, content: { kind: 'mcp', serverKey: 'svc', transport: 'stdio', command: 'svc', env: { MODE: 'fast' } } })), 'invalid');
  });

  it('never returns a stored part\'s literal env values: they read, fork and copy as names (D46)', async () => {
    // A part saved before D46 still holds literal values in the catalog.
    const catalog = createAssetCatalogStore({ dir: path.join(root, 'catalog') });
    const entry = await user(() => catalog.createAsset({ kind: 'mcp', name: 'Old', payload: { serverKey: 'old', transport: 'stdio', command: 'old', env: { MODE: 'fast' }, envVars: ['HOME_DIR'] } }));
    const full = await user(() => service.getPart(entry.id));
    expect(full.content).toEqual({ kind: 'mcp', serverKey: 'old', transport: 'stdio', command: 'old', envVars: ['HOME_DIR', 'MODE'] });
    expect(JSON.stringify(full)).not.toContain('fast');
    const head = await user(() => service.headContent(entry.id));
    expect(JSON.stringify(head!.content)).not.toContain('fast');
    const fork = await user(() => service.forkPart({ id: entry.id }));
    expect(JSON.stringify(await catalog.readRevision(fork.id, fork.revision))).not.toContain('fast');
    // An edit saves names only.
    await user(() => service.updatePart({ id: entry.id, expectedRevision: entry.headRevision, content: { ...full.content, command: 'old2' } as never }));
    const saved = await catalog.readRevision(entry.id, entry.headRevision + 1);
    expect(saved).toEqual({ serverKey: 'old', transport: 'stdio', command: 'old2', envVars: ['HOME_DIR', 'MODE'] });
  });

  it('refuses a setup for an agent without its own folder', async () => {
    const a = agent('a', {});
    delete a.worktreePath;
    await expectCode(user(() => service.saveSetup('/p', 'a', { blocks: [], skills: [], mcps: [] })), 'invalid');
  });

  it('deleting a part in use either gives each agent a copy or removes it', async () => {
    const part = await user(() => service.createPart({ name: 'Rules', content: { kind: 'block', content: 'text' } }));
    agent('a', { blocks: [part.id] });
    agent('b', { blocks: [part.id, BUILTIN_BLOCK_IDS.basics] });
    await user(() => service.deletePart({ id: part.id, expectedRevision: part.revision, mode: 'copy' }));
    const copyA = agents.get('a')!.managed!.blocks[0];
    expect(copyA).not.toBe(part.id);
    expect((await user(() => service.getPart(copyA))).content).toEqual({ kind: 'block', content: 'text' });
    const second = await user(() => service.createPart({ name: 'Second', content: { kind: 'block', content: 't' } }));
    agent('c', { blocks: [second.id, BUILTIN_BLOCK_IDS.basics] });
    await user(() => service.deletePart({ id: second.id, expectedRevision: second.revision, mode: 'remove' }));
    expect(agents.get('c')!.managed!.blocks).toEqual([BUILTIN_BLOCK_IDS.basics]);
    await expectCode(user(() => service.getPart(second.id)), 'not_found');
  });
});

describe('setups', () => {
  it('saves a setup in order, dropping duplicates and refusing unknown parts', async () => {
    agent('a', {});
    const saved = await user(() => service.saveSetup('/p', 'a', { blocks: [BUILTIN_BLOCK_IDS.basics, BUILTIN_BLOCK_IDS.identity, BUILTIN_BLOCK_IDS.basics], skills: [], mcps: [CLUBHOUSE_MCP_PART_ID] }));
    expect(saved.blocks).toEqual([BUILTIN_BLOCK_IDS.basics, BUILTIN_BLOCK_IDS.identity]);
    await expectCode(user(() => service.saveSetup('/p', 'a', { blocks: ['no-such-part'], skills: [], mcps: [] })), 'not_found');
  });

  it('refuses two skills that deliver to one folder', async () => {
    agent('a', {});
    const one = await user(() => service.createPart({ name: 'One', content: { kind: 'skill', skillName: 'deploy', files: [{ path: 'SKILL.md', content: '# one' }] } }));
    const two = await user(() => service.createPart({ name: 'Two', content: { kind: 'skill', skillName: 'deploy', files: [{ path: 'SKILL.md', content: '# two' }] } }));
    await expectCode(user(() => service.saveSetup('/p', 'a', { blocks: [], skills: [one.id, two.id], mcps: [] })), 'invalid');
  });
});

describe('templates', () => {
  it('lists built-ins, builds a setup from one, and saves an agent as a template', async () => {
    const templates = await user(() => service.listTemplates());
    expect(templates.map((t) => t.name)).toContain('Orchestrator');
    const { setup, settings } = await user(() => service.setupFromTemplate('builtin-template-orchestrator'));
    expect(setup.blocks[0]).toBe(BUILTIN_BLOCK_IDS.identity);
    expect(setup.templateId).toBe('builtin-template-orchestrator');
    expect(settings.orchestration?.orchestrate).toBe(true);
    const a = agent('a', { blocks: setup.blocks, mcps: setup.mcps });
    a.orchestration = { orchestrate: true };
    const saved = await user(() => service.templateFromAgent('/p', 'a', 'Release team'));
    expect(saved.setup.blocks).toEqual(setup.blocks);
    expect(saved.settings.orchestration).toEqual({ orchestrate: true });
    await expectCode(user(() => service.saveTemplate({ id: 'builtin-template-orchestrator', name: 'x', description: '', setup: saved.setup, settings: {} })), 'builtin_read_only');
  });

  it('pushes a template edit only to ticked agents and counts what already matches', async () => {
    const skill = await user(() => service.createPart({ name: 'Notes', content: { kind: 'skill', skillName: 'notes', files: [{ path: 'SKILL.md', content: '# n' }] } }));
    const t = await user(() => service.saveTemplate({ name: 'Team', description: '', setup: { blocks: [BUILTIN_BLOCK_IDS.identity], skills: [], mcps: [CLUBHOUSE_MCP_PART_ID] }, settings: {} }));
    agent('a', { blocks: [BUILTIN_BLOCK_IDS.identity], mcps: [CLUBHOUSE_MCP_PART_ID], templateId: t.id });
    agent('b', { blocks: [BUILTIN_BLOCK_IDS.identity], skills: [skill.id], mcps: [CLUBHOUSE_MCP_PART_ID], templateId: t.id });
    agent('c', { blocks: [BUILTIN_BLOCK_IDS.identity], mcps: [CLUBHOUSE_MCP_PART_ID], templateId: t.id });
    const next = { setup: { blocks: [BUILTIN_BLOCK_IDS.identity], skills: [skill.id], mcps: [] }, settings: { orchestration: { maxHelpers: 3 } } };
    const preview = await user(() => service.previewTemplatePush(t.id, next));
    expect(preview.changes.map((c) => c.kind)).toEqual(['add', 'remove', 'setting']);
    expect(preview.targets.find((x) => x.agentId === 'b')).toMatchObject({ applicable: 2, total: 3 });
    const settings = await user(() => service.pushTemplate(t.id, next, [{ projectPath: '/p', agentId: 'a' }, { projectPath: '/p', agentId: 'b' }]));
    expect(agents.get('a')!.managed!.skills).toEqual([skill.id]);
    expect(agents.get('a')!.managed!.mcps).toEqual([]);
    expect(agents.get('c')!.managed!.mcps).toEqual([CLUBHOUSE_MCP_PART_ID]);
    expect(settings.map((x) => [x.agentId, x.changed])).toEqual([['a', true], ['b', true]]);
    expect((await user(() => service.getTemplate(t.id))).setup.skills).toEqual([skill.id]);
  });

  it('pushes every orchestration change, resets unset settings, and reports an agent it could not update', async () => {
    const one = await user(() => service.createPart({ name: 'One', content: { kind: 'skill', skillName: 'deploy', files: [{ path: 'SKILL.md', content: '# 1' }] } }));
    const two = await user(() => service.createPart({ name: 'Two', content: { kind: 'skill', skillName: 'deploy', files: [{ path: 'SKILL.md', content: '# 2' }] } }));
    const t = await user(() => service.saveTemplate({ name: 'Team', description: '', setup: { blocks: [], skills: [], mcps: [] }, settings: { model: 'opus', orchestration: { orchestrate: true } } }));
    agent('a', { templateId: t.id });
    agent('b', { skills: [one.id], templateId: t.id });
    const next = { setup: { blocks: [], skills: [two.id], mcps: [] }, settings: { orchestration: { maxHelpers: 3, autoHelpers: true } } };
    const results = await user(() => service.pushTemplate(t.id, next, [{ projectPath: '/p', agentId: 'a' }, { projectPath: '/p', agentId: 'b' }]));
    const a = results.find((r) => r.agentId === 'a')!;
    expect(a.settings).toEqual({ model: 'default', orchestration: { orchestrate: null, maxHelpers: 3, autoHelpers: true } });
    expect(results.find((r) => r.agentId === 'b')!.failed).toMatch(/folder name deploy/);
    expect(agents.get('b')!.managed!.skills).toEqual([one.id]);
    await expectCode(user(() => service.pushTemplate(t.id, { setup: { blocks: ['gone'], skills: [], mcps: [] }, settings: {} }, [])), 'not_found');
  });

  it('reports an agent the push did not change, and leaves it as it was', async () => {
    const t = await user(() => service.saveTemplate({ name: 'Already', description: '', setup: { blocks: [], skills: [], mcps: [] }, settings: {} }));
    agent('a', { templateId: t.id });
    agent('b', { blocks: [BUILTIN_BLOCK_IDS.identity], templateId: t.id });
    const next = { setup: { blocks: [BUILTIN_BLOCK_IDS.identity], skills: [], mcps: [] }, settings: {} };
    const results = await user(() => service.pushTemplate(t.id, next, [{ projectPath: '/p', agentId: 'a' }, { projectPath: '/p', agentId: 'b' }]));
    expect(results.map((r) => [r.agentId, r.changed])).toEqual([['a', true], ['b', false]]);
    expect(agents.get('a')!.managed!.blocks).toEqual([BUILTIN_BLOCK_IDS.identity]);
  });

  it('diffs reorder of shared blocks as one change', () => {
    const changes = diffTemplates(
      { setup: { blocks: ['a', 'b'], skills: [], mcps: [] }, settings: {} },
      { setup: { blocks: ['b', 'a'], skills: [], mcps: [] }, settings: {} },
      (id) => id,
    );
    expect(changes).toEqual([{ kind: 'order' }]);
  });

  it('falls back to the built-in Helper template when the default is unset or gone', async () => {
    expect(await service.defaultHelperTemplateId()).toBe('builtin-template-helper');
    const t = await user(() => service.saveTemplate({ name: 'QA helper', description: '', setup: { blocks: [], skills: [], mcps: [] }, settings: {} }));
    await user(() => service.setDefaultHelperTemplateId(t.id));
    expect(await service.defaultHelperTemplateId()).toBe(t.id);
    await user(() => service.deleteTemplate(t.id));
    expect(await service.defaultHelperTemplateId()).toBe('builtin-template-helper');
  });
});

describe('managed helpers (#2899)', () => {
  // These are the "Let orchestrators choose helper templates" behaviors; off is covered below.
  beforeEach(async () => { await user(() => service.setHelperTemplateChoice(true)); });

  it('builds a helper from the default template with parts added and removed for it only', async () => {
    const { managedHelperSetup } = await import('./helpers');
    const pw = await user(() => service.createPart({ name: 'Playwright', content: { kind: 'mcp', serverKey: 'playwright', transport: 'stdio', command: 'npx' } }));
    const setup = await user(() => managedHelperSetup(service, { addParts: [pw.id], removeParts: [BUILTIN_BLOCK_IDS.basics] }));
    expect(setup.templateId).toBe('builtin-template-helper');
    expect(setup.blocks).toEqual([BUILTIN_BLOCK_IDS.identity, BUILTIN_BLOCK_IDS.helper]);
    expect(setup.mcps).toEqual([CLUBHOUSE_MCP_PART_ID, pw.id]);
    const template = await user(() => service.getTemplate('builtin-template-helper'));
    expect(template.setup.mcps).toEqual([CLUBHOUSE_MCP_PART_ID]);
  });

  it('names a template, and refuses an unknown template or part', async () => {
    const { managedHelperSetup } = await import('./helpers');
    const qa = await user(() => managedHelperSetup(service, { template: 'builtin-template-quality-assurance' }));
    expect(qa.blocks).toContain(BUILTIN_BLOCK_IDS.qa);
    await expect(user(() => managedHelperSetup(service, { template: 'nope' }))).rejects.toThrow(/no template "nope"/);
    await expect(user(() => managedHelperSetup(service, { addParts: ['nope'] }))).rejects.toThrow(/no agent part "nope"/);
    await expect(user(() => managedHelperSetup(service, { removeParts: ['nope'] }))).rejects.toThrow(/no agent part "nope"/);
    await expect(user(() => managedHelperSetup(service, { removeParts: [BUILTIN_BLOCK_IDS.qa] }))).rejects.toThrow(/isn't in template "builtin-template-helper"/);
  });

  it('never removes the Clubhouse MCP part, and adds it to a template without it', async () => {
    const { managedHelperSetup, HELPER_KEEPS_CLUBHOUSE_PART } = await import('./helpers');
    await expect(user(() => managedHelperSetup(service, { removeParts: [CLUBHOUSE_MCP_PART_ID] }))).rejects.toThrow(HELPER_KEEPS_CLUBHOUSE_PART);
    const bare = await user(() => service.saveTemplate({ name: 'No bridge', description: '', setup: { blocks: [], skills: [], mcps: [] }, settings: {} }));
    expect((await user(() => managedHelperSetup(service, { template: bare.id }))).mcps).toEqual([CLUBHOUSE_MCP_PART_ID]);
  });

  it('refuses a setup saving would refuse, such as two skills with one folder', async () => {
    const { managedHelperSetup } = await import('./helpers');
    const one = await user(() => service.createPart({ name: 'Ship one', content: { kind: 'skill', skillName: 'ship', files: [{ path: 'SKILL.md', content: '# 1' }] } }));
    const two = await user(() => service.createPart({ name: 'Ship two', content: { kind: 'skill', skillName: 'ship', files: [{ path: 'SKILL.md', content: '# 2' }] } }));
    await expectCode(user(() => managedHelperSetup(service, { addParts: [one.id, two.id] })), 'invalid');
  });
});

describe('letting orchestrators choose helper templates (D31)', () => {
  it('is off by default and kept in managed state', async () => {
    expect(await service.helperTemplateChoice()).toBe(false);
    await user(() => service.setHelperTemplateChoice(true));
    expect(await service.helperTemplateChoice()).toBe(true);
    const state = JSON.parse(fs.readFileSync(path.join(root, 'managed', 'state.json'), 'utf-8'));
    expect(state.helperTemplateChoice).toBe(true);
    await user(() => service.setHelperTemplateChoice(false));
    expect(await service.helperTemplateChoice()).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(root, 'managed', 'state.json'), 'utf-8'))).not.toHaveProperty('helperTemplateChoice');
  });

  it('off, uses only the default helper template and refuses another template or part changes', async () => {
    const { managedHelperSetup, HELPER_TEMPLATE_CHOICE_OFF } = await import('./helpers');
    expect((await user(() => managedHelperSetup(service, {}))).templateId).toBe('builtin-template-helper');
    // Naming the default is no choice.
    expect((await user(() => managedHelperSetup(service, { template: 'builtin-template-helper' }))).templateId).toBe('builtin-template-helper');
    for (const args of [{ template: 'builtin-template-quality-assurance' }, { addParts: [BUILTIN_BLOCK_IDS.qa] }, { removeParts: [BUILTIN_BLOCK_IDS.basics] }]) {
      await expect(user(() => managedHelperSetup(service, args))).rejects.toThrow(HELPER_TEMPLATE_CHOICE_OFF);
    }
    expect(HELPER_TEMPLATE_CHOICE_OFF).toContain('Settings › Managed agents › Helpers');
  });

  it('off, follows the default the person picked', async () => {
    const { managedHelperSetup } = await import('./helpers');
    await user(() => service.setDefaultHelperTemplateId('builtin-template-quality-assurance'));
    const setup = await user(() => managedHelperSetup(service, {}));
    expect(setup.templateId).toBe('builtin-template-quality-assurance');
    expect((await user(() => managedHelperSetup(service, { template: 'builtin-template-quality-assurance' }))).templateId).toBe('builtin-template-quality-assurance');
  });
});

describe('checkSetup', () => {
  it('runs saveSetup\'s checks without saving anything', async () => {
    agent('a', {});
    const checked = await user(() => service.checkSetup({ blocks: [BUILTIN_BLOCK_IDS.identity, BUILTIN_BLOCK_IDS.identity], skills: [], mcps: [] }));
    expect(checked).toEqual({ version: 1, blocks: [BUILTIN_BLOCK_IDS.identity], skills: [], mcps: [] });
    expect(agents.get('a')!.managed!.blocks).toEqual([]);
    await expectCode(user(() => service.checkSetup({ blocks: ['no-such-part'], skills: [], mcps: [] })), 'not_found');
  });
});
