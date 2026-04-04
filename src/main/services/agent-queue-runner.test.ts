import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentQueue, AgentQueueTask } from '../../shared/agent-queue-types';

// ---------------------------------------------------------------------------
// Mocks — order matters: vi.mock() calls are hoisted by vitest.
// ---------------------------------------------------------------------------

vi.mock('./agent-system', () => ({
  spawnAgent: vi.fn(),
}));

vi.mock('./agent-queue-registry', () => ({
  agentQueueRegistry: { get: vi.fn() },
}));

vi.mock('./agent-queue-task-store', () => ({
  agentQueueTaskStore: {
    createTask: vi.fn(),
    updateTask: vi.fn(),
    listTasks: vi.fn(),
    getTask: vi.fn(),
    cancelTask: vi.fn(),
  },
}));

/** Captured exit callback so tests can simulate agent exits. */
let capturedExitCb: ((agentId: string, exitCode: number) => void) | undefined;
vi.mock('./agent-exit-broadcast', () => ({
  onAgentExit: vi.fn((fn: (agentId: string, exitCode: number) => void) => {
    capturedExitCb = fn;
    return () => { capturedExitCb = undefined; };
  }),
}));

vi.mock('../../shared/agent-id', () => ({
  generateQuickAgentId: vi.fn(() => 'quick_test_abc'),
}));

vi.mock('../../shared/name-generator', () => ({
  generateQuickName: vi.fn(() => 'brave-owl'),
}));

vi.mock('../orchestrators/shared', () => ({
  readQuickSummary: vi.fn(),
}));

vi.mock('./log-service', () => ({
  appLog: vi.fn(),
}));

// Mock fs with importActual so vitest internals still work.
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    readFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return {
    ...actual,
    tmpdir: vi.fn(() => '/tmp'),
  };
});

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { spawnAgent } from './agent-system';
import { agentQueueRegistry } from './agent-queue-registry';
import { agentQueueTaskStore } from './agent-queue-task-store';
import { onAgentExit } from './agent-exit-broadcast';
import { generateQuickAgentId } from '../../shared/agent-id';
import { readQuickSummary } from '../orchestrators/shared';
import { readFileSync } from 'fs';
import {
  initAgentQueueRunner,
  enqueueTask,
  cancelTask,
  _resetForTesting,
} from './agent-queue-runner';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeQueue(overrides: Partial<AgentQueue> = {}): AgentQueue {
  return {
    id: 'q1',
    name: 'Test Queue',
    concurrency: 1,
    projectPath: '/project',
    createdAt: new Date().toISOString(),
    metadata: {},
    ...overrides,
  };
}

