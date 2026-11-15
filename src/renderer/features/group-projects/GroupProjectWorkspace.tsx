import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import type { GroupProject } from '../../../shared/group-project-types';
import { Button } from '../../components/Button';
import { useGroupProjectStore } from '../../stores/groupProjectStore';
import { useProjectStore } from '../../stores/projectStore';
import { useGroupProjectContext, type GroupProjectContextValue } from '../../plugins/builtin/group-project/useGroupProjectContext';
import { GroupProjectBoard } from './board/GroupProjectBoard';
import { GroupProjectDefaultsPanel } from './board/GroupProjectDefaultsPanel';
import { GroupProjectActionsSection } from './GroupProjectActionsSection';
import { GroupProjectDeliverySection } from './GroupProjectDeliverySection';
import { GroupProjectDetailsSection } from './GroupProjectDetailsSection';
import { GroupProjectMemberToolsSection } from './GroupProjectMemberToolsSection';
import { GroupProjectMembersSection } from './GroupProjectMembersSection';
import { GroupProjectRolesSection } from './GroupProjectRolesSection';
import {
  GROUP_WORKSPACE_SECTIONS, resolveGroupWorkspaceRoute, type GroupWorkspaceSection,
} from './groupProjectRoute';
import type { GroupWorkspaceSource } from './groupWorkspaceSource';
import { GroupProjectLocations } from '../settings/GroupProjectLocations';
import { GroupProjectRefusals, hostLine } from '../settings/GroupProjectScopeFields';
import { SettingsBlock, SettingsSection, settingsError, settingsHelp } from '../settings/SettingsLayout';

const SECTION_LABELS: Record<GroupWorkspaceSection, string> = {
  board: 'Board',
  members: 'Members',
  permissions: 'Permissions',
  actions: 'Actions',
  delivery: 'Delivery',
  canvases: 'Canvases',
  details: 'Details',
};

/** Below this width the section list becomes a select, and the content keeps one column. */
const NARROW_WIDTH = 640;

export interface GroupProjectWorkspaceProps {
  /** The group project, by its stable id. */
  groupId: string;
  /** Absent means Board. */
  section?: GroupWorkspaceSection;
  /** Where the person came from; Back names it. Absent: the Group Projects hub. */
  source?: Pick<GroupWorkspaceSource, 'label'> | null;
  onBack: () => void;
  onSectionChange?: (section: GroupWorkspaceSection) => void;
}

/** What a group project covers, in a person's words. */
function scopeLabel(project: GroupProject, projectName: (id: string) => string | undefined): string {
  const scope = project.scope;
  if (!scope) return 'Scope unresolved';
  const covers = scope.level === 'app' ? 'App-wide' : projectName(scope.projectId) ?? 'A project that is not registered here';
  return `${covers}. ${scope.reach === 'network' ? 'Network' : 'This computer'}`;
}

/**
 * One group project's workspace: its Board first, then Members, Permissions,
 * Actions, Delivery, Canvases and Details. It needs no canvas, and it mounts
 * from any route: the Group Projects view, Settings, or a test.
 */
export function GroupProjectWorkspace(props: GroupProjectWorkspaceProps) {
  // Keyed on the group: moving to another group starts clean, so a draft for one can never be saved to the next.
  return <WorkspaceFor key={props.groupId} {...props} />;
}

