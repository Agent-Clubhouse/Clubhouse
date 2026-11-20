import { useCallback, useEffect, useState } from 'react';
import type { Agent } from '../../../../shared/types';
import type { RemoteAgentDetails } from '../../../../shared/remote-agent-details';
import type { ControllerReadResult } from '../../../../shared/controller-chat';
import type { RemoteAgentChanges, RemoteChangesScope } from '../../../../shared/remote-agent-changes';
import { remoteChangesDiffstat } from '../../../../shared/remote-agent-changes';
import { remoteDetailsAddress } from './remote-details-address';
import { useAnnexClientStore } from '../../../stores/annexClientStore';
import { CardNote, CardRow, DetailsCard, PlusMinus } from './DetailsCard';
import { FileList, type DiffResult } from './ChangesCard';

type Result = ControllerReadResult<RemoteAgentChanges> | { status: 'loading' };
const message = (status: Result['status']) => status === 'offline' ? 'Host offline. Reconnect to read changes.'
  : status === 'forbidden' ? 'The host does not allow this changes read.' : status === 'unavailable' ? 'This host does not share read-only changes here. It may need an update.'
    : status === 'error' ? 'Couldn’t read changes from the host. Refresh to try again.' : status === 'rate_limited' ? 'The host is busy. Try again shortly.' : 'Loading changes from the host…';
const patchMessage: Record<string, string> = { filtered: 'This file uses a custom Git filter. Passive Details does not run it; compare it on the host.', binary: 'Binary file; no text diff.', unsafe: 'This path or its content could not be safely shared. File counts remain available; compare the text on the host.', 'too-large': 'This comparison exceeds the host’s bounded diff limit.', unreadable: 'The host could not read this file. No empty diff is inferred.', directory: 'This path is a directory; its contents were not read as a file.', submodule: 'Nested repository; a text diff is not available here.', budget: 'The host’s comparison read limit was reached.', unchanged: 'The file no longer differs from this base.', stale: 'The change selection moved. Refresh changes to select the current file.' };

function ChangesDiffstat({ value }: { value: RemoteAgentChanges }) {
  const counts = value.diffstat ?? remoteChangesDiffstat(value.files);
  const pageOnly = !value.diffstat && (value.offset !== 0 || value.nextOffset !== null || value.files.length !== value.totalFiles);
  const partial = pageOnly || value.uncompared > 0 || !counts || counts.knownFiles !== value.totalFiles;
  const unavailable = !counts || counts.knownFiles === 0 && (value.totalFiles > 0 || value.uncompared > 0);
  return <>{value.totalFiles} paths · {unavailable ? 'line counts unavailable' : <><PlusMinus added={counts.additions} removed={counts.deletions} />{pageOnly ? ' on this page' : partial ? ' known' : ''}</>}{partial && ' · partial'}</>;
}

