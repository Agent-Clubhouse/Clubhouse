import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { AutoJoinPreview, GroupProjectScope } from '../../../shared/group-project-types';
import { Button } from '../../components/Button';
import { GroupProjectWorkspace } from '../group-projects/GroupProjectWorkspace';
import { openGroupWorkspace } from '../group-projects/groupProjectsNav';
import { useGroupProjectsNavStore } from '../group-projects/groupProjectsNavStore';
import { useGroupWorkspaceBack } from '../group-projects/groupWorkspaceSource';
import { useGroupProjectStore } from '../../stores/groupProjectStore';
import { ipcErrorMessage } from '../../utils/ipc-error';
import {
  SettingsBlock, SettingsPage, SettingsSection,
  settingsError, settingsHelp, settingsInput, settingsLabel,
} from './SettingsLayout';
import { GroupProjectScopeFields, hostLine, scopeDescription, useScopeOptions } from './GroupProjectScopeFields';

function MemberCount({ id }: { id: string }) {
  const [count, setCount] = useState<number | null>();
  useEffect(() => {
    let active = true;
    let request = 0;
    const load = async () => {
      const current = ++request;
      try {
        const result = await window.clubhouse.groupProject.listMembers(id);
        if (active && current === request) setCount(result.members.length);
      } catch {
        // telemetry-exempt: the directory keeps its list available without a count.
        if (active && current === request) setCount(null);
      }
    };
    void load();
    const unsubscribe = window.clubhouse.groupProject.onMembershipChanged((changed) => { if (changed === id) void load(); });
    return () => { active = false; unsubscribe(); };
  }, [id]);
  return <span id={`group-project-members-${id}`} className={`${settingsHelp} block`}>{count === undefined ? 'Loading members...' : count === null ? 'Member count unavailable' : `${count} ${count === 1 ? 'member' : 'members'}`}</span>;
}

function CreateGroupProject() {
  const create = useGroupProjectStore((s) => s.create);
  const scopeOptions = useScopeOptions();
  // From the directory, a new group project covers the app on this computer unless the person picks otherwise (#3355).
  const [scope, setScope] = useState<GroupProjectScope>({ level: 'app', reach: 'local' });
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState(false);
  const [preview, setPreview] = useState<AutoJoinPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(true);
  const pending = useRef(false);
  const previewVersion = useRef(0);

  const loadPreview = useCallback(async () => {
    const version = ++previewVersion.current;
    setPreviewLoading(true);
    try {
      const result = await window.clubhouse.groupProject.previewAutoJoin(scope);
      if (version !== previewVersion.current) return;
      setPreview(result);
      setPreviewError(null);
    } catch (err) {
      // telemetry-exempt: an incomplete preview is shown before creation.
      if (version !== previewVersion.current) return;
      setPreview(null);
      setPreviewError(ipcErrorMessage(err));
    } finally { if (version === previewVersion.current) setPreviewLoading(false); }
  }, [scope]);
  useEffect(() => {
    void loadPreview();
    const offProject = window.clubhouse.project.onChanged(() => { void loadPreview(); });
    const offAgents = window.clubhouse.agent.onConfigsChanged(() => { void loadPreview(); });
    const offMembership = window.clubhouse.groupProject.onMembershipChanged(() => { void loadPreview(); });
    return () => { previewVersion.current++; offProject(); offAgents(); offMembership(); };
  }, [loadPreview]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending.current) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Not created. Enter a group project name.');
      return;
    }
    pending.current = true;
    setCreating(true);
    setError(null);
    setCreated(false);
    try {
      await create(trimmed, { scope });
      setName('');
      setCreated(true);
    } catch (err) {
      // telemetry-exempt: the failed creation is shown inline and its draft is retained.
      setError(`Not created. ${ipcErrorMessage(err)}`);
    } finally {
      pending.current = false;
      setCreating(false);
    }
  };

  return (
    <SettingsSection title="Create a group project">
      <SettingsBlock>
        <p className={`${settingsHelp} mb-3`}>
          New group projects cover the whole app on this computer unless you choose a project. Top-level durable agents in scope join automatically. Helpers and quick agents join only when added.
        </p>
        {previewLoading && <p className={settingsHelp}>Loading agents who will join...</p>}
        {previewError && <div className="flex flex-col items-start gap-2"><p role="alert" className={settingsError}>Could not preview members: {previewError}</p><Button onClick={() => void loadPreview()}>Retry preview</Button></div>}
        {preview && <div className={`${settingsHelp} mb-3`}>
          <p>{preview.wouldJoin.length} {preview.wouldJoin.length === 1 ? 'agent will' : 'agents will'} join now.</p>
          {preview.wouldJoin.length > 0 && <ul aria-label="Agents who will join" className="list-disc pl-5">
            {preview.wouldJoin.map((agent) => <li key={agent.agentId}>{agent.name}{agent.projectName ? ` (${agent.projectName})` : ''}</li>)}
          </ul>}
          {preview.unreadableProjects.length > 0 && <p>Could not check agents in: {preview.unreadableProjects.map((project) => project.name).join(', ')}. The preview may be incomplete.</p>}
        </div>}
        <form onSubmit={submit} className="flex flex-col items-start gap-2">
          <label htmlFor="new-group-project-name" className={settingsLabel}>New group project name</label>
          <input
            id="new-group-project-name"
            className={`${settingsInput} w-full min-w-0`}
            value={name}
            disabled={creating}
            onChange={(event) => { setName(event.target.value); setCreated(false); }}
          />
          <GroupProjectScopeFields
            idPrefix="new-group-project-scope"
            value={scope}
            onChange={(next) => { setPreview(null); setPreviewLoading(true); setScope(next); setCreated(false); }}
            options={scopeOptions}
            disabled={creating}
          />
          <Button type="submit" kind="primary" disabled={creating || previewLoading}>
            {creating ? 'Creating...' : 'Create group project'}
          </Button>
          {error && <p role="alert" className={settingsError}>{error}</p>}
          {created && <p role="status" className={settingsHelp}>Created. Select it in the local directory to edit.</p>}
        </form>
      </SettingsBlock>
    </SettingsSection>
  );
}