function makeTask(overrides: Partial<AgentQueueTask> = {}): AgentQueueTask {
  return {
    id: 'task1',
    queueId: 'q1',
    mission: 'do something',
    status: 'pending',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/** Flush all pending micro-tasks so fire-and-forget promises complete. */
async function flushPromises(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  capturedExitCb = undefined;
  _resetForTesting();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('initAgentQueueRunner', () => {
  it('subscribes to agent exit events', () => {
    initAgentQueueRunner();
    expect(onAgentExit).toHaveBeenCalledTimes(1);
    expect(onAgentExit).toHaveBeenCalledWith(expect.any(Function));
  });

  it('is idempotent — calling twice does not double-subscribe', () => {
    initAgentQueueRunner();
    initAgentQueueRunner();
    expect(onAgentExit).toHaveBeenCalledTimes(1);
  });
});

describe('enqueueTask', () => {
  it('creates task via store and triggers drain', async () => {
    const task = makeTask();
    vi.mocked(agentQueueTaskStore.createTask).mockResolvedValue(task);
    vi.mocked(agentQueueRegistry.get).mockResolvedValue(null);

    const result = await enqueueTask('q1', 'do something');

    expect(agentQueueTaskStore.createTask).toHaveBeenCalledWith('q1', 'do something');
    expect(result).toBe(task);
    // drainQueue is fire-and-forget; confirm registry.get was called (drain attempted)
    await flushPromises();
    expect(agentQueueRegistry.get).toHaveBeenCalledWith('q1');
  });
});

describe('happy path: enqueue -> drain -> spawn -> exit(0) -> task completed', () => {
  it('completes full lifecycle with output', async () => {
    const queue = makeQueue();
    const task = makeTask();

    vi.mocked(agentQueueTaskStore.createTask).mockResolvedValue(task);
    vi.mocked(agentQueueRegistry.get).mockResolvedValue(queue);
    vi.mocked(agentQueueTaskStore.listTasks).mockResolvedValue([task]);
    vi.mocked(agentQueueTaskStore.updateTask).mockResolvedValue(task);
    vi.mocked(spawnAgent).mockResolvedValue(undefined);
    vi.mocked(generateQuickAgentId).mockReturnValue('quick_test_abc');

    // Init the runner so exit callback is registered
    initAgentQueueRunner();

    // Enqueue — triggers drain -> startTask -> spawnAgent
    await enqueueTask('q1', 'do something');
    await flushPromises();

    // Verify task was marked running
    expect(agentQueueTaskStore.updateTask).toHaveBeenCalledWith('q1', 'task1', expect.objectContaining({
      status: 'running',
      agentId: 'quick_test_abc',
      agentName: 'brave-owl',
    }));

    // Verify spawnAgent was called with correct params
    expect(spawnAgent).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'quick_test_abc',
      projectPath: '/project',
      cwd: '/project',
      kind: 'quick',
      mission: 'do something',
    }));

    // Now simulate agent exit with success
    vi.mocked(agentQueueTaskStore.getTask).mockResolvedValue(
      makeTask({ status: 'running', agentId: 'quick_test_abc', startedAt: new Date().toISOString() }),
    );
    vi.mocked(readFileSync).mockImplementation((filePath: unknown) => {
      const p = String(filePath);
      if (p.endsWith('summary.md')) return 'Task completed successfully';
      if (p.endsWith('detail.md')) return 'Detailed analysis here';
      throw new Error('ENOENT');
    });
    vi.mocked(readQuickSummary).mockResolvedValue({
      summary: 'backup summary',
      filesModified: ['file1.ts'],
    });

    // Reset updateTask to track only the exit-related call
    vi.mocked(agentQueueTaskStore.updateTask).mockClear();
    // listTasks for drain after exit — no more pending tasks
    vi.mocked(agentQueueTaskStore.listTasks).mockResolvedValue([]);

    capturedExitCb!('quick_test_abc', 0);
    await flushPromises();

    expect(agentQueueTaskStore.updateTask).toHaveBeenCalledWith('q1', 'task1', expect.objectContaining({
      status: 'completed',
      exitCode: 0,
      summary: 'Task completed successfully',
      detail: 'Detailed analysis here',
      filesModified: ['file1.ts'],
    }));
  });
});

