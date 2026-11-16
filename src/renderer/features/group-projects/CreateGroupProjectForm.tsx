import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type {
  AutoJoinPreview, GroupProject, GroupProjectCreateHost, GroupProjectCreateOptions, GroupProjectScope, RemoteCreateOutcome,
} from '../../../shared/group-project-types';
import { Button } from '../../components/Button';
import { useGroupProjectStore } from '../../stores/groupProjectStore';
import { useProjectStore } from '../../stores/projectStore';
import { ipcErrorMessage } from '../../utils/ipc-error';
import { SettingsBlock, SettingsSection, settingsError, settingsHelp, settingsInput, settingsLabel } from '../settings/SettingsLayout';
import { GroupProjectScopeFields, useScopeOptions } from '../settings/GroupProjectScopeFields';
import { CoverageSummary } from './CoverageSummary';

export function CreateGroupProjectForm({ defaultScope = { level: 'app', reach: 'local' }, onCreated, onCancel }: {
  /** The scope the form starts on: the project view supplies its project, the hub the whole app. */
  defaultScope?: GroupProjectScope;
  onCreated?: (project: GroupProject) => void;
  onCancel?: () => void;
}) {
  const create = useGroupProjectStore((s) => s.create);
  const createOnHost = useGroupProjectStore((s) => s.createOnHost);
  const projects = useProjectStore((s) => s.projects);
  const [autoJoin, setAutoJoin] = useState(true);
  const [includeLinkedComputers, setIncludeLinkedComputers] = useState(true);
  const [excluded, setExcluded] = useState<string[]>([]);
  const scopeOptions = useScopeOptions();
  // From the directory, a new group project covers the app on this computer unless the person picks otherwise (#3355).
  const [scope, setScope] = useState<GroupProjectScope>(defaultScope);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState(false);
  const [preview, setPreview] = useState<AutoJoinPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(true);
  const pending = useRef(false);
  const previewVersion = useRef(0);
  // #3547: where it's created. Null is this computer, the default.
  const [host, setHost] = useState<string | null>(null);
  const [hosts, setHosts] = useState<GroupProjectCreateHost[] | null>(null);
  const [hostsError, setHostsError] = useState<string | null>(null);
  /** The last answer from another computer; its request id is what Retry sends again. */
  const [remote, setRemote] = useState<RemoteCreateOutcome | null>(null);
  /** While waiting: the last check couldn't reach the host. The request stands and may still be approved. */
  const [pollProblem, setPollProblem] = useState<string | null>(null);
  const remoteRef = useRef(remote);
  remoteRef.current = remote;
  const remoteDraft = useRef<{ host: string; name: string; options: GroupProjectCreateOptions } | null>(null);
  const network = scope.reach === 'network';

  const loadHosts = useCallback(async () => {
    setHostsError(null);
    try {
      setHosts(await window.clubhouse.groupProject.createHosts());
    } catch (err) {
      // telemetry-exempt: shown beside the host choice with Check again
      setHosts(null);
      setHostsError(ipcErrorMessage(err));
    }
  }, []);
  useEffect(() => { if (network) void loadHosts(); }, [network, loadHosts]);

  /** A changed draft is a new request: the old id is dropped unless it is still waiting. */
  const draftChanged = () => {
    setCreated(false);
    if (remote?.status === 'waiting') return;
    setRemote(null);
    remoteDraft.current = null;
  };

  const loadPreview = useCallback(async () => {
    const version = ++previewVersion.current;
    setPreviewLoading(true);
    try {
      const result = await window.clubhouse.groupProject.previewAutoJoin(scope, { autoJoin, includeLinkedComputers });
      if (version !== previewVersion.current) return;
      setPreview(result);
      setPreviewError(null);
    } catch (err) {
      // telemetry-exempt: an incomplete preview is shown before creation.
      if (version !== previewVersion.current) return;
      setPreview(null);
      setPreviewError(ipcErrorMessage(err));
    } finally { if (version === previewVersion.current) setPreviewLoading(false); }
  }, [scope, autoJoin, includeLinkedComputers]);
  useEffect(() => {
    void loadPreview();
    const offProject = window.clubhouse.project.onChanged(() => { void loadPreview(); });
    const offAgents = window.clubhouse.agent.onConfigsChanged(() => { void loadPreview(); });
    const offMembership = window.clubhouse.groupProject.onMembershipChanged(() => { void loadPreview(); });
    return () => { previewVersion.current++; offProject(); offAgents(); offMembership(); };
  }, [loadPreview]);

  /** Send to another computer: a new request, or `retryOf` again exactly as saved. */
  const sendRemote = useCallback(async (retryOf?: string) => {
    const draft = remoteDraft.current;
    if (!draft || pending.current) return;
    pending.current = true;
    setCreating(true);
    setError(null);
    try {
      const outcome = await createOnHost(draft.host, draft.name, draft.options, retryOf);
      // A failed check while approval waits changes nothing: the request may still be approved there.
      if (remoteRef.current?.status === 'waiting' && (outcome.status === 'unreachable' || outcome.status === 'busy')) {
        setPollProblem(outcome.reason);
        return;
      }
      setPollProblem(null);
      setRemote(outcome);
      if (outcome.status === 'created') {
        remoteDraft.current = null;
        setName('');
        setCreated(true);
        if (outcome.project) onCreated?.(outcome.project);
      }
    } catch (err) {
      // telemetry-exempt: shown inline; the draft is kept
      if (remoteRef.current?.status === 'waiting') setPollProblem(ipcErrorMessage(err));
      else setError(`Not created. ${ipcErrorMessage(err)}`);
    } finally {
      pending.current = false;
      setCreating(false);
    }
  }, [createOnHost, onCreated]);

  // While approval waits on the host, ask again now and then with the same request id.
  const waitingId = remote?.status === 'waiting' ? remote.requestId : null;
  useEffect(() => {
    if (!waitingId) return;
    const timer = setInterval(() => { void sendRemote(waitingId); }, APPROVAL_POLL_MS);
    return () => clearInterval(timer);
  }, [waitingId, sendRemote]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending.current) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Not created. Enter a group project name.');
      return;
    }
    const options: GroupProjectCreateOptions = { scope, membership: {
      autoJoin: scope.level === 'project' && autoJoin,
      includeLinkedComputers: scope.level === 'project' && scope.reach === 'network' && includeLinkedComputers,
      excluded,
    } };
    if (network && host) {
      setCreated(false);
      remoteDraft.current = { host, name: trimmed, options };
      setRemote(null);
      await sendRemote();
      return;
    }
    pending.current = true;
    setCreating(true);
    setError(null);
    setCreated(false);
    try {
      const project = await create(trimmed, options);
      setName('');
      setCreated(true);
      onCreated?.(project);
    } catch (err) {
      // telemetry-exempt: the failed creation is shown inline and its draft is retained.
      setError(`Not created. ${ipcErrorMessage(err)}`);
    } finally {
      pending.current = false;
      setCreating(false);
    }
  };

  const hostName = remote?.hostName || hosts?.find((h) => h.machine === host)?.name || 'that computer';
  const waiting = remote?.status === 'waiting';
  const locked = creating || waiting;

  return (
    <SettingsSection title="Create a group project">
      <SettingsBlock>
        <p className={`${settingsHelp} mb-3`}>
          App-wide group projects start with no members. Project groups can keep adding agents from their project, now and later. Helpers and quick agents join only when added.
        </p>
        {previewLoading && <p className={settingsHelp}>Loading agents who will join...</p>}
        {previewError && <div className="flex flex-col items-start gap-2"><p role="alert" className={settingsError}>Could not preview members: {previewError}</p><Button onClick={() => void loadPreview()}>Retry preview</Button></div>}
        {preview && <div className={`${settingsHelp} mb-3`}>
          <CoverageSummary coverage={preview.coverage} remoteHost={network && host !== null} />
          <p>{preview.wouldJoin.filter((agent) => !excluded.includes(agent.agentId)).length} {preview.wouldJoin.filter((agent) => !excluded.includes(agent.agentId)).length === 1 ? 'agent will' : 'agents will'} join now.</p>
          {preview.wouldJoin.length > 0 && <ul aria-label="Agents who will join" className="list-disc pl-5">
            {preview.wouldJoin.map((agent) => <li key={agent.agentId}><label className="flex items-center gap-2"><input type="checkbox" checked={!excluded.includes(agent.agentId)} disabled={locked}
              onChange={(event) => setExcluded((current) => event.target.checked ? current.filter((id) => id !== agent.agentId) : [...current, agent.agentId])} />
              {agent.name}{agent.projectName ? ` (${agent.projectName})` : ''}</label></li>)}
          </ul>}
          {preview.unreadableProjects.length > 0 && <p>Could not check agents in: {preview.unreadableProjects.map((project) => project.name).join(', ')}. The preview may be incomplete.</p>}
        </div>}
        <form onSubmit={submit} className="flex flex-col items-start gap-2">
          <label htmlFor="new-group-project-name" className={settingsLabel}>New group project name</label>
          <input
            id="new-group-project-name"
            className={`${settingsInput} w-full min-w-0`}
            value={name}
            disabled={locked}
            onChange={(event) => { setName(event.target.value); draftChanged(); }}
          />
          <GroupProjectScopeFields
            idPrefix="new-group-project-scope"
            value={scope}
            onChange={(next) => { setPreview(null); setPreviewLoading(true); setScope(next); setExcluded([]); draftChanged(); if (next.reach !== 'network') setHost(null); }}
            options={scopeOptions}
            disabled={locked}
          />
          {scope.level === 'project' && <fieldset disabled={locked} className="flex flex-col gap-2">
            <label className="flex items-center gap-2 text-xs text-ctp-text"><input type="checkbox" checked={autoJoin} onChange={(event) => setAutoJoin(event.target.checked)} />
              Start with every agent in {projects.find((p) => p.id === scope.projectId)?.displayName || projects.find((p) => p.id === scope.projectId)?.name || 'this project'}
            </label>
            <p className={settingsHelp}>Also adds agents that join the project later. Unchecked agents stay excluded.</p>
            {scope.reach === 'network' && <label className="flex items-center gap-2 text-xs text-ctp-text"><input type="checkbox" checked={includeLinkedComputers} disabled={!autoJoin} onChange={(event) => setIncludeLinkedComputers(event.target.checked)} />Include linked computers</label>}
          </fieldset>}
          {network && <HostChoice hosts={hosts} error={hostsError} value={host} disabled={locked}
            onChange={(next) => { setHost(next); draftChanged(); }} onReload={() => void loadHosts()} />}
          <div className="flex items-center gap-2">
            <Button type="submit" kind="primary" disabled={locked || previewLoading || !!previewError}>
              {creating && !waiting ? 'Creating...' : network && host ? `Create on ${hosts?.find((h) => h.machine === host)?.name ?? 'that computer'}` : 'Create group project'}
            </Button>
            {onCancel && <Button onClick={onCancel} disabled={creating}>Close</Button>}
          </div>
          {error && <p role="alert" className={settingsError}>{error}</p>}
          {remote && <RemoteStatus outcome={remote} hostName={hostName} busy={creating} pollProblem={pollProblem}
            onRetry={() => void sendRemote(remote.requestId)}
            onHere={() => { setHost(null); setRemote(null); setPollProblem(null); remoteDraft.current = null; }}
            onStartOver={() => { setRemote(null); setPollProblem(null); remoteDraft.current = null; }} />}
          {created && <p role="status" className={settingsHelp}>{remote?.status === 'created' ? `Created on ${hostName}.` : 'Created.'} Open it from the list.</p>}
        </form>
      </SettingsBlock>
    </SettingsSection>
  );
}

