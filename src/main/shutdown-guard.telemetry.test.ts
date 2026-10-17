import { describe, expect, it, vi } from 'vitest';
import { createBeforeQuitHandler } from './shutdown-guard';

describe('before-quit telemetry hooks', () => {
  it('times each cleanup, completes the shutdown span, then flushes telemetry, then quits', async () => {
    const order: string[] = [];
    const telemetry = {
      started: vi.fn(() => order.push('started')),
      step: vi.fn((step: string, _s: number, _e: number, ok: boolean) => order.push(`step:${step}:${ok}`)),
      completed: vi.fn(() => order.push('completed')),
    };
    let quit!: () => void;
    const quitted = new Promise<void>((r) => (quit = r));
    const handler = createBeforeQuitHandler({
      killAll: async () => {},
      flushAllAgentConfigs: async () => {
        throw new Error('disk full');
      },
      flushTelemetry: async () => {
        order.push('flush');
      },
      applyUpdateOnQuit: async () => {},
      appQuit: () => {
        order.push('quit');
        quit();
      },
      onCleanupError: () => order.push('cleanup-error'),
      telemetry,
    });
    handler({ preventDefault: () => {} });
    await quitted;
    expect(order[0]).toBe('started');
    expect(order).toContain('step:pty_kill_all:true');
    expect(order).toContain('step:agent_config_flush:false');
    expect(order).toContain('cleanup-error');
    expect(order.slice(-3)).toEqual(['completed', 'flush', 'quit']);
  });

  it('a throwing telemetry hook never blocks the quit', async () => {
    let quit!: () => void;
    const quitted = new Promise<void>((r) => (quit = r));
    const handler = createBeforeQuitHandler({
      killAll: async () => {},
      flushAllAgentConfigs: async () => {},
      applyUpdateOnQuit: async () => {},
      appQuit: () => quit(),
      onCleanupError: () => {},
      telemetry: {
        started: () => {
          throw new Error('x');
        },
        step: () => {
          throw new Error('y');
        },
        completed: () => {
          throw new Error('z');
        },
      },
    });
    handler({ preventDefault: () => {} });
    await expect(quitted).resolves.toBeUndefined();
  });
});
