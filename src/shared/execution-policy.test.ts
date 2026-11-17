import { describe, it, expect } from 'vitest';
import { APPROVAL_POLICIES, SANDBOX_MODES, assertExecutionPolicy, hasExecutionPolicy, validateExecutionPolicy, accessWithExecutionPolicy, helperExecutionPolicy } from './execution-policy';

describe('independent execution policies', () => {
  it('preserves absent policies without migrating agents, templates or helper presets', () => {
    for (const record of [{}, { access: 'auto' }, { access: 'full_access' }, { freeAgentMode: true }]) {
      const before = JSON.stringify(record);
      for (const provider of ['codex-cli', 'claude-code', 'copilot-cli', 'custom']) assertExecutionPolicy(provider, 'chat', record);
      expect(hasExecutionPolicy(record)).toBe(false);
      expect(JSON.stringify(record)).toBe(before);
    }
  });
  it.each(APPROVAL_POLICIES.flatMap((approvalPolicy) => SANDBOX_MODES.map((sandbox) => ({ approvalPolicy, sandbox }))))('chat supports $approvalPolicy × $sandbox', (policy) => {
    expect(() => assertExecutionPolicy('codex-cli', 'chat', policy, true)).not.toThrow();
  });
  it.each(SANDBOX_MODES)('terminal start/resume supports both approval choices with %s', (sandbox) => {
    for (const approvalPolicy of ['on-request', 'never'] as const) {
      for (const resume of [false, true]) expect(() => assertExecutionPolicy('codex-cli', 'terminal', { sandbox, approvalPolicy }, resume)).not.toThrow();
    }
  });
  it('refuses unsupported pairs and fallback without dropping a restriction', () => {
    for (const provider of ['claude-code', 'copilot-cli', 'custom']) expect(() => assertExecutionPolicy(provider, 'chat', { sandbox: 'read-only' })).toThrow('No verified mapping');
    expect(() => assertExecutionPolicy('codex-cli', 'terminal', { approvalPolicy: 'untrusted' })).toThrow('requires chat');
    expect(() => assertExecutionPolicy('codex-cli', 'headless', { approvalPolicy: 'on-request' })).toThrow('cannot show');
    expect(() => assertExecutionPolicy('codex-cli', 'headless', { sandbox: 'read-only' }, true)).toThrow('exec resume');
    expect(() => validateExecutionPolicy({ sandbox: 'full' })).toThrow();
    expect(() => validateExecutionPolicy({ approvalPolicy: 'on-failure' })).toThrow();
  });
  it('keeps parent restrictions for helpers and never treats a level as permission to remove them', () => {
    expect(helperExecutionPolicy({}, { sandbox: 'read-only', approvalPolicy: 'never' }, 'ask')).toEqual({ sandbox: 'read-only', approvalPolicy: 'never' });
    expect(helperExecutionPolicy({ sandbox: 'read-only', approvalPolicy: 'never' }, { sandbox: 'read-only', approvalPolicy: 'never' }, 'ask')).toEqual({ sandbox: 'read-only', approvalPolicy: 'never' });
    expect(() => helperExecutionPolicy({ sandbox: 'danger-full-access' }, { sandbox: 'read-only' }, 'full_access')).toThrow('sandbox exceeds');
    expect(() => helperExecutionPolicy({ approvalPolicy: 'never' }, { approvalPolicy: 'untrusted' }, 'full_access')).toThrow('approval policy exceeds');
    expect(() => helperExecutionPolicy({ sandbox: 'danger-full-access' }, undefined, 'auto')).toThrow('access ceiling');
    expect(helperExecutionPolicy({}, undefined, 'ask')).toEqual({});
  });
  it('cannot smuggle higher access through an independent axis in tools', () => {
    expect(accessWithExecutionPolicy('plan', { sandbox: 'danger-full-access' })).toBe('full_access');
    expect(accessWithExecutionPolicy('ask', { approvalPolicy: 'never' })).toBe('auto');
    expect(accessWithExecutionPolicy('ask', { approvalPolicy: 'on-request' })).toBe('auto_edit');
    expect(accessWithExecutionPolicy('full_access', { sandbox: 'read-only' })).toBe('full_access');
  });
});
