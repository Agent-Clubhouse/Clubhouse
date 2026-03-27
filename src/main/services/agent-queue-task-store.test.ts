import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => '/tmp/test-clubhouse',
  },
}));

const store = new Map<string, string>();
const dirs = new Set<string>();
vi.mock('fs/promises', () => ({
  mkdir: vi.fn().mockImplementation(async (dir: string) => { dirs.add(dir); }),
  access: vi.fn().mockImplementation(async (p: string) => {
    if (!store.has(p) && !dirs.has(p)) throw new Error('ENOENT');
  }),
  readFile: vi.fn().mockImplementation(async (p: string) => {
    const data = store.get(p);
    if (!data) throw new Error('ENOENT');
    return data;
  }),
  writeFile: vi.fn().mockImplementation(async (p: string, content: string) => {
    store.set(p, content);
  }),
  readdir: vi.fn().mockResolvedValue([]),
  rm: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./log-service', () => ({
  appLog: vi.fn(),
}));

import { agentQueueTaskStore } from './agent-queue-task-store';

describe('AgentQueueTaskStore', () => {
  beforeEach(() => {
    store.clear();
    dirs.clear();
    agentQueueTaskStore._resetForTesting();
  });

  it('creates a task with expected shape', async () => {
    const task = await agentQueueTaskStore.createTask('aq_1', 'Test mission');
    expect(task.id).toMatch(/^aqt_\d+_[a-z0-9]+$/);
    expect(task.queueId).toBe('aq_1');
    expect(task.mission).toBe('Test mission');
    expect(task.status).toBe('pending');
    expect(task.createdAt).toBeTruthy();
  });

  it('lists tasks for a queue', async () => {
    await agentQueueTaskStore.createTask('aq_1', 'Task A');
    await agentQueueTaskStore.createTask('aq_1', 'Task B');
    await agentQueueTaskStore.createTask('aq_2', 'Task C');

    const queue1Tasks = await agentQueueTaskStore.listTasks('aq_1');
    expect(queue1Tasks).toHaveLength(2);
    expect(queue1Tasks.map(t => t.mission).sort()).toEqual(['Task A', 'Task B']);
  });

  it('gets a task by ID', async () => {
    const task = await agentQueueTaskStore.createTask('aq_1', 'Find me');
    const found = await agentQueueTaskStore.getTask('aq_1', task.id);
    expect(found).not.toBeNull();
    expect(found!.mission).toBe('Find me');
  });

  it('returns null for unknown task', async () => {
    const found = await agentQueueTaskStore.getTask('aq_1', 'aqt_nope');
    expect(found).toBeNull();
  });

  it('updates task fields', async () => {
    const task = await agentQueueTaskStore.createTask('aq_1', 'Update me');
    const updated = await agentQueueTaskStore.updateTask('aq_1', task.id, {
      status: 'running',
      agentId: 'agent-123',
      agentName: 'scrappy-robin',
      startedAt: new Date().toISOString(),
    });

    expect(updated!.status).toBe('running');
    expect(updated!.agentId).toBe('agent-123');
    expect(updated!.agentName).toBe('scrappy-robin');
  });

  it('updates task with output', async () => {
    const task = await agentQueueTaskStore.createTask('aq_1', 'Output test');
    await agentQueueTaskStore.updateTask('aq_1', task.id, {
      status: 'completed',
      summary: 'Found 3 bugs',
      detail: 'Detailed analysis of the 3 bugs found...',
      filesModified: ['src/foo.ts', 'src/bar.ts'],
      exitCode: 0,
    });

    const found = await agentQueueTaskStore.getTask('aq_1', task.id);
    expect(found!.summary).toBe('Found 3 bugs');
    expect(found!.detail).toContain('Detailed analysis');
    expect(found!.filesModified).toEqual(['src/foo.ts', 'src/bar.ts']);
  });

  it('cancels a pending task', async () => {
    const task = await agentQueueTaskStore.createTask('aq_1', 'Cancel me');
    const cancelled = await agentQueueTaskStore.cancelTask('aq_1', task.id);
    expect(cancelled).toBe(true);

    const found = await agentQueueTaskStore.getTask('aq_1', task.id);
    expect(found!.status).toBe('cancelled');
    expect(found!.completedAt).toBeTruthy();
  });

  it('cannot cancel a running task', async () => {
    const task = await agentQueueTaskStore.createTask('aq_1', 'Running');
    await agentQueueTaskStore.updateTask('aq_1', task.id, { status: 'running' });
    const cancelled = await agentQueueTaskStore.cancelTask('aq_1', task.id);
    expect(cancelled).toBe(false);
  });

  it('lists task summaries', async () => {
    const task = await agentQueueTaskStore.createTask('aq_1', 'Summary test');
    await agentQueueTaskStore.updateTask('aq_1', task.id, {
      status: 'completed',
      summary: 'Done',
    });

    const summaries = await agentQueueTaskStore.listTaskSummaries('aq_1');
    expect(summaries).toHaveLength(1);
    expect(summaries[0].hasOutput).toBe(true);
    expect(summaries[0].status).toBe('completed');
  });

  it('gets status counts', async () => {
    await agentQueueTaskStore.createTask('aq_1', 'Pending 1');
    await agentQueueTaskStore.createTask('aq_1', 'Pending 2');
    const task3 = await agentQueueTaskStore.createTask('aq_1', 'Running');
    await agentQueueTaskStore.updateTask('aq_1', task3.id, { status: 'running' });

    const counts = await agentQueueTaskStore.getStatusCounts('aq_1');
    expect(counts.pending).toBe(2);
    expect(counts.running).toBe(1);
    expect(counts.completed).toBe(0);
    expect(counts.failed).toBe(0);
    expect(counts.cancelled).toBe(0);
  });

  it('notifies onChange listeners', async () => {
    const listener = vi.fn();
    const unsub = agentQueueTaskStore.onChange(listener);
    const task = await agentQueueTaskStore.createTask('aq_1', 'Notify');
    expect(listener).toHaveBeenCalledWith('aq_1', task.id);
    unsub();
  });
});
