import { create } from 'zustand';
import { CompletedQuickAgent } from '../../shared/types';
import {
  applyFinishedQuickAgentOp,
  MAX_FINISHED_QUICK_AGENTS,
  sanitizeFinishedQuickAgents,
  type FinishedQuickAgentOp,
  type FinishedQuickAgents,
  type FinishedQuickAgentsChange,
} from '../../shared/finished-quick-agents';
import { startMainStateSync, type MainStateApi, type MainStateSync } from '../sync/mainStateSync';
import { rendererLog } from '../plugins/renderer-logger';

const STORAGE_PREFIX = 'quick_completed_';

function storageKey(projectId: string): string {
  return `${STORAGE_PREFIX}${projectId}`;
}

function loadFromStorage(projectId: string): CompletedQuickAgent[] {
  try {
    const raw = localStorage.getItem(storageKey(projectId));
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveToStorage(projectId: string, records: CompletedQuickAgent[]): void {
  try {
    const capped = records.length > MAX_FINISHED_QUICK_AGENTS ? records.slice(0, MAX_FINISHED_QUICK_AGENTS) : records;
    localStorage.setItem(storageKey(projectId), JSON.stringify(capped));
  } catch (err) {
    console.warn('[store:quick-agent] Failed to persist completed agents to localStorage (quota?):', err instanceof Error ? err.message : err);
  }
}

/** Every project's list in localStorage: what the first window hands to main, once (#2467). */
function loadAllFromStorage(): FinishedQuickAgents {
  const out: Record<string, unknown> = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(STORAGE_PREFIX)) out[key.slice(STORAGE_PREFIX.length)] = loadFromStorage(key.slice(STORAGE_PREFIX.length));
    }
  } catch {
    // No enumerable localStorage: nothing to hand over.
  }
  return sanitizeFinishedQuickAgents(out);
}

interface QuickAgentState {
  completedAgents: Record<string, CompletedQuickAgent[]>;
  selectedCompletedId: string | null;
  loadCompleted: (projectId: string) => void;
  addCompleted: (record: CompletedQuickAgent) => void;
  dismissCompleted: (projectId: string, agentId: string) => void;
  clearCompleted: (projectId: string) => void;
  selectCompleted: (id: string | null) => void;
  /** For the main-process sync (#2467): show main's lists without sending them back. */
  replaceCompleted: (state: FinishedQuickAgents) => void;
}

export const useQuickAgentStore = create<QuickAgentState>((set, get) => {
  /**
   * Adds, dismissals and clears change the lists through the shared ops
   * (#2467): applied here at once, then sent to main, which keeps them for the
   * phone. localStorage keeps a copy for the next startup. As before, the
   * project's list is written even when the op changes nothing here, and the
   * op still goes to main, which may hold a list this window hasn't loaded.
   */
  const finishedOp = (op: FinishedQuickAgentOp) => {
    const projectId = op.type === 'add' ? op.record.projectId : op.projectId;
    const list = applyFinishedQuickAgentOp(get().completedAgents, op)[projectId] ?? [];
    saveToStorage(projectId, list);
    set((s) => ({ completedAgents: { ...s.completedAgents, [projectId]: list } }));
    finishedQuickSync?.send(op);
  };

  return {
    completedAgents: {},
    selectedCompletedId: null,

    loadCompleted: (projectId) => {
      const records = loadFromStorage(projectId);
      set((s) => ({
        completedAgents: { ...s.completedAgents, [projectId]: records },
      }));
    },

    addCompleted: (record) => finishedOp({ type: 'add', record }),

    dismissCompleted: (projectId, agentId) => finishedOp({ type: 'dismiss', projectId, agentId }),

    clearCompleted: (projectId) => finishedOp({ type: 'clear', projectId }),

    selectCompleted: (id) => set({ selectedCompletedId: id }),

    replaceCompleted: (state) => {
      const current = get().completedAgents;
      const changed = [...new Set([...Object.keys(current), ...Object.keys(state)])]
        .filter((id) => JSON.stringify(current[id] ?? []) !== JSON.stringify(state[id] ?? []));
      if (changed.length === 0) return;
      for (const id of changed) saveToStorage(id, state[id] ?? []);
      set({ completedAgents: { ...current, ...Object.fromEntries(changed.map((id) => [id, state[id] ?? []])) } });
    },
  };
});

export type FinishedQuickAgentsApi = MainStateApi<FinishedQuickAgents, FinishedQuickAgentOp>;

/** The sync with main (#2467), when this window has the bridge (not in unit tests). */
let finishedQuickSync: MainStateSync<FinishedQuickAgentOp> | null = null;

/** Start (or restart) syncing finished quick agents with main. Exported for tests; the store starts it on load. */
export function connectFinishedQuickSync(api: FinishedQuickAgentsApi | undefined): MainStateSync<FinishedQuickAgentOp> | null {
  finishedQuickSync?.stop();
  finishedQuickSync = api ? startMainStateSync(api, {
    legacy: loadAllFromStorage,
    replace: (state) => useQuickAgentStore.getState().replaceCompleted(sanitizeFinishedQuickAgents(state)),
    onError: (err) => rendererLog('store:quickAgent', 'warn', 'Finished quick agents could not sync with main', {
      meta: { error: err instanceof Error ? err.message : String(err) },
    }),
  }, applyFinishedQuickAgentOp) : null;
  return finishedQuickSync;
}

{
  const agent = (globalThis as { clubhouse?: { agent?: {
    hydrateFinishedQuick?: (legacy: FinishedQuickAgents) => Promise<FinishedQuickAgents>;
    applyFinishedQuickOp?: (clientId: string, seq: number, op: FinishedQuickAgentOp) => Promise<void>;
    onFinishedQuickChanged?: (callback: (change: FinishedQuickAgentsChange) => void) => () => void;
  } } }).clubhouse?.agent;
  connectFinishedQuickSync(agent?.hydrateFinishedQuick && agent.applyFinishedQuickOp && agent.onFinishedQuickChanged
    ? { hydrate: agent.hydrateFinishedQuick, apply: agent.applyFinishedQuickOp, onChanged: agent.onFinishedQuickChanged }
    : undefined);
}
