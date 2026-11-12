import { CONNECTION_TOOLS, WAKE_TOOL } from '../../../shared/connection-grants';
import { DISPATCHER_FEDERATION_TOOLS } from '../../../shared/dispatcher-federation';
import type { PersistedBinding, PersistedBindingSource } from '../persisted-bindings';
import { getDispatcherState, dispatcherDisplayName } from './dispatcher-service';
import { getDispatcherFederationPeers } from './dispatcher-federation-presence';

export const DISPATCHER_FEDERATION_SOURCE_ID = 'dispatcher-federation';

/** Both directions exist on both members. Offline links remain owned, not deleted or redrawn. */
export const dispatcherFederationBindingSource: PersistedBindingSource = {
  id: DISPATCHER_FEDERATION_SOURCE_ID,
  prune: true,
  readOnlyCollect: true,
  async collect(): Promise<PersistedBinding[]> {
    const state = getDispatcherState();
    if (!state.agentId) return [];
    const disabledTools = [...CONNECTION_TOOLS.map((entry) => entry.tool), WAKE_TOOL]
      .filter((tool) => !DISPATCHER_FEDERATION_TOOLS.some((safe) => safe === tool));
    const bindings: PersistedBinding[] = [];
    for (const peer of getDispatcherFederationPeers()) {
      if (!peer.address) continue;
      const localName = dispatcherDisplayName();
      const remoteName = `${peer.name} on ${peer.machineName}`;
      const fixed = { startingTools: true as const, disabledTools, enabledTools: [] as string[] };
      bindings.push(
        { agentId: state.agentId, targetId: peer.address, targetKind: 'agent', label: remoteName, agentName: localName, targetName: remoteName, ...fixed },
        { agentId: peer.address, targetId: state.agentId, targetKind: 'agent', label: localName, agentName: remoteName, targetName: localName, ...fixed },
      );
    }
    return bindings;
  },
};
