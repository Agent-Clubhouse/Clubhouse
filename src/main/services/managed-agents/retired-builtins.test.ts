/**
 * Built-ins an app update retired become the person's own copies (D99). The
 * catalog starts as an earlier version left it: every built-in installed,
 * the retired ones included, with agents and templates using them.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DurableAgentConfig } from '../../../shared/types';
import { CLUBHOUSE_MCP_PART_ID, isListed, type ManagedAgentSetup } from '../../../shared/managed-agents-types';

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => os.tmpdir() } }));
vi.mock('../log-service', () => ({ appLog: vi.fn() }));

import { createAssetCatalogStore, installBuiltinAsset, type AssetCatalogStore } from '../asset-catalog/store';
import { withSettingsSurface, _resetSettingsAuditForTesting } from '../settings-audit';
import { createManagedStateStore, type ManagedStateStore } from './state-store';
import { createManagedAgentsService, type ManagedAgentsDeps, type ManagedAgentsService } from './service';
import { BUILTIN_BLOCK_IDS, BUILTIN_SKILL_IDS, builtinParts } from './builtins';
import { deliverManagedSetup } from './delivery';
import type { OrchestratorProvider } from '../../orchestrators/types';

const user = <T>(fn: () => T) => withSettingsSurface('ui', undefined, fn);
const PM_TEMPLATE = 'builtin-template-project-manager';

let root: string;
let project: string;
let catalog: AssetCatalogStore;
let state: ManagedStateStore;
let agents: Map<string, DurableAgentConfig>;
let unreadable: boolean;
let remapped: Array<{ id: string; before: ManagedAgentSetup; after: ManagedAgentSetup }>;
let service: ManagedAgentsService;

function makeService(over: Partial<ManagedAgentsDeps> = {}): ManagedAgentsService {
  return createManagedAgentsService({
    catalog, state,
    listProjects: async () => [{ path: project, name: 'Project' }, { path: '/elsewhere', name: 'Elsewhere' }],
    listAgents: async (p) => {
      if (p === '/elsewhere') { if (unreadable) throw new Error('agents.json unreadable'); return []; }
      return [...agents.values()];
    },
    getAgent: async (_p, id) => agents.get(id) ?? null,
    setManagedSetup: async (_p, id, setup) => { const a = agents.get(id)!; if (setup) a.managed = setup; else delete a.managed; },
    isRunning: () => false,
    setHelperTemplate: async (_p, id, templateId) => { agents.get(id)!.helperTemplateId = templateId; },
    onSetupRemapped: async (_p, agent, before, after) => { remapped.push({ id: agent.id, before, after }); },
    ...over,
  });
}

function agent(id: string, over: Partial<DurableAgentConfig> = {}): DurableAgentConfig {
  const wt = path.join(project, '.clubhouse', 'agents', id);
  fs.mkdirSync(wt, { recursive: true });
  const a: DurableAgentConfig = { id, name: id, color: 'indigo', createdAt: '2026-11-07T00:00:00.000Z', worktreePath: wt, branch: `${id}/standby`, ...over };
  agents.set(id, a);
  return a;
}

const provider = {
  id: 'claude-code', displayName: 'Claude Code',
  conventions: { configDir: '.claude', skillsDir: 'skills', mcpConfigFile: '.mcp.json', legacyInstructionsFile: 'CLAUDE.md', localSettingsFile: 'settings.local.json', settingsFormat: 'json' },
  writeInstructions: async (wt: string, content: string) => { fs.writeFileSync(path.join(wt, 'CLAUDE.md'), content); },
} as unknown as OrchestratorProvider;

/** Every file under `dir`, relative, with its bytes. */
function filesOf(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = path.join(rel, e.name);
      if (e.isDirectory()) walk(r); else out[r] = fs.readFileSync(path.join(dir, r), 'utf-8');
    }
  };
  walk('');
  return out;
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-retired-'));
  project = path.join(root, 'project');
  _resetSettingsAuditForTesting(false);
  catalog = createAssetCatalogStore({ dir: path.join(root, 'catalog') });
  state = createManagedStateStore(path.join(root, 'managed'));
  agents = new Map();
  unreadable = false;
  remapped = [];
  // As an earlier version left it: every built-in installed, the retired ones too.
  await withSettingsSurface('system', undefined, async () => {
    for (const p of builtinParts()) {
      await installBuiltinAsset(catalog, { assetId: p.id, kind: p.kind, name: p.name, builtinId: p.id, expectedRevision: 0, payload: p.payload });
    }
  });
  service = makeService();
});