export function RemoteChangesCard({ agent, details, status, freshnessKey, open, onToggle }: { agent: Agent; details: RemoteAgentDetails | null; status: Result['status']; freshnessKey: string; open: boolean; onToggle: () => void }) {
  const address = remoteDetailsAddress(agent.id);
  const satelliteId = address?.satelliteId, agentId = address?.agentId;
  const satellite = useAnnexClientStore((s) => s.satellites.find((h) => h.id === satelliteId));
  const connected = satellite?.state === 'connected';
  const snapshot = satellite?.snapshot;
  const [scope, setScope] = useState<RemoteChangesScope>('branch');
  const [offset, setOffset] = useState(0);
  const [retry, setRetry] = useState(0);
  const key = `${agent.id}:${freshnessKey}:${details?.readAt ?? ''}:${scope}:${offset}:${retry}`;
  const [read, setRead] = useState<{ key: string; snapshot: typeof snapshot; result: Result } | null>(null);
  const eligible = connected && !!details && details.agentId === agentId && status === 'ok';
  useEffect(() => {
    if (!eligible || !satelliteId || !agentId) return;
    let active = true;
    Promise.resolve().then(() => window.clubhouse.annexClient.agentChanges(satelliteId, agentId, { scope, offset })).then(
      (result) => { if (active) setRead({ key, snapshot, result }); },
      // telemetry-exempt: read status only; host error text never enters the view.
      () => { if (active) setRead({ key, snapshot, result: { status: 'error' } }); },
    );
    return () => { active = false; };
  }, [eligible, key, snapshot, satelliteId, agentId, scope, offset]);
  const result: Result = !address ? { status: 'unavailable' } : !connected ? { status: 'offline' } : details && details.agentId !== agentId ? { status: 'error' } : !eligible ? { status: status === 'ok' ? 'loading' : status } as Result
    : read?.key === key && read.snapshot === snapshot ? read.result : { status: 'loading' };
  const value = result.status === 'ok' && result.value.agentId === agentId && result.value.scope === scope ? result.value : null;
  const loadDiff = useCallback(async (fileKey: string): Promise<DiffResult> => {
    if (!eligible || !satelliteId || !agentId) return { unavailable: message(connected ? status : 'offline') };
    const response = await window.clubhouse.annexClient.agentChanges(satelliteId, agentId, { scope, fileKey });
    if (response.status !== 'ok') return { unavailable: message(response.status) };
    const patch = response.value.patch;
    if (response.value.agentId !== agentId || response.value.scope !== scope || patch?.fileKey !== fileKey) return { unavailable: 'The host did not return the selected file evidence.' };
    const selected = value?.files.find((f) => f.fileKey === fileKey);
    const notice = [selected?.status === 'renamed' && selected.oldPath ? `Rename: ${selected.oldPath} → ${selected.path}.` : '', patch.redacted ? 'Sensitive values were redacted; line positions may differ.' : ''].filter(Boolean).join(' ');
    return patch.state === 'text' && patch.text ? { type: 'diff', path: selected?.path ?? '', unifiedDiff: patch.text, ...(notice && { notice }) }
      : { unavailable: patchMessage[patch.state] ?? 'No text diff was reported by the host.' };
  }, [eligible, connected, status, satelliteId, agentId, scope, value, key, snapshot]);
  const statusMessage = !address ? 'The remote agent identity is unavailable. Select it again after the host refreshes.' : message(result.status);
  const summary = value?.state === 'ok' ? <ChangesDiffstat value={value} /> : details?.cards.find((c) => c.id === 'changes')?.summary || statusMessage;
  const legacy = eligible && result.status === 'unavailable' ? details?.cards.find((c) => c.id === 'changes') : null;
  return <DetailsCard id="changes" title="Changes" summary={summary} open={open} onToggle={onToggle}>
    <div className="flex gap-2 pl-[33px] pr-3.5 pb-1">{(['branch', 'session', 'turn'] as const).map((s) => <button type="button" key={s} aria-pressed={scope === s} onClick={() => { setScope(s); setOffset(0); }} className="text-xs text-ctp-overlay1 hover:text-ctp-text">{s === 'branch' ? 'Branch' : s === 'session' ? 'Session' : 'Last turn'}</button>)}</div>
    {!value ? <>
      <CardNote>{statusMessage}</CardNote>
      {legacy && <>
        <CardNote>Last authorized host summary at {new Date(details!.readAt).toLocaleTimeString()}. Scoped file diffs and checkpoints are not available through this host.</CardNote>
        {legacy.rows.map((r, i) => <CardRow key={i} label={r.label} labelWidth="wide">{r.value}</CardRow>)}
        {legacy.notes.map((note, i) => <CardNote key={i}>{note}</CardNote>)}
        {legacy.omitted > 0 && <CardNote>{legacy.omitted} more rows omitted by the host’s display limit.</CardNote>}
        {legacy.state === 'error' && <CardNote>The host summary is incomplete because its Changes read failed.</CardNote>}
      </>}
    </> : <>
      {value.state !== 'ok' ? <CardNote>{value.state === 'not-git' ? 'Changes need the agent to work in a git repository.' : value.state === 'no-base' ? 'No main or master branch to compare with.' : value.state === 'no-checkpoint' ? 'No checkpoints recorded for this host session.' : 'This changes scope is not supported by the host for this agent.'}</CardNote> : <>
        {value.base && <CardRow label="Against">{value.base}</CardRow>}
        {value.sessionId && <CardRow label="Session">{value.sessionId}</CardRow>}
        {value.shared && <CardNote>Another agent worked in the same folder during this comparison; its edits may be included.</CardNote>}
        {scope !== 'branch' && <CardNote>{value.live ? scope === 'session' ? 'Compared with the current worktree from the first retained session checkpoint.' : 'Compared with the current worktree.' : 'Compared between the saved turn checkpoints.'}</CardNote>}
        {value.live && <CardNote>Only verified, unambiguous identical regular-file moves can be paired as renames. Other moves may remain as deletion and addition.</CardNote>}
        {scope !== 'branch' && !value.live && <CardNote>Saved turn comparisons include Git’s rename detection.</CardNote>}
        <CardNote>Link destinations are not shared by this passive read. Link target contents are never read.</CardNote>
        {!value.diffstat && (value.offset !== 0 || value.nextOffset !== null || value.files.length !== value.totalFiles) && <CardNote>This host does not share aggregate line totals. Available line counts cover only this page.</CardNote>}
        {value.diffstat && value.diffstat.knownFiles < value.totalFiles && <CardNote>Line totals are known for {value.diffstat.knownFiles} of {value.totalFiles} listed paths; the remaining line counts are unavailable.</CardNote>}
        <FileList key={`${key}:${value.observedAt}`} files={value.files} loadDiff={loadDiff} />
        {value.totalFiles === 0 && !value.uncompared && <CardNote>No changes in this comparison.</CardNote>}
        {value.uncompared > 0 && <CardNote>{value.uncompared} paths were not compared because they are protected or exceed the host’s bounded inventory. They are not known unchanged.</CardNote>}
        {(offset > 0 || value.nextOffset !== null) && <div className="flex gap-3 pl-[33px] text-xs"><button type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>Previous</button><button type="button" disabled={value.nextOffset === null} onClick={() => setOffset(value.nextOffset!)}>Next</button></div>}
        {!!value.skippedLarge.length && <CardNote>Too large to checkpoint: {value.skippedLarge.join(', ')}</CardNote>}
        {!!value.skippedRepos.length && <CardNote>Repositories with no commits: {value.skippedRepos.join(', ')}</CardNote>}
        {value.skippedOmitted > 0 && <CardNote>{value.skippedOmitted} more checkpoint exclusions omitted by the host’s display limit.</CardNote>}
      </>}
      <CardNote>Read from the host at {new Date(value.observedAt).toLocaleTimeString()}. Read-only.</CardNote>
    </>}
    <button type="button" onClick={() => setRetry((n) => n + 1)} className="pl-[33px] text-xs text-ctp-overlay1 hover:text-ctp-text">Refresh changes</button>
  </DetailsCard>;
}
