import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';

const listTombstones = vi.hoisted(() => vi.fn());
vi.mock('./group-project-host', () => ({ groupProjectHost: { listTombstones } }));
vi.mock('fs/promises', () => ({ realpath: vi.fn(async (path: string) => path), mkdir: vi.fn(), writeFile: vi.fn() }));
import { writeKey } from './plugin-storage';

beforeEach(() => { vi.clearAllMocks(); listTombstones.mockResolvedValue([{ groupProjectId: 'gp-gone' }]); });

describe('canvas persistence after group project deletion', () => {
  it('strips cards from a late renderer save before writing either copy', async () => {
    const card = { id: 'card', type: 'plugin', pluginWidgetType: 'plugin:group-project:group-project', metadata: { groupProjectId: 'gp-gone' } };
    await writeKey({ pluginId: 'canvas', scope: 'global', key: 'canvas-instances', value: [{ id: 'board', views: [card] }] });
    expect(vi.mocked(fs.writeFile)).toHaveBeenCalledTimes(2);
    for (const call of vi.mocked(fs.writeFile).mock.calls) expect(JSON.parse(String(call[1]))).toEqual([{ id: 'board', views: [] }]);
  });

  it('refuses a canvas write if tombstones cannot be checked', async () => {
    listTombstones.mockRejectedValue(new Error('unreadable'));
    await expect(writeKey({ pluginId: 'canvas', scope: 'global', key: 'canvas-instances', value: [] })).rejects.toThrow('unreadable');
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  it('does not block unrelated canvas preferences on a tombstone read', async () => {
    listTombstones.mockRejectedValue(new Error('unreadable'));
    await writeKey({ pluginId: 'canvas', scope: 'global', key: 'active-canvas', value: 'board' });
    expect(listTombstones).not.toHaveBeenCalled();
    expect(fs.writeFile).toHaveBeenCalledTimes(2);
  });
});