function WorkspaceFor({ groupId, section, source, onBack, onSectionChange }: GroupProjectWorkspaceProps) {
  const requested = resolveGroupWorkspaceRoute({ groupId, section }).section;
  const [active, setActive] = useState<GroupWorkspaceSection>(requested);
  useEffect(() => { setActive(requested); }, [groupId, requested]);

  const loaded = useGroupProjectStore((s) => s.loaded);
  const loadError = useGroupProjectStore((s) => s.loadError);
  const loadProjects = useGroupProjectStore((s) => s.loadProjects);
  const projects = useProjectStore((s) => s.projects);
  const ctx = useGroupProjectContext(groupId, false, null, null);
  const project = ctx.project;

  useEffect(() => { if (!loaded) void loadProjects(); }, [loaded, loadProjects]);

  const rootRef = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) setNarrow(entry.contentRect.width < NARROW_WIDTH);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const projectName = useMemo(() => {
    const names = new Map(projects.map((p) => [p.id, p.displayName || p.name]));
    return (id: string) => names.get(id);
  }, [projects]);

  const choose = (next: GroupWorkspaceSection) => {
    setActive(next);
    onSectionChange?.(next);
  };

  const backLabel = `Back to ${source?.label ?? 'Group Projects'}`;
  const backButton = <Button kind="quiet" onClick={onBack}>{backLabel}</Button>;

  if (loadError && !project) {
    return (
      <div ref={rootRef} className="flex h-full flex-col bg-ctp-base px-6 py-4" data-testid="group-project-workspace">
        <div>{backButton}</div>
        <p role="alert" className={`${settingsError} mt-3`}>Could not load group projects. {loadError}</p>
        <div className="mt-2"><Button onClick={() => void loadProjects()}>Retry</Button></div>
      </div>
    );
  }

  if (!loaded) {
    return (
      <div ref={rootRef} className="flex h-full flex-col bg-ctp-base px-6 py-4" data-testid="group-project-workspace">
        <div>{backButton}</div>
        <p role="status" className={`${settingsHelp} mt-3`}>Loading group project...</p>
      </div>
    );
  }

  if (!project) {
    return (
      <div ref={rootRef} className="flex h-full flex-col bg-ctp-base px-6 py-4" data-testid="group-project-workspace">
        <div>{backButton}</div>
        <p role="alert" className={`${settingsError} mt-3`}>
          This group project is not on this computer. It may have been deleted on its host.
        </p>
      </div>
    );
  }

  return (
    <div ref={rootRef} className="flex h-full min-h-0 flex-col bg-ctp-base text-ctp-text" data-testid="group-project-workspace">
      <header className="flex-shrink-0 border-b border-surface-0 px-6 pt-3 pb-2">
        <div className="-ml-2.5">{backButton}</div>
        <h2 className="mt-1 text-lg font-semibold text-ctp-text break-words">{project.name}</h2>
        <p className={`${settingsHelp} break-words`} data-testid="group-project-workspace-summary">
          {scopeLabel(project, projectName)}. {hostLine(project)}
        </p>
      </header>
      <div className={`flex min-h-0 flex-1 ${narrow ? 'flex-col' : ''}`}>
        {narrow ? (
          <div className="flex-shrink-0 border-b border-surface-0 px-6 py-2">
            <label htmlFor="group-project-section-select" className="mr-2 text-xs text-ctp-overlay1">Section</label>
            <select
              id="group-project-section-select"
              className="h-7 rounded-md border border-surface-1 bg-ctp-crust px-2 text-xs text-ctp-text focus-ring"
              value={active}
              onChange={(event) => choose(event.target.value as GroupWorkspaceSection)}
            >
              {GROUP_WORKSPACE_SECTIONS.map((id) => <option key={id} value={id}>{SECTION_LABELS[id]}</option>)}
            </select>
          </div>
        ) : (
          <nav aria-label="Group project sections" className="w-40 flex-shrink-0 border-r border-surface-0 p-2">
            <ul className="flex flex-col gap-0.5">
              {GROUP_WORKSPACE_SECTIONS.map((id) => (
                <li key={id}>
                  <button
                    type="button"
                    aria-current={active === id ? 'page' : undefined}
                    onClick={() => choose(id)}
                    className={`h-7 w-full rounded-md px-2.5 text-left text-xs focus-ring hover:bg-surface-0 ${active === id ? 'bg-surface-1 text-ctp-text' : 'text-ctp-subtext1'}`}
                  >
                    {SECTION_LABELS[id]}
                  </button>
                </li>
              ))}
            </ul>
          </nav>
        )}
        <div className="min-h-0 min-w-0 flex-1" data-testid={`group-project-section-${active}`}>
          {active === 'board'
            ? (
              <div className="flex h-full min-h-0 flex-col">
                <RefusalsBand project={project} />
                <div className="min-h-0 flex-1">
                  <GroupProjectBoard groupProjectId={groupId} ctx={ctx} variant="workspace" />
                </div>
              </div>
            )
            : (
              <div className="h-full overflow-y-auto">
                <div className="max-w-[720px] px-6 pb-20">
                  <RefusalsBand project={project} />
                  <SectionBody section={active} project={project} ctx={ctx} />
                </div>
              </div>
            )}
        </div>
      </div>
    </div>
  );
}

function RefusalsBand({ project }: { project: GroupProject }) {
  return <div className="px-0"><GroupProjectRefusals project={project} /></div>;
}

function SectionBody({ section, project, ctx }: { section: GroupWorkspaceSection; project: GroupProject; ctx: GroupProjectContextValue }): ReactElement | null {
  switch (section) {
    case 'members': return <GroupProjectMembersSection groupProjectId={project.id} />;
    case 'permissions': return (
      <>
        <GroupProjectRolesSection groupProjectId={project.id} />
        <SettingsSection title="Default tool permissions">
          <SettingsBlock>
            <GroupProjectDefaultsPanel groupProjectId={project.id} ctx={ctx} includeText={false} />
          </SettingsBlock>
        </SettingsSection>
        <GroupProjectMemberToolsSection groupProjectId={project.id} />
      </>
    );
    case 'actions': return <GroupProjectActionsSection groupProjectId={project.id} />;
    case 'delivery': return <GroupProjectDeliverySection groupProjectId={project.id} />;
    case 'canvases': return <GroupProjectLocations id={project.id} />;
    case 'details': return <GroupProjectDetailsSection project={project} />;
    default: return null;
  }
}
