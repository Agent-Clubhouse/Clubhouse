import { describe, expect, it } from 'vitest';
import { effectiveOrchestratorOf, newAgentOrchestrator } from './effective-orchestrator';

describe('effectiveOrchestratorOf (#2975)', () => {
  it('is the agent\'s own CLI, else the project\'s "Agents run on", else Claude Code', () => {
    expect(effectiveOrchestratorOf({ orchestrator: 'copilot-cli' }, { orchestrator: 'codex-cli' })).toBe('copilot-cli');
    expect(effectiveOrchestratorOf({}, { orchestrator: 'codex-cli' })).toBe('codex-cli');
    expect(effectiveOrchestratorOf({ orchestrator: null }, {})).toBe('claude-code');
    expect(effectiveOrchestratorOf({}, undefined)).toBe('claude-code');
  });
});

describe('newAgentOrchestrator (#2975)', () => {
  const offered = [{ id: 'claude-code' }, { id: 'codex-cli' }];
  it('starts on the project\'s "Agents run on" when it is offered', () => {
    expect(newAgentOrchestrator({ orchestrator: 'codex-cli' }, offered)).toBe('codex-cli');
  });
  it('starts on the first CLI offered otherwise', () => {
    expect(newAgentOrchestrator({ orchestrator: 'copilot-cli' }, offered)).toBe('claude-code');
    expect(newAgentOrchestrator(undefined, [{ id: 'codex-cli' }])).toBe('codex-cli');
    expect(newAgentOrchestrator(undefined, [])).toBe('claude-code');
  });
});