/** How often a waiting create asks its host again. */
const APPROVAL_POLL_MS = 15_000;

/** #3547: the computer that hosts the new group project. Only online computers that support it can be chosen. */
function HostChoice({ hosts, error, value, disabled, onChange, onReload }: {
  hosts: GroupProjectCreateHost[] | null;
  error: string | null;
  value: string | null;
  disabled: boolean;
  onChange: (machine: string | null) => void;
  onReload: () => void;
}) {
  return (
    <fieldset disabled={disabled} className="flex flex-col gap-1">
      <legend className={settingsLabel}>Host</legend>
      {!hosts && !error && <p className={settingsHelp}>Checking your computers...</p>}
      {error && <p role="alert" className={settingsError}>Could not list your computers: {error}</p>}
      {(hosts ?? [{ machine: null, name: 'This computer', state: 'online' as const }]).map((h) => (
        <label key={h.machine ?? 'this'} className="flex items-center gap-2 text-xs text-ctp-text">
          <input type="radio" name="new-group-project-host" checked={value === h.machine} disabled={h.state !== 'online'} onChange={() => onChange(h.machine)} />
          {h.name}{h.state !== 'online' && h.reason ? <span className={settingsHelp}>{h.reason}</span> : null}
        </label>
      ))}
      <p className={settingsHelp}>The host keeps the group project and can't be changed later. Another computer asks a person there to approve it.</p>
      <div><Button onClick={onReload} disabled={disabled}>Check again</Button></div>
    </fieldset>
  );
}

