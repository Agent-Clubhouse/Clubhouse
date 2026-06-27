import type { OrchestratorInfo } from '../../../shared/types';

/**
 * Builds the list of orchestrator options shown in an agent's settings selector.
 *
 * Starts from the profile-aware effective orchestrators (parity with AddAgentDialog),
 * then guarantees the agent's *currently-selected* orchestrator is always present —
 * even when it's disabled app-wide or absent from this machine's settings (e.g. a
 * worktree-synced agent whose project/profile wasn't synced). This keeps the selector
 * showing the real value and always usable. See #fix-orchestrator-selector AC #2.
 */
export function buildOrchestratorOptions(
  effectiveOrchestrators: OrchestratorInfo[],
  allOrchestrators: OrchestratorInfo[],
  agentOrchestrator: string,
): OrchestratorInfo[] {
  const opts = [...effectiveOrchestrators];
  if (!opts.some((o) => o.id === agentOrchestrator)) {
    const current = allOrchestrators.find((o) => o.id === agentOrchestrator);
    opts.unshift(current ?? {
      id: agentOrchestrator,
      displayName: agentOrchestrator,
      shortName: agentOrchestrator,
      capabilities: {
        headless: false,
        structuredOutput: false,
        hooks: false,
        sessionResume: false,
        permissions: false,
        structuredMode: false,
      },
    });
  }
  return opts;
}
