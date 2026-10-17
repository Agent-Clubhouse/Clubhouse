import { create } from 'zustand';
import { reportChromeActionFailed } from './telemetry';
import { isNewChromeEnabled } from './chromeFlag';
import { CHROME_STORAGE_KEY } from './storageKey';
import { useAgentStore } from '../stores/agentStore';
import { touchMru } from './titlebar/overflow';
import { ACTIVITY_WRITE_INTERVAL_MS, DEFAULT_IDLE_DAYS } from './projectActivity';

/**
 * State for the new chrome shell. Persisted under its own key so the legacy
 * shell's `clubhouse_panel_sizes` is never touched (docs/chrome-redesign-spec.md §5).
 */
export { CHROME_STORAGE_KEY };
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
  /** Per project, title-bar tab ids by most recent use: the More menu's order. */
  tabMru?: Record<string, string[]>;
  /** Last activity per project, for the idle rule (§5.4). */
  projectActivity?: Record<string, number>;
  idleDays?: number;
  idleOpen?: boolean;
}

/** Options an app view takes for one visit. */
export interface AppLaunchParams {
  /** Review: show only agents that need you, without changing the saved filter. */
  needsYouOnly?: boolean;
}

export interface AppLaunch {
  id: string;
  params: AppLaunchParams;
  seq: number;
}

/** What the New agent page opens with (#2031). */
export interface NewAgentRequest {
  kind: 'durable' | 'quick';
  /** Preselected project; otherwise the page picks the selected or last-used one. */
  projectId?: string;
  /** Bumped on every open so the form starts fresh even when it was already showing. */
  seq: number;
}

export interface ChromeState {
  /**
   * The project whose header is selected, which makes the project root the
   * scope (spec §4.5). Null when an agent row is the selection. Not persisted.
   */
  projectScopeId: string | null;
  setProjectScope: (projectId: string | null) => void;
  /** The title bar's tabs for the active project, in order, for ⌘1–9 (spec §5.3). Not persisted. */
  titleTabs: Array<{ id: string; disabled?: boolean }>;
  setTitleTabs: (tabs: Array<{ id: string; disabled?: boolean }>) => void;
  /** Set by ⌘⇧N for the start page to focus its composer, which clears it. Not persisted. */
  /** The New agent page in the pane, while it is open. Not persisted. */
  newAgent: NewAgentRequest | null;
  openNewAgent: (kind: NewAgentRequest['kind'], projectId?: string) => void;
  closeNewAgent: () => void;
  composerFocusPending: boolean;
  requestComposer: () => void;
  consumeComposerFocus: () => void;
  /**
   * The latest request to open an app view (Canvas, Review) with options for
   * that visit, such as Review's "Needs you only" from Needs you. The view reads
   * it when it mounts or when `seq` changes. Not persisted.
   */
  appLaunch: AppLaunch | null;
  launchApp: (id: string, params?: AppLaunchParams) => void;
  /**
   * The agent an app view is showing (Review's current agent), so the sidebar
   * selection follows it while that view is open. Not persisted.
   */
  appViewAgentId: string | null;
  setAppViewAgent: (agentId: string | null) => void;
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  lastProjectId: string | null;
  pinnedProjectIds: string[];
  collapsedProjectIds: string[];
  expandedFolds: string[];
  tabMru: Record<string, string[]>;
  projectActivity: Record<string, number>;
  /** Days without activity before an unpinned project folds into "N idle projects"; 0 is never. */
  idleDays: number;
  /** Whether the "N idle projects" row is expanded. */
  idleOpen: boolean;
  /** Record activity in a project: an agent ran or woke, a quick agent started, a tab opened. */
  markActivity: (projectId: string, at?: number) => void;
  /** Record a time only for projects with none yet, so existing projects don't start out idle. */
  seedActivity: (projectIds: string[], at?: number) => void;
  setIdleDays: (days: number) => void;
  toggleIdleOpen: () => void;
  /** Record a tab opened in a project, for the More menu's order. */
  touchTab: (projectId: string, tabId: string) => void;
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
  /** The same for every stored project id with a prefix: an unpaired satellite's projects. */
  forgetProjectsWithPrefix: (prefix: string) => void;
}

type PersistedFields = Pick<ChromeState,
  'sidebarWidth' | 'sidebarCollapsed' | 'lastProjectId' | 'pinnedProjectIds' | 'collapsedProjectIds' | 'expandedFolds' | 'tabMru'
  | 'projectActivity' | 'idleDays' | 'idleOpen'>;

const DEFAULTS: PersistedFields = {
  sidebarWidth: SIDEBAR_DEFAULT,
  sidebarCollapsed: false,
  lastProjectId: null,
  pinnedProjectIds: [],
  collapsedProjectIds: [],
  expandedFolds: [],
  tabMru: {},
  projectActivity: {},
  idleDays: DEFAULT_IDLE_DAYS,
  idleOpen: false,
};

const numberRecord = (value: unknown): Record<string, number> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((e): e is [string, number] => typeof e[1] === 'number' && Number.isFinite(e[1])));
};

export const foldKey = (projectId: string, fold: ProjectFold) => `${projectId}:${fold}`;

const stringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

const stringArrayRecord = (value: unknown): Record<string, string[]> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, stringArray(v)]));
};

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
      tabMru: stringArrayRecord(parsed.tabMru),
      projectActivity: numberRecord(parsed.projectActivity),
      idleDays: typeof parsed.idleDays === 'number' && parsed.idleDays >= 0 ? parsed.idleDays : DEFAULT_IDLE_DAYS,
      idleOpen: parsed.idleOpen === true,
    };
  } catch {
    // telemetry-exempt: read at module load, before telemetry is connected; corrupt state falls back to defaults
    return { ...DEFAULTS };
  }
}

