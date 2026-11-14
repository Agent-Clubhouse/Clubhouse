import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DurableAgentConfig } from '../../../shared/types';
import type { ManagedAgentSetup } from '../../../shared/managed-agents-types';
import { CLUBHOUSE_MCP_PART_ID } from '../../../shared/managed-agents-types';

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => os.tmpdir() } }));
vi.mock('../log-service', () => ({ appLog: vi.fn() }));

const h = vi.hoisted(() => ({
  agents: new Map<string, DurableAgentConfig>(),
  service: null as unknown,
  stateDir: '',
  instructions: '',
  /** Read the instructions file from the worktree, as a real provider does. */
  instructionsFromDisk: false,
  conventions: { configDir: '.claude', skillsDir: 'skills', mcpConfigFile: '.mcp.json', legacyInstructionsFile: 'CLAUDE.md', settingsFormat: 'json' } as Record<string, string>,
  /** Clubhouse Mode on for the project. */
  clubhouseMode: false,
  /** What Clubhouse Mode would write at the next wake; null when nothing. */
  materialized: null as string | null,
  /** The skills and MCP servers Clubhouse Mode would deliver at the next wake. */
  modeDefaults: { skills: [] as Array<{ name: string; path: string }>, mcpJson: null as string | null, resolveText: (t: string) => t },
  /** The orchestration fields each persona decides, as the persona layer resolves them. */
  personaPolicy: {} as Record<string, Record<string, unknown>>,
  /** Calls into orchestration-policy, in order. */
  policyCalls: [] as string[],
  availability: { available: true } as { available: boolean; error?: string },
}));

vi.mock('../agent-config', () => ({
  getDurableConfig: async (_p: string, id: string) => h.agents.get(id) ?? null,
  updateDurableConfig: vi.fn(),
  createDurable: vi.fn(),
  deleteUnregister: vi.fn(),
  deleteDurable: vi.fn(async () => {}),
}));
/** A stand-in for the retired persona layer's carry; orchestration-policy.test and legacy-migration.test cover the real one. */
vi.mock('../orchestration-policy', () => ({
  setOrchestrationPolicy: vi.fn(async () => ({ ok: true })),
  carryPersonaOrchestration: vi.fn(async (_p: string, id: string) => {
    h.policyCalls.push('carry');
    const a = h.agents.get(id)!;
    const layer = (a.persona && h.personaPolicy[a.persona]) || {};
    const carried = Object.fromEntries(Object.entries(layer).filter(([k]) => (a.orchestration as Record<string, unknown> | undefined)?.[k] === undefined));
    if (Object.keys(carried).length === 0) return undefined;
    a.orchestration = { ...a.orchestration, ...carried };
    return carried;
  }),
}));
// Clubhouse Mode's old settings and what it would write (legacy-migration.test covers the real ones).
vi.mock('./legacy-migration', async (importOriginal) => ({
  ...await importOriginal<typeof import('./legacy-migration')>(),
  legacyClubhouseModeEnabled: () => h.clubhouseMode,
  materializedInstructions: vi.fn(async () => h.materialized),
  materializedDefaults: vi.fn(async () => h.modeDefaults),
}));
vi.mock('../agent-system', () => ({
  resolveOrchestrator: async (_projectPath: string, cli?: string) => ({
    id: cli ?? 'claude-code',
    displayName: cli === 'copilot-cli' ? 'Copilot CLI' : 'Claude Code',
    checkAvailability: async () => h.availability,
    conventions: h.conventions,
    readInstructions: async (worktree: string) => (h.instructionsFromDisk ? fs.readFileSync(path.join(worktree, 'CLAUDE.md'), 'utf-8') : h.instructions),
  }),
}));
vi.mock('./index', () => ({ managedAgents: () => h.service }));
vi.mock('../git-exclude-manager', () => ({ addExclusions: vi.fn(async () => {}), replaceExclusions: vi.fn(async () => {}) }));
vi.mock('./state-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./state-store')>()),
  managedStateDir: () => h.stateDir,
}));

import { createAssetCatalogStore } from '../asset-catalog/store';
import { withSettingsSurface, _resetSettingsAuditForTesting } from '../settings-audit';
import { createManagedStateStore } from './state-store';
import { createManagedAgentsService, type ManagedAgentsService } from './service';
import * as agentConfig from '../agent-config';
import * as orchestrationPolicy from '../orchestration-policy';
import * as materialization from './legacy-migration';
import { applyManagedSettings, convertToManaged, createManagedAgent, leftoverWildcards, previewConvert, settingsForConvert } from './agents';
import { keepInstructionsAtFirstStart } from './before-managed';

const user = <T>(fn: () => T) => withSettingsSurface('ui', undefined, fn);

let root: string;
let wt: string;
let service: ManagedAgentsService;

function write(rel: string, content: string | Buffer, mode?: number) {
  const file = path.join(wt, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  if (mode !== undefined) fs.chmodSync(file, mode);
}

// Installing every built-in writes each part to disk, which ran past the test
// timeout on a loaded Windows runner (#3122). Install them once per file and
// copy the result in for each test; ensureBuiltins then finds them current and
// writes nothing. Each test still has its own folder (#3027's pattern).
let seed: string;
beforeAll(async () => {
  seed = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-convert-seed-'));
  _resetSettingsAuditForTesting(false);
  await createManagedAgentsService({
    catalog: createAssetCatalogStore({ dir: path.join(seed, 'catalog') }),
    state: createManagedStateStore(path.join(seed, 'managed')),
    listProjects: async () => [], listAgents: async () => [], getAgent: async () => null, setManagedSetup: async () => {}, isRunning: () => false,
  }).ensureBuiltins();
});
afterAll(() => { fs.rmSync(seed, { recursive: true, force: true }); });

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-convert-'));
  for (const name of fs.readdirSync(seed)) fs.cpSync(path.join(seed, name), path.join(root, name), { recursive: true });
  wt = path.join(root, 'project', '.clubhouse', 'agents', 'ada');
  fs.mkdirSync(wt, { recursive: true });
  _resetSettingsAuditForTesting(false);
  h.stateDir = path.join(root, 'managed');
  h.instructions = '';
  h.instructionsFromDisk = false;
  h.clubhouseMode = false;
  h.materialized = null;
  h.modeDefaults = { skills: [], mcpJson: null, resolveText: (t) => t };
  vi.mocked(materialization.materializedDefaults).mockClear();
  h.personaPolicy = {};
  h.policyCalls = [];
  h.availability = { available: true };
  h.conventions = { configDir: '.claude', skillsDir: 'skills', mcpConfigFile: '.mcp.json', legacyInstructionsFile: 'CLAUDE.md', settingsFormat: 'json' };
  h.agents.clear();
  h.agents.set('ada', { id: 'ada', name: 'ada', color: 'indigo', createdAt: '2026-11-07T00:00:00.000Z', worktreePath: wt });
  service = createManagedAgentsService({
    catalog: createAssetCatalogStore({ dir: path.join(root, 'catalog') }),
    state: createManagedStateStore(h.stateDir),
    listProjects: async () => [{ path: '/p', name: 'Project' }],
    listAgents: async () => [...h.agents.values()],
    getAgent: async (_p, id) => h.agents.get(id) ?? null,
    // As agent-config's setManagedSetup does: saved legacy values stay, ignored while managed.
    setManagedSetup: async (_p, id, setup: ManagedAgentSetup | null) => {
      const a = h.agents.get(id)!;
      h.policyCalls.push('save');
      if (setup) {
        if (!a.managed && !a.switchedToManagedAt) a.switchedToManagedAt = new Date().toISOString();
        a.managed = setup;
      } else delete a.managed;
    },
    isRunning: () => false,
  });
  h.service = service;
  await service.ensureBuiltins();
});

