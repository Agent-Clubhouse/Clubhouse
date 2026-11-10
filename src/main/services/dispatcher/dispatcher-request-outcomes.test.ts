import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { DurableAgentConfig } from '../../../shared/types';

/**
 * The failure-after-accept path (#3237), end to end: start_work hands the
 * request off and says it is under way; the Dispatcher's turn then fails, and
 * the chat the user sees gets that request's failure.
 */

const h = vi.hoisted(() => ({
  base: '',
  running: new Set<string>(),
  toChat: [] as Array<{ id: string; text: string }>,
  handlers: new Map<string, (agentId: string, args: Record<string, unknown>) => Promise<unknown>>(),
}));

vi.mock('../base-dir', () => ({ getBaseDirPath: () => h.base }));
vi.mock('../log-service', () => ({ appLog: vi.fn() }));
vi.mock('../../util/ipc-broadcast', () => ({ broadcastToAllWindows: vi.fn() }));
vi.mock('./dispatcher-settings', () => ({ isDispatcherEnabled: () => true }));
vi.mock('./dispatcher-paths', () => ({ getDispatcherPath: () => '/base/dispatcher', getDispatcherChatPath: () => '/base/dispatcher-chat' }));
vi.mock('../clubhouse-mcp/tools/dispatcher-delivery', () => ({
  dispatcherInboxId: () => 'coordinator',
  // The Dispatcher was idle: the hand-off starts its turn.
  deliverToDispatcher: vi.fn(async (): Promise<unknown> => ({ delivered: true, woke: false, delivery: 'prompt' })),
}));
vi.mock('./dispatcher-service', () => ({
  dispatcherDisplayName: () => 'Dispatcher',
  getDispatcherAgentId: () => 'coordinator',
  getDispatcherChatAgentId: () => 'chat',
  isDispatcherAgentId: (id: string) => id === 'coordinator',
  isDispatcherChatAgentId: (id: string) => id === 'chat',
}));
vi.mock('../agent-config', () => ({
  getDurableConfig: vi.fn(async (): Promise<DurableAgentConfig> => ({ id: 'chat', name: 'Dispatcher', color: 'indigo', createdAt: 'now', orchestrator: 'codex-cli' })),
}));
vi.mock('../agent-system', () => ({
  isAgentRunning: (id: string) => h.running.has(id),
  isAgentStopping: () => false,
  waitForAgentStopped: vi.fn(async () => true),
  spawnAgent: vi.fn(async () => undefined),
}));
vi.mock('../clubhouse-mcp/tools/helper-delivery', () => ({
  deliverNow: vi.fn(async (id: string, text: string) => { h.toChat.push({ id, text }); return 'delivered'; }),
}));
vi.mock('../clubhouse-mcp/tool-registry', () => ({
  registerGlobalTool: (name: string, _def: unknown, handler: (agentId: string, args: Record<string, unknown>) => Promise<unknown>) => {
    h.handlers.set(name, handler);
  },
}));

import { publishChatEvent, removeAllChatEventListeners } from '../agent-runtime/chat-event-bus';
import type { ChatEvent, ChatEventDataMap } from '../../../shared/chat';
import { registerDispatcherChatTools } from '../clubhouse-mcp/tools/dispatcher-chat-tools';
import { _resetDispatcherChannelForTesting, setChatDelivery } from './dispatcher-channel';
import { installRequestTracking, requestEndedMessage } from './dispatcher-request-outcomes';
import { _resetDispatcherRequestsForTesting, getRequest, getRequestsPath, requestsUnderWay } from './dispatcher-requests';

h.base = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatcher-outcomes-test-'));
afterAll(() => fs.rmSync(h.base, { recursive: true, force: true }));

function publish<T extends keyof ChatEventDataMap>(agentId: string, type: T, data: ChatEventDataMap[T]): void {
  publishChatEvent({ v: 1, agentId, sessionId: 's', seq: 1, ts: Date.now(), type, data } as unknown as ChatEvent);
}

async function startWork(request: string, extra: Record<string, unknown> = {}): Promise<string> {
  const result = await h.handlers.get('start_work')!('chat', { request, ...extra }) as { content: Array<{ text: string }>; isError?: boolean };
  expect(result.isError).toBeUndefined();
  return result.content[0].text;
}

const idIn = (text: string) => /Request (req_\w+)/.exec(text)?.[1] ?? '';
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

let stop: () => void;

beforeEach(async () => {
  await _resetDispatcherRequestsForTesting();
  fs.rmSync(getRequestsPath(), { force: true });
  _resetDispatcherChannelForTesting();
  h.running = new Set(['chat', 'coordinator']);
  h.toChat = [];
  h.handlers.clear();
  registerDispatcherChatTools();
  stop = installRequestTracking();
});

