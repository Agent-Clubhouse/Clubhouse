import { useEffect, useRef, useState } from 'react';
import type { Agent } from '../../../../shared/types';
import type { RemoteAgentDetails } from '../../../../shared/remote-agent-details';
import type { RemoteHelperRow } from '../../../../shared/remote-helper-page';
import type { ControllerReadResult } from '../../../../shared/controller-chat';
import { useAnnexClientStore } from '../../../stores/annexClientStore';
import { useRemoteProjectStore } from '../../../stores/remoteProjectStore';
import { remoteDetailsAddress } from './remote-details-address';
import { DetailsCard, CardNote } from './DetailsCard';
import { Evidence } from './RemoteDetailsEvidence';
import { openRemoteHelper, remoteHelperOpenUnavailable } from './remote-helper-navigation';
type Result = ControllerReadResult<RemoteAgentDetails> | { status: 'loading' };
const statusLabel: Record<RemoteHelperRow['status'], string> = { disposed: 'Disposed', 'handed-off': 'Handed off', creating: 'Starting', failed: 'Failed', running: 'Running', 'needs-you': 'Needs you', waking: 'Starting', 'not-running': 'Not running', unknown: 'Runtime state unavailable' };
const message = (status: Result['status']) => status === 'forbidden' ? 'The host does not allow this helper read.' : status === 'offline' ? 'Host offline. Reconnect to read helpers.' : status === 'unavailable' ? 'This host does not support selected helper pages.' : status === 'error' ? 'Couldn’t read this helper page. Refresh to try again.' : status === 'rate_limited' ? 'The host is busy. Try again shortly.' : 'Loading helpers from the host…';
const policyLabels = new Set(['Orchestration', 'Helpers get', 'Control', 'At once', 'App-wide limit', 'Cross-project helpers', 'Auto provider', 'Helper access ceiling']);
export function RemoteHelpersCard({ agent, details, status, freshnessKey, open, onToggle }: {
  agent: Agent; details: RemoteAgentDetails | null; status: Result['status']; freshnessKey: string; open: boolean; onToggle(): void;
}) {
  const address = remoteDetailsAddress(agent.id), host = useAnnexClientStore((s) => s.satellites.find((h) => h.id === address?.satelliteId));
  useRemoteProjectStore((s) => s.remoteAgents);
  const connected = host?.state === 'connected', snapshot = host?.snapshot;
  const transport = useRef({ connected, generation: 0 });
  if (transport.current.connected !== connected) transport.current = { connected, generation: transport.current.generation + 1 };
  const identity = `${agent.id}:${freshnessKey}:${details?.readAt ?? ''}:${transport.current.generation}`;
  const [selection, setSelection] = useState<{ identity: string; offset: number; retry: number } | null>(null);
  const selected = selection?.identity === identity ? selection : null;
  const [response, setResponse] = useState<{ key: string; snapshot: typeof snapshot; result: Result } | null>(null);
  const key = `${identity}:${selected?.offset ?? 0}:${selected?.retry ?? 0}`;
  const eligible = connected && !host?.snapshotUnavailable && status === 'ok' && !!details && details.agentId === address?.agentId;
  useEffect(() => {
    if (!open || !eligible || !selected || !address || details?.helperPages !== 1) return;
    let active = true;
    Promise.resolve().then(() => window.clubhouse.annexClient.agentDetails(address.satelliteId, address.agentId, { card: 'orchestrate', source: 'helpers', offset: selected.offset })).then(
      (result) => { if (active) setResponse({ key, snapshot, result }); },
      // telemetry-exempt: bounded read status replaces raw transport errors.
      () => { if (active) setResponse({ key, snapshot, result: { status: 'error' } }); },
    );
    return () => { active = false; };
  }, [open, eligible, selected, key, snapshot, details?.helperPages, address?.satelliteId, address?.agentId]);
  const result: Result = !connected ? { status: 'offline' } : !eligible ? { status: status === 'ok' ? 'loading' : status } as Result
    : selected ? response?.key === key && response.snapshot === snapshot ? response.result : { status: 'loading' } : { status: 'ok', value: details! };
  const candidate = result.status === 'ok' && result.value.agentId === address?.agentId && (!selected || result.value.helperPageOnly === true) ? result.value.helperPage : undefined;
  const page = candidate?.offset === (selected?.offset ?? 0) ? candidate : undefined;
  const card = eligible ? details?.cards.find((c) => c.id === 'orchestrate') : undefined;
  const [disposedOpen, setDisposedOpen] = useState(false);
  const select = (offset: number) => setSelection({ identity, offset, retry: (selected?.retry ?? 0) + 1 });
  const row = (r: RemoteHelperRow) => {
    const why = page && result.status === 'ok' ? remoteHelperOpenUnavailable(agent, r) : 'Refresh current helper evidence before opening.';
    const failure = r.failure === 'creation' ? 'Couldn’t create its working folder.' : r.failure === 'runtime' ? 'Its CLI reported a failure.' : r.failure === 'unknown' ? 'Runtime failure status unavailable.' : null;
    const work = r.work.state === 'recorded' ? r.work.text : r.work.reason === 'admission-limit' ? 'Work not checked yet. Refresh this page to retry.' : r.work.reason === 'read-failed' ? 'Couldn’t check work.' : r.work.reason === 'identity' ? 'Work unavailable: helper identity unconfirmed.' : 'Work not applicable.';
    return <li key={r.key} className="pl-[33px] pr-3.5 py-1 text-xs" data-testid="remote-helper-row" data-state={r.status}>
      <div className="flex gap-2"><span className="font-medium truncate">{r.name}</span><span className="ml-auto">{statusLabel[r.status]}</span></div>
      <div>{r.projectName ?? 'Project identity unavailable'}</div>
      <div>{[r.branch, r.status === 'disposed' ? r.disposedAt : work].filter(Boolean).join(' · ')}</div>
      {failure && <div>{failure}</div>}
      <button type="button" disabled={!!why} title={why ?? `Open ${r.name} on its host`} className="underline disabled:no-underline" onClick={() => openRemoteHelper(agent, r)}>Open</button>
      {why && <span className="ml-2">{why}</span>}
    </li>;
  };
  if (card?.state === 'not-applicable') return null;
  return <DetailsCard id="orchestrate" title="Orchestration" summary={card?.summary || message(result.status)} open={open} onToggle={onToggle}>
    {card && (!selected || page) && <Evidence card={page ? { ...card, rows: card.rows.filter((r) => policyLabels.has(r.label)), notes: [], omitted: 0 } : card} />}
    {!page ? <CardNote>{result.status === 'ok' ? 'This host shares the legacy helper summary only. Structured helper rows and work pages need a host update.' : message(result.status)}</CardNote> : <>
      <CardNote>{page.liveCount === null ? 'Live helper count unavailable' : `${page.liveCount} live helpers`} · {page.disposedCount === null ? 'Disposed count unavailable' : `${page.disposedCount} disposed`} · {page.pendingCount === null ? 'Pending count unavailable' : `${page.pendingCount} waiting to start`}</CardNote>
      {page.pending.length > 0 && <ul aria-label="Waiting to start">{page.pending.map((r) => <li key={r.key} className="pl-[33px] text-xs"><strong>{r.name}</strong> · Awaiting approval<div>{r.task}</div>{r.warning && <div>{r.warning}</div>}<div>{r.createdAt} · expires {r.expiresAt}</div></li>)}</ul>}
      <ul aria-label="Helpers">{page.rows.filter((r) => r.status !== 'disposed').map(row)}</ul>
      {!!page.disposedCount && <><button type="button" className="pl-[33px] text-xs" aria-expanded={disposedOpen} onClick={() => setDisposedOpen((v) => !v)}>Disposed ({page.disposedCount})</button>{disposedOpen && <><ul aria-label="Disposed helpers">{page.rows.filter((r) => r.status === 'disposed').map(row)}</ul>{!page.rows.some((r) => r.status === 'disposed') && <CardNote>No disposed rows in this page. Continue through the helper pages to read later records.</CardNote>}</>}</>}
      {page.state === 'unavailable' && <CardNote>The selected helper inventory is unavailable. Pending starts are reported independently.</CardNote>}
      {page.notes.map((note) => <CardNote key={note}>{note}</CardNote>)}
      {details?.helperPages === 1 && <div className="flex gap-3 pl-[33px] text-xs"><button type="button" disabled={!page.offset} onClick={() => select(0)}>First helper page</button><button type="button" disabled={!page.offset} onClick={() => select(page.offset - 8)}>Previous helpers</button><button type="button" disabled={page.next === null} onClick={() => page.next !== null && select(page.next)}>Next helpers</button></div>}
    </>}
    {eligible && details?.helperPages === 1 && <button type="button" className="pl-[33px] text-xs" onClick={() => select(selected?.offset ?? 0)}>Refresh helpers</button>}
  </DetailsCard>;
}
