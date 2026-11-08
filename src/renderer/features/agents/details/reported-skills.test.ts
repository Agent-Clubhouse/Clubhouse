import { describe, expect, it } from 'vitest';
import type { ChatViewState } from '../../../stores/chatStore';
import { effectiveProviderOf, loadedState, reportedSkillsFor } from './reported-skills';

const report = { provider: 'claude-code' as const, driver: 'claude_agent_sdk' as const, source: 'system/init' as const, nativeSessionId: 'n1', sessionId: 's1', reportedAt: 1, names: ['build'] };
const chat = (over: Partial<ChatViewState> = {}) => ({
  agentId: 'a', provider: 'claude-code', driver: 'claude_agent_sdk', sessionId: 's1', nativeSessionId: 'n1', providerSkills: report, ...over,
}) as unknown as ChatViewState;

describe('reported skills (#2929)', () => {
  it('counts only a report for this agent, its effective provider and its exact session', () => {
    expect(reportedSkillsFor({ id: 'a' }, chat(), {}).report).toBe(report);
    expect(reportedSkillsFor({ id: 'b' }, chat(), {})).toEqual({ supported: false, report: null });
    expect(reportedSkillsFor({ id: 'a' }, chat({ sessionId: 's2' }), {}).report).toBeNull();
    expect(reportedSkillsFor({ id: 'a' }, chat({ nativeSessionId: 'n2' }), {}).report).toBeNull();
    // Inherits Codex from the project, so a Claude chat's report isn't its own.
    expect(reportedSkillsFor({ id: 'a' }, chat(), { orchestrator: 'codex-cli' })).toEqual({ supported: false, report: null });
    // No project yet: nothing can be matched.
    expect(reportedSkillsFor({ id: 'a' }, chat(), undefined).supported).toBe(false);
    expect(reportedSkillsFor({ id: 'a' }, null, {}).supported).toBe(false);
  });

  it('the agent\'s own CLI wins over the project default', () => {
    expect(effectiveProviderOf({ orchestrator: 'copilot-cli' }, { orchestrator: 'codex-cli' })).toBe('copilot-cli');
    expect(effectiveProviderOf({}, { orchestrator: 'codex-cli' })).toBe('codex-cli');
    expect(effectiveProviderOf({}, {})).toBe('claude-code');
    expect(effectiveProviderOf({}, undefined)).toBeNull();
  });

  it('a file on disk is loaded only when the report names it', () => {
    expect(loadedState({ name: 'build' }, undefined)).toBe('not-confirmed');
    expect(loadedState({ name: 'build' }, null)).toBe('not-confirmed');
    expect(loadedState({ name: 'build' }, [])).toBe('not-confirmed');
    expect(loadedState({ name: 'build' }, ['build'])).toBe('reported');
    expect(loadedState({ name: 'folder', skillName: 'real-name' }, ['real-name'])).toBe('reported');
  });
});
