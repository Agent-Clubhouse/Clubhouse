import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { GroupProject } from '../../../shared/group-project-types';
import { Button } from '../../components/Button';
import { useGroupProjectStore } from '../../stores/groupProjectStore';
import { ipcErrorMessage } from '../../utils/ipc-error';
import { DeleteGroupProjectDialog } from '../settings/DeleteGroupProjectDialog';
import { GroupProjectScopeEditor, hostLine, scopeDescription } from '../settings/GroupProjectScopeFields';
import { SettingsBlock, SettingsSection, settingsError, settingsHelp, settingsInput, settingsLabel, settingsTextArea } from '../settings/SettingsLayout';

function editableFields(project: GroupProject) {
  return { name: project.name, description: project.description, instructions: project.instructions };
}

/** Only the host can do these: a copy of a network group project says so, plainly, instead of offering them. */
export function hostOnlyReason(project: GroupProject, what: string): string | null {
  if (project.network?.role !== 'replica') return null;
  return `Only ${project.hostName ?? 'the host'} can ${what}. This computer holds a copy, and there is no host transfer.`;
}

/**
 * Name, description and instructions with an explicit Save, the scope and its
 * review (#3431), and Delete with its impact, token and cascade.
 */
export function GroupProjectDetailsSection({ project }: { project: GroupProject }) {
  const update = useGroupProjectStore((s) => s.update);
  const remove = useGroupProjectStore((s) => s.remove);
  const [deleting, setDeleting] = useState(false);
  const loadImpact = useCallback(() => window.clubhouse.groupProject.previewDelete(project.id), [project.id]);
  const confirmDelete = useCallback((token: string) => remove(project.id, token), [remove, project.id]);
  const [baseline, setBaseline] = useState(() => editableFields(project));
  const [draft, setDraft] = useState(baseline);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const pending = useRef(false);
  const dirty = draft.name !== baseline.name || draft.description !== baseline.description
    || draft.instructions !== baseline.instructions;
  const hostOnlyScope = hostOnlyReason(project, 'change the scope');
  const hostOnlyDelete = hostOnlyReason(project, 'delete this group project');

  useEffect(() => {
    if (!dirty && !saving) {
      const fields = editableFields(project);
      setBaseline(fields);
      setDraft(fields);
    }
  }, [project, dirty, saving]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending.current) return;
    if (!draft.name.trim()) {
      setError('Not saved. Enter a group project name.');
      return;
    }
    const next = { ...draft, name: draft.name.trim() };
    const fields: Partial<typeof next> = {};
    if (next.name !== baseline.name) fields.name = next.name;
    if (next.description !== baseline.description) fields.description = next.description;
    if (next.instructions !== baseline.instructions) fields.instructions = next.instructions;
    pending.current = true;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await update(project.id, fields);
      setBaseline(next);
      setDraft(next);
      setSaved(true);
    } catch (err) {
      // telemetry-exempt: the failed save is shown inline and its draft is retained.
      setError(`Not saved. ${ipcErrorMessage(err)}`);
    } finally {
      pending.current = false;
      setSaving(false);
    }
  };

  return (
    <>
      <SettingsSection title="Edit group project">
        <SettingsBlock>
          <p className={`${settingsHelp} mb-3 break-words`}>{scopeDescription(project.scope)}</p>
          <p className={`${settingsHelp} mb-3 break-words`}>{hostLine(project)}. The host is set when a group project is created.</p>
          <form onSubmit={submit} className="flex flex-col items-start gap-2">
            <label htmlFor="group-project-name" className={settingsLabel}>Name</label>
            <input
              id="group-project-name"
              className={`${settingsInput} w-full min-w-0`}
              value={draft.name}
              disabled={saving}
              onChange={(event) => { setDraft({ ...draft, name: event.target.value }); setSaved(false); }}
            />
            <label htmlFor="group-project-description" className={settingsLabel}>Description</label>
            <textarea
              id="group-project-description"
              className={settingsTextArea}
              rows={3}
              value={draft.description}
              disabled={saving}
              onChange={(event) => { setDraft({ ...draft, description: event.target.value }); setSaved(false); }}
            />
            <label htmlFor="group-project-instructions" className={settingsLabel}>Instructions</label>
            <textarea
              id="group-project-instructions"
              className={settingsTextArea}
              rows={6}
              value={draft.instructions}
              disabled={saving}
              onChange={(event) => { setDraft({ ...draft, instructions: event.target.value }); setSaved(false); }}
            />
            <Button type="submit" kind="primary" disabled={saving || !dirty}>
              {saving ? 'Saving...' : 'Save changes'}
            </Button>
            {error && <p role="alert" className={settingsError}>{error}</p>}
            {saved && <p role="status" className={settingsHelp}>
              {project.network?.role === 'replica' ? `Submitted. Some changes may be waiting for ${project.hostName ?? 'the host'}.` : 'Changes saved to the local registry.'}
            </p>}
          </form>
        </SettingsBlock>
      </SettingsSection>
      {hostOnlyScope
        ? (
          <SettingsSection title="Scope">
            <SettingsBlock>
              <Button disabled aria-describedby="group-project-scope-host-only">Change scope</Button>
              <p id="group-project-scope-host-only" className={`${settingsHelp} mt-2`}>{hostOnlyScope}</p>
            </SettingsBlock>
          </SettingsSection>
        )
        : <GroupProjectScopeEditor project={project} />}
      <SettingsSection title="Delete">
        <SettingsBlock>
          <Button kind="danger" disabled={!!hostOnlyDelete} aria-describedby={hostOnlyDelete ? 'group-project-delete-host-only' : undefined} onClick={() => setDeleting(true)}>
            Delete group project
          </Button>
          {hostOnlyDelete && <p id="group-project-delete-host-only" className={`${settingsHelp} mt-2`}>{hostOnlyDelete}</p>}
          {deleting && <DeleteGroupProjectDialog name={project.name} loadImpact={loadImpact} confirmDelete={confirmDelete} onClose={() => setDeleting(false)} />}
        </SettingsBlock>
      </SettingsSection>
    </>
  );
}
