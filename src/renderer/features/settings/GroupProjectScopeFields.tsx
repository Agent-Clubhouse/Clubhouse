import { useEffect, useRef, useState } from 'react';
import type { GroupProject, GroupProjectMemberView, GroupProjectScope, GroupProjectScopeOptions } from '../../../shared/group-project-types';
import type { Project } from '../../../shared/types';
import { sameGroupProjectScope } from '../../../shared/group-project-scope';
import { Button } from '../../components/Button';
import { useGroupProjectStore } from '../../stores/groupProjectStore';
import { useProjectStore } from '../../stores/projectStore';
import { ipcErrorMessage } from '../../utils/ipc-error';
import { SettingsBlock, SettingsSection, settingsError, settingsHelp, settingsInput, settingsLabel } from './SettingsLayout';

const projectLabel = (project: Project) => project.displayName || project.name;

/** What a scope covers, in the words of #3355's table. */
export function scopeMeaning(scope: GroupProjectScope, projects: readonly Project[]): string {
  if (scope.level === 'app') {
    return scope.reach === 'local'
      ? 'Agents in every project on this computer.'
      : 'Agents in every project on every computer in your Annex Network.';
  }
  const project = projects.find((p) => p.id === scope.projectId);
  const name = project ? projectLabel(project) : 'this project';
  return scope.reach === 'local'
    ? `Agents in ${name} on this computer.`
    : `Agents in ${name} and in projects linked to it on your other computers.`;
}

/** Loads whether network reach can be chosen, and why not. */
export function useScopeOptions(): GroupProjectScopeOptions | null {
  const load = useGroupProjectStore((s) => s.scopeOptions);
  const [options, setOptions] = useState<GroupProjectScopeOptions | null>(null);
  useEffect(() => {
    let live = true;
    load().then((value) => { if (live) setOptions(value); }, () => {
      // telemetry-exempt: without an answer, network stays unavailable with a generic reason
      if (live) setOptions({ network: { available: false, reason: 'Could not check whether network reach is available.' } });
    });
    return () => { live = false; };
  }, [load]);
  return options;
}

interface ScopeFieldsProps {
  idPrefix: string;
  value: GroupProjectScope;
  onChange: (scope: GroupProjectScope) => void;
  options: GroupProjectScopeOptions | null;
  disabled?: boolean;
}

/** Project or app, and this computer or network (#3355). Network is disabled with its reason when unavailable. */
export function GroupProjectScopeFields({ idPrefix, value, onChange, options, disabled }: ScopeFieldsProps) {
  const projects = useProjectStore((s) => s.projects);
  const networkAvailable = options?.network.available ?? false;
  const reasonId = `${idPrefix}-network-reason`;
  const covers = value.level === 'app' ? 'app' : `project:${value.projectId}`;
  const knownProject = value.level !== 'project' || projects.some((p) => p.id === value.projectId);

  const setCovers = (next: string) => {
    onChange(next === 'app'
      ? { level: 'app', reach: value.reach }
      : { level: 'project', projectId: next.slice('project:'.length), reach: value.reach });
  };
  const setReach = (reach: GroupProjectScope['reach']) => onChange({ ...value, reach } as GroupProjectScope);

  return (
    <div className="flex w-full min-w-0 flex-col items-start gap-2">
      <label htmlFor={`${idPrefix}-covers`} className={settingsLabel}>Covers</label>
      <select
        id={`${idPrefix}-covers`}
        className={`${settingsInput} w-full min-w-0`}
        value={covers}
        disabled={disabled}
        onChange={(event) => setCovers(event.target.value)}
      >
        <option value="app">The whole app</option>
        {projects.map((project) => (
          <option key={project.id} value={`project:${project.id}`}>{projectLabel(project)}</option>
        ))}
        {!knownProject && <option value={covers}>Unregistered project</option>}
      </select>
      <fieldset className="flex flex-col gap-1" disabled={disabled}>
        <legend className={settingsLabel}>Reach</legend>
        <label className="flex items-center gap-2 text-xs text-ctp-text">
          <input type="radio" name={`${idPrefix}-reach`} checked={value.reach === 'local'} onChange={() => setReach('local')} />
          This computer
        </label>
        <label className="flex items-center gap-2 text-xs text-ctp-text">
          <input
            type="radio"
            name={`${idPrefix}-reach`}
            checked={value.reach === 'network'}
            disabled={!networkAvailable}
            aria-describedby={networkAvailable ? undefined : reasonId}
            onChange={() => setReach('network')}
          />
          Network
        </label>
        {!networkAvailable && (
          <p id={reasonId} className={settingsHelp}>{options?.network.reason ?? 'Checking whether network reach is available...'}</p>
        )}
      </fieldset>
      <p className={settingsHelp}>{scopeMeaning(value, projects)}</p>
    </div>
  );
}

