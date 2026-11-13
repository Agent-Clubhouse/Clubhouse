/** The production controller receiver, shared with the transport integration test. */
import type { DispatcherAgentCallReceiver } from './annex-agent-calls';
import { federationDirection } from './dispatcher-federation-policy';
import { getDispatcherAgentId, isDispatcherEnabled } from './dispatcher/dispatcher-service';
import { runAgentToolForRemoteCaller } from './clubhouse-mcp/tool-registry';

export const federationReceiver: DispatcherAgentCallReceiver = {
  isTarget: (id) => id === getDispatcherAgentId(),
  isAvailable: () => isDispatcherEnabled(),
  receive: async (request) => {
    const caller = { agentId: request.origin.agentId, machineId: request.origin.machineId };
    if (!federationDirection(caller, { agentId: request.targetId })) return {
      content: [{ type: 'text', text: 'That controller is not linked by this computer’s Annex Network membership.' }],
      isError: true, annexDelivery: { state: 'refused', reason: 'not_connected' },
    };
    return runAgentToolForRemoteCaller(request.tool, request.targetId, `${caller.agentId}@${caller.machineId}`, request.args);
  },
};
