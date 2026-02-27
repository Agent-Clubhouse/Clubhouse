import { useState, useEffect, useMemo } from 'react';
import { useOrchestratorStore } from '../stores/orchestratorStore';
import { useProfileStore } from '../stores/profileStore';
import type { OrchestratorInfo, OrchestratorProfile } from '../../shared/types';

interface EffectiveOrchestratorsResult {
  /** Orchestrators available for agent creation (filtered by active profile) */
  effectiveOrchestrators: OrchestratorInfo[];
  /** The active profile for the project (if any) */
  activeProfile: OrchestratorProfile | undefined;
  /** Whether an orchestrator is covered by the active profile (always true if no profile) */
  isOrchestratorInProfile: (orchestratorId: string) => boolean;
}

/**
 * Returns the effective set of orchestrators for agent creation.
 * When a profile is active on the project, only orchestrators configured
 * in that profile are returned. Otherwise, all enabled orchestrators are returned.
 */
export function useEffectiveOrchestrators(projectPath?: string): EffectiveOrchestratorsResult {
  const enabled = useOrchestratorStore((s) => s.enabled);
  const allOrchestrators = useOrchestratorStore((s) => s.allOrchestrators);
  const profiles = useProfileStore((s) => s.profiles);
  const loadProfiles = useProfileStore((s) => s.loadProfiles);
  const [profileId, setProfileId] = useState<string | undefined>(undefined);

  // Load profiles on mount
  useEffect(() => {
    loadProfiles();
  }, [loadProfiles]);

  // Read the project's profileId from project agent defaults
  useEffect(() => {
    if (!projectPath) {
      setProfileId(undefined);
      return;
    }
    let cancelled = false;
    window.clubhouse.agentSettings.readProjectAgentDefaults(projectPath)
      .then((defaults) => {
        if (!cancelled) setProfileId(defaults?.profileId);
      })
      .catch(() => {
        if (!cancelled) setProfileId(undefined);
      });
    return () => { cancelled = true; };
  }, [projectPath]);

  return useMemo(() => {
    const enabledOrchestrators = allOrchestrators.filter((o) => enabled.includes(o.id));

    if (!profileId) {
      return {
        effectiveOrchestrators: enabledOrchestrators,
        activeProfile: undefined,
        isOrchestratorInProfile: () => true,
      };
    }

    const profile = profiles.find((p) => p.id === profileId);
    if (!profile) {
      return {
        effectiveOrchestrators: enabledOrchestrators,
        activeProfile: undefined,
        isOrchestratorInProfile: () => true,
      };
    }

    const profileOrchestratorIds = new Set(Object.keys(profile.orchestrators));
    const filtered = enabledOrchestrators.filter((o) => profileOrchestratorIds.has(o.id));

    return {
      // If the profile has no matching enabled orchestrators, fall back to all enabled
      effectiveOrchestrators: filtered.length > 0 ? filtered : enabledOrchestrators,
      activeProfile: profile,
      isOrchestratorInProfile: (orchId: string) => profileOrchestratorIds.has(orchId),
    };
  }, [allOrchestrators, enabled, profileId, profiles]);
}
