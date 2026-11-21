import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
const context = vi.hoisted(() => ({ root: '' }));
vi.mock('./base-dir', () => ({ getBaseDirPath: () => context.root }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./plugin-storage', () => ({ getGlobalPluginDataDir: () => path.join(context.root, 'plugins') }));
vi.mock('./badge-settings', () => ({ getSettings: () => ({}), saveSettings: vi.fn() }));
vi.mock('./sound-service', () => ({ getSettings: () => ({}), saveSettings: vi.fn() }));
vi.mock('./finished-quick-agents-store', () => ({ moveFinishedQuickAgents: vi.fn() }));
vi.mock('./agent-config', () => ({ projectKey: async (p: string) => p, agentConfigGeneration: () => 0,
  peekDurableConfigs: vi.fn(), peekDurableConfigsChecked: async () => ({ agents: [], readable: true }) }));
import * as projectStore from './project-store';
import { getAgentCanvasMemberships } from './canvas-store-reader';
import { clearHelperIndexCache, listHelpersEverywhere } from './helper-index';
let home: string;
beforeEach(async () => {
  context.root = await fs.mkdtemp(path.join(os.tmpdir(), 'clubhouse-details-readonly-'));
  home = path.join(context.root, 'project'); await fs.mkdir(home);
  clearHelperIndexCache();
});
afterEach(async () => { await fs.rm(context.root, { recursive: true, force: true }); });
async function diskSnapshot(dir: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(result, await diskSnapshot(file));
    else result[path.relative(context.root, file)] = await fs.readFile(file, 'utf8');
  }
  return result;
}
const current = () => JSON.stringify({ version: 1, projects: [{ id: 'p1', name: 'Project', path: home }] });
describe('Details strict inventories never recover or rewrite project/canvas storage', () => {
  it.each(['corrupt', 'legacy', 'backup-only'] as const)('keeps %s project inventory byte-identical and reports uncertainty', async (mode) => {
    if (mode !== 'backup-only') await fs.writeFile(path.join(context.root, 'projects.json'), mode === 'corrupt' ? '{broken' : JSON.stringify({ version: 0, projects: [] }));
    await fs.writeFile(path.join(context.root, 'projects.json.bak'), current());
    const before = await diskSnapshot(context.root);
    const recoveringList = vi.spyOn(projectStore, 'list');
    await expect(listHelpersEverywhere(home, 'a1', { includeDisposed: true, readOnly: true })).rejects.toThrow('unreadable');
    await expect(getAgentCanvasMemberships('a1', 'p1', { strict: true })).rejects.toThrow();
    expect(recoveringList).not.toHaveBeenCalled();
    expect(await diskSnapshot(context.root)).toEqual(before);
  });
  it('distinguishes corrupt selected canvas instances from verified missing/empty stores without recovery', async () => {
    await fs.writeFile(path.join(context.root, 'projects.json'), current());
    const recoveringList = vi.spyOn(projectStore, 'list');
    expect(await getAgentCanvasMemberships('a1', 'p1', { strict: true })).toEqual([]);
    const kv = path.join(home, '.clubhouse/plugin-data-local/canvas/kv'); await fs.mkdir(kv, { recursive: true });
    await fs.writeFile(path.join(kv, 'canvas-instances.json'), '{broken');
    await fs.writeFile(path.join(kv, 'canvas-instances.json.bak'), JSON.stringify([{ id: 'c', name: 'Recovery board', views: [{ id: 'v', type: 'agent', agentId: 'a1' }] }]));
    const before = await diskSnapshot(context.root);
    await expect(getAgentCanvasMemberships('a1', 'p1', { strict: true })).rejects.toThrow('incomplete');
    expect(recoveringList).not.toHaveBeenCalled();
    expect(await diskSnapshot(context.root)).toEqual(before);
  });
});
