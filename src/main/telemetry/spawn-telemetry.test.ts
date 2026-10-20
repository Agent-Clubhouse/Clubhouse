import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ATTR } from '../../shared/telemetry/attributes';
import { setProducingRuntime } from './__test-utils__/producing-runtime';
import { modelFamily, recordChatStart, recordSpawn, spawnAttrs } from './spawn-telemetry';
import { tagError, type TelemetryRuntime } from './types';

let count: ReturnType<typeof vi.fn>;
let replaySpan: ReturnType<typeof vi.fn>;
beforeEach(() => {
  count = vi.fn();
  replaySpan = vi.fn();
  setProducingRuntime({ level: 'standard', count, replaySpan } as unknown as TelemetryRuntime);
});
afterEach(() => setProducingRuntime(null));

describe('modelFamily', () => {
  it.each([
    [undefined, 'default'],
    ['default', 'default'],
    ['claude-opus-5-5', 'opus'],
    ['sonnet', 'sonnet'],
    ['claude-haiku-5-5', 'haiku'],
    ['gpt-5.1-codex', 'gpt-5'],
    ['my-private-finetune', 'other'],
  ])('%s → %s', (model, family) => {
    expect(modelFamily(model)).toBe(family);
  });
});

describe('recordChatStart', () => {
  it('records nothing for a spawn that was never chat, and a fallback as chat_start_failed', () => {
    recordChatStart(undefined, false);
    expect(replaySpan).not.toHaveBeenCalled();
    recordChatStart(1000, true, 1400);
    recordChatStart(2000, false, 2100);
    expect(replaySpan.mock.calls.map((c) => c[0])).toEqual([
      { name: 'clubhouse.chat.start', startMs: 1000, endMs: 1400, attrs: [], outcome: 'ok', errorType: undefined },
      { name: 'clubhouse.chat.start', startMs: 2000, endMs: 2100, attrs: [], outcome: 'error', errorType: 'chat_start_failed' },
    ]);
  });
});

describe('recordSpawn', () => {
  it('counts a success with its duration', () => {
    recordSpawn('durable', { runtime: 'pty', orchestrator: 'codex-cli' }, 1000, undefined, 3500);
    const dims = [ATTR.agentKind('durable'), ATTR.orchestrator('codex-cli'), ATTR.agentRuntime('pty')];
    expect(count).toHaveBeenCalledWith('clubhouse.agent.spawns', 1, [...dims, ATTR.outcome('ok')]);
    expect(count).toHaveBeenCalledWith('clubhouse.agent.spawn.duration', 2.5, dims);
  });

  it('counts a failure by its tagged error type, and a headless spawn without a PID as headless_no_pid', () => {
    recordSpawn('quick', { runtime: 'pty' }, 0, tagError(new Error('x'), 'cwd_invalid'));
    recordSpawn('quick', { runtime: 'headless', noPid: true }, 0, undefined);
    recordSpawn('quick', { runtime: 'pty' }, 0, new Error('untagged'));
    const types = count.mock.calls.filter((c) => c[0] === 'clubhouse.agent.spawns').map((c) => c[2].at(-1));
    expect(types).toEqual([ATTR.errorType('cwd_invalid'), ATTR.errorType('headless_no_pid'), ATTR.errorType('unknown')]);
    expect(count.mock.calls.some((c) => c[0] === 'clubhouse.agent.spawn.duration')).toBe(false);
  });

  it('only attaches the facts a spawn learned', () => {
    expect(spawnAttrs({ runtime: 'chat', orchestrator: 'weird', model: 'opus' })).toEqual([
      ATTR.orchestrator('other'), ATTR.modelFamily('opus'), ATTR.agentRuntime('chat'),
    ]);
    expect(spawnAttrs({})).toEqual([ATTR.orchestrator('other'), ATTR.modelFamily('default')]);
  });
});
