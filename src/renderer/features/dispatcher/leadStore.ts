import { useEffect, useMemo } from 'react';
import { create } from 'zustand';
import type { Agent } from '../../../shared/types';
import type { MobileGrantRequest } from '../../../shared/mobile-control';
import type { DesktopPendingGrantRequest } from '../../../shared/grant-requests';
import { connectionApprovalInvolves, connectionApprovalView } from '../../../shared/approval-routing';
import type { DispatcherLeadState } from '../../../shared/dispatcher-lead';
import { DISPATCHER_PROJECT_ID } from '../../../shared/dispatcher-types';
import { useAnnexClientStore } from '../../stores/annexClientStore';
import { namespacedAgentId, namespacedProjectId, useRemoteProjectStore } from '../../stores/remoteProjectStore';
import { rendererLog } from '../../plugins/renderer-logger';

/**
 * The network-wide lead as this computer sees it (#3351), for Settings, the
 * Dispatcher pane and its sidebar row. One subscription, started by the first
 * reader.
 */
interface LeadStoreState {
  state: DispatcherLeadState | null;
  setState: (state: DispatcherLeadState) => void;
}

export const useLeadStore = create<LeadStoreState>((set) => ({
  state: null,
  setState: (state) => set({ state }),
}));

let subscribed = false;
function subscribe(): void {
  if (subscribed) return;
  subscribed = true;
  window.clubhouse.dispatcher.onLeadChanged((state) => useLeadStore.getState().setState(state));
  window.clubhouse.dispatcher.getLead().then(
    (state) => useLeadStore.getState().setState(state),
    () => { subscribed = false; /* telemetry-exempt: read again by the next reader */ },
  );
}

/** The lead state, subscribing on first use. */
export function useLeadState(): DispatcherLeadState | null {
  useEffect(subscribe, []);
  return useLeadStore((s) => s.state);
}

/** The lead's Dispatcher as last seen, so its chat stays readable while its computer is offline (#3353). */
const lastKnown = new Map<string, Agent>();

export interface FollowedLead {
  state: DispatcherLeadState;
  /** The lead's machine name. */
  machineName: string;
  /** The lead's Dispatcher chat agent, under its namespaced id, once its snapshot has it. */
  agent: Agent | null;
  online: boolean;
}

/**
 * While this computer follows a lead (#3352): the lead's Dispatcher chat as an
 * agent on another desktop, so the usual remote chat (D219) shows it.
 */
export function useFollowedLead(): FollowedLead | null {
  const state = useLeadState();
  const machine = state?.following ? state.lead?.machine ?? null : null;
  const satellite = useAnnexClientStore((s) => (machine ? s.satellites.find((sat) => sat.fingerprint.toLowerCase() === machine) ?? null : null));
  const remote = satellite?.snapshot?.dispatcher?.agent ?? null;
  const satelliteId = satellite?.id ?? null;
  const online = satellite?.state === 'connected';
  // Its live run state: the snapshot's copy is as it was when the snapshot was taken.
  const live = useRemoteProjectStore((s) => (remote && satelliteId ? s.remoteAgents[namespacedAgentId(satelliteId, remote.id)] ?? null : null));
  const agent = useMemo<Agent | null>(() => {
    if (!machine) return null;
    if (!remote || !satelliteId) return lastKnown.get(machine) ?? null;
    const copy = live ?? { ...remote, id: namespacedAgentId(satelliteId, remote.id), projectId: namespacedProjectId(satelliteId, remote.projectId || DISPATCHER_PROJECT_ID) };
    // A Dispatcher's chat always runs in chat; a snapshot taken while it slept says null (D220).
    const shown: Agent = { ...copy, executionMode: 'chat' };
    lastKnown.set(machine, shown);
    return shown;
  }, [remote, satelliteId, machine, live]);
  if (!state || !machine) return null;
  return { state, machineName: state.lead?.name ?? satellite?.alias ?? 'another computer', agent, online };
}

export type FollowerApproval = {
  /** The computer it waits on (lowercase fingerprint). */
  machine: string;
  machineName: string;
} & ({ request: MobileGrantRequest; pending?: never } | { request?: never; pending: DesktopPendingGrantRequest });

