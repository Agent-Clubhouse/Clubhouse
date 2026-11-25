import { describe, it, expect, beforeEach } from 'vitest';
import { clearHookSessionIds, noteHookSessionId, takeHookSessionId } from './hook-session-ids';

describe('hook-reported session ids', () => {
  beforeEach(() => clearHookSessionIds());

  it('gives the latest id reported during the run, once', () => {
    noteHookSessionId('a1', 'antigravity-cli', 'conv-1', 1000);
    noteHookSessionId('a1', 'antigravity-cli', 'conv-2', 2000);
    expect(takeHookSessionId('a1', 'antigravity-cli', 500)).toBe('conv-2');
    expect(takeHookSessionId('a1', 'antigravity-cli', 500)).toBeUndefined();
  });

  it('never gives an earlier run\'s id or another provider\'s', () => {
    noteHookSessionId('a1', 'antigravity-cli', 'old', 1000);
    expect(takeHookSessionId('a1', 'antigravity-cli', 1001)).toBeUndefined();
    noteHookSessionId('a1', 'antigravity-cli', 'conv', 2000);
    expect(takeHookSessionId('a1', 'codex-cli', 0)).toBeUndefined();
    expect(takeHookSessionId('a1', 'antigravity-cli', 0)).toBeUndefined();
  });
});