function readStoredShortcuts(): unknown {
  try {
    const raw = localStorage.getItem(CHROME_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as { shortcuts?: unknown } | null)?.shortcuts : undefined;
  } catch {
    // telemetry-exempt: corrupt stored state is rewritten by this save
    return undefined;
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
    tabMru: state.tabMru,
    projectActivity: state.projectActivity,
    idleDays: state.idleDays,
    idleOpen: state.idleOpen,
  };
  try {
    // Keyboard shortcut overrides share the key but are written by their own store; keep them.
    const shortcuts = readStoredShortcuts();
    localStorage.setItem(CHROME_STORAGE_KEY, JSON.stringify(shortcuts === undefined ? payload : { ...payload, shortcuts }));
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

    titleTabs: [],
    setTitleTabs: (tabs) => {
      const current = get().titleTabs;
      const same = current.length === tabs.length && current.every((t, i) => t.id === tabs[i].id && !!t.disabled === !!tabs[i].disabled);
      if (!same) set({ titleTabs: tabs });
    },

    newAgent: null,
    openNewAgent: (kind, projectId) => set({ newAgent: { kind, projectId, seq: (get().newAgent?.seq ?? 0) + 1 } }),
    closeNewAgent: () => { if (get().newAgent) set({ newAgent: null }); },

    composerFocusPending: false,
    requestComposer: () => set({ composerFocusPending: true }),
    consumeComposerFocus: () => { if (get().composerFocusPending) set({ composerFocusPending: false }); },
    appLaunch: null,
    launchApp: (id, params = {}) => set({ appLaunch: { id, params, seq: (get().appLaunch?.seq ?? 0) + 1 } }),
    appViewAgentId: null,
    setAppViewAgent: (agentId) => { if (get().appViewAgentId !== agentId) set({ appViewAgentId: agentId }); },

    resizeSidebar: (delta) => {
      const { sidebarWidth, sidebarCollapsed } = get();
      if (sidebarCollapsed) return;
      const next = clampSidebarWidth(sidebarWidth + delta);
      if (next === sidebarWidth) return;
      set({ sidebarWidth: next });
      schedulePersist();
    },

    touchTab: (projectId, tabId) => {
      // Opening one of a project's tabs is activity (§2 idle rule).
      get().markActivity(projectId);
      const current = get().tabMru[projectId] ?? [];
      if (current[0] === tabId) return;
      set({ tabMru: { ...get().tabMru, [projectId]: touchMru(current, tabId) } });
      schedulePersist();
    },

    markActivity: (projectId, at = Date.now()) => {
      const last = get().projectActivity[projectId];
      if (last !== undefined && at - last < ACTIVITY_WRITE_INTERVAL_MS) return;
      set({ projectActivity: { ...get().projectActivity, [projectId]: at } });
      schedulePersist();
    },

    seedActivity: (projectIds, at = Date.now()) => {
      const current = get().projectActivity;
      const missing = projectIds.filter((id) => current[id] === undefined);
      if (missing.length === 0) return;
      set({ projectActivity: { ...current, ...Object.fromEntries(missing.map((id) => [id, at])) } });
      schedulePersist();
    },

    setIdleDays: (days) => {
      set({ idleDays: Math.max(0, Math.round(days)) });
      schedulePersist();
    },

    toggleIdleOpen: () => {
      set({ idleOpen: !get().idleOpen });
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

    forgetProjectsWithPrefix: (prefix) => {
      const s = get();
      const stored = [
        ...s.pinnedProjectIds,
        ...s.collapsedProjectIds,
        ...s.expandedFolds.map((key) => key.slice(0, key.lastIndexOf(':'))),
        ...(s.lastProjectId ? [s.lastProjectId] : []),
        ...Object.keys(s.tabMru),
        ...Object.keys(s.projectActivity),
      ];
      get().forgetProjects([...new Set(stored.filter((id) => id.startsWith(prefix)))]);
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
        tabMru: Object.fromEntries(Object.entries(s.tabMru).filter(([id]) => !gone.has(id))),
        projectActivity: Object.fromEntries(Object.entries(s.projectActivity).filter(([id]) => !gone.has(id))),
      });
      schedulePersist();
    },
  };
});

/**
 * Agents running or waking, and quick agents starting, are project activity
 * for the idle rule (§2). Started by ChromeBody. Returns the unsubscribe.
 */
export function syncProjectActivityWithAgents(): () => void {
  return useAgentStore.subscribe((state, prev) => {
    if (state.agentSpawnedAt === prev.agentSpawnedAt) return;
    for (const [id, at] of Object.entries(state.agentSpawnedAt)) {
      if (prev.agentSpawnedAt[id] === at) continue;
      const projectId = state.agents[id]?.projectId;
      if (projectId) useChromeStore.getState().markActivity(projectId, at);
    }
  });
}

/**
 * Whatever makes an agent active (a sidebar row, a notification, the palette,
 * switch-agent-N, a popout, the plugin API, a spawn) ends the project scope, so
 * the header highlight and the scoped tabs move to that agent (spec §4.5). A
 * header selection clears the project's active agent, so this never undoes it.
 * Started by ChromeBody, so it only runs in the new shell. Returns the unsubscribe.
 */
export function syncProjectScopeWithActiveAgent(): () => void {
  return useAgentStore.subscribe((state, prev) => {
    if (state.activeAgentId && state.activeAgentId !== prev.activeAgentId) {
      useChromeStore.getState().setProjectScope(null);
    }
  });
}
