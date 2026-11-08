import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { listeners } = vi.hoisted(() => ({
  listeners: {
    config: new Set<(projectPath: string) => void>(),
    dispatcher: new Set<() => void>(),
    projects: new Set<() => void>(),
    bindings: new Set<(agentId: string) => void>(),
    events: new Set<(event: { type: string; agentId?: string }) => void>(),
  },
}));

function subscribe<T>(set: Set<T>) {
  return (listener: T) => {
    set.add(listener);
    return () => set.delete(listener);
  };
}

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => '/tmp' } }));
vi.mock('../log-service', () => ({ appLog: vi.fn() }));
vi.mock('../project-store', () => ({ list: vi.fn(async () => []), onProjectsChanged: subscribe(listeners.projects) }));
vi.mock('../agent-config', () => ({ listDurable: vi.fn(async () => []), onAgentConfigChanged: subscribe(listeners.config) }));
vi.mock('../orchestration-policy', () => ({ resolveOrchestrationPolicies: vi.fn(async () => new Map()) }));
vi.mock('../agent-runtime', () => ({ getAgentRuntime: vi.fn(), isAgentStoppingError: () => false }));
vi.mock('../app-event-bus', () => ({ onAppEvent: subscribe(listeners.events) }));
vi.mock('../clubhouse-mcp/binding-manager', () => ({
  bindingManager: {
    onChange: subscribe(listeners.bindings),
    getBindingsForAgent: (agentId: string) => (agentId === 'lead' ? [{ agentId, targetId: 'dispatcher', targetKind: 'agent' }] : []),
  },
}));
vi.mock('./dispatcher-service', () => ({
  DISPATCHER_NAME: 'Dispatcher',
  getDispatcherAgentId: () => 'dispatcher',
  isDispatcherEnabled: () => true,
  isDispatcherPath: (p: string) => p === '/dispatcher',
  onDispatcherChanged: subscribe(listeners.dispatcher),
}));

import { isWiredToDispatcher, liveAgentCardDeps, watchAgentCards } from './dispatcher-agent-cards-watch';
import { getAgentRuntime } from '../agent-runtime';
import type { AgentCards } from './dispatcher-agent-cards';

let cards: { sync: ReturnType<typeof vi.fn>; deliver: ReturnType<typeof vi.fn> };
let stop: () => void;

beforeEach(() => {
  vi.useFakeTimers();
  cards = { sync: vi.fn(async () => {}), deliver: vi.fn(async () => {}) };
  stop = watchAgentCards(cards as unknown as AgentCards);
});
afterEach(() => {
  stop();
  vi.useRealTimers();
});

describe('watching for agent cards', () => {
  it('syncs every project once at start', async () => {
    await vi.advanceTimersByTimeAsync(300);
    expect(cards.sync).toHaveBeenCalledTimes(1);
    expect(cards.sync).toHaveBeenCalledWith(undefined);
  });

  it('reads only the project whose agents changed, once for a burst, and never the Dispatcher\'s own folder', async () => {
    await vi.advanceTimersByTimeAsync(300);
    for (const l of listeners.config) { l('/p'); l('/p'); l('/q'); l('/dispatcher'); }
    await vi.advanceTimersByTimeAsync(300);
    expect(cards.sync).toHaveBeenCalledTimes(2);
    expect(cards.sync).toHaveBeenLastCalledWith(new Set(['/p', '/q']));
  });

  it('reads every project when the Dispatcher or the project list changes', async () => {
    await vi.advanceTimersByTimeAsync(300);
    for (const l of listeners.dispatcher) l();
    await vi.advanceTimersByTimeAsync(300);
    expect(cards.sync).toHaveBeenLastCalledWith(undefined);
    for (const l of listeners.projects) l();
    await vi.advanceTimersByTimeAsync(300);
    expect(cards.sync).toHaveBeenCalledTimes(3);
  });

  it('sends a waiting request when the agent\'s wires change or its turn ends', () => {
    for (const l of listeners.bindings) l('lead');
    for (const l of listeners.events) { l({ type: 'turn.ended', agentId: 'qa' }); l({ type: 'turn.started', agentId: 'qa' }); }
    expect(cards.deliver.mock.calls).toEqual([['lead'], ['qa']]);
  });

  it('stops listening when unsubscribed', async () => {
    stop();
    for (const l of listeners.bindings) l('lead');
    expect(cards.deliver).not.toHaveBeenCalled();
  });
});

describe('isWiredToDispatcher', () => {
  it('is true only for an agent with a wire to the Dispatcher, and never for the Dispatcher', () => {
    expect(isWiredToDispatcher('lead')).toBe(true);
    expect(isWiredToDispatcher('qa')).toBe(false);
    expect(isWiredToDispatcher('dispatcher')).toBe(false);
  });
});

describe('sending a request', () => {
  const runtime = { kind: 'chat', isRunning: () => true, getState: () => 'idle', sendMessage: vi.fn(async () => ({ delivery: 'prompt' })) };

  beforeEach(() => {
    runtime.sendMessage.mockClear();
    vi.mocked(getAgentRuntime).mockReturnValue(runtime as never);
  });
  afterEach(() => vi.unstubAllEnvs());

  it('puts it in front of a running agent as a Clubhouse message', async () => {
    expect(await liveAgentCardDeps.send('lead', '[Clubhouse] hi', [{ fromClubhouse: true, text: 'hi' }])).toBe('delivered');
    expect(runtime.sendMessage).toHaveBeenCalledWith('[Clubhouse] hi', expect.objectContaining({ source: 'mcp', routed: [{ fromClubhouse: true, text: 'hi' }] }));
  });

  it('sends nothing in E2E, where a fake CLI\'s script doesn\'t expect it', async () => {
    vi.stubEnv('CLUBHOUSE_TEST_NO_CARD_REQUESTS', '1');
    expect(await liveAgentCardDeps.send('lead', '[Clubhouse] hi', [])).toBe('not_running');
    expect(runtime.sendMessage).not.toHaveBeenCalled();
  });
});
