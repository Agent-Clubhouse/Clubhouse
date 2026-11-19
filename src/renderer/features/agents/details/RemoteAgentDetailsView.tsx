import { RemoteActionsEvidence } from './RemoteActionsEvidence';
/** Remote container: host reads and shared presentation only; no local config, git or action hooks. */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { RemoteAgentDetails, RemoteDetailsCardId } from '../../../../shared/remote-agent-details';
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
import { useRemoteDetailsChat } from './useRemoteDetailsChat';
import { CanvasMembershipList } from './CanvasMembershipList';
import { jumpToCanvas, remoteCanvasJumpUnavailable } from './agent-canvases';
import { RemoteChangesCard } from './RemoteChangesCard';
import { Evidence } from './RemoteDetailsEvidence';
import { RemoteQuickSettingsCard } from './RemoteQuickSettingsCard';
import { admittedProviderLabel } from '../../../../shared/provider-display';
import { ProviderEvidenceNotes, ProviderInventory } from './ProviderEvidenceNotes';
import { remoteDetailsAddress } from './remote-details-address';

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

export function RemoteAgentDetailsView({ agent, chat, onShowInStream, missedSubagentId }: AgentDetailsProps) {
  const address = remoteDetailsAddress(agent.id);
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
  const transport = useRef({ connected, snapshotUnavailable, generation: 0 });
  if (transport.current.connected !== connected || transport.current.snapshotUnavailable !== snapshotUnavailable) transport.current = { connected, snapshotUnavailable, generation: transport.current.generation + 1 };
  const refreshKey = `${agent.id}:${agent.status}:${retry}:${chat?.sessionId ?? ''}:${chat?.nativeSessionId ?? ''}:${chat?.turnId ?? ''}:${chat?.workspaceRevision ?? 0}:${transport.current.generation}`;
  const [read, setRead] = useState<{ key: string; snapshot: typeof snapshot; result: Result } | null>(null);
  const satelliteId = address?.satelliteId;
  const agentId = address?.agentId;
  useEffect(() => {
    if (!connected || !satelliteId || !agentId) return;
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
  const received: Result = !address ? { status: 'unavailable' } : !connected ? { status: 'offline' }
    : read?.key === refreshKey && read.snapshot === snapshot ? read.result : { status: 'loading' };
  const result: Result = received.status === 'ok' && received.value.agentId !== agentId ? { status: 'error' } : received;
  const details = result.status === 'ok' ? result.value : null;
  const hydrated = useRemoteDetailsChat(agent.id, details, connected, snapshot, transport.current.generation);
  const runKey = `${agent.id}:${details?.providerId ?? ''}:${details?.sessionId ?? ''}:${details?.nativeSessionId ?? ''}:${details?.spawnedAt ?? ''}:${transport.current.generation}:${details?.providerEvidence?.runId ?? ''}`;
  const suspectRun = useRef<string | null>(null);
  const retriedRun = useRef<string | null>(null);
  const refreshedProviderReport = useRef<string | null>(null);
  useEffect(() => {
    if (!hydrated.providerRefreshSeq || !hydrated.providerRefreshIdentity) return;
    const report = `${hydrated.providerRefreshIdentity}:${hydrated.providerRefreshSeq}`;
    if (refreshedProviderReport.current === report) return;
    refreshedProviderReport.current = report;
    setRetry((n) => n + 1);
  }, [hydrated.providerRefreshSeq, hydrated.providerRefreshIdentity]);
  if (hydrated.stopped && details?.running) suspectRun.current = runKey;
  if (hydrated.chat || details && !details.running) suspectRun.current = null;
  const runtimeUnconfirmed = !!details?.running && suspectRun.current === runKey;
  useEffect(() => {
    if (!hydrated.stopped || !details?.running || retriedRun.current === runKey) return;
    retriedRun.current = runKey;
    setRetry((n) => n + 1);
  }, [hydrated.stopped, details?.running, runKey]);
  const status = details?.status ?? agent.status;
  const asleep = status === 'sleeping' || status === 'error';
  const card = (id: RemoteDetailsCardId) => details?.cards.find((c) => c.id === id);
  const settingsResult: RemoteSettingsResult = result.status === 'ok'
    ? result.value.settings ? { status: 'ok', value: result.value.settings } : { status: 'error' }
    : result;
  // Retained chat is historical while disconnected and is never presented as a current host read.
  const session = details && connected && !asleep && details.running ? hydrated.chat : undefined;
  const quickProvider = agent.kind === 'quick' && !runtimeUnconfirmed ? details?.cards.find((c) => c.id === 'settings')?.rows.find((r) => r.label === 'CLI' || asleep && r.label === 'Last CLI')?.value : undefined;
  const reportedProvider = admittedProviderLabel(session?.provider,
    details?.providerLabel ? { id: details.providerId, label: details.providerLabel } : agent.kind === 'quick' && quickProvider ? { id: details?.providerId, label: quickProvider } : undefined,
    details?.settings ? { id: details.settings.providerId, label: details.settings.provider } : undefined);
  const lastProvider = card('session')?.rows.find((r) => r.label === 'Last CLI')?.value ?? (agent.kind === 'quick' ? quickProvider : undefined) ?? 'Not recorded for the last session';
  const provider = asleep ? lastProvider : runtimeUnconfirmed ? 'Current provider not confirmed' : details?.sessionId && !session && !asleep ? 'Current provider evidence unavailable' : reportedProvider ?? details?.providerLabel ?? quickProvider ?? details?.settings?.provider ?? 'Not reported by host';
  const map = useMemo(() => {
    if (!session) return null;
    const value = buildAgentMap({ items: session.items, subagents: session.subagents, capabilities: session.capabilities, state: session.state });
    if (hydrated.evidence) for (const node of value.nodes) if (!node.items.length && !node.startTs) delete node.durationMs;
    return value;
  }, [session, hydrated.evidence]);
  const showSubagents = !dispatcher && !!map && map.mode !== 'none';
  const requested = focus?.agentId === agent.id ? containingDetailsCard(focus.card) : null;
  const available = new Set<CardId>(['settings', 'connections', 'actions']);
  if (dispatcher) available.add('other-machines');
  else {
    for (const id of ['changes', 'session', 'skills-mcp', 'canvases'] as const) available.add(id);
    if (agent.kind === 'durable') available.add('orchestrate');
    if (agent.kind === 'durable' && !agent.parentAgentId) available.add('dispatcher');
    if (showSubagents) available.add('subagents');
  }
  for (const c of details?.cards ?? []) if (c.state === 'not-applicable') available.delete(c.id);
  const focusTarget = requested && available.has(requested) ? requested : dispatcher ? 'actions' : 'session';
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
      {c ? id === 'canvases' ? <>
        <CanvasMembershipList hits={c.rows.filter((r) => r.canvas).map((r) => ({ ...r.canvas!, name: r.label }))} onJump={(hit) => jumpToCanvas(agent, hit)} unavailable={(hit) => remoteCanvasJumpUnavailable(agent, hit)} />
        <Evidence card={{ ...c, rows: c.rows.filter((r) => !r.canvas) }} />
        {c.rows.some((r) => !r.canvas) && <CardNote>This host shared membership names without navigation identities.</CardNote>}
      </> : id === 'actions' ? <RemoteActionsEvidence card={c} agentName={agent.name} /> : <Evidence card={c} /> : <CardNote>{resultMessage(result.status)}</CardNote>}
    </DetailsCard>;
  };
  const sessionCard = card('session');
  const sessionRows = sessionCard?.rows.map((r) => r.label === 'Ended' && /^\d{4}-\d{2}-\d{2}T/.test(r.value) && Number.isFinite(Date.parse(r.value)) ? { ...r, value: formatAgo(Date.parse(r.value)) } : r);
  const lastSummary = ['Ended', 'Duration', 'Cost'].map((label) => sessionRows?.find((r) => r.label === label)?.value).filter((value) => value && value !== 'Not reported').join(' · ');
  const stats = session?.usage.session;
  const cost = stats?.costUsd !== undefined ? formatCost(stats.costUsd, stats.costIsEstimate) : null;
  const tokenStats = stats?.tokens ?? session?.usage.turnTotal;
  const tokens = tokenStats?.total ?? ((tokenStats?.input ?? 0) + (tokenStats?.output ?? 0) || undefined);
  const ctx = session?.capabilities && session.capabilities.usage !== 'none' ? session.usage.context : null;
  const ctxPct = ctx && ctx.size > 0 ? Math.min(100, Math.round(ctx.used / ctx.size * 100)) : null;
  const limits = session?.capabilities?.limits ? session.usage.limits : [];
  const skillReport = reportedSkillsFor(agent, session, details ? { orchestrator: details.providerId } : undefined);
  const reported = skillReport.report;
  const liveMcp = mcpRows(session?.mcpServers ?? null, null, []);
  const otherMachines = snapshot?.dispatcherPresence?.remotes;
  return <aside className="w-[340px] flex-shrink-0 min-h-0 overflow-y-auto flex flex-col gap-2 pt-2.5 pb-3 pr-3.5 pl-1" data-testid="agent-details" aria-label={`${agent.name} details`}
    onKeyDown={(e) => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); setOpen(false); } }}>
    <div className="flex items-center gap-2 px-1 text-xs text-ctp-overlay1"><span className="font-semibold">Details</span><span className="truncate">{agent.name}</span><button type="button" className="ml-auto" aria-label="Hide details" data-testid="agent-details-close" onClick={() => setOpen(false)}>×</button></div>
    <div className="px-1 text-xs text-ctp-overlay1" role="status" data-testid="remote-details-freshness">
      {!address ? 'The remote agent identity is unavailable. Select it again after the host refreshes.' : details ? <>Read from {host} at {new Date(details.readAt).toLocaleTimeString()}. Read-only.</> : resultMessage(result.status)}
      {snapshotUnavailable && ' The host snapshot is unavailable; retained data may be stale.'}
      {details?.providerEvidenceState === 'unavailable' && <p>The host has no current runtime display report. Earlier session values are withheld. <Button kind="ghost" onClick={() => setRetry((n) => n + 1)}>Refresh provider reports</Button></p>}
      {details?.providerEvidenceState === 'unsupported' && details.sessionId && <p>This host runtime does not share current provider display reports.</p>}
      {hydrated.waiting && <p>{hydrated.loading ? 'Refreshing provider evidence from the host…' : 'Current provider evidence has not been refreshed. Retained session data is withheld.'}</p>}
      {hydrated.partial && <p>{hydrated.evidence ? 'Only part of the host transcript is loaded. Display reports from this runtime open are read separately; earlier stream activity may be missing.' : 'Only part of the host transcript is loaded. Earlier provider reports and subagent activity may be missing.'}</p>}
      {hydrated.evidence && <p>Provider facts observed on the host since this runtime opened, read at {new Date(hydrated.evidence.readAt).toLocaleTimeString()}. {hydrated.evidence.completeFromStart ? 'This runtime open was observed from its start; resumed conversation history is separate.' : 'A native session changed; earlier facts were cleared.'}</p>}
      {hydrated.evidence && <ProviderEvidenceNotes evidence={hydrated.evidence} />}
      {['error', 'rate_limited', 'unavailable'].includes(result.status) && <Button kind="ghost" onClick={() => setRetry((n) => n + 1)}>Refresh</Button>}
    </div>
    {agent.kind === 'quick' ? <RemoteQuickSettingsCard card={card('settings')} session={session} runtimeUnconfirmed={runtimeUnconfirmed} message={resultMessage(result.status)} /> : <RemoteSettingsCard agent={{ ...agent, status }} chat={session} currentProvider={details?.providerLabel ? { id: details.providerId, label: details.providerLabel } : undefined} runtimeUnconfirmed={runtimeUnconfirmed} result={result.status === 'unavailable' ? undefined : settingsResult} onRetry={() => setRetry((n) => n + 1)}>{card('settings') && <Evidence card={card('settings')!} />}</RemoteSettingsCard>}

    {!dispatcher && <RemoteChangesCard agent={agent} details={details} status={result.status} freshnessKey={refreshKey} open={open('changes')} onToggle={() => toggleCard('changes')} />}
    {!dispatcher && agent.kind === 'durable' && !agent.parentAgentId && basic('dispatcher', 'Dispatcher')}
    {!dispatcher && agent.kind === 'durable' && basic('orchestrate', 'Orchestration')}
    {showSubagents && session && map && <DetailsCard id="subagents" title="Subagents" summary={subagentSummary(map)} open={open('subagents')} onToggle={() => toggleCard('subagents')}>
      {(!connected || asleep || snapshotUnavailable) && <CardNote>Last loaded session snapshot. Current subagent status is not confirmed.</CardNote>}
      {hydrated.evidence && !hydrated.evidence.values.subagents && <CardNote>No subagent report has arrived in this runtime open. Earlier conversation activity is separate.</CardNote>}
      {hydrated.evidence && hydrated.partial && <CardNote>Provider-reported subagents include this runtime’s earlier reports. Tool activity and timings still depend on the loaded transcript and may be incomplete.</CardNote>}
      <SubagentList agent={agent} state={session} map={map} selected={selectedSub} onSelect={setSelectedSub} onShowInStream={(id) => onShowInStream?.(id)} missedSubagentId={missedSubagentId} />
    </DetailsCard>}
    {basic('connections', 'Connections')}
    {dispatcher && <DetailsCard id="other-machines" title="Other machines" summary={otherMachines ? otherMachinesSummary(otherMachines) : 'not shared here'} open={open('other-machines')} onToggle={() => toggleCard('other-machines')}>
      {(!connected || snapshotUnavailable) && <CardNote>Last host snapshot; these states may be stale.</CardNote>}
      {otherMachines ? <OtherMachinesList compact remotes={otherMachines} /> : <CardNote>{host} hasn’t shared its other machines here.</CardNote>}
    </DetailsCard>}
    {basic('actions', 'Actions')}
    {!dispatcher && <DetailsCard id="skills-mcp" title="Skills and MCP" summary={asleep ? 'last session evidence' : 'connections and session reports'} open={open('skills-mcp')} onToggle={() => toggleCard('skills-mcp')}>
      {runtimeUnconfirmed && <CardNote>The session stopped or reported an error after the host read. Current MCP status is unconfirmed.</CardNote>}
      {card('skills-mcp') ? <Evidence card={runtimeUnconfirmed ? { ...card('skills-mcp')!, rows: card('skills-mcp')!.rows.filter((r) => r.label !== 'Clubhouse MCP') } : card('skills-mcp')!} /> : <CardNote>{resultMessage(result.status)}</CardNote>}
      {hydrated.evidence && hydrated.evidence.values.mcpServers === undefined && <CardNote>The provider has not reported its MCP connections in this runtime open.</CardNote>}
      {hydrated.evidence?.values.mcpServers?.length === 0 && <CardNote>The provider explicitly reported no MCP connections.</CardNote>}
      <ProviderInventory evidence={hydrated.evidence} />
      {liveMcp.rows.map((m) => <CardRow key={m.name} label={m.name}>{m.status}{m.reason ? ` · ${m.reason}` : ''}</CardRow>)}
      {reported && <>
        <CardNote>{asleep || !connected ? 'Last session snapshot.' : 'Session snapshot.'} Provider-reported names do not prove a skill was used or executed. Filesystem scope and origin are not reported.</CardNote>
        <CardRow label="Source">Claude · system/init</CardRow><CardRow label="Session">{reported.sessionId}</CardRow><CardRow label="Native session">{reported.nativeSessionId}</CardRow><CardRow label="Reported">{new Date(reported.reportedAt).toLocaleString()}</CardRow>
        {reported.names?.length ? reported.names.map((name) => <CardRow key={name} label="Reported skill">{name}</CardRow>) : <CardNote>{reported.names ? 'Claude explicitly reported no skills in this snapshot.' : 'Skill names were not reported in this snapshot.'}</CardNote>}
      </>}
      {!reported && <CardNote>{!details || !session ? 'Provider evidence is unavailable until a current authorized session read succeeds.' : skillReport.supported ? 'No valid skills report for this session has arrived.' : 'This provider does not report loaded skill names here.'}</CardNote>}
    </DetailsCard>}
    {!dispatcher && <DetailsCard id="session" title={asleep ? 'Last session' : 'Session'} summary={asleep ? lastSummary : cost ?? ''} open={open('session')} onToggle={() => toggleCard('session')}>
      <CardRow label="Runs on">{provider}{session?.driver ? ` · ${DRIVER_LABELS[session.driver] ?? session.driver}${session.cliVersion ? ` ${session.cliVersion}` : ''}` : agent.executionMode === 'pty' ? ' · CLI' : ''}</CardRow>
      {!asleep && <CardRow label="Usage">{cost || tokens ? [cost, tokens ? `${formatTokens(tokens)} tokens` : null].filter(Boolean).join(' · ') : session ? 'Not reported in the loaded session snapshot' : agent.executionMode === 'pty' && details?.settings?.runtime === 'terminal' ? 'Not reported in the CLI view' : 'Current usage is not available from the host'}</CardRow>}
      {hydrated.evidence?.values.turnTotal && !hydrated.evidence.values.sessionUsage?.tokens && <CardNote>Token sums cover completed turns observed since this runtime opened. Earlier resumed conversation usage is separate.</CardNote>}
      {!runtimeUnconfirmed && status === 'running' && details?.spawnedAt && <CardRow label="Running">{formatDuration(Math.max(0, Date.now() - details.spawnedAt))}</CardRow>}
      {ctx && ctxPct !== null && <section aria-label="Context window" data-testid="details-session-context"><CardRow label="Context window" labelWidth="wide">{ctxPct}% of {formatTokens(ctx.size)}{ctx.window === 'input' ? ' input' : ''}</CardRow><div className="pr-3.5 pl-[33px] py-1 text-xs"><UsageBar pct={ctxPct} /><p>{formatTokens(ctx.used)} of {formatTokens(ctx.size)} {ctx.window === 'input' ? 'input ' : ''}tokens</p>{ctx.window === 'input' && <p>{provider} reports the room left for input after its output reserve, so its own total can be larger.</p>}<p>{provider} compacts the conversation on its own near the limit.</p></div></section>}
      {limits.length > 0 && <CardRow label="Plan limits"><span className="flex flex-col gap-1">{limits.map((l) => <span key={l.window}>{limitName(l.window)} {limitLabel(l)}{l.resetsAt ? ` · resets ${new Date(l.resetsAt).toLocaleString()}` : ''}</span>)}</span></CardRow>}
      {asleep && !details && agent.lastSleep && <><CardNote>Last loaded host snapshot; these sleep fields may be stale.</CardNote><CardRow label="Ended">{formatAgo(Date.parse(agent.lastSleep.at))}</CardRow><CardRow label="Why">{describeSleep(agent.lastSleep)}</CardRow></>}
      {runtimeUnconfirmed && <CardNote>Current run state is not confirmed. Refreshing the host’s lifecycle evidence.</CardNote>}
      {sessionCard ? <Evidence card={{ ...sessionCard, rows: (sessionRows ?? []).filter((r) => !runtimeUnconfirmed || r.label !== 'Status') }} /> : <CardNote>{resultMessage(result.status)}</CardNote>}
    </DetailsCard>}
    {!dispatcher && basic('canvases', 'Canvases')}
  </aside>;
}
