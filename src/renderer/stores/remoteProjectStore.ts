/**
 * Zustand store for remote satellite projects and agents (#866).
 *
 * Populated from satellite snapshots and real-time events forwarded
 * by the annex client. Agent IDs are namespaced as `remote:<satelliteId>:<originalAgentId>`
 * to prevent collisions with local agents.
 */
import { create } from 'zustand';
import { usePluginStore } from '../plugins/plugin-store';
import type {
  Project,
  Agent,
  AgentDetailedStatus,
  SatelliteSnapshot,
  SnapshotPluginSummary,
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

/**
 * Namespace delimiter — must not appear in fingerprints (hex:hex colon-separated)
 * or agent/project IDs (alphanum + underscore). Double-pipe is safe.
 */
const NS_SEP = '||';
const NS_PREFIX = `remote${NS_SEP}`;

/** Namespace an agent ID for routing unambiguity. */
export function namespacedAgentId(satelliteId: string, agentId: string): string {
  return `${NS_PREFIX}${satelliteId}${NS_SEP}${agentId}`;
}

/** Namespace a project ID. */
export function namespacedProjectId(satelliteId: string, projectId: string): string {
  return `${NS_PREFIX}${satelliteId}${NS_SEP}${projectId}`;
}

/** Return the prefix used for all IDs belonging to a satellite. */
export function satellitePrefix(satelliteId: string): string {
  return `${NS_PREFIX}${satelliteId}${NS_SEP}`;
}

/** Parse a namespaced ID (agent or project) back to its components. */
export function parseNamespacedId(id: string): { satelliteId: string; agentId: string } | null {
  if (!id.startsWith(NS_PREFIX)) return null;
  const rest = id.slice(NS_PREFIX.length);
  const sepIdx = rest.indexOf(NS_SEP);
  if (sepIdx === -1) return null;
  return { satelliteId: rest.slice(0, sepIdx), agentId: rest.slice(sepIdx + NS_SEP.length) };
}

/** Check if an agent ID is a remote (namespaced) ID. */
export function isRemoteAgentId(id: string): boolean {
  return id.startsWith(NS_PREFIX);
}

/** Check if a project ID is a remote (namespaced) ID. */
export function isRemoteProjectId(id: string): boolean {
  return id.startsWith(NS_PREFIX);
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

  /** Remote project icon data URLs keyed by namespaced project ID */
  remoteProjectIcons: Record<string, string>;

  /** Remote agent icon data URLs keyed by namespaced agent ID */
  remoteAgentIcons: Record<string, string>;

  /** Apply a satellite snapshot to the store. */
  applySatelliteSnapshot: (satelliteId: string, satelliteName: string, snapshot: SatelliteSnapshot) => void;

  /** Remove all data for a satellite (e.g., on disconnect). */
  removeSatellite: (satelliteId: string) => void;

  /** Update a remote agent's detailed status. */
  updateRemoteAgentStatus: (satelliteId: string, agentId: string, status: AgentDetailedStatus) => void;

  /** Update a remote agent's run state (running/sleeping). */
  updateRemoteAgentRunState: (satelliteId: string, agentId: string, status: 'running' | 'sleeping') => void;

  /** Upsert a remote agent (add if new, update run state if exists). */
  upsertRemoteAgent: (satelliteId: string, agent: Partial<Agent> & { id: string }) => void;

  /** Get all remote projects (flattened). */
  getAllRemoteProjects: () => RemoteProject[];
}

export interface PluginMatchResult {
  id: string;
  name: string;
  status: 'matched' | 'missing' | 'version_mismatch';
  /** Source of the locally matched plugin (builtin vs community/marketplace). */
  source?: 'builtin' | 'community' | 'marketplace';
  localVersion?: string;
  remoteVersion?: string;
  scope?: string;
  contributes?: unknown;
}

/**
 * Compare satellite plugins against locally installed plugins.
 */
function computePluginMatchState(remotePlugins: SnapshotPluginSummary[]): PluginMatchResult[] {
  const localPlugins = usePluginStore.getState().plugins;

  return remotePlugins.map((remote) => {
    const local = localPlugins[remote.id];
    if (!local) {
      return {
        id: remote.id,
        name: remote.name,
        status: 'missing' as const,
        remoteVersion: remote.version,
        scope: remote.scope,
        contributes: remote.contributes,
      };
    }
    if (local.manifest.version !== remote.version) {
      return {
        id: remote.id,
        name: remote.name,
        status: 'version_mismatch' as const,
        source: local.source,
        localVersion: local.manifest.version,
        remoteVersion: remote.version,
        scope: remote.scope,
        contributes: remote.contributes,
      };
    }
    return {
      id: remote.id,
      name: remote.name,
      status: 'matched' as const,
      source: local.source,
      localVersion: local.manifest.version,
      remoteVersion: remote.version,
      scope: remote.scope,
      contributes: remote.contributes,
    };
  });
}

export const useRemoteProjectStore = create<RemoteProjectStoreState>((set, get) => ({
  satelliteProjects: {},
  remoteAgents: {},
  remoteAgentDetailedStatus: {},
  pluginMatchState: {},
  remoteProjectIcons: {},
  remoteAgentIcons: {},

  applySatelliteSnapshot: (satelliteId, satelliteName, snapshot) => {
    // Map projects to RemoteProject
    const projects: RemoteProject[] = (snapshot.projects || []).map((p) => ({
      ...p,
      id: namespacedProjectId(satelliteId, p.id),
      path: '__remote__',
      remote: true as const,
      satelliteId,
      satelliteName,
    }));

    // Map agents with namespaced IDs
    const newAgents: Record<string, Agent> = {};
    const agents = snapshot.agents || {};
    for (const [_projectId, projectAgents] of Object.entries(agents)) {
      for (const agent of projectAgents as Agent[]) {
        const nsId = namespacedAgentId(satelliteId, agent.id);
        newAgents[nsId] = {
          ...agent,
          id: nsId,
          projectId: namespacedProjectId(satelliteId, agent.projectId),
        };
      }
    }

    // Compute plugin match state
    const pluginMatches = snapshot.plugins
      ? computePluginMatchState(snapshot.plugins)
      : [];

    // Namespace icon data URLs
    const newProjectIcons: Record<string, string> = {};
    if (snapshot.projectIcons) {
      for (const [projId, dataUrl] of Object.entries(snapshot.projectIcons)) {
        newProjectIcons[namespacedProjectId(satelliteId, projId)] = dataUrl;
      }
    }

    const newAgentIcons: Record<string, string> = {};
    if (snapshot.agentIcons) {
      for (const [agentId, dataUrl] of Object.entries(snapshot.agentIcons)) {
        newAgentIcons[namespacedAgentId(satelliteId, agentId)] = dataUrl;
      }
    }

    // Extract detailed statuses from agentsMeta (snapshot includes current status for running agents)
    const newDetailedStatuses: Record<string, AgentDetailedStatus> = {};
    if (snapshot.agentsMeta) {
      const meta = snapshot.agentsMeta as Record<string, { detailedStatus?: AgentDetailedStatus | null }>;
      for (const [agentId, agentMeta] of Object.entries(meta)) {
        if (agentMeta.detailedStatus) {
          newDetailedStatuses[namespacedAgentId(satelliteId, agentId)] = agentMeta.detailedStatus;
        }
      }
    }

    // Merge into store (replace this satellite's data, keep others)
    set((state) => {
      // Remove old agents for this satellite
      const filteredAgents = { ...state.remoteAgents };
      for (const key of Object.keys(filteredAgents)) {
        if (key.startsWith(satellitePrefix(satelliteId))) {
          delete filteredAgents[key];
        }
      }

      // Remove old detailed statuses for this satellite and merge new ones
      const filteredStatuses = { ...state.remoteAgentDetailedStatus };
      for (const key of Object.keys(filteredStatuses)) {
        if (key.startsWith(satellitePrefix(satelliteId))) {
          delete filteredStatuses[key];
        }
      }

      // Remove old icons for this satellite
      const filteredProjectIcons = { ...state.remoteProjectIcons };
      const filteredAgentIcons = { ...state.remoteAgentIcons };
      for (const key of Object.keys(filteredProjectIcons)) {
        if (key.startsWith(satellitePrefix(satelliteId))) delete filteredProjectIcons[key];
      }
      for (const key of Object.keys(filteredAgentIcons)) {
        if (key.startsWith(satellitePrefix(satelliteId))) delete filteredAgentIcons[key];
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
        remoteAgentDetailedStatus: {
          ...filteredStatuses,
          ...newDetailedStatuses,
        },
        pluginMatchState: {
          ...state.pluginMatchState,
          [satelliteId]: pluginMatches,
        },
        remoteProjectIcons: {
          ...filteredProjectIcons,
          ...newProjectIcons,
        },
        remoteAgentIcons: {
          ...filteredAgentIcons,
          ...newAgentIcons,
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
      const newProjectIcons = { ...state.remoteProjectIcons };
      const newAgentIcons = { ...state.remoteAgentIcons };
      for (const key of Object.keys(newAgents)) {
        if (key.startsWith(satellitePrefix(satelliteId))) {
          delete newAgents[key];
          delete newStatuses[key];
        }
      }

      const newPluginMatch = { ...state.pluginMatchState };
      delete newPluginMatch[satelliteId];

      for (const key of Object.keys(newProjectIcons)) {
        if (key.startsWith(satellitePrefix(satelliteId))) delete newProjectIcons[key];
      }
      for (const key of Object.keys(newAgentIcons)) {
        if (key.startsWith(satellitePrefix(satelliteId))) delete newAgentIcons[key];
      }

      return {
        satelliteProjects: newProjects,
        remoteAgents: newAgents,
        remoteAgentDetailedStatus: newStatuses,
        pluginMatchState: newPluginMatch,
        remoteProjectIcons: newProjectIcons,
        remoteAgentIcons: newAgentIcons,
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

  updateRemoteAgentRunState: (satelliteId, agentId, status) => {
    const nsId = namespacedAgentId(satelliteId, agentId);
    set((state) => {
      const agent = state.remoteAgents[nsId];
      if (!agent) return state;
      return {
        remoteAgents: {
          ...state.remoteAgents,
          [nsId]: { ...agent, status },
        },
      };
    });
  },

  upsertRemoteAgent: (satelliteId, agent) => {
    const nsId = namespacedAgentId(satelliteId, agent.id);
    set((state) => {
      const existing = state.remoteAgents[nsId];
      if (existing) {
        // Update existing agent's run state
        return {
          remoteAgents: {
            ...state.remoteAgents,
            [nsId]: { ...existing, status: agent.status || existing.status },
          },
        };
      }
      // Add new agent — namespace its projectId
      const nsProjId = agent.projectId
        ? `remote:${satelliteId}:${agent.projectId}`
        : '';
      const newAgent: Agent = {
        id: nsId,
        projectId: nsProjId,
        name: agent.name || agent.id,
        kind: agent.kind || 'quick',
        status: agent.status || 'running',
        color: agent.color || '',
        mission: agent.mission,
        model: agent.model,
        orchestrator: agent.orchestrator,
        freeAgentMode: agent.freeAgentMode,
        parentAgentId: agent.parentAgentId,
      };
      return {
        remoteAgents: {
          ...state.remoteAgents,
          [nsId]: newAgent,
        },
      };
    });
  },

  getAllRemoteProjects: () => {
    const state = get();
    return Object.values(state.satelliteProjects).flat();
  },
}));
