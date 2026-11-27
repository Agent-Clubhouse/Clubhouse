/** The production controller receiver, shared with the transport integration test. */
import { FederationRefusal } from '../../shared/dispatcher-federation-requests';
import { getAgentRuntime } from './agent-runtime';
import { federationTurnOpen, withFederationInput } from './dispatcher-federation-context';
import { countFederatedDuplicate, federatedRequests, receiveFederatedNewsCause, receiveFederatedRequest } from './dispatcher-federation-runtime';
import { isNetworkComputer, type AgentToolRunResult, type DispatcherAgentCallReceiver } from './annex-agent-calls';
import { remoteFederationController } from './dispatcher-federation';
import { federationDirection, federationMessageDirection } from './dispatcher-federation-policy';
import { getDispatcherAgentId, isDispatcherEnabled } from './dispatcher/dispatcher-service';
import { runAgentToolForRemoteCaller } from './clubhouse-mcp/tool-registry';
import { isForwardedNewsCall, receiveFollowerNews } from './dispatcher-follower-news';

export const federationReceiver: DispatcherAgentCallReceiver = {
  duplicate: countFederatedDuplicate,
  isTarget: (id) => id === getDispatcherAgentId(),
  isAvailable: () => isDispatcherEnabled(),
  receive: async (request) => {
    const caller = { agentId: request.origin.agentId, machineId: request.origin.machineId };
    const controller = federationDirection(caller, { agentId: request.targetId });
    const directNews = ['send_message', 'send_file'].includes(request.tool) && federationMessageDirection(caller, { agentId: request.targetId });
    // A member whose controller this computer hasn't learned yet, from a restart on either side (#3829):
    // nothing ran, so the sender retries until its own expiry instead of refusing for good.
    if (!controller && !directNews && request.targetId === getDispatcherAgentId() && isNetworkComputer(caller.machineId!)
      && !remoteFederationController(caller.machineId!)?.agentId) return {
      content: [{ type: 'text', text: 'This computer has not learned the sending controller yet.' }],
      isError: true, annexDelivery: { state: 'retry_later', reason: 'target_not_ready' },
    };
    if (!controller && (!directNews || request.args.news !== undefined)) return {
      content: [{ type: 'text', text: 'That controller is not connected through this computer’s Annex Network membership.' }],
      isError: true, annexDelivery: { state: 'refused', reason: 'not_connected' },
    };
    if (['send_message', 'send_file', 'hand_off_request'].includes(request.tool) && federatedRequests()?.allowed(caller.machineId!, request.args, request.tool) === false) return {
      content: [{ type: 'text', text: 'This controller connection is paused after a fixed limit was reached.' }],
      isError: true, annexDelivery: { state: 'refused', reason: 'controller_link_paused' },
    };
    if (request.tool === 'hand_off_request') return receiveFederatedRequest(request);
    if (['send_message', 'send_file'].includes(request.tool) && (request.tool === 'send_file' || getAgentRuntime(request.targetId)?.kind !== 'chat') && federationTurnOpen(request.targetId)) return {
      content: [{ type: 'text', text: 'Waiting for the receiving controller to finish its current turn.' }],
      isError: true, annexDelivery: { state: 'retry_later', reason: 'target_not_ready' },
    };
    let input: Awaited<ReturnType<typeof receiveFederatedNewsCause>>;
    if (request.tool === 'send_message' || request.tool === 'send_file') {
      try { input = await receiveFederatedNewsCause(request); }
      catch (err) { return { content: [{ type: 'text', text: err instanceof FederationRefusal ? JSON.stringify({ error: err.details() }) : err instanceof Error ? err.message : String(err) }], isError: true, annexDelivery: { state: 'refused', reason: err instanceof FederationRefusal ? err.code : 'controller_limit' } }; }
    }
    const run = (args: Record<string, unknown>) => {
      const deliver = () => runAgentToolForRemoteCaller(request.tool, request.targetId, `${caller.agentId}@${caller.machineId}`, args);
      return input ? withFederationInput(input, deliver) : deliver();
    };
    // A follower's news (#3352): checked, named by the authenticated machine only, and told to this controller.
    const result: AgentToolRunResult = await (isForwardedNewsCall(request.tool, request.args)
      ? receiveFollowerNews(caller.machineId, request.args.news, (message) => run({ message })) : run(request.args));
    if (input && result.annexDelivery?.state !== 'retry_later') await federatedRequests()?.finishNews(request.origin.machineId, request.deliveryId);
    return result;
  },
};
