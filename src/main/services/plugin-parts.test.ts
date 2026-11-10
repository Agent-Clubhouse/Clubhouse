import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A plugin's agentConfig instructions and MCP servers as attributed Managed
// Agent parts (#3245), over the real parts library and the project's real
// settings file: only the project list and where the library keeps its state
// are faked.

const h = vi.hoisted(() => ({ service: null as unknown, stateDir: '', projectPath: '' }));

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => os.tmpdir() } }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./project-store', () => ({ list: async () => [{ id: 'proj_app', name: 'app', path: h.projectPath }] }));
vi.mock('./agent-config', () => ({ isSameProject: async (a: string, b: string) => path.resolve(a) === path.resolve(b) }));
vi.mock('./managed-agents', () => ({ managedAgents: () => h.service }));
vi.mock('./managed-agents/state-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./managed-agents/state-store')>()),
  managedStateDir: () => h.stateDir,
}));

import { createAssetCatalogStore } from './asset-catalog/store';
import { createManagedStateStore } from './managed-agents/state-store';
import { createManagedAgentsService, type ManagedAgentsService } from './managed-agents/service';
import { withSettingsSurface, _resetSettingsAuditForTesting } from './settings-audit';
import { readProjectAgentDefaults } from './agent-settings-service';
import { importPluginLegacyParts, readPluginManagedParts, removeAllPluginManagedParts, setPluginManagedParts } from './plugin-parts';

const user = <T>(fn: () => T) => withSettingsSurface('ui', undefined, fn);

let root: string;
let service: ManagedAgentsService;

function writeDefaults(agentDefaults: Record<string, unknown>): void {
  fs.mkdirSync(path.join(h.projectPath, '.clubhouse'), { recursive: true });
  fs.writeFileSync(path.join(h.projectPath, '.clubhouse', 'settings.json'), JSON.stringify({ defaults: {}, quickOverrides: {}, agentDefaults }));
}

async function pluginEntries() {
  return Object.values(await service.liveEntries()).filter((e) => e.source.kind === 'plugin').sort((a, b) => a.name.localeCompare(b.name));
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-parts-'));
  h.projectPath = path.join(root, 'app');
  fs.mkdirSync(h.projectPath, { recursive: true });
  h.stateDir = path.join(root, 'managed');
  _resetSettingsAuditForTesting(false);
  service = createManagedAgentsService({
    catalog: createAssetCatalogStore({ dir: path.join(root, 'catalog') }),
    state: createManagedStateStore(h.stateDir),
    listProjects: async () => [], listAgents: async () => [], getAgent: async () => null, setManagedSetup: async () => {}, isRunning: () => false,
  });
  h.service = service;
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('a plugin\'s instructions', () => {
  it('become one attributed block part, updated in place, and replace what it saved in the legacy defaults', async () => {
    writeDefaults({ instructions: 'Mine.\n\n<!-- plugin:buddy:start -->\nOld.\n<!-- plugin:buddy:end -->' });

    await user(() => setPluginManagedParts(h.projectPath, 'buddy', { instructions: 'Check your inbox.' }));
    const [part] = await pluginEntries();
    expect(part).toMatchObject({ kind: 'block', name: 'app: buddy instructions', headRevision: 1, source: { kind: 'plugin', pluginId: 'buddy', projectId: 'proj_app', key: 'instructions' } });
    const [summary] = await service.listParts('block');
    expect(summary).toMatchObject({ updatedBy: 'the buddy plugin', description: expect.stringContaining('Contributed by the buddy plugin for app') });
    expect((await readProjectAgentDefaults(h.projectPath)).instructions).toBe('Mine.');

    // The same text again changes nothing; new text is a new revision of the same part.
    await user(() => setPluginManagedParts(h.projectPath, 'buddy', { instructions: 'Check your inbox.' }));
    expect((await pluginEntries())[0].headRevision).toBe(1);
    await user(() => setPluginManagedParts(h.projectPath, 'buddy', { instructions: 'Check your inbox twice.' }));
    const after = await pluginEntries();
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: part.id, headRevision: 2 });
    expect(await readPluginManagedParts(h.projectPath, 'buddy')).toEqual({ instructions: 'Check your inbox twice.', mcpServers: [] });

    await user(() => setPluginManagedParts(h.projectPath, 'buddy', { instructions: null }));
    expect(await pluginEntries()).toEqual([]);
  });

  it('makes one part when two writes arrive at once', async () => {
    await Promise.all([
      user(() => setPluginManagedParts(h.projectPath, 'buddy', { instructions: 'A' })),
      user(() => setPluginManagedParts(h.projectPath, 'buddy', { instructions: 'B' })),
    ]);
    const parts = await pluginEntries();
    expect(parts).toHaveLength(1);
    expect((await readPluginManagedParts(h.projectPath, 'buddy')).instructions).toBe('B');
  });

  it('refuses a project that isn\'t registered, writing nothing', async () => {
    await expect(user(() => setPluginManagedParts(path.join(root, 'elsewhere'), 'buddy', { instructions: 'x' }))).rejects.toThrow(/isn't a registered project/);
    expect(await pluginEntries()).toEqual([]);
  });
});

