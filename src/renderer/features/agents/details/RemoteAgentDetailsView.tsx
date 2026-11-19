/** Remote container: host reads and shared presentation only; no local config, git or action hooks. */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { RemoteAgentDetails, RemoteDetailsCard, RemoteDetailsCardId } from '../../../../shared/remote-agent-details';
import type { ControllerReadResult } from '../../../../shared/controller-chat';
import { DISPATCHER_PROJECT_ID } from '../../../../shared/dispatcher-types';
import { useAnnexClientStore } from '../../../stores/annexClientStore';
import { parseNamespacedId } from '../../../stores/remoteProjectStore';
import { Button } from '../../../components/Button';
import { CardNote, CardRow, DetailsCard, UsageBar } from './DetailsCard';
import { containingDetailsCard, useAgentDetailsStore, useDetailsCardState, type CardId } from './detailsStore';
import { RemoteSettingsCard, type RemoteSettingsResult } from './RemoteSettingsCard';
import type { AgentDetailsProps } from './AgentDetails';
import { SubagentList, subagentSummary } from '../chat/AgentMapPanel';
import { buildAgentMap, formatCost, formatDuration, formatTokens } from '../chat/view-model';
import { DRIVER_LABELS, limitLabel, limitName } from '../chat/ChatHeader';
import { describeSleep, formatAgo } from '../states/format';
import { OtherMachinesList, otherMachinesSummary } from '../../dispatcher/OtherMachinesList';
import { reportedSkillsFor } from './reported-skills';
import { mcpRows } from './McpCard';

type Result = ControllerReadResult<RemoteAgentDetails> | { status: 'loading' };
function resultMessage(status: Result['status']): string {
  switch (status) {
    case 'ok': return '';
    case 'loading': return 'Loading details from the host…';
    case 'offline': return 'Host offline. Reconnect to read current details.';
    case 'unavailable': return 'This host does not share these details, or the agent is no longer available. The host may need an update.';
    case 'forbidden': return 'The host does not allow this details read.';
    case 'rate_limited': return 'The host is busy. Try again shortly.';
    case 'error': return 'Couldn’t read details from the host. Try again.';
  }
}
function Evidence({ card }: { card: RemoteDetailsCard }) {
  return <>
    {card.rows.map((r, i) => <CardRow key={i} label={r.label} labelWidth="wide"><span className="break-words">{r.value}</span></CardRow>)}
    {card.notes.map((note, i) => <CardNote key={i}>{note}</CardNote>)}
    {card.state === 'error' && <CardNote><span role="status">Couldn’t read this section from the host.</span></CardNote>}
    {card.state === 'unsupported' && <CardNote>This host does not support sharing this section.</CardNote>}
    {card.omitted > 0 && <CardNote>{card.omitted} more rows omitted by the host’s display limit. View the complete list on the host.</CardNote>}
  </>;
}