describe('agent exit with non-zero code', () => {
  it('marks task as failed when exit code is 1', async () => {
    const queue = makeQueue();
    const task = makeTask();

    vi.mocked(agentQueueTaskStore.createTask).mockResolvedValue(task);
    vi.mocked(agentQueueRegistry.get).mockResolvedValue(queue);
    vi.mocked(agentQueueTaskStore.listTasks).mockResolvedValue([task]);
    vi.mocked(agentQueueTaskStore.updateTask).mockResolvedValue(task);
    vi.mocked(spawnAgent).mockResolvedValue(undefined);

    initAgentQueueRunner();
    await enqueueTask('q1', 'do something');
    await flushPromises();

    // Simulate agent exit with code 1
    vi.mocked(agentQueueTaskStore.getTask).mockResolvedValue(
      makeTask({ status: 'running', agentId: 'quick_test_abc', startedAt: new Date().toISOString() }),
    );
    vi.mocked(readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
    vi.mocked(readQuickSummary).mockResolvedValue(null);
    vi.mocked(agentQueueTaskStore.updateTask).mockClear();
    vi.mocked(agentQueueTaskStore.listTasks).mockResolvedValue([]);

    capturedExitCb!('quick_test_abc', 1);
    await flushPromises();

    expect(agentQueueTaskStore.updateTask).toHaveBeenCalledWith('q1', 'task1', expect.objectContaining({
      status: 'failed',
      exitCode: 1,
      errorMessage: 'Agent exited with code 1',
    }));
  });
});

describe('readQueueAgentOutput file I/O failure', () => {
  it('returns nulls gracefully when output files do not exist', async () => {
    const queue = makeQueue();
    const task = makeTask();

    vi.mocked(agentQueueTaskStore.createTask).mockResolvedValue(task);
    vi.mocked(agentQueueRegistry.get).mockResolvedValue(queue);
    vi.mocked(agentQueueTaskStore.listTasks).mockResolvedValue([task]);
    vi.mocked(agentQueueTaskStore.updateTask).mockResolvedValue(task);
    vi.mocked(spawnAgent).mockResolvedValue(undefined);

    initAgentQueueRunner();
    await enqueueTask('q1', 'do something');
    await flushPromises();

    // Both readFileSync calls throw (no output files)
    vi.mocked(readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
    vi.mocked(readQuickSummary).mockResolvedValue(null);
    vi.mocked(agentQueueTaskStore.getTask).mockResolvedValue(
      makeTask({ status: 'running', agentId: 'quick_test_abc', startedAt: new Date().toISOString() }),
    );
    vi.mocked(agentQueueTaskStore.updateTask).mockClear();
    vi.mocked(agentQueueTaskStore.listTasks).mockResolvedValue([]);

    capturedExitCb!('quick_test_abc', 0);
    await flushPromises();

    // summary and detail should both be undefined (null coerced via || undefined)
    expect(agentQueueTaskStore.updateTask).toHaveBeenCalledWith('q1', 'task1', expect.objectContaining({
      status: 'completed',
      exitCode: 0,
      summary: undefined,
      detail: undefined,
    }));
  });
});

describe('concurrency limit enforcement', () => {
  it('only starts tasks up to concurrency limit (limit=1, 2 pending)', async () => {
    const queue = makeQueue({ concurrency: 1 });
    const task1 = makeTask({ id: 'task1', createdAt: '2024-01-01T00:00:00Z' });
    const task2 = makeTask({ id: 'task2', createdAt: '2024-01-01T00:01:00Z' });

    vi.mocked(agentQueueTaskStore.createTask).mockResolvedValue(task1);
    vi.mocked(agentQueueRegistry.get).mockResolvedValue(queue);
    // Both tasks are pending, no running tasks
    vi.mocked(agentQueueTaskStore.listTasks).mockResolvedValue([task1, task2]);
    vi.mocked(agentQueueTaskStore.updateTask).mockResolvedValue(task1);
    vi.mocked(spawnAgent).mockResolvedValue(undefined);

    let agentIdCounter = 0;
    vi.mocked(generateQuickAgentId).mockImplementation(() => `quick_${++agentIdCounter}`);

    await enqueueTask('q1', 'do something');
    await flushPromises();

    // Only one spawnAgent call because concurrency is 1 and 0 running
    expect(spawnAgent).toHaveBeenCalledTimes(1);
  });

  it('starts multiple tasks when concurrency allows (limit=3, 2 pending)', async () => {
    const queue = makeQueue({ concurrency: 3 });
    const task1 = makeTask({ id: 'task1', createdAt: '2024-01-01T00:00:00Z' });
    const task2 = makeTask({ id: 'task2', createdAt: '2024-01-01T00:01:00Z' });

    vi.mocked(agentQueueTaskStore.createTask).mockResolvedValue(task1);
    vi.mocked(agentQueueRegistry.get).mockResolvedValue(queue);
    vi.mocked(agentQueueTaskStore.listTasks).mockResolvedValue([task1, task2]);
    vi.mocked(agentQueueTaskStore.updateTask).mockResolvedValue(task1);
    vi.mocked(spawnAgent).mockResolvedValue(undefined);

    let agentIdCounter = 0;
    vi.mocked(generateQuickAgentId).mockImplementation(() => `quick_${++agentIdCounter}`);

    await enqueueTask('q1', 'do something');
    await flushPromises();

    // Both tasks should start since concurrency limit is 3
    expect(spawnAgent).toHaveBeenCalledTimes(2);
  });

  it('accounts for already-running tasks against concurrency limit', async () => {
    const queue = makeQueue({ concurrency: 1 });
    const runningTask = makeTask({ id: 'running1', status: 'running' });
    const pendingTask = makeTask({ id: 'pending1', status: 'pending' });

    vi.mocked(agentQueueTaskStore.createTask).mockResolvedValue(pendingTask);
    vi.mocked(agentQueueRegistry.get).mockResolvedValue(queue);
    vi.mocked(agentQueueTaskStore.listTasks).mockResolvedValue([runningTask, pendingTask]);
    vi.mocked(spawnAgent).mockResolvedValue(undefined);

    await enqueueTask('q1', 'do something');
    await flushPromises();

    // No new tasks should start — 1 running already fills the limit of 1
    expect(spawnAgent).not.toHaveBeenCalled();
  });
});

describe('re-entrancy prevention', () => {
  it('skips drain when already draining the same queue', async () => {
    const queue = makeQueue();
    // Make listTasks hang so we can trigger a second drain while the first is in-flight
    let resolveListTasks!: (value: AgentQueueTask[]) => void;
    vi.mocked(agentQueueRegistry.get).mockResolvedValue(queue);
    vi.mocked(agentQueueTaskStore.listTasks).mockReturnValue(
      new Promise<AgentQueueTask[]>((resolve) => { resolveListTasks = resolve; }),
    );
    vi.mocked(agentQueueTaskStore.createTask).mockResolvedValue(makeTask());

    // First enqueue triggers drainQueue
    const p1 = enqueueTask('q1', 'task 1');

    // Second enqueue triggers drainQueue while first is still pending
    vi.mocked(agentQueueTaskStore.createTask).mockResolvedValue(makeTask({ id: 'task2' }));
    const p2 = enqueueTask('q1', 'task 2');

    await p1;
    await p2;

    // Resolve the first drain
    resolveListTasks([]);
    await flushPromises();

    // registry.get should be called once for the first drain;
    // the second drain returns early due to re-entrancy guard.
    expect(agentQueueRegistry.get).toHaveBeenCalledTimes(1);
  });
});

describe('queue not found', () => {
  it('marks task as failed when queue does not exist during startTask', async () => {
    const task = makeTask();
    vi.mocked(agentQueueTaskStore.createTask).mockResolvedValue(task);

    // First call from drainQueue returns the queue, second from startTask returns null
    vi.mocked(agentQueueRegistry.get)
      .mockResolvedValueOnce(makeQueue())   // drainQueue lookup
      .mockResolvedValueOnce(null);          // startTask lookup — queue gone
    vi.mocked(agentQueueTaskStore.listTasks)
      .mockResolvedValueOnce([task])         // first drain — has a pending task
      .mockResolvedValue([]);                // any subsequent drains — empty
    vi.mocked(agentQueueTaskStore.updateTask).mockResolvedValue(task);

    await enqueueTask('q1', 'do something');
    await flushPromises();

    expect(agentQueueTaskStore.updateTask).toHaveBeenCalledWith('q1', 'task1', expect.objectContaining({
      status: 'failed',
      errorMessage: 'Queue no longer exists',
    }));
    // spawnAgent should NOT have been called
    expect(spawnAgent).not.toHaveBeenCalled();
  });
});

describe('no projectPath', () => {
  it('marks task as failed when queue has no projectPath', async () => {
    const queue = makeQueue({ projectPath: undefined });
    const task = makeTask();

    vi.mocked(agentQueueTaskStore.createTask).mockResolvedValue(task);
    vi.mocked(agentQueueRegistry.get).mockResolvedValue(queue);
    vi.mocked(agentQueueTaskStore.listTasks)
      .mockResolvedValueOnce([task])   // first drain — has a pending task
      .mockResolvedValue([]);          // subsequent drains — empty
    vi.mocked(agentQueueTaskStore.updateTask).mockResolvedValue(task);

    await enqueueTask('q1', 'do something');
    await flushPromises();

    expect(agentQueueTaskStore.updateTask).toHaveBeenCalledWith('q1', 'task1', expect.objectContaining({
      status: 'failed',
      errorMessage: 'No project configured for this queue',
    }));
    expect(spawnAgent).not.toHaveBeenCalled();
  });
});

describe('cancelTask', () => {
  it('delegates to task store', async () => {
    vi.mocked(agentQueueTaskStore.cancelTask).mockResolvedValue(true);

    const result = await cancelTask('q1', 'task1');

    expect(agentQueueTaskStore.cancelTask).toHaveBeenCalledWith('q1', 'task1');
    expect(result).toBe(true);
  });

  it('returns false when task store returns false', async () => {
    vi.mocked(agentQueueTaskStore.cancelTask).mockResolvedValue(false);

    const result = await cancelTask('q1', 'nonexistent');

    expect(result).toBe(false);
  });
});

describe('spawn failure', () => {
  it('marks task as failed and retriggers drain on spawn error', async () => {
    const queue = makeQueue();
    const task = makeTask();

    vi.mocked(agentQueueTaskStore.createTask).mockResolvedValue(task);
    vi.mocked(agentQueueRegistry.get).mockResolvedValue(queue);
    // First drain sees the pending task; the retry drain after failure sees empty
    vi.mocked(agentQueueTaskStore.listTasks)
      .mockResolvedValueOnce([task])   // initial drain
      .mockResolvedValue([]);          // retry drain after spawn failure
    vi.mocked(agentQueueTaskStore.updateTask).mockResolvedValue(task);
    vi.mocked(spawnAgent).mockRejectedValue(new Error('spawn failed'));

    await enqueueTask('q1', 'do something');
    await flushPromises();

    // Task should be marked running first, then failed after spawn error
    expect(agentQueueTaskStore.updateTask).toHaveBeenCalledWith('q1', 'task1', expect.objectContaining({
      status: 'running',
    }));
    expect(agentQueueTaskStore.updateTask).toHaveBeenCalledWith('q1', 'task1', expect.objectContaining({
      status: 'failed',
      errorMessage: 'spawn failed',
    }));

    // drainQueue should have been retriggered after failure
    // registry.get is called for: initial drain, startTask, retry drain
    expect(agentQueueRegistry.get).toHaveBeenCalledTimes(3);
  });

  it('uses fallback error message for non-Error throws', async () => {
    const queue = makeQueue();
    const task = makeTask();

    vi.mocked(agentQueueTaskStore.createTask).mockResolvedValue(task);
    vi.mocked(agentQueueRegistry.get).mockResolvedValue(queue);
    vi.mocked(agentQueueTaskStore.listTasks)
      .mockResolvedValueOnce([task])
      .mockResolvedValue([]);
    vi.mocked(agentQueueTaskStore.updateTask).mockResolvedValue(task);
    vi.mocked(spawnAgent).mockRejectedValue('string error');

    await enqueueTask('q1', 'do something');
    await flushPromises();

    expect(agentQueueTaskStore.updateTask).toHaveBeenCalledWith('q1', 'task1', expect.objectContaining({
      status: 'failed',
      errorMessage: 'Failed to spawn agent',
    }));
  });
});

describe('handleAgentExit edge cases', () => {
  it('ignores exit for unknown agent (not managed by queue)', async () => {
    initAgentQueueRunner();

    capturedExitCb!('unknown-agent', 0);
    await flushPromises();

    // No store calls should be made for unknown agents
    expect(agentQueueTaskStore.getTask).not.toHaveBeenCalled();
  });

  it('ignores exit if task is no longer running', async () => {
    const queue = makeQueue();
    const task = makeTask();

    vi.mocked(agentQueueTaskStore.createTask).mockResolvedValue(task);
    vi.mocked(agentQueueRegistry.get).mockResolvedValue(queue);
    vi.mocked(agentQueueTaskStore.listTasks).mockResolvedValue([task]);
    vi.mocked(agentQueueTaskStore.updateTask).mockResolvedValue(task);
    vi.mocked(spawnAgent).mockResolvedValue(undefined);

    initAgentQueueRunner();
    await enqueueTask('q1', 'do something');
    await flushPromises();

    // Return task as already completed (not running)
    vi.mocked(agentQueueTaskStore.getTask).mockResolvedValue(
      makeTask({ status: 'completed' }),
    );
    vi.mocked(agentQueueTaskStore.updateTask).mockClear();
    vi.mocked(agentQueueTaskStore.listTasks).mockResolvedValue([]);

    capturedExitCb!('quick_test_abc', 0);
    await flushPromises();

    // updateTask should NOT be called since task is not in running state
    expect(agentQueueTaskStore.updateTask).not.toHaveBeenCalled();
  });

  it('prefers file-based summary over quick summary', async () => {
    const queue = makeQueue();
    const task = makeTask();

    vi.mocked(agentQueueTaskStore.createTask).mockResolvedValue(task);
    vi.mocked(agentQueueRegistry.get).mockResolvedValue(queue);
    vi.mocked(agentQueueTaskStore.listTasks).mockResolvedValue([task]);
    vi.mocked(agentQueueTaskStore.updateTask).mockResolvedValue(task);
    vi.mocked(spawnAgent).mockResolvedValue(undefined);

    initAgentQueueRunner();
    await enqueueTask('q1', 'do something');
    await flushPromises();

    vi.mocked(agentQueueTaskStore.getTask).mockResolvedValue(
      makeTask({ status: 'running', agentId: 'quick_test_abc', startedAt: new Date().toISOString() }),
    );
    vi.mocked(readFileSync).mockImplementation((filePath: unknown) => {
      const p = String(filePath);
      if (p.endsWith('summary.md')) return 'File-based summary';
      if (p.endsWith('detail.md')) return 'File-based detail';
      throw new Error('ENOENT');
    });
    vi.mocked(readQuickSummary).mockResolvedValue({
      summary: 'Quick agent summary (should not be used)',
      filesModified: ['a.ts'],
    });
    vi.mocked(agentQueueTaskStore.updateTask).mockClear();
    vi.mocked(agentQueueTaskStore.listTasks).mockResolvedValue([]);

    capturedExitCb!('quick_test_abc', 0);
    await flushPromises();

    expect(agentQueueTaskStore.updateTask).toHaveBeenCalledWith('q1', 'task1', expect.objectContaining({
      summary: 'File-based summary',
      detail: 'File-based detail',
      filesModified: ['a.ts'],
    }));
  });

  it('falls back to quick summary when file summary is absent', async () => {
    const queue = makeQueue();
    const task = makeTask();

    vi.mocked(agentQueueTaskStore.createTask).mockResolvedValue(task);
    vi.mocked(agentQueueRegistry.get).mockResolvedValue(queue);
    vi.mocked(agentQueueTaskStore.listTasks).mockResolvedValue([task]);
    vi.mocked(agentQueueTaskStore.updateTask).mockResolvedValue(task);
    vi.mocked(spawnAgent).mockResolvedValue(undefined);

    initAgentQueueRunner();
    await enqueueTask('q1', 'do something');
    await flushPromises();

    vi.mocked(agentQueueTaskStore.getTask).mockResolvedValue(
      makeTask({ status: 'running', agentId: 'quick_test_abc', startedAt: new Date().toISOString() }),
    );
    // File reads fail — no output files written
    vi.mocked(readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
    vi.mocked(readQuickSummary).mockResolvedValue({
      summary: 'Quick agent fallback summary',
      filesModified: ['b.ts'],
    });
    vi.mocked(agentQueueTaskStore.updateTask).mockClear();
    vi.mocked(agentQueueTaskStore.listTasks).mockResolvedValue([]);

    capturedExitCb!('quick_test_abc', 0);
    await flushPromises();

    expect(agentQueueTaskStore.updateTask).toHaveBeenCalledWith('q1', 'task1', expect.objectContaining({
      summary: 'Quick agent fallback summary',
      filesModified: ['b.ts'],
    }));
  });
});
