import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => '/tmp/test-clubhouse',
  },
}));

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

import { agentQueueRegistry } from './agent-queue-registry';

describe('AgentQueueRegistry', () => {
  beforeEach(() => {
    store.clear();
    agentQueueRegistry._resetForTesting();
  });

  it('creates a queue with expected shape', async () => {
    const q = await agentQueueRegistry.create('Test Queue');
    expect(q.id).toMatch(/^aq_\d+_[a-z0-9]+$/);
    expect(q.name).toBe('Test Queue');
    expect(q.concurrency).toBe(1);
    expect(q.createdAt).toBeTruthy();
    expect(q.metadata).toEqual({});
  });

  it('lists created queues', async () => {
    await agentQueueRegistry.create('A');
    await agentQueueRegistry.create('B');
    const list = await agentQueueRegistry.list();
    expect(list).toHaveLength(2);
    expect(list.map(q => q.name).sort()).toEqual(['A', 'B']);
  });

  it('gets a queue by ID', async () => {
    const q = await agentQueueRegistry.create('Find Me');
    const found = await agentQueueRegistry.get(q.id);
    expect(found).not.toBeNull();
    expect(found!.name).toBe('Find Me');
  });

  it('returns null for unknown ID', async () => {
    const found = await agentQueueRegistry.get('aq_nonexistent');
    expect(found).toBeNull();
  });

  it('updates queue fields', async () => {
    const q = await agentQueueRegistry.create('Old Name');
    const updated = await agentQueueRegistry.update(q.id, {
      name: 'New Name',
      concurrency: 3,
      model: 'sonnet',
      freeAgentMode: true,
    });
    expect(updated!.name).toBe('New Name');
    expect(updated!.concurrency).toBe(3);
    expect(updated!.model).toBe('sonnet');
    expect(updated!.freeAgentMode).toBe(true);
  });

  it('updates metadata (merges)', async () => {
    const q = await agentQueueRegistry.create('Meta Test');
    await agentQueueRegistry.update(q.id, { metadata: { key1: 'val1' } });
    await agentQueueRegistry.update(q.id, { metadata: { key2: 'val2' } });
    const fetched = await agentQueueRegistry.get(q.id);
    expect(fetched!.metadata).toEqual({ key1: 'val1', key2: 'val2' });
  });

  it('returns null when updating unknown ID', async () => {
    const result = await agentQueueRegistry.update('aq_nope', { name: 'x' });
    expect(result).toBeNull();
  });

  it('deletes a queue', async () => {
    const q = await agentQueueRegistry.create('To Delete');
    expect(await agentQueueRegistry.delete(q.id)).toBe(true);
    expect(await agentQueueRegistry.get(q.id)).toBeNull();
    expect(await agentQueueRegistry.list()).toHaveLength(0);
  });

  it('returns false when deleting unknown ID', async () => {
    expect(await agentQueueRegistry.delete('aq_nope')).toBe(false);
  });

  it('notifies onChange listeners', async () => {
    const listener = vi.fn();
    const unsub = agentQueueRegistry.onChange(listener);
    await agentQueueRegistry.create('Notify Test');
    expect(listener).toHaveBeenCalledTimes(1);
    unsub();
    await agentQueueRegistry.create('After Unsub');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('flushes to disk', async () => {
    await agentQueueRegistry.create('Persist');
    await agentQueueRegistry.flush();
    const fsp = await import('fs/promises');
    expect(fsp.writeFile).toHaveBeenCalled();
  });

  it('getSync returns queue from cache', async () => {
    const q = await agentQueueRegistry.create('Sync Test');
    const found = agentQueueRegistry.getSync(q.id);
    expect(found).not.toBeNull();
    expect(found!.name).toBe('Sync Test');
  });

  it('getSync returns null for unknown ID', () => {
    expect(agentQueueRegistry.getSync('aq_nope')).toBeNull();
  });
});
