import { create } from 'zustand';
import { reportChromeActionFailed } from './telemetry';
import { isNewChromeEnabled } from './chromeFlag';

/**
 * State for the new chrome shell. Persisted under its own key so the legacy
 * shell's `clubhouse_panel_sizes` is never touched (docs/chrome-redesign-spec.md §5).
 */
export const CHROME_STORAGE_KEY = 'clubhouse_chrome_v2';
const STORAGE_VERSION = 2;

export const SIDEBAR_MIN = 220;
export const SIDEBAR_MAX = 480;
export const SIDEBAR_DEFAULT = 264;

const PERSIST_DEBOUNCE_MS = 300;

/** A per-project fold inside the tree: sleeping agents or finished quick agents. */
export type ProjectFold = 'sleeping' | 'finished';

interface PersistedChromeState {
  version: number;
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  /** The project selected most recently, restored when nothing is selected (spec §5.2). */
  lastProjectId?: string | null;
  pinnedProjectIds?: string[];
  collapsedProjectIds?: string[];
  /** Keys of the form `${projectId}:${fold}` that the user expanded. Folds start closed. */
  expandedFolds?: string[];
}

export interface ChromeState {
  /**
   * The project whose header is selected, which makes the project root the
   * scope (spec §4.5). Null when an agent row is the selection. Not persisted.
   */
  projectScopeId: string | null;
  setProjectScope: (projectId: string | null) => void;
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  lastProjectId: string | null;
  pinnedProjectIds: string[];
  collapsedProjectIds: string[];
  expandedFolds: string[];
  resizeSidebar: (delta: number) => void;
  setSidebarWidth: (width: number) => void;
  toggleSidebar: () => void;
  setLastProjectId: (projectId: string) => void;
  togglePinned: (projectId: string) => void;
  toggleProjectCollapsed: (projectId: string) => void;
  setProjectCollapsed: (projectId: string, collapsed: boolean) => void;
  /** Collapse every given project, or expand them all if every one is already collapsed. */
  toggleCollapseAll: (projectIds: string[]) => void;
  toggleFold: (projectId: string, fold: ProjectFold) => void;
  /** Drop pins, collapsed state and folds for projects that were removed. */
  forgetProjects: (projectIds: string[]) => void;
}

type PersistedFields = Pick<ChromeState,
  'sidebarWidth' | 'sidebarCollapsed' | 'lastProjectId' | 'pinnedProjectIds' | 'collapsedProjectIds' | 'expandedFolds'>;

const DEFAULTS: PersistedFields = {
  sidebarWidth: SIDEBAR_DEFAULT,
  sidebarCollapsed: false,
  lastProjectId: null,
  pinnedProjectIds: [],
  collapsedProjectIds: [],
  expandedFolds: [],
};

export const foldKey = (projectId: string, fold: ProjectFold) => `${projectId}:${fold}`;

const stringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

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
      pinnedProjectIds: stringArray(parsed.pinnedProjectIds),
      collapsedProjectIds: stringArray(parsed.collapsedProjectIds),
      expandedFolds: stringArray(parsed.expandedFolds),
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
    pinnedProjectIds: state.pinnedProjectIds,
    collapsedProjectIds: state.collapsedProjectIds,
    expandedFolds: state.expandedFolds,
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
    projectScopeId: null,

    setProjectScope: (projectId) => {
      if (get().projectScopeId !== projectId) set({ projectScopeId: projectId });
    },

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

    togglePinned: (projectId) => {
      const pinned = get().pinnedProjectIds;
      set({ pinnedProjectIds: pinned.includes(projectId) ? pinned.filter((id) => id !== projectId) : [...pinned, projectId] });
      schedulePersist();
    },

    toggleProjectCollapsed: (projectId) => {
      get().setProjectCollapsed(projectId, !get().collapsedProjectIds.includes(projectId));
    },

    setProjectCollapsed: (projectId, collapsed) => {
      const current = get().collapsedProjectIds;
      const has = current.includes(projectId);
      if (has === collapsed) return;
      set({ collapsedProjectIds: collapsed ? [...current, projectId] : current.filter((id) => id !== projectId) });
      schedulePersist();
    },

    toggleCollapseAll: (projectIds) => {
      const current = new Set(get().collapsedProjectIds);
      const allCollapsed = projectIds.length > 0 && projectIds.every((id) => current.has(id));
      if (allCollapsed) {
        projectIds.forEach((id) => current.delete(id));
      } else {
        projectIds.forEach((id) => current.add(id));
      }
      set({ collapsedProjectIds: [...current] });
      schedulePersist();
    },

    toggleFold: (projectId, fold) => {
      const key = foldKey(projectId, fold);
      const current = get().expandedFolds;
      set({ expandedFolds: current.includes(key) ? current.filter((k) => k !== key) : [...current, key] });
      schedulePersist();
    },

    forgetProjects: (projectIds) => {
      if (projectIds.length === 0) return;
      const gone = new Set(projectIds);
      const s = get();
      set({
        pinnedProjectIds: s.pinnedProjectIds.filter((id) => !gone.has(id)),
        collapsedProjectIds: s.collapsedProjectIds.filter((id) => !gone.has(id)),
        expandedFolds: s.expandedFolds.filter((key) => !gone.has(key.slice(0, key.lastIndexOf(':')))),
        lastProjectId: s.lastProjectId && gone.has(s.lastProjectId) ? null : s.lastProjectId,
      });
      schedulePersist();
    },
  };
});
