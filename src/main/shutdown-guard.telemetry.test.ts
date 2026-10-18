import { describe, expect, it, vi } from 'vitest';
import { createBeforeQuitHandler, createShutdownCoordinator, SHUTDOWN_STEPS } from './shutdown-guard';
import { ATTR } from '../shared/telemetry/attributes';

describe('shutdown telemetry hooks', () => {
  it('times each step, completes the shutdown span, then flushes telemetry, then quits', async () => {
    const order: string[] = [];
    const telemetry = {
      started: vi.fn(() => order.push('started')),
      step: vi.fn((step: string, _s: number, _e: number, ok: boolean) => order.push(`step:${step}:${ok}`)),
      completed: vi.fn(() => order.push('completed')),
    };
    const coordinator = createShutdownCoordinator({
      plan: () => ({
        stop: [{ step: 'pty_kill_all', label: 'kill PTY sessions', run: async () => {}, timeoutMs: 1_000 }],
        persist: [{ step: 'agent_config_flush', label: 'flush agent configs', run: async () => { throw new Error('disk full'); }, timeoutMs: 1_000 }],
        restore: [{ step: 'config_restore', label: 'restore agent configs', run: async () => {}, timeoutMs: 1_000 }],
      }),
      telemetry,
      onCleanupError: () => order.push('cleanup-error'),
    });
    let quit!: () => void;
    const quitted = new Promise<void>((r) => (quit = r));
    createBeforeQuitHandler({
      shutdown: (after) => coordinator.run(after),
      flushTelemetry: async () => { order.push('flush'); },
      applyUpdateOnQuit: async () => {},
      appQuit: () => { order.push('quit'); quit(); },
      onCleanupError: () => order.push('cleanup-error'),
    })({ preventDefault: () => {} });
    await quitted;
    expect(order).toEqual([
      'started',
      'step:pty_kill_all:true',
      'step:agent_config_flush:false',
      'cleanup-error',
      'step:config_restore:true',
      'step:update_apply_on_quit:true',
      'completed',
      'flush',
      'quit',
    ]);
  });

  it('a throwing telemetry hook never blocks the quit', async () => {
    const coordinator = createShutdownCoordinator({
      plan: () => ({ stop: [{ step: 'pty_kill_all', label: 'kill', run: async () => {}, timeoutMs: 1_000 }], persist: [], restore: [] }),
      onCleanupError: () => {},
      telemetry: {
        started: () => { throw new Error('x'); },
        step: () => { throw new Error('y'); },
        completed: () => { throw new Error('z'); },
      },
    });
    let quit!: () => void;
    const quitted = new Promise<void>((r) => (quit = r));
    createBeforeQuitHandler({
      shutdown: (after) => coordinator.run(after),
      applyUpdateOnQuit: async () => {},
      appQuit: () => quit(),
      onCleanupError: () => {},
    })({ preventDefault: () => {} });
    await expect(quitted).resolves.toBeUndefined();
  });
});

describe('shutdown step names', () => {
  it('every step the coordinator reports is a known clubhouse.shutdown.step value, not "other"', () => {
    for (const step of SHUTDOWN_STEPS) expect(ATTR.shutdownStep(step).value).toBe(step);
  });
});
