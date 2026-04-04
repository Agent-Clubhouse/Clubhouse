import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  app: { getPath: () => '/tmp/clubhouse-test' },
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock('../services/agent-queue-registry', () => ({
  agentQueueRegistry: {
    list: vi.fn(async () => []),
    create: vi.fn(async (name: string) => ({ id: 'aq-1', name })),
    get: vi.fn(async (id: string) => ({ id, name: 'Test Queue' })),
    update: vi.fn(async (id: string, fields: any) => ({ id, ...fields })),
    delete: vi.fn(async () => true),
    onChange: vi.fn(),
  },
}));

vi.mock('../services/agent-queue-task-store', () => ({
  agentQueueTaskStore: {
    listTaskSummaries: vi.fn(async () => [{ id: 'task-1', status: 'pending' }]),
    getTask: vi.fn(async (queueId: string, taskId: string) => ({
      id: taskId, queueId, status: 'pending', payload: {},
    })),
    deleteQueueTasks: vi.fn(async () => undefined),
    onChange: vi.fn(),
  },
}));

vi.mock('../services/agent-queue-runner', () => ({
  initAgentQueueRunner: vi.fn(),
}));

vi.mock('../services/mcp-settings', () => ({
  isMcpEnabledForAny: vi.fn(() => true),
}));

vi.mock('../services/log-service', () => ({
  appLog: vi.fn(),
}));

vi.mock('../util/ipc-broadcast', () => ({
  broadcastToAllWindows: vi.fn(),
}));

import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import { agentQueueRegistry } from '../services/agent-queue-registry';
import { agentQueueTaskStore } from '../services/agent-queue-task-store';
import { initAgentQueueRunner } from '../services/agent-queue-runner';
import { isMcpEnabledForAny } from '../services/mcp-settings';
import { broadcastToAllWindows } from '../util/ipc-broadcast';

type HandlerFn = (...args: unknown[]) => unknown;
const handlers = new Map<string, HandlerFn>();

const fakeEvent = { sender: { id: 1 } } as any;

/**
 * Because the module uses a module-level `handlersRegistered` guard with no
 * exported reset function, we re-import the module fresh for each test via
 * `vi.resetModules()` + dynamic import. This guarantees the guard is always
 * cleared before each test.
 */
async function freshRegister(): Promise<typeof import('./agent-queue-handlers')> {
  vi.resetModules();
  // Re-apply the handler capture after module reset
  vi.mocked(ipcMain.handle).mockImplementation((channel: string, handler: HandlerFn) => {
    handlers.set(channel, handler);
    return undefined as any;
  });
  return import('./agent-queue-handlers');
}

function getHandler(channel: string): HandlerFn {
  const h = handlers.get(channel);
  if (!h) throw new Error(`No handler for ${channel}. Registered: ${Array.from(handlers.keys()).join(', ')}`);
  return h;
}

beforeEach(() => {
  vi.clearAllMocks();
  handlers.clear();
});

