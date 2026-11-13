import { describe, expect, it, vi } from 'vitest';
import { createGroupProjectDeletionService, type GroupProjectDeletionInventory } from './group-project-deletion';

function inventory(): GroupProjectDeletionInventory {
  return { groupProjectId: 'gp', members: ['Ada'], canvases: ['Home', 'Work'], actions: ['Build'], grants: ['Admin'], messages: 3, topics: 2, machines: [], revisions: ['1'] };
}

describe('group project deletion confirmation', () => {
  it('requires the same caller and a fresh single-use token', async () => {
    const cascade = vi.fn(async () => {});
    const service = createGroupProjectDeletionService({ inventory: async () => inventory(), cascade });
    const first = await service.preview('gp', 7);
    await expect(service.confirm('gp', 8, first.token)).rejects.toThrow();
    expect(cascade).not.toHaveBeenCalled();
    const second = await service.preview('gp', 7);
    await service.confirm('gp', 7, second.token);
    expect(cascade).toHaveBeenCalledOnce();
    await expect(service.confirm('gp', 7, second.token)).rejects.toThrow();
  });

  it('refuses a changed inventory before any cascade', async () => {
    const cascade = vi.fn(async () => {});
    const value = inventory();
    const service = createGroupProjectDeletionService({ inventory: async () => value, cascade });
    const preview = await service.preview('gp', 1);
    value.members.push('Grace');
    await expect(service.confirm('gp', 1, preview.token)).rejects.toThrow('changed');
    expect(cascade).not.toHaveBeenCalled();
  });

  it('expires tokens and releases a failed cascade for a fresh preview', async () => {
    let now = 0;
    const cascade = vi.fn().mockRejectedValueOnce(new Error('write failed')).mockResolvedValueOnce(undefined);
    const service = createGroupProjectDeletionService({ inventory: async () => inventory(), cascade, now: () => now });
    const expired = await service.preview('gp', 1);
    now = 300_000;
    await expect(service.confirm('gp', 1, expired.token)).rejects.toThrow('expired');
    const failed = await service.preview('gp', 1);
    await expect(service.confirm('gp', 1, failed.token)).rejects.toThrow('write failed');
    const retry = await service.preview('gp', 1);
    await service.confirm('gp', 1, retry.token);
    expect(cascade).toHaveBeenCalledTimes(2);
  });
});
