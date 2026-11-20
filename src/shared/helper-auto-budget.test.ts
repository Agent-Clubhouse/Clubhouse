import { describe, expect, it } from 'vitest';
import { defaultAutoBudgetPolicy, isAutoBudgetPolicy, readAutoBudgetSetting } from './helper-auto-budget';

describe('closed, explicit Auto budget configuration', () => {
  it('keeps absence legacy and stores both selected reserves only after explicit opt-in', () => {
    expect(readAutoBudgetSetting(undefined)).toBeUndefined();
    const policy = defaultAutoBudgetPolicy();
    expect(policy).toEqual({ version: 1, enabled: true, reserves: { 'claude-code': 10, 'codex-cli': 10 } });
    expect(isAutoBudgetPolicy(policy)).toBe(true);
    expect(readAutoBudgetSetting({ ...policy, enabled: false })).toEqual({ ...policy, enabled: false });
    const read = readAutoBudgetSetting(policy);
    if (read && read !== 'invalid') read.reserves['claude-code'] = 20;
    expect(policy.reserves['claude-code']).toBe(10);
  });

  it.each([null, {}, [], 'invalid', { ...defaultAutoBudgetPolicy(), version: 2 },
    { ...defaultAutoBudgetPolicy(), enabled: 'true' }, { ...defaultAutoBudgetPolicy(), relaxation: 5 },
    { ...defaultAutoBudgetPolicy(), reserves: { 'claude-code': 10 } },
    { ...defaultAutoBudgetPolicy(), reserves: { 'claude-code': 10, 'copilot-cli': 10 } },
    { ...defaultAutoBudgetPolicy(), reserves: { 'claude-code': -1, 'codex-cli': 10 } },
    { ...defaultAutoBudgetPolicy(), reserves: { 'claude-code': 10.5, 'codex-cli': 10 } },
    { ...defaultAutoBudgetPolicy(), reserves: { 'claude-code': 101, 'codex-cli': 10 } },
  ])('fails closed for unreadable/unsupported configuration %#', (raw) => {
    expect(isAutoBudgetPolicy(raw)).toBe(false);
    expect(readAutoBudgetSetting(raw)).toBe('invalid');
  });
});
