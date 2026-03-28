import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { getPath: () => '/tmp/clubhouse-test' },
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock('../services/group-project-registry', () => ({
  groupProjectRegistry: {
    list: vi.fn(async () => []),
    create: vi.fn(async (name: string) => ({ id: 'gp-1', name })),
    get: vi.fn(async (id: string) => ({ id, name: 'Test Project' })),
    update: vi.fn(async (id: string, fields: any) => ({ id, ...fields })),
    delete: vi.fn(async () => true),
    onChange: vi.fn(),
  },
}));

const mockBoard = {
  getDigest: vi.fn(() => []),
  getTopicMessages: vi.fn(() => []),
  getAllMessages: vi.fn(() => []),
  postMessage: vi.fn(async (_sender: string, topic: string, body: string) => ({
    id: 'msg-1', sender: 'user', topic, body, timestamp: new Date().toISOString(),
  })),
};

vi.mock('../services/group-project-bulletin', () => ({
  getBulletinBoard: vi.fn(() => mockBoard),
  destroyBulletinBoard: vi.fn(async () => undefined),
}));

vi.mock('../services/clubhouse-mcp/tools/group-project-tools', () => ({
  registerGroupProjectTools: vi.fn(),
}));

vi.mock('../services/group-project-lifecycle', () => ({
  initGroupProjectLifecycle: vi.fn(),
}));

vi.mock('../services/group-project-shoulder-tap', () => ({
  executeShoulderTap: vi.fn(async () => ({ delivered: true })),
}));

