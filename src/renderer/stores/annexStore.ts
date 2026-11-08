import { create } from 'zustand';
import type { AnnexDevice, AnnexPeerListing, AnnexSettings, AnnexStatus } from '../../shared/types';

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
  /** Every paired device, whichever way it's paired, with where it stands (#3057). */
  devices: AnnexDevice[];
  loadDevices: () => Promise<void>;
  /** Removes a device and ends its connections at once, whichever way it's paired. */
  removeDevice: (fingerprint: string) => Promise<void>;
  /** Renames a network member everywhere (#3067). */
  renameDevice: (fingerprint: string, name: string) => Promise<boolean>;
}

export const useAnnexStore = create<AnnexStoreState>((set) => ({
  settings: DEFAULT_SETTINGS,
  status: DEFAULT_STATUS,
  peers: [],
  devices: [],

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
      set({ status: DEFAULT_STATUS, peers: [], devices: [] });
      // Main keeps the names through a reset, so show what it saved rather than blank defaults.
      const settings = await window.clubhouse.annex.getSettings();
      set({ settings: settings ? { ...DEFAULT_SETTINGS, ...settings } : DEFAULT_SETTINGS });
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

  renameDevice: async (fingerprint: string, name: string) => {
    try {
      const ok = await window.clubhouse.annex.renameDevice(fingerprint, name);
      if (!ok) return false;
      // The fresh list arrives via onDevicesChanged; show the name at once.
      set((state) => ({ devices: state.devices.map((d) => (d.fingerprint === fingerprint ? { ...d, alias: name } : d)) }));
      return true;
    } catch {
      return false;
    }
  },

  loadDevices: async () => {
    try {
      const devices = await window.clubhouse.annex.listDevices();
      set({ devices: Array.isArray(devices) ? devices : [] });
    } catch {
      // Keep the current list
    }
  },

  removeDevice: async (fingerprint: string) => {
    try {
      await window.clubhouse.annex.removeDevice(fingerprint);
      // The fresh list arrives via onDevicesChanged; drop it here too so the row goes at once.
      set((state) => ({
        devices: state.devices.filter((d) => d.fingerprint !== fingerprint),
        peers: state.peers.filter((p) => p.fingerprint !== fingerprint),
      }));
    } catch {
      // Error handled in main
    }
  },
}));

/** Keep `devices` fresh from main's broadcasts. */
export function subscribeAnnexDevices(): () => void {
  return window.clubhouse.annex.onDevicesChanged((devices) => {
    useAnnexStore.setState({ devices });
  });
}

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
