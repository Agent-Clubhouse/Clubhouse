/**
 * Group project post notices (#3362): subscription, coalescing, the rate
 * limit, sleeping and busy members, and legacy polling.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BulletinMessage, GroupProject, GroupProjectChange, GroupProjectMembership } from '../../shared/group-project-types';

const fx = vi.hoisted(() => ({
  gp: null as unknown as GroupProject,
  membership: { version: 1, autoJoin: true, explicit: [], excluded: [] } as GroupProjectMembership,
  members: [] as Array<{ address: string; name: string }>,
  messages: [] as BulletinMessage[],
  changeListeners: new Set<(c: GroupProjectChange) => void>(),
  connected: new Set<(agentId: string) => void>(),
  alive: new Set<string>(),
  runtimes: new Map<string, { kind: 'chat' | 'pty'; state: string; sendMessage: ReturnType<typeof vi.fn>; isRunning: () => boolean; getState: () => string }>(),
  telCount: vi.fn(),
}));

vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('../telemetry/facade', () => ({ tel: { count: fx.telCount } }));
vi.mock('./group-project-host', () => ({
  groupProjectHost: {
    onChange: (fn: (c: GroupProjectChange) => void) => { fx.changeListeners.add(fn); return () => fx.changeListeners.delete(fn); },
    get: async () => fx.gp,
    resolveMembers: async () => fx.members,
    getMembership: async () => structuredClone(fx.membership),
    inboxFor: async (_id: string, name: string) => `inbox-${name}`,
    updateMembership: async (_id: string, fn: (d: GroupProjectMembership) => GroupProjectMembership | void) => {
      const draft = structuredClone(fx.membership);
      fx.membership = fn(draft) || draft;
      return { membership: structuredClone(fx.membership), seq: 1 };
    },
  },
}));
vi.mock('./group-project-bulletin', () => ({
  getBulletinBoard: () => ({ getAllMessages: async () => fx.messages }),
}));
vi.mock('./group-project-lifecycle', () => ({ isAgentAlive: (id: string) => fx.alive.has(id) }));
vi.mock('./agent-runtime', () => ({ getAgentRuntime: (id: string) => fx.runtimes.get(id) }));
vi.mock('./clubhouse-mcp/tool-registry', () => ({ buildToolName: (_b: unknown, suffix: string) => `group__release__${suffix}` }));
vi.mock('./clubhouse-mcp/connection-events', () => ({
  onAgentMcpConnected: (fn: (agentId: string) => void) => { fx.connected.add(fn); return () => fx.connected.delete(fn); },
}));

import { bindingManager } from './clubhouse-mcp/binding-manager';
import {
  COALESCE_MS, RATE_LIMIT_MAX, WAKE_SUMMARY_DELAY_MS, _resetDeliveryForTesting, listTopicSubscriptions, mentions,
  setTopicSubscription, watchGroupProjectDelivery,
} from './group-project-delivery';

let seq = 0;

/** Post as the host does: the message carries the change's sequence number. */
async function post(sender: string, topic: string, body = 'hello'): Promise<void> {
  seq++;
  fx.messages.push({ id: `m${seq}`, sender, topic, body, timestamp: new Date().toISOString(), seq });
  for (const fn of fx.changeListeners) fn({ groupProjectId: 'gp1', seq, part: 'board' });
  await vi.advanceTimersByTimeAsync(0);
}

function runtime(agentId: string, kind: 'chat' | 'pty' = 'chat', state = 'idle') {
  const r = {
    kind, state,
    sendMessage: vi.fn(async () => ({ delivery: 'prompt' as const })),
    isRunning: () => true,
    getState: () => r.state,
  };
  fx.runtimes.set(agentId, r);
  fx.alive.add(agentId);
  return r;
}

const sentTexts = (r: { sendMessage: ReturnType<typeof vi.fn> }) => r.sendMessage.mock.calls.map((c) => c[0] as string);
const counted = (result: string) => fx.telCount.mock.calls
  .filter((c) => c[0] === 'clubhouse.group.notices' && JSON.stringify(c[2]).includes(`"${result}"`))
  .reduce((n, c) => n + (c[1] as number), 0);

beforeEach(() => {
  vi.useFakeTimers();
  seq = 0;
  fx.gp = { id: 'gp1', name: 'Release', description: '', instructions: '', createdAt: '', metadata: {} };
  fx.membership = { version: 1, autoJoin: true, explicit: [], excluded: [] };
  fx.members = [{ address: 'lead', name: 'lead' }, { address: 'dev', name: 'dev' }, { address: 'qa', name: 'qa' }];
  fx.messages = [];
  fx.alive.clear();
  fx.runtimes.clear();
  fx.telCount.mockClear();
  watchGroupProjectDelivery();
});

afterEach(() => {
  _resetDeliveryForTesting();
  bindingManager._resetForTesting();
  vi.useRealTimers();
});

