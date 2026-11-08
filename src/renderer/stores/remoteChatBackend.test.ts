import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readRemoteTranscript, remoteChat, remoteChatTarget } from './remoteChatBackend';
import { useChatStore, initChatEventListener } from './chatStore';

const SAT = Array.from({ length: 16 }, () => 'ab').join(':');
const NS = `remote||${SAT}||durable_chat`;

const ev = (seq: number, type: string, data: Record<string, unknown> = {}) =>
  ({ v: 2, agentId: 'durable_chat', sessionId: 'sess_live', seq, ts: 1000 + seq, type, data }) as never;

describe('chat for an agent on another desktop (#2390)', () => {
  const chatPage = vi.fn();
  const chatCommand = vi.fn();
  const local = { sendMessage: vi.fn(), readTranscript: vi.fn(), interrupt: vi.fn(), respondPermission: vi.fn(), answerQuestion: vi.fn(), setLevel: vi.fn(), setModel: vi.fn(), removeQueued: vi.fn(), getAgentRuntime: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(window.clubhouse.annexClient, { chatPage, chatCommand });
    Object.assign(window.clubhouse.chat, local);
    chatPage.mockResolvedValue({ events: [ev(1, 'session_started', { resumed: false }), ev(2, 'turn_started', { trigger: 'prompt' })], pendingPermissions: [], pendingQuestions: [], state: 'idle' });
    chatCommand.mockResolvedValue({ status: 'completed', result: { delivery: 'prompt', messageId: 'msg_1' } });
    useChatStore.setState({ agents: {}, loading: {}, partial: {}, loaded: {}, live: {} } as never);
  });

  it('knows a namespaced id is on another desktop, and a local one is not', () => {
    expect(remoteChatTarget(NS)).toEqual({ satelliteId: SAT, agentId: 'durable_chat' });
    expect(remoteChatTarget('durable_chat')).toBeNull();
  });

  it('reads the transcript from that desktop, keyed by the namespaced id, pending prompts folded in once', async () => {
    const pending = ev(3, 'permission_request', { requestId: 'p1' });
    chatPage.mockResolvedValueOnce({ events: [ev(1, 'session_started'), pending], pendingPermissions: [pending], pendingQuestions: [], state: 'waiting_permission' });
    const read = await readRemoteTranscript(NS, 50);
    expect(chatPage).toHaveBeenCalledWith(SAT, 'durable_chat', { limit: 50 });
    expect(read.events.map((e) => [e.agentId, e.seq])).toEqual([[NS, 1], [NS, 3]]);
    expect(read.live).toBe(true);
  });

  it('sends commands to that desktop with the session, and throws a refusal\'s message', async () => {
    await expect(remoteChat.send(NS, 'sess_live', 'hi', 'auto')).resolves.toEqual({ delivery: 'prompt', messageId: 'msg_1' });
    expect(chatCommand).toHaveBeenCalledWith(SAT, { type: 'chat.send', agentId: 'durable_chat', sessionId: 'sess_live', text: 'hi', delivery: 'auto' });
    chatCommand.mockResolvedValueOnce({ status: 'rejected', error: { code: 'session_mismatch', message: 'That session ended.' } });
    await expect(remoteChat.interrupt(NS, 'sess_live')).rejects.toThrow('That session ended.');
    await expect(remoteChat.send(NS, null, 'hi')).rejects.toThrow(/not loaded yet/);
  });

  it('the store routes an agent on another desktop through it, never this machine\'s chat runtime', async () => {
    const store = useChatStore.getState();
    await store.loadTranscript(NS);
    expect(chatPage).toHaveBeenCalled();
    expect(useChatStore.getState().agents[NS]?.sessionId).toBe('sess_live');
    await store.send(NS, 'hello');
    await store.interrupt(NS);
    await store.setLevel(NS, 'plan' as never);
    await store.setModel(NS, 'opus', 'high');
    await store.respondPermission(NS, 'p1', 'allow');
    await store.answerQuestion(NS, 'q1', { which: ['main'] } as never);
    expect(chatCommand.mock.calls.map((c) => (c[1] as { type: string }).type)).toEqual([
      'chat.send', 'chat.interrupt', 'chat.setLevel', 'chat.setModel', 'chat.permission', 'chat.question',
    ]);
    for (const fn of Object.values(local)) expect(fn).not.toHaveBeenCalled();
  });

  it('applies a connected desktop\'s chat:event under the namespaced id', async () => {
    let fire: ((e: { satelliteId: string; type: string; payload: unknown }) => void) | null = null;
    Object.assign(window.clubhouse.annexClient, {
      onSatelliteEvent: (cb: typeof fire) => { fire = cb; return () => { fire = null; }; },
    });
    const { initAnnexClientListener } = await import('./annexClientStore');
    const offAnnex = initAnnexClientListener();
    const offChat = initChatEventListener();
    fire!({ satelliteId: SAT, type: 'chat:event', payload: { agentId: 'durable_chat', event: ev(1, 'session_started', { resumed: false }) } });
    expect(useChatStore.getState().agents[NS]?.sessionId).toBe('sess_live');
    expect(useChatStore.getState().agents.durable_chat).toBeUndefined();
    offChat();
    offAnnex();
  });
});
