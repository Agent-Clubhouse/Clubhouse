import type { RemoteDetailsCard } from '../../../../shared/remote-agent-details';
import { accessLabel } from '../../../../shared/agent-access';
import type { ChatViewState } from '../../../stores/chatStore';
import { contextSummary } from '../ContextWindowField';
import { CardNote, CardRow, DetailsCard } from './DetailsCard';
import { Evidence } from './RemoteDetailsEvidence';
import { useAgentDetailsStore } from './detailsStore';

/** Quick launch metadata has no durable config or next-wake settings hook. */
export function RemoteQuickSettingsCard({ card, session, runtimeUnconfirmed, message }: { card?: RemoteDetailsCard; session?: ChatViewState; runtimeUnconfirmed: boolean; message: string }) {
  const open = useAgentDetailsStore((s) => s.settingsOpen);
  const setOpen = useAgentDetailsStore((s) => s.setSettingsOpen);
  const cli = card?.rows.find((r) => r.label === 'CLI')?.value ?? session?.provider;
  const context = session ? contextSummary(session.contextLimits, session.usage.context?.size) : null;
  const liveAccess = session?.level && card?.rows.find((r) => r.label === 'Access')?.value !== 'Set by the CLI' ? session.level : null;
  const rows = card?.rows.filter((r) => !(runtimeUnconfirmed && ['CLI', 'View', 'Runs in', 'Access'].includes(r.label))
    && !(session?.cliVersion && r.label === 'CLI') && !(liveAccess && r.label === 'Access'));
  return <DetailsCard id="settings" title="Settings" summary={card?.summary || message} open={open} onToggle={() => setOpen(!open)}>
    {session?.cliVersion && <CardRow label="CLI" labelWidth="wide">{cli} {session.cliVersion}</CardRow>}
    {session?.model && <CardRow label="Model" labelWidth="wide">{session.models.find((m) => m.id === session.model)?.label ?? session.model}</CardRow>}
    {session?.effortReported && session.effort && <CardRow label="Effort" labelWidth="wide">{session.effort[0].toUpperCase() + session.effort.slice(1)}{session.effortIsDefault ? ' (default)' : ''}</CardRow>}
    {context && <CardRow label="Context" labelWidth="wide">{context}</CardRow>}
    {liveAccess && <CardRow label="Access" labelWidth="wide">{accessLabel(liveAccess)}</CardRow>}
    {card ? <Evidence card={{ ...card, rows: rows ?? [] }} /> : <CardNote>{message}</CardNote>}
    {runtimeUnconfirmed && <CardNote>Current runtime reports are unconfirmed. Retained launch choices do not establish what is running.</CardNote>}
  </DetailsCard>;
}