describe('who hears about a post', () => {
  it('a burst to a subscribed topic becomes one notice per member, never to the sender', async () => {
    const lead = runtime('lead');
    const dev = runtime('dev');
    await post('lead@Release', 'general', 'one');
    await post('qa@Release', 'general', 'two');
    await post('lead@Release', 'general', 'three');
    expect(dev.sendMessage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(COALESCE_MS);
    expect(sentTexts(dev)).toEqual([expect.stringContaining('3 new messages in #general from lead, qa.')]);
    // lead sent two of them, but hears about qa's.
    expect(sentTexts(lead)).toEqual([expect.stringContaining('1 new message in #general from qa.')]);
    expect(counted('sent')).toBe(2);
    // dev's three became one (2); qa, asleep, has lead's two held as one (1).
    expect(counted('coalesced')).toBe(3);
  });

  it('a work channel reaches only its subscribers, members named in the post, and the lead', async () => {
    fx.gp.metadata = { admins: ['lead'] };
    const lead = runtime('lead');
    const dev = runtime('dev');
    const qa = runtime('qa');
    await setTopicSubscription('gp1', 'qa', 'qa', 'release-qa', true);
    await post('user', 'release-qa', 'ping @dev please');
    await vi.advanceTimersByTimeAsync(COALESCE_MS);
    expect(sentTexts(qa)).toEqual([expect.stringContaining('#release-qa from the user')]);
    expect(sentTexts(dev)[0]).toContain('You were mentioned.');
    expect(sentTexts(lead)).toHaveLength(1);
  });

  it('an unsubscribed default topic is quiet for that member', async () => {
    const dev = runtime('dev');
    expect(await setTopicSubscription('gp1', 'dev', 'dev', 'general', false)).toEqual(['control', 'inbox-dev']);
    await post('qa@Release', 'general');
    await vi.advanceTimersByTimeAsync(COALESCE_MS);
    expect(dev.sendMessage).not.toHaveBeenCalled();
    expect(await listTopicSubscriptions('gp1', 'dev', 'dev')).toEqual(['control', 'inbox-dev']);
  });

  it('a group project with polling on behaves as today: no notices', async () => {
    fx.gp.metadata = { pollingEnabled: true };
    const dev = runtime('dev');
    await post('qa@Release', 'general');
    await vi.advanceTimersByTimeAsync(COALESCE_MS);
    expect(dev.sendMessage).not.toHaveBeenCalled();
  });

  it('system posts notify no one', async () => {
    const dev = runtime('dev');
    await post('system', 'system', 'dev joined');
    await vi.advanceTimersByTimeAsync(COALESCE_MS);
    expect(dev.sendMessage).not.toHaveBeenCalled();
  });

  it('matches @mentions on word boundaries', () => {
    expect(mentions('thanks @dev!', 'dev')).toBe(true);
    expect(mentions('@DEV look', 'dev')).toBe(true);
    expect(mentions('@devops look', 'dev')).toBe(false);
    expect(mentions('mail dev@example.com', 'dev')).toBe(false);
  });
});

describe('sleeping and busy members', () => {
  it('a sleeping member is not woken; it gets one summary when it connects', async () => {
    await post('lead@Release', 'general');
    await vi.advanceTimersByTimeAsync(COALESCE_MS);
    await post('qa@Release', 'control');
    await vi.advanceTimersByTimeAsync(COALESCE_MS);
    // dev twice; qa and lead once each for the other's post.
    expect(counted('held_asleep')).toBe(4);

    const dev = runtime('dev');
    for (const fn of fx.connected) fn('dev');
    expect(dev.sendMessage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(WAKE_SUMMARY_DELAY_MS);
    expect(sentTexts(dev)).toEqual([expect.stringContaining('2 new messages in #general (1), #control (1) from lead, qa.')]);
  });

  it('a busy member gets one merged notice queued for the end of its turn', async () => {
    const dev = runtime('dev', 'chat', 'running');
    await post('lead@Release', 'general');
    await vi.advanceTimersByTimeAsync(COALESCE_MS);
    await post('qa@Release', 'general');
    await post('qa@Release', 'general');
    await vi.advanceTimersByTimeAsync(COALESCE_MS);

    expect(dev.sendMessage).toHaveBeenCalledTimes(2);
    for (const call of dev.sendMessage.mock.calls) {
      expect(call[1]).toMatchObject({ delivery: 'queued', actionQueue: { actionId: 'group-project:gp1', latestOnly: true } });
    }
    // The second replaces the first, covering both bursts.
    expect(sentTexts(dev)[1]).toContain('3 new messages in #general from lead, qa.');
    expect(counted('sent')).toBe(1);

    // Delivered at the turn's end: the next notice starts fresh.
    dev.sendMessage.mock.calls[1][1].actionQueue.onSettled('delivered');
    await post('qa@Release', 'general');
    await vi.advanceTimersByTimeAsync(COALESCE_MS);
    expect(sentTexts(dev)[2]).toContain('1 new message in #general from qa.');
  });

  it('a terminal agent gets its notice typed in', async () => {
    const dev = runtime('dev', 'pty');
    bindingManager.bind('dev', { targetId: 'gp1', targetKind: 'group-project', label: 'Release', agentName: 'dev' });
    await post('qa@Release', 'general');
    await vi.advanceTimersByTimeAsync(COALESCE_MS);
    expect(dev.sendMessage).toHaveBeenCalledWith(expect.stringContaining('group__release__read_topic'), expect.objectContaining({ source: 'group_project' }));
  });
});

describe('rate limit', () => {
  it('drops notices over the limit and says so in the next one', async () => {
    const dev = runtime('dev');
    for (let i = 0; i < RATE_LIMIT_MAX + 1; i++) {
      await post('qa@Release', 'general');
      await vi.advanceTimersByTimeAsync(COALESCE_MS);
    }
    expect(dev.sendMessage).toHaveBeenCalledTimes(RATE_LIMIT_MAX);
    expect(counted('rate_limited')).toBe(1);

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await post('qa@Release', 'general');
    await vi.advanceTimersByTimeAsync(COALESCE_MS);
    expect(sentTexts(dev).at(-1)).toContain('1 earlier message was not announced.');
  });
});
