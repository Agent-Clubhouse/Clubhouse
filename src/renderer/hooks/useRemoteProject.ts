/**
 * Hook for canvas widgets to detect whether they are rendering inside a
 * remote (annex) project context and extract the satellite routing info.
 */
import { useMemo } from 'react';
import { isRemoteProjectId, parseNamespacedId } from '../stores/remoteProjectStore';

export interface RemoteProjectInfo {
  /** Whether this widget is rendering in a remote project context. */
  isRemote: boolean;
  /** The satellite's fingerprint (only set when isRemote). */
  satelliteId: string | null;
  /** The original (non-namespaced) project ID on the satellite (only set when isRemote). */
  originalProjectId: string | null;
}

/**
 * Returns remote project info for a given project ID.
 * Widgets use this to decide whether to route operations through annex proxies.
 */
export function useRemoteProject(projectId: string | undefined | null): RemoteProjectInfo {
  return useMemo(() => {
    if (!projectId || !isRemoteProjectId(projectId)) {
      return { isRemote: false, satelliteId: null, originalProjectId: null };
    }
    const parsed = parseNamespacedId(projectId);
    if (!parsed) {
      return { isRemote: false, satelliteId: null, originalProjectId: null } as RemoteProjectInfo;
    }
    return {
      isRemote: true,
      satelliteId: parsed.satelliteId as string,
      originalProjectId: parsed.agentId as string,
    };
  }, [projectId]);
}
