import { create } from 'zustand';
import type { AnnexPeerListing, AnnexSettings, AnnexStatus } from '../../shared/types';

const DEFAULT_SETTINGS: AnnexSettings = {
  enableServer: false,
  enableClient: false,
  deviceName: '',
  alias: '',
  icon: 'computer',
  color: 'indigo',
  autoReconnect: true,
};

const DEFAULT_STATUS: AnnexStatus = {
  advertising: false,
  port: 0,
  pin: '',
  connectedCount: 0,
  fingerprint: '',
  alias: '',
  icon: 'computer',
  color: 'indigo',
};

interface AnnexStoreState {
  settings: AnnexSettings;
  status: AnnexStatus;
  loadSettings: () => Promise<void>;
  saveSettings: (settings: AnnexSettings) => Promise<void>;
  loadStatus: () => Promise<void>;
  regeneratePin: () => Promise<void>;
  /** Reopens pairing after too many wrong PINs paused it. */
  allowPairingAgain: () => Promise<void>;
  purgeServerConfig: () => Promise<void>;
  /** Everything paired with this machine, phones and computers both ways. */
  peers: AnnexPeerListing[];
  loadPeers: () => Promise<void>;
  /** Removes a pairing and closes its connections. */
  removePeer: (fingerprint: string) => Promise<void>;
}

export const useAnnexStore = create<AnnexStoreState>((set) => ({
  settings: DEFAULT_SETTINGS,
  status: DEFAULT_STATUS,
  peers: [],

  loadSettings: async () => {
    try {
      const [settings, status] = await Promise.all([
        window.clubhouse.annex.getSettings(),
        window.clubhouse.annex.getStatus(),
      ]);
      set({
        settings: settings || DEFAULT_SETTINGS,
        status: status || DEFAULT_STATUS,
      });
    } catch {
      // Keep defaults
    }
  },

  saveSettings: async (settings: AnnexSettings) => {
    set({ settings });
    try {
      await window.clubhouse.annex.saveSettings(settings);
      // Status will be pushed via onStatusChanged
    } catch {
      // Revert on error
    }
  },

  loadStatus: async () => {
    try {
      const status = await window.clubhouse.annex.getStatus();
      set({ status: status || DEFAULT_STATUS });
    } catch {
      // Keep defaults
    }
  },

  regeneratePin: async () => {
    try {
      const status = await window.clubhouse.annex.regeneratePin();
      set({ status: status || DEFAULT_STATUS });
    } catch {
      // Error handled in main
    }
  },

  allowPairingAgain: async () => {
    try {
      await window.clubhouse.annex.unlockPairing();
      const status = await window.clubhouse.annex.getStatus();
      set({ status: status || DEFAULT_STATUS });
    } catch {
      // Error handled in main
    }
  },

  purgeServerConfig: async () => {
    try {
      await window.clubhouse.annex.purgeServerConfig();
      set({ settings: DEFAULT_SETTINGS, status: DEFAULT_STATUS, peers: [] });
    } catch {
      // Error handled in main
    }
  },

  loadPeers: async () => {
    try {
      const peers = await window.clubhouse.annex.listPeers();
      set({ peers: Array.isArray(peers) ? peers : [] });
    } catch {
      // Keep the current list
    }
  },

  removePeer: async (fingerprint: string) => {
    try {
      await window.clubhouse.annex.removePeer(fingerprint);
      // The fresh list arrives via onPeersChanged; drop it here too so the row goes at once.
      set((state) => ({ peers: state.peers.filter((p) => p.fingerprint !== fingerprint) }));
    } catch {
      // Error handled in main
    }
  },
}));

/** Keep `peers` fresh from main's broadcasts. */
export function subscribeAnnexPeers(): () => void {
  return window.clubhouse.annex.onPeersChanged((peers) => {
    useAnnexStore.setState({ peers });
  });
}

/** Listen for status updates pushed from main process. */
export function initAnnexListener(): () => void {
  return window.clubhouse.annex.onStatusChanged((status) => {
    useAnnexStore.setState({ status: status as AnnexStatus });
  });
}