function seedAgentFiles() {
  h.instructions = 'Ship small PRs.';
  write('.claude/skills/release-notes/SKILL.md', '# Release notes\nWrite them.');
  write('.claude/skills/release-notes/scripts/run.sh', '#!/bin/sh\necho hi\n', 0o755);
  write('.claude/skills/release-notes/logo.bin', Buffer.from([0, 1, 2, 255]));
  write('.claude/skills/no-entry/README.md', 'No SKILL.md here.');
  write('.mcp.json', JSON.stringify({
    mcpServers: {
      clubhouse: { command: 'clubhouse-bridge' },
      github: { command: 'npx', args: ['-y', '@github/mcp'], env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' } },
      docs: { type: 'http', url: 'https://docs.example.com/mcp' },
      leaky: { command: 'leaky', env: { API_TOKEN: 'sk-live-1234567890abcdef' } },
    },
  }));
}

describe('previewConvert', () => {
  it('names what becomes parts and what is not brought over, and writes nothing', async () => {
    seedAgentFiles();
    const preview = await user(() => previewConvert('/p', 'ada'));
    expect(preview.blocks).toEqual(['ada notes']);
    expect(preview.skills).toEqual(['release-notes']);
    expect(preview.mcps).toEqual(['github', 'docs', 'leaky']);
    expect(preview.notes).toEqual([
      "The no-entry skill isn't brought over because it has no SKILL.md.",
      "leaky: values for API_TOKEN aren't kept. Set them in your environment.",
      'Its .mcp.json is copied to .clubhouse-before-managed/.mcp.json in its folder before Clubhouse writes its own. The copy stays out of commits.',
    ]);
    expect(fs.existsSync(path.join(wt, '.clubhouse-before-managed'))).toBe(false);
    expect(h.agents.get('ada')!.managed).toBeUndefined();
    expect((await user(() => service.listParts('skill'))).filter((p) => !p.builtin)).toEqual([]);
    expect((await user(() => service.listParts('mcp'))).filter((p) => !p.builtin)).toEqual([]);
  });

  it('says MCP servers in a TOML file are not brought over', async () => {
    h.conventions = { ...h.conventions, mcpConfigFile: '.codex/config.toml', settingsFormat: 'toml' };
    const preview = await user(() => previewConvert('/p', 'ada'));
    expect(preview.notes).toEqual(["MCP servers in .codex/config.toml aren't brought over because Clubhouse can't read that format yet."]);
  });

  it('brings over a Codex agent\'s skills from .agents/skills and its earlier .codex/skills, the current folder winning', async () => {
    h.conventions = { configDir: '.codex', skillsDir: 'skills', skillsRoot: '.agents/skills', mcpConfigFile: '.codex/config.toml', legacyInstructionsFile: 'AGENTS.md', settingsFormat: 'toml' };
    (h.conventions as unknown as { previousSkillsRoots: string[] }).previousSkillsRoots = ['.codex/skills'];
    write('.agents/skills/ship/SKILL.md', '# Ship\nNew.');
    write('.codex/skills/ship/SKILL.md', '# Ship\nOld.');
    write('.codex/skills/notes/SKILL.md', '# Notes');
    const preview = await user(() => previewConvert('/p', 'ada'));
    expect(preview.skills).toEqual(['notes', 'ship']);
    const setup = await user(() => convertToManaged('/p', 'ada', { keep: true }));
    const contents = await Promise.all(setup.skills.map(async (id) => (await user(() => service.getPart(id))).content));
    expect(contents.map((c) => (c.kind === 'skill' ? [c.skillName, c.files[0].content] : null))).toEqual([['notes', '# Notes'], ['ship', '# Ship\nNew.']]);
  });

  it('says an unreadable MCP file is not brought over', async () => {
    write('.mcp.json', '{ not json');
    const preview = await user(() => previewConvert('/p', 'ada'));
    expect(preview.mcps).toEqual([]);
    expect(preview.notes).toEqual([
      "MCP servers in .mcp.json aren't brought over because the file isn't valid JSON.",
      'Its .mcp.json is copied to .clubhouse-before-managed/.mcp.json in its folder before Clubhouse writes its own. The copy stays out of commits.',
    ]);
  });
});

describe('convertToManaged with keep', () => {
  it('turns the instructions, skills and MCP servers into parts for this agent only', async () => {
    seedAgentFiles();
    const setup = await user(() => convertToManaged('/p', 'ada', { keep: true }));
    expect(setup.blocks).toHaveLength(1);
    expect(setup.skills).toHaveLength(1);
    expect(setup.mcps[0]).toBe(CLUBHOUSE_MCP_PART_ID);
    expect(setup.mcps).toHaveLength(4);
    // The env value never reaches a part; the original MCP file is kept in the agent's folder.
    const leaky = await user(() => service.getPart(setup.mcps[3]));
    expect(leaky.content).toEqual({ kind: 'mcp', serverKey: 'leaky', transport: 'stdio', command: 'leaky', envVars: ['API_TOKEN'] });
    expect(fs.readFileSync(path.join(wt, '.clubhouse-before-managed', '.mcp.json'), 'utf-8')).toContain('sk-live-1234567890abcdef');
    for (const file of fs.readdirSync(path.join(root, 'catalog'), { recursive: true }) as string[]) {
      const full = path.join(root, 'catalog', file);
      if (fs.statSync(full).isFile()) expect(fs.readFileSync(full, 'utf-8')).not.toContain('sk-live-1234567890abcdef');
    }

    const block = await user(() => service.getPart(setup.blocks[0]));
    expect(block.name).toBe('ada notes');
    expect(block.content).toEqual({ kind: 'block', content: 'Ship small PRs.' });

    const skill = await user(() => service.getPart(setup.skills[0]));
    expect(skill.name).toBe('release-notes, ada');
    expect(skill.usedBy.map((u) => u.agentId)).toEqual(['ada']);
    if (skill.content.kind !== 'skill') throw new Error('not a skill');
    expect(skill.content.skillName).toBe('release-notes');
    const files = Object.fromEntries(skill.content.files.map((f) => [f.path, f]));
    expect(files['SKILL.md'].content).toBe('# Release notes\nWrite them.');
    expect(files['logo.bin']).toMatchObject({ encoding: 'base64', content: Buffer.from([0, 1, 2, 255]).toString('base64') });
    if (process.platform !== 'win32') expect(files['scripts/run.sh'].executable).toBe(true);

    const [github, docs] = await Promise.all(setup.mcps.slice(1).map((id) => user(() => service.getPart(id))));
    expect(github.name).toBe('github, ada');
    expect(github.content).toMatchObject({ kind: 'mcp', serverKey: 'github', transport: 'stdio', command: 'npx', args: ['-y', '@github/mcp'], envVars: ['GITHUB_TOKEN'] });
    expect(docs.content).toMatchObject({ kind: 'mcp', serverKey: 'docs', transport: 'http', url: 'https://docs.example.com/mcp' });

    // The original instructions file is kept in app data.
    expect(fs.readFileSync(path.join(h.stateDir, 'before-managed', 'ada', 'CLAUDE.md'), 'utf-8')).toBe('Ship small PRs.');
  });

  it('names a part with a number when the name is taken', async () => {
    write('.claude/skills/notes/SKILL.md', 'x');
    await user(() => service.createPart({ name: 'notes, ada', content: { kind: 'skill', skillName: 'other', files: [{ path: 'SKILL.md', content: 'y' }] } }));
    const setup = await user(() => convertToManaged('/p', 'ada', { keep: true }));
    expect((await user(() => service.getPart(setup.skills[0]))).name).toBe('notes, ada 2');
  });

  it('always adds the Clubhouse part, whatever an old mcpOverride says (D69)', async () => {
    (h.agents.get('ada') as unknown as Record<string, unknown>).mcpOverride = false;
    const setup = await user(() => convertToManaged('/p', 'ada', { keep: true }));
    expect(setup).toMatchObject({ blocks: [], skills: [], mcps: [CLUBHOUSE_MCP_PART_ID] });
  });
});

describe('switched once, and backups that are never overwritten (#2901)', () => {
  const dir = () => path.join(h.stateDir, 'before-managed', 'ada');

  it('marks every switch from unmanaged to managed, and the mark stays after Stop managing', async () => {
    await user(() => convertToManaged('/p', 'ada', { keep: true }));
    const at = h.agents.get('ada')!.switchedToManagedAt;
    expect(at).toEqual(expect.any(String));
    await user(() => service.unmanage('/p', 'ada'));
    expect(h.agents.get('ada')!.managed).toBeUndefined();
    expect(h.agents.get('ada')!.switchedToManagedAt).toBe(at);
  });

  it('a second switch keeps a new copy beside the first, never over it', async () => {
    h.instructions = 'Before the first switch.';
    await user(() => convertToManaged('/p', 'ada', { keep: true }));
    await user(() => service.unmanage('/p', 'ada'));
    h.instructions = 'Before the second switch.';
    await user(() => convertToManaged('/p', 'ada', { keep: true }));
    const files = fs.readdirSync(dir()).filter((f) => f.startsWith('CLAUDE.md'));
    expect(files).toHaveLength(2);
    expect(fs.readFileSync(path.join(dir(), 'CLAUDE.md'), 'utf-8')).toBe('Before the first switch.');
    const second = files.find((f) => f !== 'CLAUDE.md')!;
    expect(second).toMatch(/^CLAUDE\.md\.\d+$/);
    expect(fs.readFileSync(path.join(dir(), second), 'utf-8')).toBe('Before the second switch.');
  });

  it('the first managed start compares against the copy its own switch made', async () => {
    h.instructionsFromDisk = true;
    write('CLAUDE.md', 'First.');
    await user(() => convertToManaged('/p', 'ada', { keep: true }));
    await user(() => service.unmanage('/p', 'ada'));
    write('CLAUDE.md', 'Second.');
    await user(() => convertToManaged('/p', 'ada', { keep: true }));
    const provider = { id: 'claude-code', conventions: h.conventions, readInstructions: async (w: string) => fs.readFileSync(path.join(w, 'CLAUDE.md'), 'utf-8') } as never;
    // Unchanged since this switch: nothing more is kept, though it differs from the first copy.
    await keepInstructionsAtFirstStart(h.agents.get('ada')!, provider);
    expect(fs.readdirSync(dir()).filter((f) => f.includes('first-start'))).toEqual([]);
  });

  it('a failed switch leaves no copy and no folder behind', async () => {
    h.instructions = 'Ship small PRs.';
    const saveSetup = service.saveSetup;
    service.saveSetup = vi.fn(async () => { throw new Error('disk full'); });
    try {
      await expect(user(() => convertToManaged('/p', 'ada', { keep: true }))).rejects.toThrow('disk full');
    } finally {
      service.saveSetup = saveSetup;
    }
    expect(fs.existsSync(dir())).toBe(false);
    expect(h.agents.get('ada')!.switchedToManagedAt).toBeUndefined();
  });
});

describe('a switch cut short (#2901)', () => {
  const pendingFile = () => path.join(h.stateDir, 'before-managed', 'ada', '.switch-pending.json');
  const custom = async (kind: 'block' | 'skill' | 'mcp') => (await user(() => service.listParts(kind))).filter((p) => !p.builtin);

  it('lists the parts in a pending file as they are made, and removes the file once saved', async () => {
    seedAgentFiles();
    const listed: string[][] = [];
    const saveSetup = service.saveSetup.bind(service);
    service.saveSetup = vi.fn(async (p, id, setup) => {
      listed.push((JSON.parse(fs.readFileSync(pendingFile(), 'utf-8')) as { parts: string[] }).parts);
      return saveSetup(p, id, setup);
    });
    const setup = await user(() => convertToManaged('/p', 'ada', { keep: true }));
    expect(listed).toEqual([[...setup.blocks, ...setup.skills, ...setup.mcps.filter((id) => id !== CLUBHOUSE_MCP_PART_ID)]]);
    expect(fs.existsSync(pendingFile())).toBe(false);
  });

  it('the next switch removes the parts an interrupted one made, then makes its own once', async () => {
    h.instructions = 'Ship small PRs.';
    // As a switch the app quit during leaves it: a part made, the pending file, no save.
    const leftover = await user(() => service.createPart({ name: 'ada notes', content: { kind: 'block', content: 'Ship small PRs.' } }));
    fs.mkdirSync(path.dirname(pendingFile()), { recursive: true });
    fs.writeFileSync(pendingFile(), JSON.stringify({ startedAt: new Date().toISOString(), parts: [leftover.id] }));

    const setup = await user(() => convertToManaged('/p', 'ada', { keep: true }));

    const blocks = await custom('block');
    expect(blocks.map((b) => b.id)).toEqual(setup.blocks);
    expect(blocks.map((b) => b.name)).toEqual(['ada notes']);
    expect(blocks[0].id).not.toBe(leftover.id);
    expect(fs.existsSync(pendingFile())).toBe(false);
  });

  it('keeps the parts of a switch that was saved before it was cut short', async () => {
    h.instructions = 'Ship small PRs.';
    const setup = await user(() => convertToManaged('/p', 'ada', { keep: true }));
    // The app quit right after the save: the pending file is still there.
    fs.mkdirSync(path.dirname(pendingFile()), { recursive: true });
    fs.writeFileSync(pendingFile(), JSON.stringify({ startedAt: '2026-01-01T00:00:00.000Z', parts: setup.blocks }));
    await user(() => service.unmanage('/p', 'ada'));
    await user(() => convertToManaged('/p', 'ada', { keep: true }));
    expect((await custom('block')).map((b) => b.id)).toContain(setup.blocks[0]);
  });

  it('a switch that finds the agent managed right before its save removes its own parts and stops', async () => {
    seedAgentFiles();
    const createPart = service.createPart.bind(service);
    let first = true;
    service.createPart = vi.fn(async (input) => {
      const part = await createPart(input);
      if (first) {
        first = false;
        // Another switch of this agent finishes meanwhile.
        h.agents.set('ada', { ...h.agents.get('ada')!, managed: { version: 1, blocks: [], skills: [], mcps: [] } });
      }
      return part;
    });
    await expect(user(() => convertToManaged('/p', 'ada', { keep: true }))).rejects.toThrow('already Clubhouse managed');
    for (const kind of ['block', 'skill', 'mcp'] as const) expect(await custom(kind)).toEqual([]);
    expect(h.agents.get('ada')!.managed).toEqual({ version: 1, blocks: [], skills: [], mcps: [] });
  });
});

describe('convertToManaged for an agent with a persona or Clubhouse Mode (#2901)', () => {
  it('keeps the instructions in its folder when Clubhouse Mode is off, and keeps the saved persona as setManagedSetup does', async () => {
    h.instructionsFromDisk = true;
    write('CLAUDE.md', 'You are ada. Build with npm run build.');
    write('.claude/skills/ship/SKILL.md', '# Ship\nOpen a PR.');
    h.agents.set('ada', { ...h.agents.get('ada')!, persona: 'qa' });

    const setup = await user(() => convertToManaged('/p', 'ada', { keep: true }));

    const block = await user(() => service.getPart(setup.blocks[0]));
    expect(block.content).toEqual({ kind: 'block', content: 'You are ada. Build with npm run build.' });
    const skill = await user(() => service.getPart(setup.skills[0]));
    expect(skill.content).toMatchObject({ kind: 'skill', skillName: 'ship' });
    expect(h.agents.get('ada')!.managed).toEqual(setup);
    // Nothing on disk changes until its next start.
    expect(fs.readFileSync(path.join(wt, 'CLAUDE.md'), 'utf-8')).toBe('You are ada. Build with npm run build.');
    expect(h.agents.get('ada')!.persona).toBe('qa');
    expect(vi.mocked(agentConfig.updateDurableConfig)).not.toHaveBeenCalledWith('/p', 'ada', expect.objectContaining({ clubhouseModeOverride: expect.anything() }));
  });

  it('an Orchestrator-persona agent with no own orchestration keeps orchestrate: true, carried before the save', async () => {
    h.personaPolicy = { orchestrator: { orchestrate: true } };
    h.agents.set('ada', { ...h.agents.get('ada')!, persona: 'orchestrator' });
    await user(() => convertToManaged('/p', 'ada', { keep: true }));
    expect(h.agents.get('ada')!.persona).toBe('orchestrator');
    expect(h.agents.get('ada')!.orchestration).toEqual({ orchestrate: true });
    expect(h.policyCalls).toEqual(['carry', 'save']);
    expect(orchestrationPolicy.carryPersonaOrchestration).toHaveBeenCalledWith('/p', 'ada');
  });

  it('does the same with a template', async () => {
    h.personaPolicy = { orchestrator: { orchestrate: true } };
    h.agents.set('ada', { ...h.agents.get('ada')!, persona: 'orchestrator' });
    const t = await user(() => service.saveTemplate({ name: 'Plain', description: '', setup: { blocks: [], skills: [], mcps: [] }, settings: {} }));
    await user(() => convertToManaged('/p', 'ada', { keep: false, templateId: t.id }));
    expect(h.agents.get('ada')!.orchestration).toEqual({ orchestrate: true });
    expect(h.policyCalls).toEqual(['carry', 'save']);
  });

  it('builds the block from what Clubhouse Mode would write, for one that never woke, and backs up the raw file', async () => {
    h.clubhouseMode = true;
    h.instructionsFromDisk = true;
    // Never woke: its folder still has the project template.
    write('CLAUDE.md', 'You are @@AgentName.\n@@If(github)\nOpen a PR.\n@@EndIf\n@@Persona');
    h.materialized = 'You are ada.\nOpen a PR.\n# QA\nTest everything.';
    const preview = await user(() => previewConvert('/p', 'ada'));
    expect(preview.notes).toEqual([]);
    const setup = await user(() => convertToManaged('/p', 'ada', { keep: true }));
    const block = await user(() => service.getPart(setup.blocks[0]));
    expect(block.content).toEqual({ kind: 'block', content: 'You are ada.\nOpen a PR.\n# QA\nTest everything.' });
    expect(fs.readFileSync(path.join(h.stateDir, 'before-managed', 'ada', 'CLAUDE.md'), 'utf-8')).toContain('@@If(github)');
  });

  it('uses the file for an agent with Clubhouse Mode off for it, or when Clubhouse Mode writes none', async () => {
    h.clubhouseMode = true;
    h.instructions = 'Mine.';
    h.materialized = 'From the project.';
    h.agents.set('ada', { ...h.agents.get('ada')!, clubhouseModeOverride: true });
    expect((await user(() => previewConvert('/p', 'ada'))).blocks).toEqual(['ada notes']);
    let setup = await user(() => convertToManaged('/p', 'ada', { keep: true }));
    expect((await user(() => service.getPart(setup.blocks[0]))).content).toEqual({ kind: 'block', content: 'Mine.' });

    h.agents.set('bo', { id: 'bo', name: 'bo', color: 'indigo', createdAt: '2026-11-07T00:00:00.000Z', worktreePath: wt });
    h.materialized = null;
    setup = await user(() => convertToManaged('/p', 'bo', { keep: true }));
    expect((await user(() => service.getPart(setup.blocks[0]))).content).toEqual({ kind: 'block', content: 'Mine.' });
  });

  it('lists @@ tokens a managed agent leaves as written', async () => {
    h.instructions = 'You are @@AgentName on @@StandbyBranch.\n@@If(github)\nPR\n@@EndIf\n@@Mission';
    const preview = await user(() => previewConvert('/p', 'ada'));
    expect(preview.notes).toEqual(["Its instructions still have @@If, @@EndIf and @@Mission, which a managed agent doesn't fill in. Edit the block after the switch."]);
    expect(leftoverWildcards('@@Path @@AgentName @@StandbyBranch')).toEqual([]);
    // The built-in build, test, lint and validate skills replace these for managed agents (#2902).
    expect(leftoverWildcards('@@BuildCommand @@TestCommand @@LintCommand @@SourceControlProvider')).toEqual([
      '@@BuildCommand', '@@TestCommand', '@@LintCommand', '@@SourceControlProvider',
    ]);
  });
});

describe('convertToManaged brings over what Clubhouse Mode would deliver', () => {
  /** A project source skill, as Clubhouse Mode copies from .clubhouse/skills. */
  function projectSkill(name: string, files: Record<string, string>) {
    const dir = path.join(root, 'project', '.clubhouse', 'skills', name);
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), content);
    }
    return { name, path: dir };
  }

  function projectDefaults() {
    h.modeDefaults = {
      skills: [projectSkill('review', { 'SKILL.md': '# Review\nReview as @@AgentName.' })],
      mcpJson: JSON.stringify({ mcpServers: { clubhouse: { command: 'clubhouse-bridge' }, linear: { command: 'npx', args: ['-y', 'linear-mcp'], env: { LINEAR_KEY: '${LINEAR_KEY}' } } } }),
      resolveText: (t) => t.replace(/@@AgentName/g, 'ada'),
    };
  }

  it('a Clubhouse Mode agent that never woke converts with the project default skill and MCP server, and the preview lists them', async () => {
    h.clubhouseMode = true;
    projectDefaults();
    const preview = await user(() => previewConvert('/p', 'ada'));
    expect(preview.skills).toEqual(['review']);
    expect(preview.mcps).toEqual(['linear']);
    expect(preview.notes).toEqual([]);

    const setup = await user(() => convertToManaged('/p', 'ada', { keep: true }));
    expect(setup.skills).toHaveLength(1);
    expect(setup.mcps).toHaveLength(2);
    expect(setup.mcps[0]).toBe(CLUBHOUSE_MCP_PART_ID);
    const skill = await user(() => service.getPart(setup.skills[0]));
    expect(skill.content).toEqual({ kind: 'skill', skillName: 'review', files: [{ path: 'SKILL.md', content: '# Review\nReview as ada.' }] });
    expect(skill.description).toContain("from the project's defaults");
    const mcp = await user(() => service.getPart(setup.mcps[1]));
    expect(mcp.content).toEqual({ kind: 'mcp', serverKey: 'linear', transport: 'stdio', command: 'npx', args: ['-y', 'linear-mcp'], envVars: ['LINEAR_KEY'] });
  });

  it('runs the defaults through the same checks and notes as the folder', async () => {
    h.clubhouseMode = true;
    h.modeDefaults = {
      skills: [projectSkill('no-entry', { 'README.md': 'No SKILL.md.' })],
      mcpJson: JSON.stringify({ mcpServers: { leaky: { command: 'leaky', env: { API_TOKEN: 'sk-live-1234567890abcdef' } } } }),
      resolveText: (t) => t,
    };
    const preview = await user(() => previewConvert('/p', 'ada'));
    expect(preview.skills).toEqual([]);
    expect(preview.mcps).toEqual(['leaky']);
    expect(preview.notes).toEqual([
      "The no-entry skill isn't brought over because it has no SKILL.md.",
      "leaky: values for API_TOKEN aren't kept. Set them in your environment.",
    ]);
    const setup = await user(() => convertToManaged('/p', 'ada', { keep: true }));
    expect((await user(() => service.getPart(setup.mcps[1]))).content).toEqual({ kind: 'mcp', serverKey: 'leaky', transport: 'stdio', command: 'leaky', envVars: ['API_TOKEN'] });

    h.agents.set('bo', { id: 'bo', name: 'bo', color: 'indigo', createdAt: '2026-11-07T00:00:00.000Z', worktreePath: wt });
    h.modeDefaults = { skills: [], mcpJson: '{ not json', resolveText: (t) => t };
    expect((await user(() => previewConvert('/p', 'bo'))).notes).toEqual(["The project's default MCP servers aren't brought over because they aren't valid JSON."]);
  });

  it("the folder's copy of a skill or MCP server wins, and the preview says so", async () => {
    h.clubhouseMode = true;
    projectDefaults();
    write('.claude/skills/review/SKILL.md', '# Review\nMy own way.');
    write('.mcp.json', JSON.stringify({ mcpServers: { linear: { command: 'linear-local' } } }));
    const preview = await user(() => previewConvert('/p', 'ada'));
    expect(preview.skills).toEqual(['review']);
    expect(preview.mcps).toEqual(['linear']);
    expect(preview.notes).toEqual([
      "The review skill in its folder is kept over the project's default of the same name.",
      "The linear MCP server in its .mcp.json is kept over the project's default of the same name.",
      'Its .mcp.json is copied to .clubhouse-before-managed/.mcp.json in its folder before Clubhouse writes its own. The copy stays out of commits.',
    ]);
    const setup = await user(() => convertToManaged('/p', 'ada', { keep: true }));
    expect(setup.skills).toHaveLength(1);
    expect((await user(() => service.getPart(setup.skills[0]))).content).toMatchObject({ files: [{ path: 'SKILL.md', content: '# Review\nMy own way.' }] });
    expect(setup.mcps).toHaveLength(2);
    expect((await user(() => service.getPart(setup.mcps[1]))).content).toMatchObject({ serverKey: 'linear', command: 'linear-local' });
  });

  it('says nothing when the folder holds what Clubhouse Mode last delivered', async () => {
    h.clubhouseMode = true;
    projectDefaults();
    // Woke: its folder has the resolved copies.
    write('.claude/skills/review/SKILL.md', '# Review\nReview as ada.');
    write('.mcp.json', h.modeDefaults.mcpJson!);
    const preview = await user(() => previewConvert('/p', 'ada'));
    expect(preview.skills).toEqual(['review']);
    expect(preview.mcps).toEqual(['linear']);
    expect(preview.notes).toEqual(['Its .mcp.json is copied to .clubhouse-before-managed/.mcp.json in its folder before Clubhouse writes its own. The copy stays out of commits.']);
  });

  it('a plain unmanaged agent, or one with Clubhouse Mode off for it, gets only what is in its folder', async () => {
    projectDefaults();
    write('.claude/skills/ship/SKILL.md', '# Ship\nOpen a PR.');
    let preview = await user(() => previewConvert('/p', 'ada'));
    expect(preview.skills).toEqual(['ship']);
    expect(preview.mcps).toEqual([]);
    expect(preview.notes).toEqual([]);
    expect(materialization.materializedDefaults).not.toHaveBeenCalled();
    const setup = await user(() => convertToManaged('/p', 'ada', { keep: true }));
    expect(setup.skills).toHaveLength(1);
    expect(setup.mcps).toEqual([CLUBHOUSE_MCP_PART_ID]);

    h.clubhouseMode = true;
    h.agents.set('bo', { id: 'bo', name: 'bo', color: 'indigo', createdAt: '2026-11-07T00:00:00.000Z', worktreePath: wt, clubhouseModeOverride: true });
    preview = await user(() => previewConvert('/p', 'bo'));
    expect(preview.skills).toEqual(['ship']);
    expect(preview.mcps).toEqual([]);
    expect(materialization.materializedDefaults).not.toHaveBeenCalled();
  });
});

