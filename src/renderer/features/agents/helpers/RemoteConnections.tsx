/**
 * Connections with agents on other computers (#3064), inside the Connections
 * card: each one with its direction and machine, a way to remove it, and a
 * picker to connect to an agent on a computer this one is connected to.
 *
 * The connection is the link (D129): each direction is the person's own link,
 * kept on both computers, and the computer that receives a call checks it.
 */

import { useEffect, useMemo, useState } from 'react';
import type { Agent } from '../../../../shared/types';
import { activeAgentLinks, type ConnectionDirection as SavedDirection } from '../../../../shared/connection-grants';
import { formatAgentAddress, namespacedIdFromAddress } from '../../../../shared/agent-address';
import { useRemoteProjectStore } from '../../../stores/remoteProjectStore';
import { useAnnexClientStore } from '../../../stores/annexClientStore';
import type { ConnectionPickerDirectory } from '../../../../shared/connection-picker';
import { ConnectionSourcesDialog } from './ConnectionSourcesDialog';
import type { ConnectionPairSources } from '../../../../shared/connection-sources';

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

const META: Record<RemoteConnection['direction'], string> = { 'two-way': 'two-way', to: 'sends to it', from: 'sends to this agent' };

export function RemoteConnections({ agent, grants, onChanged, openAddress }: {
  agent: Agent;
  grants: readonly SavedDirection[];
  /** After a connect or a removal, so the card reads the store again. */
  onChanged: () => void;
  openAddress?: string | null;
}) {
  const satellites = useAnnexClientStore((s) => s.satellites);
  const remoteAgents = useRemoteProjectStore((s) => s.remoteAgents);
  const rows = useMemo(() => remoteConnections(grants, agent.id), [grants, agent.id]);
  const [managing, setManaging] = useState<string | null>(null);
  const [directory, setDirectory] = useState<ConnectionPickerDirectory | null>(null);
  useEffect(() => {
    let live = true;
    void window.clubhouse.mcpBinding.listCardTargets?.(agent.id).then((value) => { if (live) setDirectory(value); }).catch(() => {});
    return () => { live = false; };
  }, [agent.id, grants]);
  useEffect(() => { if (openAddress) setManaging(openAddress); }, [openAddress]);

  const machineName = (machine: string) => satellites.find((s) => s.fingerprint.toLowerCase() === machine)?.alias || directory?.machines.find((p) => p.id === machine)?.name || 'another computer';
  const nameOf = (r: Pick<RemoteConnection, 'agentId' | 'machine'>) =>
    remoteAgents[namespacedIdFromAddress({ agentId: r.agentId, machine: r.machine })]?.name || directory?.targets.find((target) => target.id === r.agentId && target.machineId === r.machine)?.name || r.agentId;
  const rowDirections = (row: RemoteConnection) => grants.filter((d) => (!d.from.machineId && d.from.agentId === agent.id && d.to.machineId === row.machine && d.to.agentId === row.agentId)
    || (!d.to.machineId && d.to.agentId === agent.id && d.from.machineId === row.machine && d.from.agentId === row.agentId));
  const managed = rows.find((row) => row.address === managing);
  const pairs: ConnectionPairSources[] = managed ? rowDirections(managed).filter((d) => d.link || d.cardLink || activeAgentLinks(d).length).map((d) => ({
    agentId: formatAgentAddress({ agentId: d.from.agentId, machine: d.from.machineId }),
    targetId: formatAgentAddress({ agentId: d.to.agentId, machine: d.to.machineId }),
    bound: true,
    sources: [...(d.link ? [{ kind: 'user_link' as const, sourceId: 'network-connections' }] : []), ...(d.cardLink ? [{ kind: 'card_link' as const, sourceId: 'connections-card' }] : []), ...(activeAgentLinks(d).length ? [{ kind: 'tool_link' as const, sourceId: 'network-agent-connections', makers: activeAgentLinks(d) }] : [])],
  })) : [];
  if (rows.length === 0 && !managed) return null;

  return (
    <div className="mt-1" data-testid="remote-connections">
      <div className="ml-[22px] pl-3 pt-2 pb-1 text-xs text-ctp-overlay1">On other computers</div>
      {rows.length > 0 && (
        <ul className="flex flex-col">
          {rows.map((r) => (
            <li key={r.address}>
              <div className="w-[calc(100%-28px)] ml-[22px] h-[30px] flex items-center gap-2 pl-3 pr-2.5 rounded-md hover:bg-surface-0" data-testid="remote-connection-row">
                <span className="text-[12.5px] text-ctp-text truncate">{nameOf(r)}</span>
                <span className="text-xs text-ctp-overlay1 whitespace-nowrap">on {machineName(r.machine)}, {META[r.direction]}</span>
                {rowDirections(r).flatMap((d) => activeAgentLinks(d)).filter((maker, index, all) => all.findIndex((other) => other.agentId === maker.agentId && other.machineId === maker.machineId) === index).map((maker) => <span key={`${maker.agentId}@${maker.machineId}`} className="text-xs text-ctp-overlay1">Made by {maker.name || maker.agentId} on {machineName(maker.machineId)}</span>)}
                <span className="ml-auto flex items-center gap-2.5">
                  <button type="button" onClick={() => setManaging(managing === r.address ? null : r.address)} className="text-xs text-ctp-overlay1 hover:text-ctp-text cursor-pointer" data-testid="remote-connection-manage">
                    Edit
                  </button>
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
      {managed && <ConnectionSourcesDialog agentId={agent.id} otherId={managed.address} agentName={agent.name} otherName={nameOf(managed)} targetKind="agent"
        grants={grants} pairs={pairs} remote={{ agentId: agent.id, address: managed.address }} onClose={() => setManaging(null)} onRemoved={onChanged} />}
    </div>
  );
}
