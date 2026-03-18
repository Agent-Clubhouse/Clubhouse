/**
 * Zustand store for Annex V2 client state (controller side).
 *
 * Manages satellite connection state and snapshots, updated via IPC events
 * from the main process.
 */
import { create } from 'zustand';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SatelliteState = 'disconnected' | 'discovering' | 'connecting' | 'connected';

export interface SatelliteSnapshot {
  projects: unknown[];
  agents: Record<string, unknown[]>;
  quickAgents: Record<string, unknown[]>;
  theme: unknown;
  orchestrators: unknown;
  pendingPermissions: unknown[];
  lastSeq: number;
  plugins?: unknown[];
  protocolVersion?: number;
}

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
// Store
// ---------------------------------------------------------------------------

interface AnnexClientStoreState {
  satellites: SatelliteConnection[];
  loadSatellites: () => Promise<void>;
  connect: (fingerprint: string, bearerToken?: string) => Promise<void>;
  disconnect: (fingerprint: string) => Promise<void>;
  retry: (fingerprint: string) => Promise<void>;
  scan: () => Promise<void>;
  sendPtyInput: (satelliteId: string, agentId: string, data: string) => Promise<void>;
  sendPtyResize: (satelliteId: string, agentId: string, cols: number, rows: number) => Promise<void>;
  sendAgentSpawn: (satelliteId: string, params: unknown) => Promise<void>;
  sendAgentKill: (satelliteId: string, agentId: string) => Promise<void>;
}

export const useAnnexClientStore = create<AnnexClientStoreState>((set) => ({
  satellites: [],

  loadSatellites: async () => {
    try {
      const satellites = await window.clubhouse.annexClient.getSatellites();
      set({ satellites });
    } catch {
      // Keep empty
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
}));

/** Listen for satellite updates pushed from main process. */
export function initAnnexClientListener(): () => void {
  const unsubSatellites = window.clubhouse.annexClient.onSatellitesChanged((satellites) => {
    useAnnexClientStore.setState({ satellites });
  });

  const unsubEvents = window.clubhouse.annexClient.onSatelliteEvent((event) => {
    // Satellite events can be handled by other stores/components
    // For now, just log them for debugging
  });

  return () => {
    unsubSatellites();
    unsubEvents();
  };
}