describe('retired built-ins become the person\'s own copies (D99)', () => {
  it('switches every agent and template that uses one to a visible, editable copy, and removes the unused ones', async () => {
    const pm = agent('pm', {
      helperTemplateId: PM_TEMPLATE,
      managed: {
        version: 1, templateId: PM_TEMPLATE,
        blocks: [BUILTIN_BLOCK_IDS.identity, BUILTIN_BLOCK_IDS.basics, BUILTIN_BLOCK_IDS.projectManager],
        skills: [BUILTIN_SKILL_IDS.build, BUILTIN_SKILL_IDS.postResult],
        mcps: [CLUBHOUSE_MCP_PART_ID],
        helperChanges: { added: [BUILTIN_BLOCK_IDS.projectManager], removed: [] },
      },
    });
    agent('plain');
    const mine = await user(() => service.saveTemplate({ name: 'Reviews', description: '', setup: { blocks: [BUILTIN_BLOCK_IDS.reviewer], skills: [], mcps: [] }, settings: { helperTemplateId: PM_TEMPLATE } }));
    await state.update((s) => { s.defaultHelperTemplateId = PM_TEMPLATE; });

    // What the agent gets before the update.
    await user(() => deliverManagedSetup({ service, projectPath: project, agent: pm, provider }));
    const before = filesOf(pm.worktreePath!);

    await service.ensureBuiltins();

    const blocks = await user(() => service.listParts('block'));
    const skills = await user(() => service.listParts('skill'));
    const pmCopy = blocks.find((b) => b.name === 'Project manager')!;
    const reviewerCopy = blocks.find((b) => b.name === 'Code reviewer')!;
    const postCopy = skills.find((s) => s.name === 'Post result')!;
    for (const copy of [pmCopy, reviewerCopy, postCopy]) {
      expect(copy).toMatchObject({ builtin: false, fromRetiredBuiltin: true });
      expect(copy.retired).toBeUndefined();
      expect(isListed(copy)).toBe(true);
    }
    expect(pmCopy.description).toBe(builtinParts().find((p) => p.id === BUILTIN_BLOCK_IDS.projectManager)!.description);
    // The built-ins themselves are gone, used or not.
    for (const id of [BUILTIN_BLOCK_IDS.projectManager, BUILTIN_BLOCK_IDS.reviewer, BUILTIN_BLOCK_IDS.developerMerge, BUILTIN_BLOCK_IDS.developerPr, BUILTIN_SKILL_IDS.postResult]) {
      await expect(user(() => service.getPart(id)), id).rejects.toMatchObject({ code: 'not_found' });
    }
    expect(blocks.map((b) => b.name)).not.toContain('Developer, full merge');

    // The template copy takes the retired template's place everywhere it was named.
    const templates = await user(() => service.listTemplates());
    const tCopy = templates.find((t) => t.name === 'Project Manager')!;
    expect(tCopy).toMatchObject({ builtin: false, fromRetiredBuiltin: PM_TEMPLATE, settings: { orchestration: { orchestrate: true, autoHelpers: true } } });
    expect(tCopy.setup.blocks).toEqual([BUILTIN_BLOCK_IDS.identity, BUILTIN_BLOCK_IDS.basics, pmCopy.id]);
    expect(templates.map((t) => t.id)).not.toContain(PM_TEMPLATE);
    await expect(user(() => service.getTemplate(PM_TEMPLATE))).rejects.toMatchObject({ code: 'not_found' });
    expect(await service.defaultHelperTemplateId()).toBe(tCopy.id);

    const after = agents.get('pm')!;
    expect(after.managed).toMatchObject({
      templateId: tCopy.id,
      blocks: [BUILTIN_BLOCK_IDS.identity, BUILTIN_BLOCK_IDS.basics, pmCopy.id],
      skills: [BUILTIN_SKILL_IDS.build, postCopy.id],
      helperChanges: { added: [pmCopy.id], removed: [] },
    });
    expect(after.helperTemplateId).toBe(tCopy.id);
    expect(agents.get('plain')!.managed).toBeUndefined();
    const reviews = await user(() => service.getTemplate(mine.id));
    expect(reviews.setup.blocks).toEqual([reviewerCopy.id]);
    expect(reviews.settings.helperTemplateId).toBe(tCopy.id);
    expect(remapped.map((r) => r.id)).toContain('pm');

    // What the agent gets is the same, byte for byte.
    await user(() => deliverManagedSetup({ service, projectPath: project, agent: after, provider }));
    expect(filesOf(pm.worktreePath!)).toEqual(before);

    // The copy is the person's: it edits like any custom part.
    const saved = await user(() => service.updatePart({ id: pmCopy.id, expectedRevision: pmCopy.revision, content: { kind: 'block', content: 'Manage it my way.' } }));
    expect(saved.revision).toBe(pmCopy.revision + 1);
  });

  it('does it once: a second start makes no more copies', async () => {
    agent('pm', { managed: { version: 1, blocks: [BUILTIN_BLOCK_IDS.projectManager], skills: [], mcps: [CLUBHOUSE_MCP_PART_ID] } });
    await service.ensureBuiltins();
    const first = await user(() => service.listParts('block'));
    await service.ensureBuiltins();
    await makeService().ensureBuiltins();
    expect((await user(() => service.listParts('block'))).map((b) => b.id).sort()).toEqual(first.map((b) => b.id).sort());
    expect(first.filter((b) => b.name === 'Project manager')).toHaveLength(1);
    // The map from built-in to copy is kept on disk.
    expect((await createManagedStateStore(path.join(root, 'managed')).read()).retiredCopies?.[BUILTIN_BLOCK_IDS.projectManager]).toBe(first.find((b) => b.name === 'Project manager')!.id);
  });

  it('keeps the name, unless the person already has a part by that name', async () => {
    // A retired built-in's name was free for new parts (D71).
    const theirs = await user(() => service.createPart({ name: 'Code reviewer', content: { kind: 'block', content: 'Mine.' } }));
    agent('r', { managed: { version: 1, blocks: [BUILTIN_BLOCK_IDS.reviewer], skills: [], mcps: [CLUBHOUSE_MCP_PART_ID] } });
    await service.ensureBuiltins();
    const blocks = await user(() => service.listParts('block'));
    expect(blocks.find((b) => b.id === theirs.id)!.name).toBe('Code reviewer');
    const copy = blocks.find((b) => b.fromRetiredBuiltin)!;
    expect(copy.name).toBe('Code reviewer 2');
    expect(agents.get('r')!.managed!.blocks).toEqual([copy.id]);
  });

  it('keeps a retired part installed while a project\'s agents can\'t be read, and finishes once they can', async () => {
    unreadable = true;
    agent('pm', { managed: { version: 1, blocks: [BUILTIN_BLOCK_IDS.projectManager], skills: [], mcps: [CLUBHOUSE_MCP_PART_ID] } });
    await service.ensureBuiltins();
    const copyId = agents.get('pm')!.managed!.blocks[0];
    expect(copyId).not.toBe(BUILTIN_BLOCK_IDS.projectManager);
    // Still there for an agent in the project that couldn't be read; hidden as before.
    expect(await user(() => service.getPart(BUILTIN_BLOCK_IDS.projectManager))).toMatchObject({ builtin: true, retired: true });
    // A start that can read every project finishes, with the same copy.
    unreadable = false;
    await service.ensureBuiltins();
    await expect(user(() => service.getPart(BUILTIN_BLOCK_IDS.projectManager))).rejects.toMatchObject({ code: 'not_found' });
    expect((await user(() => service.listParts('block'))).filter((b) => b.fromRetiredBuiltin).map((b) => b.id)).toEqual([copyId]);
  });

  it('never installs a retired built-in on a fresh install', async () => {
    catalog = createAssetCatalogStore({ dir: path.join(root, 'catalog-fresh') });
    state = createManagedStateStore(path.join(root, 'managed-fresh'));
    const fresh = makeService();
    await fresh.ensureBuiltins();
    const ids = [...(await user(() => fresh.listParts('block'))), ...(await user(() => fresh.listParts('skill')))].map((p) => p.id);
    for (const p of builtinParts().filter((x) => x.retired)) expect(ids, p.id).not.toContain(p.id);
    expect(ids).toContain(BUILTIN_BLOCK_IDS.identity);
  });

  it('copies the shipped text for an agent that names a retired built-in this install never had', async () => {
    catalog = createAssetCatalogStore({ dir: path.join(root, 'catalog-fresh') });
    state = createManagedStateStore(path.join(root, 'managed-fresh'));
    agent('synced', { managed: { version: 1, blocks: [BUILTIN_BLOCK_IDS.projectManager], skills: [], mcps: [CLUBHOUSE_MCP_PART_ID] } });
    const fresh = makeService();
    await fresh.ensureBuiltins();
    const copyId = agents.get('synced')!.managed!.blocks[0];
    const copy = await user(() => fresh.getPart(copyId));
    const shipped = builtinParts().find((p) => p.id === BUILTIN_BLOCK_IDS.projectManager)!;
    expect(copy.content).toEqual({ kind: 'block', content: (shipped.payload as { content: string }).content });
  });
});

