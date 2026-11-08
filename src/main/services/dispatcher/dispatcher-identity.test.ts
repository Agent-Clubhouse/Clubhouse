import { describe, expect, it } from 'vitest';
import type { DurableAgentConfig } from '../../../shared/types';
import { isEmptyMirror, mirrorUpdates } from './dispatcher-identity';

const base: DurableAgentConfig = { id: 'a', name: 'Dispatcher', color: 'indigo', createdAt: 'then' };

describe('one identity over two records (#3036)', () => {
  it('is empty when the two already match, whatever is per agent', () => {
    const from = { ...base, model: 'opus', orchestrator: 'claude-code' as const, lastSessionId: 's1', runtimeMode: 'chat' as const };
    const to = { ...from, id: 'b', lastSessionId: 's2', createdAt: 'now' };
    expect(isEmptyMirror(mirrorUpdates(from, to))).toBe(true);
  });

  it('copies name, look and settings', () => {
    const from: DurableAgentConfig = {
      ...base, name: 'Rosie', color: 'rose', emoji: '🦊', orchestrator: 'codex-cli', model: 'gpt-5', contextWindow: '1m',
      runtimeMode: 'terminal', idleSleep: 'never', access: 'auto',
    };
    expect(mirrorUpdates(from, { ...base, id: 'b', icon: 'old.png' })).toEqual({
      identity: { name: 'Rosie', color: 'rose', emoji: '🦊', icon: null },
      config: { orchestrator: 'codex-cli', model: 'gpt-5', contextWindow: '1m', runtimeMode: 'terminal', idleSleep: 'never', access: 'auto' },
    });
  });

  it('clears what the source cleared, and reads a missing model as the CLI default', () => {
    const to: DurableAgentConfig = { ...base, id: 'b', emoji: '🦊', model: 'opus', contextWindow: '1m', runtimeMode: 'chat', idleSleep: 'never' };
    expect(mirrorUpdates(base, to)).toEqual({
      identity: { emoji: null },
      config: { model: 'default', contextWindow: null, runtimeMode: null, idleSleep: null },
    });
    expect(isEmptyMirror(mirrorUpdates({ ...base, model: 'default' }, base))).toBe(true);
  });

  it('never clears the CLI, and copies the legacy free-agent flag only without Access', () => {
    expect(mirrorUpdates(base, { ...base, orchestrator: 'claude-code' }).config).toEqual({});
    expect(mirrorUpdates({ ...base, freeAgentMode: true }, base).config).toEqual({ freeAgentMode: true });
    expect(mirrorUpdates({ ...base, access: 'ask', freeAgentMode: false }, { ...base, freeAgentMode: true }).config).toEqual({ access: 'ask' });
  });
});
