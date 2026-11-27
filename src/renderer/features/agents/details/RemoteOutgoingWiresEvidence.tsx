import { isRemoteOutgoingWires, type RemoteOutgoingWires } from '../../../../shared/remote-agent-details';
import { CardNote } from './DetailsCard';

const kindLabel = { agent: 'agent', browser: 'browser', terminal: 'terminal', 'group-project': 'group project', plugin: 'plugin' } as const;
const unavailable = {
  unreadable: 'The host could not read these outgoing connection records.',
  invalid: 'The selected outgoing connection records are unavailable.',
  limit: 'The host could not read these outgoing connection records within its display limit.',
  changed: 'The outgoing connection records changed while the host was reading them.',
} as const;

/** A record inventory, never connection health or permission evidence. */
export function RemoteOutgoingWiresEvidence({ wires }: { wires?: RemoteOutgoingWires }) {
  if (!isRemoteOutgoingWires(wires)) return <CardNote>This host does not share outgoing connection records in this card. Connections are unknown here; saved connection descriptions do not confirm a current connection.</CardNote>;
  if (wires.state === 'unavailable') return <CardNote>{unavailable[wires.reason]} Connections are unknown here.</CardNote>;
  return <>
    <CardNote>Host-memory outgoing connection records for this selected agent at the Details read. These records do not establish health, reachability, authorization or a live connection.</CardNote>
    {wires.total === 0 ? <CardNote>The host recorded no outgoing connections for this selected agent.</CardNote> : <>
      <CardNote>{wires.rows.length} of {wires.total} recorded outgoing connections shown.</CardNote>
      <ul className="pr-3.5 pl-[33px] py-1 text-xs break-words" aria-label="Recorded outgoing connections">
        {wires.rows.map((wire, index) => <li key={index} className="flex items-baseline gap-2 py-0.5">
          <span className="min-w-0">Recorded connection to {wire.name ?? 'Name unavailable from host'}</span>
          <span className="ml-auto text-ctp-overlay1 whitespace-nowrap">{kindLabel[wire.kind]}</span>
        </li>)}
      </ul>
    </>}
    {wires.omitted > 0 && <CardNote>{wires.omitted} additional outgoing connection records omitted by the host’s display limit. No complete connection list is claimed.</CardNote>}
  </>;
}