describe('a project whose agents can\'t be read keeps the retired parts (D99)', () => {
  /** A project folder with agents.json as agent-config writes it. */
  function projectWith(name: string, agentsJson: string | null): string {
    const dir = path.join(root, name);
    fs.mkdirSync(path.join(dir, '.clubhouse'), { recursive: true });
    if (agentsJson !== null) fs.writeFileSync(path.join(dir, '.clubhouse', 'agents.json'), agentsJson);
    return dir;
  }

  async function adoptWith(other: string): Promise<void> {
    const { peekDurableConfigsChecked } = await import('../agent-config');
    const a = projectWith('a', JSON.stringify([{ id: 'pm', name: 'pm', color: 'indigo', createdAt: '', worktreePath: path.join(root, 'a', 'wt'), managed: { version: 1, blocks: [BUILTIN_BLOCK_IDS.projectManager], skills: [], mcps: [CLUBHOUSE_MCP_PART_ID] } }]));
    agents.set('pm', JSON.parse(fs.readFileSync(path.join(a, '.clubhouse', 'agents.json'), 'utf-8'))[0]);
    // The real read path: agent-config's peek, on real folders.
    await makeService({
      listProjects: async () => [{ path: a, name: 'a' }, { path: other, name: 'other' }],
      listAgentsChecked: (p) => peekDurableConfigsChecked(p),
    }).ensureBuiltins();
  }

  it('keeps them when a registered project\'s folder is gone (an unmounted drive)', async () => {
    await adoptWith(path.join(root, 'unmounted', 'project'));
    expect(agents.get('pm')!.managed!.blocks[0]).not.toBe(BUILTIN_BLOCK_IDS.projectManager);
    expect(await user(() => service.getPart(BUILTIN_BLOCK_IDS.projectManager))).toMatchObject({ builtin: true, retired: true });
    expect(await user(() => service.getPart(BUILTIN_BLOCK_IDS.reviewer))).toMatchObject({ builtin: true, retired: true });
  });

  it('keeps them when a project\'s agents.json doesn\'t parse', async () => {
    await adoptWith(projectWith('corrupt', '[{"id": "x", '));
    expect(await user(() => service.getPart(BUILTIN_BLOCK_IDS.projectManager))).toMatchObject({ builtin: true, retired: true });
  });

  it('removes them when the other project simply has no agents yet', async () => {
    await adoptWith(projectWith('empty', null));
    await expect(user(() => service.getPart(BUILTIN_BLOCK_IDS.projectManager))).rejects.toMatchObject({ code: 'not_found' });
    await expect(user(() => service.getPart(BUILTIN_BLOCK_IDS.reviewer))).rejects.toMatchObject({ code: 'not_found' });
  });

  it('keeps them when the project list can\'t be read', async () => {
    agent('pm', { managed: { version: 1, blocks: [BUILTIN_BLOCK_IDS.projectManager], skills: [], mcps: [CLUBHOUSE_MCP_PART_ID] } });
    await makeService({ listProjectsChecked: async () => ({ projects: [], readable: false }) }).ensureBuiltins();
    expect(await user(() => service.getPart(BUILTIN_BLOCK_IDS.reviewer))).toMatchObject({ builtin: true, retired: true });
  });
});