describe('a switch that fails (#2901)', () => {
  it('checks the setup before making any part, so a skill folder clash leaves nothing behind', async () => {
    write('.claude/skills/Ship/SKILL.md', '# Ship');
    write('.claude/skills/ship/SKILL.md', '# ship');
    // A case-insensitive file system has only one of the two.
    if (fs.readdirSync(path.join(wt, '.claude', 'skills')).length < 2) return;
    h.instructions = 'Ship small PRs.';
    await expect(user(() => convertToManaged('/p', 'ada', { keep: true }))).rejects.toThrow(/^(Ship and ship|ship and Ship) both install to (ship|Ship)\/\. Pick one\.$/);
    expect((await user(() => service.listParts('block'))).filter((p) => !p.builtin)).toEqual([]);
    expect((await user(() => service.listParts('skill'))).filter((p) => !p.builtin)).toEqual([]);
    expect(h.policyCalls).toEqual([]);
  });

  it('checkSetup counts the planned skill folders, ignoring case', async () => {
    await expect(user(() => service.checkSetup({ blocks: [], skills: [], mcps: [] }, { skillFolders: ['Ship', 'ship'] }))).rejects.toThrow('Ship and ship both install to ship/. Pick one.');
    await expect(user(() => service.checkSetup({ blocks: [], skills: [], mcps: [CLUBHOUSE_MCP_PART_ID] }, { skillFolders: ['ship', 'review'] }))).resolves.toMatchObject({ mcps: [CLUBHOUSE_MCP_PART_ID] });
  });

  it('removes the parts it made when the save fails, and keeps the carried fields: no persona layer would give them back', async () => {
    seedAgentFiles();
    h.personaPolicy = { orchestrator: { orchestrate: true } };
    h.agents.set('ada', { ...h.agents.get('ada')!, persona: 'orchestrator' });
    const saveSetup = service.saveSetup;
    service.saveSetup = vi.fn(async () => { throw new Error('disk full'); });
    try {
      await expect(user(() => convertToManaged('/p', 'ada', { keep: true }))).rejects.toThrow('disk full');
    } finally {
      service.saveSetup = saveSetup;
    }
    for (const kind of ['block', 'skill', 'mcp'] as const) {
      expect((await user(() => service.listParts(kind))).filter((p) => !p.builtin)).toEqual([]);
    }
    expect(h.agents.get('ada')!.orchestration).toEqual({ orchestrate: true });
    expect(h.agents.get('ada')!.managed).toBeUndefined();
    expect(h.policyCalls).toEqual(['carry']);
    expect(fs.existsSync(path.join(h.stateDir, 'before-managed', 'ada', '.awaiting-first-start'))).toBe(false);
  });
});

