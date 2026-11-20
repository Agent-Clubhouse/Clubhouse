import type { ProviderNextWake, ProviderStartReceipt } from '../../shared/mobile-control';

/** Immutable creation evidence is separate from the current runtime observation.
 * The provider selection names the command's provider, never a CLI handshake. */
export function providerStartReceipt(input: {
  agentId: string; hostEpoch: string; commandId: string; configured: ProviderNextWake | null;
  completed: boolean; created: boolean; selectedProvider: string | null;
  running: boolean | null; sameCreatedRuntime: boolean; appSessionId?: string; nativeProviderSessionId?: string;
  createdAt?: string; observedAt?: string;
}): ProviderStartReceipt {
  const associated = input.created && input.sameCreatedRuntime && input.running;
  return { version: 2, target: { agentId: input.agentId, hostEpoch: input.hostEpoch, commandId: input.commandId }, configured: input.configured,
    result: { status: input.completed ? 'start_acknowledged' : input.created ? 'failed_after_creation' : 'refused_before_creation', configuration: input.configured ? 'verified_at_start' : 'not_verified', configPersistedByStart: false },
    start: { creation: input.created ? 'observed' : 'not_observed', providerSelection: input.created ? input.selectedProvider : null, evidence: input.created ? 'pty_created' : 'unknown', observedAt: input.created ? input.createdAt ?? null : null },
    running: { state: input.running === false ? 'not_running' : associated ? 'running' : 'unknown', providerSelection: associated ? input.selectedProvider : null, evidence: associated ? 'same_created_runtime' : 'unknown', observedAt: input.observedAt ?? null,
      appSessionId: associated ? input.appSessionId ?? null : null, nativeProviderSessionId: associated ? input.nativeProviderSessionId ?? null : null, model: null, effort: null } };
}
