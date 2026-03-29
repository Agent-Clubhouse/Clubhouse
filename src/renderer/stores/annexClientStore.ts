/**
 * Zustand store for Annex V2 client state (controller side).
 *
 * Manages satellite connection state and snapshots, updated via IPC events
 * from the main process.
 */
import { create } from 'zustand';
import { useRemoteProjectStore } from './remoteProjectStore';
import type { SatelliteSnapshot } from '../../shared/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SatelliteState = 'disconnected' | 'discovering' | 'connecting' | 'connected';

export interface SatelliteConnection {
  id: string;
  alias: string;
  icon: string;
  color: string;
  fingerprint: string;
  state: SatelliteState;
  host: string;
  mainPort: number;
  pairingPort: number;
  snapshot: SatelliteSnapshot | null;
  lastError: string | null;
}

// ---------------------------------------------------------------------------
// Discovered service type (mirrors main process DiscoveredService)
// ---------------------------------------------------------------------------

export interface DiscoveredService {
  fingerprint: string;
  alias: string;
  icon: string;
  color: string;
  host: string;
  mainPort: number;
  pairingPort: number;
  publicKey: string;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface AnnexClientStoreState {
  satellites: SatelliteConnection[];
  discoveredServices: DiscoveredService[];
  /** Track which satellites have paused remote control */
  satellitePaused: Record<string, boolean>;
  loadSatellites: () => Promise<void>;
  loadDiscovered: () => Promise<void>;
  pairWith: (fingerprint: string, pin: string) => Promise<{ success: boolean; error?: string }>;
  connect: (fingerprint: string, bearerToken?: string) => Promise<void>;
  disconnect: (fingerprint: string) => Promise<void>;
  forgetSatellite: (fingerprint: string) => Promise<void>;
  forgetAllSatellites: () => Promise<void>;
  retry: (fingerprint: string) => Promise<void>;
  scan: () => Promise<void>;
  sendPtyInput: (satelliteId: string, agentId: string, data: string) => Promise<void>;
  sendClipboardImage: (satelliteId: string, agentId: string, base64: string, mimeType: string) => Promise<void>;
  sendPtyResize: (satelliteId: string, agentId: string, cols: number, rows: number) => Promise<void>;
  sendAgentSpawn: (satelliteId: string, params: unknown) => Promise<void>;
  sendAgentKill: (satelliteId: string, agentId: string) => Promise<void>;
  sendAgentWake: (satelliteId: string, agentId: string, options?: { resume?: boolean; mission?: string }) => Promise<void>;
  requestPtyBuffer: (satelliteId: string, agentId: string) => Promise<string>;
  sendAgentCreateDurable: (satelliteId: string, projectId: string, params: {
    name: string; color: string; model?: string; useWorktree?: boolean;
    orchestrator?: string; freeAgentMode?: boolean; mcpIds?: string[];
  }) => Promise<unknown>;
  sendAgentDeleteDurable: (satelliteId: string, projectId: string, agentId: string, mode: string) => Promise<unknown>;
  requestWorktreeStatus: (satelliteId: string, projectId: string, agentId: string) => Promise<unknown>;
  sendAgentReorder: (satelliteId: string, projectId: string, orderedIds: string[]) => Promise<void>;
}

export const useAnnexClientStore = create<AnnexClientStoreState>((set) => ({
  satellites: [],
  discoveredServices: [],
  satellitePaused: {},

  loadSatellites: async () => {
    try {
      const satellites = await window.clubhouse.annexClient.getSatellites();
      set({ satellites });
    } catch (err) {
      console.warn('[annex-client] loadSatellites failed:', err);
    }
  },

  loadDiscovered: async () => {
    try {
      const discoveredServices = await window.clubhouse.annexClient.getDiscovered();
      set({ discoveredServices });
    } catch (err) {
      console.warn('[annex-client] loadDiscovered failed:', err);
    }
  },

  pairWith: async (fingerprint, pin) => {
    try {
      return await window.clubhouse.annexClient.pairWith(fingerprint, pin);
    } catch {
      return { success: false, error: 'IPC error' };
    }
  },

  connect: async (fingerprint, bearerToken) => {
    try {
      await window.clubhouse.annexClient.connect(fingerprint, bearerToken);
    } catch (err) {
      console.warn('[annex-client] connect failed:', fingerprint, err);
    }
  },

  disconnect: async (fingerprint) => {
    try {
      await window.clubhouse.annexClient.disconnect(fingerprint);
    } catch (err) {
      console.warn('[annex-client] disconnect failed:', fingerprint, err);
    }
  },

  forgetSatellite: async (fingerprint) => {
    try {
      await window.clubhouse.annexClient.forgetSatellite(fingerprint);
    } catch (err) {
      console.warn('[annex-client] forgetSatellite failed:', fingerprint, err);
    }
  },

  forgetAllSatellites: async () => {
    try {
      await window.clubhouse.annexClient.forgetAllSatellites();
    } catch (err) {
      console.warn('[annex-client] forgetAllSatellites failed:', err);
    }
  },

  retry: async (fingerprint) => {
    try {
      await window.clubhouse.annexClient.retry(fingerprint);
    } catch (err) {
      console.warn('[annex-client] retry failed:', fingerprint, err);
    }
  },

  scan: async () => {
    try {
      await window.clubhouse.annexClient.scan();
    } catch (err) {
      console.warn('[annex-client] scan failed:', err);
    }
  },

  sendPtyInput: async (satelliteId, agentId, data) => {
    try {
      await window.clubhouse.annexClient.ptyInput(satelliteId, agentId, data);
    } catch (err) {
      console.warn('[annex-client] sendPtyInput failed:', satelliteId, agentId, err);
    }
  },

  sendClipboardImage: async (satelliteId, agentId, base64, mimeType) => {
    try {
      await window.clubhouse.annexClient.clipboardImage(satelliteId, agentId, base64, mimeType);
    } catch (err) {
      console.warn('[annex-client] sendClipboardImage failed:', satelliteId, agentId, err);
    }
  },

  sendPtyResize: async (satelliteId, agentId, cols, rows) => {
    try {
      await window.clubhouse.annexClient.ptyResize(satelliteId, agentId, cols, rows);
    } catch (err) {
      console.warn('[annex-client] sendPtyResize failed:', satelliteId, agentId, err);
    }
  },

  sendAgentSpawn: async (satelliteId, params) => {
    try {
      await window.clubhouse.annexClient.agentSpawn(satelliteId, params);
    } catch (err) {
      console.warn('[annex-client] sendAgentSpawn failed:', satelliteId, err);
    }
  },

  sendAgentKill: async (satelliteId, agentId) => {
    try {
      await window.clubhouse.annexClient.agentKill(satelliteId, agentId);
    } catch (err) {
      console.warn('[annex-client] sendAgentKill failed:', satelliteId, agentId, err);
    }
  },

  sendAgentWake: async (satelliteId, agentId, options) => {
    try {
      await window.clubhouse.annexClient.agentWake(satelliteId, agentId, options);
    } catch (err) {
      console.warn('[annex-client] sendAgentWake failed:', satelliteId, agentId, err);
    }
  },

  requestPtyBuffer: async (satelliteId, agentId) => {
    try {
      return await window.clubhouse.annexClient.ptyGetBuffer(satelliteId, agentId);
    } catch (err) {
      console.warn('[annex-client] requestPtyBuffer failed:', satelliteId, agentId, err);
      return '';
    }
  },

  sendAgentCreateDurable: async (satelliteId, projectId, params) => {
    return window.clubhouse.annexClient.agentCreateDurable(satelliteId, projectId, params);
  },

  sendAgentDeleteDurable: async (satelliteId, projectId, agentId, mode) => {
    return window.clubhouse.annexClient.agentDeleteDurable(satelliteId, projectId, agentId, mode);
  },

  requestWorktreeStatus: async (satelliteId, projectId, agentId) => {
    return window.clubhouse.annexClient.agentWorktreeStatus(satelliteId, projectId, agentId);
  },

  sendAgentReorder: async (satelliteId, projectId, orderedIds) => {
    try {
      await window.clubhouse.annexClient.agentReorder(satelliteId, projectId, orderedIds);
    } catch (err) {
      console.warn('[annex-client] sendAgentReorder failed:', satelliteId, projectId, err);
    }
  },
}));

// ---------------------------------------------------------------------------
// Satellite PTY Data Bus — simple event emitter for forwarding pty:data events
// ---------------------------------------------------------------------------

type PtyDataListener = (satelliteId: string, agentId: string, data: string) => void;
const ptyDataListeners = new Set<PtyDataListener>();

export const satellitePtyDataBus = {
  on(listener: PtyDataListener): () => void {
    ptyDataListeners.add(listener);
    return () => { ptyDataListeners.delete(listener); };
  },
  emit(satelliteId: string, agentId: string, data: string): void {
    for (const listener of ptyDataListeners) {
      try { listener(satelliteId, agentId, data); } catch (err) {
        console.warn('[annex-client] ptyDataBus listener threw:', err);
      }
    }
  },
};

// ---------------------------------------------------------------------------
// Satellite PTY Exit Bus — forwards pty:exit events to terminal plugin listeners
// ---------------------------------------------------------------------------

type PtyExitListener = (satelliteId: string, agentId: string, exitCode: number) => void;
const ptyExitListeners = new Set<PtyExitListener>();

export const satellitePtyExitBus = {
  on(listener: PtyExitListener): () => void {
    ptyExitListeners.add(listener);
    return () => { ptyExitListeners.delete(listener); };
  },
  emit(satelliteId: string, agentId: string, exitCode: number): void {
    for (const listener of ptyExitListeners) {
      try { listener(satelliteId, agentId, exitCode); } catch (err) {
        console.warn('[annex-client] ptyExitBus listener threw:', err);
      }
    }
  },
};

/** Listen for satellite updates pushed from main process. */
export function initAnnexClientListener(): () => void {
  const unsubSatellites = window.clubhouse.annexClient.onSatellitesChanged((satellites: SatelliteConnection[]) => {
    useAnnexClientStore.setState({ satellites });
  });

  const unsubDiscovered = window.clubhouse.annexClient.onDiscoveredChanged((services: DiscoveredService[]) => {
    useAnnexClientStore.setState({ discoveredServices: services });
  });

  const unsubEvents = window.clubhouse.annexClient.onSatelliteEvent((event: { satelliteId: string; type: string; payload: unknown }) => {
    const { satelliteId, type, payload } = event;

    if (type === 'snapshot') {
      // Find satellite name from current satellites list
      const satellite = useAnnexClientStore.getState().satellites.find((s) => s.id === satelliteId);
      const satelliteName = satellite?.alias || satelliteId;
      const snap = payload as SatelliteSnapshot;
      useRemoteProjectStore.getState().applySatelliteSnapshot(
        satelliteId,
        satelliteName,
        snap,
      );
      // Sync pause state from snapshot so reconnects clear stale paused flags
      useAnnexClientStore.setState((state) => ({
        satellitePaused: { ...state.satellitePaused, [satelliteId]: !!snap.sessionPaused },
      }));
    } else if (type === 'pty:data') {
      const p = payload as { agentId: string; data: string };
      satellitePtyDataBus.emit(satelliteId, p.agentId, p.data);
    } else if (type === 'hook:event') {
      // Agent detailed status update (pre_tool, post_tool, etc.)
      const p = payload as { agentId: string; event: unknown; detailedStatus?: import('../../shared/types').AgentDetailedStatus };
      if (p.agentId && p.detailedStatus) {
        useRemoteProjectStore.getState().updateRemoteAgentStatus(
          satelliteId, p.agentId, p.detailedStatus,
        );
      }
    } else if (type === 'structured:event') {
      // Structured-mode agent status update
      const p = payload as { agentId: string; event: unknown; detailedStatus?: import('../../shared/types').AgentDetailedStatus };
      if (p.agentId && p.detailedStatus) {
        useRemoteProjectStore.getState().updateRemoteAgentStatus(
          satelliteId, p.agentId, p.detailedStatus,
        );
      }
    } else if (type === 'agent:woken') {
      // Existing agent woken — update status to 'running'
      const p = payload as { agentId?: string; id?: string };
      const agentId = p.agentId || p.id;
      if (agentId) {
        useRemoteProjectStore.getState().updateRemoteAgentRunState(satelliteId, agentId, 'running');
      }
    } else if (type === 'agent:spawned') {
      // New or existing agent spawned — upsert into remote agents
      const p = payload as {
        id?: string; agentId?: string; name?: string; kind?: string;
        status?: string; projectId?: string; prompt?: string;
        model?: string; orchestrator?: string; freeAgentMode?: boolean;
        parentAgentId?: string;
      };
      const agentId = p.id || p.agentId;
      if (agentId) {
        useRemoteProjectStore.getState().upsertRemoteAgent(satelliteId, {
          id: agentId,
          name: p.name || agentId,
          kind: (p.kind || 'quick') as import('../../shared/types').AgentKind,
          status: (p.status === 'starting' ? 'running' : p.status || 'running') as import('../../shared/types').AgentStatus,
          projectId: p.projectId || '',
          color: '',
          mission: p.prompt,
          model: p.model,
          orchestrator: p.orchestrator as import('../../shared/types').OrchestratorId | undefined,
          freeAgentMode: p.freeAgentMode,
          parentAgentId: p.parentAgentId,
        });
      }
    } else if (type === 'pty:exit' || type === 'agent:completed') {
      // Agent stopped — update status to 'sleeping'
      const p = payload as { agentId?: string; id?: string; exitCode?: number };
      const agentId = p.agentId || p.id;
      if (agentId) {
        useRemoteProjectStore.getState().updateRemoteAgentRunState(satelliteId, agentId, 'sleeping');
        satellitePtyExitBus.emit(satelliteId, agentId, p.exitCode ?? -1);
      }
    } else if (type === 'canvas:state') {
      const p = payload as { projectId?: string | null; state?: unknown; scope?: string };
      if (p.state && (p.projectId || p.scope === 'global')) {
        const isAppLevel = !p.projectId || p.scope === 'global';
        const nsProjId = isAppLevel ? '' : `remote||${satelliteId}||${p.projectId}`;
        const cs = p.state as {
          canvasId: string; views: unknown[]; viewport: unknown;
          nextZIndex: number; zoomedViewId: string | null;
          selectedViewId?: string | null; name: string;
          allCanvasTabs?: Array<{ id: string; name: string }>;
          activeCanvasId?: string;
          wireDefinitions?: Array<{
            agentId: string; targetId: string; targetKind: string; label: string;
            agentName?: string; targetName?: string; projectName?: string;
            instructions?: Record<string, string>; disabledTools?: string[];
          }>;
        };

        // Re-namespace agent/project IDs in views — the satellite stores
        // original IDs but the controller needs namespaced IDs to resolve
        // remote agents from its store.
        const namespacedViews = (cs.views as any[]).map((v: any) => {
          const patched = { ...v };
          if (patched.agentId && typeof patched.agentId === 'string' && !patched.agentId.startsWith('remote||')) {
            patched.agentId = `remote||${satelliteId}||${patched.agentId}`;
          }
          if (patched.projectId && typeof patched.projectId === 'string' && !patched.projectId.startsWith('remote||')) {
            patched.projectId = `remote||${satelliteId}||${patched.projectId}`;
          }
          if (patched.metadata && typeof patched.metadata === 'object') {
            const meta = { ...patched.metadata };
            if (meta.agentId && typeof meta.agentId === 'string' && !meta.agentId.startsWith('remote||')) {
              meta.agentId = `remote||${satelliteId}||${meta.agentId}`;
            }
            if (meta.projectId && typeof meta.projectId === 'string' && !meta.projectId.startsWith('remote||')) {
              meta.projectId = `remote||${satelliteId}||${meta.projectId}`;
            }
            if (meta.groupProjectId && typeof meta.groupProjectId === 'string' && !meta.groupProjectId.startsWith('remote||')) {
              meta.groupProjectId = `remote||${satelliteId}||${meta.groupProjectId}`;
            }
            patched.metadata = meta;
          }
          return patched;
        });

        // Re-namespace agent/target IDs in wire definitions so wires resolve
        // correctly on the controller using namespaced agent IDs.
        const namespacedWires = cs.wireDefinitions?.map((w) => {
          const patched = { ...w };
          if (patched.agentId && !patched.agentId.startsWith('remote||')) {
            patched.agentId = `remote||${satelliteId}||${patched.agentId}`;
          }
          if (patched.targetId && !patched.targetId.startsWith('remote||')) {
            patched.targetId = `remote||${satelliteId}||${patched.targetId}`;
          }
          return patched;
        });

        // Helper to route canvas data to the correct store based on scope
        const commitCanvasData = (data: { canvases: unknown[]; activeCanvasId: string; wireDefinitions?: unknown[] }) => {
          if (isAppLevel) {
            useRemoteProjectStore.getState().updateRemoteAppCanvasState(satelliteId, data);
          } else {
            useRemoteProjectStore.getState().updateRemoteCanvasState(nsProjId, data);
          }
        };

        const existingStore = isAppLevel
          ? useRemoteProjectStore.getState().remoteAppCanvasState[satelliteId]
          : useRemoteProjectStore.getState().remoteCanvasState[nsProjId];
        const existing = existingStore as { canvases: any[]; activeCanvasId: string; wireDefinitions?: unknown[] } | undefined;

        if (cs.allCanvasTabs) {
          // Full tab metadata available — build complete canvas list.
          // Use full data for the canvas that changed, stub data for others.
          const canvases = cs.allCanvasTabs.map((tab) => {
            if (tab.id === cs.canvasId) {
              return {
                id: cs.canvasId,
                name: cs.name,
                views: namespacedViews,
                viewport: cs.viewport,
                nextZIndex: cs.nextZIndex,
                zoomedViewId: cs.zoomedViewId,
                selectedViewId: cs.selectedViewId ?? null,
              };
            }
            // Preserve existing data for other tabs if we have it
            const prev = existing?.canvases?.find((c: any) => c.id === tab.id);
            return prev || { id: tab.id, name: tab.name, views: [], viewport: { panX: 0, panY: 0, zoom: 1 }, nextZIndex: 0, zoomedViewId: null, selectedViewId: null };
          });
          commitCanvasData({
            canvases,
            activeCanvasId: cs.activeCanvasId || cs.canvasId,
            wireDefinitions: namespacedWires,
          });
        } else if (existing) {
          // No tab metadata — merge single canvas into existing state
          const canvases = [...(existing.canvases as any[])];
          const idx = canvases.findIndex((c: any) => c.id === cs.canvasId);
          const updated = {
            id: cs.canvasId, name: cs.name, views: namespacedViews,
            viewport: cs.viewport, nextZIndex: cs.nextZIndex,
            zoomedViewId: cs.zoomedViewId,
            selectedViewId: cs.selectedViewId ?? null,
          };
          if (idx >= 0) {
            canvases[idx] = updated;
          } else {
            canvases.push(updated);
          }
          commitCanvasData({
            canvases,
            activeCanvasId: existing.activeCanvasId,
            wireDefinitions: namespacedWires ?? existing.wireDefinitions,
          });
        } else {
          // First canvas state for this project/app
          commitCanvasData({
            canvases: [{
              id: cs.canvasId, name: cs.name, views: namespacedViews,
              viewport: cs.viewport, nextZIndex: cs.nextZIndex,
              zoomedViewId: cs.zoomedViewId,
              selectedViewId: cs.selectedViewId ?? null,
            }],
            activeCanvasId: cs.canvasId,
            wireDefinitions: namespacedWires,
          });
        }
      }
    } else if (type === 'session:paused') {
      useAnnexClientStore.setState((state) => ({
        satellitePaused: { ...state.satellitePaused, [satelliteId]: true },
      }));
    } else if (type === 'session:resumed') {
      useAnnexClientStore.setState((state) => ({
        satellitePaused: { ...state.satellitePaused, [satelliteId]: false },
      }));
    } else if (type === 'group-project:changed') {
      const p = payload as { action?: string; project?: unknown };
      if (p.action && p.project) {
        useRemoteProjectStore.getState().updateRemoteGroupProject(satelliteId, p.action as string, p.project);
      }
    } else if (type === 'bulletin:message') {
      const p = payload as { projectId?: string; message?: unknown };
      if (p.projectId && p.message) {
        useRemoteProjectStore.getState().addRemoteBulletinMessage(satelliteId, p.projectId, p.message);
      }
    } else if (type === 'group-project:list') {
      const p = payload as { projects?: unknown[] };
      if (p.projects) {
        useRemoteProjectStore.getState().setRemoteGroupProjects(satelliteId, p.projects);
      }
    }
  });

  return () => {
    unsubSatellites();
    unsubDiscovered();
    unsubEvents();
  };
}
