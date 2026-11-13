import { useEffect, useMemo } from 'react';
import { create } from 'zustand';
import type { Agent } from '../../../shared/types';
import type { DispatcherLeadState } from '../../../shared/dispatcher-lead';
import { DISPATCHER_PROJECT_ID } from '../../../shared/dispatcher-types';
import { useAnnexClientStore } from '../../stores/annexClientStore';
import { namespacedAgentId, namespacedProjectId, useRemoteProjectStore } from '../../stores/remoteProjectStore';

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

/** For tests: as if nothing had read the lead yet. */
export function _resetLeadStoreForTesting(): void {
  subscribed = false;
  lastKnown.clear();
  useLeadStore.setState({ state: null });
}