afterEach(() => {
  stop();
  removeAllChatEventListeners();
});

describe('a request whose turn fails after it was accepted (#3237)', () => {
  it('start_work gives a request id, and the chat gets that request\'s failure', async () => {
    const text = await startWork('Tag 1.0 on main.');
    const id = idIn(text);
    expect(id).toMatch(/^req_/);
    expect(text).toContain('whether it worked, failed or was stopped');
    expect(requestsUnderWay()).toBe(1);

    publish('coordinator', 'turn_started', { trigger: 'prompt' });
    publish('coordinator', 'error', { code: 'provider_error', message: 'Model overloaded', fatal: false } as ChatEventDataMap['error']);
    publish('coordinator', 'turn_ended', { stopReason: 'error' });
    await settle();

    expect(getRequest(id)?.status).toBe('failed');
    expect(requestsUnderWay()).toBe(0);
    expect(h.toChat).toEqual([{ id: 'chat', text: requestEndedMessage({ id }, 'failed', 'Model overloaded').text }]);
    expect(h.toChat[0].text).toContain(`Request ${id} stopped with an error: Model overloaded`);
    expect(h.toChat[0].text).toContain(`start_work with request_id ${id}`);
  });

  it('a retry reuses the failed request\'s id', async () => {
    const id = idIn(await startWork('Tag 1.0 on main.'));
    publish('coordinator', 'turn_started', { trigger: 'prompt' });
    publish('coordinator', 'turn_ended', { stopReason: 'error' });
    await settle();
    const retry = await startWork('Tag 1.0 on main.', { request_id: id });
    expect(retry).toBe(`Request ${id} is under way again. Its outcome will come back here as a message from Clubhouse, whether it worked, failed or was stopped.`);
    expect(getRequest(id)?.status).toBe('under_way');
  });

  it('a second start_work for the same request while it is under way isn\'t handed off again', async () => {
    const id = idIn(await startWork('Tag 1.0 on main.'));
    expect(await startWork('tag 1.0 on main')).toContain(`Request ${id} is already under way, so it wasn't handed off twice.`);
  });

  it('a stopped turn tells the chat it was stopped', async () => {
    const id = idIn(await startWork('Tag 1.0 on main.'));
    publish('coordinator', 'turn_started', { trigger: 'prompt' });
    publish('coordinator', 'turn_ended', { stopReason: 'cancelled' });
    await settle();
    expect(h.toChat[0].text).toContain(`Request ${id} was stopped before it finished.`);
  });

  it('pays no attention to other agents\' turns', async () => {
    const id = idIn(await startWork('Tag 1.0 on main.'));
    publish('chat', 'turn_started', { trigger: 'prompt' });
    publish('chat', 'turn_ended', { stopReason: 'error' });
    publish('webapp-lead', 'turn_started', { trigger: 'prompt' });
    publish('webapp-lead', 'turn_ended', { stopReason: 'error' });
    await settle();
    expect(getRequest(id)?.status).toBe('under_way');
    expect(h.toChat).toEqual([]);
  });

  it('refuses a request_id that isn\'t one', async () => {
    const result = await h.handlers.get('start_work')!('chat', { request: 'x', request_id: 'r'.repeat(101) }) as { isError?: boolean };
    expect(result.isError).toBe(true);
  });
});

describe('tell_user (#3204)', () => {
  it('passes the request id on with the report, for the group chat to key it', async () => {
    const delivery = vi.fn(() => ({ hold: 'later' as const, reason: 'held' }));
    setChatDelivery(delivery);
    await h.handlers.get('tell_user')!('coordinator', { message: 'Tagged 1.0.', kind: 'answer', request_id: 'req_1' });
    expect(delivery).toHaveBeenCalledWith({ message: 'Tagged 1.0.', kind: 'answer', request: 'req_1' });
  });
});

describe('what the chat is told', () => {
  it('names no second agent, and asks for a short reply in the user\'s terms', () => {
    for (const ending of ['failed', 'cancelled', 'timed_out'] as const) {
      const { text, routed } = requestEndedMessage({ id: 'req_1' }, ending);
      expect(text.startsWith('[FROM:Clubhouse] Request req_1')).toBe(true);
      expect(text).toContain('Tell the user in a few words');
      expect(text).not.toMatch(/coordinator|session/i);
      expect(routed).toEqual([{ fromClubhouse: true, text: expect.any(String) }]);
    }
  });
});
