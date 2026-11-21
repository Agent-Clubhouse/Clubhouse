import type { RemoteDetailsCard } from '../../../../shared/remote-agent-details';
import { CardNote, CardRow } from './DetailsCard';

export function Evidence({ card }: { card: RemoteDetailsCard }) {
  if (card.requested === false) return <CardNote>This section is not included in the selected Connections page. Refresh full Details to read it.</CardNote>;
  return <>
    {card.rows.map((r, i) => <CardRow key={i} label={r.label} labelWidth="wide"><span className="break-words">{r.value}</span></CardRow>)}
    {card.notes.map((note, i) => <CardNote key={i}>{note}</CardNote>)}
    {card.state === 'error' && <CardNote><span role="status">Couldn’t read this section from the host.</span></CardNote>}
    {card.state === 'unsupported' && <CardNote>This host does not support sharing this section.</CardNote>}
    {card.omitted > 0 && <CardNote>{card.omitted} more rows omitted by the host’s display limit. View the complete list on the host.</CardNote>}
  </>;
}