/** What another computer answered, with what can be done next. Nothing is ever queued. */
function RemoteStatus({ outcome, hostName, busy, pollProblem, onRetry, onHere, onStartOver }: {
  outcome: RemoteCreateOutcome;
  hostName: string;
  busy: boolean;
  pollProblem: string | null;
  onRetry: () => void;
  onHere: () => void;
  onStartOver: () => void;
}) {
  switch (outcome.status) {
    case 'created':
      return null;
    case 'waiting':
      return (
        <div role="status" className="flex flex-col items-start gap-1">
          <p className={settingsHelp}>Waiting for approval on {hostName}. A person there approves it in Needs you. Nothing has been created yet.</p>
          <p className={settingsHelp}>The request ends {new Date(outcome.expiresAt).toLocaleString()} if nobody answers. Closing this form stops checking, but the request may still be approved there.</p>
          {pollProblem && <p className={settingsError}>Couldn't check just now. {pollProblem} The request still stands and may be approved; this form keeps checking.</p>}
          <Button onClick={onRetry} disabled={busy}>Check now</Button>
        </div>
      );
    case 'unreachable':
    case 'busy':
      return (
        <div role="alert" className="flex flex-col items-start gap-1">
          <p className={settingsError}>Not created. {outcome.reason}</p>
          <div className="flex items-center gap-2">
            <Button onClick={onRetry} disabled={busy}>Retry</Button>
            <Button onClick={onHere} disabled={busy}>Create on this computer instead</Button>
          </div>
        </div>
      );
    default:
      return (
        <div role="alert" className="flex flex-col items-start gap-1">
          <p className={settingsError}>{STATUS_LABELS[outcome.status]} {outcome.reason}</p>
          <div className="flex items-center gap-2">
            <Button onClick={onStartOver} disabled={busy}>Start a new request</Button>
            <Button onClick={onHere} disabled={busy}>Create on this computer instead</Button>
          </div>
        </div>
      );
  }
}

const STATUS_LABELS: Record<'refused' | 'declined' | 'expired' | 'unsupported', string> = {
  refused: 'Refused.',
  declined: 'Declined.',
  expired: 'Expired.',
  unsupported: 'Not available.',
};
