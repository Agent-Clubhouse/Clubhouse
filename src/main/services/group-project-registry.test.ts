import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock electron app
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => '/tmp/test-clubhouse',
  },
}));

// Mock fs/promises — in-memory store
const store = new Map<string, string>();
vi.mock('fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  access: vi.fn().mockImplementation(async (p: string) => {
    if (!store.has(p)) throw new Error('ENOENT');
  }),
  readFile: vi.fn().mockImplementation(async (p: string) => {
    const data = store.get(p);
    if (!data) throw new Error('ENOENT');
    return data;
  }),
  writeFile: vi.fn().mockImplementation(async (p: string, content: string) => {
    store.set(p, content);
  }),
}));

vi.mock('./log-service', () => ({
  appLog: vi.fn(),
}));

import { groupProjectRegistry } from './group-project-registry';

describe('GroupProjectRegistry', () => {
  beforeEach(() => {
    store.clear();
    groupProjectRegistry._resetForTesting();
  });

  it('creates a project with expected shape', async () => {
    const p = await groupProjectRegistry.create('Test Project');
    expect(p.id).toMatch(/^gp_\d+_[a-z0-9]+$/);
    expect(p.name).toBe('Test Project');
    expect(p.description).toBe('');
    expect(p.instructions).toBe('');
    expect(p.createdAt).toBeTruthy();
    expect(p.metadata).toEqual({});
  });

  it('lists created projects', async () => {
    await groupProjectRegistry.create('A');
    await groupProjectRegistry.create('B');
    const list = await groupProjectRegistry.list();
    expect(list).toHaveLength(2);
    expect(list.map(p => p.name).sort()).toEqual(['A', 'B']);
  });

  it('gets a project by ID', async () => {
    const p = await groupProjectRegistry.create('Find Me');
    const found = await groupProjectRegistry.get(p.id);
    expect(found).not.toBeNull();
    expect(found!.name).toBe('Find Me');
  });

  it('returns null for unknown ID', async () => {
    const found = await groupProjectRegistry.get('gp_nonexistent');
    expect(found).toBeNull();
  });

  it('updates a project name', async () => {
    const p = await groupProjectRegistry.create('Old Name');
    const updated = await groupProjectRegistry.update(p.id, { name: 'New Name' });
    expect(updated!.name).toBe('New Name');
    const fetched = await groupProjectRegistry.get(p.id);
    expect(fetched!.name).toBe('New Name');
  });

  it('updates metadata (merges)', async () => {
    const p = await groupProjectRegistry.create('Meta Test');
    await groupProjectRegistry.update(p.id, { metadata: { key1: 'val1' } });
    await groupProjectRegistry.update(p.id, { metadata: { key2: 'val2' } });
    const fetched = await groupProjectRegistry.get(p.id);
    expect(fetched!.metadata).toEqual({ key1: 'val1', key2: 'val2' });
  });

  it('returns null when updating unknown ID', async () => {
    const result = await groupProjectRegistry.update('gp_nope', { name: 'x' });
    expect(result).toBeNull();
  });

  it('deletes a project', async () => {
    const p = await groupProjectRegistry.create('To Delete');
    expect(await groupProjectRegistry.delete(p.id)).toBe(true);
    expect(await groupProjectRegistry.get(p.id)).toBeNull();
    expect(await groupProjectRegistry.list()).toHaveLength(0);
  });

  it('returns false when deleting unknown ID', async () => {
    expect(await groupProjectRegistry.delete('gp_nope')).toBe(false);
  });

  it('notifies onChange listeners', async () => {
    const listener = vi.fn();
    const unsub = groupProjectRegistry.onChange(listener);
    await groupProjectRegistry.create('Notify Test');
    expect(listener).toHaveBeenCalledTimes(1);
    unsub();
    await groupProjectRegistry.create('After Unsub');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('updates description and instructions', async () => {
    const p = await groupProjectRegistry.create('DescTest');
    const updated = await groupProjectRegistry.update(p.id, {
      description: 'A test project',
      instructions: 'Follow the rules',
    });
    expect(updated!.description).toBe('A test project');
    expect(updated!.instructions).toBe('Follow the rules');
    const fetched = await groupProjectRegistry.get(p.id);
    expect(fetched!.description).toBe('A test project');
    expect(fetched!.instructions).toBe('Follow the rules');
  });

  it('normalizes old entries missing description/instructions on load', async () => {
    // Write an old-format entry without description/instructions
    const fsp = await import('fs/promises');
    const oldData = JSON.stringify([{
      id: 'gp_old_abc',
      name: 'Legacy',
      createdAt: '2025-01-01T00:00:00.000Z',
      metadata: {},
    }]);
    const registryFile = '/tmp/test-clubhouse/.clubhouse-dev/group-projects/registry.json';
    (fsp.access as any).mockImplementation(async (p: string) => {
      if (p === registryFile) return;
      throw new Error('ENOENT');
    });
    (fsp.readFile as any).mockImplementation(async (p: string) => {
      if (p === registryFile) return oldData;
      throw new Error('ENOENT');
    });

    groupProjectRegistry._resetForTesting();
    const project = await groupProjectRegistry.get('gp_old_abc');
    expect(project).not.toBeNull();
    expect(project!.description).toBe('');
    expect(project!.instructions).toBe('');
  });

  it('flushes to disk', async () => {
    await groupProjectRegistry.create('Persist');
    await groupProjectRegistry.flush();
    // Verify writeFile was called
    const fsp = await import('fs/promises');
    expect(fsp.writeFile).toHaveBeenCalled();
  });
});
