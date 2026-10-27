import type { CompletedQuickAgent } from './types';

/**
 * Finished quick agents (#2467): the start page's "Finished, waiting on you"
 * list, per project, kept by main so Annex can send it to a phone and a phone
 * can dismiss from it. The renderer applies the same ops locally first, so the
 * list responds at once; every op is pure and idempotent, so main and each
 * window reach the same lists from the same ops.
 *
 * Each project's list is newest first and keeps the latest
 * MAX_FINISHED_QUICK_AGENTS, as the renderer's localStorage copy always has.
 */

export const MAX_FINISHED_QUICK_AGENTS = 50;

/** Finished quick agents per project id, newest first. */
export type FinishedQuickAgents = Record<string, CompletedQuickAgent[]>;

export type FinishedQuickAgentOp =
  /** A quick agent exited. Ignored when its id is already in the project's list. */
  | { type: 'add'; record: CompletedQuickAgent }
  | { type: 'dismiss'; projectId: string; agentId: string }
  | { type: 'clear'; projectId: string };

/** What main broadcasts to the windows after a change. `acked` is the last op seq it applied from each window. */
export interface FinishedQuickAgentsChange {
  state: FinishedQuickAgents;
  acked: Record<string, number>;
}

/** The lists after `op`. Returns `state` itself when nothing changes. */
export function applyFinishedQuickAgentOp(state: FinishedQuickAgents, op: FinishedQuickAgentOp): FinishedQuickAgents {
  switch (op.type) {
    case 'add': {
      const list = state[op.record.projectId] ?? [];
      if (list.some((r) => r.id === op.record.id)) return state;
      return { ...state, [op.record.projectId]: [op.record, ...list].slice(0, MAX_FINISHED_QUICK_AGENTS) };
    }
    case 'dismiss': {
      const list = state[op.projectId];
      if (!list?.some((r) => r.id === op.agentId)) return state;
      return { ...state, [op.projectId]: list.filter((r) => r.id !== op.agentId) };
    }
    case 'clear': {
      if (!state[op.projectId]?.length) return state;
      return { ...state, [op.projectId]: [] };
    }
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** A finished-agent record from untrusted JSON, or null when it lacks what the list shows. */
export function sanitizeCompletedQuickAgent(value: unknown): CompletedQuickAgent | null {
  if (!isRecord(value)) return null;
  const { id, projectId, name, mission, exitCode, completedAt } = value;
  if (typeof id !== 'string' || !id || typeof projectId !== 'string' || !projectId) return null;
  if (typeof name !== 'string' || typeof mission !== 'string' || !finite(exitCode) || !finite(completedAt)) return null;
  return {
    ...(value as unknown as CompletedQuickAgent),
    summary: typeof value.summary === 'string' ? value.summary : null,
    filesModified: Array.isArray(value.filesModified) ? value.filesModified.filter((f): f is string => typeof f === 'string') : [],
  };
}

/** Lists from untrusted JSON (a stored file, localStorage, IPC): bad entries are dropped, each list is capped. */
export function sanitizeFinishedQuickAgents(value: unknown): FinishedQuickAgents {
  if (!isRecord(value)) return {};
  const out: FinishedQuickAgents = {};
  for (const [projectId, list] of Object.entries(value)) {
    if (!Array.isArray(list)) continue;
    out[projectId] = list
      .map(sanitizeCompletedQuickAgent)
      .filter((r): r is CompletedQuickAgent => r !== null && r.projectId === projectId)
      .slice(0, MAX_FINISHED_QUICK_AGENTS);
  }
  return out;
}

/** An op from untrusted IPC, or null when it isn't one. */
export function parseFinishedQuickAgentOp(value: unknown): FinishedQuickAgentOp | null {
  if (!isRecord(value)) return null;
  const projectId = typeof value.projectId === 'string' && value.projectId.length > 0 ? value.projectId : null;
  switch (value.type) {
    case 'add': {
      const record = sanitizeCompletedQuickAgent(value.record);
      return record ? { type: 'add', record } : null;
    }
    case 'dismiss':
      return projectId && typeof value.agentId === 'string' && value.agentId.length > 0
        ? { type: 'dismiss', projectId, agentId: value.agentId } : null;
    case 'clear':
      return projectId ? { type: 'clear', projectId } : null;
    default:
      return null;
  }
}
