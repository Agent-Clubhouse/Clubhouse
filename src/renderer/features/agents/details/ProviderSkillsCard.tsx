import type { Agent } from '../../../../shared/types';
import type { ChatViewState } from '../../../stores/chatStore';
import { useProjectStore } from '../../../stores/projectStore';
import { CardNote, CardRow, DetailsCard } from './DetailsCard';
import { reportedSkillsFor } from './reported-skills';

/** Only renders metadata already in chat state. No filesystem reads or provider requests. */
export function ProviderSkillsCard({ agent, chat, open, onToggle, embedded }: {
  agent: Agent;
  chat: ChatViewState;
  open: boolean;
  onToggle: () => void;
  embedded?: boolean;
}) {
  const project = useProjectStore((s) => s.projects.find((p) => p.id === agent.projectId));
  // Match the selected override, else the known project's default. An absent
  // project cannot establish an inherited selection (e.g. during hydration).
  const { supported, report } = reportedSkillsFor(agent, chat, project);
  const names = report?.names;
  const historical = agent.status === 'sleeping' || agent.status === 'error'
    || chat.state === 'sleeping' || chat.state === 'error';
  return (
    <DetailsCard id="provider-skills" title="Reported skills"
      summary={names ? `${names.length} reported` : 'Unknown'} open={open} onToggle={onToggle} embedded={embedded}>
      <CardNote>
        {historical ? 'Last session snapshot. ' : 'Session snapshot. '}
        Provider-reported names do not prove a skill was used or executed. Filesystem scope and origin are not reported.
      </CardNote>
      {report && <>
        <CardRow label="Source">Claude · system/init</CardRow>
        <CardRow label="Session"><span className="font-mono break-all">{report.sessionId}</span></CardRow>
        <CardRow label="Native session"><span className="font-mono break-all">{report.nativeSessionId}</span></CardRow>
        <CardRow label="Reported"><time dateTime={new Date(report.reportedAt).toISOString()}>{new Date(report.reportedAt).toLocaleString()}</time></CardRow>
      </>}
      {!supported ? <CardNote>Passive skill reporting is unavailable for this provider or session.</CardNote>
        : names == null ? <CardNote>No valid skill list reported for this session.</CardNote>
          : <>
            {names.length === 0 ? <CardNote>Claude explicitly reported no skills in this snapshot.</CardNote>
              : <ul className="pr-3.5 pl-[33px] py-1 text-xs text-ctp-text break-words" aria-label="Provider-reported skill names">
                {names.map((name) => <li key={name}>{name}</li>)}
              </ul>}
          </>}
      <CardNote>This snapshot can change on a later turn. Opening this card sends nothing to the provider.</CardNote>
    </DetailsCard>
  );
}
