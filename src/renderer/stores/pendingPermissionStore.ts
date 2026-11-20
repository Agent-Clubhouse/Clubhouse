import { create } from 'zustand';
import { CachedDomain, remoteProjectionMutated } from './snapshot-delta';
import type { PendingPermissionInfo, PermissionResolveOutcome } from '../../shared/permission-types';
import { isRemoteAgentId, parseNamespacedId, satellitePrefix } from './remoteProjectStore';

/**
 * Pending approve/deny requests for durable (PTY) agents.
 *
 * Durable agents raise permission requests through the hook server, which
 * parks them in the main-process queue. Until issue #1553 only a connected
 * Annex/iOS client could answer them, so requests aged out after ~110s, fell
 * back to 'ask', and re-prompted immediately — the agent looked hung. This
 * store is the renderer half of the desktop-local approve/deny path.
 */
interface PendingPermissionState {
  /** requestId → request. */
  byRequestId: Record<string, PendingPermissionInfo>;

  /** Seed from the main process (window reload, agent view mount). */
  hydrate: (permissions: PendingPermissionInfo[]) => void;
  hydrateRemote: (satelliteId: string, permissions: PendingPermissionInfo[]) => void;
  /** A new request arrived. */
  addPending: (permission: PendingPermissionInfo) => void;
  /** A request was settled — by us, by Annex, or by timeout. */
  removePending: (requestId: string) => void;
  /** Drop everything for an agent (e.g. the agent stopped). */
  clearForAgent: (agentId: string) => void;
  /** Send a decision to the main process; removes the request on success. */
  resolve: (
    agentId: string,
    requestId: string,
    decision: 'allow' | 'deny',
  ) => Promise<PermissionResolveOutcome>;
}

/** Display mutation only; host decisions and existing action gates are unchanged. */
function remotePermissionMutated(id: string): void {
  const remote = parseNamespacedId(id);
  if (remote) remoteProjectionMutated(remote.satelliteId, CachedDomain.Permissions);
}

/** Pending requests for one agent, oldest first. */
export function selectPendingForAgent(
  state: Pick<PendingPermissionState, 'byRequestId'>,
  agentId: string,
): PendingPermissionInfo[] {
  return Object.values(state.byRequestId)
    .filter((p) => p.agentId === agentId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

export const usePendingPermissionStore = create<PendingPermissionState>((set, get) => ({
  byRequestId: {},

  hydrate: (permissions) => {
    set({
      byRequestId: Object.fromEntries([
        ...Object.entries(get().byRequestId).filter(([, p]) => isRemoteAgentId(p.agentId)),
        ...permissions.map((p) => [p.requestId, p] as const),
      ]),
    });
  },

  hydrateRemote: (satelliteId, permissions) => {
    set((s) => ({
      byRequestId: Object.fromEntries([
        ...Object.entries(s.byRequestId).filter(([, p]) => !p.agentId.startsWith(satellitePrefix(satelliteId))),
        ...permissions.map((p) => [p.requestId, p] as const),
      ]),
    }));
  },

  addPending: (permission) => {
    remotePermissionMutated(permission.agentId);
    set((s) => ({ byRequestId: { ...s.byRequestId, [permission.requestId]: permission } }));
  },

  removePending: (requestId) => {
    remotePermissionMutated(requestId);
    set((s) => {
      if (!s.byRequestId[requestId]) return s;
      const next = { ...s.byRequestId };
      delete next[requestId];
      return { byRequestId: next };
    });
  },

  clearForAgent: (agentId) => {
    remotePermissionMutated(agentId);
    set((s) => {
      const next: Record<string, PendingPermissionInfo> = {};
      let changed = false;
      for (const [id, p] of Object.entries(s.byRequestId)) {
        if (p.agentId === agentId) { changed = true; continue; }
        next[id] = p;
      }
      return changed ? { byRequestId: next } : s;
    });
  },

  resolve: async (agentId, requestId, decision) => {
    const remote = parseNamespacedId(agentId);
    const request = parseNamespacedId(requestId);
    if (remote && request?.satelliteId !== remote.satelliteId) throw new Error('That request belongs to a different computer.');
    const outcome = remote
      ? await window.clubhouse.annexClient.respondPermission(remote.satelliteId, remote.agentId, request.agentId, decision)
      : await window.clubhouse.agent.resolvePendingPermission(agentId, requestId, decision);
    // Clear the prompt whether or not the decision applied: a rejected resolve
    // means the request is gone (expired/already answered) or was never ours,
    // and either way leaving a dead prompt on screen helps nobody. The main
    // process stays the sole authority on what the agent is actually told.
    get().removePending(requestId);
    return outcome;
  },
}));
