import { useRef, useState } from 'react';
import type { Agent } from '../../../../shared/types';
import type { RemoteAgentDetails } from '../../../../shared/remote-agent-details';
import type { ChatEvent } from '../../../../shared/chat';
import { isChatDetailsValue } from '../../../../shared/chat/details-evidence';
import { readProviderSkills, reportedSkillNames } from '../../../../shared/chat/provider-skills';
import { reportedMcpToolNames } from '../../../../shared/chat/provider-inventory';
import { sameRemoteSessionHistoryBinding, type RemoteSessionHistoryBinding } from '../../../../shared/remote-session-history';
import { DISPATCHER_PROJECT_ID } from '../../../../shared/dispatcher-types';
import { useAnnexClientStore } from '../../../stores/annexClientStore';
import { parseNamespacedId } from '../../../stores/remoteProjectStore';
import { remoteTranscriptRevision, useChatStore } from '../../../stores/chatStore';
import { CardNote } from './DetailsCard';
import { remoteDetailsAddress } from './remote-details-address';
import { REMOTE_HISTORY_PAGE_LIMIT, remoteSessionHistoryPage, type RemoteHistoryPage } from './remote-session-history-page';

const text = (value: unknown): value is string => typeof value === 'string' && !!value && value.length <= 512 && !Array.from(value).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
function Names({ label, names }: { label: string; names: string[] | null | undefined }) {
  const [offset, setOffset] = useState(0);
  return <div>
    {names === undefined ? `${label}: not reported in this event.` : names === null ? `${label}: unavailable or malformed.` : !names.length ? `${label}: explicitly empty.` : <>
      <p>{label}: {names.length} reported names; {offset + 1}–{Math.min(offset + 50, names.length)} shown.</p>
      <ul aria-label={label}>{names.slice(offset, offset + 50).map((name, index) => <li key={offset + index}>{name}</li>)}</ul>
      {names.length > 50 && <><button type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>Previous names</button>{' '}<button type="button" disabled={offset + 50 >= names.length} onClick={() => setOffset(offset + 50)}>Next names</button></>}
    </>}
  </div>;
}

/** Selected archived reports only; no raw args/prompts, invented totals or live-state overlay. */
function Report({ event, binding, childTools }: { event: ChatEvent; binding: RemoteSessionHistoryBinding; childTools: Set<string> }) {
  const data = event.data;
  if ('truncated' in data) return <p>This archived event was shortened by the host; its fields remain partial.</p>;
  if (event.type === 'subagent') {
    if (binding.subagents === 'none') return null;
    if (binding.subagents === 'ids_only') return text(event.data.subagentId) ? <p>Child thread: {event.data.subagentId}. Name and status are not reported by this capability.</p> : <p>Child thread identity unavailable.</p>;
    if (!isChatDetailsValue('subagents', [data])) return <p>Child report unavailable or outside display limits.</p>;
    const s = event.data;
    return <p>Child report: {s.name} · {s.status}{s.toolCount !== undefined && ` · ${s.toolCount} tools`}{s.usage?.total !== undefined && ` · ${s.usage.total} tokens`}. Earlier activity may be on another page.</p>;
  }
  if (event.type === 'tool_call' && binding.subagents !== 'none' && text(event.data.subagentId)) return <p>Child activity: {event.data.subagentId} · {text(event.data.kind) ? event.data.kind : 'tool'}{text(event.data.status) && ` · ${event.data.status}`}.</p>;
  if (event.type === 'tool_call_update' && binding.subagents !== 'none' && childTools.has(event.data.toolCallId)) return <p>Child tool update{text(event.data.status) && ` · ${event.data.status}`}{number(event.data.durationMs) && ` · ${event.data.durationMs} ms`}. Only this page’s observed activity is covered.</p>;
  if ((event.type === 'agent_message' || event.type === 'agent_thought') && binding.subagents !== 'none' && text(event.data.subagentId)) return <p>Child {event.type === 'agent_message' ? 'message' : 'activity'} recorded for {event.data.subagentId}. Text is not included in this summary.</p>;
  if (event.type === 'model_changed') return <p>Model report: {text(event.data.modelId) ? event.data.modelId : 'not reported'}{text(event.data.effort) && ` · effort ${event.data.effort}`}.</p>;
  if (event.type === 'usage') return <p>Usage report: {event.data.scope === 'turn' ? 'turn' : 'session'}{number(event.data.tokens?.total) ? ` · ${event.data.tokens.total} tokens` : ' · token total not reported'}{number(event.data.costUsd) && ` · $${event.data.costUsd}`}. Coverage is this recorded report; no totals are added across pages.</p>;
  if (event.type !== 'session_info') return null;
  const d = event.data;
  const skills = d.providerSkills === undefined ? undefined : readProviderSkills(d.providerSkills);
  const skillBound = skills && skills.provider === binding.providerId && skills.driver === binding.driver && skills.nativeSessionId === binding.nativeSessionId;
  const inventory = d.providerInventory;
  const inventoryBound = inventory && inventory.provider === binding.providerId && inventory.driver === binding.driver && inventory.nativeSessionId === binding.nativeSessionId
    && (inventory.provider === 'claude-code' && ['claude_agent_sdk', 'claude_stream_json'].includes(inventory.driver) && inventory.source === 'system/init'
      || inventory.provider === 'copilot' && inventory.driver === 'copilot_sdk' && inventory.source === 'session.skills_loaded');
  return <>
    {d.cliVersion !== undefined && <p>CLI version: {text(d.cliVersion) ? d.cliVersion : 'unavailable'}.</p>}
    {d.model !== undefined && <p>Model: {d.model === null ? 'provider default; exact model unknown' : text(d.model) ? d.model : 'unavailable'}.</p>}
    {d.providerSkills !== undefined && <Names label="Archived skill names" names={skillBound ? skills.names : null} />}
    {inventory !== undefined && <><Names label="Archived inventory skills" names={!inventoryBound ? null : inventory.skills === undefined ? undefined : reportedSkillNames(inventory.skills)} /><Names label="Archived model-visible MCP tools" names={!inventoryBound ? null : inventory.mcpTools === undefined ? undefined : reportedMcpToolNames(inventory.mcpTools)} /></>}
    {d.mcpServers !== undefined && <Names label="Archived MCP connection names" names={Array.isArray(d.mcpServers) && d.mcpServers.length <= 2048 && d.mcpServers.every((m) => m && text(m.name)) ? d.mcpServers.map((m) => m.name) : null} />}
  </>;
}

