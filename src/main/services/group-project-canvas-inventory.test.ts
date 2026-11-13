import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'path';
import { readAllCanvasStores, readKvKey } from './canvas-store-reader';
import { readGroupProjectCanvasInventory, removeGroupProjectFromCanvasInventory } from './group-project-canvas-inventory';

vi.mock('./canvas-store-reader', () => ({ readAllCanvasStores: vi.fn(), readKvKey: vi.fn() }));
const dir = path.join('canvas-fixture', 'kv');
const location = { scope: 'app' as const, kvDir: dir };
const view = { id: 'node', type: 'plugin', pluginWidgetType: 'plugin:group-project:group-project', metadata: { groupProjectId: 'gp' } };
const data = [{ id: 'board', name: 'Board', views: [view] }];

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(readAllCanvasStores).mockResolvedValue([{ location, canvases: data, wires: [], problems: [] }]);
  vi.mocked(readKvKey).mockImplementation(async (_dir, key) => key === 'canvas-instances' ? { status: 'ok', value: data } : { status: 'missing' });
});

describe('group project canvas inventory', () => {
  it('inventories cards and removes references without mutating the original data', async () => {
    const inventory = await readGroupProjectCanvasInventory('gp');
    expect(inventory.canvases).toEqual(['Home / Board']);
    const write = vi.fn(async () => {});
    await removeGroupProjectFromCanvasInventory(inventory, 'gp', write);
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ scope: 'global', key: 'canvas-instances', value: [{ id: 'board', name: 'Board', views: [] }] }));
    expect(data[0].views).toEqual([view]);
  });

  it('refuses to continue when any store is unreadable', async () => {
    vi.mocked(readAllCanvasStores).mockResolvedValue([{ location, canvases: null, wires: null, problems: ['unreadable'] }]);
    await expect(readGroupProjectCanvasInventory('gp')).rejects.toThrow('Home: unreadable');
  });

  it('does not read malformed recovery snapshots when building the impact', async () => {
    await readGroupProjectCanvasInventory('gp');
    expect(vi.mocked(readKvKey).mock.calls.every(([, key]) => !key.startsWith('canvas-instances-recovery-'))).toBe(true);
  });
});