describe('the first managed start after a switch (#2901)', () => {
  const provider = () => ({
    id: 'claude-code',
    conventions: h.conventions,
    readInstructions: async (worktree: string) => fs.readFileSync(path.join(worktree, 'CLAUDE.md'), 'utf-8'),
  }) as never;
  const dir = () => path.join(h.stateDir, 'before-managed', 'ada');

  it('keeps the instructions a running session changed after the switch, once', async () => {
    h.instructionsFromDisk = true;
    write('CLAUDE.md', 'Ship small PRs.');
    await user(() => convertToManaged('/p', 'ada', { keep: true }));
    // The session that was running edits the file before it stops.
    write('CLAUDE.md', 'Ship small PRs. Also: run the linter.');
    await keepInstructionsAtFirstStart(h.agents.get('ada')!, provider());
    expect(fs.readFileSync(path.join(dir(), 'CLAUDE.md'), 'utf-8')).toBe('Ship small PRs.');
    expect(fs.readFileSync(path.join(dir(), 'CLAUDE.first-start.md'), 'utf-8')).toBe('Ship small PRs. Also: run the linter.');

    // Later starts write the managed file and keep nothing more.
    write('CLAUDE.md', 'Managed.');
    await keepInstructionsAtFirstStart(h.agents.get('ada')!, provider());
    expect(fs.readFileSync(path.join(dir(), 'CLAUDE.first-start.md'), 'utf-8')).toBe('Ship small PRs. Also: run the linter.');
  });

  it('keeps nothing more when the file is as it was at the switch', async () => {
    h.instructionsFromDisk = true;
    write('CLAUDE.md', 'Ship small PRs.');
    await user(() => convertToManaged('/p', 'ada', { keep: true }));
    await keepInstructionsAtFirstStart(h.agents.get('ada')!, provider());
    expect(fs.readdirSync(dir())).toEqual(['CLAUDE.md']);
  });
});

