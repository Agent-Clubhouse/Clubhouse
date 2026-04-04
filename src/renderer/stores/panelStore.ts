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

const RAIL_MIN = 140;
const RAIL_MAX = 400;
const RAIL_DEFAULT = 200;

interface PanelState {
  explorerWidth: number;
  explorerCollapsed: boolean;
  accessoryWidth: number;
  accessoryCollapsed: boolean;
  railPinned: boolean;
  railWidth: number;

  resizeExplorer: (delta: number) => void;
  resizeAccessory: (delta: number) => void;
  toggleExplorerCollapse: () => void;
  toggleAccessoryCollapse: () => void;
  toggleRailPin: () => void;
  resizeRail: (delta: number) => void;
}

function loadPersistedState(): Partial<Pick<PanelState, 'explorerWidth' | 'explorerCollapsed' | 'accessoryWidth' | 'accessoryCollapsed' | 'railPinned' | 'railWidth'>> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return {};
}

function persist(state: Pick<PanelState, 'explorerWidth' | 'explorerCollapsed' | 'accessoryWidth' | 'accessoryCollapsed' | 'railPinned' | 'railWidth'>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      explorerWidth: state.explorerWidth,
      explorerCollapsed: state.explorerCollapsed,
      accessoryWidth: state.accessoryWidth,
      accessoryCollapsed: state.accessoryCollapsed,
      railPinned: state.railPinned,
      railWidth: state.railWidth,
    }));
  } catch { /* ignore */ }
}

const PERSIST_DEBOUNCE_MS = 300;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

const saved = loadPersistedState();

export const usePanelStore = create<PanelState>((set, get) => {

/** Debounce persist — reads latest state when the timer fires. */
function schedulePersist(): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persist(get());
  }, PERSIST_DEBOUNCE_MS);
}

return ({
  explorerWidth: saved.explorerWidth ?? EXPLORER_DEFAULT,
  explorerCollapsed: saved.explorerCollapsed ?? false,
  accessoryWidth: saved.accessoryWidth ?? ACCESSORY_DEFAULT,
  accessoryCollapsed: saved.accessoryCollapsed ?? false,
  railPinned: saved.railPinned ?? false,
  railWidth: saved.railWidth ?? RAIL_DEFAULT,

  resizeExplorer: (delta) => {
    const { explorerWidth, explorerCollapsed } = get();
    if (explorerCollapsed) return;
    const newWidth = explorerWidth + delta;
    if (newWidth < EXPLORER_SNAP) {
      set({ explorerCollapsed: true });
      schedulePersist();
    } else {
      const clamped = Math.max(EXPLORER_MIN, Math.min(newWidth, EXPLORER_MAX));
      set({ explorerWidth: clamped });
      schedulePersist();
    }
  },

  resizeAccessory: (delta) => {
    const { accessoryWidth, accessoryCollapsed } = get();
    if (accessoryCollapsed) return;
    const newWidth = accessoryWidth + delta;
    if (newWidth < ACCESSORY_SNAP) {
      set({ accessoryCollapsed: true });
      schedulePersist();
    } else {
      const clamped = Math.max(ACCESSORY_MIN, Math.min(newWidth, ACCESSORY_MAX));
      set({ accessoryWidth: clamped });
      schedulePersist();
    }
  },

  toggleExplorerCollapse: () => {
    const collapsed = !get().explorerCollapsed;
    set({ explorerCollapsed: collapsed });
    schedulePersist();
  },

  toggleAccessoryCollapse: () => {
    const collapsed = !get().accessoryCollapsed;
    set({ accessoryCollapsed: collapsed });
    schedulePersist();
  },

  toggleRailPin: () => {
    const pinned = !get().railPinned;
    set({ railPinned: pinned });
    schedulePersist();
  },

  resizeRail: (delta) => {
    const { railWidth } = get();
    const newWidth = railWidth + delta;
    const clamped = Math.max(RAIL_MIN, Math.min(newWidth, RAIL_MAX));
    set({ railWidth: clamped });
    schedulePersist();
  },
});
});
