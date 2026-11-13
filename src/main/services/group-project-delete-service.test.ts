import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  inventory: vi.fn(), canvas: vi.fn(), remove: vi.fn(), delete: vi.fn(), exclusive: vi.fn(),
}));
vi.mock('./group-project-host', () => ({ groupProjectHost: { exclusive: mocks.exclusive, delete: mocks.delete } }));
vi.mock('./group-project-delete-inventory', () => ({ readGroupProjectDeletionInventory: mocks.inventory }));
vi.mock('./group-project-canvas-inventory', () => ({ readGroupProjectCanvasInventory: mocks.canvas, removeGroupProjectFromCanvasInventory: mocks.remove }));
vi.mock('./plugin-storage', () => ({ writeKeyWithinCanvasBarrier: vi.fn() }));
import { createLocalGroupProjectDeleteService } from './group-project-delete-service';

const impact = { groupProjectId: 'gp', members: ['Ada'], canvases: ['One', 'Two'], actions: [], grants: [], messages: 2, topics: 1, machines: [], revisions: ['3', 'canvas'] };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.inventory.mockImplementation(async () => structuredClone(impact));
  mocks.canvas.mockResolvedValue({ revision: 'canvas', entries: [] });
  mocks.remove.mockResolvedValue(undefined);
  mocks.delete.mockResolvedValue({ deleted: true });
  mocks.exclusive.mockImplementation(async (_id, callback) => callback({ seq: 3 }));
});

describe('local group project cascade', () => {
  it('checks the inventory under both guards before cleanup and host delete', async () => {
    const release = vi.fn();
    const service = createLocalGroupProjectDeleteService(release);
    const preview = await service.preview('gp', 7);
    await service.confirm('gp', 7, preview.token);
    expect(mocks.remove).toHaveBeenCalledBefore(mocks.delete);
    expect(mocks.delete).toHaveBeenCalledWith('gp', { expectedSeq: 3, withinExclusive: true });
    expect(release).toHaveBeenCalledWith('gp');
  });

  it('does not write or delete if the canvas changes while acquiring the guards', async () => {
    const release = vi.fn();
    const service = createLocalGroupProjectDeleteService(release);
    const preview = await service.preview('gp', 7);
    mocks.canvas.mockResolvedValue({ revision: 'changed', entries: [] });
    await expect(service.confirm('gp', 7, preview.token)).rejects.toThrow('canvases changed');
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.delete).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });
});
