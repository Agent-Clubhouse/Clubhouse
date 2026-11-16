import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { AutoJoinPreview, GroupProject, GroupProjectScope } from '../../../shared/group-project-types';
import { Button } from '../../components/Button';
import { useGroupProjectStore } from '../../stores/groupProjectStore';
import { ipcErrorMessage } from '../../utils/ipc-error';
import { SettingsBlock, SettingsSection, settingsError, settingsHelp, settingsInput, settingsLabel } from '../settings/SettingsLayout';
import { GroupProjectScopeFields, useScopeOptions } from '../settings/GroupProjectScopeFields';

export function CreateGroupProjectForm({ defaultScope = { level: 'app', reach: 'local' }, onCreated, onCancel }: {
  /** The scope the form starts on: the project view supplies its project, the hub the whole app. */
  defaultScope?: GroupProjectScope;
  onCreated?: (project: GroupProject) => void;
  onCancel?: () => void;
}) {
  const create = useGroupProjectStore((s) => s.create);
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
      const project = await create(trimmed, { scope });
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
          <div className="flex items-center gap-2">
            <Button type="submit" kind="primary" disabled={creating || previewLoading}>
              {creating ? 'Creating...' : 'Create group project'}
            </Button>
            {onCancel && <Button onClick={onCancel} disabled={creating}>Close</Button>}
          </div>
          {error && <p role="alert" className={settingsError}>{error}</p>}
          {created && <p role="status" className={settingsHelp}>Created. Open it from the list.</p>}
        </form>
      </SettingsBlock>
    </SettingsSection>
  );
}
