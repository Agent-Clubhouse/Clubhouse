import { isMachineFingerprint } from '../../../../shared/agent-address';
import { registerGlobalTool } from '../tool-registry';

export function registerHandoffCapacityTools(): void {
  registerGlobalTool('probe_capacity', {
    description: 'Read coarse capacity for this computer and Annex Network computers, or one machine fingerprint from list_devices. Returns agent counts, CPU/memory and disk bands, cached provider availability and whether handoffs are accepted. Offline computers return immediately. No paths, hostnames or exact resource measurements.',
    inputSchema: { type: 'object', properties: { machine: { type: 'string', description: 'Optional machine fingerprint from list_devices. Omit to probe all computers.' } } },
  }, async (agentId, args) => {
    if (Object.keys(args).some((key) => key !== 'machine')
      || args.machine !== undefined && (typeof args.machine !== 'string' || !isMachineFingerprint(args.machine))) {
      return { content: [{ type: 'text', text: 'Give only an optional machine fingerprint from list_devices.' }], isError: true };
    }
    try {
      const { handoffCapacityService } = await import('../../handoff-capacity-host');
      const result = await handoffCapacityService().probe(agentId, typeof args.machine === 'string' ? args.machine.toLowerCase() : undefined);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch {
      // telemetry-exempt: report no OS details or peer response content
      return { content: [{ type: 'text', text: 'Capacity probe is unavailable or not authorized. Try again after checking device connectivity and device.read permissions.' }], isError: true };
    }
  }, { grant: { actions: ['device.read'], target: 'app' } });
}
