/**
 * Where Actions keep their data (#2958), in the app's user data folder:
 *
 * - actions.json: the actions, plus the engine's next schedule times and
 *   pending waits, so a restart catches up and re-checks.
 * - action-history.json: run history. Each action keeps at most 10 runs within
 *   72 hours. This is Actions' own small store, independent of the telemetry
 *   record (#2920), which can read from it later (decision recorded on #2918).
 */

import {
  ACTION_STEP_KINDS,
  trimHistory,
  type Action,
  type ActionRun,
} from '../../../shared/actions';
import { validateActionInput } from '../../../shared/actions/validate';
import { appLog } from '../log-service';
import { backupUnreadableSettings, createSettingsStore } from '../settings-store';
import type { EngineState, EngineStorage, PersistedWait, RunHistory } from './engine';

interface StoredActions {
  version: 1;
  actions: Action[];
  state: EngineState;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Keep only actions that still validate; a bad record is dropped, not fatal. */
export function sanitizeActions(raw: unknown): Action[] {
  if (!Array.isArray(raw)) return [];
  const out: Action[] = [];
  for (const item of raw) {
    if (!isObject(item) || typeof item.id !== 'string' || !isObject(item.owner)) continue;
    const valid = validateActionInput(item, { allowPastEndsAt: true });
    if (!valid.ok) continue;
    const owner = item.owner as Action['owner'];
    if (!['user', 'dispatcher', 'agent', 'app'].includes(owner.kind)) continue;
    if (owner.kind === 'agent' && typeof owner.agentId !== 'string') continue;
    out.push({
      id: item.id,
      name: valid.value.name ?? 'Action',
      trigger: valid.value.trigger,
      steps: valid.value.steps,
      overlap: valid.value.overlap,
      owner,
      enabled: valid.value.enabled,
      ...(valid.value.endsAt !== undefined && { endsAt: valid.value.endsAt }),
      ...(valid.value.maxRuns !== undefined && { maxRuns: valid.value.maxRuns }),
      ...(typeof item.runsUsed === 'number' && Number.isSafeInteger(item.runsUsed) && item.runsUsed >= 0 && { runsUsed: item.runsUsed }),
      ...(typeof item.offReason === 'string' && { offReason: item.offReason }),
      ...(typeof item.problem === 'string' && { problem: item.problem }),
      createdAt: typeof item.createdAt === 'number' ? item.createdAt : 0,
      updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : 0,
    });
  }
  return out;
}

function sanitizeState(raw: unknown): EngineState {
  const state: EngineState = { nextAt: {}, waits: [] };
  if (!isObject(raw)) return state;
  if (isObject(raw.nextAt)) {
    for (const [id, at] of Object.entries(raw.nextAt)) if (typeof at === 'number' && Number.isFinite(at)) state.nextAt[id] = at;
  }
  if (Array.isArray(raw.waits)) {
    for (const w of raw.waits) {
      if (!isObject(w) || typeof w.actionId !== 'string' || typeof w.dueAt !== 'number' || typeof w.startedAt !== 'number') continue;
      const wait: PersistedWait = {
        actionId: w.actionId,
        startedAt: w.startedAt,
        dueAt: w.dueAt,
        chain: Array.isArray(w.chain) ? w.chain.filter((c): c is string => typeof c === 'string') : [],
        detail: typeof w.detail === 'string' ? w.detail : '',
        ...(typeof w.agentId === 'string' && { agentId: w.agentId }),
      };
      state.waits.push(wait);
    }
  }
  return state;
}

const actionsStore = createSettingsStore<StoredActions>(
  'actions.json',
  { version: 1, actions: [], state: { nextAt: {}, waits: [] } },
  (raw) => ({ version: 1, actions: sanitizeActions(raw.actions), state: sanitizeState(raw.state) }),
  {
    atomic: true,
    // A file that exists but can't be read loads as no actions, and the next
    // save would replace it. Keep a copy beside it first (#3025).
    onLoad: (result) => {
      if (!('error' in result) || (result.error as NodeJS.ErrnoException)?.code === 'ENOENT') return;
      try {
        backupUnreadableSettings('actions.json');
      } catch (err) {
        // telemetry-exempt: the settings store already records the reset to defaults
        appLog('core:actions', 'error', 'Could not keep a copy of the unreadable actions file', { meta: { error: err instanceof Error ? err.message : String(err) } });
      }
    },
  },
);

function logSaveError(what: string) {
  return (err: unknown) => {
    // telemetry-exempt: logged; the in-memory copy stays and the next change saves again
    appLog('core:actions', 'error', `Failed to save ${what}`, { meta: { error: err instanceof Error ? err.message : String(err) } });
  };
}

/** The real storage: writes are queued by the settings store, in order. */
export function createActionsStorage(): EngineStorage {
  let current = actionsStore.get();
  return {
    load: () => {
      current = actionsStore.get();
      return { actions: current.actions, state: current.state };
    },
    saveActions: (actions) => {
      current = { ...current, actions };
      actionsStore.save(current).catch(logSaveError('actions'));
    },
    saveState: (state) => {
      current = { ...current, state };
      actionsStore.save(current).catch(logSaveError('action state'));
    },
  };
}

// ── History ─────────────────────────────────────────────────────────────────

interface StoredHistory {
  version: 1;
  runs: Record<string, ActionRun[]>;
}

function sanitizeRun(raw: unknown): ActionRun | null {
  if (!isObject(raw) || typeof raw.id !== 'string' || typeof raw.actionId !== 'string' || typeof raw.startedAt !== 'number') return null;
  if (!isObject(raw.trigger) || typeof raw.trigger.kind !== 'string' || typeof raw.trigger.at !== 'number') return null;
  const outcomes = ['running', 'done', 'failed', 'cancelled', 'skipped'];
  if (typeof raw.outcome !== 'string' || !outcomes.includes(raw.outcome)) return null;
  const steps = Array.isArray(raw.steps)
    ? raw.steps.filter((s): s is ActionRun['steps'][number] => isObject(s) && ACTION_STEP_KINDS.includes(s.kind as never) && (s.outcome === 'done' || s.outcome === 'failed') && typeof s.detail === 'string')
    : [];
  return {
    id: raw.id,
    actionId: raw.actionId,
    trigger: raw.trigger as unknown as ActionRun['trigger'],
    chain: Array.isArray(raw.chain) ? raw.chain.filter((c): c is string => typeof c === 'string') : [],
    startedAt: raw.startedAt,
    ...(typeof raw.endedAt === 'number' && { endedAt: raw.endedAt }),
    outcome: raw.outcome as ActionRun['outcome'],
    ...(typeof raw.reason === 'string' && { reason: raw.reason }),
    steps,
  };
}

/**
 * A run still marked running when the app starts didn't finish: Clubhouse
 * closed during it.
 */
export function settleInterruptedRuns(runs: ActionRun[]): ActionRun[] {
  return runs.map((r) => r.outcome === 'running'
    ? { ...r, outcome: 'cancelled' as const, endedAt: r.endedAt ?? r.startedAt, reason: 'Clubhouse closed before it finished' }
    : r);
}

const historyStore = createSettingsStore<StoredHistory>(
  'action-history.json',
  { version: 1, runs: {} },
  (raw) => {
    const runs: Record<string, ActionRun[]> = {};
    if (isObject(raw.runs)) {
      for (const [id, list] of Object.entries(raw.runs)) {
        if (!Array.isArray(list)) continue;
        const clean = list.map(sanitizeRun).filter((r): r is ActionRun => !!r);
        if (clean.length) runs[id] = settleInterruptedRuns(clean);
      }
    }
    return { version: 1, runs };
  },
  { atomic: true },
);

/** How long to gather history writes into one save. */
const HISTORY_SAVE_DELAY_MS = 500;

export function createRunHistory(now: () => number = Date.now): RunHistory & { flush(): Promise<void> } {
  const runs = new Map<string, ActionRun[]>(Object.entries(historyStore.get().runs));
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastSave: Promise<void> = Promise.resolve();

  const save = (): Promise<void> => {
    timer = null;
    const t = now();
    const out: Record<string, ActionRun[]> = {};
    for (const [id, list] of runs) {
      const kept = trimHistory(list, t);
      if (kept.length) out[id] = kept;
      else runs.delete(id);
    }
    lastSave = historyStore.save({ version: 1, runs: out }).catch(logSaveError('action history'));
    return lastSave;
  };

  return {
    put(run) {
      const copy: ActionRun = { ...run, steps: run.steps.map((s) => ({ ...s })), chain: [...run.chain] };
      const list = (runs.get(run.actionId) ?? []).filter((r) => r.id !== run.id);
      list.push(copy);
      runs.set(run.actionId, trimHistory(list, now()));
      if (!timer) timer = setTimeout(() => { void save(); }, HISTORY_SAVE_DELAY_MS);
    },
    list(actionId) {
      return trimHistory(runs.get(actionId) ?? [], now()).map((r) => ({ ...r, steps: [...r.steps], chain: [...r.chain] }));
    },
    flush() {
      if (timer) { clearTimeout(timer); return save(); }
      return lastSave;
    },
  };
}
