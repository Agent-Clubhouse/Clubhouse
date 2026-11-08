/**
 * One data folder moved between an older and a newer Clubhouse build (#2930,
 * D100). Each "build" is the real service with its own built-in manifest,
 * loaded fresh, over the same catalog, managed state and agents: older, then
 * newer, then older again, then newer again.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DurableAgentConfig } from '../../../shared/types';
import { CLUBHOUSE_MCP_PART_ID, type ManagedTemplate } from '../../../shared/managed-agents-types';
import type { OrchestratorProvider } from '../../orchestrators/types';
import type { BuiltinPart } from './builtins';
import { BUILTIN_BLOCK_IDS, BUILTIN_SKILL_IDS, builtinParts, builtinTemplates } from './builtins';

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => os.tmpdir() } }));
vi.mock('../log-service', () => ({ appLog: vi.fn() }));

interface Build { parts: BuiltinPart[]; templates: ManagedTemplate[] }

const OLDER_ONLY = 'builtin-block-older-only';
const NEWER_ONLY = 'builtin-block-newer-only';
const NEWER_TEMPLATE = 'builtin-template-newer-only';
const NEWER_LINE = 'A line only the newer build ships.';
const NEWER_NAME = 'Basics, newer';
const OLDER_NAME = builtinParts().find((p) => p.id === BUILTIN_BLOCK_IDS.basics)!.name;

/** The older build: today's built-ins plus one block the newer build retires. */
function olderBuild(): Build {
  return {
    parts: [...builtinParts(), { id: OLDER_ONLY, kind: 'block', name: 'Older only', description: 'Cut in the newer build.', payload: { content: 'Older only block.' } }],
    templates: builtinTemplates(),
  };
}

/**
 * The newer build: the Basics block says more under a new name, the build skill gains a file,
 * one block and one template are new, and the older build's extra block is
 * retired (D99).
 */
function newerBuild(): Build {
  const parts = builtinParts().map((p): BuiltinPart => {
    if (p.id === BUILTIN_BLOCK_IDS.basics) return { ...p, name: NEWER_NAME, payload: { content: `${(p.payload as { content: string }).content}\n\n${NEWER_LINE}` } };
    if (p.id === BUILTIN_SKILL_IDS.build) {
      const payload = p.payload as { skillName: string; files: Array<{ path: string; content: string }> };
      return { ...p, payload: { ...payload, files: [...payload.files, { path: 'reference.md', content: 'Newer reference.\n' }] } };
    }
    return p;
  });
  parts.push(
    { id: NEWER_ONLY, kind: 'block', name: 'Newer only', description: 'New in the newer build.', payload: { content: 'Newer only block.' } },
    { id: OLDER_ONLY, kind: 'block', name: 'Older only', description: 'Cut in the newer build.', retired: true, payload: { content: 'Older only block.' } },
  );
  const templates = [...builtinTemplates(), {
    id: NEWER_TEMPLATE, name: 'Newer only', description: '', builtin: true as const,
    setup: { blocks: [BUILTIN_BLOCK_IDS.identity, NEWER_ONLY], skills: [], mcps: [CLUBHOUSE_MCP_PART_ID] }, settings: {},
  }];
  return { parts, templates };
}

let root: string;
let project: string;
let agents: Map<string, DurableAgentConfig>;

const provider = {
  id: 'claude-code', displayName: 'Claude Code',
  conventions: { configDir: '.claude', skillsDir: 'skills', mcpConfigFile: '.mcp.json', legacyInstructionsFile: 'CLAUDE.md', localSettingsFile: 'settings.local.json', settingsFormat: 'json' },
  writeInstructions: async (wt: string, content: string) => { fs.writeFileSync(path.join(wt, 'CLAUDE.md'), content); },
} as unknown as OrchestratorProvider;

