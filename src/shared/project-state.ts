/**
 * Project pins, inactive marks and activity (#2458): the chrome sidebar's idle
 * rule state, kept by main so Annex can send it to a phone and a phone can
 * change it. The renderer applies the same ops locally first, so the sidebar
 * responds at once; every op is pure, idempotent and carries its own time, so
 * main and each window reach the same state from the same ops.
 *
 * The idle rule (docs/chrome-redesign-spec.md §2, §5.4): a project is idle when
 * it is unpinned and nothing happened in it for the idle window (7 days by
 * default). Activity is an agent running or waking, a quick agent starting,
 * or the user opening one of the project's tabs; sleeping agents don't count.
 * A project the user marked inactive (#2116) is idle at once, and stays so
 * until they mark it active; new activity doesn't undo the mark, but like any
 * idle project it still shows while it is running or selected.
 */

export const DEFAULT_IDLE_DAYS = 7;
export const IDLE_DAY_CHOICES = [3, 7, 14, 30, 0] as const; // 0: never idle
const DAY_MS = 24 * 60 * 60 * 1000;

/** Activity is written at most this often per project, so a busy agent doesn't churn storage. */
export const ACTIVITY_WRITE_INTERVAL_MS = 60_000;

export interface ProjectState {
  pinnedProjectIds: string[];
  /** Projects marked inactive by the user: idle until marked active. */
  inactiveProjectIds: string[];
  /** Last activity per project id, epoch ms. */
  projectActivity: Record<string, number>;
  /** Days without activity before an unpinned project is idle; 0 is never. */
  idleDays: number;
}

export const DEFAULT_PROJECT_STATE: ProjectState = {
  pinnedProjectIds: [],
  inactiveProjectIds: [],
  projectActivity: {},
  idleDays: DEFAULT_IDLE_DAYS,
};

export type ProjectStateOp =
  | { type: 'setPinned'; projectId: string; pinned: boolean }
  /** Marking inactive is refused for a pinned project; marking active counts as activity at `at`. */
  | { type: 'setInactive'; projectId: string; inactive: boolean; at: number }
  /** Throttled to one write per ACTIVITY_WRITE_INTERVAL_MS per project. */
  | { type: 'markActivity'; projectId: string; at: number }
  /** A time only for projects with none yet, so existing projects don't start out idle. */
  | { type: 'seedActivity'; projectIds: string[]; at: number }
  | { type: 'setIdleDays'; days: number }
  /** Drop everything stored for removed projects. */
  | { type: 'forget'; projectIds: string[] };

/** What main broadcasts to the windows after a change. `acked` is the last op seq it applied from each window. */
export interface ProjectStateChange {
  state: ProjectState;
  acked: Record<string, number>;
}

/** The state after `op`. Returns `state` itself when nothing changes. */
export function applyProjectStateOp(state: ProjectState, op: ProjectStateOp): ProjectState {
  switch (op.type) {
    case 'setPinned': {
      const has = state.pinnedProjectIds.includes(op.projectId);
      if (has === op.pinned) return state;
      return { ...state, pinnedProjectIds: op.pinned ? [...state.pinnedProjectIds, op.projectId] : state.pinnedProjectIds.filter((id) => id !== op.projectId) };
    }
    case 'setInactive': {
      if (op.inactive) {
        if (state.pinnedProjectIds.includes(op.projectId) || state.inactiveProjectIds.includes(op.projectId)) return state;
        return { ...state, inactiveProjectIds: [...state.inactiveProjectIds, op.projectId] };
      }
      // Unthrottled, unlike markActivity: the user asked for it now.
      if (!state.inactiveProjectIds.includes(op.projectId) && state.projectActivity[op.projectId] === op.at) return state;
      return {
        ...state,
        inactiveProjectIds: state.inactiveProjectIds.filter((id) => id !== op.projectId),
        projectActivity: { ...state.projectActivity, [op.projectId]: op.at },
      };
    }
    case 'markActivity': {
      const last = state.projectActivity[op.projectId];
      if (last !== undefined && op.at - last < ACTIVITY_WRITE_INTERVAL_MS) return state;
      return { ...state, projectActivity: { ...state.projectActivity, [op.projectId]: op.at } };
    }
    case 'seedActivity': {
      const missing = op.projectIds.filter((id) => state.projectActivity[id] === undefined);
      if (missing.length === 0) return state;
      return { ...state, projectActivity: { ...state.projectActivity, ...Object.fromEntries(missing.map((id) => [id, op.at])) } };
    }
    case 'setIdleDays': {
      const idleDays = Math.max(0, Math.round(op.days));
      return idleDays === state.idleDays || !Number.isFinite(idleDays) ? state : { ...state, idleDays };
    }
    case 'forget': {
      const gone = new Set(op.projectIds);
      const touched = state.pinnedProjectIds.some((id) => gone.has(id)) || state.inactiveProjectIds.some((id) => gone.has(id))
        || Object.keys(state.projectActivity).some((id) => gone.has(id));
      if (!touched) return state;
      return {
        ...state,
        pinnedProjectIds: state.pinnedProjectIds.filter((id) => !gone.has(id)),
        inactiveProjectIds: state.inactiveProjectIds.filter((id) => !gone.has(id)),
        projectActivity: Object.fromEntries(Object.entries(state.projectActivity).filter(([id]) => !gone.has(id))),
      };
    }
  }
}

const stringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

const numberRecord = (value: unknown): Record<string, number> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((e): e is [string, number] => typeof e[1] === 'number' && Number.isFinite(e[1])));
};

/** Project state from untrusted JSON (a stored file, localStorage, IPC): bad fields fall back to defaults. */
export function sanitizeProjectState(value: unknown): ProjectState {
  const raw = value && typeof value === 'object' ? value as Partial<Record<keyof ProjectState, unknown>> : {};
  return {
    pinnedProjectIds: stringArray(raw.pinnedProjectIds),
    inactiveProjectIds: stringArray(raw.inactiveProjectIds),
    projectActivity: numberRecord(raw.projectActivity),
    idleDays: typeof raw.idleDays === 'number' && Number.isFinite(raw.idleDays) && raw.idleDays >= 0 ? raw.idleDays : DEFAULT_IDLE_DAYS,
  };
}

/** An op from untrusted IPC, or null when it isn't one. */
export function parseProjectStateOp(value: unknown): ProjectStateOp | null {
  if (!value || typeof value !== 'object') return null;
  const op = value as Record<string, unknown>;
  const id = typeof op.projectId === 'string' && op.projectId.length > 0;
  const at = typeof op.at === 'number' && Number.isFinite(op.at);
  const ids = Array.isArray(op.projectIds) && op.projectIds.every((p) => typeof p === 'string');
  switch (op.type) {
    case 'setPinned': return id && typeof op.pinned === 'boolean' ? { type: op.type, projectId: op.projectId as string, pinned: op.pinned } : null;
    case 'setInactive': return id && at && typeof op.inactive === 'boolean' ? { type: op.type, projectId: op.projectId as string, inactive: op.inactive, at: op.at as number } : null;
    case 'markActivity': return id && at ? { type: op.type, projectId: op.projectId as string, at: op.at as number } : null;
    case 'seedActivity': return ids && at ? { type: op.type, projectIds: op.projectIds as string[], at: op.at as number } : null;
    case 'setIdleDays': return typeof op.days === 'number' && Number.isFinite(op.days) ? { type: op.type, days: op.days } : null;
    case 'forget': return ids ? { type: op.type, projectIds: op.projectIds as string[] } : null;
    default: return null;
  }
}

export interface IdleInput {
  /** Last activity per project id. A project with none yet is treated as active (it is seeded when first seen). */
  activity: Readonly<Record<string, number>>;
  pinnedIds: readonly string[];
  /** Projects with an agent running now. */
  runningIds: ReadonlySet<string>;
  /** The selected project never hides in the idle row. */
  activeProjectId: string | null;
  idleDays: number;
  now: number;
  /** Projects marked inactive by the user. */
  inactiveIds?: readonly string[];
}

export function isProjectIdle(projectId: string, input: IdleInput): boolean {
  if (input.pinnedIds.includes(projectId) || input.runningIds.has(projectId) || input.activeProjectId === projectId) return false;
  if (input.inactiveIds?.includes(projectId)) return true;
  if (input.idleDays <= 0) return false;
  const last = input.activity[projectId];
  if (last === undefined) return false;
  return input.now - last > input.idleDays * DAY_MS;
}
