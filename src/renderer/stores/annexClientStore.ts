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
    } catch {
      // Keep empty
    }
  },

  loadDiscovered: async () => {
    try {
      const discoveredServices = await window.clubhouse.annexClient.getDiscovered();
      set({ discoveredServices });
    } catch {
      // Keep empty
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
    } catch { /* ignore */ }
  },

  disconnect: async (fingerprint) => {
    try {
      await window.clubhouse.annexClient.disconnect(fingerprint);
    } catch { /* ignore */ }
  },

  forgetSatellite: async (fingerprint) => {
    try {
      await window.clubhouse.annexClient.forgetSatellite(fingerprint);
    } catch { /* ignore */ }
  },

  forgetAllSatellites: async () => {
    try {
      await window.clubhouse.annexClient.forgetAllSatellites();
    } catch { /* ignore */ }
  },

  retry: async (fingerprint) => {
    try {
      await window.clubhouse.annexClient.retry(fingerprint);
    } catch { /* ignore */ }
  },

  scan: async () => {
    try {
      await window.clubhouse.annexClient.scan();
    } catch { /* ignore */ }
  },

  sendPtyInput: async (satelliteId, agentId, data) => {
    try {
      await window.clubhouse.annexClient.ptyInput(satelliteId, agentId, data);
    } catch { /* ignore */ }
  },

  sendClipboardImage: async (satelliteId, agentId, base64, mimeType) => {
    try {
      await window.clubhouse.annexClient.clipboardImage(satelliteId, agentId, base64, mimeType);
    } catch { /* ignore */ }
  },

  sendPtyResize: async (satelliteId, agentId, cols, rows) => {
    try {
      await window.clubhouse.annexClient.ptyResize(satelliteId, agentId, cols, rows);
    } catch { /* ignore */ }
  },

  sendAgentSpawn: async (satelliteId, params) => {
    try {
      await window.clubhouse.annexClient.agentSpawn(satelliteId, params);
    } catch { /* ignore */ }
  },

  sendAgentKill: async (satelliteId, agentId) => {
    try {
      await window.clubhouse.annexClient.agentKill(satelliteId, agentId);
    } catch { /* ignore */ }
  },

  sendAgentWake: async (satelliteId, agentId, options) => {
    try {
      await window.clubhouse.annexClient.agentWake(satelliteId, agentId, options);
    } catch { /* ignore */ }
  },

  requestPtyBuffer: async (satelliteId, agentId) => {
    try {
      return await window.clubhouse.annexClient.ptyGetBuffer(satelliteId, agentId);
    } catch {
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
    } catch { /* ignore */ }
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
      try { listener(satelliteId, agentId, data); } catch { /* ignore */ }
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
      try { listener(satelliteId, agentId, exitCode); } catch { /* ignore */ }
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
      useRemoteProjectStore.getState().applySatelliteSnapshot(
        satelliteId,
        satelliteName,
        payload as SatelliteSnapshot,
      );
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
      const p = payload as { projectId?: string; state?: unknown };
      if (p.projectId && p.state) {
        const nsProjId = `remote||${satelliteId}||${p.projectId}`;
        const cs = p.state as { canvasId: string; views: unknown[]; viewport: unknown; nextZIndex: number; zoomedViewId: string | null; name: string };
        // Update the canvas state for this remote project — store a single-canvas
        // snapshot so the canvas plugin can hydrate from it
        useRemoteProjectStore.getState().updateRemoteCanvasState(nsProjId, {
          canvases: [{
            id: cs.canvasId,
            name: cs.name,
            views: cs.views,
            viewport: cs.viewport,
            nextZIndex: cs.nextZIndex,
            zoomedViewId: cs.zoomedViewId,
          }],
          activeCanvasId: cs.canvasId,
        });
      }
    } else if (type === 'session:paused') {
      useAnnexClientStore.setState((state) => ({
        satellitePaused: { ...state.satellitePaused, [satelliteId]: true },
      }));
    } else if (type === 'session:resumed') {
      useAnnexClientStore.setState((state) => ({
        satellitePaused: { ...state.satellitePaused, [satelliteId]: false },
      }));
    }
  });

  return () => {
    unsubSatellites();
    unsubDiscovered();
    unsubEvents();
  };
}
