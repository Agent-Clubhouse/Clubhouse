import { create } from 'zustand';
import { reportChromeActionFailed } from './telemetry';
import { isNewChromeEnabled } from './chromeFlag';

/**
 * State for the new chrome shell. Persisted under its own key so the legacy
 * shell's `clubhouse_panel_sizes` is never touched (docs/chrome-redesign-spec.md §5).
 */
export const CHROME_STORAGE_KEY = 'clubhouse_chrome_v2';
const STORAGE_VERSION = 1;

export const SIDEBAR_MIN = 220;
export const SIDEBAR_MAX = 480;
export const SIDEBAR_DEFAULT = 264;

const PERSIST_DEBOUNCE_MS = 300;

interface PersistedChromeState {
  version: number;
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  /** The project selected most recently, restored when nothing is selected (spec §5.2). */
  lastProjectId?: string | null;
}

type PersistedFields = Pick<ChromeState, 'sidebarWidth' | 'sidebarCollapsed' | 'lastProjectId'>;

const DEFAULTS: PersistedFields = { sidebarWidth: SIDEBAR_DEFAULT, sidebarCollapsed: false, lastProjectId: null };

export interface ChromeState {
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  lastProjectId: string | null;
  resizeSidebar: (delta: number) => void;
  setLastProjectId: (projectId: string) => void;
  setSidebarWidth: (width: number) => void;
  toggleSidebar: () => void;
}

export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_DEFAULT;
  return Math.max(SIDEBAR_MIN, Math.min(Math.round(width), SIDEBAR_MAX));
}

export function loadChromeState(): PersistedFields {
  try {
    const raw = localStorage.getItem(CHROME_STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<PersistedChromeState> | null;
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULTS };
    return {
      sidebarWidth: typeof parsed.sidebarWidth === 'number' ? clampSidebarWidth(parsed.sidebarWidth) : SIDEBAR_DEFAULT,
      sidebarCollapsed: parsed.sidebarCollapsed === true,
      lastProjectId: typeof parsed.lastProjectId === 'string' ? parsed.lastProjectId : null,
    };
  } catch {
    // telemetry-exempt: read at module load, before telemetry is connected; corrupt state falls back to defaults
    return { ...DEFAULTS };
  }
}

function persistChromeState(state: PersistedFields): void {
  const payload: PersistedChromeState = {
    version: STORAGE_VERSION,
    sidebarWidth: state.sidebarWidth,
    sidebarCollapsed: state.sidebarCollapsed,
    lastProjectId: state.lastProjectId,
  };
  try {
    localStorage.setItem(CHROME_STORAGE_KEY, JSON.stringify(payload));
  } catch (err) {
    console.warn('[store:chrome] Failed to persist chrome state (quota?):', err instanceof Error ? err.message : err);
    reportChromeActionFailed('chrome_state_save', err);
  }
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;

export const useChromeStore = create<ChromeState>((set, get) => {
  const schedulePersist = () => {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      persistChromeState(get());
    }, PERSIST_DEBOUNCE_MS);
  };

  return {
    // With the flag off the legacy shell runs and this store is never used, so
    // don't touch localStorage at startup.
    ...(isNewChromeEnabled() ? loadChromeState() : DEFAULTS),

    resizeSidebar: (delta) => {
      const { sidebarWidth, sidebarCollapsed } = get();
      if (sidebarCollapsed) return;
      const next = clampSidebarWidth(sidebarWidth + delta);
      if (next === sidebarWidth) return;
      set({ sidebarWidth: next });
      schedulePersist();
    },

    setLastProjectId: (projectId) => {
      if (get().lastProjectId === projectId) return;
      set({ lastProjectId: projectId });
      schedulePersist();
    },

    setSidebarWidth: (width) => {
      set({ sidebarWidth: clampSidebarWidth(width) });
      schedulePersist();
    },

    toggleSidebar: () => {
      set({ sidebarCollapsed: !get().sidebarCollapsed });
      schedulePersist();
    },
  };
});
