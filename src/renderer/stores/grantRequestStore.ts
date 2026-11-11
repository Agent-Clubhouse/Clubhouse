import { create } from 'zustand';
import type { GrantRequest } from '../../shared/grant-requests';
import { grantRequestActionLabels } from '../../shared/grant-requests';

/**
 * Clubhouse permission requests waiting on the user (#2970). Main holds each
 * one and sends it here; it shows under Needs you on the agent's row, and
 * selecting that opens the review dialog (`reviewing`). The Dispatcher's
 * chat dock and the agent's permissions page list them too. Main says when a request closes
 * (answered, expired or dropped).
 */
interface GrantRequestState {
  /** Keyed by request id. */
  requests: Record<string, GrantRequest>;
  /** The agent whose requests the review dialog shows. */
  reviewing: string | null;
  add: (request: GrantRequest) => void;
  remove: (requestIds: readonly string[]) => void;
  review: (agentId: string | null) => void;
}

export const useGrantRequestStore = create<GrantRequestState>((set) => ({
  requests: {},
  reviewing: null,
  add: (request) => set((s) => ({ requests: { ...s.requests, [request.requestId]: request } })),
  remove: (requestIds) => set((s) => {
    if (!requestIds.some((id) => s.requests[id])) return s;
    const requests = { ...s.requests };
    for (const id of requestIds) delete requests[id];
    // The dialog closes once its agent has nothing left waiting.
    const reviewing = s.reviewing && Object.values(requests).some((r) => r.agentId === s.reviewing) ? s.reviewing : null;
    return { requests, reviewing };
  }),
  review: (agentId) => set({ reviewing: agentId }),
}));

/** One agent's waiting requests, oldest first. */
export function grantRequestsFor(requests: Record<string, GrantRequest>, agentId: string): GrantRequest[] {
  return Object.values(requests)
    .filter((r) => r.agentId === agentId)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

/** Requests by agent, each list oldest first. */
export function grantRequestsByAgent(
  requests: Record<string, GrantRequest>,
  shownId: (agentId: string) => string = (id) => id,
): Record<string, GrantRequest[]> {
  const out: Record<string, GrantRequest[]> = {};
  for (const r of Object.values(requests)) (out[shownId(r.agentId)] ??= []).push(r);
  for (const list of Object.values(out)) list.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  return out;
}

/** The Needs you line for an agent's requests. */
export function describeGrantRequests(list: readonly GrantRequest[]): string {
  const first = list[0];
  if (!first) return 'Asks for a permission';
  const label = grantRequestActionLabels(first).join(', ');
  return list.length > 1 ? `${label} (${list.length} requests)` : label;
}
