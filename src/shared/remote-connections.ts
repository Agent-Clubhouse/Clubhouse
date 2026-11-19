import { activeAgentLinks, type ConnectionDirection as SavedDirection } from './connection-grants';
import { formatAgentAddress } from './agent-address';

export interface RemoteConnection {
  /** `agentId@machine`. */
  address: string;
  agentId: string;
  machine: string;
  direction: 'two-way' | 'to' | 'from';
}

/** The agent's links with agents on other machines, one row per other agent. */
export function remoteConnections(grants: readonly SavedDirection[], agentId: string): RemoteConnection[] {
  const rows = new Map<string, RemoteConnection>();
  for (const d of grants) {
    if (!d.link && !d.cardLink && !activeAgentLinks(d).length) continue;
    const outgoing = d.from.agentId === agentId && !d.from.machineId && !!d.to.machineId;
    const incoming = d.to.agentId === agentId && !d.to.machineId && !!d.from.machineId;
    if (!outgoing && !incoming) continue;
    const other = outgoing ? d.to : d.from;
    const address = formatAgentAddress({ agentId: other.agentId, machine: other.machineId });
    const existing = rows.get(address);
    const direction = outgoing ? 'to' : 'from';
    if (existing) existing.direction = existing.direction === direction ? direction : 'two-way';
    else rows.set(address, { address, agentId: other.agentId, machine: other.machineId!.toLowerCase(), direction });
  }
  return [...rows.values()];
}