function Reports({ page, binding }: { page: RemoteHistoryPage; binding: RemoteSessionHistoryBinding }) {
  const [offset, setOffset] = useState(0);
  const childTools = new Set(page.events.filter((e) => e.type === 'tool_call' && text(e.data.subagentId)).map((e) => e.type === 'tool_call' ? e.data.toolCallId : ''));
  const reports = page.events.filter((e) => ['session_info', 'model_changed', 'usage'].includes(e.type)
    || binding.subagents !== 'none' && (e.type === 'subagent' || e.type === 'tool_call' && text(e.data.subagentId)
      || e.type === 'tool_call_update' && childTools.has(e.data.toolCallId)
      || (e.type === 'agent_message' || e.type === 'agent_thought') && text(e.data.subagentId)));
  return <div className="pr-3.5 pl-[33px] text-xs break-words" data-testid="remote-history-reports">
    <p>{reports.length} provider or child report events in this page. No facts from other pages are inferred.</p>
    {page.events.some((event) => 'truncated' in event.data || event.type === 'notice' && event.data.code === 'event_omitted') && <p>The host shortened or omitted some recorded events. Reading to the page end does not recover those fields.</p>}
    {binding.subagents === 'none' && <p>The provider does not expose child details with its current capability.</p>}
    {!reports.length && <p>No provider or child reports are present in this event page; other pages and unrecorded facts remain unknown.</p>}
    {reports.slice(offset, offset + 50).map((event) => <section key={event.seq} aria-label={`Archived report ${event.seq}`}><p>Recorded {new Date(event.ts).toLocaleString()} · event {event.seq}</p><Report event={event} binding={binding} childTools={childTools} /></section>)}
    {reports.length > 50 && <><button type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>Previous reports</button>{' '}<button type="button" disabled={offset + 50 >= reports.length} onClick={() => setOffset(offset + 50)}>Next reports</button></>}
  </div>;
}