export function RemoteAgentDetailsView({ agent, chat, onShowInStream, missedSubagentId }: AgentDetailsProps) {
  const address = parseNamespacedId(agent.id);
  const project = parseNamespacedId(agent.projectId);
  const satellite = useAnnexClientStore((s) => s.satellites.find((sat) => sat.id === address?.satelliteId));
  const host = satellite?.alias || satellite?.snapshot?.machine?.name || 'the other machine';
  const connected = satellite?.state === 'connected';
  const snapshot = satellite?.snapshot;
  const snapshotUnavailable = satellite?.snapshotUnavailable;
  const dispatcher = !!address && (snapshot?.dispatcher?.agent?.id === address.agentId || project?.agentId === DISPATCHER_PROJECT_ID);
  const [retry, setRetry] = useState(0);
  const [selectedSub, setSelectedSub] = useState<string | null>(null);
  const setOpen = useAgentDetailsStore((s) => s.setOpen);
  const focus = useAgentDetailsStore((s) => s.focus);
  const { openCards, setOpenCards, toggleCard } = useDetailsCardState(agent.id, false);
  const refreshKey = `${agent.id}:${agent.status}:${retry}:${chat?.sessionId ?? ''}:${chat?.turnId ?? ''}:${chat?.workspaceRevision ?? 0}`;
  const [read, setRead] = useState<{ key: string; snapshot: typeof snapshot; result: Result } | null>(null);
  const satelliteId = address?.satelliteId;
  const agentId = address?.agentId;
  useEffect(() => {
    if (!connected || snapshotUnavailable || !satelliteId || !agentId) return;
    let active = true;
    // The view is already behind the user's Details toggle. Coalesce rapid host snapshots/tool events.
    const timer = setTimeout(() => {
      Promise.resolve().then(() => window.clubhouse.annexClient.agentDetails(satelliteId, agentId)).then(
        (result) => { if (active) setRead({ key: refreshKey, snapshot, result }); },
        // telemetry-exempt: a retryable display status, never host error text.
        () => { if (active) setRead({ key: refreshKey, snapshot, result: { status: 'error' } }); },
      );
    }, 150);
    return () => { active = false; clearTimeout(timer); };
  }, [connected, snapshotUnavailable, satelliteId, agentId, refreshKey, snapshot]);
  const result: Result = !connected ? { status: 'offline' } : snapshotUnavailable ? { status: 'error' }
    : read?.key === refreshKey && read.snapshot === snapshot ? read.result : { status: 'loading' };
  const details = result.status === 'ok' ? result.value : null;
  const status = details?.status ?? agent.status;
  const asleep = status === 'sleeping' || status === 'error';
  const card = (id: RemoteDetailsCardId) => details?.cards.find((c) => c.id === id);
  const settingsResult: RemoteSettingsResult = result.status === 'ok'
    ? result.value.settings ? { status: 'ok', value: result.value.settings } : { status: 'error' }
    : result;
  // Retained chat is historical while disconnected and is never presented as a current host read.
  const session = connected && !snapshotUnavailable && !asleep ? chat : undefined;
  const provider = details?.settings?.provider ?? session?.provider ?? 'Not reported by host';
  const map = useMemo(() => chat ? buildAgentMap({ items: chat.items, subagents: chat.subagents, capabilities: chat.capabilities, state: chat.state }) : null, [chat]);
  const showSubagents = !dispatcher && !!map && map.mode !== 'none';
  const focusTarget = focus?.agentId === agent.id ? containingDetailsCard(focus.card) : null;
  const handled = useRef<number | null>(null);
  useEffect(() => {
    if (!focus || focus.agentId !== agent.id || handled.current === focus.nonce) return;
    handled.current = focus.nonce;
    if (focusTarget === 'settings') useAgentDetailsStore.getState().setSettingsOpen(true);
    else if (focusTarget) setOpenCards((s) => new Set(s).add(focusTarget));
    if (focus.subagentId) setSelectedSub(focus.subagentId);
  }, [focus, agent.id, focusTarget, setOpenCards]);
  const open = (id: CardId) => openCards.has(id);
  const basic = (id: RemoteDetailsCardId, title: string) => {
    const c = card(id);
    if (c?.state === 'not-applicable') return null;
    return <DetailsCard key={id} id={id} title={c?.title ?? title} summary={c?.summary || resultMessage(result.status)} open={open(id)} onToggle={() => toggleCard(id)}>
      {c ? <Evidence card={c} /> : <CardNote>{resultMessage(result.status)}</CardNote>}
    </DetailsCard>;
  };
  const stats = session?.usage.session;
  const cost = stats?.costUsd !== undefined ? formatCost(stats.costUsd, stats.costIsEstimate) : null;
  const tokenStats = stats?.tokens ?? session?.usage.turnTotal;
  const tokens = tokenStats?.total ?? ((tokenStats?.input ?? 0) + (tokenStats?.output ?? 0) || undefined);
  const ctx = session?.capabilities && session.capabilities.usage !== 'none' ? session.usage.context : null;
  const ctxPct = ctx && ctx.size > 0 ? Math.min(100, Math.round(ctx.used / ctx.size * 100)) : null;
  const limits = session?.capabilities?.limits ? session.usage.limits : [];
  const skillReport = reportedSkillsFor(agent, chat, details ? { orchestrator: details.providerId } : undefined);
  const reported = skillReport.report;
  const liveMcp = mcpRows(session?.mcpServers ?? null, null, []);
  const otherMachines = snapshot?.dispatcherPresence?.remotes;
  return <aside className="w-[340px] flex-shrink-0 min-h-0 overflow-y-auto flex flex-col gap-2 pt-2.5 pb-3 pr-3.5 pl-1" data-testid="agent-details" aria-label={`${agent.name} details`}
    onKeyDown={(e) => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); setOpen(false); } }}>
    <div className="flex items-center gap-2 px-1 text-xs text-ctp-overlay1"><span className="font-semibold">Details</span><span className="truncate">{agent.name}</span><button type="button" className="ml-auto" aria-label="Hide details" data-testid="agent-details-close" onClick={() => setOpen(false)}>×</button></div>
    <div className="px-1 text-xs text-ctp-overlay1" role="status" data-testid="remote-details-freshness">
      {details ? <>Read from {host} at {new Date(details.readAt).toLocaleTimeString()}. Read-only.</> : resultMessage(result.status)}
      {snapshotUnavailable && ' The host snapshot is unavailable; retained data may be stale.'}
      {['error', 'rate_limited', 'unavailable'].includes(result.status) && <Button kind="ghost" onClick={() => setRetry((n) => n + 1)}>Refresh</Button>}
    </div>
    <RemoteSettingsCard agent={{ ...agent, status }} chat={session} result={settingsResult}>{card('settings') && <Evidence card={card('settings')!} />}</RemoteSettingsCard>
    {!dispatcher && basic('changes', 'Changes')}
    {!dispatcher && agent.kind === 'durable' && !agent.parentAgentId && basic('dispatcher', 'Dispatcher')}
    {!dispatcher && agent.kind === 'durable' && basic('orchestrate', 'Orchestration')}
    {showSubagents && chat && map && <DetailsCard id="subagents" title="Subagents" summary={subagentSummary(map)} open={open('subagents')} onToggle={() => toggleCard('subagents')}>
      {(!connected || asleep || snapshotUnavailable) && <CardNote>Last loaded session snapshot. Current subagent status is not confirmed.</CardNote>}
      <SubagentList agent={agent} state={chat} map={map} selected={selectedSub} onSelect={setSelectedSub} onShowInStream={(id) => onShowInStream?.(id)} missedSubagentId={missedSubagentId} />
    </DetailsCard>}
    {basic('connections', 'Connections')}
    {dispatcher && <DetailsCard id="other-machines" title="Other machines" summary={otherMachines ? otherMachinesSummary(otherMachines) : 'not shared here'} open={open('other-machines')} onToggle={() => toggleCard('other-machines')}>
      {!connected && <CardNote>Last host snapshot; these states may be stale while offline.</CardNote>}
      {otherMachines ? <OtherMachinesList compact remotes={otherMachines} /> : <CardNote>The host hasn’t shared its other machines here.</CardNote>}
    </DetailsCard>}
    {basic('actions', 'Actions')}
    {!dispatcher && <DetailsCard id="skills-mcp" title="Skills and MCP" summary={asleep ? 'last session evidence' : 'connections and session reports'} open={open('skills-mcp')} onToggle={() => toggleCard('skills-mcp')}>
      {card('skills-mcp') ? <Evidence card={card('skills-mcp')!} /> : <CardNote>{resultMessage(result.status)}</CardNote>}
      {liveMcp.rows.map((m) => <CardRow key={m.name} label={m.name}>{m.status}{m.reason ? ` · ${m.reason}` : ''}</CardRow>)}
      {reported && <>
        <CardNote>{asleep || !connected ? 'Last session snapshot.' : 'Session snapshot.'} Provider-reported names do not prove a skill was used or executed. Filesystem scope and origin are not reported.</CardNote>
        <CardRow label="Source">Claude · system/init</CardRow><CardRow label="Session">{reported.sessionId}</CardRow><CardRow label="Native session">{reported.nativeSessionId}</CardRow><CardRow label="Reported">{new Date(reported.reportedAt).toLocaleString()}</CardRow>
        {reported.names?.length ? reported.names.map((name) => <CardRow key={name} label="Reported skill">{name}</CardRow>) : <CardNote>{reported.names ? 'Claude explicitly reported no skills in this snapshot.' : 'Skill names were not reported in this snapshot.'}</CardNote>}
      </>}
      {!reported && <CardNote>{skillReport.supported ? 'No valid skills report for this session has arrived.' : 'This provider does not report loaded skill names here.'}</CardNote>}
    </DetailsCard>}
    {!dispatcher && <DetailsCard id="session" title={asleep ? 'Last session' : 'Session'} summary={cost ?? ''} open={open('session')} onToggle={() => toggleCard('session')}>
      <CardRow label="Runs on">{provider}{session?.driver ? ` · ${DRIVER_LABELS[session.driver] ?? session.driver}${session.cliVersion ? ` ${session.cliVersion}` : ''}` : agent.executionMode === 'pty' ? ' · CLI' : ''}</CardRow>
      {!asleep && <CardRow label="Usage">{cost || tokens ? [cost, tokens ? `${formatTokens(tokens)} tokens` : null].filter(Boolean).join(' · ') : session ? 'Not reported in the loaded session snapshot' : 'Not reported in the CLI view'}</CardRow>}
      {status === 'running' && details?.spawnedAt && <CardRow label="Running">{formatDuration(Math.max(0, Date.now() - details.spawnedAt))}</CardRow>}
      {ctx && ctxPct !== null && <section aria-label="Context window" data-testid="details-session-context"><CardRow label="Context window" labelWidth="wide">{ctxPct}% of {formatTokens(ctx.size)}{ctx.window === 'input' ? ' input' : ''}</CardRow><div className="pr-3.5 pl-[33px] py-1 text-xs"><UsageBar pct={ctxPct} /><p>{formatTokens(ctx.used)} of {formatTokens(ctx.size)} {ctx.window === 'input' ? 'input ' : ''}tokens</p>{ctx.window === 'input' && <p>{provider} reports the room left for input after its output reserve, so its own total can be larger.</p>}<p>{provider} compacts the conversation on its own near the limit.</p></div></section>}
      {limits.length > 0 && <CardRow label="Plan limits"><span className="flex flex-col gap-1">{limits.map((l) => <span key={l.window}>{limitName(l.window)} {limitLabel(l)}{l.resetsAt ? ` · resets ${new Date(l.resetsAt).toLocaleString()}` : ''}</span>)}</span></CardRow>}
      {asleep && agent.lastSleep && <><CardRow label="Ended">{formatAgo(Date.parse(agent.lastSleep.at))}</CardRow><CardRow label="Why">{describeSleep(agent.lastSleep)}</CardRow></>}
      {card('session') ? <Evidence card={card('session')!} /> : <CardNote>{resultMessage(result.status)}</CardNote>}
    </DetailsCard>}
    {!dispatcher && basic('canvases', 'Canvases')}
  </aside>;
}
