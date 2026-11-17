import { postNotificationLabel } from '../../../shared/group-project-notifications';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { GroupProject } from '../../../shared/group-project-types';
import { Button } from '../../components/Button';
import { useGroupProjectStore } from '../../stores/groupProjectStore';
import { useProjectStore } from '../../stores/projectStore';
import { hostLine } from '../settings/GroupProjectScopeFields';
import { SettingsPage, settingsError, settingsHelp, settingsInput } from '../settings/SettingsLayout';
import { CreateGroupProjectForm } from './CreateGroupProjectForm';
import { OfferToLink } from './CoverageSummary';
import { buildDirectory, coverageLine, projectLabel, scopeReachLine, type CoverageById, type DirectoryProject } from './groupProjectsDirectory';
import { useGroupCoverage } from './useGroupCoverage';
import type { GroupProjectsView } from './groupProjectsNavStore';

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

function GroupRow({ project, projects, coverage, onOpen }: {
  project: GroupProject;
  projects: readonly DirectoryProject[];
  coverage: CoverageById;
  onOpen: (id: string) => void;
}) {
  const verified = coverage.get(project.id);
  const line = coverageLine(verified);
  return (
    <li>
      <button
        type="button"
        aria-label={project.name}
        aria-describedby={`group-project-scope-${project.id} group-project-members-${project.id} group-project-host-${project.id} group-project-notifications-${project.id}${line ? ` group-project-coverage-${project.id}` : ''}`}
        data-testid={`group-project-row-${project.id}`}
        onClick={() => onOpen(project.id)}
        className="w-full min-w-0 rounded-md px-2.5 py-2 text-left text-xs focus-ring hover:bg-surface-0 text-ctp-subtext1"
      >
        <span className="block font-medium break-words">{project.name}</span>
        <span id={`group-project-scope-${project.id}`} className={`${settingsHelp} block break-words`}>{scopeReachLine(project, projects)}</span>
        <span id={`group-project-host-${project.id}`} className={`${settingsHelp} block break-words`}>{hostLine(project)}</span>
        {line && <span id={`group-project-coverage-${project.id}`} className={`${settingsHelp} block break-words`}>{line}</span>}
        <MemberCount id={project.id} />
        <span id={`group-project-notifications-${project.id}`} className={`${settingsHelp} block`}>{postNotificationLabel(project)}</span>
      </button>
      <OfferToLink coverage={verified} className="px-2.5" />
    </li>
  );
}

/**
 * The Group Projects hub (#3544): every group known on this computer, as a
 * searchable list sectioned by project and app-wide, in the main pane and in
 * Settings alike. A row opens that group through `onOpenGroup`; each surface
 * decides where that goes. The view is every group or one project's view, which
 * filters and never changes a group's scope or members.
 */
