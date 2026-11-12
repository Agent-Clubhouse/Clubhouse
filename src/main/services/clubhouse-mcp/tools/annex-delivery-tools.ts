import { getDelivery } from '../../annex-agent-calls';
import { tel } from '../../../telemetry/facade';
import { appLog } from '../../log-service';
import { registerGlobalTool } from '../tool-registry';

export function registerAnnexDeliveryTools(): void {
  registerGlobalTool('get_delivery', {
    description: 'Read your durable cross-machine delivery by delivery_id. Delivered means the receiving tool/runtime accepted input, not that a model processed it. Indeterminate deliveries must not be blindly resent under a new key.',
    inputSchema: { type: 'object', properties: { delivery_id: { type: 'string' } }, required: ['delivery_id'] },
  }, async (agentId, args) => {
    if (Object.keys(args).some((k) => k !== 'delivery_id') || typeof args.delivery_id !== 'string' || !args.delivery_id || args.delivery_id.length > 200) {
      return { content: [{ type: 'text', text: 'Give delivery_id only (1 to 200 characters).' }], isError: true };
    }
    try {
      const status = getDelivery(agentId, args.delivery_id);
      return status
        ? { content: [{ type: 'text', text: JSON.stringify(status) }] }
        : { content: [{ type: 'text', text: 'No retained delivery with that id belongs to you.' }], isError: true };
    } catch (err) {
      tel.exception(Object.assign(new Error('annex_delivery_status_read_failed'), { stack: undefined }), { origin: 'main', handled: true });
      appLog('core:annex', 'error', 'Could not read durable delivery', { meta: { agentId, error: err instanceof Error ? err.message : String(err) } });
      return { content: [{ type: 'text', text: 'The durable delivery store is unavailable. No delivery state can be confirmed.' }], isError: true };
    }
  }, { grant: { actions: ['agent.read'], target: 'self' } });
}
