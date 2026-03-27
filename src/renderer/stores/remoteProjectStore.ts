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

  /** Remote canvas state keyed by namespaced project ID */
  remoteCanvasState: Record<string, { canvases: unknown[]; activeCanvasId: string }>;

  /** App-level (global) canvas state keyed by satelliteId */
  remoteAppCanvasState: Record<string, { canvases: unknown[]; activeCanvasId: string }>;

  /** Remote group projects keyed by satelliteId */
  remoteGroupProjects: Record<string, unknown[]>;

  /** Remote bulletin digests keyed by "satelliteId::projectId" */
  remoteBulletinDigests: Record<string, unknown[]>;

  /** Remote group project members keyed by "satelliteId::projectId" */
  remoteGroupProjectMembers: Record<string, Array<{ agentId: string; agentName: string; status: string }>>;

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

  /** Remove a remote agent by satellite ID and original agent ID. */
  removeRemoteAgent: (satelliteId: string, agentId: string) => void;

  /** Update canvas state for a remote project. */
  updateRemoteCanvasState: (namespacedProjectId: string, state: { canvases: unknown[]; activeCanvasId: string }) => void;

  /** Update a remote group project (create/update/delete). */
  updateRemoteGroupProject: (satelliteId: string, action: string, project: unknown) => void;

  /** Add a bulletin message from a remote satellite. */
  addRemoteBulletinMessage: (satelliteId: string, projectId: string, message: unknown) => void;

  /** Set the full list of remote group projects for a satellite. */
  setRemoteGroupProjects: (satelliteId: string, projects: unknown[]) => void;

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
  /** Whether the remote plugin declares `annex` permission (defaults to false for old satellites). */
  annexEnabled: boolean;
}

/**
 * Compare satellite plugins against locally installed plugins.
 */
