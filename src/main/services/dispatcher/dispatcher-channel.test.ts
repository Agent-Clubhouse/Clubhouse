import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { DurableAgentConfig } from '../../../shared/types';

const h = vi.hoisted(() => ({
  enabled: true,
  running: new Set<string>(),
  stopping: new Set<string>(),
  configs: new Map<string, DurableAgentConfig>(),
  delivered: [] as Array<{ id: string; text: string; routed: unknown }>,
  delivery: 'delivered' as 'delivered' | 'not_running' | 'stopping',
  base: '',
  name: 'Dispatcher',
}));

vi.mock('../base-dir', () => ({ getBaseDirPath: () => h.base }));
vi.mock('../log-service', () => ({ appLog: vi.fn() }));
vi.mock('../../util/ipc-broadcast', () => ({ broadcastToAllWindows: vi.fn() }));
vi.mock('./dispatcher-settings', () => ({ isDispatcherEnabled: () => h.enabled }));
vi.mock('./dispatcher-paths', () => ({ getDispatcherPath: () => '/base/dispatcher', getDispatcherChatPath: () => '/base/dispatcher-chat' }));
vi.mock('../clubhouse-mcp/tools/dispatcher-delivery', () => ({
  // The Dispatcher's inbox is its own agent, whatever id a caller names.
  dispatcherInboxId: () => 'coordinator',
  deliverToDispatcher: vi.fn(async (): Promise<unknown> => ({ delivered: true, woke: false })),
}));
vi.mock('./dispatcher-service', async () => ({
  dispatcherDisplayName: (role: 'chat' | 'work' = 'chat') => dispatcherRoleDisplayName(role, h.name),
  getDispatcherAgentId: () => 'coordinator',
  getDispatcherChatAgentId: () => 'chat',
  isDispatcherAgentId: (id: string) => id === 'coordinator',
  isDispatcherChatAgentId: (id: string) => id === 'chat',
}));
import { dispatcherRoleDisplayName } from '../../../shared/dispatcher-name';
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
import { IPC } from '../../../shared/ipc-channels';
import {
  CHAT_UPDATE_TAG, HAND_OFF_TAG, _resetDispatcherChannelForTesting, deliverToChat, deliverUpdateToChat, handOffToDispatcher, setChatDelivery,
} from './dispatcher-channel';
import { _resetDispatcherRequestsForTesting, getRequest, getRequests, getRequestsPath, noteRequestDone } from './dispatcher-requests';

h.base = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatcher-channel-test-'));
afterAll(() => fs.rmSync(h.base, { recursive: true, force: true }));

