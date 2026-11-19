import { describe, expect, it } from 'vitest';
import { isRemoteAgentSettings } from './remote-agent-settings';
const value = { version: 1, readOnly: true, agentId: 'a1', provider: 'Host', model: 'Model', runtime: 'terminal', access: 'Ask first', executionPolicy: 'Defaults', autoSleep: null, context: null,
  setup: { state: 'ok', managed: false, template: null, instructions: 'None', skills: null, mcps: null } };
describe('remote Settings contract', () => {
  it('accepts bounded read-only evidence and rejects mismatched identity or malformed data', () => {
    expect(isRemoteAgentSettings(value, 'a1')).toBe(true);
    expect(isRemoteAgentSettings({ ...value, providerId: 'claude-code' }, 'a1')).toBe(true);
    expect(isRemoteAgentSettings(value, 'a2')).toBe(false);
    for (const patch of [{ version: 2 }, { readOnly: false }, { provider: 1 }, { providerId: 1 }, { providerId: '' }, { providerId: 'x'.repeat(1025) }, { runtime: 'local' }, { model: 'x'.repeat(1025) }, { setup: {} }, { setup: { ...value.setup, mcps: ['x', 1] } }, { setup: { ...value.setup, skills: Array(101).fill('x') } }]) {
      expect(isRemoteAgentSettings({ ...value, ...patch }, 'a1')).toBe(false);
    }
  });
});