describe('convert acceptance (#2819)', () => {
  it('runs block validation in the preview, so a refused instructions file becomes a note and no block', async () => {
    h.instructions = '---\nmodel: opus\n---\nShip small PRs.';
    const preview = await user(() => previewConvert('/p', 'ada'));
    expect(preview.blocks).toEqual([]);
    expect(preview.notes).toEqual(["CLAUDE.md isn't brought over as a block because its front matter sets a model or CLI, which belong in the agent's settings. Clubhouse keeps a copy in its app data."]);
    const setup = await user(() => convertToManaged('/p', 'ada', { keep: true }));
    expect(setup.blocks).toEqual([]);
    expect(fs.readFileSync(path.join(h.stateDir, 'before-managed', 'ada', 'CLAUDE.md'), 'utf-8')).toContain('Ship small PRs.');
  });

  it('says a skill with a credentials file is not brought over, in words', async () => {
    write('.claude/skills/deploy/SKILL.md', '# Deploy');
    write('.claude/skills/deploy/.env', 'X=1');
    const preview = await user(() => previewConvert('/p', 'ada'));
    expect(preview.skills).toEqual([]);
    expect(preview.notes).toEqual(["The deploy skill isn't brought over because it contains a credentials file (such as .env or a key file), and Clubhouse stores no secrets."]);
  });

  it('with a template keeps the agent\'s CLI, so it keeps its conversation (D51)', async () => {
    const t = await user(() => service.saveTemplate({ name: 'Other CLI', description: '', setup: { blocks: [], skills: [], mcps: [] }, settings: { orchestrator: 'codex-cli', model: 'gpt-5', freeAgentMode: true } }));
    vi.mocked(agentConfig.updateDurableConfig).mockClear();
    await user(() => convertToManaged('/p', 'ada', { keep: false, templateId: t.id }));
    // A template saved before #2761 reads with the app's old mode (skip-all by default): Full access.
    expect(agentConfig.updateDurableConfig).toHaveBeenCalledWith('/p', 'ada', { access: 'full_access' });
  });

  it('keeps a template model only when the template is for the agent\'s CLI', () => {
    expect(settingsForConvert('claude-code', { orchestrator: 'claude-code', model: 'opus' })).toEqual({ model: 'opus' });
    expect(settingsForConvert('claude-code', { model: 'opus', freeAgentMode: false })).toEqual({ model: 'opus', freeAgentMode: false });
    expect(settingsForConvert('claude-code', { orchestrator: 'codex-cli', model: 'gpt-5' })).toEqual({});
    // An effort is for a model, so it follows the model's rule (#2895).
    expect(settingsForConvert('claude-code', { orchestrator: 'codex-cli', model: 'gpt-5', effort: 'xhigh', idleSleep: 30 })).toEqual({ idleSleep: 30 });
    expect(settingsForConvert('claude-code', { effort: 'high', helperTemplateId: 'builtin-template-helper' })).toEqual({ effort: 'high', helperTemplateId: 'builtin-template-helper' });
    // Only for the model the agent will run: the template's, or its own when that is the same (D81).
    expect(settingsForConvert('claude-code', { effort: 'high' }, 'sonnet')).toEqual({});
    expect(settingsForConvert('claude-code', { model: 'opus', effort: 'high' }, 'sonnet')).toEqual({ model: 'opus', effort: 'high' });
    expect(settingsForConvert('claude-code', { orchestrator: 'codex-cli', model: 'opus', effort: 'high' }, 'opus')).toEqual({});
  });

  it('copies the MCP file aside once, and a second copy never overwrites the first', async () => {
    write('.mcp.json', JSON.stringify({ mcpServers: {} }));
    write('.clubhouse-before-managed/.mcp.json', 'earlier');
    await user(() => convertToManaged('/p', 'ada', { keep: true }));
    const kept = fs.readdirSync(path.join(wt, '.clubhouse-before-managed'));
    expect(kept).toHaveLength(2);
    expect(fs.readFileSync(path.join(wt, '.clubhouse-before-managed', '.mcp.json'), 'utf-8')).toBe('earlier');
    // The original stays until the first managed start rewrites it.
    expect(fs.existsSync(path.join(wt, '.mcp.json'))).toBe(true);
  });
});

