import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DurableAgentConfig } from '../../../shared/types';

const h = vi.hoisted(() => ({
  enabled: true,
  running: new Set<string>(),
  stopping: new Set<string>(),
  configs: new Map<string, DurableAgentConfig>(),
  delivered: [] as Array<{ id: string; text: string; routed: unknown }>,
  delivery: 'delivered' as 'delivered' | 'not_running' | 'stopping',
}));

vi.mock('../log-service', () => ({ appLog: vi.fn() }));
vi.mock('../../util/ipc-broadcast', () => ({ broadcastToAllWindows: vi.fn() }));
vi.mock('./dispatcher-settings', () => ({ isDispatcherEnabled: () => h.enabled }));
vi.mock('./dispatcher-paths', () => ({ getDispatcherPath: () => '/base/dispatcher', getDispatcherChatPath: () => '/base/dispatcher-chat' }));
vi.mock('../clubhouse-mcp/tools/dispatcher-delivery', () => ({
  // The Dispatcher's inbox is its own agent, whatever id a caller names.
  dispatcherInboxId: () => 'coordinator',
  deliverToDispatcher: vi.fn(async (): Promise<unknown> => ({ delivered: true, woke: false })),
}));
vi.mock('./dispatcher-service', () => ({
  DISPATCHER_NAME: 'Dispatcher',
  getDispatcherAgentId: () => 'coordinator',
  getDispatcherChatAgentId: () => 'chat',
  isDispatcherAgentId: (id: string) => id === 'coordinator',
  isDispatcherChatAgentId: (id: string) => id === 'chat',
}));
vi.mock('../agent-config', () => ({
  getDurableConfig: vi.fn(async (_dir: string, id: string) => h.configs.get(id) ?? null),
}));
vi.mock('../agent-system', () => ({
  isAgentRunning: (id: string) => h.running.has(id),
  isAgentStopping: (id: string) => h.stopping.has(id),
  waitForAgentStopped: vi.fn(async (id: string) => { h.stopping.delete(id); h.running.delete(id); return true; }),
  spawnAgent: vi.fn(async (params: { agentId: string }) => { h.running.add(params.agentId); }),
}));
vi.mock('../clubhouse-mcp/tools/helper-delivery', () => ({
  deliverNow: vi.fn(async (id: string, text: string, routed: unknown) => {
    if (h.delivery === 'delivered') h.delivered.push({ id, text, routed });
    return h.delivery;
  }),
}));

import * as agentSystem from '../agent-system';
import { deliverToDispatcher } from '../clubhouse-mcp/tools/dispatcher-delivery';
import { broadcastToAllWindows } from '../../util/ipc-broadcast';
import {
  CHAT_UPDATE_TAG, HAND_OFF_TAG, _resetDispatcherChannelForTesting, deliverToChat, handOffToDispatcher, onHandOff, setChatDelivery,
} from './dispatcher-channel';

beforeEach(() => {
  h.enabled = true;
  h.running.clear();
  h.stopping.clear();
  h.delivered = [];
  h.delivery = 'delivered';
  h.configs = new Map([
    ['coordinator', { id: 'coordinator', name: 'Dispatcher', color: 'indigo', createdAt: 'then', orchestrator: 'codex-cli', lastSessionId: 'sess-1', freeAgentMode: true }],
    ['chat', { id: 'chat', name: 'Dispatcher', color: 'indigo', createdAt: 'now', orchestrator: 'codex-cli' }],
  ]);
  _resetDispatcherChannelForTesting();
  vi.mocked(agentSystem.spawnAgent).mockClear();
  vi.mocked(broadcastToAllWindows).mockClear();
  vi.mocked(deliverToDispatcher).mockClear();
});