/** Start a build over the shared data: fresh modules, its own manifest, then its startup install. */
async function start(build: Build) {
  vi.resetModules();
  vi.doMock('./builtins', async (importOriginal) => {
    const real = await importOriginal<typeof import('./builtins')>();
    return { ...real, builtinParts: () => structuredClone(build.parts), builtinTemplates: () => structuredClone(build.templates) };
  });
  const store = await import('../asset-catalog/store');
  const audit = await import('../settings-audit');
  const stateStore = await import('./state-store');
  const svc = await import('./service');
  const delivery = await import('./delivery');
  audit._resetSettingsAuditForTesting(false);
  const service = svc.createManagedAgentsService({
    catalog: store.createAssetCatalogStore({ dir: path.join(root, 'catalog') }),
    state: stateStore.createManagedStateStore(path.join(root, 'managed')),
    listProjects: async () => [{ path: project, name: 'Project' }],
    listAgents: async () => [...agents.values()],
    getAgent: async (_p, id) => agents.get(id) ?? null,
    setManagedSetup: async (_p, id, setup) => { const a = agents.get(id)!; if (setup) a.managed = setup; else delete a.managed; },
    isRunning: () => false,
    setHelperTemplate: async (_p, id, templateId) => { agents.get(id)!.helperTemplateId = templateId; },
  });
  await service.ensureBuiltins();
  const user = <T>(fn: () => Promise<T>) => audit.withSettingsSurface('ui', undefined, fn);
  return {
    service,
    user,
    /** What the agent's folder gets at its next start. */
    deliver: async (id: string) => {
      const a = agents.get(id)!;
      await user(() => delivery.deliverManagedSetup({ service, projectPath: project, agent: a, provider }));
      const skill = path.join(a.worktreePath!, '.claude', 'skills', 'build');
      return {
        instructions: fs.readFileSync(path.join(a.worktreePath!, 'CLAUDE.md'), 'utf-8'),
        skillFiles: fs.existsSync(skill) ? fs.readdirSync(skill).sort() : [],
      };
    },
  };
}

function agent(id: string, managed: DurableAgentConfig['managed']): DurableAgentConfig {
  const wt = path.join(project, '.clubhouse', 'agents', id);
  fs.mkdirSync(wt, { recursive: true });
  const a: DurableAgentConfig = { id, name: id, color: 'indigo', createdAt: '2026-11-07T00:00:00.000Z', worktreePath: wt, branch: `${id}/standby`, managed };
  agents.set(id, a);
  return a;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-downgrade-'));
  project = path.join(root, 'project');
  agents = new Map();
});

