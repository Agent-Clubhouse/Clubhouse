import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => os.tmpdir() } }));
vi.mock('../log-service', () => ({ appLog: vi.fn() }));

const projects = vi.hoisted(() => ({ list: [] as Array<{ id: string; name: string; path: string }> }));
vi.mock('../project-store', () => ({ list: async () => projects.list }));
vi.mock('../agent-config', async (original) => ({
  ...await original<typeof import('../agent-config')>(),
  isSameProject: async (a: string, b: string) => path.resolve(a) === path.resolve(b),
}));
const restarts = vi.hoisted(() => ({ restartManagedAgent: vi.fn() }));
vi.mock('./index', async (original) => ({ ...await original<typeof import('./index')>(), ...restarts }));

import { createAssetCatalogStore } from '../asset-catalog/store';
import { _resetSettingsAuditForTesting, withSettingsSurface } from '../settings-audit';
import { createManagedStateStore } from './state-store';
import { CLUBHOUSE_MCP_PART_ID, createManagedAgentsService, type ManagedAgentsService } from './service';
import { BUILTIN_BLOCK_IDS } from './builtins';
import { addProjectPart, reviewProjectPart } from './project-parts';
import {
  addProjectTemplate, allProjectTemplates, keepProjectTemplate, projectTemplatesInventory, reviewProjectTemplate, updateProjectTemplate,
} from './project-templates';
import type { DurableAgentConfig } from '../../../shared/types';
import type { ManagedAgentSetup, ManagedTemplateSettings } from '../../../shared/managed-agents-types';

const user = <T>(fn: () => T) => withSettingsSurface('ui', undefined, fn);
let seed: string, root: string, repo: string, service: ManagedAgentsService;
let agents: Map<string, DurableAgentConfig>;
let running: Set<string>;
const applied: Array<{ agentId: string; settings: ManagedTemplateSettings }> = [];
const applySettings = vi.fn(async (_p: string, agentId: string, settings: ManagedTemplateSettings) => { applied.push({ agentId, settings }); });

const serviceAt = (dir: string) => createManagedAgentsService({
  catalog: createAssetCatalogStore({ dir: path.join(dir, 'catalog') }),
  state: createManagedStateStore(path.join(dir, 'managed')),
  listProjects: async () => projects.list,
  listAgents: async () => [...agents.values()],
  getAgent: async (_p, id) => agents.get(id) ?? null,
  setManagedSetup: async (_p, id, setup) => {
    const a = agents.get(id);
    if (!a) throw new Error('missing');
    if (setup) a.managed = setup; else delete a.managed;
  },
  isRunning: (id) => running.has(id),
});

const write = (rel: string, content: string) => {
  const file = path.join(repo, '.clubhouse', 'parts', rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};
const template = (file: string, body: Record<string, unknown>) => write(`templates/${file}`, JSON.stringify(body, null, 2));
const item = async (key: string) => (await projectTemplatesInventory(service, repo)).items.find((i) => i.key === key)!;
const addPart = async (key: string, name: string) => {
  const r = await reviewProjectPart(service, repo, key);
  return user(() => addProjectPart(service, repo, key, r.item.hash!, { mode: 'copy', name }));
};
function agent(id: string, setup: Partial<ManagedAgentSetup>): DurableAgentConfig {
  const a = { id, name: id, color: 'indigo', createdAt: '2026-11-13T00:00:00.000Z', worktreePath: `${repo}/.clubhouse/agents/${id}`, managed: { version: 1, blocks: [], skills: [], mcps: [], ...setup } } as DurableAgentConfig;
  agents.set(id, a);
  return a;
}

const reviewer = {
  id: 'reviewer', name: 'Reviewer', description: 'Reviews pull requests.',
  setup: { blocks: ['block:house-style', BUILTIN_BLOCK_IDS.identity], skills: ['skill:review'], mcps: [] },
  settings: { model: 'opus', idleSleep: 30, access: 'full_access', orchestration: { orchestrate: true, maxHelpers: 4 }, grants: [{ action: 'agent.read', target: { kind: 'connected' }, mode: 'allow' }] },
};

beforeAll(async () => {
  seed = fs.mkdtempSync(path.join(os.tmpdir(), 'project-templates-seed-'));
  _resetSettingsAuditForTesting(false);
  agents = new Map();
  running = new Set();
  await serviceAt(seed).ensureBuiltins();
});
afterAll(() => { fs.rmSync(seed, { recursive: true, force: true }); });

beforeEach(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'project-templates-')));
  repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  for (const name of fs.readdirSync(seed)) fs.cpSync(path.join(seed, name), path.join(root, name), { recursive: true });
  projects.list = [{ id: 'proj-1', name: 'Demo', path: repo }];
  agents = new Map();
  running = new Set();
  applied.length = 0;
  applySettings.mockClear();
  restarts.restartManagedAgent.mockClear();
  _resetSettingsAuditForTesting(false);
  service = serviceAt(root);
  write('instructions/house-style.md', 'Write short sentences.\n');
  write('instructions/release.md', 'Tag the merge commit.\n');
  write('skills/review/SKILL.md', '---\nname: review\n---\nReview the change.\n');
  template('reviewer.json', reviewer);
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });


