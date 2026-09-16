import { create } from 'zustand';
import type { GoobersConnectionState } from '../../shared/goobers-types';

export function isGoobersConnectionState(v: unknown): v is GoobersConnectionState {
  return typeof v === 'object' && v !== null && 'connection' in v && 'daemon' in v;
}

interface GoobersStoreState {
  state: GoobersConnectionState | null;
  loaded: boolean;
  loadError: string | null;
  loadState: () => Promise<void>;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
}

export const useGoobersStore = create<GoobersStoreState>((set) => ({
  state: null,
  loaded: false,
  loadError: null,

  loadState: async () => {
    try {
      const raw = await window.clubhouse.goobers.getState();
      if (isGoobersConnectionState(raw)) {
        set({ state: raw, loaded: true, loadError: null });
      } else {
        set({ loaded: true, loadError: 'goobers:get-state returned an unrecognized shape' });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[goobers] loadState failed:', message);
      set({ loaded: true, loadError: message });
    }
  },

  connect: async () => {
    const raw = await window.clubhouse.goobers.connect();
    if (isGoobersConnectionState(raw)) {
      set({ state: raw });
    }
  },

  disconnect: async () => {
    await window.clubhouse.goobers.disconnect();
  },
}));

/** Initialize listener for Goobers connection-state broadcasts from main. */
export function initGoobersListener(): () => void {
  return window.clubhouse.goobers.onStateChanged((state) => {
    if (isGoobersConnectionState(state)) {
      useGoobersStore.setState({ state });
    }
  });
}
