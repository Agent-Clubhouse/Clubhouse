import { create } from 'zustand';

const STORAGE_KEY = 'clubhouse_panel_sizes';

const EXPLORER_MIN = 140;
const EXPLORER_MAX = 400;
const EXPLORER_DEFAULT = 200;
const EXPLORER_SNAP = 60;

const ACCESSORY_MIN = 200;
const ACCESSORY_MAX = 500;
const ACCESSORY_DEFAULT = 280;
const ACCESSORY_SNAP = 80;

interface PanelState {
  explorerWidth: number;
  explorerCollapsed: boolean;
  accessoryWidth: number;
  accessoryCollapsed: boolean;

  resizeExplorer: (delta: number) => void;
  resizeAccessory: (delta: number) => void;
  toggleExplorerCollapse: () => void;
  toggleAccessoryCollapse: () => void;
}

function loadPersistedState(): Partial<Pick<PanelState, 'explorerWidth' | 'explorerCollapsed' | 'accessoryWidth' | 'accessoryCollapsed'>> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return {};
}

function persist(state: Pick<PanelState, 'explorerWidth' | 'explorerCollapsed' | 'accessoryWidth' | 'accessoryCollapsed'>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      explorerWidth: state.explorerWidth,
      explorerCollapsed: state.explorerCollapsed,
      accessoryWidth: state.accessoryWidth,
      accessoryCollapsed: state.accessoryCollapsed,
    }));
  } catch { /* ignore */ }
}

const saved = loadPersistedState();

export const usePanelStore = create<PanelState>((set, get) => ({
  explorerWidth: saved.explorerWidth ?? EXPLORER_DEFAULT,
  explorerCollapsed: saved.explorerCollapsed ?? false,
  accessoryWidth: saved.accessoryWidth ?? ACCESSORY_DEFAULT,
  accessoryCollapsed: saved.accessoryCollapsed ?? false,

  resizeExplorer: (delta) => {
    const { explorerWidth, explorerCollapsed } = get();
    if (explorerCollapsed) return;
    const newWidth = explorerWidth + delta;
    if (newWidth < EXPLORER_SNAP) {
      set({ explorerCollapsed: true });
      persist({ ...get(), explorerCollapsed: true });
    } else {
      const clamped = Math.max(EXPLORER_MIN, Math.min(newWidth, EXPLORER_MAX));
      set({ explorerWidth: clamped });
      persist({ ...get(), explorerWidth: clamped });
    }
  },

  resizeAccessory: (delta) => {
    const { accessoryWidth, accessoryCollapsed } = get();
    if (accessoryCollapsed) return;
    const newWidth = accessoryWidth + delta;
    if (newWidth < ACCESSORY_SNAP) {
      set({ accessoryCollapsed: true });
      persist({ ...get(), accessoryCollapsed: true });
    } else {
      const clamped = Math.max(ACCESSORY_MIN, Math.min(newWidth, ACCESSORY_MAX));
      set({ accessoryWidth: clamped });
      persist({ ...get(), accessoryWidth: clamped });
    }
  },

  toggleExplorerCollapse: () => {
    const collapsed = !get().explorerCollapsed;
    set({ explorerCollapsed: collapsed });
    persist({ ...get(), explorerCollapsed: collapsed });
  },

  toggleAccessoryCollapse: () => {
    const collapsed = !get().accessoryCollapsed;
    set({ accessoryCollapsed: collapsed });
    persist({ ...get(), accessoryCollapsed: collapsed });
  },
}));
