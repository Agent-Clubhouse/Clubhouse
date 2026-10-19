import { create } from 'zustand';
import { reportChromeActionFailed } from './telemetry';
import { CHROME_STORAGE_KEY } from './storageKey';
import { isNewChromeEnabled } from './chromeFlag';
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

/** How the sidebar orders projects or agents (#2116): the user's own order, or most recent activity first. */
export type SidebarSort = 'manual' | 'recent';
export const SIDEBAR_SORTS: readonly SidebarSort[] = ['manual', 'recent'];

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
  projectSort?: SidebarSort;
  agentSort?: SidebarSort;
  /** Projects the user marked inactive: they stay in the idle section until marked active (#2116). */
  inactiveProjectIds?: string[];
  /** Last activity per agent (wake, or a turn starting), for the Recent agent order. */
  agentActivity?: Record<string, number>;
  /** Agents whose helpers the user folded away in the sidebar (#2231). Helpers start shown. */
  collapsedAgentIds?: string[];
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
export interface NewAgentRequest extends NewAgentOptions {
  kind: 'durable' | 'quick';
  /** Preselected project; otherwise the page picks the selected or last-used one. */
  projectId?: string;
  /** Bumped on every open so the form starts fresh even when it was already showing. */
  seq: number;
}

/**
 * What an opener of the New agent page can ask for (#2031; canvas uses all three).
 *
 * Contract: `onClosed` fires exactly once, after any creation in flight has
 * settled, with the new agent's id or null. `onCreated`, when the agent was
 * made, fires just before it. Leaving the page while it is creating doesn't
 * cancel the creation; the opener still hears how it ended.
 */
export interface NewAgentOptions {
  /** Called with the new agent's id once it exists, before onClosed. Not called on cancel or failure. */
  onCreated?: (agentId: string) => void;
  /** Called once when the page is gone and nothing is in flight: with the new agent's id, or null if nothing was made. */
  onClosed?: (createdAgentId: string | null) => void;
  /** After creating, stay on the view underneath instead of opening the agent. */
  stayInView?: boolean;
}

/** Pages closed from outside while creating: their onClosed waits for settleNewAgent. */
const unsettled = new WeakSet<NewAgentRequest>();

function endNewAgent(request: NewAgentRequest, inFlight: boolean, createdAgentId: string | null): void {
  if (inFlight) unsettled.add(request);
  else request.onClosed?.(createdAgentId);
}

/**
 * A New agent page that was closed or replaced while creating reports how the
 * creation ended. A no-op for a page that is still open or already settled.
 */
export function settleNewAgent(request: NewAgentRequest, createdAgentId: string | null): void {
  if (!unsettled.delete(request)) return;
  if (createdAgentId) request.onCreated?.(createdAgentId);
  request.onClosed?.(createdAgentId);
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
  /** The New agent page in the pane, while it is open. Not persisted. */
  newAgent: NewAgentRequest | null;
  /** The page is creating an agent or adding a project. */
  newAgentBusy: boolean;
  /**
   * Project and agent ids that existed when the page last went busy. Selecting
   * one that didn't (the project it added, its creating placeholder) is the
   * page's own doing and doesn't close it; anything else does (ChromeBody).
   */
  newAgentKnownIds: { projectIds: string[]; agentIds: string[] } | null;
  openNewAgent: (kind: NewAgentRequest['kind'], projectId?: string, options?: NewAgentOptions) => void;
  /**
   * Close the page. From the page itself, `createdAgentId` goes to onClosed.
   * Closed from outside while busy, onClosed waits for settleNewAgent.
   */
  closeNewAgent: (createdAgentId?: string | null) => void;
  setNewAgentBusy: (busy: boolean, known?: { projectIds: string[]; agentIds: string[] }) => void;
  /**
   * Close the page without ending it: the opener's callbacks move on with the
   * returned request (From a template… hands them to the template dialogs).
   * Refuses (null) while the page is creating, whose own settle owns them.
   */
  handOffNewAgent: () => NewAgentRequest | null;
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
  projectSort: SidebarSort;
  agentSort: SidebarSort;
  inactiveProjectIds: string[];
  agentActivity: Record<string, number>;
  collapsedAgentIds: string[];
  /** Fold or unfold the helpers nested under an agent (#2231). Shared by both sidebar layouts. */
  toggleAgentCollapsed: (agentId: string) => void;
  /** Unfold these agents' helpers, e.g. to reveal a selected helper. */
  expandAgents: (agentIds: string[]) => void;
  /** Drop per-agent state for agents that no longer exist. */
  forgetAgents: (agentIds: string[]) => void;
  setProjectSort: (sort: SidebarSort) => void;
  setAgentSort: (sort: SidebarSort) => void;
  /** Move a project to the idle section now, until it is marked active. Pinned projects can't be (unpin first). */
  markProjectInactive: (projectId: string) => void;
  /** Bring a project out of the idle section: clears a manual mark and counts as activity now. */
  markProjectActive: (projectId: string, at?: number) => void;
  /** Record activity for an agent (a wake, or a turn starting), for the Recent agent order. */
  markAgentActivity: (agentId: string, at?: number) => void;
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
  | 'projectActivity' | 'idleDays' | 'idleOpen' | 'projectSort' | 'agentSort' | 'inactiveProjectIds' | 'agentActivity' | 'collapsedAgentIds'>;

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
  projectSort: 'manual',
  agentSort: 'manual',
  inactiveProjectIds: [],
  agentActivity: {},
  collapsedAgentIds: [],
};

