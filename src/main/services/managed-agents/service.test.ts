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

  it('keeps an MCP part\'s literal env through an edit', async () => {
    const mcp = await user(() => service.createPart({ name: 'Svc', content: { kind: 'mcp', serverKey: 'svc', transport: 'stdio', command: 'svc', env: { MODE: 'fast' } } }));
    const full = await user(() => service.getPart(mcp.id));
    expect(full.content).toMatchObject({ env: { MODE: 'fast' } });
    await user(() => service.updatePart({ id: mcp.id, expectedRevision: mcp.revision, content: { ...full.content, command: 'svc2' } as never }));
    expect((await user(() => service.getPart(mcp.id))).content).toMatchObject({ command: 'svc2', env: { MODE: 'fast' } });
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
    expect(settings.map((x) => x.agentId)).toEqual(['a', 'b']);
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
