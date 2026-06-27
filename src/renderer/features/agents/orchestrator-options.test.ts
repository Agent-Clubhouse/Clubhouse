import { describe, it, expect } from 'vitest';
import { buildOrchestratorOptions } from './orchestrator-options';
import type { OrchestratorInfo } from '../../../shared/types';

const caps = { headless: true, structuredOutput: true, hooks: true, sessionResume: true, permissions: true, structuredMode: false };

const claudeCode: OrchestratorInfo = { id: 'claude-code', displayName: 'Claude Code', shortName: 'CC', capabilities: caps };
const codexCli: OrchestratorInfo = { id: 'codex-cli', displayName: 'Codex CLI', shortName: 'CX', capabilities: caps };
const copilotCli: OrchestratorInfo = { id: 'copilot-cli', displayName: 'Copilot CLI', shortName: 'CP', capabilities: caps };

const allOrchestrators = [claudeCode, codexCli, copilotCli];

describe('buildOrchestratorOptions', () => {
  it('returns the effective orchestrators unchanged when the current one is already present', () => {
    const opts = buildOrchestratorOptions([claudeCode, codexCli], allOrchestrators, 'claude-code');
    expect(opts.map((o) => o.id)).toEqual(['claude-code', 'codex-cli']);
  });

  it('does not duplicate the current orchestrator', () => {
    const opts = buildOrchestratorOptions([claudeCode, codexCli], allOrchestrators, 'codex-cli');
    expect(opts.filter((o) => o.id === 'codex-cli')).toHaveLength(1);
    expect(opts).toHaveLength(2);
  });

  it('prepends the current orchestrator (from the global list) when it is not in the effective set', () => {
    // Worktree-synced agent on codex-cli, but the profile only enables claude-code.
    const opts = buildOrchestratorOptions([claudeCode], allOrchestrators, 'codex-cli');
    expect(opts.map((o) => o.id)).toEqual(['codex-cli', 'claude-code']);
    expect(opts[0].displayName).toBe('Codex CLI');
  });

  it('renders a selectable option even when the current orchestrator is unknown to this machine', () => {
    // Agent synced with an orchestrator absent from app settings entirely.
    const opts = buildOrchestratorOptions([claudeCode], [claudeCode], 'mystery-cli');
    expect(opts.map((o) => o.id)).toEqual(['mystery-cli', 'claude-code']);
    // A real <option> can render — the synthesized entry carries a label and safe caps.
    expect(opts[0].displayName).toBe('mystery-cli');
    expect(opts[0].capabilities.permissions).toBe(false);
  });

  it('still surfaces a single option (current orchestrator) when nothing is effective', () => {
    // Empty effective set must not strand the agent with no selector data.
    const opts = buildOrchestratorOptions([], allOrchestrators, 'claude-code');
    expect(opts.map((o) => o.id)).toEqual(['claude-code']);
  });

  it('does not mutate the input array', () => {
    const effective = [claudeCode];
    buildOrchestratorOptions(effective, allOrchestrators, 'codex-cli');
    expect(effective.map((o) => o.id)).toEqual(['claude-code']);
  });
});
