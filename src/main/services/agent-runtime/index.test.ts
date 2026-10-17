import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../pty-manager', () => ({ isRunning: vi.fn(() => false) }));
vi.mock('../agent-registry', () => ({ agentRegistry: { get: vi.fn(() => undefined) } }));

import { registerChatRuntime, clearChatRuntimes, stopAllChatRuntimes } from './index';
import type { AgentRuntime } from '../../../shared/chat';

function fakeChat(agentId: string, stop: () => Promise<void>): AgentRuntime {
  return { kind: 'chat', agentId, stop: vi.fn(stop) } as unknown as AgentRuntime;
}

afterEach(() => clearChatRuntimes());

describe('stopAllChatRuntimes', () => {
  it('stops every chat runtime in parallel and waits for all of them', async () => {
    const order: string[] = [];
    let finishSlow!: () => void;
    const slow = fakeChat('slow', () => new Promise<void>((r) => { finishSlow = () => { order.push('slow'); r(); }; }));
    const fast = fakeChat('fast', async () => { order.push('fast'); });
    registerChatRuntime(slow);
    registerChatRuntime(fast);

    let settled = false;
    const all = stopAllChatRuntimes().then(() => { settled = true; });
    await vi.waitFor(() => expect(order).toEqual(['fast']));
    expect(slow.stop).toHaveBeenCalledOnce();
    expect(settled).toBe(false);

    finishSlow();
    await all;
    expect(order).toEqual(['fast', 'slow']);
  });

  it('a failing stop does not keep the others from stopping, and is reported', async () => {
    const ok = fakeChat('ok', async () => {});
    registerChatRuntime(fakeChat('broken', async () => { throw new Error('driver close failed'); }));
    registerChatRuntime(ok);

    await expect(stopAllChatRuntimes()).rejects.toThrow('1 chat runtime(s) failed to stop: driver close failed');
    expect(ok.stop).toHaveBeenCalledOnce();
  });
});