describe('a plugin\'s MCP servers', () => {
  it('become one part each, follow the next call, and clear only the plugin\'s legacy servers', async () => {
    writeDefaults({ mcpJson: JSON.stringify({ mcpServers: { mine: { command: 'm' }, 'plugin-buddy-old': { command: 'o' } } }) });

    const result = await user(() => setPluginManagedParts(h.projectPath, 'buddy', { mcpServers: {
      chat: { command: 'chat-mcp' },
      keyed: { command: 'k', env: { API_KEY: 'literal' } },
      clubhouse: { url: 'http://127.0.0.1:1/mcp' },
    } }));
    expect(result.notes.join('\n')).toMatch(/keyed: values for API_KEY aren't kept/);
    expect(result.notes.join('\n')).toMatch(/clubhouse server is Clubhouse's own/);
    expect((await pluginEntries()).map((e) => [e.name, e.source])).toEqual([
      ['app: buddy chat', { kind: 'plugin', pluginId: 'buddy', projectId: 'proj_app', key: 'mcp:chat' }],
      ['app: buddy keyed', { kind: 'plugin', pluginId: 'buddy', projectId: 'proj_app', key: 'mcp:keyed' }],
    ]);
    expect(JSON.parse((await readProjectAgentDefaults(h.projectPath)).mcpJson!).mcpServers).toEqual({ mine: { command: 'm' } });

    await user(() => setPluginManagedParts(h.projectPath, 'buddy', { mcpServers: { chat: { command: 'chat-mcp' } } }));
    expect((await pluginEntries()).map((e) => e.name)).toEqual(['app: buddy chat']);
    expect((await readPluginManagedParts(h.projectPath, 'buddy')).mcpServers).toEqual(['chat']);

    await removeAllPluginManagedParts(h.projectPath, 'buddy');
    expect(await pluginEntries()).toEqual([]);
  });
});

describe('import of what a plugin saved before', () => {
  it('makes the missing parts, leaves the saved values and the plugin\'s own parts alone', async () => {
    const saved = { instructions: 'Mine.\n\n<!-- plugin:buddy:start -->\nSaved.\n<!-- plugin:buddy:end -->' };
    writeDefaults(saved);
    await user(() => importPluginLegacyParts(h.projectPath, 'buddy', { instructions: 'Saved.', mcpServers: { chat: { command: 'chat-mcp' } } }));
    expect((await pluginEntries()).map((e) => e.name)).toEqual(['app: buddy chat', 'app: buddy instructions']);
    expect((await readProjectAgentDefaults(h.projectPath)).instructions).toBe(saved.instructions);

    // The plugin wrote newer instructions since: an import doesn't overwrite them.
    await user(() => setPluginManagedParts(h.projectPath, 'buddy', { instructions: 'Newer.' }));
    await user(() => importPluginLegacyParts(h.projectPath, 'buddy', { instructions: 'Saved.' }));
    expect((await readPluginManagedParts(h.projectPath, 'buddy')).instructions).toBe('Newer.');
    expect(await pluginEntries()).toHaveLength(2);
  });
});
