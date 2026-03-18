/**
 * Zustand store for remote satellite projects and agents (#866).
 *
 * Populated from satellite snapshots and real-time events forwarded
 * by the annex client. Agent IDs are namespaced as `remote:<satelliteId>:<originalAgentId>`
 * to prevent collisions with local agents.
 */
import { create } from 'zustand';
import type {
  Project,
  Agent,
  AgentDetailedStatus,
  SatelliteSnapshot,
} from '../../shared/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RemoteProject extends Project {
  remote: true;
  satelliteId: string;
  satelliteName: string;
}

export function isRemoteProject(project: Project | RemoteProject): project is RemoteProject {
  return 'remote' in project && (project as RemoteProject).remote === true;
}

/** Namespace an agent ID for routing unambiguity. */
export function namespacedAgentId(satelliteId: string, agentId: string): string {
  return `remote:${satelliteId}:${agentId}`;
}

/** Parse a namespaced agent ID back to its components. */
export function parseNamespacedId(id: string): { satelliteId: string; agentId: string } | null {
  const match = id.match(/^remote:([^:]+):(.+)$/);
  if (!match) return null;
  return { satelliteId: match[1], agentId: match[2] };
}

/** Check if an agent ID is a remote (namespaced) ID. */
export function isRemoteAgentId(id: string): boolean {
  return id.startsWith('remote:');
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface RemoteProjectStoreState {
  /** Remote projects keyed by satelliteId */
  satelliteProjects: Record<string, RemoteProject[]>;

  /** Remote agents keyed by namespaced ID */
  remoteAgents: Record<string, Agent>;

  /** Remote agent detailed statuses keyed by namespaced ID */
  remoteAgentDetailedStatus: Record<string, AgentDetailedStatus>;

  /** Plugin match results per satellite */
  pluginMatchState: Record<string, PluginMatchResult[]>;

  /** Apply a satellite snapshot to the store. */
  applySatelliteSnapshot: (satelliteId: string, satelliteName: string, snapshot: SatelliteSnapshot) => void;

  /** Remove all data for a satellite (e.g., on disconnect). */
  removeSatellite: (satelliteId: string) => void;

  /** Update a remote agent's detailed status. */
  updateRemoteAgentStatus: (satelliteId: string, agentId: string, status: AgentDetailedStatus) => void;

  /** Get all remote projects (flattened). */
  getAllRemoteProjects: () => RemoteProject[];
}

export interface PluginMatchResult {
  id: string;
  status: 'matched' | 'missing' | 'version_mismatch';
  localVersion?: string;
  remoteVersion?: string;
}

export const useRemoteProjectStore = create<RemoteProjectStoreState>((set, get) => ({
  satelliteProjects: {},
  remoteAgents: {},
  remoteAgentDetailedStatus: {},
  pluginMatchState: {},

  applySatelliteSnapshot: (satelliteId, satelliteName, snapshot) => {
    // Map projects to RemoteProject
    const projects: RemoteProject[] = (snapshot.projects || []).map((p) => ({
      ...p,
      id: `remote:${satelliteId}:${p.id}`,
      path: '__remote__',
      remote: true as const,
      satelliteId,
      satelliteName,
    }));

    // Map agents with namespaced IDs
    const newAgents: Record<string, Agent> = {};
    const agents = snapshot.agents || {};
    for (const [projectId, projectAgents] of Object.entries(agents)) {
      for (const agent of projectAgents as Agent[]) {
        const nsId = namespacedAgentId(satelliteId, agent.id);
        newAgents[nsId] = {
          ...agent,
          id: nsId,
          projectId: `remote:${satelliteId}:${agent.projectId}`,
        };
      }
    }

    // Merge into store (replace this satellite's data, keep others)
    set((state) => {
      // Remove old agents for this satellite
      const filteredAgents = { ...state.remoteAgents };
      for (const key of Object.keys(filteredAgents)) {
        if (key.startsWith(`remote:${satelliteId}:`)) {
          delete filteredAgents[key];
        }
      }

      return {
        satelliteProjects: {
          ...state.satelliteProjects,
          [satelliteId]: projects,
        },
        remoteAgents: {
          ...filteredAgents,
          ...newAgents,
        },
      };
    });
  },

  removeSatellite: (satelliteId) => {
    set((state) => {
      const newProjects = { ...state.satelliteProjects };
      delete newProjects[satelliteId];

      const newAgents = { ...state.remoteAgents };
      const newStatuses = { ...state.remoteAgentDetailedStatus };
      for (const key of Object.keys(newAgents)) {
        if (key.startsWith(`remote:${satelliteId}:`)) {
          delete newAgents[key];
          delete newStatuses[key];
        }
      }

      return {
        satelliteProjects: newProjects,
        remoteAgents: newAgents,
        remoteAgentDetailedStatus: newStatuses,
      };
    });
  },

  updateRemoteAgentStatus: (satelliteId, agentId, status) => {
    const nsId = namespacedAgentId(satelliteId, agentId);
    set((state) => ({
      remoteAgentDetailedStatus: {
        ...state.remoteAgentDetailedStatus,
        [nsId]: status,
      },
    }));
  },

  getAllRemoteProjects: () => {
    const state = get();
    return Object.values(state.satelliteProjects).flat();
  },
}));
