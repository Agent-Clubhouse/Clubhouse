import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  inventory: vi.fn(), canvas: vi.fn(), remove: vi.fn(), begin: vi.fn(), finish: vi.fn(), pending: vi.fn(), exclusive: vi.fn(), exclusivePending: vi.fn(),
}));
vi.mock('./group-project-host', () => ({ groupProjectHost: { exclusive: mocks.exclusive, beginDelete: mocks.begin, finishDelete: mocks.finish, listPendingDeletes: mocks.pending, exclusivePending: mocks.exclusivePending } }));
vi.mock('./group-project-delete-inventory', () => ({ readGroupProjectDeletionInventory: mocks.inventory }));
vi.mock('./group-project-canvas-inventory', () => ({ readGroupProjectCanvasInventory: mocks.canvas, removeGroupProjectFromCanvasInventory: mocks.remove }));
vi.mock('./plugin-storage', () => ({ writeKeyWithinCanvasBarrier: vi.fn() }));
import { createLocalGroupProjectDeleteService } from './group-project-delete-service';

const impact = { groupProjectId: 'gp', members: ['Ada'], exclusions: [], canvases: ['One', 'Two'], actions: [], grants: [], messages: 2, topics: 1, machines: [], revisions: ['3', 'canvas'] };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.inventory.mockImplementation(async () => structuredClone(impact));
  mocks.canvas.mockResolvedValue({ revision: 'canvas', entries: [] });
  mocks.remove.mockResolvedValue(undefined);
  mocks.begin.mockResolvedValue({});
  mocks.finish.mockResolvedValue({});
  mocks.pending.mockResolvedValue([]);
  mocks.exclusivePending.mockImplementation(async (_id, callback) => callback());
  mocks.exclusive.mockImplementation(async (_id, callback) => callback({ seq: 3 }));
});

describe('local group project cascade', () => {
  it('checks the inventory under both guards before cleanup and host delete', async () => {
    const release = vi.fn();
    const service = createLocalGroupProjectDeleteService(release);
    const preview = await service.preview('gp', 7);
    await service.confirm('gp', 7, preview.token);
    expect(mocks.begin).toHaveBeenCalledBefore(mocks.remove);
    expect(mocks.remove).toHaveBeenCalledBefore(mocks.finish);
    expect(mocks.begin).toHaveBeenCalledWith('gp', { expectedSeq: 3, withinExclusive: true });
    expect(release).toHaveBeenCalledWith('gp');
  });

  it('does not write or delete if the canvas changes while acquiring the guards', async () => {
    const release = vi.fn();
    const service = createLocalGroupProjectDeleteService(release);
    const preview = await service.preview('gp', 7);
    mocks.canvas.mockResolvedValue({ revision: 'changed', entries: [] });
    await expect(service.confirm('gp', 7, preview.token)).rejects.toThrow('canvases changed');
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.begin).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });
  it.each(['canvas', 'bindings', 'finish'] as const)('recovers after %s fails following the tombstone', async (step) => {
    let pending = false;
    let fail = true;
    mocks.begin.mockImplementation(async () => { pending = true; });
    mocks.pending.mockImplementation(async () => pending ? [{ groupProjectId: 'gp' }] : []);
    mocks.remove.mockImplementation(async () => { if (step === 'canvas' && fail) { fail = false; throw new Error(step); } });
    mocks.finish.mockImplementation(async () => { if (step === 'finish' && fail) { fail = false; throw new Error(step); } pending = false; });
    const release = vi.fn(() => { if (step === 'bindings' && fail) { fail = false; throw new Error(step); } });
    const service = createLocalGroupProjectDeleteService(release);
    const preview = await service.preview('gp', 7);
    await expect(service.confirm('gp', 7, preview.token)).rejects.toThrow(step);
    expect(pending).toBe(true);
    await createLocalGroupProjectDeleteService(release).recoverPending();
    expect(pending).toBe(false);
    expect(mocks.exclusivePending).toHaveBeenCalledWith('gp', expect.any(Function));
  });

});
