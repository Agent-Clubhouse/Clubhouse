import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DurableAgentConfig, ProjectAgentDefaults } from '../../shared/types';

// The project's legacy defaults (#3245) over real files and the real parts
// library: only the agent list, the CLI and where the library keeps its state
// are faked.

const h = vi.hoisted(() => ({
  defaults: {} as Record<string, unknown>,
  agents: [] as DurableAgentConfig[],
  provider: null as unknown,
  service: null as unknown,
  stateDir: '',
  projectPath: '',
  updates: [] as Array<{ id: string; fields: Record<string, unknown> }>,
}));

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => os.tmpdir() } }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./source-control-settings', () => ({ effectiveAppSourceControlProvider: () => 'github' }));
vi.mock('./agent-settings-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./agent-settings-service')>()),
  readProjectAgentDefaults: async () => h.defaults,
}));
vi.mock('./agent-config', () => ({
  listDurable: async () => h.agents,
  getDurableConfig: async (_p: string, id: string) => h.agents.find((a) => a.id === id) ?? null,
  updateDurableConfig: async (_p: string, id: string, fields: Record<string, unknown>) => { h.updates.push({ id, fields }); },
  isSameProject: async (a: string, b: string) => path.resolve(a) === path.resolve(b),
}));
vi.mock('./agent-system', () => ({ resolveOrchestrator: async () => h.provider }));
vi.mock('./project-store', () => ({ list: async () => [{ id: 'proj_app', name: 'app', path: h.projectPath }] }));
vi.mock('./managed-agents', () => ({ managedAgents: () => h.service }));
vi.mock('./managed-agents/state-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./managed-agents/state-store')>()),
  managedStateDir: () => h.stateDir,
}));

import { createAssetCatalogStore } from './asset-catalog/store';
import { createManagedStateStore } from './managed-agents/state-store';
import { createManagedAgentsService, type ManagedAgentsService } from './managed-agents/service';
import { withSettingsSurface, _resetSettingsAuditForTesting } from './settings-audit';
import {
  copyIntoAgent,
  describeLegacyDefaults,
  importAsParts,
  legacyDefaultsNotCopied,
  previewCopyIntoAgent,
  previewCopyIntoNewAgent,
  previewImportAsParts,
} from './legacy-defaults';

const user = <T>(fn: () => T) => withSettingsSurface('ui', undefined, fn);

function provider(over: Record<string, unknown> = {}) {
  const conventions = { configDir: '.claude', skillsDir: 'skills', mcpConfigFile: '.mcp.json', legacyInstructionsFile: 'CLAUDE.md', localSettingsFile: 'settings.local.json', settingsFormat: 'json', ...over };
  return {
    id: 'claude-code',
    displayName: 'Claude Code',
    conventions,
    readInstructions: async (wt: string) => fs.readFileSync(path.join(wt, 'CLAUDE.md'), 'utf-8'),
    writeInstructions: async (wt: string, content: string) => { fs.writeFileSync(path.join(wt, 'CLAUDE.md'), content); },
  };
}

let root: string;
let service: ManagedAgentsService;

function agent(id: string, extra: Partial<DurableAgentConfig> = {}): DurableAgentConfig {
  const worktreePath = path.join(h.projectPath, '.clubhouse', 'agents', id);
  fs.mkdirSync(worktreePath, { recursive: true });
  return { id, name: id, color: 'indigo', createdAt: '2026-11-09T00:00:00.000Z', worktreePath, branch: `${id}/standby`, ...extra };
}