beforeEach(async () => {
  await _resetDispatcherRequestsForTesting();
  fs.rmSync(getRequestsPath(), { force: true });
  h.enabled = true;
  h.name = 'Dispatcher';
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
    const result = await handOffToDispatcher('chat', 'wake release-lead and tag 1.0');
    expect(result).toEqual({ outcome: 'delivered', requestId: expect.stringMatching(/^req_/) });
    expect(deliverToDispatcher).toHaveBeenCalledTimes(1);
    const [req] = vi.mocked(deliverToDispatcher).mock.calls[0] as unknown as [Record<string, unknown>];
    expect(req).toMatchObject({ senderId: 'chat', targetId: 'coordinator', targetName: 'Dispatcher', submit: true, toolName: 'start_work', args: { request: 'wake release-lead and tag 1.0' } });
    expect(String(req.text).startsWith(`${HAND_OFF_TAG} Request ${result.requestId}.`)).toBe(true);
    // The Dispatcher reports the outcome under the same id (#3237).
    expect(req.text).toContain(`tell_user and request_id ${result.requestId}`);
    expect(req.taskId).toBe(result.requestId);
    expect(getRequest(result.requestId!)).toMatchObject({ status: 'under_way', text: 'wake release-lead and tag 1.0' });
    expect(req.text).toContain('not their approval');
    expect(req.text).toContain('wake release-lead and tag 1.0');
    // Nothing here starts an agent itself.
    expect(agentSystem.spawnAgent).not.toHaveBeenCalled();
  });

  it('says it started the Dispatcher when the delivery woke it', async () => {
    vi.mocked(deliverToDispatcher).mockResolvedValueOnce({ delivered: true, woke: true });
    expect(await handOffToDispatcher('chat', 'what is everyone doing?')).toMatchObject({ outcome: 'started', requestId: expect.any(String) });
  });

  it('passes on why it wasn\'t delivered, such as a wake that asks first', async () => {
    vi.mocked(deliverToDispatcher).mockResolvedValueOnce({ delivered: false, text: 'Dispatcher is asleep, so the message was not delivered. Asked the user.' });
    expect(await handOffToDispatcher('chat', 'x')).toEqual({ outcome: 'undelivered', error: 'Dispatcher is asleep, so the message was not delivered. Asked the user.' });
    // A request that never went isn't one.
    expect(getRequests()).toEqual([]);
  });

  it('forgets a request whose delivery threw', async () => {
    vi.mocked(deliverToDispatcher).mockRejectedValueOnce(new Error('runtime gone'));
    await expect(handOffToDispatcher('chat', 'tag 1.0')).rejects.toThrow('runtime gone');
    expect(getRequests()).toEqual([]);
  });

  it('refuses any caller but the chat, and does nothing while the Dispatcher is off', async () => {
    expect((await handOffToDispatcher('coordinator', 'x')).outcome).toBe('refused');
    expect((await handOffToDispatcher('someone', 'x')).outcome).toBe('refused');
    h.enabled = false;
    expect((await handOffToDispatcher('chat', 'x')).outcome).toBe('off');
    expect(deliverToDispatcher).not.toHaveBeenCalled();
  });
});

describe('retrying a request (#3237)', () => {
  it('doesn\'t hand off the same request twice while it is under way', async () => {
    const first = await handOffToDispatcher('chat', 'Tag 1.0 on main.');
    const again = await handOffToDispatcher('chat', 'tag 1.0 on main');
    expect(again).toEqual({ outcome: 'delivered', requestId: first.requestId, reuse: 'already' });
    expect(deliverToDispatcher).toHaveBeenCalledTimes(1);
  });

  it('hands a request off again under its own id, as a follow-up or a retry', async () => {
    const first = await handOffToDispatcher('chat', 'tag 1.0');
    const again = await handOffToDispatcher('chat', 'Tag from main.', first.requestId);
    expect(again).toEqual({ outcome: 'delivered', requestId: first.requestId, reuse: 'again' });
    const [req] = vi.mocked(deliverToDispatcher).mock.calls[1] as unknown as [Record<string, unknown>];
    expect(req.text).toContain(`Request ${first.requestId}, handed off again`);
    expect(req.args).toEqual({ request: 'Tag from main.', request_id: first.requestId });
    expect(getRequests()).toHaveLength(1);
  });

  it('lists the steps already done when a request is handed off again, so they aren\'t repeated (#3241)', async () => {
    const first = await handOffToDispatcher('chat', 'clone acme/web and add it');
    noteRequestDone(first.requestId!, ['Cloned acme/web into ~/src/web'], Date.now());
    await handOffToDispatcher('chat', 'Try again.', first.requestId);
    const [firstReq] = vi.mocked(deliverToDispatcher).mock.calls[0] as unknown as [Record<string, unknown>];
    const [againReq] = vi.mocked(deliverToDispatcher).mock.calls[1] as unknown as [Record<string, unknown>];
    expect(firstReq.text).not.toContain('Already done');
    expect(againReq.text).toContain('Already done for this request, so don\'t repeat it:\n- Cloned acme/web into ~/src/web');
  });

  it('refuses an id that names no request', async () => {
    expect(await handOffToDispatcher('chat', 'tag 1.0', 'req_nope')).toEqual({
      outcome: 'undelivered', error: 'There is no request req_nope. Leave out request_id to start a new one.',
    });
    expect(deliverToDispatcher).not.toHaveBeenCalled();
  });
});

