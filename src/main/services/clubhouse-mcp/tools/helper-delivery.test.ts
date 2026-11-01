import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ChatSessionState } from '../../../../shared/chat';
import { AgentStoppingError } from '../../agent-runtime/agent-stopping';

interface FakeRuntime {
  kind: 'chat' | 'pty';
  state: ChatSessionState;
  caps?: { steer: boolean; queue: 'client' | 'native' | 'none' };
  running: boolean;
  sent: string[];
  routed: unknown[];
  refuse: boolean;
  listeners: Set<(s: ChatSessionState) => void>;
  setState(s: ChatSessionState): void;
}

const runtimes = new Map<string, FakeRuntime>();

function addRuntime(id: string, kind: 'chat' | 'pty', state: ChatSessionState = 'idle'): FakeRuntime {
  const rt: FakeRuntime = {
    kind, state, sent: [], routed: [], refuse: false, listeners: new Set(), running: true,
    setState(s) { rt.state = s; for (const l of [...rt.listeners]) l(s); },
  };
  runtimes.set(id, rt);
  return rt;
}

vi.mock('../../agent-runtime', () => ({
  getAgentRuntime: (id: string) => {
    const rt = runtimes.get(id);
    if (!rt) return undefined;
    return {
      kind: rt.kind,
      agentId: id,
      isRunning: () => rt.running,
      getState: () => (rt.kind === 'chat' ? rt.state : 'idle'),
      getCapabilities: rt.kind === 'chat' ? () => rt.caps ?? { steer: true, queue: 'native' } : undefined,
      onStateChange: (l: (s: ChatSessionState) => void) => { rt.listeners.add(l); return () => { rt.listeners.delete(l); }; },
      sendMessage: async (text: string, opts: { routed?: unknown }) => {
        if (rt.refuse) throw new AgentStoppingError(id);
        rt.sent.push(text);
        rt.routed.push(opts.routed);
        return { delivery: 'prompt' };
      },
    };
  },
}));

import {
  HELPER_UPDATE_WINDOW_MS, _resetHelperDeliveryForTesting, deliverHelperUpdate, deliverNow, flushHelperUpdates,
} from './helper-delivery';

beforeEach(() => {
  vi.useFakeTimers();
  runtimes.clear();
  _resetHelperDeliveryForTesting();
});

afterEach(() => {
  _resetHelperDeliveryForTesting();
  vi.useRealTimers();
});