export function GroupProjectsHub({ view, onViewChange, query, onQueryChange, onOpenGroup }: {
  view: GroupProjectsView;
  onViewChange: (view: GroupProjectsView) => void;
  query: string;
  onQueryChange: (query: string) => void;
  onOpenGroup: (id: string) => void;
}) {
  const groups = useGroupProjectStore((s) => s.projects);
  const loaded = useGroupProjectStore((s) => s.loaded);
  const loadError = useGroupProjectStore((s) => s.loadError);
  const loadProjects = useGroupProjectStore((s) => s.loadProjects);
  const localProjects = useProjectStore((s) => s.projects);
  const [retrying, setRetrying] = useState(false);
  const retryPending = useRef(false);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!loaded) void loadProjects();
  }, [loaded, loadProjects]);

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

  const projects: DirectoryProject[] = useMemo(
    () => localProjects.map((p) => ({ id: p.id, name: p.name, displayName: p.displayName })),
    [localProjects],
  );
  const lensProject = view.kind === 'project' ? projects.find((p) => p.id === view.projectId) : undefined;
  const lensName = view.kind === 'project' ? (lensProject ? projectLabel(lensProject) : 'This project') : null;
  const { coverage, failed: coverageFailed } = useGroupCoverage(groups);
  const directory = useMemo(() => buildDirectory(groups, projects, view, query, coverage), [groups, projects, view, query, coverage]);
  const searching = query.trim().length > 0;
  const all: GroupProjectsView = { kind: 'all' };

  const title = lensName ? `${lensName} and app-wide` : 'Group Projects';
  const description = lensName
    ? 'Group projects verified to cover this project, and app-wide group projects. Changing the view changes no scope or members.'
    : 'Group projects on this computer, including network copies and group projects on no canvas.';
  const actions = (
    <>
      {view.kind === 'project' && <Button onClick={() => onViewChange(all)}>All groups</Button>}
      {/* Not while the inventory is unknown: a duplicate could be created blind. */}
      <Button kind="primary" onClick={() => setCreating(true)} disabled={creating || !loaded || !!loadError || retrying}>New group project</Button>
    </>
  );

  let body;
  if (!loaded || retrying) {
    body = <p role="status" className={`${settingsHelp} mt-4`}>Loading group projects...</p>;
  } else if (loadError) {
    body = (
      <div className="flex flex-col items-start gap-2 mt-4">
        <p role="alert" className={settingsError}>
          Could not load the local directory. The inventory is unavailable. {loadError}
        </p>
        <Button onClick={retry}>Retry loading</Button>
      </div>
    );
  } else if (groups.length === 0) {
    body = (
      <div className="mt-4 flex flex-col items-start gap-2" data-testid="group-projects-first-run">
        <p className="text-[13px] text-ctp-text">No group projects yet.</p>
        <p className={settingsHelp}>Give agents a shared board and coordinate work. Create one for a project or for the whole app.</p>
        {!creating && <Button kind="primary" onClick={() => setCreating(true)}>Create group project</Button>}
      </div>
    );
  } else {
    body = (
      <div className="mt-4 flex flex-col gap-1">
        <div className="flex items-center gap-3 mb-2">
          <input
            type="search"
            aria-label="Search group projects"
            placeholder="Search groups"
            className={`${settingsInput} flex-1 min-w-0`}
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
          />
          {searching && <Button onClick={() => onQueryChange('')}>Clear search</Button>}
        </div>
        <p role="status" className={settingsHelp}>
          {directory.shown} {directory.shown === 1 ? 'group project' : 'group projects'}
          {directory.hiddenByView > 0 && (
            <>. {directory.hiddenByView} other {directory.hiddenByView === 1 ? 'group is' : 'groups are'} not shown. </>
          )}
          {directory.hiddenByView > 0 && (
            <button type="button" className="underline cursor-pointer focus-ring rounded" onClick={() => onViewChange(all)}>Show all groups</button>
          )}
        </p>
        {coverageFailed && <p role="status" className={settingsHelp}>Coverage could not be read. Copies from other computers show as not verified.</p>}
        {view.kind === 'project' && !directory.sections.some((s) => s.key === `project:${view.projectId}`) && !searching && (
          <p className="text-[13px] text-ctp-text mt-2">No group projects just for {lensName}.</p>
        )}
        {directory.shown === 0 && searching && <p className={`${settingsHelp} mt-2`}>No matches.</p>}
        {directory.sections.map((section) => (
          <section key={section.key} className="mt-4" aria-label={section.heading}>
            <h3 className="text-[13px] font-semibold text-ctp-text px-2.5">{section.heading}</h3>
            {section.note && <p className={`${settingsHelp} px-2.5`}>{section.note}</p>}
            <ul aria-label={`${section.heading} group projects`} className="flex flex-col gap-1 mt-1">
              {section.groups.map((group) => (
                <GroupRow key={group.id} project={group} projects={projects} coverage={coverage} onOpen={onOpenGroup} />
              ))}
            </ul>
          </section>
        ))}
      </div>
    );
  }

  return (
    <SettingsPage title={title} description={description} actions={actions} testId="group-projects-hub">
      {creating && (
        <CreateGroupProjectForm
          defaultScope={view.kind === 'project' ? { level: 'project', projectId: view.projectId, reach: 'local' } : undefined}
          onCreated={(created) => { setCreating(false); onOpenGroup(created.id); }}
          onCancel={() => setCreating(false)}
        />
      )}
      {body}
    </SettingsPage>
  );
}
