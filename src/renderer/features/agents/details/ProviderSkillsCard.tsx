import type { Agent } from '../../../../shared/types';
import type { ChatViewState } from '../../../stores/chatStore';
import { useProjectStore } from '../../../stores/projectStore';
import { CardNote, CardRow, DetailsCard } from './DetailsCard';
import { useManagedParts, useManagedSetup, useManagedStatus } from '../../managed/managedApi';
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
  const { report } = reportedSkillsFor(agent, chat, project);
  const names = report?.names;
  // What Clubhouse itself installed from the agent's managed setup. Known without any provider report.
  const { value: setup } = useManagedSetup(project?.path, agent.id);
  const installedIds = setup?.skills ?? [];
  // Skills are copied when the agent starts, so the setup alone only says what is set up. Delivery evidence
  // (a running session that got its setup, with no edit since and no failure) says they are installed.
  const { value: status } = useManagedStatus(agent.status === 'running' ? project?.path : undefined, agent.id);
  const delivered = agent.status === 'running' && !!status?.deliveredAt && !status.waiting && !status.deliveryFailed;
  const label = delivered ? 'Installed by Clubhouse' : 'Set up by Clubhouse';
  const { value: parts } = useManagedParts('skill', installedIds.length > 0);
  const installed = installedIds.flatMap((id) => { const part = parts?.find((p) => p.id === id); return part ? [part.name] : []; });
  const installedList = installed.length > 0 && (
    <>
      <p className="pr-3.5 pl-[33px] pt-1.5 pb-0.5 text-xs text-ctp-overlay1">{label}</p>
      {!delivered && <p className="pr-3.5 pl-[33px] pb-0.5 text-xs text-ctp-overlay1">Applies when the agent next starts.</p>}
      <ul className="pr-3.5 pl-[33px] py-1 text-xs text-ctp-text break-words" aria-label={label} data-testid="details-installed-skills">
        {installed.map((name) => <li key={name}>{name}</li>)}
      </ul>
    </>
  );
  if (names == null) {
    // Nothing reported: show only what Clubhouse knows it installed, or nothing at all.
    if (!installedList) return null;
    return (
      <DetailsCard id="provider-skills" title="Skills" summary={`${installed.length} ${delivered ? 'installed' : 'set up'} by Clubhouse`} open={open} onToggle={onToggle} embedded={embedded}>
        {installedList}
      </DetailsCard>
    );
  }
  const historical = agent.status === 'sleeping' || agent.status === 'error'
    || chat.state === 'sleeping' || chat.state === 'error';
  return (
    <DetailsCard id="provider-skills" title="Reported skills"
      summary={`${names.length} reported`} open={open} onToggle={onToggle} embedded={embedded}>
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
      {names.length === 0 ? <CardNote>Claude explicitly reported no skills in this snapshot.</CardNote>
        : <ul className="pr-3.5 pl-[33px] py-1 text-xs text-ctp-text break-words" aria-label="Provider-reported skill names">
          {names.map((name) => <li key={name}>{name}</li>)}
        </ul>}
      {installedList}
      <CardNote>This snapshot can change on a later turn. Opening this card sends nothing to the provider.</CardNote>
    </DetailsCard>
  );
}
