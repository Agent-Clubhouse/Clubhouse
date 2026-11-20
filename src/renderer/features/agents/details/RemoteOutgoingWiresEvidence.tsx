import { isRemoteOutgoingWires, type RemoteOutgoingWires } from '../../../../shared/remote-agent-details';
import { CardNote } from './DetailsCard';

const kindLabel = { agent: 'agent', browser: 'browser', terminal: 'terminal', 'group-project': 'group project', plugin: 'plugin' } as const;
const unavailable = {
  unreadable: 'The host could not read these outgoing binding records.',
  invalid: 'The selected outgoing binding records are unavailable.',
  limit: 'The host could not read these outgoing binding records within its display limit.',
  changed: 'The outgoing binding records changed while the host was reading them.',
} as const;

/** A record inventory, never connection health or permission evidence. */
export function RemoteOutgoingWiresEvidence({ wires }: { wires?: RemoteOutgoingWires }) {
  if (!isRemoteOutgoingWires(wires)) return <CardNote>This host does not share outgoing wire records in this card. Wiring is unknown here; saved connection descriptions do not confirm a current wire.</CardNote>;
  if (wires.state === 'unavailable') return <CardNote>{unavailable[wires.reason]} Wiring is unknown here.</CardNote>;
  return <>
    <CardNote>Host-memory outgoing binding records for this selected agent at the Details read. These records do not establish health, reachability, authorization or a live connection.</CardNote>
    {wires.total === 0 ? <CardNote>The host recorded no outgoing bindings for this selected agent.</CardNote> : <>
      <CardNote>{wires.rows.length} of {wires.total} recorded outgoing bindings shown.</CardNote>
      <ul className="pr-3.5 pl-[33px] py-1 text-xs break-words" aria-label="Recorded outgoing wires">
        {wires.rows.map((wire, index) => <li key={index} className="flex items-baseline gap-2 py-0.5">
          <span className="min-w-0">Recorded wire to {wire.name ?? 'Name unavailable from host'}</span>
          <span className="ml-auto text-ctp-overlay1 whitespace-nowrap">{kindLabel[wire.kind]}</span>
        </li>)}
      </ul>
    </>}
    {wires.omitted > 0 && <CardNote>{wires.omitted} additional outgoing binding records omitted by the host’s display limit. No complete wire list is claimed.</CardNote>}
  </>;
}