const sidebarSort = (value: unknown): SidebarSort => (value === 'recent' ? 'recent' : 'manual');

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
      projectSort: sidebarSort(parsed.projectSort),
      agentSort: sidebarSort(parsed.agentSort),
      inactiveProjectIds: stringArray(parsed.inactiveProjectIds),
      agentActivity: numberRecord(parsed.agentActivity),
      collapsedAgentIds: stringArray(parsed.collapsedAgentIds),
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
    projectSort: state.projectSort,
    agentSort: state.agentSort,
    inactiveProjectIds: state.inactiveProjectIds,
    agentActivity: state.agentActivity,
    collapsedAgentIds: state.collapsedAgentIds,
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
/**
 * Whether the store holds the saved state. With the new layout off it starts
 * from defaults without reading storage; the legacy agent list loads it on
 * first use (it shares collapsedAgentIds), and every change it makes loads
 * first, so a persist never overwrites the saved state with defaults.
 */
let stateLoaded = false;

export const useChromeStore = create<ChromeState>((set, get) => {
  stateLoaded = isNewChromeEnabled();
  const schedulePersist = () => {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      persistChromeState(get());
    }, PERSIST_DEBOUNCE_MS);
  };

  return {
    // With the flag off the legacy shell runs and only the agent list's fold
    // state is used (ensureChromeStateLoaded), so don't touch localStorage at startup.
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
    newAgentBusy: false,
    newAgentKnownIds: null,
    openNewAgent: (kind, projectId, options = {}) => {
      const previous = get().newAgent;
      const previousBusy = get().newAgentBusy;
      set({ newAgent: { ...options, kind, projectId, seq: (previous?.seq ?? 0) + 1 }, newAgentBusy: false, newAgentKnownIds: null });
      // A new open replaces the one showing; it ends now, or when its creation settles.
      if (previous) endNewAgent(previous, previousBusy, null);
    },
    closeNewAgent: (createdAgentId = null) => {
      const request = get().newAgent;
      if (!request) return;
      const busy = get().newAgentBusy;
      set({ newAgent: null, newAgentBusy: false, newAgentKnownIds: null });
      endNewAgent(request, busy && createdAgentId === null, createdAgentId);
    },
    handOffNewAgent: () => {
      const request = get().newAgent;
      if (!request || get().newAgentBusy) return null;
      set({ newAgent: null, newAgentBusy: false, newAgentKnownIds: null });
      return request;
    },
    setNewAgentBusy: (busy, known) => {
      if (busy && known) set({ newAgentBusy: true, newAgentKnownIds: known });
      else if (get().newAgentBusy !== busy) set({ newAgentBusy: busy });
    },
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

    setProjectSort: (sort) => {
      if (get().projectSort === sort) return;
      set({ projectSort: sort });
      schedulePersist();
    },

    setAgentSort: (sort) => {
      if (get().agentSort === sort) return;
      set({ agentSort: sort });
      schedulePersist();
    },

    markProjectInactive: (projectId) => {
      const s = get();
      if (s.pinnedProjectIds.includes(projectId) || s.inactiveProjectIds.includes(projectId)) return;
      set({ inactiveProjectIds: [...s.inactiveProjectIds, projectId] });
      schedulePersist();
    },

    markProjectActive: (projectId, at = Date.now()) => {
      const s = get();
      // Unthrottled, unlike markActivity: the user asked for it now.
      set({
        inactiveProjectIds: s.inactiveProjectIds.filter((id) => id !== projectId),
        projectActivity: { ...s.projectActivity, [projectId]: at },
      });
      schedulePersist();
    },

    markAgentActivity: (agentId, at = Date.now()) => {
      const last = get().agentActivity[agentId];
      if (last !== undefined && at - last < ACTIVITY_WRITE_INTERVAL_MS) return;
      set({ agentActivity: { ...get().agentActivity, [agentId]: at } });
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

    toggleAgentCollapsed: (agentId) => {
      ensureChromeStateLoaded();
      const current = get().collapsedAgentIds;
      set({ collapsedAgentIds: current.includes(agentId) ? current.filter((id) => id !== agentId) : [...current, agentId] });
      schedulePersist();
    },

    expandAgents: (agentIds) => {
      ensureChromeStateLoaded();
      const open = new Set(agentIds);
      const current = get().collapsedAgentIds;
      if (!current.some((id) => open.has(id))) return;
      set({ collapsedAgentIds: current.filter((id) => !open.has(id)) });
      schedulePersist();
    },

    forgetAgents: (agentIds) => {
      ensureChromeStateLoaded();
      const gone = new Set(agentIds);
      const s = get();
      const collapsedAgentIds = s.collapsedAgentIds.filter((id) => !gone.has(id));
      const hadActivity = agentIds.some((id) => id in s.agentActivity);
      if (collapsedAgentIds.length === s.collapsedAgentIds.length && !hadActivity) return;
      set({
        collapsedAgentIds,
        agentActivity: hadActivity ? Object.fromEntries(Object.entries(s.agentActivity).filter(([id]) => !gone.has(id))) : s.agentActivity,
      });
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
        ...s.inactiveProjectIds,
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
        inactiveProjectIds: s.inactiveProjectIds.filter((id) => !gone.has(id)),
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
    const chrome = useChromeStore.getState();
    if (state.agentSpawnedAt !== prev.agentSpawnedAt) {
      for (const [id, at] of Object.entries(state.agentSpawnedAt)) {
        if (prev.agentSpawnedAt[id] === at) continue;
        const projectId = state.agents[id]?.projectId;
        if (projectId) chrome.markActivity(projectId, at);
        chrome.markAgentActivity(id, at);
      }
    }
    // A turn starting is agent activity too (the Recent agent order, #2116).
    if (state.agentDetailedStatus !== prev.agentDetailedStatus) {
      for (const [id, status] of Object.entries(state.agentDetailedStatus)) {
        if (status.state === 'working' && prev.agentDetailedStatus[id]?.state !== 'working') chrome.markAgentActivity(id);
      }
    }
  });
}

/** Load the saved state into the store once, if startup skipped it (new layout off). */
export function ensureChromeStateLoaded(): void {
  if (stateLoaded) return;
  stateLoaded = true;
  useChromeStore.setState(loadChromeState());
}

/**
 * Forget the fold state of agents that leave the agent store (deleted,
 * disposed, or gone from their project on reload), so stale ids don't pile up
 * in saved state. Started by both sidebars. Returns the unsubscribe.
 */
export function syncCollapsedAgentsWithAgents(): () => void {
  return useAgentStore.subscribe((state, prev) => {
    if (state.agents === prev.agents) return;
    const { collapsedAgentIds } = useChromeStore.getState();
    if (collapsedAgentIds.length === 0) return;
    const gone = collapsedAgentIds.filter((id) => prev.agents[id] && !state.agents[id]);
    if (gone.length > 0) useChromeStore.getState().forgetAgents(gone);
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