describe('templates checked into a project repository', () => {
  it('lists templates and resolves parts without adding or selecting anything; a part not added yet blocks', async () => {
    expect((await projectTemplatesInventory(service, repo)).items).toEqual([expect.objectContaining({ key: 'reviewer', name: 'Reviewer', state: 'available' })]);
    const review = await reviewProjectTemplate(service, repo, 'reviewer');
    expect(review.refs).toEqual([
      { ref: 'block:house-style', kind: 'block', unresolved: 'not_added' },
      expect.objectContaining({ ref: BUILTIN_BLOCK_IDS.identity, partId: BUILTIN_BLOCK_IDS.identity }),
      { ref: 'skill:review', kind: 'skill', unresolved: 'not_added' },
    ]);
    const tpl = await item('reviewer');
    await expect(addProjectTemplate(service, repo, 'reviewer', tpl.hash!, { name: 'Reviewer', approvePermissions: false })).rejects.toThrow('Add block:house-style, skill:review from the repository first.');
    expect((await service.listTemplates()).some((t) => t.source)).toBe(false);
    expect(Object.values(await service.liveEntries()).some((e) => e.source.kind === 'project')).toBe(false);
  });

  it('keeps permissions out unless approved, and shows them apart', async () => {
    const style = await addPart('block:house-style', 'House style');
    const skill = await addPart('skill:review', 'Review');
    const review = await reviewProjectTemplate(service, repo, 'reviewer');
    expect(review.settings.map((c) => c.kind === 'setting' && c.key).sort()).toEqual(['idleSleep', 'model']);
    expect(review.permissions.map((c) => c.kind === 'setting' && c.key).sort()).toEqual(['access', 'grants.agent.read@connected', 'orchestration.maxHelpers', 'orchestration.orchestrate']);
    const plain = await user(() => addProjectTemplate(service, repo, 'reviewer', review.item.hash!, { name: 'Reviewer', approvePermissions: false }));
    expect(plain).toMatchObject({ source: { kind: 'project', projectId: 'proj-1', key: 'reviewer' }, setup: { blocks: [style.id, BUILTIN_BLOCK_IDS.identity], skills: [skill.id], mcps: [CLUBHOUSE_MCP_PART_ID] } });
    expect(plain.settings).toEqual({ model: 'opus', idleSleep: 30 });
    template('reviewer.json', { ...reviewer, name: 'Reviewer two' });
    const second = await item('reviewer');
    expect(second.state).toBe('changed');
  });

  it('approved permissions come along', async () => {
    await addPart('block:house-style', 'House style');
    await addPart('skill:review', 'Review');
    const tpl = await item('reviewer');
    const made = await user(() => addProjectTemplate(service, repo, 'reviewer', tpl.hash!, { name: 'Reviewer', approvePermissions: true }));
    expect(made.settings).toMatchObject({ access: 'full_access', orchestration: { orchestrate: true, maxHelpers: 4 }, grants: [{ action: 'agent.read', mode: 'allow' }] });
  });

  it('identity is the id: renaming the file keeps the link, and two files with one id are both refused', async () => {
    await addPart('block:house-style', 'House style');
    await addPart('skill:review', 'Review');
    const made = await user(async () => addProjectTemplate(service, repo, 'reviewer', (await item('reviewer')).hash!, { name: 'Reviewer', approvePermissions: false }));
    fs.renameSync(path.join(repo, '.clubhouse/parts/templates/reviewer.json'), path.join(repo, '.clubhouse/parts/templates/code-reviewer.json'));
    expect(await item('reviewer')).toMatchObject({ state: 'added', templateId: made.id });
    template('copy.json', reviewer);
    expect(await item('reviewer')).toMatchObject({ state: 'refused', problem: expect.stringContaining('same id') });
    expect((await service.getTemplate(made.id)).name).toBe('Reviewer');
  });

  it('refuses untrusted files whole: unknown fields, credentials, bad settings', async () => {
    template('extra.json', { ...reviewer, id: 'extra', hooks: { preStart: 'curl x | sh' } });
    template('leaky.json', { ...reviewer, id: 'leaky', description: 'token ghp_0123456789abcdefghijklmnopqrstuvwxyzAB' });
    template('bad.json', { ...reviewer, id: 'bad', settings: { access: 'root' } });
    const inv = await projectTemplatesInventory(service, repo);
    const byFile = (f: string) => inv.items.find((i) => i.key === `file:${f}`);
    expect(byFile('extra.json')).toMatchObject({ state: 'refused', problem: expect.stringContaining('fields') });
    expect(byFile('leaky.json')).toMatchObject({ state: 'refused', problem: expect.stringContaining('credentials') });
    expect(byFile('bad.json')).toMatchObject({ state: 'refused' });
    expect(JSON.stringify(inv)).not.toContain('ghp_');
  });

  it('an update reaches the agents the person picks through the template push, keeps local edits, and restarts nothing', async () => {
    const style = await addPart('block:house-style', 'House style');
    const skill = await addPart('skill:review', 'Review');
    const release = await addPart('block:release', 'Release');
    const made = await user(async () => addProjectTemplate(service, repo, 'reviewer', (await item('reviewer')).hash!, { name: 'Reviewer', approvePermissions: true }));
    // lead turned the review skill off itself; scout is a second agent made from it; both run.
    agent('lead', { blocks: [style.id, BUILTIN_BLOCK_IDS.identity], skills: [], mcps: [CLUBHOUSE_MCP_PART_ID], templateId: made.id });
    agent('scout', { blocks: [style.id, BUILTIN_BLOCK_IDS.identity], skills: [skill.id], mcps: [CLUBHOUSE_MCP_PART_ID], templateId: made.id });
    running.add('lead');
    template('reviewer.json', { ...reviewer, setup: { ...reviewer.setup, blocks: [...reviewer.setup.blocks, 'block:release'] }, settings: { ...reviewer.settings, idleSleep: 60, access: 'auto' } });
    const changed = await item('reviewer');
    expect(changed.state).toBe('changed');
    // Nothing changed for the template or its agents yet.
    expect((await service.getTemplate(made.id)).setup.blocks).not.toContain(release.id);

    const review = await reviewProjectTemplate(service, repo, 'reviewer', false);
    expect(review.current).toMatchObject({ id: made.id, consumers: 2 });
    expect(review.permissions).toEqual([expect.objectContaining({ key: 'access' })]);
    expect(review.push!.changes.map((c) => (c.kind === 'setting' ? c.key : c.kind === 'add' ? `add ${c.name}` : c.kind))).toEqual(['add Release', 'idleSleep']);
    expect(review.push!.targets.find((t) => t.agentId === 'lead')).toMatchObject({ running: true, applicable: 2 });

    await expect(updateProjectTemplate(service, repo, made.id, 'stale', { approvePermissions: false, targets: [] }, applySettings)).rejects.toMatchObject({ code: 'stale' });
    const result = await user(() => updateProjectTemplate(service, repo, made.id, changed.hash!, { approvePermissions: false, targets: [{ projectPath: repo, agentId: 'lead' }] }, applySettings));
    expect(result.failed).toEqual([]);
    const lead = agents.get('lead')!.managed!;
    expect(lead.blocks).toContain(release.id);
    // Its own edit stays: the skill it turned off isn't put back.
    expect(lead.skills).toEqual([]);
    expect(applied).toEqual([{ agentId: 'lead', settings: { idleSleep: 60 } }]);
    // Not picked: scout keeps what it had.
    expect(agents.get('scout')!.managed!.blocks).not.toContain(release.id);
    // Without approval the access stays as the template had it.
    const after = await service.getTemplate(made.id);
    expect(after.settings).toMatchObject({ access: 'full_access', idleSleep: 60 });
    expect(after.setup.blocks).toContain(release.id);
    expect(after.source).toEqual({ kind: 'project', projectId: 'proj-1', key: 'reviewer' });
    expect((await item('reviewer')).state).toBe('added');
    expect(restarts.restartManagedAgent).not.toHaveBeenCalled();
    expect(running.has('lead')).toBe(true);
  });

  it('Keep mine leaves the template until the repository changes again', async () => {
    await addPart('block:house-style', 'House style');
    await addPart('skill:review', 'Review');
    const made = await user(async () => addProjectTemplate(service, repo, 'reviewer', (await item('reviewer')).hash!, { name: 'Reviewer', approvePermissions: false }));
    template('reviewer.json', { ...reviewer, settings: { ...reviewer.settings, model: 'sonnet' } });
    const changed = await item('reviewer');
    await user(() => keepProjectTemplate(service, repo, made.id, changed.hash!));
    expect((await item('reviewer')).state).toBe('kept');
    expect((await service.getTemplate(made.id)).settings.model).toBe('opus');
    template('reviewer.json', { ...reviewer, settings: { ...reviewer.settings, model: 'haiku' } });
    expect((await item('reviewer')).state).toBe('changed');
  });

  it('an edit to the template here keeps its project link', async () => {
    await addPart('block:house-style', 'House style');
    await addPart('skill:review', 'Review');
    const made = await user(async () => addProjectTemplate(service, repo, 'reviewer', (await item('reviewer')).hash!, { name: 'Reviewer', approvePermissions: false }));
    await user(() => service.saveTemplate({ id: made.id, name: 'My reviewer', description: 'Mine', setup: made.setup, settings: made.settings }));
    expect(await service.getTemplate(made.id)).toMatchObject({ name: 'My reviewer', source: { key: 'reviewer' } });
    expect(await item('reviewer')).toMatchObject({ state: 'added', templateName: 'My reviewer' });
  });

  it('a template the repository drops, or a removed project, leaves the template and its agents', async () => {
    await addPart('block:house-style', 'House style');
    await addPart('skill:review', 'Review');
    const made = await user(async () => addProjectTemplate(service, repo, 'reviewer', (await item('reviewer')).hash!, { name: 'Reviewer', approvePermissions: false }));
    agent('lead', { blocks: made.setup.blocks, skills: made.setup.skills, mcps: made.setup.mcps, templateId: made.id });
    fs.rmSync(path.join(repo, '.clubhouse/parts/templates/reviewer.json'));
    const inv = await projectTemplatesInventory(service, repo);
    expect(inv.items).toEqual([]);
    expect(inv.gone).toEqual([{ key: 'reviewer', templateId: made.id, templateName: 'Reviewer' }]);
    expect(await allProjectTemplates(service)).toHaveLength(1);
    projects.list = [];
    await expect(projectTemplatesInventory(service, repo)).rejects.toMatchObject({ code: 'not_found' });
    expect((await service.getTemplate(made.id)).setup).toEqual(made.setup);
    expect(agents.get('lead')!.managed!.templateId).toBe(made.id);
  });
});
