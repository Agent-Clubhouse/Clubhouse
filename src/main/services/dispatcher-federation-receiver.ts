/** The production controller receiver, shared with the transport integration test. */
import { countFederatedDuplicate, federatedRequests, receiveFederatedNewsCause, receiveFederatedRequest } from './dispatcher-federation-runtime';
import type { DispatcherAgentCallReceiver } from './annex-agent-calls';
import { federationDirection } from './dispatcher-federation-policy';
import { getDispatcherAgentId, isDispatcherEnabled } from './dispatcher/dispatcher-service';
import { runAgentToolForRemoteCaller } from './clubhouse-mcp/tool-registry';
import { isForwardedNewsCall, receiveFollowerNews } from './dispatcher-follower-news';

export const federationReceiver: DispatcherAgentCallReceiver = {
  duplicate: countFederatedDuplicate,
  isTarget: (id) => id === getDispatcherAgentId(),
  isAvailable: () => isDispatcherEnabled(),
  receive: async (request) => {
    const caller = { agentId: request.origin.agentId, machineId: request.origin.machineId };
    if (!federationDirection(caller, { agentId: request.targetId })) return {
      content: [{ type: 'text', text: 'That controller is not linked by this computer’s Annex Network membership.' }],
      isError: true, annexDelivery: { state: 'refused', reason: 'not_connected' },
    };
    if (['send_message', 'send_file', 'hand_off_request'].includes(request.tool) && federatedRequests()?.allowed(caller.machineId!, request.args, request.tool) === false) return {
      content: [{ type: 'text', text: 'This controller link is paused after a fixed limit was reached.' }],
      isError: true, annexDelivery: { state: 'refused', reason: 'controller_link_paused' },
    };
    if (request.tool === 'hand_off_request') return receiveFederatedRequest(request);
    if (request.tool === 'send_message' || request.tool === 'send_file') {
      try { await receiveFederatedNewsCause(request); }
      catch (err) { return { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true, annexDelivery: { state: 'refused', reason: 'controller_limit' } }; }
    }
    const run = (args: Record<string, unknown>) => runAgentToolForRemoteCaller(request.tool, request.targetId, `${caller.agentId}@${caller.machineId}`, args);
    // A follower's news (#3352): checked, named by the authenticated machine only, and told to this controller.
    if (isForwardedNewsCall(request.tool, request.args)) return receiveFollowerNews(caller.machineId, request.args.news, (message) => run({ message }));
    return run(request.args);
  },
};
