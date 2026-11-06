import { describe, expect, it } from 'vitest';
import { MAX_REPORTED_SKILLS, MAX_REPORTED_SKILL_NAME_LENGTH, readProviderSkills, reportedSkillNames } from './provider-skills';

describe('passive provider skill metadata', () => {
  it.each([undefined, null, {}, '', [null], [42], ['valid', null], [''], ['  '], ['a\nb'],
    ['x'.repeat(MAX_REPORTED_SKILL_NAME_LENGTH + 1)], Array(1), Array(MAX_REPORTED_SKILLS + 1).fill('a')])('keeps malformed or oversized metadata unknown: %j', (value) => {
    expect(reportedSkillNames(value)).toBeNull();
  });

  it('distinguishes explicit empty from unknown and bounds/deduplicates literal names', () => {
    expect(reportedSkillNames([])).toEqual([]);
    expect(reportedSkillNames(['review', '<script>', '../name', 'review'])).toEqual(['review', '<script>', '../name']);
    expect(reportedSkillNames(Array(MAX_REPORTED_SKILLS).fill('a'))).toEqual(['a']);
    expect(reportedSkillNames(['x'.repeat(MAX_REPORTED_SKILL_NAME_LENGTH)])).toHaveLength(1);
  });

  it('requires provider, driver, source and native session provenance at replay', () => {
    const report = { provider: 'claude-code', driver: 'claude_agent_sdk', source: 'system/init', nativeSessionId: 'native', names: [] };
    expect(readProviderSkills(report)).toEqual(report);
    for (const bad of [{ provider: 'codex' }, { driver: 'codex_app_server' }, { source: 'commands' }, { nativeSessionId: '' }]) {
      expect(readProviderSkills({ ...report, ...bad })).toBeNull();
    }
    expect(readProviderSkills({ ...report, names: ['valid', 1] })?.names).toBeNull();
  });
});