describe('the copy of the retired Post result skill (D74, D99)', () => {
  it('still leaves a skill folder the project tracks to the project, as the built-in did', async () => {
    const pm = agent('qa', { managed: { version: 1, blocks: [], skills: [BUILTIN_SKILL_IDS.postResult], mcps: [CLUBHOUSE_MCP_PART_ID] } });
    const wt = pm.worktreePath!;
    const { execFileSync } = await import('node:child_process');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: wt, stdio: 'ignore' });
    git('init', '-q');
    const own = path.join(wt, '.claude', 'skills', 'post-result');
    fs.mkdirSync(own, { recursive: true });
    fs.writeFileSync(path.join(own, 'SKILL.md'), '---\nname: post-result\ndescription: Ours.\n---\nPost it our way.\n');
    git('add', '.');
    git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'our post-result skill');
    await user(() => deliverManagedSetup({ service, projectPath: project, agent: pm, provider }));
    const before = filesOf(wt);
    expect(before[path.join('.claude', 'skills', 'post-result', 'SKILL.md')]).toContain('Post it our way.');

    await service.ensureBuiltins();
    const after = agents.get('qa')!;
    expect(after.managed!.skills[0]).not.toBe(BUILTIN_SKILL_IDS.postResult);
    await user(() => deliverManagedSetup({ service, projectPath: project, agent: after, provider }));
    const files = filesOf(wt);
    for (const f of Object.keys(files).filter((f) => !f.startsWith(`.git${path.sep}`))) expect(files[f], f).toBe(before[f]);
    expect(execFileSync('git', ['status', '--porcelain', '--', '.claude/skills/post-result'], { cwd: wt, encoding: 'utf-8' })).toBe('');
  });
});