export function RemoteSessionHistory({ agent, details, ready, generation }: { agent: Agent; details: RemoteAgentDetails | null; ready: boolean; generation: number }) {
  const address = remoteDetailsAddress(agent.id), project = parseNamespacedId(agent.projectId);
  const satellite = useAnnexClientStore((s) => s.satellites.find((host) => host.id === address?.satelliteId));
  const receipt = useChatStore((s) => s.remoteReadReceipts[agent.id]);
  const evidence = details?.providerEvidence;
  const expected: RemoteSessionHistoryBinding | undefined = evidence && evidence.nativeSessionId && evidence.values.capabilities ? {
    version: 1, projectId: project?.agentId ?? '', agentId: address?.agentId ?? '', sessionId: evidence.sessionId, providerId: evidence.providerId,
    driver: evidence.driver, nativeSessionId: evidence.nativeSessionId, displayRunId: evidence.runId, startSeq: evidence.startSeq, subagents: evidence.values.capabilities.subagents,
  } : undefined;
  const eligible = ready && agent.kind === 'durable' && project?.satelliteId === address?.satelliteId && project?.agentId !== DISPATCHER_PROJECT_ID
    && satellite?.state === 'connected' && !satellite.snapshotUnavailable && !!expected && !!receipt?.historyBinding
    && receipt.snapshot === satellite.snapshot && receipt.revision === remoteTranscriptRevision(agent.id)
    && sameRemoteSessionHistoryBinding(expected, receipt.historyBinding);
  const key = `${agent.id}:${agent.projectId}:${generation}:${eligible}:${receipt?.revision}:${expected ? JSON.stringify(expected) : ''}`;
  const fence = useRef({ key, snapshot: satellite?.snapshot, receipt });
  if (fence.current.key !== key || fence.current.snapshot !== satellite?.snapshot || fence.current.receipt !== receipt) fence.current = { key, snapshot: satellite?.snapshot, receipt };
  const selection = fence.current;
  const pending = useRef<typeof selection | null>(null);
  const [read, setRead] = useState<{ selection: typeof selection; status: 'loading' | 'ok' | 'error'; page?: RemoteHistoryPage; cursor: number; newer: number[] } | null>(null);
  const current = eligible && read?.selection === selection ? read : null;
  const initialCursor = receipt?.nextBeforeSeq;
  const cursor = current?.page?.nextBeforeSeq ?? (current?.page ? null : initialCursor);
  const canRead = eligible && typeof cursor === 'number' && cursor > expected!.startSeq;
  const load = async (beforeSeq: number, newer: number[]) => {
    if (!eligible || !address || !expected || pending.current === selection) return;
    pending.current = selection;
    const stillSelected = () => fence.current === selection && useChatStore.getState().remoteReadReceipts[agent.id] === receipt
      && receipt?.revision === remoteTranscriptRevision(agent.id) && useAnnexClientStore.getState().satellites.some((host) => host.id === address.satelliteId && host.state === 'connected' && !host.snapshotUnavailable && host.snapshot === selection.snapshot);
    setRead({ selection, status: 'loading', cursor: beforeSeq, newer });
    try {
      const value = await window.clubhouse.annexClient.chatPage(address.satelliteId, address.agentId, { beforeSeq, limit: REMOTE_HISTORY_PAGE_LIMIT });
      if (!stillSelected()) return;
      const page = remoteSessionHistoryPage(value, expected, beforeSeq);
      setRead(page ? { selection, status: 'ok', page, cursor: beforeSeq, newer } : { selection, status: 'error', cursor: beforeSeq, newer: [] });
    } catch { // telemetry-exempt: archive denial/error withholds prior private evidence; never show host error text
      if (stillSelected()) setRead({ selection, status: 'error', cursor: beforeSeq, newer: [] });
    } finally { if (pending.current === selection) pending.current = null; }
  };
  return <section aria-label="Older session history" data-testid="remote-session-history">
    <CardNote>Older reports are separate from current provider facts. Only recorded events from this runtime open can be read; earlier resumed history and provider display omissions are not declared complete.</CardNote>
    {!eligible ? <CardNote>This host cannot confirm older history belongs to the selected project and current session. Earlier facts remain unavailable.</CardNote>
      : initialCursor === undefined ? <CardNote>This host has not supplied a history cursor. Earlier reports remain partial.</CardNote>
        : <>
          {current?.status === 'loading' && <CardNote>Reading one older event page…</CardNote>}
          {current?.status === 'error' && <CardNote>Older history was refused, changed or unavailable. Previous archived evidence is withheld; refresh Details before trying again.</CardNote>}
          {current?.page && <Reports key={`${key}:${current.cursor}`} page={current.page} binding={expected!} />}
          {(current?.page?.atRunStart || initialCursor === null || typeof initialCursor === 'number' && initialCursor <= expected!.startSeq) && <CardNote>No earlier events were reported within this runtime open. This does not confirm complete resumed history or recover unrecorded provider facts.</CardNote>}
          {canRead && current?.status !== 'error' && <button type="button" disabled={current?.status === 'loading'} className="pl-[33px] text-xs" onClick={() => void load(cursor!, current?.page ? [...current.newer, current.cursor].slice(-32) : [])}>{current?.page ? 'Read older page' : 'Read older session history'}</button>}
          {!!current?.newer.length && current.status !== 'loading' && current.status !== 'error' && <button type="button" className="pl-[33px] text-xs" onClick={() => void load(current.newer[current.newer.length - 1], current.newer.slice(0, -1))}>Read newer page</button>}
        </>}
  </section>;
}