describe('agent-queue-handlers', () => {
  // ── Registration ──────────────────────────────────────────────────────

  it('skips registration when MCP is not enabled', async () => {
    vi.mocked(isMcpEnabledForAny).mockReturnValue(false);
    const mod = await freshRegister();
    mod.registerAgentQueueHandlers();
    expect(ipcMain.handle).not.toHaveBeenCalled();
    expect(initAgentQueueRunner).not.toHaveBeenCalled();
  });

  it('registers all 7 IPC handlers when MCP is enabled', async () => {
    vi.mocked(isMcpEnabledForAny).mockReturnValue(true);
    const mod = await freshRegister();
    mod.registerAgentQueueHandlers();

    const expectedChannels = [
      IPC.AGENT_QUEUE.LIST,
      IPC.AGENT_QUEUE.CREATE,
      IPC.AGENT_QUEUE.GET,
      IPC.AGENT_QUEUE.UPDATE,
      IPC.AGENT_QUEUE.DELETE,
      IPC.AGENT_QUEUE.LIST_TASKS,
      IPC.AGENT_QUEUE.GET_TASK,
    ];
    for (const channel of expectedChannels) {
      expect(handlers.has(channel), `Missing handler for ${channel}`).toBe(true);
    }
    expect(vi.mocked(ipcMain.handle).mock.calls.length).toBe(7);
  });

  it('is idempotent — calling twice does not double-register', async () => {
    vi.mocked(isMcpEnabledForAny).mockReturnValue(true);
    const mod = await freshRegister();
    mod.registerAgentQueueHandlers();
    const callCount = vi.mocked(ipcMain.handle).mock.calls.length;
    mod.registerAgentQueueHandlers();
    expect(vi.mocked(ipcMain.handle).mock.calls.length).toBe(callCount);
  });

  it('calls initAgentQueueRunner on registration', async () => {
    vi.mocked(isMcpEnabledForAny).mockReturnValue(true);
    const mod = await freshRegister();
    mod.registerAgentQueueHandlers();
    expect(initAgentQueueRunner).toHaveBeenCalledOnce();
  });

  it('subscribes to registry onChange for broadcast', async () => {
    vi.mocked(isMcpEnabledForAny).mockReturnValue(true);
    const mod = await freshRegister();
    mod.registerAgentQueueHandlers();
    expect(agentQueueRegistry.onChange).toHaveBeenCalled();
  });

  it('subscribes to task store onChange for broadcast', async () => {
    vi.mocked(isMcpEnabledForAny).mockReturnValue(true);
    const mod = await freshRegister();
    mod.registerAgentQueueHandlers();
    expect(agentQueueTaskStore.onChange).toHaveBeenCalled();
  });

  // ── onChange broadcasts ───────────────────────────────────────────────

  it('broadcasts queue list when registry onChange fires', async () => {
    vi.mocked(isMcpEnabledForAny).mockReturnValue(true);
    const mod = await freshRegister();
    mod.registerAgentQueueHandlers();

    const queues = [{ id: 'aq-1', name: 'Queue A' }];
    vi.mocked(agentQueueRegistry.list).mockResolvedValue(queues as any);

    const onChangeCallback = vi.mocked(agentQueueRegistry.onChange).mock.calls[0][0];
    onChangeCallback();

    await vi.waitFor(() => {
      expect(broadcastToAllWindows).toHaveBeenCalledWith(IPC.AGENT_QUEUE.CHANGED, queues);
    });
  });

  it('broadcasts task change when task store onChange fires', async () => {
    vi.mocked(isMcpEnabledForAny).mockReturnValue(true);
    const mod = await freshRegister();
    mod.registerAgentQueueHandlers();

    const onChangeCallback = vi.mocked(agentQueueTaskStore.onChange).mock.calls[0][0];
    onChangeCallback('aq-1', 'task-42');

    expect(broadcastToAllWindows).toHaveBeenCalledWith(
      IPC.AGENT_QUEUE.TASK_CHANGED,
      { queueId: 'aq-1', taskId: 'task-42' },
    );
  });

  // ── LIST ──────────────────────────────────────────────────────────────

  describe('LIST', () => {
    beforeEach(async () => {
      vi.mocked(isMcpEnabledForAny).mockReturnValue(true);
      const mod = await freshRegister();
      mod.registerAgentQueueHandlers();
    });

    it('returns the registry list', async () => {
      const queues = [{ id: 'aq-1', name: 'Queue A' }, { id: 'aq-2', name: 'Queue B' }];
      vi.mocked(agentQueueRegistry.list).mockResolvedValue(queues as any);
      const handler = getHandler(IPC.AGENT_QUEUE.LIST);
      const result = await handler(fakeEvent);
      expect(result).toEqual(queues);
    });
  });

  // ── CREATE ────────────────────────────────────────────────────────────

  describe('CREATE', () => {
    beforeEach(async () => {
      vi.mocked(isMcpEnabledForAny).mockReturnValue(true);
      const mod = await freshRegister();
      mod.registerAgentQueueHandlers();
    });

    it('validates string arg and creates queue', async () => {
      const handler = getHandler(IPC.AGENT_QUEUE.CREATE);
      const result = await handler(fakeEvent, 'My Queue');
      expect(agentQueueRegistry.create).toHaveBeenCalledWith('My Queue');
      expect(result).toEqual({ id: 'aq-1', name: 'My Queue' });
    });

    it('rejects non-string arg', () => {
      const handler = getHandler(IPC.AGENT_QUEUE.CREATE);
      expect(() => handler(fakeEvent, 123)).toThrow();
    });

    it('rejects missing name argument', () => {
      const handler = getHandler(IPC.AGENT_QUEUE.CREATE);
      expect(() => handler(fakeEvent)).toThrow();
    });
  });

  // ── GET ───────────────────────────────────────────────────────────────

  describe('GET', () => {
    beforeEach(async () => {
      vi.mocked(isMcpEnabledForAny).mockReturnValue(true);
      const mod = await freshRegister();
      mod.registerAgentQueueHandlers();
    });

    it('returns queue by id', async () => {
      const handler = getHandler(IPC.AGENT_QUEUE.GET);
      const result = await handler(fakeEvent, 'aq-1');
      expect(agentQueueRegistry.get).toHaveBeenCalledWith('aq-1');
      expect(result).toEqual({ id: 'aq-1', name: 'Test Queue' });
    });

    it('rejects missing id', () => {
      const handler = getHandler(IPC.AGENT_QUEUE.GET);
      expect(() => handler(fakeEvent)).toThrow();
    });
  });

  // ── UPDATE ────────────────────────────────────────────────────────────

  describe('UPDATE', () => {
    beforeEach(async () => {
      vi.mocked(isMcpEnabledForAny).mockReturnValue(true);
      const mod = await freshRegister();
      mod.registerAgentQueueHandlers();
    });

    it('updates queue with id and fields', async () => {
      const fields = { name: 'Updated Queue' };
      const handler = getHandler(IPC.AGENT_QUEUE.UPDATE);
      const result = await handler(fakeEvent, 'aq-1', fields);
      expect(agentQueueRegistry.update).toHaveBeenCalledWith('aq-1', fields);
      expect(result).toEqual({ id: 'aq-1', name: 'Updated Queue' });
    });

    it('rejects missing fields argument', () => {
      const handler = getHandler(IPC.AGENT_QUEUE.UPDATE);
      expect(() => handler(fakeEvent, 'aq-1')).toThrow();
    });

    it('rejects non-object fields', () => {
      const handler = getHandler(IPC.AGENT_QUEUE.UPDATE);
      expect(() => handler(fakeEvent, 'aq-1', 'not-an-object')).toThrow();
    });
  });

  // ── DELETE ────────────────────────────────────────────────────────────

  describe('DELETE', () => {
    beforeEach(async () => {
      vi.mocked(isMcpEnabledForAny).mockReturnValue(true);
      const mod = await freshRegister();
      mod.registerAgentQueueHandlers();
    });

    it('deletes queue and its tasks', async () => {
      const handler = getHandler(IPC.AGENT_QUEUE.DELETE);
      const result = await handler(fakeEvent, 'aq-1');
      expect(agentQueueRegistry.delete).toHaveBeenCalledWith('aq-1');
      expect(agentQueueTaskStore.deleteQueueTasks).toHaveBeenCalledWith('aq-1');
      expect(result).toBe(true);
    });

    it('does not delete tasks when queue delete returns false', async () => {
      vi.mocked(agentQueueRegistry.delete).mockResolvedValue(false);
      const handler = getHandler(IPC.AGENT_QUEUE.DELETE);
      const result = await handler(fakeEvent, 'aq-nonexistent');
      expect(agentQueueTaskStore.deleteQueueTasks).not.toHaveBeenCalled();
      expect(result).toBe(false);
    });

    it('rejects missing id', () => {
      const handler = getHandler(IPC.AGENT_QUEUE.DELETE);
      expect(() => handler(fakeEvent)).toThrow();
    });
  });

  // ── LIST_TASKS ────────────────────────────────────────────────────────

  describe('LIST_TASKS', () => {
    beforeEach(async () => {
      vi.mocked(isMcpEnabledForAny).mockReturnValue(true);
      const mod = await freshRegister();
      mod.registerAgentQueueHandlers();
    });

    it('returns task summaries for a queue', async () => {
      const tasks = [{ id: 'task-1', status: 'pending' }, { id: 'task-2', status: 'done' }];
      vi.mocked(agentQueueTaskStore.listTaskSummaries).mockResolvedValue(tasks as any);
      const handler = getHandler(IPC.AGENT_QUEUE.LIST_TASKS);
      const result = await handler(fakeEvent, 'aq-1');
      expect(agentQueueTaskStore.listTaskSummaries).toHaveBeenCalledWith('aq-1');
      expect(result).toEqual(tasks);
    });

    it('rejects missing queueId', () => {
      const handler = getHandler(IPC.AGENT_QUEUE.LIST_TASKS);
      expect(() => handler(fakeEvent)).toThrow();
    });
  });

  // ── GET_TASK ──────────────────────────────────────────────────────────

  describe('GET_TASK', () => {
    beforeEach(async () => {
      vi.mocked(isMcpEnabledForAny).mockReturnValue(true);
      const mod = await freshRegister();
      mod.registerAgentQueueHandlers();
    });

    it('returns task by queueId and taskId', async () => {
      const handler = getHandler(IPC.AGENT_QUEUE.GET_TASK);
      const result = await handler(fakeEvent, 'aq-1', 'task-1');
      expect(agentQueueTaskStore.getTask).toHaveBeenCalledWith('aq-1', 'task-1');
      expect(result).toEqual({
        id: 'task-1', queueId: 'aq-1', status: 'pending', payload: {},
      });
    });

    it('rejects missing taskId', () => {
      const handler = getHandler(IPC.AGENT_QUEUE.GET_TASK);
      expect(() => handler(fakeEvent, 'aq-1')).toThrow();
    });

    it('rejects missing both arguments', () => {
      const handler = getHandler(IPC.AGENT_QUEUE.GET_TASK);
      expect(() => handler(fakeEvent)).toThrow();
    });
  });
});
