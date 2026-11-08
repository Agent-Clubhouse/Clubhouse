import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DurableAgentConfig } from '../../../shared/types';
import type { ManagedAgentSetup } from '../../../shared/managed-agents-types';
import { CLUBHOUSE_MCP_PART_ID, isListed } from '../../../shared/managed-agents-types';

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => os.tmpdir() } }));
vi.mock('../log-service', () => ({ appLog: vi.fn() }));

import { createAssetCatalogStore, installBuiltinAsset } from '../asset-catalog/store';
import { withSettingsSurface, _resetSettingsAuditForTesting } from '../settings-audit';
import { createManagedStateStore } from './state-store';
import { createManagedAgentsService, diffTemplates, ManagedError, type ManagedAgentsService } from './service';
import { updateAgentGrantChanges } from '../agent-grants-store';
import { BUILTIN_BLOCK_IDS, BUILTIN_MANIFEST, BUILTIN_SKILL_IDS, builtinParts, builtinTemplates, DEFAULT_HELPER_TEMPLATE_ID } from './builtins';
import { BUILTIN_SKILL_TEXT, BUILTIN_TEXT } from './builtin-text/index';

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
    // Every built-in block but the retired ones, which are never installed (D99).
    expect(blocks.filter((b) => b.builtin).map((b) => b.id).sort()).toEqual(builtinParts().filter((p) => p.kind === 'block' && !p.retired).map((p) => p.id).sort());
    const before = (await user(() => service.getPart(BUILTIN_BLOCK_IDS.identity))).revision;
    await service.ensureBuiltins();
    expect((await user(() => service.getPart(BUILTIN_BLOCK_IDS.identity))).revision).toBe(before);
  });

  it('logs and skips one built-in that won\'t install, installs the rest, and fails at the end so a later start retries', async () => {
    const catalog = createAssetCatalogStore({ dir: path.join(root, 'catalog-bad') });
    // A built-in record of another kind under the Identity block's id: the install of the block is refused.
    await withSettingsSurface('system', undefined, () => installBuiltinAsset(catalog, {
      assetId: BUILTIN_BLOCK_IDS.identity, kind: 'mcp', name: 'Wrong', builtinId: BUILTIN_BLOCK_IDS.identity, expectedRevision: 0,
      payload: { serverKey: 'wrong', transport: 'stdio', command: 'wrong' },
    }));
    const fresh = createManagedAgentsService({
      catalog, state: createManagedStateStore(path.join(root, 'managed-bad')),
      listProjects: async () => [], listAgents: async () => [], getAgent: async () => null, setManagedSetup: async () => {}, isRunning: () => false,
    });
    await expect(fresh.ensureBuiltins()).rejects.toThrow(`Built-in agent parts could not be installed: ${BUILTIN_BLOCK_IDS.identity}`);
    const installed = (await user(() => fresh.listParts('block'))).map((p) => p.id);
    expect(installed).toContain(BUILTIN_BLOCK_IDS.basics);
    expect(installed).toContain(BUILTIN_BLOCK_IDS.groupProjects);
    expect((await user(() => fresh.listParts('skill'))).map((p) => p.id)).toContain(BUILTIN_SKILL_IDS.validate);
  });

  it('ships the built-ins from the maintainer\'s builder review (#2902), without the cut ones (D71, D99)', async () => {
    const blocks = (await user(() => service.listParts('block'))).filter((b) => b.builtin);
    expect(blocks.filter(isListed).map((b) => b.name)).toEqual([
      'Clubhouse basics', 'Developer', 'Group project lead', 'Group projects', 'Helper', 'Identity', 'Identity (working)',
      'Merging', 'Orchestrator', 'Product owner', 'Pull requests', 'Quality assurance', 'Researcher',
    ]);
    expect(blocks.filter((b) => b.retired)).toEqual([]);
    // The cut ones are in the manifest, retired, so an install that had them can turn them into copies.
    expect(BUILTIN_MANIFEST.blocks.filter((b) => b.retired).map((b) => b.id).sort()).toEqual([
      BUILTIN_BLOCK_IDS.reviewer, BUILTIN_BLOCK_IDS.developerMerge, BUILTIN_BLOCK_IDS.developerPr, BUILTIN_BLOCK_IDS.projectManager,
    ].sort());
    const templates = await user(() => service.listTemplates());
    expect(templates.filter(isListed).map((t) => t.name)).toEqual([
      'Orchestrator', 'Group Project Lead', 'Quality Assurance (pull request)', 'Quality Assurance (group project)',
      'Developer (Full Merge)', 'Developer (No Merge)',
      'Product Owner', 'Researcher', 'Helper', 'Developer helper', 'Research helper', 'QA helper',
    ]);
    expect(templates.filter((t) => t.retired)).toEqual([]);
    expect(builtinTemplates().filter((t) => t.retired).map((t) => t.id)).toEqual(['builtin-template-project-manager']);
    expect(DEFAULT_HELPER_TEMPLATE_ID).toBe('builtin-template-helper');
    expect(await service.defaultHelperTemplateId()).toBe('builtin-template-helper');
  });

  it('keeps the manifest whole: every id code uses, every block file, and every template block exist', () => {
    const ids = new Set(BUILTIN_MANIFEST.blocks.map((b) => b.id));
    for (const id of Object.values(BUILTIN_BLOCK_IDS)) expect(ids, id).toContain(id);
    expect(Object.keys(BUILTIN_TEXT).sort()).toEqual(BUILTIN_MANIFEST.blocks.map((b) => b.file).sort());
    const retired = new Set(BUILTIN_MANIFEST.blocks.filter((b) => b.retired).map((b) => b.id));
    for (const t of builtinTemplates()) {
      for (const id of t.setup.blocks) expect(ids, `${t.id} lists ${id}`).toContain(id);
      if (!t.retired) expect(t.setup.blocks.filter((id) => retired.has(id)), t.id).toEqual([]);
      expect(t.setup.mcps).toEqual([CLUBHOUSE_MCP_PART_ID]);
    }
    expect(new Set(builtinTemplates().map((t) => t.id)).size).toBe(builtinTemplates().length);
    const skillIds = new Set(BUILTIN_MANIFEST.skills.map((sk) => sk.id));
    for (const id of Object.values(BUILTIN_SKILL_IDS)) expect(skillIds, id).toContain(id);
    expect(Object.keys(BUILTIN_SKILL_TEXT).sort()).toEqual(BUILTIN_MANIFEST.skills.map((sk) => sk.file).sort());
    for (const sk of BUILTIN_MANIFEST.skills) expect(sk.file).toBe(`skills/${sk.id.slice('builtin-skill-'.length)}/SKILL.md`);
    for (const t of builtinTemplates()) for (const id of t.setup.skills) expect(skillIds, `${t.id} lists ${id}`).toContain(id);
  });

  it('installs the built-in skills and lists them as built-in and read-only, forkable (#2902)', async () => {
    const skills = (await user(() => service.listParts('skill'))).filter((p) => p.builtin);
    expect(skills.filter(isListed).map((p) => p.name)).toEqual([
      'Build', 'Lint', 'Post result to parent', 'Post result to the board', 'Post result to the pull request', 'Test', 'Validate',
    ]);
    // The generic Post result was cut: retired in the manifest, not installed (D99).
    expect(skills.filter((p) => p.retired)).toEqual([]);
    expect(BUILTIN_MANIFEST.skills.filter((sk) => sk.retired).map((sk) => sk.id)).toEqual([BUILTIN_SKILL_IDS.postResult]);
    const validate = await user(() => service.getPart(BUILTIN_SKILL_IDS.validate));
    expect(validate).toMatchObject({ builtin: true, kind: 'skill' });
    expect(validate.description).not.toBe('');
    if (validate.content.kind !== 'skill') throw new Error('not a skill');
    expect(validate.content.skillName).toBe('validate');
    expect(validate.content.files.map((f) => f.path)).toEqual(['SKILL.md']);
    expect(validate.content.files[0].content).toBe(BUILTIN_SKILL_TEXT['skills/validate/SKILL.md']);
    // Every SKILL.md starts with front matter naming its folder, and the library shows its description.
    for (const sk of builtinParts().filter((p) => p.kind === 'skill')) {
      const { skillName, files } = sk.payload as { skillName: string; files: Array<{ path: string; content: string }> };
      expect(files[0].content, sk.id).toMatch(new RegExp(`^---\\r?\\n(?:.*\\r?\\n)*?name: ${skillName}\\r?\\n`));
      expect(sk.description, sk.id).not.toBe('');
    }

    await expectCode(user(() => service.updatePart({ id: validate.id, expectedRevision: validate.revision, content: { kind: 'skill', skillName: 'validate', files: [{ path: 'SKILL.md', content: '# mine' }] } })), 'builtin_read_only');
    await expectCode(user(() => service.updatePart({ id: validate.id, expectedRevision: validate.revision, name: 'Mine' })), 'builtin_read_only');
    await expectCode(user(() => service.deletePart({ id: validate.id, expectedRevision: validate.revision, mode: 'remove' })), 'builtin_read_only');
    const copy = await user(() => service.forkPart({ id: validate.id }));
    expect(copy).toMatchObject({ builtin: false, name: 'Validate copy', forkedFrom: validate.id, description: validate.description });
    // A fork keeps the folder, so it takes the built-in's place at delivery.
    const forked = await user(() => service.getPart(copy.id));
    expect(forked.content.kind === 'skill' && forked.content.skillName).toBe('validate');

    // A second install leaves them alone.
    await service.ensureBuiltins();
    expect((await user(() => service.getPart(BUILTIN_SKILL_IDS.validate))).revision).toBe(validate.revision);
  });

  it('templates carry the built-in skills the maintainer chose (#2902)', async () => {
    const S = BUILTIN_SKILL_IDS;
    const dev = [S.build, S.test, S.lint, S.validate];
    const expected: Record<string, string[]> = {
      'builtin-template-developer-full-merge': dev,
      'builtin-template-developer-no-merge': dev,
      'builtin-template-developer-helper': dev,
      'builtin-template-quality-assurance': [...dev, S.postResultPr],
      'builtin-template-qa-group-project': [...dev, S.postResultBoard],
      'builtin-template-qa-helper': [...dev, S.postResultParent],
    };
    const templates = await user(() => service.listTemplates());
    for (const t of templates.filter((x) => x.builtin)) expect(t.setup.skills, t.id).toEqual(expected[t.id] ?? []);
    const { setup } = await user(() => service.setupFromTemplate('builtin-template-quality-assurance'));
    expect(setup.skills).toEqual(expected['builtin-template-quality-assurance']);
  });

  it('gives each QA template exactly one post-result variant, the one for where it reports (#2902)', async () => {
    const S = BUILTIN_SKILL_IDS;
    const variants = new Set<string>([S.postResult, S.postResultParent, S.postResultBoard, S.postResultPr]);
    const want: Record<string, string> = {
      'builtin-template-quality-assurance': S.postResultPr,
      'builtin-template-qa-group-project': S.postResultBoard,
      'builtin-template-qa-helper': S.postResultParent,
    };
    // The pull request one keeps the id Quality Assurance shipped with, so its agents keep their template.
    expect((await user(() => service.getTemplate('builtin-template-quality-assurance'))).name).toBe('Quality Assurance (pull request)');
    for (const [id, variant] of Object.entries(want)) {
      const t = await user(() => service.getTemplate(id));
      expect(t.setup.blocks, id).toContain(BUILTIN_BLOCK_IDS.qa);
      expect(t.setup.skills.filter((sk) => variants.has(sk)), id).toEqual([variant]);
      // It saves as a setup: one skill per folder.
      const { setup } = await user(() => service.setupFromTemplate(id));
      agent(`qa-${id}`, {});
      await user(() => service.saveSetup('/p', `qa-${id}`, setup));
    }
    const groupQa = await user(() => service.getTemplate('builtin-template-qa-group-project'));
    expect(groupQa.setup.blocks).toContain(BUILTIN_BLOCK_IDS.groupProjects);
    // No other template carries a post-result variant.
    for (const t of (await user(() => service.listTemplates())).filter((x) => x.builtin && !(x.id in want))) {
      expect(t.setup.skills.filter((sk) => variants.has(sk)), t.id).toEqual([]);
    }
  });

  it('installs every post-result variant as post-result/, so a setup carries only one (#2902)', async () => {
    const S = BUILTIN_SKILL_IDS;
    const variants = [S.postResultParent, S.postResultBoard, S.postResultPr];
    for (const id of variants) {
      const part = await user(() => service.getPart(id));
      expect(part.content.kind === 'skill' && part.content.skillName, id).toBe('post-result');
    }
    for (const id of [S.build, S.test, S.lint, S.validate]) {
      const part = await user(() => service.getPart(id));
      expect(part.content.kind === 'skill' && part.content.skillName, id).toBe(id.slice('builtin-skill-'.length));
    }
    agent('qa', { skills: [S.postResultPr] });
    const refused = async (skills: string[], message: string) => {
      const save = user(() => service.saveSetup('/p', 'qa', { blocks: [], skills, mcps: [] }));
      await expectCode(save, 'invalid');
      await expect(save).rejects.toThrow(message);
      // A template is refused the same way.
      await expect(user(() => service.saveTemplate({ name: `Clash ${skills.join(' ')}`, description: '', setup: { blocks: [], skills, mcps: [] }, settings: {} }))).rejects.toThrow(message);
    };
    // Built-in and built-in.
    await refused([S.postResultParent, S.postResultPr], 'Post result to parent and Post result to the pull request both install to post-result/. Pick one.');
    // Built-in and a fork: a fork keeps the folder, so it can't sit beside the built-in it came from.
    const fork = await user(() => service.forkPart({ id: S.postResultPr }));
    await refused([S.postResultPr, fork.id], `Post result to the pull request and ${fork.name} both install to post-result/. Pick one.`);
    // Fork and fork, of different built-ins.
    const other = await user(() => service.forkPart({ id: S.postResultBoard }));
    await refused([fork.id, other.id], `${fork.name} and ${other.name} both install to post-result/. Pick one.`);
    // A user skill that happens to use the folder.
    const mine = await user(() => service.createPart({ name: 'Mine', content: { kind: 'skill', skillName: 'post-result', files: [{ path: 'SKILL.md', content: '# mine' }] } }));
    await refused([S.postResultBoard, mine.id], 'Post result to the board and Mine both install to post-result/. Pick one.');
    // A skill listed twice is that skill once, not a clash with itself.
    const twice = await user(() => service.saveTemplate({ name: 'Twice', description: '', setup: { blocks: [], skills: [S.postResultPr, S.build, S.postResultPr], mcps: [] }, settings: {} }));
    expect(twice.setup.skills).toEqual([S.postResultPr, S.build]);
    // One at a time is fine, and the library says which folder each uses.
    await user(() => service.saveSetup('/p', 'qa', { blocks: [], skills: [fork.id], mcps: [] }));
    expect((await user(() => service.getPart(fork.id))).skillName).toBe('post-result');
    // Forking for an agent swaps the fork in for the part it came from: a replace, not a clash.
    agent('qa2', { skills: [S.build, S.postResultPr] });
    const swapped = await user(() => service.forkPart({ id: S.postResultPr, agent: { projectPath: '/p', agentId: 'qa2' } }));
    expect(agents.get('qa2')!.managed!.skills).toEqual([S.build, swapped.id]);
  });

  it('keeps the Identity line the E2E specs look for', () => {
    const identity = builtinParts().find((p) => p.id === BUILTIN_BLOCK_IDS.identity)!;
    expect((identity.payload as { content: string }).content.split('\n')[0]).toBe('You are @@AgentName, an agent working in Clubhouse.');
  });

  it('frees a retired built-in\'s name for new parts and templates (D71)', async () => {
    const block = await user(() => service.createPart({ name: 'Code reviewer', content: { kind: 'block', content: 'Review hard.' } }));
    expect(block.builtin).toBe(false);
    const t = await user(() => service.saveTemplate({ name: 'Project Manager', description: '', setup: { blocks: [], skills: [], mcps: [] }, settings: {} }));
    expect(t.retired).toBeUndefined();
    await expectCode(user(() => service.createPart({ name: 'Identity', content: { kind: 'block', content: 'x' } })), 'name_taken');
    await expectCode(user(() => service.saveTemplate({ name: 'Helper', description: '', setup: { blocks: [], skills: [], mcps: [] }, settings: {} })), 'name_taken');
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

  it('reports the names a part stored literal env values for, never the values (D46)', async () => {
    const catalog = createAssetCatalogStore({ dir: path.join(root, 'catalog') });
    const entry = await user(() => catalog.createAsset({ kind: 'mcp', name: 'Old', payload: { serverKey: 'old', transport: 'stdio', command: 'old', env: { MODE: 'fast', REGION: 'eu' }, envVars: ['HOME_DIR'] } }));
    const full = await user(() => service.getPart(entry.id));
    expect(full.droppedEnvValues).toEqual(['MODE', 'REGION']);
    const listed = (await user(() => service.listParts('mcp'))).find((p) => p.id === entry.id)!;
    expect(listed.droppedEnvValues).toEqual(['MODE', 'REGION']);
    expect((await user(() => service.headContent(entry.id)))!.droppedEnvValues).toEqual(['MODE', 'REGION']);
    expect(JSON.stringify(listed)).not.toContain('fast');
    // A part with names only, and one saved again after the edit, report nothing.
    const clean = await user(() => service.createPart({ name: 'Clean', content: { kind: 'mcp', serverKey: 'clean', transport: 'stdio', command: 'c', envVars: ['CLEAN_MODE'] } }));
    expect((await user(() => service.getPart(clean.id))).droppedEnvValues).toBeUndefined();
    await user(() => service.updatePart({ id: entry.id, expectedRevision: entry.headRevision, content: { ...full.content, command: 'old2' } as never }));
    expect((await user(() => service.getPart(entry.id))).droppedEnvValues).toBeUndefined();
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

  it('unmanage clears the setup and asks for Clubhouse\'s own additions to the agent folder to be removed (D49)', async () => {
    const onUnmanaged = vi.fn(async () => {});
    const withHook = createManagedAgentsService({
      catalog: createAssetCatalogStore({ dir: path.join(root, 'catalog') }),
      state: createManagedStateStore(path.join(root, 'managed')),
      listProjects: async () => [{ path: '/p', name: 'Project' }],
      listAgents: async () => [...agents.values()],
      getAgent: async (_p, id) => agents.get(id) ?? null,
      setManagedSetup: async (_p, id, setup) => { const a = agents.get(id)!; if (setup) a.managed = setup; else delete a.managed; },
      isRunning: () => false,
      onUnmanaged,
    });
    agent('a', {});
    await user(() => withHook.unmanage('/p', 'a'));
    expect(agents.get('a')!.managed).toBeUndefined();
    expect(onUnmanaged).toHaveBeenCalledTimes(1);
    expect(onUnmanaged).toHaveBeenCalledWith('/p', expect.objectContaining({ id: 'a', worktreePath: agents.get('a')!.worktreePath }));
    // An agent that wasn't managed has nothing of Clubhouse's to remove.
    agent('b');
    await user(() => withHook.unmanage('/p', 'b'));
    expect(onUnmanaged).toHaveBeenCalledTimes(1);
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
    // Leaving the Clubhouse part out is no change: it stays in every template (D69).
    expect(preview.changes.map((c) => c.kind)).toEqual(['add', 'setting']);
    expect(preview.targets.find((x) => x.agentId === 'b')).toMatchObject({ applicable: 1, total: 2 });
    const settings = await user(() => service.pushTemplate(t.id, next, [{ projectPath: '/p', agentId: 'a' }, { projectPath: '/p', agentId: 'b' }]));
    expect(agents.get('a')!.managed!.skills).toEqual([skill.id]);
    expect(agents.get('a')!.managed!.mcps).toEqual([CLUBHOUSE_MCP_PART_ID]);
    expect(agents.get('c')!.managed!.mcps).toEqual([CLUBHOUSE_MCP_PART_ID]);
    expect((await user(() => service.getTemplate(t.id))).setup.mcps).toEqual([CLUBHOUSE_MCP_PART_ID]);
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
    expect(results.find((r) => r.agentId === 'b')!.failed).toBe('One and Two both install to deploy/. Pick one.');
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
    const t = await user(() => service.saveTemplate({ name: 'Careful reviewer', description: '', setup: { blocks: [], skills: [], mcps: [] }, settings: {} }));
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
    expect(setup.blocks).toEqual([BUILTIN_BLOCK_IDS.identityHelper, BUILTIN_BLOCK_IDS.helper]);
    expect(setup.mcps).toEqual([CLUBHOUSE_MCP_PART_ID, pw.id]);
    const template = await user(() => service.getTemplate('builtin-template-helper'));
    expect(template.setup.mcps).toEqual([CLUBHOUSE_MCP_PART_ID]);
    // Kept for the helper's Details: "Helper template, plus Playwright, minus Clubhouse basics" (D91).
    expect(setup.helperChanges).toEqual({ added: [pw.id], removed: [BUILTIN_BLOCK_IDS.basics] });
  });

  it('records no change for a part the template already has, or one removed and added back', async () => {
    const { managedHelperSetup } = await import('./helpers');
    const same = await user(() => managedHelperSetup(service, { addParts: [BUILTIN_BLOCK_IDS.identity] }));
    expect(same.helperChanges).toEqual({ added: [], removed: [] });
    const back = await user(() => managedHelperSetup(service, { removeParts: [BUILTIN_BLOCK_IDS.basics], addParts: [BUILTIN_BLOCK_IDS.basics] }));
    expect(back.helperChanges).toEqual({ added: [], removed: [] });
  });

  it('records changes against what the helper gets after the working Identity swap (#2902)', async () => {
    const { managedHelperSetup } = await import('./helpers');
    // The swap itself is no change: the template's Identity is the working one for every helper.
    const plain = await user(() => managedHelperSetup(service, {}));
    expect(plain.blocks).toContain(BUILTIN_BLOCK_IDS.identityHelper);
    expect(plain.helperChanges).toEqual({ added: [], removed: [] });
    // Removing either Identity removes the one the helper had, and that is what Details names.
    const noIdentity = await user(() => managedHelperSetup(service, { removeParts: [BUILTIN_BLOCK_IDS.identity] }));
    expect(noIdentity.blocks).not.toContain(BUILTIN_BLOCK_IDS.identityHelper);
    expect(noIdentity.helperChanges).toEqual({ added: [], removed: [BUILTIN_BLOCK_IDS.identityHelper] });
  });

  it('names a template, and refuses an unknown template or part', async () => {
    const { managedHelperSetup } = await import('./helpers');
    const qa = await user(() => managedHelperSetup(service, { template: 'builtin-template-quality-assurance' }));
    expect(qa.blocks).toContain(BUILTIN_BLOCK_IDS.qa);
    // A helper works on the branch it was given: the working Identity, never the durable one (#2902).
    expect(qa.blocks[0]).toBe(BUILTIN_BLOCK_IDS.identityHelper);
    expect(qa.blocks).not.toContain(BUILTIN_BLOCK_IDS.identity);
    expect(qa.skills).toContain(BUILTIN_SKILL_IDS.postResultPr);
    await expect(user(() => managedHelperSetup(service, { template: 'nope' }))).rejects.toThrow(/no template "nope"/);
    await expect(user(() => managedHelperSetup(service, { addParts: ['nope'] }))).rejects.toThrow(/no agent part "nope"/);
    await expect(user(() => managedHelperSetup(service, { removeParts: ['nope'] }))).rejects.toThrow(/no agent part "nope"/);
    await expect(user(() => managedHelperSetup(service, { removeParts: [BUILTIN_BLOCK_IDS.qa] }))).rejects.toThrow(/isn't in template "builtin-template-helper"/);
  });

  it('checks removeParts and addParts against the working Identity a helper gets, and never gives it both (#2902)', async () => {
    const { managedHelperSetup } = await import('./helpers');
    const { identity, identityHelper, qa, basics } = BUILTIN_BLOCK_IDS;
    // The QA template lists the durable Identity; its helper gets the working one.
    const tpl = 'builtin-template-quality-assurance';
    expect((await user(() => service.getTemplate(tpl))).setup.blocks[0]).toBe(identity);
    // Removing either id removes the Identity the helper gets.
    for (const id of [identity, identityHelper]) {
      const setup = await user(() => managedHelperSetup(service, { template: tpl, removeParts: [id] }));
      expect(setup.blocks, id).toEqual([basics, qa]);
    }
    // Adding either id is the working one, once.
    for (const id of [identity, identityHelper]) {
      const setup = await user(() => managedHelperSetup(service, { template: tpl, addParts: [id] }));
      expect(setup.blocks, id).toEqual([identityHelper, basics, qa]);
    }
    // Removed, then added back, it's the working one too.
    const back = await user(() => managedHelperSetup(service, { template: tpl, removeParts: [identity], addParts: [identity] }));
    expect(back.blocks).toEqual([basics, qa, identityHelper]);
    // A template that lists both gives the helper the working one once.
    const both = await user(() => service.saveTemplate({ name: 'Both', description: '', setup: { blocks: [identity, basics, identityHelper], skills: [], mcps: [] }, settings: {} }));
    expect((await user(() => managedHelperSetup(service, { template: both.id }))).blocks).toEqual([identityHelper, basics]);
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

  it('installs the built-ins first when a helper starts before they are installed, and retries after a failed install', async () => {
    const { managedHelperSetup } = await import('./helpers');
    const freshRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-agents-fresh-'));
    const fresh = createManagedAgentsService({
      catalog: createAssetCatalogStore({ dir: path.join(freshRoot, 'catalog') }),
      state: createManagedStateStore(path.join(freshRoot, 'managed')),
      listProjects: async () => [],
      listAgents: async () => [],
      getAgent: async () => null,
      setManagedSetup: async () => {},
      isRunning: () => false,
    });
    const install = vi.spyOn(fresh, 'ensureBuiltins').mockRejectedValueOnce(new Error('disk full'));
    // The failed install is logged, and the start is refused for the part it needs.
    await expect(user(() => managedHelperSetup(fresh, {}))).rejects.toThrow();
    const setup = await user(() => managedHelperSetup(fresh, {}));
    expect(setup.templateId).toBe('builtin-template-helper');
    expect(setup.mcps).toContain(CLUBHOUSE_MCP_PART_ID);
    await user(() => managedHelperSetup(fresh, {}));
    // Once installed, later starts don't install again.
    expect(install).toHaveBeenCalledTimes(2);
  });
});

describe('template settings beyond parts (#2898)', () => {
  it('Save as template captures effort, auto-sleep and the helper template', async () => {
    const a = agent('a', { blocks: [BUILTIN_BLOCK_IDS.identity] });
    Object.assign(a, { orchestrator: 'claude-code', model: 'opus', effort: 'high', idleSleep: 30, helperTemplateId: 'builtin-template-quality-assurance', orchestration: { orchestrate: true, maxHelpers: 4 } });
    const saved = await user(() => service.templateFromAgent('/p', 'a', 'Lead'));
    expect(saved.settings).toEqual({
      orchestrator: 'claude-code', model: 'opus', effort: 'high', idleSleep: 30,
      helperTemplateId: 'builtin-template-quality-assurance', orchestration: { orchestrate: true, maxHelpers: 4 },
    });
  });

  it('keeps only settings a template can hold: no null and no bad values', async () => {
    const t = await user(() => service.saveTemplate({
      name: 'Loose', description: '', setup: { blocks: [], skills: [], mcps: [] },
      settings: { effort: null, idleSleep: null, helperTemplateId: null, model: 'opus' },
    }));
    expect(t.settings).toEqual({ model: 'opus' });
    const bad = await user(() => service.saveTemplate({
      name: 'Bad', description: '', setup: { blocks: [], skills: [], mcps: [] },
      settings: { effort: 'NOT A LEVEL', idleSleep: -5 as number, helperTemplateId: '' },
    }));
    expect(bad.settings).toEqual({});
    const ok = await user(() => service.saveTemplate({
      name: 'Kept', description: '', setup: { blocks: [], skills: [], mcps: [] },
      settings: { effort: 'low', idleSleep: 'never', helperTemplateId: 'builtin-template-helper' },
    }));
    expect(ok.settings).toEqual({ effort: 'low', idleSleep: 'never', helperTemplateId: 'builtin-template-helper' });
  });

  it('lists setting changes for the push dialog, with helper templates by name, and counts what still applies', async () => {
    const t = await user(() => service.saveTemplate({
      name: 'Lead', description: '', setup: { blocks: [], skills: [], mcps: [] },
      settings: { orchestration: { orchestrate: true, maxHelpers: 5 }, effort: 'high' },
    }));
    const a = agent('a', { templateId: t.id });
    Object.assign(a, { orchestration: { orchestrate: true, maxHelpers: 5 }, effort: 'high' });
    const b = agent('b', { templateId: t.id });
    Object.assign(b, { orchestration: { orchestrate: true, maxHelpers: 3 }, helperTemplateId: 'builtin-template-quality-assurance', idleSleep: 15 });
    const next = {
      setup: { blocks: [], skills: [], mcps: [] },
      settings: { orchestration: { orchestrate: true, maxHelpers: 3 }, helperTemplateId: 'builtin-template-quality-assurance', idleSleep: 15 },
    };
    const preview = await user(() => service.previewTemplatePush(t.id, next));
    expect(preview.changes).toEqual([
      { kind: 'setting', key: 'effort', from: 'high', to: 'CLI default' },
      { kind: 'setting', key: 'orchestration.maxHelpers', from: '5', to: '3' },
      { kind: 'setting', key: 'idleSleep', from: 'app default', to: '15 min' },
      { kind: 'setting', key: 'helperTemplateId', from: 'app default', to: 'Quality Assurance (pull request)' },
    ]);
    // b already has three of the four; a has none of them.
    expect(preview.targets.find((x) => x.agentId === 'a')).toMatchObject({ applicable: 4, total: 4 });
    expect(preview.targets.find((x) => x.agentId === 'b')).toMatchObject({ applicable: 0, total: 4 });

    const results = await user(() => service.pushTemplate(t.id, next, [{ projectPath: '/p', agentId: 'a' }, { projectPath: '/p', agentId: 'b' }]));
    // What a template no longer sets goes back to the default: null clears it.
    expect(results.find((r) => r.agentId === 'a')!.settings).toEqual({
      effort: null, orchestration: { maxHelpers: 3 }, idleSleep: 15, helperTemplateId: 'builtin-template-quality-assurance',
    });
    expect(results.find((r) => r.agentId === 'b')!.changed).toBe(false);
    expect((await user(() => service.getTemplate(t.id))).settings).toEqual(next.settings);
  });
});

describe('a template\'s Clubhouse permissions (#2971)', () => {
  const msg = { action: 'agent.message' as const, target: { kind: 'connected' as const } };
  const settingsWrite = { action: 'settings.app.write' as const, target: { kind: 'app' as const } };

  it('keeps well-formed permissions, and refuses a list that isn\'t one', async () => {
    const t = await user(() => service.saveTemplate({
      name: 'Quiet', description: '', setup: { blocks: [], skills: [], mcps: [] },
      settings: { grants: [{ ...msg, mode: 'off' }] },
    }));
    expect(t.settings.grants).toEqual([{ ...msg, mode: 'off' }]);
    await expect(user(() => service.previewTemplatePush(t.id, { setup: t.setup, settings: { grants: [{ action: 'root', target: { kind: 'app' }, mode: 'allow' }] as never } })))
      .rejects.toThrow(/Clubhouse permissions/);
  });

  it('lists each permission that changes by name, and a push sets or takes away just those', async () => {
    const t = await user(() => service.saveTemplate({
      name: 'Perms', description: '', setup: { blocks: [], skills: [], mcps: [] },
      settings: { grants: [{ ...msg, mode: 'off' }] },
    }));
    agent('a', { templateId: t.id });
    const next = { setup: { blocks: [], skills: [], mcps: [] }, settings: { grants: [{ ...settingsWrite, mode: 'ask' as const }] } };
    const preview = await user(() => service.previewTemplatePush(t.id, next));
    expect(preview.changes).toEqual([
      { kind: 'setting', key: 'grants.agent.message@connected', from: 'Off', to: 'default', label: 'Clubhouse permission: Send messages and files (Connected agents)' },
      { kind: 'setting', key: 'grants.settings.app.write@app', from: 'default', to: 'Ask first', label: 'Clubhouse permission: Change app settings (The app)' },
    ]);
    const [result] = await user(() => service.pushTemplate(t.id, next, [{ projectPath: '/p', agentId: 'a' }]));
    expect(result.settings.grants).toEqual([{ ...msg, mode: null }, { ...settingsWrite, mode: 'ask' }]);
  });

  it('counts a permission change by the agent\'s template layer, not the person\'s own change over it', async () => {
    const t = await user(() => service.saveTemplate({
      name: 'Layered', description: '', setup: { blocks: [], skills: [], mcps: [] }, settings: { grants: [{ ...msg, mode: 'off' }] },
    }));
    agent('a', { templateId: t.id });
    agent('b', { templateId: t.id });
    await updateAgentGrantChanges('a', () => ({ changes: [{ ...msg, mode: 'ask', by: 'user' }], template: [{ ...msg, mode: 'off' }] }));
    await updateAgentGrantChanges('b', () => ({ changes: [], template: [{ ...msg, mode: 'ask' }] }));
    try {
      const preview = await user(() => service.previewTemplatePush(t.id, { setup: t.setup, settings: { grants: [{ ...msg, mode: 'ask' }] } }));
      expect(preview.targets.find((x) => x.agentId === 'a')).toMatchObject({ applicable: 1 });
      expect(preview.targets.find((x) => x.agentId === 'b')).toMatchObject({ applicable: 0, note: 'Clubhouse permission: Send messages and files (Connected agents) already Ask first' });
    } finally {
      await updateAgentGrantChanges('a', () => undefined);
      await updateAgentGrantChanges('b', () => undefined);
    }
  });
});

describe('an effort goes only with the model it is for (D81)', () => {
  const empty = { blocks: [], skills: [], mcps: [] };

  it('a model-only push sends the template\'s effort with the new model, and the preview says so', async () => {
    const t = await user(() => service.saveTemplate({ name: 'Lead', description: '', setup: empty, settings: { orchestrator: 'claude-code', model: 'opus', effort: 'high' } }));
    const a = agent('a', { templateId: t.id });
    Object.assign(a, { orchestrator: 'claude-code', model: 'opus', effort: 'high' });
    const next = { setup: empty, settings: { orchestrator: 'claude-code', model: 'sonnet', effort: 'high' } };
    const preview = await user(() => service.previewTemplatePush(t.id, next));
    expect(preview.changes).toEqual([
      { kind: 'setting', key: 'model', from: 'opus', to: 'sonnet' },
      { kind: 'setting', key: 'effort', from: 'reset by the new model', to: 'high', followsModel: true },
    ]);
    expect(preview.targets[0]).toMatchObject({ applicable: 2, total: 2 });
    const [result] = await user(() => service.pushTemplate(t.id, next, [{ projectPath: '/p', agentId: 'a' }]));
    // Applied in one write after the model, so updateDurableConfig doesn't clear it.
    expect(result.settings).toEqual({ model: 'sonnet', effort: 'high' });
  });

  it('a model-only push with no template effort lists the reset, and sends no effort', async () => {
    const t = await user(() => service.saveTemplate({ name: 'Plain', description: '', setup: empty, settings: { model: 'opus' } }));
    const a = agent('a', { templateId: t.id });
    Object.assign(a, { model: 'opus', effort: 'high' });
    const b = agent('b', { templateId: t.id });
    Object.assign(b, { model: 'opus' });
    const next = { setup: empty, settings: { model: 'sonnet' } };
    const preview = await user(() => service.previewTemplatePush(t.id, next));
    expect(preview.changes[1]).toEqual({ kind: 'setting', key: 'effort', from: 'reset by the new model', to: 'CLI default', followsModel: true });
    // Only an agent with an effort loses one.
    expect(preview.targets.find((x) => x.agentId === 'a')).toMatchObject({ applicable: 2, total: 2 });
    expect(preview.targets.find((x) => x.agentId === 'b')).toMatchObject({ applicable: 1, total: 2 });
    const results = await user(() => service.pushTemplate(t.id, next, [{ projectPath: '/p', agentId: 'a' }]));
    expect(results[0].settings).toEqual({ model: 'sonnet' });
  });

  it('an effort-only push skips an agent that runs its own model, and says why', async () => {
    const t = await user(() => service.saveTemplate({ name: 'Lead', description: '', setup: empty, settings: { model: 'opus' } }));
    const same = agent('same', { templateId: t.id });
    Object.assign(same, { model: 'opus' });
    const own = agent('own', { templateId: t.id });
    Object.assign(own, { model: 'sonnet', effort: 'low' });
    const next = { setup: empty, settings: { model: 'opus', effort: 'high' } };
    const preview = await user(() => service.previewTemplatePush(t.id, next));
    expect(preview.changes).toEqual([{ kind: 'setting', key: 'effort', from: 'CLI default', to: 'high' }]);
    expect(preview.targets.find((x) => x.agentId === 'same')).toMatchObject({ applicable: 1, total: 1 });
    expect(preview.targets.find((x) => x.agentId === 'own')).toMatchObject({ applicable: 0, total: 1, note: 'effort not applied: it runs another model' });
    const results = await user(() => service.pushTemplate(t.id, next, [{ projectPath: '/p', agentId: 'same' }, { projectPath: '/p', agentId: 'own' }]));
    expect(results.find((r) => r.agentId === 'same')!.settings).toEqual({ effort: 'high' });
    expect(results.find((r) => r.agentId === 'own')!.changed).toBe(false);
  });

  it('pushing a template whose Access is no longer set gives agents the Default access, and leaves one already there (#2998)', async () => {
    const fas = await import('../free-agent-settings');
    const spy = vi.spyOn(fas, 'getDefaultAccess').mockReturnValue('auto_edit');
    try {
      const t = await user(() => service.saveTemplate({ name: 'Leveled', description: '', setup: empty, settings: { access: 'auto' } }));
      const on = agent('on', { templateId: t.id });
      Object.assign(on, { access: 'auto' });
      const there = agent('there', { templateId: t.id });
      Object.assign(there, { access: 'auto_edit' });
      const next = { setup: empty, settings: {} };
      const preview = await user(() => service.previewTemplatePush(t.id, next));
      expect(preview.changes).toEqual([{ kind: 'setting', key: 'access', from: 'Auto', to: 'Auto-accept edits (Default access)' }]);
      expect(preview.targets.find((x) => x.agentId === 'on')).toMatchObject({ applicable: 1 });
      expect(preview.targets.find((x) => x.agentId === 'there')).toMatchObject({ applicable: 0 });
      const results = await user(() => service.pushTemplate(t.id, next, [{ projectPath: '/p', agentId: 'on' }, { projectPath: '/p', agentId: 'there' }]));
      expect(results.find((r) => r.agentId === 'on')!.settings).toEqual({ access: 'auto_edit' });
      expect(results.find((r) => r.agentId === 'there')!.changed).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('refuses a push whose settings a setting doesn\'t take before any agent is written', async () => {
    const skill = await user(() => service.createPart({ name: 'Notes', content: { kind: 'skill', skillName: 'notes', files: [{ path: 'SKILL.md', content: '# n' }] } }));
    const t = await user(() => service.saveTemplate({ name: 'Team', description: '', setup: empty, settings: {} }));
    agent('a', { templateId: t.id });
    for (const settings of [{ effort: 'High; rm -rf' }, { idleSleep: -1 }, { orchestration: { maxHelpers: 0 } }, { helperTemplateId: 7 }, { orchestrator: '../x' }]) {
      const next = { setup: { blocks: [], skills: [skill.id], mcps: [] }, settings: settings as never };
      await expectCode(user(() => service.pushTemplate(t.id, next, [{ projectPath: '/p', agentId: 'a' }])), 'invalid');
      await expectCode(user(() => service.previewTemplatePush(t.id, next)), 'invalid');
    }
    expect(agents.get('a')!.managed!.skills).toEqual([]);
    expect((await user(() => service.getTemplate(t.id))).setup.skills).toEqual([]);
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

  it('uses the orchestrator\'s own helper template, falling back to the app default when it is gone (#2895)', async () => {
    const { managedHelperSetup, helperTemplateFor, HELPER_TEMPLATE_CHOICE_OFF } = await import('./helpers');
    // Choice off: the person set it, so it is no choice, and naming it or the app default passes.
    expect((await user(() => managedHelperSetup(service, {}, 'builtin-template-quality-assurance'))).templateId).toBe('builtin-template-quality-assurance');
    expect((await user(() => managedHelperSetup(service, { template: 'builtin-template-quality-assurance' }, 'builtin-template-quality-assurance'))).templateId).toBe('builtin-template-quality-assurance');
    expect((await user(() => managedHelperSetup(service, { template: 'builtin-template-helper' }, 'builtin-template-quality-assurance'))).templateId).toBe('builtin-template-helper');
    await expect(user(() => managedHelperSetup(service, { template: 'builtin-template-orchestrator' }, 'builtin-template-quality-assurance'))).rejects.toThrow(HELPER_TEMPLATE_CHOICE_OFF);
    const t = await user(() => service.saveTemplate({ name: 'Gone soon', description: '', setup: { blocks: [], skills: [], mcps: [] }, settings: {} }));
    expect(await helperTemplateFor(service, t.id)).toEqual({ templateId: t.id, appDefault: 'builtin-template-helper' });
    await user(() => service.deleteTemplate(t.id));
    expect(await helperTemplateFor(service, t.id)).toEqual({ templateId: 'builtin-template-helper', appDefault: 'builtin-template-helper' });
    expect((await user(() => managedHelperSetup(service, {}, t.id))).templateId).toBe('builtin-template-helper');
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
    expect(checked).toEqual({ version: 1, blocks: [BUILTIN_BLOCK_IDS.identity], skills: [], mcps: [CLUBHOUSE_MCP_PART_ID] });
    expect(agents.get('a')!.managed!.blocks).toEqual([]);
    await expectCode(user(() => service.checkSetup({ blocks: ['no-such-part'], skills: [], mcps: [] })), 'not_found');
  });
});

describe('the Clubhouse MCP part is in every setup and template (D69)', () => {
  it('saveSetup and checkSetup add it first when it is left out', async () => {
    agent('a', {});
    const other = await user(() => service.createPart({ name: 'Docs', content: { kind: 'mcp', serverKey: 'docs', transport: 'http', url: 'https://docs.example.com/mcp' } }));
    const saved = await user(() => service.saveSetup('/p', 'a', { blocks: [], skills: [], mcps: [other.id] }));
    expect(saved.mcps).toEqual([CLUBHOUSE_MCP_PART_ID, other.id]);
    expect(agents.get('a')!.managed!.mcps).toEqual([CLUBHOUSE_MCP_PART_ID, other.id]);
    // Where the setup already has it, its place is kept.
    expect((await user(() => service.checkSetup({ blocks: [], skills: [], mcps: [other.id, CLUBHOUSE_MCP_PART_ID] }))).mcps).toEqual([other.id, CLUBHOUSE_MCP_PART_ID]);
  });

  it('saveTemplate adds it, and setupFromTemplate gives it', async () => {
    const t = await user(() => service.saveTemplate({ name: 'Bare', description: '', setup: { blocks: [], skills: [], mcps: [] }, settings: {} }));
    expect(t.setup.mcps).toEqual([CLUBHOUSE_MCP_PART_ID]);
    expect((await user(() => service.setupFromTemplate(t.id))).setup.mcps).toEqual([CLUBHOUSE_MCP_PART_ID]);
  });

  it('reads a custom template saved without it as having it', async () => {
    await createManagedStateStore(path.join(root, 'managed')).update((s) => {
      s.templates['template-old'] = { id: 'template-old', name: 'Old', description: '', builtin: false, setup: { blocks: [], skills: [], mcps: [] }, settings: {}, updatedAt: '2026-01-01T00:00:00.000Z' };
    });
    expect((await user(() => service.getTemplate('template-old'))).setup.mcps).toEqual([CLUBHOUSE_MCP_PART_ID]);
    expect((await user(() => service.setupFromTemplate('template-old'))).setup.mcps).toEqual([CLUBHOUSE_MCP_PART_ID]);
  });

  it('refuses to copy it', async () => {
    await expectCode(user(() => service.forkPart({ id: CLUBHOUSE_MCP_PART_ID })), 'invalid');
  });
});

describe('attribution and helper changes (#2899, #2900)', () => {
  const asDispatcher = <T>(fn: () => T) => withSettingsSurface('dispatcher', 'dispatcher-1', fn);

  it('records the Dispatcher on a setup it saves, and clears it when the person saves', async () => {
    agent('a', { blocks: [BUILTIN_BLOCK_IDS.identity] });
    const saved = await asDispatcher(() => service.saveSetup('/p', 'a', { blocks: [], skills: [], mcps: [] }));
    expect(saved.updatedBy).toBe('Dispatcher');
    expect(agents.get('a')!.managed!.updatedBy).toBe('Dispatcher');
    expect(Date.parse(agents.get('a')!.managed!.updatedAt!)).not.toBeNaN();
    await user(() => service.saveSetup('/p', 'a', { blocks: [BUILTIN_BLOCK_IDS.identity], skills: [], mcps: [] }));
    expect(agents.get('a')!.managed!.updatedBy).toBeUndefined();
    expect(agents.get('a')!.managed!.updatedAt).toBeDefined();
  });

  it('ignores bookkeeping a caller passes inside the setup', async () => {
    agent('a', { blocks: [] });
    await user(() => service.saveSetup('/p', 'a', { blocks: [], skills: [], mcps: [], updatedBy: 'Someone', helperChanges: { added: ['x'], removed: [] } }));
    expect(agents.get('a')!.managed!.updatedBy).toBeUndefined();
    expect(agents.get('a')!.managed!.helperChanges).toBeUndefined();
  });

  it('records the Dispatcher on a template it saves and on a push', async () => {
    const t = await asDispatcher(() => service.saveTemplate({ name: 'Reviewer', description: '', setup: { blocks: [], skills: [], mcps: [] }, settings: {} }));
    expect(t.updatedBy).toBe('Dispatcher');
    const again = await user(() => service.saveTemplate({ id: t.id, name: 'Reviewer', description: '', setup: { blocks: [], skills: [], mcps: [] }, settings: {} }));
    expect(again.updatedBy).toBeUndefined();
    await asDispatcher(() => service.pushTemplate(t.id, { setup: { blocks: [BUILTIN_BLOCK_IDS.identity], skills: [], mcps: [] }, settings: {} }, []));
    expect((await service.getTemplate(t.id)).updatedBy).toBe('Dispatcher');
  });

  it('keeps start_helper changes while the parts stay, and drops them once they change', async () => {
    agent('h', { blocks: [] });
    const changes = { added: [BUILTIN_BLOCK_IDS.identity], removed: [] };
    await user(() => service.saveSetup('/p', 'h', { blocks: [BUILTIN_BLOCK_IDS.identity], skills: [], mcps: [] }, { helperChanges: changes }));
    expect(agents.get('h')!.managed!.helperChanges).toEqual(changes);
    // The same parts saved again (a push that changed nothing, say): still true.
    await user(() => service.saveSetup('/p', 'h', { blocks: [BUILTIN_BLOCK_IDS.identity], skills: [], mcps: [] }));
    expect(agents.get('h')!.managed!.helperChanges).toEqual(changes);
    await user(() => service.saveSetup('/p', 'h', { blocks: [], skills: [], mcps: [] }));
    expect(agents.get('h')!.managed!.helperChanges).toBeUndefined();
  });

  it('lists the agents made from a template', async () => {
    const t = await user(() => service.saveTemplate({ name: 'Mine', description: '', setup: { blocks: [], skills: [], mcps: [] }, settings: {} }));
    agent('a', { templateId: t.id });
    agent('b', {});
    running.add('a');
    expect(await service.templateConsumers(t.id)).toEqual([expect.objectContaining({ agentId: 'a', running: true, projectName: 'Project' })]);
  });
});

describe('stale renames and description edits (#2897, D92)', () => {
  it('refuses a save whose name was changed since it was opened, and keeps the rename', async () => {
    const part = await user(() => service.createPart({ name: 'Rules', description: 'Old', content: { kind: 'block', content: 'one' } }));
    // Someone else renames it: the revision doesn't move.
    const renamed = await user(() => service.updatePart({ id: part.id, expectedRevision: part.revision, expectedName: 'Rules', name: 'House rules' }));
    expect(renamed.revision).toBe(part.revision);
    // The editor opened "Rules" and sends that name back with its text.
    await expectCode(user(() => service.updatePart({ id: part.id, expectedRevision: part.revision, expectedName: 'Rules', expectedDescription: 'Old', name: 'Rules', description: 'Old', content: { kind: 'block', content: 'two' } })), 'stale');
    const now = await user(() => service.getPart(part.id));
    expect(now.name).toBe('House rules');
    expect(now.content).toEqual({ kind: 'block', content: 'one' });
    // Pinned to what is there now, it saves.
    const saved = await user(() => service.updatePart({ id: part.id, expectedRevision: now.revision, expectedName: 'House rules', expectedDescription: 'Old', name: 'Rules', content: { kind: 'block', content: 'two' } }));
    expect(saved.name).toBe('Rules');
  });

  it('refuses a save whose description was changed since it was opened', async () => {
    const part = await user(() => service.createPart({ name: 'Notes', description: 'Old', content: { kind: 'block', content: 'one' } }));
    await user(() => service.updatePart({ id: part.id, expectedRevision: part.revision, expectedDescription: 'Old', description: 'New' }));
    await expectCode(user(() => service.updatePart({ id: part.id, expectedRevision: part.revision, expectedName: 'Notes', expectedDescription: 'Old', description: 'Old', content: { kind: 'block', content: 'two' } })), 'stale');
    expect((await user(() => service.getPart(part.id))).description).toBe('New');
    // No description before counts as empty.
    const bare = await user(() => service.createPart({ name: 'Bare', content: { kind: 'block', content: 'x' } }));
    await user(() => service.updatePart({ id: bare.id, expectedRevision: bare.revision, expectedDescription: '', description: 'Now one' }));
  });
});