vi.mock('../services/annex-event-bus', () => ({
  emitGroupProjectChanged: vi.fn(),
  emitBulletinMessage: vi.fn(),
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
import { groupProjectRegistry } from '../services/group-project-registry';
import { getBulletinBoard, destroyBulletinBoard } from '../services/group-project-bulletin';
import { executeShoulderTap } from '../services/group-project-shoulder-tap';
import * as annexEventBus from '../services/annex-event-bus';
import { isMcpEnabledForAny } from '../services/mcp-settings';
import { broadcastToAllWindows } from '../util/ipc-broadcast';
import { registerGroupProjectHandlers, _resetHandlersForTesting } from './group-project-handlers';

type HandlerFn = (...args: unknown[]) => unknown;
const handlers = new Map<string, HandlerFn>();

const fakeEvent = { sender: { id: 1 } } as any;

beforeEach(() => {
  vi.clearAllMocks();
  handlers.clear();
  vi.mocked(ipcMain.handle).mockImplementation((channel: string, handler: HandlerFn) => {
    handlers.set(channel, handler);
    return undefined as any;
  });
  _resetHandlersForTesting();
  registerGroupProjectHandlers();
});

function getHandler(channel: string): HandlerFn {
  const h = handlers.get(channel);
  if (!h) throw new Error(`No handler for ${channel}. Registered: ${Array.from(handlers.keys()).join(', ')}`);
  return h;
}

describe('group-project-handlers', () => {
  // ── Registration ──────────────────────────────────────────────────────

  it('registers all expected IPC handlers', () => {
    const expectedChannels = [
      IPC.GROUP_PROJECT.LIST,
      IPC.GROUP_PROJECT.CREATE,
      IPC.GROUP_PROJECT.GET,
      IPC.GROUP_PROJECT.UPDATE,
      IPC.GROUP_PROJECT.DELETE,
      IPC.GROUP_PROJECT.GET_BULLETIN_DIGEST,
      IPC.GROUP_PROJECT.GET_TOPIC_MESSAGES,
      IPC.GROUP_PROJECT.GET_ALL_MESSAGES,
      IPC.GROUP_PROJECT.POST_BULLETIN_MESSAGE,
      IPC.GROUP_PROJECT.SEND_SHOULDER_TAP,
    ];
    for (const channel of expectedChannels) {
      expect(handlers.has(channel), `Missing handler for ${channel}`).toBe(true);
    }
  });

  it('is idempotent — second call does not re-register', () => {
    const callCount = vi.mocked(ipcMain.handle).mock.calls.length;
    registerGroupProjectHandlers();
    expect(vi.mocked(ipcMain.handle).mock.calls.length).toBe(callCount);
  });

  it('does not register when MCP is disabled', () => {
    vi.mocked(isMcpEnabledForAny).mockReturnValue(false);
    handlers.clear();
    vi.mocked(ipcMain.handle).mockClear();
    _resetHandlersForTesting();
    registerGroupProjectHandlers();
    expect(ipcMain.handle).not.toHaveBeenCalled();
  });

  it('subscribes to registry onChange for broadcast', () => {
    expect(groupProjectRegistry.onChange).toHaveBeenCalled();
  });

  it('broadcasts project list when onChange fires', async () => {
    const projects = [{ id: 'gp-1', name: 'Test' }];
    vi.mocked(groupProjectRegistry.list).mockResolvedValue(projects as any);
    const onChangeCallback = vi.mocked(groupProjectRegistry.onChange).mock.calls[0][0];
    onChangeCallback();
    // Allow the async broadcast to settle
    await vi.waitFor(() => {
      expect(broadcastToAllWindows).toHaveBeenCalledWith(IPC.GROUP_PROJECT.CHANGED, projects);
    });
  });

  // ── LIST ──────────────────────────────────────────────────────────────

  describe('LIST', () => {
    it('returns list of projects', async () => {
      const projects = [{ id: 'gp-1', name: 'Project A' }];
      vi.mocked(groupProjectRegistry.list).mockResolvedValue(projects as any);
      const handler = getHandler(IPC.GROUP_PROJECT.LIST);
      const result = await handler(fakeEvent);
      expect(result).toEqual(projects);
    });
  });

  // ── CREATE ────────────────────────────────────────────────────────────

  describe('CREATE', () => {
    it('creates project and emits event', async () => {
      const handler = getHandler(IPC.GROUP_PROJECT.CREATE);
      const result = await handler(fakeEvent, 'My Project');
      expect(groupProjectRegistry.create).toHaveBeenCalledWith('My Project');
      expect(annexEventBus.emitGroupProjectChanged).toHaveBeenCalledWith('created', { id: 'gp-1', name: 'My Project' });
      expect(result).toEqual({ id: 'gp-1', name: 'My Project' });
    });

    it('rejects missing name argument', () => {
      const handler = getHandler(IPC.GROUP_PROJECT.CREATE);
      expect(() => handler(fakeEvent)).toThrow();
    });

    it('rejects non-string name argument', () => {
      const handler = getHandler(IPC.GROUP_PROJECT.CREATE);
      expect(() => handler(fakeEvent, 123)).toThrow();
    });
  });

  // ── GET ───────────────────────────────────────────────────────────────

  describe('GET', () => {
    it('returns project by ID', async () => {
      const handler = getHandler(IPC.GROUP_PROJECT.GET);
      const result = await handler(fakeEvent, 'gp-1');
      expect(groupProjectRegistry.get).toHaveBeenCalledWith('gp-1');
      expect(result).toEqual({ id: 'gp-1', name: 'Test Project' });
    });

    it('rejects missing ID', () => {
      const handler = getHandler(IPC.GROUP_PROJECT.GET);
      expect(() => handler(fakeEvent)).toThrow();
    });
  });

  // ── UPDATE ────────────────────────────────────────────────────────────

  describe('UPDATE', () => {
    it('updates project and emits event', async () => {
      const handler = getHandler(IPC.GROUP_PROJECT.UPDATE);
      const fields = { name: 'Updated Name' };
      const result = await handler(fakeEvent, 'gp-1', fields);
      expect(groupProjectRegistry.update).toHaveBeenCalledWith('gp-1', fields);
      expect(annexEventBus.emitGroupProjectChanged).toHaveBeenCalledWith('updated', { id: 'gp-1', name: 'Updated Name' });
      expect(result).toEqual({ id: 'gp-1', name: 'Updated Name' });
    });

    it('does not emit event when update returns null', async () => {
      vi.mocked(groupProjectRegistry.update).mockResolvedValue(null as any);
      const handler = getHandler(IPC.GROUP_PROJECT.UPDATE);
      await handler(fakeEvent, 'nonexistent', { name: 'x' });
      expect(annexEventBus.emitGroupProjectChanged).not.toHaveBeenCalled();
    });

    it('rejects missing fields argument', () => {
      const handler = getHandler(IPC.GROUP_PROJECT.UPDATE);
      expect(() => handler(fakeEvent, 'gp-1')).toThrow();
    });

    it('rejects non-object fields', () => {
      const handler = getHandler(IPC.GROUP_PROJECT.UPDATE);
      expect(() => handler(fakeEvent, 'gp-1', 'not-an-object')).toThrow();
    });
  });

  // ── DELETE ────────────────────────────────────────────────────────────

  describe('DELETE', () => {
    it('deletes project, emits event, and destroys bulletin', async () => {
      const handler = getHandler(IPC.GROUP_PROJECT.DELETE);
      const result = await handler(fakeEvent, 'gp-1');
      expect(groupProjectRegistry.delete).toHaveBeenCalledWith('gp-1');
      expect(annexEventBus.emitGroupProjectChanged).toHaveBeenCalledWith('deleted', { id: 'gp-1', name: 'Test Project' });
      expect(destroyBulletinBoard).toHaveBeenCalledWith('gp-1');
      expect(result).toBe(true);
    });

    it('does not emit event when delete returns false', async () => {
      vi.mocked(groupProjectRegistry.delete).mockResolvedValue(false);
      const handler = getHandler(IPC.GROUP_PROJECT.DELETE);
      await handler(fakeEvent, 'nonexistent');
      expect(annexEventBus.emitGroupProjectChanged).not.toHaveBeenCalled();
      expect(destroyBulletinBoard).not.toHaveBeenCalled();
    });

    it('rejects missing ID', () => {
      const handler = getHandler(IPC.GROUP_PROJECT.DELETE);
      expect(() => handler(fakeEvent)).toThrow();
    });
  });

  // ── Bulletin Board ────────────────────────────────────────────────────

  describe('GET_BULLETIN_DIGEST', () => {
    it('returns digest from bulletin board', async () => {
      const digest = [{ topic: 'progress', messageCount: 5 }];
      mockBoard.getDigest.mockReturnValue(digest);
      const handler = getHandler(IPC.GROUP_PROJECT.GET_BULLETIN_DIGEST);
      const result = await handler(fakeEvent, 'gp-1');
      expect(getBulletinBoard).toHaveBeenCalledWith('gp-1');
      expect(result).toEqual(digest);
    });

    it('passes since parameter when provided', async () => {
      const handler = getHandler(IPC.GROUP_PROJECT.GET_BULLETIN_DIGEST);
      await handler(fakeEvent, 'gp-1', '2026-03-28T00:00:00Z');
      expect(mockBoard.getDigest).toHaveBeenCalledWith('2026-03-28T00:00:00Z');
    });

    it('passes undefined since when omitted', async () => {
      const handler = getHandler(IPC.GROUP_PROJECT.GET_BULLETIN_DIGEST);
      await handler(fakeEvent, 'gp-1');
      expect(mockBoard.getDigest).toHaveBeenCalledWith(undefined);
    });
  });

  describe('GET_TOPIC_MESSAGES', () => {
    it('returns messages for a topic', async () => {
      const messages = [{ id: 'msg-1', topic: 'progress', body: 'hello' }];
      mockBoard.getTopicMessages.mockReturnValue(messages);
      const handler = getHandler(IPC.GROUP_PROJECT.GET_TOPIC_MESSAGES);
      const result = await handler(fakeEvent, 'gp-1', 'progress');
      expect(mockBoard.getTopicMessages).toHaveBeenCalledWith('progress', undefined, undefined);
      expect(result).toEqual(messages);
    });

    it('passes since and limit parameters', async () => {
      const handler = getHandler(IPC.GROUP_PROJECT.GET_TOPIC_MESSAGES);
      await handler(fakeEvent, 'gp-1', 'progress', '2026-03-28T00:00:00Z', 10);
      expect(mockBoard.getTopicMessages).toHaveBeenCalledWith('progress', '2026-03-28T00:00:00Z', 10);
    });

    it('rejects missing topic', () => {
      const handler = getHandler(IPC.GROUP_PROJECT.GET_TOPIC_MESSAGES);
      expect(() => handler(fakeEvent, 'gp-1')).toThrow();
    });
  });

  describe('GET_ALL_MESSAGES', () => {
    it('returns all messages', async () => {
      const messages = [{ id: 'msg-1', body: 'hello' }];
      mockBoard.getAllMessages.mockReturnValue(messages);
      const handler = getHandler(IPC.GROUP_PROJECT.GET_ALL_MESSAGES);
      const result = await handler(fakeEvent, 'gp-1');
      expect(mockBoard.getAllMessages).toHaveBeenCalledWith(undefined, undefined);
      expect(result).toEqual(messages);
    });

    it('passes since and limit', async () => {
      const handler = getHandler(IPC.GROUP_PROJECT.GET_ALL_MESSAGES);
      await handler(fakeEvent, 'gp-1', '2026-03-28T00:00:00Z', 50);
      expect(mockBoard.getAllMessages).toHaveBeenCalledWith('2026-03-28T00:00:00Z', 50);
    });
  });

  describe('POST_BULLETIN_MESSAGE', () => {
    it('posts message and emits event', async () => {
      const handler = getHandler(IPC.GROUP_PROJECT.POST_BULLETIN_MESSAGE);
      const result = await handler(fakeEvent, 'gp-1', 'progress', 'Done!');
      expect(mockBoard.postMessage).toHaveBeenCalledWith('user', 'progress', 'Done!');
      expect(annexEventBus.emitBulletinMessage).toHaveBeenCalledWith('gp-1', expect.objectContaining({ topic: 'progress', body: 'Done!' }));
      expect(result).toMatchObject({ id: 'msg-1', topic: 'progress', body: 'Done!' });
    });

    it('rejects missing body', () => {
      const handler = getHandler(IPC.GROUP_PROJECT.POST_BULLETIN_MESSAGE);
      expect(() => handler(fakeEvent, 'gp-1', 'progress')).toThrow();
    });

    it('rejects missing topic', () => {
      const handler = getHandler(IPC.GROUP_PROJECT.POST_BULLETIN_MESSAGE);
      expect(() => handler(fakeEvent, 'gp-1')).toThrow();
    });
  });

  // ── Shoulder Tap ──────────────────────────────────────────────────────

  describe('SEND_SHOULDER_TAP', () => {
    it('executes shoulder tap with target agent', async () => {
      const handler = getHandler(IPC.GROUP_PROJECT.SEND_SHOULDER_TAP);
      await handler(fakeEvent, 'gp-1', 'agent-2', 'Hey, check this out');
      expect(executeShoulderTap).toHaveBeenCalledWith({
        projectId: 'gp-1',
        senderLabel: 'user',
        targetAgentId: 'agent-2',
        message: 'Hey, check this out',
      });
    });

    it('sends broadcast tap when targetAgentId is undefined', async () => {
      const handler = getHandler(IPC.GROUP_PROJECT.SEND_SHOULDER_TAP);
      await handler(fakeEvent, 'gp-1', undefined, 'Everyone listen');
      expect(executeShoulderTap).toHaveBeenCalledWith({
        projectId: 'gp-1',
        senderLabel: 'user',
        targetAgentId: null,
        message: 'Everyone listen',
      });
    });

    it('rejects missing message', () => {
      const handler = getHandler(IPC.GROUP_PROJECT.SEND_SHOULDER_TAP);
      expect(() => handler(fakeEvent, 'gp-1', 'agent-2')).toThrow();
    });
  });
});
