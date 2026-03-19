/**
 * Hook for accessing remote agent data (#870).
 *
 * Provides a unified interface for reading agent data regardless of whether
 * the active project is local or remote. When the active project is remote,
 * reads from remoteProjectStore; otherwise falls back to the regular agentStore.
 */
import { useMemo } from 'react';
import {
  useRemoteProjectStore,
  isRemoteAgentId,
  isRemoteProjectId as storeIsRemoteProjectId,
  parseNamespacedId,
} from '../stores/remoteProjectStore';
import type { Agent } from '../../shared/types';

/**
 * Check if a project ID refers to a remote project.
 */
export function isRemoteProjectId(projectId: string | null): boolean {
  return !!projectId && storeIsRemoteProjectId(projectId);
}

/**
 * Get remote agents for a given remote project ID.
 */
export function useRemoteAgents(projectId: string | null): Agent[] {
  const remoteAgents = useRemoteProjectStore((s) => s.remoteAgents);

  return useMemo(() => {
    if (!projectId || !isRemoteProjectId(projectId)) return [];

    return Object.values(remoteAgents).filter((agent) => agent.projectId === projectId);
  }, [remoteAgents, projectId]);
}

/**
 * Get the satellite ID from a remote project ID.
 */
export function getSatelliteIdFromProjectId(projectId: string): string | null {
  const parsed = parseNamespacedId(projectId);
  return parsed ? parsed.satelliteId : null;
}

export { isRemoteAgentId, parseNamespacedId };