/**
 * Change a group project's scope. A person reviews who would leave before it
 * applies; the host refuses if that list changed meanwhile.
 */
export function GroupProjectScopeEditor({ project }: { project: GroupProject }) {
  const previewScope = useGroupProjectStore((s) => s.previewScope);
  const setScope = useGroupProjectStore((s) => s.setScope);
  const options = useScopeOptions();
  const projects = useProjectStore((s) => s.projects);
  const saved: GroupProjectScope = project.scope ?? { level: 'app', reach: 'local' };
  const [draft, setDraft] = useState<GroupProjectScope>(saved);
  const [baseline, setBaseline] = useState<GroupProjectScope>(saved);
  const [leaving, setLeaving] = useState<GroupProjectMemberView[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState(false);
  const pending = useRef(false);
  const unchanged = sameGroupProjectScope(project.scope, draft);

  // A change made elsewhere (another window, an agent, the host) replaces an untouched draft.
  useEffect(() => {
    if (sameGroupProjectScope(baseline, saved)) return;
    if (sameGroupProjectScope(baseline, draft) && leaving === null && !busy) setDraft(saved);
    setBaseline(saved);
  }, [saved, baseline, draft, leaving, busy]);

  const change = (next: GroupProjectScope) => {
    setDraft(next);
    setLeaving(null);
    setError(null);
    setApplied(false);
  };

  const run = async (step: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      await step();
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  const review = () => run(async () => {
    try {
      setLeaving(await previewScope(project.id, draft));
    } catch (err) {
      // telemetry-exempt: shown inline; nothing changed
      setError(`Could not review this change. ${ipcErrorMessage(err)}`);
    }
  });

  const apply = () => run(async () => {
    if (!leaving) return;
    try {
      await setScope(project.id, draft, leaving.map((member) => member.address));
      setLeaving(null);
      setApplied(true);
    } catch (err) {
      // telemetry-exempt: shown inline; the host applies nothing on refusal
      setLeaving(null);
      setError(`Scope not changed. ${ipcErrorMessage(err)}`);
    }
  });

  return (
    <SettingsSection title="Scope">
      <SettingsBlock>
        <div role="region" aria-label="Scope" className="flex flex-col items-start gap-2">
          {!project.scope && (
            <p className={settingsHelp}>This group project has no scope yet. Choosing one here sets it explicitly.</p>
          )}
          <GroupProjectScopeFields idPrefix={`scope-${project.id}`} value={draft} onChange={change} options={options} disabled={busy} />
          {leaving === null ? (
            <Button onClick={review} disabled={busy || unchanged}>Review change</Button>
          ) : (
            <div className="flex flex-col items-start gap-2" role="region" aria-label="Scope change review">
              {leaving.length === 0 ? (
                <p className={settingsHelp}>No members leave.</p>
              ) : (
                <>
                  <p className={settingsHelp}>
                    {leaving.length === 1 ? 'This member leaves' : `These ${leaving.length} members leave`} when the scope changes:
                  </p>
                  <ul aria-label="Members who would leave" className="list-disc pl-5 text-xs text-ctp-text">
                    {leaving.map((member) => {
                      const from = projects.find((p) => p.id === member.projectId);
                      return <li key={member.address}>{member.name}{from ? ` (${projectLabel(from)})` : ''}</li>;
                    })}
                  </ul>
                </>
              )}
              <div className="flex gap-2">
                <Button kind="primary" onClick={apply} disabled={busy}>
                  {leaving.length === 0 ? 'Apply scope' : `Apply and remove ${leaving.length}`}
                </Button>
                <Button kind="ghost" onClick={() => setLeaving(null)} disabled={busy}>Cancel</Button>
              </div>
            </div>
          )}
          {error && <p role="alert" className={settingsError}>{error}</p>}
          {applied && <p role="status" className={settingsHelp}>Scope changed.</p>}
        </div>
      </SettingsBlock>
    </SettingsSection>
  );
}
