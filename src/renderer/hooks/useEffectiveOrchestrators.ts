import { useMemo } from 'react';
import { useOrchestratorStore } from '../stores/orchestratorStore';
import type { OrchestratorInfo } from '../../shared/types';

interface EffectiveOrchestratorsResult {
  /** Orchestrators available for agent creation: the enabled ones. */
  effectiveOrchestrators: OrchestratorInfo[];
}

/**
 * The orchestrators agent creation offers: every enabled one. Each runs on
 * its provider's own login (provider profiles were removed, #2749).
 */
export function useEffectiveOrchestrators(): EffectiveOrchestratorsResult {
  const enabled = useOrchestratorStore((s) => s.enabled);
  const allOrchestrators = useOrchestratorStore((s) => s.allOrchestrators);

  return useMemo(() => ({
    effectiveOrchestrators: allOrchestrators.filter((o) => enabled.includes(o.id)),
  }), [allOrchestrators, enabled]);
}
