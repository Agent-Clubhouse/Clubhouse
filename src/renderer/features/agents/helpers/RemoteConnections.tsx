/**
 * Connections with agents on other computers (#3064), inside the Connections
 * card: each one with its direction and machine, a way to remove it, and a
 * picker to connect to an agent on a computer this one is connected to.
 *
 * The connection is the link (D129): each direction is the person's own link,
 * kept on both computers, and the computer that receives a call checks it.
 */

import { useMemo, useState } from 'react';
import type { Agent } from '../../../../shared/types';
import type { ConnectionDirection as SavedDirection } from '../../../../shared/connection-grants';
import { addressFromNamespacedId, formatAgentAddress, namespacedIdFromAddress } from '../../../../shared/agent-address';
import { useRemoteProjectStore } from '../../../stores/remoteProjectStore';
import { useAnnexClientStore } from '../../../stores/annexClientStore';
import { Button } from '../../../components/Button';
import { ConfirmDestructiveAction } from '../../../components/ConfirmDestructiveAction';

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
    if (!d.link) continue;
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

export function RemoteConnections({ agent, grants, onChanged }: {
  agent: Agent;
  grants: readonly SavedDirection[];
  /** After a connect or a removal, so the card reads the store again. */
  onChanged: () => void;
}) {
  const satellites = useAnnexClientStore((s) => s.satellites);
  const remoteAgents = useRemoteProjectStore((s) => s.remoteAgents);
  const rows = useMemo(() => remoteConnections(grants, agent.id), [grants, agent.id]);
  const [picking, setPicking] = useState(false);
  const [choice, setChoice] = useState('');
  const [twoWay, setTwoWay] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<RemoteConnection | null>(null);

  const machineName = (machine: string) => satellites.find((s) => s.fingerprint.toLowerCase() === machine)?.alias || 'another computer';
  // Durable agents on computers this one is connected to, by address.
  const candidates = useMemo(() => {
    const connected = new Set(satellites.filter((s) => s.state === 'connected').map((s) => s.fingerprint.toLowerCase()));
    const linked = new Set(rows.map((r) => r.address));
    return Object.entries(remoteAgents).flatMap(([id, a]) => {
      const address = addressFromNamespacedId(id);
      if (!address?.machine || !connected.has(address.machine) || a.kind !== 'durable') return [];
      const text = formatAgentAddress(address);
      return linked.has(text) ? [] : [{ address: text, name: a.name, machine: address.machine }];
    }).sort((x, y) => x.name.localeCompare(y.name));
  }, [remoteAgents, satellites, rows]);
  const nameOf = (r: Pick<RemoteConnection, 'agentId' | 'machine'>) =>
    remoteAgents[namespacedIdFromAddress({ agentId: r.agentId, machine: r.machine })]?.name || r.agentId;

  if (rows.length === 0 && candidates.length === 0) return null;

  const connect = async () => {
    const picked = candidates.find((c) => c.address === choice);
    if (!picked) return;
    setError(null);
    try {
      await window.clubhouse.mcpBinding.connectAcrossMachines(agent.id, picked.address, { twoWay, name: picked.name });
      setPicking(false);
      setChoice('');
      onChanged();
    } catch {
      // telemetry-exempt: main logged it; the picker says so and stays open.
      setError('Couldn’t connect them. Try again.');
    }
  };

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
                <span className="ml-auto">
                  <button type="button" onClick={() => setRemoving(r)} className="text-xs text-ctp-overlay1 hover:text-ctp-text cursor-pointer" data-testid="remote-connection-remove">
                    Remove
                  </button>
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
      {candidates.length > 0 && (picking ? (
        <div className="ml-[22px] pl-3 pr-2.5 py-1.5 flex flex-col gap-1.5" data-testid="remote-connection-picker">
          <select
            aria-label="Agent on another computer"
            value={choice}
            onChange={(e) => setChoice(e.target.value)}
            className="h-7 rounded-md bg-surface-0 text-xs text-ctp-text px-2"
          >
            <option value="">Choose an agent</option>
            {candidates.map((c) => <option key={c.address} value={c.address}>{c.name} on {machineName(c.machine)}</option>)}
          </select>
          <label className="flex items-center gap-1.5 text-xs text-ctp-subtext0">
            <input type="checkbox" checked={twoWay} onChange={(e) => setTwoWay(e.target.checked)} />
            Both ways
          </label>
          {error && <div className="text-xs text-ctp-error">{error}</div>}
          <div className="flex gap-1.5">
            <Button onClick={() => void connect()} kind="primary" disabled={!choice}>Connect</Button>
            <Button onClick={() => { setPicking(false); setError(null); }} kind="ghost">Cancel</Button>
          </div>
        </div>
      ) : (
        <div className="ml-[22px] pl-3 py-1">
          <button type="button" onClick={() => setPicking(true)} className="text-xs text-ctp-accent hover:underline cursor-pointer" data-testid="remote-connection-add">
            Connect to an agent on another computer
          </button>
        </div>
      ))}
      <ConfirmDestructiveAction
        open={removing !== null}
        title={`Remove the connection with ${removing ? nameOf(removing) : ''}?`}
        description="Both directions are removed, here and on the other computer once it hears. Neither agent keeps its tools for the other."
        confirmLabel="Remove"
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          const r = removing;
          setRemoving(null);
          if (r) {
            void window.clubhouse.mcpBinding.disconnectAcrossMachines(agent.id, r.address)
              // telemetry-exempt: main logged it; the card reads the store again either way.
              .catch(() => {})
              .finally(onChanged);
          }
        }}
      />
    </div>
  );
}