export function GroupProjectsSettingsView() {
  const projects = useGroupProjectStore((s) => s.projects);
  const loaded = useGroupProjectStore((s) => s.loaded);
  const loadError = useGroupProjectStore((s) => s.loadError);
  const loadProjects = useGroupProjectStore((s) => s.loadProjects);
  const [retrying, setRetrying] = useState(false);
  const retryPending = useRef(false);
  const route = useGroupProjectsNavStore((s) => s.route);
  const { source, back } = useGroupWorkspaceBack();

  useEffect(() => {
    if (!loaded) void loadProjects();
  }, [loaded, loadProjects]);

  // Leaving this page leaves the group, so coming back shows the directory rather than the last group opened.
  useEffect(() => () => useGroupProjectsNavStore.getState().setRoute(null), []);

  const retry = async () => {
    if (retryPending.current) return;
    retryPending.current = true;
    setRetrying(true);
    try {
      await loadProjects();
    } finally {
      retryPending.current = false;
      setRetrying(false);
    }
  };

  // A group opened from a row or a link shows its workspace, Board first, in place of the directory.
  if (route) {
    return <GroupProjectWorkspace key={route.groupId} groupId={route.groupId} section={route.section} source={source} onBack={back} />;
  }

  return (
    <SettingsPage
      title="Group Projects"
      description="Group projects on this computer, including network copies and group projects on no canvas."
    >
      <SettingsSection title="Local directory">
        <SettingsBlock>
          {!loaded || retrying ? <p role="status" className={settingsHelp}>Loading group projects...</p>
            : loadError ? (
              <div className="flex flex-col items-start gap-2">
                <p role="alert" className={settingsError}>
                  Could not load the local directory. The inventory is unavailable. {loadError}
                </p>
                <Button onClick={retry}>Retry loading</Button>
              </div>
            ) : projects.length === 0 ? <p className={settingsHelp}>No group projects stored on this machine.</p>
              : (
                <ul aria-label="Local group projects" className="flex flex-col gap-1">
                  {projects.map((project) => (
                    <li key={project.id}>
                      <button
                        type="button"
                        aria-label={project.name}
                        aria-describedby={`group-project-scope-${project.id} group-project-members-${project.id} group-project-host-${project.id}`}
                        onClick={() => openGroupWorkspace({ groupId: project.id })}
                        className="w-full min-w-0 rounded-md px-2.5 py-2 text-left text-xs focus-ring hover:bg-surface-0 text-ctp-subtext1"
                      >
                        <span className="block font-medium break-words">{project.name}</span>
                        <MemberCount id={project.id} />
                        <span id={`group-project-host-${project.id}`} className={`${settingsHelp} block break-words`}>{hostLine(project)}</span>
                        <span className={`${settingsHelp} block`}>{project.metadata?.pollingEnabled ? 'Polling on' : 'Polling off'}</span>
                        <span id={`group-project-scope-${project.id}`} className={`${settingsHelp} block break-words`}>{scopeDescription(project.scope)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
        </SettingsBlock>
      </SettingsSection>
      {loaded && !loadError && !retrying && <CreateGroupProject />}
    </SettingsPage>
  );
}
