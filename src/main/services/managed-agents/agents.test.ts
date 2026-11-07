import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  conventions: { configDir: '.claude', skillsDir: 'skills', mcpConfigFile: '.mcp.json', legacyInstructionsFile: 'CLAUDE.md', settingsFormat: 'json' } as Record<string, string>,
}));

vi.mock('../agent-config', () => ({
  getDurableConfig: async (_p: string, id: string) => h.agents.get(id) ?? null,
  updateDurableConfig: vi.fn(),
  createDurable: vi.fn(),
  deleteUnregister: vi.fn(),
}));
vi.mock('../orchestration-policy', () => ({ setOrchestrationPolicy: vi.fn(async () => ({ ok: true })) }));
vi.mock('../agent-system', () => ({
  resolveOrchestrator: async () => ({
    id: 'claude-code',
    conventions: h.conventions,
    readInstructions: async () => h.instructions,
  }),
}));
vi.mock('./index', () => ({ managedAgents: () => h.service }));
vi.mock('../git-exclude-manager', () => ({ addExclusions: vi.fn(async () => {}) }));
vi.mock('./state-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./state-store')>()),
  managedStateDir: () => h.stateDir,
}));

import { createAssetCatalogStore } from '../asset-catalog/store';
import { withSettingsSurface, _resetSettingsAuditForTesting } from '../settings-audit';
import { createManagedStateStore } from './state-store';
import { createManagedAgentsService, type ManagedAgentsService } from './service';
import * as agentConfig from '../agent-config';
import { convertToManaged, previewConvert, settingsForConvert } from './agents';

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

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-convert-'));
  wt = path.join(root, 'project', '.clubhouse', 'agents', 'ada');
  fs.mkdirSync(wt, { recursive: true });
  _resetSettingsAuditForTesting(false);
  h.stateDir = path.join(root, 'managed');
  h.instructions = '';
  h.conventions = { configDir: '.claude', skillsDir: 'skills', mcpConfigFile: '.mcp.json', legacyInstructionsFile: 'CLAUDE.md', settingsFormat: 'json' };
  h.agents.clear();
  h.agents.set('ada', { id: 'ada', name: 'ada', color: 'indigo', createdAt: '2026-11-07T00:00:00.000Z', worktreePath: wt });
  service = createManagedAgentsService({
    catalog: createAssetCatalogStore({ dir: path.join(root, 'catalog') }),
    state: createManagedStateStore(h.stateDir),
    listProjects: async () => [{ path: '/p', name: 'Project' }],
    listAgents: async () => [...h.agents.values()],
    getAgent: async (_p, id) => h.agents.get(id) ?? null,
    setManagedSetup: async (_p, id, setup: ManagedAgentSetup | null) => {
      const a = h.agents.get(id)!;
      if (setup) a.managed = setup; else delete a.managed;
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

  it('keeps the Clubhouse part off for an agent with its bridge off', async () => {
    h.agents.get('ada')!.mcpOverride = false;
    const setup = await user(() => convertToManaged('/p', 'ada', { keep: true }));
    expect(setup).toMatchObject({ blocks: [], skills: [], mcps: [] });
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
    expect(agentConfig.updateDurableConfig).toHaveBeenCalledWith('/p', 'ada', { freeAgentMode: true });
  });

  it('keeps a template model only when the template is for the agent\'s CLI', () => {
    expect(settingsForConvert('claude-code', { orchestrator: 'claude-code', model: 'opus' })).toEqual({ model: 'opus' });
    expect(settingsForConvert('claude-code', { model: 'opus', freeAgentMode: false })).toEqual({ model: 'opus', freeAgentMode: false });
    expect(settingsForConvert('claude-code', { orchestrator: 'codex-cli', model: 'gpt-5' })).toEqual({});
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
