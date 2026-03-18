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

/** Listen for satellite updates pushed from main process. */
export function initAnnexClientListener(): () => void {
  const unsubSatellites = window.clubhouse.annexClient.onSatellitesChanged((satellites: SatelliteConnection[]) => {
    useAnnexClientStore.setState({ satellites });
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
    }
  });

  return () => {
    unsubSatellites();
    unsubEvents();
  };
}
