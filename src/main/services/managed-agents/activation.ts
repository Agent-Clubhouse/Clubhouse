import type { DurableAgentConfig } from '../../../shared/types';
import type { ManagedMcpProblem } from '../../../shared/managed-agents-types';
import { resolveManagedSetup, setupFingerprint, type DeliveryRecord } from './delivery';
import type { ManagedAgentsService } from './service';
import { withClubhouseSetup } from './service';
import type { ManagedPartRevision } from './activation-receipts';

export function partRevisions(parts: DeliveryRecord['parts']): ManagedPartRevision[] {
  return Object.entries(parts).map(([id, part]) => ({ id, revision: part.revision })).sort((a, b) => a.id.localeCompare(b.id));
}

/** Passive evidence only. A delivery record or a live process never proves model visibility. */
export async function managedActivationFor(input: {
  service: ManagedAgentsService;
  agent: DurableAgentConfig;
  running: boolean;
  effectiveProvider?: string;
  materialized?: DeliveryRecord;
  deliveryFailed: boolean;
  mcpProblems?: ManagedMcpProblem[];
}) {
  const { agent, service, running, materialized } = input;
  const configured = agent.managed ? withClubhouseSetup(agent.managed) : null;
  const desired = configured ? await resolveManagedSetup(service, configured) : null;
  const fingerprint = desired ? setupFingerprint(agent, desired).fingerprint : null;
  const provider = input.effectiveProvider ?? agent.orchestrator;
  const partsMatch = materialized && fingerprint ? materialized.fingerprint === fingerprint && !materialized.missing && !desired?.missing.length : null;
  const providerMatch = materialized?.provider && provider ? materialized.provider === provider : null;
  const matchesDesired = partsMatch === false || providerMatch === false ? false : partsMatch === null || providerMatch === null ? null : true;
  const duplicates = desired ? desired.mcps.map((m) => m.content.serverKey).filter((key, index, keys) => keys.indexOf(key) !== index) : [];
  const lastRestart = await service.latestRestartReceipt(agent.id);
  const diagnostics = [
    ...(!configured ? ['not_managed'] : []),
    ...(desired?.missing.length ? ['missing_parts'] : []),
    ...(duplicates.length ? ['duplicate_mcp_keys'] : []),
    ...(input.deliveryFailed ? ['delivery_failed'] : []),
    ...(running && input.mcpProblems?.length ? ['missing_mcp_environment'] : []),
    ...(!running && lastRestart?.outcome === 'failed' ? ['restart_failed'] : []),
  ];
  return {
    agentId: agent.id,
    provider: provider ?? 'not_confirmed',
    status: diagnostics.length ? 'blocked' : running && matchesDesired ? 'partial' : 'pending',
    configured: { managed: !!configured, ...(configured && { blocks: configured.blocks, skills: configured.skills, mcps: configured.mcps }) },
    desired: desired ? {
      parts: partRevisions(setupFingerprint(agent, desired).parts),
      missing: desired.missing,
      fingerprint,
    } : null,
    materialized: input.deliveryFailed ? { status: 'failed', matchesDesired: false }
      : materialized ? { status: 'recorded', provider: materialized.provider ?? 'not_confirmed', deliveredAt: materialized.deliveredAt, parts: partRevisions(materialized.parts), missing: materialized.missing ?? 0, matchesDesired }
        : { status: 'not_confirmed', matchesDesired: null },
    running: {
      status: running ? 'running' : 'stopped',
      launchSetup: running && materialized && !input.deliveryFailed ? 'recorded_at_start' : 'not_confirmed',
      matchesDesired: running && !input.deliveryFailed ? matchesDesired : null,
    },
    providerConfirmedLoaded: {
      skills: 'not_confirmed', mcpTools: 'not_confirmed', syntheticCheck: 'not_run',
      note: 'No trusted model-visible skill/tool report is available through this API. File writes, session creation and MCP handshakes are not activation proof. No prompt, tool operation or paid probe was run.',
    },
    verification: { status: 'blocked', reason: 'provider_evidence_unavailable', attempts: 0,
      recovery: 'Inspect the target provider\'s current-session model-visible inventory, or request an explicitly authorized harmless check. Do not restart repeatedly to infer success.' },
    lastRestart,
    ...(lastRestart?.outcome === 'requested' && { restartNote: 'Restart intent exists, but its outcome is not recorded. It may still be waiting or may have been interrupted; do not assume completion or retry automatically.' }),
    diagnostics,
  };
}
