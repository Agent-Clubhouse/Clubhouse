import { beforeEach, describe, expect, it, vi } from 'vitest';
import { claudeContextWindowOptions, copilotContextWindowOptions, type ContextWindowOptions } from '../../shared/context-window';

const mocks = vi.hoisted(() => ({ options: null as unknown, clear: vi.fn(async () => undefined), fails: false }));
vi.mock('./agent-system', () => ({
  resolveOrchestrator: vi.fn(async () => {
    if (mocks.fails) throw new Error('no provider');
    return { id: 'x', displayName: 'X', getContextWindowOptions: async () => mocks.options };
  }),
  resolveProfileEnv: vi.fn(async () => undefined),
}));
vi.mock('./agent-config', () => ({ clearContextWindow: mocks.clear }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));

import { contextWindowCheck, contextWindowForLaunch, contextWindowOptionsFor } from './context-window';

beforeEach(() => {
  mocks.options = claudeContextWindowOptions('claude-haiku-4-5');
  mocks.fails = false;
  mocks.clear.mockClear();
});

describe('contextWindowCheck', () => {
  it('passes a choice on offer and refuses one that is not', async () => {
    expect(await contextWindowCheck('/p', 'x', 'm', '200000')).toEqual({ state: 'ok' });
    expect((await contextWindowCheck('/p', 'x', 'm', '500000')).state).toBe('refused');
  });

  it('cannot say when the catalog cannot, and falls back to unavailable', async () => {
    mocks.options = copilotContextWindowOptions('m', null);
    expect((await contextWindowCheck('/p', 'x', 'm', 'long_context')).state).toBe('unknown');
    mocks.fails = true;
    expect(await contextWindowOptionsFor('/p', 'x', 'm')).toMatchObject<Partial<ContextWindowOptions>>({ configurable: false, state: 'unavailable' });
  });
});

describe('contextWindowForLaunch', () => {
  it('passes a choice on offer', async () => {
    expect(await contextWindowForLaunch('/p', 'x', 'a', 'm', '200000')).toEqual({ value: '200000' });
    expect(mocks.clear).not.toHaveBeenCalled();
  });

  it('clears one the model no longer offers, and sends the notice instead of the value', async () => {
    const result = await contextWindowForLaunch('/p', 'x', 'a', 'm', '500000');
    expect(result.value).toBeUndefined();
    expect(result.notice).toMatchObject({ level: 'warn', code: 'context_window_not_applied' });
    expect(result.notice?.message).toMatch(/cleared it/);
    expect(mocks.clear).toHaveBeenCalledWith('/p', 'a', result.notice?.message);
  });

  it('keeps one it cannot check, unapplied, and says so', async () => {
    mocks.options = copilotContextWindowOptions('m', null);
    const result = await contextWindowForLaunch('/p', 'x', 'a', 'm', 'long_context');
    expect(result.value).toBeUndefined();
    expect(result.notice?.code).toBe('context_window_not_applied');
    expect(result.notice?.message).not.toMatch(/cleared/);
    expect(mocks.clear).not.toHaveBeenCalled();
  });
});
