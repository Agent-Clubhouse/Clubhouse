import { create } from 'zustand';
import type { HelperDisposeRequest } from '../../shared/types';
import { describeHelperDisposeRequest } from '../../shared/helper-request-copy';

/**
 * Helper disposes waiting on the user (#2229): an orchestrator whose control
 * level is "ask-everything" called dispose_helper. Each shows under Needs you
 * on the helper's row, with the check facts. Selecting it opens the dispose
 * confirmation (#2232), where the user disposes or declines; either way the
 * request is then dismissed. Nothing is disposed from here.
 */
export interface PendingHelperDispose {
  request: HelperDisposeRequest;
  orchestratorName: string;
  /** When it arrived, for Needs you ordering. */
  at: number;
}

interface HelperDisposeRequestState {
  /** Keyed by helper id; a newer request for the same helper replaces the older one. */
  requests: Record<string, PendingHelperDispose>;
  /** The helper whose request the dispose confirmation shows (#2232), or null. */
  reviewing: string | null;
  add: (request: HelperDisposeRequest, orchestratorName: string, at?: number) => void;
  dismiss: (helperId: string) => void;
  /** Open the dispose confirmation for a pending request. */
  review: (helperId: string) => void;
}

export const useHelperDisposeRequestStore = create<HelperDisposeRequestState>((set) => ({
  requests: {},
  reviewing: null,
  add: (request, orchestratorName, at = Date.now()) => set((s) => ({
    requests: { ...s.requests, [request.helperId]: { request, orchestratorName, at } },
  })),
  dismiss: (helperId) => set((s) => {
    if (!s.requests[helperId]) return s.reviewing === helperId ? { reviewing: null } : s;
    const requests = { ...s.requests };
    delete requests[helperId];
    return { requests, reviewing: s.reviewing === helperId ? null : s.reviewing };
  }),
  review: (helperId) => set((s) => (s.requests[helperId] ? { reviewing: helperId } : s)),
}));

/** The Needs you line for a pending dispose: who asked, and what the checks found. */
export function describeHelperDispose(pending: PendingHelperDispose): string {
  return describeHelperDisposeRequest(pending.orchestratorName, pending.request);
}
