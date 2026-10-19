import { create } from 'zustand';
import type { HelperStartRequest } from '../../shared/types';

/**
 * Helper starts waiting on the user (#2234): an orchestrator whose control
 * level asks before starting called start_helper. Main holds each request
 * and sends it here; it shows under Needs you on the orchestrator's row and
 * as a pending row in its Helpers card, with Approve and Decline. Main says
 * when a request closes (answered, expired or dropped), and the renderer
 * sends back only the project and the request id.
 */
interface HelperStartRequestState {
  /** Keyed by request id. */
  requests: Record<string, HelperStartRequest>;
  add: (request: HelperStartRequest) => void;
  remove: (requestIds: readonly string[]) => void;
  /** Replace everything with main's list (on load). */
  replaceAll: (requests: readonly HelperStartRequest[]) => void;
}

export const useHelperStartRequestStore = create<HelperStartRequestState>((set) => ({
  requests: {},
  add: (request) => set((s) => ({ requests: { ...s.requests, [request.requestId]: request } })),
  remove: (requestIds) => set((s) => {
    if (!requestIds.some((id) => s.requests[id])) return s;
    const requests = { ...s.requests };
    for (const id of requestIds) delete requests[id];
    return { requests };
  }),
  replaceAll: (list) => set({ requests: Object.fromEntries(list.map((r) => [r.requestId, r])) }),
}));

/** One orchestrator's waiting starts, oldest first. */
export function startRequestsFor(requests: Readonly<Record<string, HelperStartRequest>>, orchestratorId: string): HelperStartRequest[] {
  return Object.values(requests)
    .filter((r) => r.orchestratorId === orchestratorId)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

/** Waiting starts grouped by orchestrator, oldest first in each. */
export function startRequestsByOrchestrator(requests: Readonly<Record<string, HelperStartRequest>>): Record<string, HelperStartRequest[]> {
  const out: Record<string, HelperStartRequest[]> = {};
  for (const r of Object.values(requests)) (out[r.orchestratorId] ??= []).push(r);
  for (const list of Object.values(out)) list.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  return out;
}

/** The Needs you line for an orchestrator's waiting starts. */
export function describeHelperStarts(list: readonly HelperStartRequest[]): string {
  if (list.length === 1) return `Wants to start the helper ${list[0].args.name}`;
  return `Wants to start ${list.length} helpers`;
}