function computePluginMatchState(remotePlugins: SnapshotPluginSummary[]): PluginMatchResult[] {
  const localPlugins = usePluginStore.getState().plugins;

  return remotePlugins.map((remote) => {
    const annexEnabled = remote.annexEnabled ?? false;
    const local = localPlugins[remote.id];
    if (!local) {
      return {
        id: remote.id,
        name: remote.name,
        status: 'missing' as const,
        remoteVersion: remote.version,
        scope: remote.scope,
        contributes: remote.contributes,
        annexEnabled,
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
        annexEnabled,
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
      annexEnabled,
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
  remoteCanvasState: {},
  remoteAppCanvasState: {},
  remoteGroupProjects: {},
  remoteBulletinDigests: {},
  remoteGroupProjectMembers: {},

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

    // Namespace canvas state by project ID
    const newCanvasState: Record<string, { canvases: unknown[]; activeCanvasId: string }> = {};
    if (snapshot.canvasState) {
      for (const [projId, cs] of Object.entries(snapshot.canvasState)) {
        newCanvasState[namespacedProjectId(satelliteId, projId)] = cs;
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
        remoteCanvasState: {
          ...state.remoteCanvasState,
          ...newCanvasState,
        },
        remoteAppCanvasState: snapshot.appCanvasState
          ? { ...state.remoteAppCanvasState, [satelliteId]: snapshot.appCanvasState }
          : state.remoteAppCanvasState,
        remoteGroupProjects: snapshot.groupProjects
          ? { ...state.remoteGroupProjects, [satelliteId]: snapshot.groupProjects }
          : state.remoteGroupProjects,
        remoteBulletinDigests: snapshot.bulletinDigests
          ? (() => {
              const updated = { ...state.remoteBulletinDigests };
              for (const [gpId, digest] of Object.entries(snapshot.bulletinDigests!)) {
                updated[`${satelliteId}::${gpId}`] = digest as unknown[];
              }
              return updated;
            })()
          : state.remoteBulletinDigests,
        remoteGroupProjectMembers: snapshot.groupProjectMembers
          ? (() => {
              const updated = { ...state.remoteGroupProjectMembers };
              for (const [gpId, members] of Object.entries(snapshot.groupProjectMembers!)) {
                updated[`${satelliteId}::${gpId}`] = members as Array<{ agentId: string; agentName: string; status: string }>;
              }
              return updated;
            })()
          : state.remoteGroupProjectMembers,
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

      const newCanvasState = { ...state.remoteCanvasState };
      for (const key of Object.keys(newCanvasState)) {
        if (key.startsWith(satellitePrefix(satelliteId))) delete newCanvasState[key];
      }

      const newAppCanvasState = { ...state.remoteAppCanvasState };
      delete newAppCanvasState[satelliteId];

      const newGroupProjects = { ...state.remoteGroupProjects };
      delete newGroupProjects[satelliteId];

      const newBulletinDigests = { ...state.remoteBulletinDigests };
      const newGroupProjectMembers = { ...state.remoteGroupProjectMembers };
      const satPrefix = `${satelliteId}::`;
      for (const key of Object.keys(newBulletinDigests)) {
        if (key.startsWith(satPrefix)) delete newBulletinDigests[key];
      }
      for (const key of Object.keys(newGroupProjectMembers)) {
        if (key.startsWith(satPrefix)) delete newGroupProjectMembers[key];
      }

      return {
        satelliteProjects: newProjects,
        remoteAgents: newAgents,
        remoteAgentDetailedStatus: newStatuses,
        pluginMatchState: newPluginMatch,
        remoteProjectIcons: newProjectIcons,
        remoteAgentIcons: newAgentIcons,
        remoteCanvasState: newCanvasState,
        remoteAppCanvasState: newAppCanvasState,
        remoteGroupProjects: newGroupProjects,
        remoteBulletinDigests: newBulletinDigests,
        remoteGroupProjectMembers: newGroupProjectMembers,
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
        ? namespacedProjectId(satelliteId, agent.projectId)
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

  removeRemoteAgent: (satelliteId, agentId) => {
    const nsId = namespacedAgentId(satelliteId, agentId);
    set((state) => {
      const newAgents = { ...state.remoteAgents };
      delete newAgents[nsId];
      const newStatuses = { ...state.remoteAgentDetailedStatus };
      delete newStatuses[nsId];
      return {
        remoteAgents: newAgents,
        remoteAgentDetailedStatus: newStatuses,
      };
    });
  },

  updateRemoteCanvasState: (nsProjId, canvasData) => {
    set((state) => ({
      remoteCanvasState: {
        ...state.remoteCanvasState,
        [nsProjId]: canvasData,
      },
    }));
  },

  updateRemoteGroupProject: (satelliteId, action, project) => {
    set((state) => {
      const existing = [...(state.remoteGroupProjects[satelliteId] || [])];
      const gp = project as { id: string };
      if (action === 'created') {
        existing.push(project);
      } else if (action === 'updated') {
        const idx = existing.findIndex((p: any) => p.id === gp.id);
        if (idx >= 0) existing[idx] = project;
        else existing.push(project);
      } else if (action === 'deleted') {
        const idx = existing.findIndex((p: any) => p.id === gp.id);
        if (idx >= 0) existing.splice(idx, 1);
      }
      return {
        remoteGroupProjects: { ...state.remoteGroupProjects, [satelliteId]: existing },
      };
    });
  },

  addRemoteBulletinMessage: (satelliteId, projectId, _message) => {
    // A new message was posted — invalidate the cached digest so UI re-fetches
    const key = `${satelliteId}::${projectId}`;
    set((state) => {
      const newDigests = { ...state.remoteBulletinDigests };
      delete newDigests[key]; // Force re-fetch
      return { remoteBulletinDigests: newDigests };
    });
  },

  setRemoteGroupProjects: (satelliteId, projects) => {
    set((state) => ({
      remoteGroupProjects: { ...state.remoteGroupProjects, [satelliteId]: projects },
    }));
  },

  getAllRemoteProjects: () => {
    const state = get();
    return Object.values(state.satelliteProjects).flat();
  },
}));
