import { describe, it, expect } from 'vitest';
import { canRunDispatcher, pickDispatcherDefault } from './dispatcher-default';

const REGISTERED = ['claude-code', 'copilot-cli', 'codex-cli', 'antigravity-cli'];

describe('pickDispatcherDefault', () => {
  it('picks the first enabled provider, as before, for the existing three', () => {
    expect(pickDispatcherDefault(REGISTERED.slice(0, 3), ['codex-cli', 'copilot-cli'])).toBe('copilot-cli');
    expect(pickDispatcherDefault(REGISTERED.slice(0, 3), [])).toBe('claude-code');
  });

  it('never picks Antigravity, even when it is the only provider enabled', () => {
    expect(pickDispatcherDefault(REGISTERED, ['antigravity-cli'])).toBe('claude-code');
    expect(pickDispatcherDefault(['antigravity-cli'], ['antigravity-cli'])).toBeUndefined();
    expect(canRunDispatcher('antigravity-cli')).toBe(false);
  });
});