export const followerApprovalId = (item: FollowerApproval): string => item.request ? item.request.requestId : item.pending.requestId;
export const followerApprovalTime = (item: FollowerApproval): number => Date.parse(item.request ? item.request.requestedAt : item.pending.createdAt) || 0;

const NO_APPROVALS: FollowerApproval[] = [];
let visibility = new Map<string, string>();

/**
 * Ask-first requests on connected computer members, oldest first (#3354,
 * #3654, #3696). Without a lead peers see every host-offered row. With a lead,
 * the existing routing stands. Host-only notices never offer an answer.
 */
export function useFollowerApprovals(): FollowerApproval[] {
  const state = useLeadState();
  const satellites = useAnnexClientStore((s) => s.satellites);
  const approvals = useMemo(() => followerApprovalsFrom(state, satellites), [state, satellites]);
  useEffect(() => {
    const shown = new Map(approvals.map((item) => {
      const request = item.request;
      const connection = request && connectionApprovalView(request);
      const reason = !request ? 'host_only' : request.update || request.answers.length === 0 || connection && !connection.canonical ? 'read_only' : 'answerable';
      return [`${item.machine}:${followerApprovalId(item)}`, reason];
    }));
    const next = new Map<string, string>();
    for (const sat of satellites) {
      const machine = sat.fingerprint.toLowerCase();
      const member = state?.choices.find((c) => !c.self && c.machine.toLowerCase() === machine);
      for (const row of [...(sat.snapshot?.grantRequests ?? []), ...(sat.snapshot?.pendingGrantRequests ?? [])]) {
        const key = `${machine}:${row.requestId}`;
        const reason = shown.get(key) ?? (!state ? 'lead_unknown' : !member ? 'not_member' : sat.needsPairing ? 'unpaired'
          : sat.state !== 'connected' || !member.online ? 'offline' : 'lead_routing');
        next.set(key, reason);
        if (visibility.get(key) !== reason) rendererLog('core:dispatcher', 'info', shown.has(key) ? 'Remote approval shown' : 'Remote approval hidden', {
          meta: { machine, requestId: row.requestId, reason, role: state?.role ?? 'unknown' },
        });
      }
    }
    visibility = next;
  }, [state, satellites, approvals]);
  return approvals;
}

function followerApprovalsFrom(state: DispatcherLeadState | null, satellites: ReturnType<typeof useAnnexClientStore.getState>['satellites']): FollowerApproval[] {
  const members = state?.choices.filter((c) => !c.self && c.online) ?? [];
  const self = state?.choices.find((c) => c.self)?.machine;
  if (!members.length) return NO_APPROVALS;
  const out: FollowerApproval[] = [];
  const seen = new Set<string>();
  const all = state?.role === 'lead' || state?.role === 'peer' && state.lead === null;
  for (const member of members) {
    const machine = member.machine.toLowerCase();
    const sat = satellites.find((x) => x.fingerprint.toLowerCase() === machine && x.state === 'connected' && !x.needsPairing);
    for (const request of sat?.snapshot?.grantRequests ?? []) {
      // Snapshots already apply grantRowVisibleTo at the authenticated sender.
      const key = `${machine}:${request.requestId}`;
      if (!seen.has(key) && (all || connectionApprovalInvolves(request, self))) {
        seen.add(key);
        out.push({ machine, machineName: member.name, request });
      }
    }
    if (all) for (const pending of sat?.snapshot?.pendingGrantRequests ?? []) {
      const key = `${machine}:${pending.requestId}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ machine, machineName: pending.hostLabel, pending });
      }
    }
  }
  return out.length ? out.sort((a, b) => followerApprovalTime(a) - followerApprovalTime(b)) : NO_APPROVALS;
}

/** Whether this request is waiting right now, read from the stores and not from what a row last rendered. */
export function isFollowerApprovalPending(machine: string, requestId: string): boolean {
  return followerApprovalsFrom(useLeadStore.getState().state, useAnnexClientStore.getState().satellites)
    .some((item) => item.machine === machine.toLowerCase() && !!item.request && item.request.requestId === requestId);
}

/** For tests: as if nothing had read the lead yet. */
export function _resetLeadStoreForTesting(): void {
  subscribed = false;
  lastKnown.clear();
  visibility.clear();
  useLeadStore.setState({ state: null });
}