describe('deliverHelperUpdate (#2414)', () => {
  it('delivers to an idle chat parent at once', async () => {
    const rt = addRuntime('p', 'chat', 'idle');
    await expect(deliverHelperUpdate('p', 'one')).resolves.toBe('delivered');
    expect(rt.sent).toEqual(['one']);
  });

  it('reports a parent with no runtime as not running', async () => {
    await expect(deliverHelperUpdate('gone', 'one')).resolves.toBe('not_running');
  });

  it('batches a burst to a steering parent mid-turn into one message after the window', async () => {
    const rt = addRuntime('p', 'chat', 'running');
    const results = ['a', 'b', 'c'].map((t) => deliverHelperUpdate('p', `[FROM HELPER:${t} (${t})] hi`));
    await vi.advanceTimersByTimeAsync(HELPER_UPDATE_WINDOW_MS - 1);
    expect(rt.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await expect(Promise.all(results)).resolves.toEqual(['delivered', 'delivered', 'delivered']);
    expect(rt.sent).toEqual([
      '3 updates, oldest first:\n\n' +
      '--- 1 of 3 ---\n[FROM HELPER:a (a)] hi\n\n--- 2 of 3 ---\n[FROM HELPER:b (b)] hi\n\n--- 3 of 3 ---\n[FROM HELPER:c (c)] hi',
    ]);
  });

  it('sends who sent each update beside the text, parsing one that has no part', async () => {
    const rt = addRuntime('p', 'chat', 'running');
    const results = [
      deliverHelperUpdate('p', '[FROM HELPER:a (a)] hi', { sender: { agentId: 'a', name: 'a' }, text: 'hi' }),
      deliverHelperUpdate('p', '[Clubhouse] ready'),
    ];
    await vi.advanceTimersByTimeAsync(HELPER_UPDATE_WINDOW_MS);
    await Promise.all(results);
    expect(rt.sent).toEqual(['2 updates, oldest first:\n\n--- 1 of 2 ---\n[FROM HELPER:a (a)] hi\n\n--- 2 of 2 ---\n[Clubhouse] ready']);
    expect(rt.routed).toEqual([[{ sender: { agentId: 'a', name: 'a' }, text: 'hi' }, { fromClubhouse: true, text: 'ready' }]]);
  });

  it('sends an idle parent\'s update with its sender', async () => {
    const rt = addRuntime('p', 'chat', 'idle');
    await deliverHelperUpdate('p', '[FROM HELPER:a (a)] hi', { sender: { agentId: 'a', name: 'a' }, text: 'hi' });
    expect(rt.routed).toEqual([[{ sender: { agentId: 'a', name: 'a' }, text: 'hi' }]]);
  });

  it('keeps the window fixed from the first update', async () => {
    const rt = addRuntime('p', 'chat', 'running');
    void deliverHelperUpdate('p', 'one');
    await vi.advanceTimersByTimeAsync(HELPER_UPDATE_WINDOW_MS - 10);
    void deliverHelperUpdate('p', 'two');
    await vi.advanceTimersByTimeAsync(10);
    expect(rt.sent).toHaveLength(1);
  });

  it('sends a lone update unchanged', async () => {
    const rt = addRuntime('p', 'chat', 'waiting_permission');
    const result = deliverHelperUpdate('p', '[Clubhouse] Helper "a" is ready.');
    await vi.advanceTimersByTimeAsync(HELPER_UPDATE_WINDOW_MS);
    await expect(result).resolves.toBe('delivered');
    expect(rt.sent).toEqual(['[Clubhouse] Helper "a" is ready.']);
  });

  it('flushes early when a chat parent goes idle, and stops listening', async () => {
    const rt = addRuntime('p', 'chat', 'running');
    const results = [deliverHelperUpdate('p', 'one'), deliverHelperUpdate('p', 'two')];
    rt.setState('starting');
    await vi.advanceTimersByTimeAsync(0);
    expect(rt.sent).toEqual([]);
    rt.setState('idle');
    await expect(Promise.all(results)).resolves.toEqual(['delivered', 'delivered']);
    expect(rt.sent).toHaveLength(1);
    expect(rt.listeners.size).toBe(0);
    await vi.advanceTimersByTimeAsync(HELPER_UPDATE_WINDOW_MS);
    expect(rt.sent).toHaveLength(1);
  });

  it('adds to a pending batch even when the parent looks idle, keeping the order', async () => {
    const rt = addRuntime('p', 'chat', 'running');
    void deliverHelperUpdate('p', 'one');
    rt.state = 'idle';
    void deliverHelperUpdate('p', 'two');
    await vi.advanceTimersByTimeAsync(HELPER_UPDATE_WINDOW_MS);
    expect(rt.sent).toHaveLength(1);
    expect(rt.sent[0]).toMatch(/one[\s\S]*two/);
  });

  it('batches per parent', async () => {
    const a = addRuntime('a', 'chat', 'running');
    const b = addRuntime('b', 'chat', 'running');
    void deliverHelperUpdate('a', 'to a');
    void deliverHelperUpdate('b', 'to b');
    await vi.advanceTimersByTimeAsync(HELPER_UPDATE_WINDOW_MS);
    expect(a.sent).toEqual(['to a']);
    expect(b.sent).toEqual(['to b']);
  });

  it('always batches for a terminal parent, whose turn state main cannot see', async () => {
    const rt = addRuntime('t', 'pty');
    const results = [deliverHelperUpdate('t', 'one'), deliverHelperUpdate('t', 'two')];
    await vi.advanceTimersByTimeAsync(0);
    expect(rt.sent).toEqual([]);
    expect(rt.listeners.size).toBe(0);
    await vi.advanceTimersByTimeAsync(HELPER_UPDATE_WINDOW_MS);
    await expect(Promise.all(results)).resolves.toEqual(['delivered', 'delivered']);
    expect(rt.sent).toEqual(['2 updates, oldest first:\n\n--- 1 of 2 ---\none\n\n--- 2 of 2 ---\ntwo']);
  });

  it('reports a terminal that is shutting down as stopping, for every update in the batch', async () => {
    const rt = addRuntime('t', 'pty');
    const results = [deliverHelperUpdate('t', 'one'), deliverHelperUpdate('t', 'two')];
    rt.refuse = true;
    await vi.advanceTimersByTimeAsync(HELPER_UPDATE_WINDOW_MS);
    await expect(Promise.all(results)).resolves.toEqual(['stopping', 'stopping']);
  });

  it('skips the window for a chat parent that merges its own queue (ACP)', async () => {
    const rt = addRuntime('p', 'chat', 'running');
    rt.caps = { steer: false, queue: 'client' };
    await expect(deliverHelperUpdate('p', 'one')).resolves.toBe('delivered');
    await expect(deliverHelperUpdate('p', 'two')).resolves.toBe('delivered');
    expect(rt.sent).toEqual(['one', 'two']);
  });

  it('reports a parent that stops during the window as not running', async () => {
    const rt = addRuntime('p', 'chat', 'running');
    const result = deliverHelperUpdate('p', 'one');
    rt.running = false;
    rt.setState('sleeping');
    await expect(result).resolves.toBe('not_running');
    expect(rt.sent).toEqual([]);
  });

  it('reports a parent that exits during the window as not running', async () => {
    addRuntime('p', 'chat', 'running');
    const result = deliverHelperUpdate('p', 'one');
    runtimes.delete('p');
    await vi.advanceTimersByTimeAsync(HELPER_UPDATE_WINDOW_MS);
    await expect(result).resolves.toBe('not_running');
  });

  it('flushHelperUpdates sends the pending batch at once, so a question that follows keeps its place', async () => {
    const rt = addRuntime('p', 'chat', 'running');
    const result = deliverHelperUpdate('p', 'progress');
    await flushHelperUpdates('p');
    await deliverNow('p', '[QUESTION FROM HELPER:a (a)] ?');
    await expect(result).resolves.toBe('delivered');
    expect(rt.sent).toEqual(['progress', '[QUESTION FROM HELPER:a (a)] ?']);
    await vi.advanceTimersByTimeAsync(HELPER_UPDATE_WINDOW_MS);
    expect(rt.sent).toHaveLength(2);
  });
});
