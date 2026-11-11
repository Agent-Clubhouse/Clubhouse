import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const configListeners: Array<(projectPath: string) => void> = [];
const exitListeners: Array<(agentId: string, code: number) => void> = [];
let durables: Record<string, Array<Record<string, unknown>>> = {};

vi.mock('./agent-config', () => ({
  listDurable: vi.fn(async (p: string) => durables[p] ?? []),
  onAgentConfigChanged: vi.fn((l: (p: string) => void) => { configListeners.push(l); return () => undefined; }),
}));
vi.mock('./agent-exit-broadcast', () => ({
  onAgentExit: vi.fn((l: (id: string, code: number) => void) => { exitListeners.push(l); return () => undefined; }),
}));
vi.mock('./agent-runtime/chat-event-bus', () => ({ onChatEvent: vi.fn(() => () => undefined) }));
vi.mock('./project-store', () => ({ list: vi.fn(async () => [{ id: 'p1', path: '/p1' }]) }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));

import { finishHeadlessTurn, onAppEvent, publishAppEvent, publishFromHookEvent, resetAppEventBus, startHeadlessTurn, type AppEvent } from './app-event-bus';
import { knownAgent, knownAgents, startAppEventSources, stopAppEventSources } from './app-event-sources';
import { beginQuickAgentRun } from './quick-agent-events';

const flush = () => new Promise((r) => setTimeout(r, 0));

let events: AppEvent[];
beforeEach(() => {
  durables = { '/p1': [{ id: 'a1', name: 'lead' }, { id: 'h0', parentAgentId: 'a1', disposedAt: 'x' }] };
  events = [];
  configListeners.length = 0;
  exitListeners.length = 0;
});
afterEach(() => {
  stopAppEventSources();
  resetAppEventBus();
});

async function start() {
  await startAppEventSources();
  onAppEvent((e) => events.push(e));
}

describe('app event sources', () => {
  it('keeps headless dedup after exit and resets outcome for a replacement run', async () => {
    await start();
    const identity = { agentId: 'q1', name: 'Review', projectPath: '/p1' };
    beginQuickAgentRun(identity);
    const old = startHeadlessTurn('q1');
    beginQuickAgentRun(identity);
    finishHeadlessTurn(old, 'interrupted');
    const next = startHeadlessTurn('q1');
    finishHeadlessTurn(next, 'completed');
    exitListeners[0]('q1', 0);
    publishFromHookEvent('q1', { kind: 'stop', rawName: 'Stop' });
    expect(events.filter((event) => event.type === 'turn.ended')).toMatchObject([
      { outcome: 'interrupted' }, { outcome: 'completed' },
    ]);
    expect(events.filter((event) => event.type === 'agent.quick_finished')).toMatchObject([
      { outcome: 'cancelled' }, { outcome: 'completed' },
    ]);
  });
  it('knows quick agents during their turn and exactly-once finish, without treating them as durable helpers', async () => {
    await start();
    beginQuickAgentRun({ agentId: 'q1', name: 'Review', projectPath: '/p1', parentAgentId: 'a1' });
    expect(knownAgent('q1')).toMatchObject({ name: 'Review', projectPath: '/p1', parentAgentId: 'a1', quick: true });
    expect(knownAgents().has('q1')).toBe(true);
    const knownAtFinish: boolean[] = [];
    onAppEvent((event) => { if (event.type === 'agent.quick_finished') knownAtFinish.push(!!knownAgent(event.agentId)); });
    publishAppEvent({ type: 'turn.ended', agentId: 'q1', via: 'headless', outcome: 'failed' });
    exitListeners[0]('q1', 0);
    exitListeners[0]('q1', 0);
    expect(events.filter((event) => event.type === 'agent.quick_finished')).toMatchObject([
      { agentId: 'q1', name: 'Review', outcome: 'failed', parentAgentId: 'a1', owner: { kind: 'user' }, durationMs: expect.any(Number) },
    ]);
    expect(knownAtFinish).toEqual([true]);
    expect(events.filter((event) => event.type === 'helper.finished')).toHaveLength(0);
    expect(knownAgent('q1')).toBeDefined();
  });
  it('publishes nothing for the baseline, then created and deleted on changes', async () => {
    await start();
    expect(events).toEqual([]);
    durables['/p1'] = [
      { id: 'h1', parentAgentId: 'a1' },
      { id: 'c1', creation: { state: 'creating' } },
    ];
    configListeners[0]('/p1');
    await flush(); await flush();
    expect(events.map((e) => [e.type, 'agentId' in e && e.agentId])).toEqual([
      ['agent.created', 'h1'],
      ['agent.deleted', 'a1'],
    ]);
    expect(events[0]).toMatchObject({ parentAgentId: 'a1', projectPath: '/p1' });
  });

  it('treats a disposed helper as deleted', async () => {
    durables['/p1'] = [{ id: 'h1', parentAgentId: 'a1' }];
    await start();
    durables['/p1'] = [{ id: 'h1', parentAgentId: 'a1', disposedAt: '2026-11-08' }];
    configListeners[0]('/p1');
    await flush(); await flush();
    expect(events.map((e) => e.type)).toEqual(['agent.deleted']);
  });

  it('takes a baseline for a project added later, so its first agent is reported', async () => {
    await start();
    durables['/p2'] = [];
    publishAppEvent({ type: 'project.added', projectId: 'p2', projectPath: '/p2' });
    await flush(); await flush();
    durables['/p2'] = [{ id: 'n1', name: 'new' }];
    configListeners[0]('/p2');
    await flush(); await flush();
    expect(events.filter((e) => e.type === 'agent.created')).toMatchObject([{ agentId: 'n1', name: 'new', projectPath: '/p2' }]);
  });

  it('publishes asleep on exit', async () => {
    await start();
    exitListeners[0]('a1', 0);
    expect(events).toMatchObject([{ type: 'agent.asleep', agentId: 'a1', exitCode: 0 }]);
  });

  it('turns a helper’s completed turn into helper finished', async () => {
    durables['/p1'] = [{ id: 'a1' }, { id: 'h1', parentAgentId: 'a1' }];
    await start();
    publishAppEvent({ type: 'turn.ended', agentId: 'h1', via: 'chat', outcome: 'completed' });
    publishAppEvent({ type: 'turn.ended', agentId: 'a1', via: 'chat', outcome: 'completed' });
    publishAppEvent({ type: 'turn.ended', agentId: 'h1', via: 'chat', outcome: 'failed' });
    expect(events.filter((e) => e.type === 'helper.finished')).toMatchObject([
      { agentId: 'h1', parentAgentId: 'a1', projectPath: '/p1' },
    ]);
  });
});