function setDefaults(d: ProjectAgentDefaults): void {
  h.defaults = d as Record<string, unknown>;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-defaults-'));
  h.projectPath = path.join(root, 'app');
  fs.mkdirSync(h.projectPath, { recursive: true });
  h.stateDir = path.join(root, 'managed');
  h.agents = [];
  h.updates = [];
  h.provider = provider();
  _resetSettingsAuditForTesting(false);
  service = createManagedAgentsService({
    catalog: createAssetCatalogStore({ dir: path.join(root, 'catalog') }),
    state: createManagedStateStore(h.stateDir),
    listProjects: async () => [], listAgents: async () => [], getAgent: async () => null, setManagedSetup: async () => {}, isRunning: () => false,
  });
  h.service = service;
  setDefaults({});
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('describeLegacyDefaults', () => {
  it('splits plugin parts out and names the plain agents that still get the MCP servers', async () => {
    setDefaults({
      instructions: 'Use pnpm.\n\n<!-- plugin:buddy:start -->\nBe kind.\n<!-- plugin:buddy:end -->',
      mcpJson: JSON.stringify({ mcpServers: { docs: { command: 'docs' }, 'plugin-buddy-chat': { command: 'chat' } } }),
      buildCommand: 'make',
    });
    const own = agent('own');
    fs.writeFileSync(path.join(own.worktreePath!, '.mcp.json'), '{"mcpServers":{}}');
    h.agents = [agent('bare'), own, agent('managed', { managed: { version: 1, blocks: [], skills: [], mcps: [] } }), { id: 'root', name: 'root', color: 'indigo', createdAt: '' }];

    const d = await describeLegacyDefaults(h.projectPath);

    expect(d.hasValues).toBe(true);
    expect(d.instructions).toBe('Use pnpm.');
    expect(d.pluginInstructions).toEqual([{ pluginId: 'buddy', label: 'Be kind.' }]);
    expect(d.mcpServers).toEqual([{ key: 'docs' }, { key: 'plugin-buddy-chat', pluginId: 'buddy' }]);
    // The project-folder agent has no MCP file of its own either.
    expect(d.inheritingMcp.map((a) => a.name)).toEqual(['bare', 'root']);
    expect(d.plainAgents.map((a) => a.name)).toEqual(['bare', 'own']);
    expect(d.commands).toEqual({ buildCommand: 'make' });
  });

  it('has nothing for blank values, and says so to callers that don\'t copy', async () => {
    setDefaults({ instructions: '  ', permissions: { allow: [], deny: [] }, commandPrefix: '. ./init.sh' });
    expect((await describeLegacyDefaults(h.projectPath)).hasValues).toBe(false);
    expect(await legacyDefaultsNotCopied(h.projectPath)).toBeUndefined();
    setDefaults({ testCommand: 'npm test' });
    expect(await legacyDefaultsNotCopied(h.projectPath)).toBe('not_copied');
  });
});

describe('import as parts', () => {
  beforeEach(() => {
    setDefaults({
      instructions: 'Run @@TestCommand before a PR.\n\n<!-- plugin:buddy:start -->\nBe kind.\n<!-- plugin:buddy:end -->',
      testCommand: 'npm test -- --run',
      buildCommand: 'make',
      permissions: { allow: ['Bash(git:*)'] },
      mcpJson: JSON.stringify({ mcpServers: {
        docs: { command: 'docs-mcp', args: ['--port', '3'] },
        keyed: { command: 'k', env: { API_KEY: 'literal' } },
        'plugin-buddy-chat': { command: 'chat' },
        clubhouse: { url: 'http://127.0.0.1:1/mcp' },
      } }),
    });
  });

  it('previews a block and MCP parts, and says what stays behind', async () => {
    const preview = await previewImportAsParts(h.projectPath);
    expect(preview.parts).toEqual([
      { kind: 'block', name: 'app legacy instructions', status: 'new' },
      { kind: 'mcp', name: 'docs', status: 'new' },
      { kind: 'mcp', name: 'keyed', status: 'new' },
    ]);
    expect(preview.notes.join('\n')).toMatch(/Instructions from the buddy plugin stay with the plugin/);
    expect(preview.notes.join('\n')).toMatch(/plugin-buddy-chat comes from the buddy plugin/);
    expect(preview.notes.join('\n')).toMatch(/keyed: values for API_KEY aren't kept/);
    expect(preview.notes.join('\n')).toMatch(/Permission rules aren't parts/);
    expect(Object.values(await service.liveEntries())).toHaveLength(0);
  });

  it('imports them with the commands filled in, attributed to the project defaults, and once only', async () => {
    const result = await user(() => importAsParts(h.projectPath));
    expect(result.created.map((p) => p.name)).toEqual(['app legacy instructions', 'docs', 'keyed']);
    const entries = Object.values(await service.liveEntries());
    expect(entries.every((e) => e.source.kind === 'import' && e.source.from === 'project-defaults')).toBe(true);
    const block = entries.find((e) => e.kind === 'block')!;
    const head = await service.headContent(block.id);
    expect(head?.content).toEqual({ kind: 'block', content: 'Run npm test -- --run before a PR.\n\n## Project commands\n\n- Build: `make`' });

    const again = await user(() => importAsParts(h.projectPath));
    expect(again.created).toEqual([]);
    expect(again.existing.map((p) => p.name).sort()).toEqual(['app legacy instructions', 'docs', 'keyed']);
    expect((await previewImportAsParts(h.projectPath)).parts.every((p) => p.status === 'in_library')).toBe(true);
  });
});

describe('copy into a plain agent', () => {
  it('previews and copies into its folder, adding to what it has', async () => {
    setDefaults({
      instructions: 'Hello @@AgentName.',
      permissions: { allow: ['Read(**)', 'Edit(**)'] },
      mcpJson: JSON.stringify({ mcpServers: { docs: { command: 'docs' }, mine: { command: 'theirs' } } }),
      lintCommand: 'npm run lint',
    });
    const a = agent('scout', { testCommand: 'own test' });
    fs.writeFileSync(path.join(a.worktreePath!, 'CLAUDE.md'), 'Mine.\n');
    fs.mkdirSync(path.join(a.worktreePath!, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(a.worktreePath!, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { allow: ['Read(**)'] } }));
    fs.writeFileSync(path.join(a.worktreePath!, '.mcp.json'), JSON.stringify({ mcpServers: { mine: { command: 'mine' } } }));
    h.agents = [a];

    const preview = await previewCopyIntoAgent(h.projectPath, 'scout');
    expect(preview.changes.map((c) => [c.target.replace(/\\/g, '/'), c.action])).toEqual([
      ['CLAUDE.md', 'append'],
      ['.claude/settings.local.json', 'merge'],
      ['.mcp.json', 'merge'],
      ['Lint command', 'set'],
    ]);
    expect(fs.readFileSync(path.join(a.worktreePath!, 'CLAUDE.md'), 'utf-8')).toBe('Mine.\n');

    await copyIntoAgent(h.projectPath, 'scout');
    expect(fs.readFileSync(path.join(a.worktreePath!, 'CLAUDE.md'), 'utf-8')).toBe('Mine.\n\nHello scout.\n');
    expect(JSON.parse(fs.readFileSync(path.join(a.worktreePath!, '.claude', 'settings.local.json'), 'utf-8')).permissions.allow).toEqual(['Read(**)', 'Edit(**)']);
    expect(JSON.parse(fs.readFileSync(path.join(a.worktreePath!, '.mcp.json'), 'utf-8')).mcpServers).toEqual({ mine: { command: 'mine' }, docs: { command: 'docs' } });
    expect(h.updates).toEqual([{ id: 'scout', fields: { lintCommand: 'npm run lint' } }]);
  });

  it('treats an empty command as none, and keeps the project JSON\'s other keys in a new MCP file', async () => {
    setDefaults({ buildCommand: 'make', mcpJson: JSON.stringify({ inputs: [{ id: 'token' }], mcpServers: { docs: { command: 'docs' } } }) });
    const a = agent('blank', { buildCommand: '' });
    h.agents = [a];
    const preview = await previewCopyIntoAgent(h.projectPath, 'blank');
    expect(preview.changes.find((c) => c.item === 'buildCommand')?.action).toBe('set');
    await copyIntoAgent(h.projectPath, 'blank');
    expect(JSON.parse(fs.readFileSync(path.join(a.worktreePath!, '.mcp.json'), 'utf-8'))).toEqual({ inputs: [{ id: 'token' }], mcpServers: { docs: { command: 'docs' } } });
    expect(h.updates).toEqual([{ id: 'blank', fields: { buildCommand: 'make' } }]);
  });

  it('skips what the CLI can\'t take, and what isn\'t valid', async () => {
    setDefaults({ permissions: { deny: ['WebFetch'] }, mcpJson: '{not json' });
    h.provider = { ...provider({ permissionRules: false }), displayName: 'Copilot CLI' };
    h.agents = [agent('pilot')];
    const preview = await previewCopyIntoAgent(h.projectPath, 'pilot');
    expect(preview.changes.map((c) => [c.item, c.action])).toEqual([['permissions', 'skip'], ['mcp', 'skip']]);
    expect(preview.changes[0].detail).toMatch(/Copilot CLI has no allow and deny rules/);
  });

  it('writes a TOML MCP file only when there is none', async () => {
    setDefaults({ mcpJson: JSON.stringify({ mcpServers: { docs: { command: 'docs' } } }) });
    h.provider = provider({ settingsFormat: 'toml', mcpConfigFile: path.join('.codex', 'config.toml') });
    const fresh = agent('fresh');
    const kept = agent('kept');
    fs.mkdirSync(path.join(kept.worktreePath!, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(kept.worktreePath!, '.codex', 'config.toml'), 'model = "x"\n');
    h.agents = [fresh, kept];
    expect((await previewCopyIntoAgent(h.projectPath, 'fresh')).changes.map((c) => c.action)).toEqual(['write']);
    expect((await previewCopyIntoAgent(h.projectPath, 'kept')).changes.map((c) => c.action)).toEqual(['skip']);
    await copyIntoAgent(h.projectPath, 'fresh');
    expect(fs.readFileSync(path.join(fresh.worktreePath!, '.codex', 'config.toml'), 'utf-8')).toContain('docs');
  });

  it('refuses an agent with no folder of its own, and a managed agent', async () => {
    setDefaults({ instructions: 'x' });
    h.agents = [{ id: 'root', name: 'root', color: 'indigo', createdAt: '' }, agent('managed', { managed: { version: 1, blocks: [], skills: [], mcps: [] } })];
    expect((await previewCopyIntoAgent(h.projectPath, 'root')).blocked).toMatch(/project folder/);
    await expect(copyIntoAgent(h.projectPath, 'root')).rejects.toThrow(/project folder/);
    await expect(previewCopyIntoAgent(h.projectPath, 'managed')).rejects.toThrow(/isn't a plain agent/);
  });

  it('previews a new agent\'s copy without reading any folder', async () => {
    setDefaults({ instructions: 'Hi @@AgentName.', permissions: { allow: ['Read(**)'] } });
    const preview = await previewCopyIntoNewAgent(h.projectPath, 'newbie');
    expect(preview.changes.map((c) => c.action)).toEqual(['write', 'write']);
    expect(fs.existsSync(path.join(h.projectPath, '.clubhouse', 'agents', 'newbie'))).toBe(false);
  });
});