describe('a copy cut short (D99)', () => {
  it('finds the copy made just before the app stopped instead of making a second one', async () => {
    agent('r', { managed: { version: 1, blocks: [BUILTIN_BLOCK_IDS.reviewer], skills: [], mcps: [CLUBHOUSE_MCP_PART_ID] } });
    // The intent was recorded and the catalog made the copy, then the app stopped before managed state said what it was.
    const at = new Date(Date.now() - 1000).toISOString();
    await state.update((s) => { s.retiredPending = { [BUILTIN_BLOCK_IDS.reviewer]: { name: 'Code reviewer', at } }; });
    const orphan = await withSettingsSurface('ui', undefined, () => catalog.createAsset({ kind: 'block', name: 'Code reviewer', payload: builtinParts().find((p) => p.id === BUILTIN_BLOCK_IDS.reviewer)!.payload as never }));
    await service.ensureBuiltins();
    const copies = (await user(() => service.listParts('block'))).filter((b) => b.name.startsWith('Code reviewer'));
    expect(copies.map((c) => c.id)).toEqual([orphan.id]);
    expect(copies[0].fromRetiredBuiltin).toBe(true);
    expect(agents.get('r')!.managed!.blocks).toEqual([orphan.id]);
    expect((await state.read()).retiredPending?.[BUILTIN_BLOCK_IDS.reviewer]).toBeUndefined();
  });
});
