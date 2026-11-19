/** Display references only: no execution eligibility, federation, membership or cold-store initialization. */
import type { ActionNames } from '../../../shared/actions';
import { addressFromNamespacedId, isMachineFingerprint, parseAgentAddress } from '../../../shared/agent-address';
import { peekKnownAgentName } from '../app-event-sources';
import { getSatellite } from '../annex-client';
import { peekPeerAlias } from '../annex-peers';
import { dispatcherDisplayName, isDispatcherIdentityAgentId } from '../dispatcher/dispatcher-service';
import { groupProjectRegistry } from '../group-project-registry';

export interface SelectedActionNames { agentId: string; projectId: string; agentName?: string; projectName?: string }
export function actionDetailsNames(projectName: (id: string) => string | undefined, selected?: SelectedActionNames): { names: ActionNames; notices(): string[] } {
  const notes = new Set<string>();
  const cached = new Map<string, string | undefined>();
  let entries = 0, groups = 0;
  const machines = new Map<string, { host: string; labels: Map<string, string | null> } | undefined>();
  const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
  const missing = (kind: string): undefined => { notes.add(`A referenced ${kind} name is unavailable in retained host metadata.`); return undefined; };
  const once = (key: string, read: () => string | undefined) => {
    if (!cached.has(key)) {
      const value = read(); cached.set(key, typeof value === 'string' && value ? value : undefined);
      if (cached.get(key)) notes.add('Reference names use retained host display metadata.');
    }
    return cached.get(key);
  };
  const names: ActionNames = {
    agent: (id) => once(`agent:${id}`, () => {
      const address = addressFromNamespacedId(id) ?? parseAgentAddress(id);
      if (!address.machine) return /@|^remote\|\|/.test(id) ? missing('agent') : (isDispatcherIdentityAgentId(id) ? dispatcherDisplayName() : id === selected?.agentId && selected.agentName ? selected.agentName : peekKnownAgentName(id)) || missing('agent');
      if (!isMachineFingerprint(address.machine) || !address.agentId || /@|\|\|/.test(address.agentId)) return missing('agent');
      if (!machines.has(address.machine)) {
        const machine = address.machine;
        machines.set(machine, undefined);
        const connection = getSatellite(machine);
        if (!connection || connection.needsPairing || !record(connection.snapshot)) return missing('remote agent');
        const snapshot = connection.snapshot;
        if (record(snapshot.machine) && typeof snapshot.machine.fingerprint === 'string' && snapshot.machine.fingerprint.toLowerCase() !== machine) return missing('remote agent');
        const labels = new Map<string, string | null>();
        const add = (agent: unknown) => {
          if (record(agent) && typeof agent.id === 'string' && typeof agent.name === 'string') labels.set(agent.id, labels.has(agent.id) ? null : agent.name);
        };
        for (const kind of ['agents', 'quickAgents'] as const) {
          const collection = snapshot[kind]; if (!record(collection)) continue;
          for (const key in collection) {
            if (++groups > 256) { notes.add('Cached reference-name lookup reached its host read limit; remaining names are unknown.'); return undefined; }
            const list = collection[key]; if (!Array.isArray(list)) continue;
            for (const agent of list) {
              if (++entries > 4096) { notes.add('Cached reference-name lookup reached its host read limit; remaining names are unknown.'); return undefined; }
              add(agent);
            }
          }
        }
        if (record(snapshot.dispatcher)) add(snapshot.dispatcher.agent);
        const host = (typeof connection.alias === 'string' && connection.alias ? connection.alias : undefined) || (record(snapshot.machine) && typeof snapshot.machine.name === 'string' ? snapshot.machine.name : 'another computer');
        machines.set(machine, { host, labels });
      }
      const cachedMachine = machines.get(address.machine);
      const label = cachedMachine?.labels.get(address.agentId);
      if (!label || !cachedMachine) return missing('remote agent');
      notes.add('Remote reference names come from retained host snapshots; their current availability is not checked here.');
      return `${label} on ${cachedMachine.host}`;
    }),
    project: (id) => once(`project:${id}`, () => (id === selected?.projectId ? selected.projectName : undefined) || projectName(id) || missing('project')),
    dispatcher: () => dispatcherDisplayName(),
    device: (id) => once(`device:${id}`, () => getSatellite(id)?.alias || peekPeerAlias(id) || missing('device')),
    groupProject: (id) => once(`group:${id}`, () => groupProjectRegistry.getSync(id)?.name || missing('group project')),
  };
  return { names, notices: () => [...notes] };
}
