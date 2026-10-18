import { create } from 'zustand';
import type { HelperDisposeRequest } from '../../shared/types';

/**
 * Helper disposes waiting on the user (#2229): an orchestrator whose control
 * level is "ask-everything" called dispose_helper. Each shows under Needs you
 * on the helper's row, with the check facts, until the user selects it or the
 * helper is gone. Nothing is disposed from here.
 * TODO(#2232): a real dispose confirmation the user can accept or decline.
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
  add: (request: HelperDisposeRequest, orchestratorName: string, at?: number) => void;
  dismiss: (helperId: string) => void;
}

export const useHelperDisposeRequestStore = create<HelperDisposeRequestState>((set) => ({
  requests: {},
  add: (request, orchestratorName, at = Date.now()) => set((s) => ({
    requests: { ...s.requests, [request.helperId]: { request, orchestratorName, at } },
  })),
  dismiss: (helperId) => set((s) => {
    if (!s.requests[helperId]) return s;
    const requests = { ...s.requests };
    delete requests[helperId];
    return { requests };
  }),
}));

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The Needs you line for a pending dispose: who asked, and what the checks found. */
export function describeHelperDispose(pending: PendingHelperDispose): string {
  const { checks, forceRequested } = pending.request;
  const facts: string[] = [];
  if (checks.dirty > 0) facts.push(plural(checks.dirty, 'uncommitted file', 'uncommitted files'));
  if (checks.unpushed > 0) facts.push(plural(checks.unpushed, 'unpushed commit', 'unpushed commits'));
  if (checks.unmerged) facts.push(plural(checks.unmerged, 'unmerged commit', 'unmerged commits'));
  if (checks.error) facts.push(checks.error);
  const what = facts.length > 0 ? facts.join(', ') : 'nothing would be lost';
  return `${pending.orchestratorName} asked to dispose this helper${forceRequested ? ' (forced)' : ''}. ${what[0].toUpperCase()}${what.slice(1)}.`;
}