afterEach(() => {
  vi.doUnmock('./builtins');
  vi.resetModules();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('moving between an older and a newer build (D100)', () => {
  it('agents get what the running build ships, and keep what only the newer build had', async () => {
    agent('dev', {
      version: 1,
      blocks: [BUILTIN_BLOCK_IDS.identity, BUILTIN_BLOCK_IDS.basics, OLDER_ONLY],
      skills: [BUILTIN_SKILL_IDS.build],
      mcps: [CLUBHOUSE_MCP_PART_ID],
    });

    // ── Older build ──
    let build = await start(olderBuild());
    const older1 = await build.deliver('dev');
    expect(older1.instructions).not.toContain(NEWER_LINE);
    expect(older1.instructions).toContain('Older only block.');
    expect(older1.skillFiles).toEqual(['SKILL.md']);

    // ── Newer build ──
    build = await start(newerBuild());
    const newer1 = await build.deliver('dev');
    expect(newer1.instructions).toContain(NEWER_LINE);
    expect(newer1.skillFiles).toEqual(['SKILL.md', 'reference.md']);
    // The retired block is the person's own copy now (D99), with the same text.
    const copy = (await build.user(() => build.service.listParts('block'))).find((p) => p.name === 'Older only')!;
    expect(copy).toMatchObject({ builtin: false, fromRetiredBuiltin: true });
    expect(agents.get('dev')!.managed!.blocks).toEqual([BUILTIN_BLOCK_IDS.identity, BUILTIN_BLOCK_IDS.basics, copy.id]);
    expect(newer1.instructions).toContain('Older only block.');
    // A second agent uses what only the newer build has.
    agent('fresh', {
      version: 1, templateId: NEWER_TEMPLATE,
      blocks: [BUILTIN_BLOCK_IDS.identity, NEWER_ONLY],
      skills: [],
      mcps: [CLUBHOUSE_MCP_PART_ID],
    });
    const freshNewer = await build.deliver('fresh');
    expect(freshNewer.instructions).toContain('Newer only block.');
    expect((await build.user(() => build.service.getPart(BUILTIN_BLOCK_IDS.basics))).name).toBe(NEWER_NAME);
    // The person edits their copy.
    await build.user(() => build.service.updatePart({ id: copy.id, expectedRevision: copy.revision, content: { kind: 'block', content: 'Edited by the person.' } }));
    const edited = await build.deliver('dev');
    expect(edited.instructions).toContain('Edited by the person.');

    // ── Back to the older build ──
    build = await start(olderBuild());
    const older2 = await build.deliver('dev');
    // The built-ins it ships win: the newer line, name and file are gone. The edited copy stays the person's.
    expect(older2.instructions).toBe(edited.instructions.replace(`\n\n${NEWER_LINE}`, ''));
    expect(older2.instructions).not.toContain(NEWER_LINE);
    expect(older2.skillFiles).toEqual(['SKILL.md']);
    expect(agents.get('dev')!.managed!.blocks).toContain(copy.id);
    expect((await build.user(() => build.service.getPart(BUILTIN_BLOCK_IDS.basics))).name).toBe(OLDER_NAME);
    // A built-in only the newer build ships stays installed, read-only, with the text it had.
    const freshOlder = await build.deliver('fresh');
    expect(freshOlder.instructions).toBe(freshNewer.instructions);
    const newerOnly = await build.user(() => build.service.getPart(NEWER_ONLY));
    expect(newerOnly).toMatchObject({ builtin: true, name: 'Newer only' });
    // The template only the newer build ships isn't offered; the agent keeps its parts.
    const templates = await build.user(() => build.service.listTemplates());
    expect(templates.map((t) => t.id)).not.toContain(NEWER_TEMPLATE);
    expect(agents.get('fresh')!.managed!.blocks).toEqual([BUILTIN_BLOCK_IDS.identity, NEWER_ONLY]);
    // The block the newer build retired is a built-in again, for new setups and the older build's templates.
    const olderOnly = await build.user(() => build.service.getPart(OLDER_ONLY));
    expect(olderOnly).toMatchObject({ builtin: true });
    // An agent made on the older build uses it.
    agent('later', { version: 1, blocks: [BUILTIN_BLOCK_IDS.identity, OLDER_ONLY], skills: [], mcps: [CLUBHOUSE_MCP_PART_ID] });
    const laterOlder = await build.deliver('later');
    expect(laterOlder.instructions).toContain('Older only block.');

    // ── Newer build again ──
    build = await start(newerBuild());
    const newer2 = await build.deliver('dev');
    expect(newer2).toEqual(edited);
    // The later agent gets a copy of its own with the text it had: the earlier copy was edited, so it isn't reused (D99).
    const laterNewer = await build.deliver('later');
    expect(laterNewer).toEqual(laterOlder);
    const blocks = await build.user(() => build.service.listParts('block'));
    const copies = blocks.filter((p) => p.name.startsWith('Older only'));
    expect(copies.map((p) => p.name).sort()).toEqual(['Older only', 'Older only 2']);
    expect(copies.every((p) => !p.builtin)).toBe(true);
    expect(agents.get('later')!.managed!.blocks[1]).toBe(copies.find((p) => p.name === 'Older only 2')!.id);
    expect(agents.get('dev')!.managed!.blocks[2]).toBe(copy.id);
  }, 60_000);

  it('reuses the earlier copy for an agent made on the older build when the copy still has the built-in\'s text', async () => {
    agent('dev', { version: 1, blocks: [BUILTIN_BLOCK_IDS.identity, OLDER_ONLY], skills: [], mcps: [CLUBHOUSE_MCP_PART_ID] });
    await start(olderBuild());
    let build = await start(newerBuild());
    const copy = agents.get('dev')!.managed!.blocks[1];
    build = await start(olderBuild());
    agent('later', { version: 1, blocks: [BUILTIN_BLOCK_IDS.identity, OLDER_ONLY], skills: [], mcps: [CLUBHOUSE_MCP_PART_ID] });
    const before = await build.deliver('later');
    build = await start(newerBuild());
    expect(agents.get('later')!.managed!.blocks[1]).toBe(copy);
    expect(await build.deliver('later')).toEqual(before);
    const blocks = await build.user(() => build.service.listParts('block'));
    expect(blocks.filter((p) => p.name.startsWith('Older only')).map((p) => p.id)).toEqual([copy]);
  }, 60_000);
});