describe('handing work from the chat to the Dispatcher (#3036)', () => {
  it('goes to the Dispatcher\'s inbox through the one delivery path (#3037), as agent text, never the user\'s approval', async () => {
    expect(await handOffToDispatcher('chat', 'wake release-lead and tag 1.0')).toEqual({ outcome: 'delivered' });
    expect(deliverToDispatcher).toHaveBeenCalledTimes(1);
    const [req] = vi.mocked(deliverToDispatcher).mock.calls[0] as unknown as [Record<string, unknown>];
    expect(req).toMatchObject({ senderId: 'chat', targetId: 'coordinator', targetName: 'Dispatcher', submit: true, toolName: 'start_work', args: { request: 'wake release-lead and tag 1.0' } });
    expect(String(req.text).startsWith(HAND_OFF_TAG)).toBe(true);
    expect(req.text).toContain('not their approval');
    expect(req.text).toContain('wake release-lead and tag 1.0');
    // Nothing here starts an agent itself.
    expect(agentSystem.spawnAgent).not.toHaveBeenCalled();
  });

  it('says it started the Dispatcher when the delivery woke it', async () => {
    vi.mocked(deliverToDispatcher).mockResolvedValueOnce({ delivered: true, woke: true });
    expect(await handOffToDispatcher('chat', 'what is everyone doing?')).toEqual({ outcome: 'started' });
  });

  it('passes on why it wasn\'t delivered, such as a wake that asks first', async () => {
    vi.mocked(deliverToDispatcher).mockResolvedValueOnce({ delivered: false, text: 'Dispatcher is asleep, so the message was not delivered. Asked the user.' });
    expect(await handOffToDispatcher('chat', 'x')).toEqual({ outcome: 'undelivered', error: 'Dispatcher is asleep, so the message was not delivered. Asked the user.' });
  });

  it('tells listeners of each hand-off that went through, and none that didn\'t', async () => {
    const heard = vi.fn();
    const stop = onHandOff(heard);
    await handOffToDispatcher('chat', 'tag 1.0');
    expect(heard).toHaveBeenCalledTimes(1);
    vi.mocked(deliverToDispatcher).mockResolvedValueOnce({ delivered: false, text: 'no' });
    await handOffToDispatcher('chat', 'x');
    await handOffToDispatcher('someone', 'x');
    expect(heard).toHaveBeenCalledTimes(1);
    stop();
    await handOffToDispatcher('chat', 'again');
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('refuses any caller but the chat, and does nothing while the Dispatcher is off', async () => {
    expect((await handOffToDispatcher('coordinator', 'x')).outcome).toBe('refused');
    expect((await handOffToDispatcher('someone', 'x')).outcome).toBe('refused');
    h.enabled = false;
    expect((await handOffToDispatcher('chat', 'x')).outcome).toBe('off');
    expect(deliverToDispatcher).not.toHaveBeenCalled();
  });
});

describe('telling the user, through the chat (#3036)', () => {
  it('reaches a running chat as a Clubhouse notice that names no one', async () => {
    h.running.add('chat');
    expect(await deliverToChat('coordinator', 'Checkout is fixed in #412.')).toEqual({ outcome: 'delivered' });
    const [sent] = h.delivered;
    expect(sent.id).toBe('chat');
    expect(sent.text.startsWith(CHAT_UPDATE_TAG)).toBe(true);
    expect(sent.routed).toEqual([{ fromClubhouse: true, text: 'Checkout is fixed in #412.' }]);
  });

  it('starts a sleeping chat with it, and the window is told the chat is waking', async () => {
    expect((await deliverToChat('coordinator', 'news')).outcome).toBe('started');
    expect(agentSystem.spawnAgent).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'chat', projectPath: '/base/dispatcher-chat', resume: false }));
    expect(broadcastToAllWindows).toHaveBeenCalledWith(expect.anything(), 'chat');
  });

  it('waits for a chat that is stopping, then starts it again', async () => {
    h.running.add('chat');
    h.stopping.add('chat');
    expect((await deliverToChat('coordinator', 'x')).outcome).toBe('started');
    expect(agentSystem.waitForAgentStopped).toHaveBeenCalledWith('chat');
  });

  it('starts the chat once for two updates that arrive together', async () => {
    const [a, b] = await Promise.all([deliverToChat('coordinator', 'one'), deliverToChat('coordinator', 'two')]);
    expect(agentSystem.spawnAgent).toHaveBeenCalledTimes(1);
    expect([a.outcome, b.outcome].sort()).toEqual(['delivered', 'started']);
  });

  it('says so when the chat is shutting down', async () => {
    h.running.add('chat');
    h.delivery = 'stopping';
    expect((await deliverToChat('coordinator', 'x')).outcome).toBe('stopping');
  });

  it('goes through the delivery step, which can rewrite it or hold it back (#3043)', async () => {
    h.running.add('chat');
    setChatDelivery(({ message }) => (message.includes('routine') ? null : { text: `short: ${message}`, routed: [{ fromClubhouse: true, text: 'short' }] }));
    expect(await deliverToChat('coordinator', 'routine progress')).toEqual({ outcome: 'delivered', held: 'never' });
    expect(h.delivered).toEqual([]);
    await deliverToChat('coordinator', 'needs you');
    expect(h.delivered[0].text).toBe('short: needs you');
    setChatDelivery(null);
    await deliverToChat('coordinator', 'back to default');
    expect(h.delivered[1].text.startsWith(CHAT_UPDATE_TAG)).toBe(true);
  });

  it('passes the agent and kind on to the delivery step, and says why a report was held', async () => {
    h.running.add('chat');
    const seen: unknown[] = [];
    setChatDelivery((report) => { seen.push(report); return { hold: 'later', reason: 'Held for the next check-in summary.' }; });
    expect(await deliverToChat('coordinator', { message: 'Lint is green.', from: 'webapp-lead', kind: 'routine' }))
      .toEqual({ outcome: 'delivered', held: 'later', reason: 'Held for the next check-in summary.' });
    expect(seen).toEqual([{ message: 'Lint is green.', from: 'webapp-lead', kind: 'routine' }]);
    expect(h.delivered).toEqual([]);
  });

  it('refuses any caller but the Dispatcher, and does nothing while it is off', async () => {
    expect((await deliverToChat('chat', 'x')).outcome).toBe('refused');
    h.enabled = false;
    expect((await deliverToChat('coordinator', 'x')).outcome).toBe('off');
    expect(agentSystem.spawnAgent).not.toHaveBeenCalled();
  });
});
