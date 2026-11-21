/** No local action hooks, management callbacks or action definitions. */
import type { RemoteDetailsCard } from '../../../../shared/remote-agent-details';
import { ActionGroupFrame, ActionLineContent } from '../../actions/ActionListPresentation';
import { Evidence } from './RemoteDetailsEvidence';
import { CardNote } from './DetailsCard';

export function RemoteActionsEvidence({ card, agentName }: { card: RemoteDetailsCard; agentName: string }) {
  const groups = [
    { id: 'owned', title: `Owned by ${agentName}`, note: `Their usage counts toward ${agentName}.` },
    { id: 'targeting', title: `Targets ${agentName}` },
    { id: 'triggered-by', title: `Set off by ${agentName}` },
    { id: 'dispatcher', title: 'Made by the Dispatcher' },
  ] as const;
  const legacy = card.rows.filter((r) => !r.action);
  return <>
    <div className="px-3 pb-1">{groups.map((group) => {
      const rows = card.rows.filter((r) => r.action?.group === group.id);
      if (!rows.length) return null;
      const content = rows.map((r, index) => <li key={index} className="py-2 border-t border-surface-0" data-testid="remote-action-row"><ActionLineContent name={r.label} description={r.action!.description} enabled={r.action!.enabled} lastRun={r.action!.lastRun} /></li>);
      return group.id === 'dispatcher' ? <ul key={group.id}>{content}</ul> : <ActionGroupFrame key={group.id} title={group.title} empty="" hasItems note={'note' in group ? group.note : undefined}>{content}</ActionGroupFrame>;
    })}</div>
    {legacy.length > 0 && <CardNote>This host shared action descriptions without relationship group fields.</CardNote>}
    <Evidence card={{ ...card, rows: legacy }} />
  </>;
}