describe('applying settings a template or the builder carries (#2895)', () => {
  beforeEach(() => {
    vi.mocked(agentConfig.updateDurableConfig).mockClear();
    vi.mocked(orchestrationPolicy.setOrchestrationPolicy).mockClear();
    vi.mocked(agentConfig.createDurable).mockReset();
  });

  it('writes each to the agent\'s own setting: effort with the CLI and model in one write, null back to the default', async () => {
    await applyManagedSettings('/p', 'ada', {
      orchestrator: 'codex-cli', model: 'gpt-5', effort: 'high', freeAgentMode: true, idleSleep: 30, helperTemplateId: 'builtin-template-quality-assurance',
      orchestration: { orchestrate: true, maxHelpers: 3, autoHelpers: true, connectToDispatcher: false, control: 'ask-before-start' },
    });
    expect(agentConfig.updateDurableConfig).toHaveBeenCalledTimes(1);
    expect(agentConfig.updateDurableConfig).toHaveBeenCalledWith('/p', 'ada', {
      orchestrator: 'codex-cli', model: 'gpt-5', effort: 'high', freeAgentMode: true, idleSleep: 30, helperTemplateId: 'builtin-template-quality-assurance',
    });
    expect(orchestrationPolicy.setOrchestrationPolicy).toHaveBeenCalledWith('/p', 'ada', { orchestrate: true, maxHelpers: 3, autoHelpers: true, connectToDispatcher: false, control: 'ask-before-start' });
    await applyManagedSettings('/p', 'ada', { effort: null, idleSleep: null, helperTemplateId: null });
    expect(agentConfig.updateDurableConfig).toHaveBeenLastCalledWith('/p', 'ada', { effort: null, idleSleep: null, helperTemplateId: null });
  });

  it('forwards per-consumer authorization to both native settings and orchestration writes', async () => {
    const guard = { prepare: vi.fn(async () => undefined), check: vi.fn() };
    await applyManagedSettings('/p', 'ada', { model: 'opus', orchestration: { maxHelpers: 2 } }, undefined, guard);
    expect(agentConfig.updateDurableConfig).toHaveBeenCalledExactlyOnceWith('/p', 'ada', { model: 'opus' }, undefined, guard);
    expect(orchestrationPolicy.setOrchestrationPolicy).toHaveBeenCalledExactlyOnceWith('/p', 'ada', { maxHelpers: 2 }, { agentPrecondition: guard });
  });

  it('applies a level as Access, which wins over the legacy flag beside it (#2761)', async () => {
    await applyManagedSettings('/p', 'ada', { access: 'auto_edit', freeAgentMode: false });
    expect(agentConfig.updateDurableConfig).toHaveBeenLastCalledWith('/p', 'ada', { access: 'auto_edit' });
  });

  it('create from a template applies what createDurable doesn\'t take: effort, auto-sleep, helper template and orchestration', async () => {
    const t = await user(() => service.saveTemplate({
      name: 'Lead', description: '', setup: { blocks: [], skills: [], mcps: [] },
      settings: { orchestrator: 'claude-code', model: 'opus', effort: 'high', idleSleep: 'never', helperTemplateId: 'builtin-template-quality-assurance', orchestration: { orchestrate: true, maxHelpers: 3 } },
    }));
    vi.mocked(agentConfig.createDurable).mockImplementation(async (_p, name) => {
      const made: DurableAgentConfig = { id: 'made', name, color: 'indigo', createdAt: '2026-11-07T00:00:00.000Z', worktreePath: wt };
      h.agents.set('made', made);
      return made;
    });
    await user(() => createManagedAgent('/p', { name: 'lead', color: 'indigo', templateId: t.id }));
    expect(agentConfig.createDurable).toHaveBeenCalledWith('/p', 'lead', 'indigo', 'opus', true, 'claude-code', undefined);
    expect(agentConfig.updateDurableConfig).toHaveBeenCalledWith('/p', 'made', { effort: 'high', idleSleep: 'never', helperTemplateId: 'builtin-template-quality-assurance' });
    expect(orchestrationPolicy.setOrchestrationPolicy).toHaveBeenCalledWith('/p', 'made', { orchestrate: true, maxHelpers: 3 });
  });

  it('never asks to copy the project\'s legacy defaults, for a managed or a plain agent (#3243, #3245)', async () => {
    vi.mocked(agentConfig.createDurable).mockImplementation(async (_p, name) => {
      const made: DurableAgentConfig = { id: `made-${name}`, name, color: 'indigo', createdAt: '2026-11-09T00:00:00.000Z', worktreePath: wt };
      h.agents.set(made.id, made);
      return made;
    });
    await user(() => createManagedAgent('/p', { name: 'scratch', color: 'indigo', settings: { orchestrator: 'copilot-cli' } }));
    expect(vi.mocked(agentConfig.createDurable).mock.lastCall).toHaveLength(7);
    await user(() => createManagedAgent('/p', { name: 'plain', color: 'indigo', managed: false, settings: { orchestrator: 'copilot-cli' } }));
    expect(vi.mocked(agentConfig.createDurable).mock.lastCall).toHaveLength(7);
  });

  it.each([false, true])('refuses an unavailable resolved CLI before making an agent or saving setup (plain: %s)', async (plain) => {
    h.availability = { available: false, error: 'Claude Code was not found in PATH.' };
    const save = vi.spyOn(service, 'saveSetup');
    await expect(user(() => createManagedAgent(path.resolve('project'), {
      name: 'unavailable', color: 'indigo', ...(plain && { managed: false as const }),
    }))).rejects.toThrow('Claude Code is unavailable. Claude Code was not found in PATH.');
    expect(agentConfig.createDurable).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    save.mockRestore();
  });

  it('passes a renderer request id through without opting in to legacy defaults', async () => {
    vi.mocked(agentConfig.createDurable).mockResolvedValue(h.agents.get('ada')!);
    await user(() => createManagedAgent(path.resolve('project'), {
      name: 'requested', color: 'indigo', creationRequestId: 'creating_request',
      settings: { orchestrator: 'copilot-cli' },
    }));
    expect(agentConfig.createDurable).toHaveBeenCalledWith(path.resolve('project'), 'requested', 'indigo', undefined, true, 'copilot-cli', undefined,
      undefined, undefined, undefined, { creationRequestId: 'creating_request' });
  });

  it('creates each listed built-in template with the available CLI selected by the page', async () => {
    const projectPath = path.resolve('project');
    vi.mocked(agentConfig.createDurable).mockImplementation(async (_projectPath, name, color, _model, _worktree, orchestrator) => {
      const made: DurableAgentConfig = { id: name, name, color, orchestrator, worktreePath: wt, createdAt: '2026-11-10T00:00:00Z' };
      h.agents.set(made.id, made);
      return made;
    });
    const templates = (await user(() => service.listTemplates())).filter((template) => template.builtin && !template.retired);
    expect(templates.length).toBeGreaterThan(0);
    for (const [index, template] of templates.entries()) {
      const made = await user(() => createManagedAgent(projectPath, {
        name: `template-${index}`, color: 'indigo', templateId: template.id, settings: { orchestrator: 'copilot-cli' },
      }));
      expect(made.orchestrator).toBe('copilot-cli');
    }
    expect(agentConfig.createDurable).toHaveBeenCalledTimes(templates.length);
  });

  it('removes a managed agent whose setup could not be saved, with the folder it was just given (#3243)', async () => {
    vi.mocked(agentConfig.createDurable).mockImplementation(async (_p, name) => {
      const made: DurableAgentConfig = { id: 'half', name, color: 'indigo', createdAt: '2026-11-09T00:00:00.000Z', worktreePath: wt };
      h.agents.set(made.id, made);
      return made;
    });
    vi.mocked(agentConfig.deleteDurable).mockClear();
    const save = vi.spyOn(service, 'saveSetup').mockRejectedValueOnce(new Error('disk full'));
    await expect(user(() => createManagedAgent('/p', { name: 'half', color: 'indigo' }))).rejects.toThrow('disk full');
    expect(agentConfig.deleteDurable).toHaveBeenCalledWith('/p', 'half');
    expect(agentConfig.deleteUnregister).not.toHaveBeenCalled();
    save.mockRestore();
  });

  it('a caller\'s legacy off wins over a template\'s level (#2761)', async () => {
    const t = await user(() => service.saveTemplate({
      name: 'Free', description: '', setup: { blocks: [], skills: [], mcps: [] }, settings: { orchestrator: 'claude-code', access: 'full_access' },
    }));
    vi.mocked(agentConfig.createDurable).mockImplementation(async (_p, name) => {
      const made: DurableAgentConfig = { id: 'made2', name, color: 'indigo', createdAt: '2026-11-07T00:00:00.000Z', worktreePath: wt };
      h.agents.set('made2', made);
      return made;
    });
    await user(() => createManagedAgent('/p', { name: 'off', color: 'indigo', templateId: t.id, settings: { freeAgentMode: false } }));
    expect(agentConfig.createDurable).toHaveBeenLastCalledWith('/p', 'off', 'indigo', undefined, true, 'claude-code', 'ask');
    await user(() => createManagedAgent('/p', { name: 'tmpl', color: 'indigo', templateId: t.id }));
    expect(agentConfig.createDurable).toHaveBeenLastCalledWith('/p', 'tmpl', 'indigo', undefined, true, 'claude-code', 'full_access');
  });

  it('a caller\'s legacy on/off keeps the template\'s level when it is already on that side (#2997)', async () => {
    let n = 0;
    vi.mocked(agentConfig.createDurable).mockImplementation(async (_p, name) => {
      const made: DurableAgentConfig = { id: `m${++n}`, name, color: 'indigo', createdAt: '2026-11-07T00:00:00.000Z', worktreePath: wt };
      h.agents.set(made.id, made);
      return made;
    });
    const auto = await user(() => service.saveTemplate({ name: 'Auto', description: '', setup: { blocks: [], skills: [], mcps: [] }, settings: { orchestrator: 'claude-code', access: 'auto' } }));
    const plan = await user(() => service.saveTemplate({ name: 'Plan', description: '', setup: { blocks: [], skills: [], mcps: [] }, settings: { orchestrator: 'claude-code', access: 'plan' } }));
    await user(() => createManagedAgent('/p', { name: 'on', color: 'indigo', templateId: auto.id, settings: { freeAgentMode: true } }));
    expect(agentConfig.createDurable).toHaveBeenLastCalledWith('/p', 'on', 'indigo', undefined, true, 'claude-code', 'auto');
    await user(() => createManagedAgent('/p', { name: 'off', color: 'indigo', templateId: plan.id, settings: { freeAgentMode: false } }));
    expect(agentConfig.createDurable).toHaveBeenLastCalledWith('/p', 'off', 'indigo', undefined, true, 'claude-code', 'plan');
    // A level the caller names wins over the legacy flag it read back beside it.
    await user(() => createManagedAgent('/p', { name: 'named', color: 'indigo', templateId: auto.id, settings: { access: 'plan', freeAgentMode: true } }));
    expect(agentConfig.createDurable).toHaveBeenLastCalledWith('/p', 'named', 'indigo', undefined, true, 'claude-code', 'plan');
  });
});