describe('Clubhouse\'s own updates to the chat (#3237)', () => {
  it('reach the chat untriaged, waking it when it sleeps', async () => {
    const triage = vi.fn(() => null);
    setChatDelivery(triage);
    expect((await deliverUpdateToChat({ text: `${CHAT_UPDATE_TAG} Request req_1 was stopped.`, routed: [] })).outcome).toBe('started');
    expect(triage).not.toHaveBeenCalled();
    expect(agentSystem.spawnAgent).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'chat', mission: `${CHAT_UPDATE_TAG} Request req_1 was stopped.` }));
  });

  it('go nowhere while the Dispatcher is off', async () => {
    h.enabled = false;
    expect((await deliverUpdateToChat({ text: 'x', routed: [] })).outcome).toBe('off');
  });
});

describe('telling the user, through the chat (#3036)', () => {
  it('passes the group chat\'s note back to the Dispatcher, such as who the news was credited to (#3241)', async () => {
    h.running.add('chat');
    setChatDelivery(() => ({ text: 'x', routed: [], note: 'Shown as webapp-lead\'s news.' }));
    expect(await deliverToChat('coordinator', 'Cloned it.')).toEqual({ outcome: 'delivered', note: 'Shown as webapp-lead\'s news.' });
  });

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

  it.each(['Dispatcher', 'Rosie'])('names the controller when a report cannot reach chat named %s, but still opens that chat (#3193)', async (name) => {
    h.name = name;
    h.running.add('chat');
    h.delivery = 'stopping';
    const notDelivered = vi.fn();
    setChatDelivery(() => ({ text: 'ask it', routed: [{ fromClubhouse: true, text: 'Should deletion be on by default?' }], notDelivered }));
    expect((await deliverToChat('coordinator', { message: 'x', from: 'api-lead', kind: 'needs_user' })).outcome).toBe('stopping');
    expect(notDelivered).toHaveBeenCalledTimes(1);
    expect(broadcastToAllWindows).toHaveBeenCalledWith(IPC.APP.AGENT_ATTENTION, 'chat', { title: 'Dispatcher controller needs you', message: 'Should deletion be on by default?' });

    // An answer that didn't arrive is forgotten as shown too, but isn't worth a notification.
    vi.mocked(broadcastToAllWindows).mockClear();
    expect((await deliverToChat('coordinator', { message: 'x', kind: 'answer' })).outcome).toBe('stopping');
    expect(notDelivered).toHaveBeenCalledTimes(2);
    expect(broadcastToAllWindows).not.toHaveBeenCalled();
  });

  it('tells the delivery step when starting the chat throws, and passes the error on', async () => {
    vi.mocked(agentSystem.spawnAgent).mockRejectedValueOnce(new Error('no CLI'));
    const notDelivered = vi.fn();
    setChatDelivery(() => ({ text: 'ask it', routed: [{ fromClubhouse: true, text: 'Which branch?' }], notDelivered }));
    await expect(deliverToChat('coordinator', { message: 'Which branch?' })).rejects.toThrow('no CLI');
    expect(notDelivered).toHaveBeenCalledTimes(1);
  });

  it('leaves a delivered report alone', async () => {
    h.running.add('chat');
    const notDelivered = vi.fn();
    setChatDelivery(() => ({ text: 'ask it', routed: [{ fromClubhouse: true, text: 'Which branch?' }], notDelivered }));
    expect((await deliverToChat('coordinator', { message: 'Which branch?' })).outcome).toBe('delivered');
    expect(notDelivered).not.toHaveBeenCalled();
  });

  it('refuses any caller but the Dispatcher, and does nothing while it is off', async () => {
    expect((await deliverToChat('chat', 'x')).outcome).toBe('refused');
    h.enabled = false;
    expect((await deliverToChat('coordinator', 'x')).outcome).toBe('off');
    expect(agentSystem.spawnAgent).not.toHaveBeenCalled();
  });
});
