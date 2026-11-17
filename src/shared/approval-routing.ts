import { parseAgentAddress } from './agent-address';
import type { MobileGrantRequest } from './mobile-control';

/**
 * Whether another computer's pending call involves this computer (#3654).
 * Only stored connection arguments confer ownership. Bare references belong
 * to the requesting computer; display text and lasting grant asks do not.
 */
export function connectionApprovalInvolves(
  row: Pick<MobileGrantRequest, 'kind' | 'actions' | 'toolName' | 'arguments'>,
  machine: string | null | undefined,
): boolean {
  if (!machine || row.kind !== 'call' || !row.actions.includes('connection.manage')
    || !['connect_agents', 'disconnect_agents', 'set_connection_tools'].includes(row.toolName ?? '')) return false;
  try {
    const args: unknown = row.arguments ? JSON.parse(row.arguments) : null;
    if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
    const { from, to } = args as Record<string, unknown>;
    if (typeof from !== 'string' || !from || typeof to !== 'string' || !to) return false;
    return [from, to].some((ref) => {
      const end = parseAgentAddress(ref);
      return !end.agentId.includes('@') && end.machine === machine.toLowerCase();
    });
  } catch {
    // telemetry-exempt: malformed stored arguments confer no ownership
    return false;
  }
}
