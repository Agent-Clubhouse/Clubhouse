import React, { useCallback, useMemo, useState } from 'react';
import type { Agent, AgentDetailedStatus, CompletedQuickAgent, Project } from '../../../shared/types';
import { useChromeStore, foldKey, type ProjectFold } from '../chromeStore';
import { ProjectGroup } from './ProjectGroup';
import { moveProject, orderProjects } from './treeModel';
import { reportChromeFeature } from '../telemetry';

/**
 * The project tree (docs/chrome-redesign-spec.md §4.2): pinned projects first,
 * then the rest in saved order. Projects collapse one by one or all at once,
 * and drag to reorder (written back through `reorderProjects`).
 */

const EMPTY_COMPLETED: CompletedQuickAgent[] = [];

export interface ProjectTreeProps {
  projects: Project[];
  projectIcons: Record<string, string>;
  agentsByProject: Record<string, Agent[]>;
  detailed: Record<string, AgentDetailedStatus>;
  completedByProject: Record<string, CompletedQuickAgent[]>;
  activeProjectId: string | null;
  activeAgentId: string | null;
  /** The project whose header is selected (project-root scope), if any. */
  projectScopeId: string | null;
  selectedCompletedId: string | null;
  /** Absent on a satellite host: its project order is not changed from here. */
  onReorder?: (orderedIds: string[]) => void;
  onSelectProject: (projectId: string) => void;
  onNewAgent?: (projectId: string) => void;
  onSelectAgent: (agent: Agent) => void;
  onSelectCompleted: (projectId: string, completedId: string) => void;
  onDismissCompleted: (projectId: string, completedId: string) => void;
  onClearCompleted: (projectId: string) => void;
}

const CollapseAllIcon = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M7 15l5-5 5 5M7 9l5-5 5 5" />
  </svg>
);

export function ProjectTree(props: ProjectTreeProps) {
  const { projects, projectIcons, agentsByProject, detailed, completedByProject, activeProjectId, activeAgentId, selectedCompletedId, onReorder } = props;
  const pinnedProjectIds = useChromeStore((s) => s.pinnedProjectIds);
  const collapsedProjectIds = useChromeStore((s) => s.collapsedProjectIds);
  const expandedFolds = useChromeStore((s) => s.expandedFolds);
  const togglePinned = useChromeStore((s) => s.togglePinned);
  const toggleProjectCollapsed = useChromeStore((s) => s.toggleProjectCollapsed);
  const toggleCollapseAll = useChromeStore((s) => s.toggleCollapseAll);
  const toggleFold = useChromeStore((s) => s.toggleFold);

  const { pinned, rest } = useMemo(() => orderProjects(projects, pinnedProjectIds), [projects, pinnedProjectIds]);
  const collapsedSet = useMemo(() => new Set(collapsedProjectIds), [collapsedProjectIds]);
  const foldSet = useMemo(() => new Set(expandedFolds), [expandedFolds]);
  const projectIds = useMemo(() => projects.map((p) => p.id), [projects]);
  const pinnedSet = useMemo(() => new Set(pinnedProjectIds), [pinnedProjectIds]);
  /** Order as shown: pinned first. Reordering works on this, so a drop lands where it looks like it will. */
  const displayIds = useMemo(() => [...pinned, ...rest].map((p) => p.id), [pinned, rest]);
  const allCollapsed = projectIds.length > 0 && projectIds.every((id) => collapsedSet.has(id));

  // Drag-to-reorder projects
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const dragHandlers = useMemo(() => ({
    onDragStart: (e: React.DragEvent, id: string) => {
      setDragId(id);
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', id);
    },
    onDragOver: (e: React.DragEvent, id: string) => {
      // Drops stay inside their section: pinned among pinned, the rest among the rest.
      if (!dragId || pinnedSet.has(dragId) !== pinnedSet.has(id)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setOverId(id);
    },
    onDrop: (e: React.DragEvent, id: string) => {
      e.preventDefault();
      const sameSection = !!dragId && pinnedSet.has(dragId) === pinnedSet.has(id);
      const next = dragId && sameSection ? moveProject(displayIds, dragId, id) : null;
      setDragId(null);
      setOverId(null);
      if (next) onReorder?.(next);
    },
    onDragEnd: () => { setDragId(null); setOverId(null); },
  }), [dragId, displayIds, pinnedSet, onReorder]);

  const onToggleFold = useCallback((projectId: string, fold: ProjectFold) => {
    toggleFold(projectId, fold);
    reportChromeFeature('fold_toggle');
  }, [toggleFold]);
  const onToggleCollapsed = useCallback((projectId: string) => {
    toggleProjectCollapsed(projectId);
    reportChromeFeature('project_collapse');
  }, [toggleProjectCollapsed]);
  const onTogglePinned = useCallback((projectId: string) => {
    togglePinned(projectId);
    reportChromeFeature('project_pin');
  }, [togglePinned]);

  const renderGroup = (project: Project) => (
    <ProjectGroup
      key={project.id}
      project={project}
      iconUrl={projectIcons[project.id]}
      agents={agentsByProject[project.id] ?? []}
      detailed={detailed}
      completed={completedByProject[project.id] ?? EMPTY_COMPLETED}
      collapsed={collapsedSet.has(project.id)}
      pinned={pinnedProjectIds.includes(project.id)}
      sleepingOpen={foldSet.has(foldKey(project.id, 'sleeping'))}
      finishedOpen={foldSet.has(foldKey(project.id, 'finished'))}
      activeProjectId={activeProjectId}
      activeAgentId={props.projectScopeId === project.id ? null : activeAgentId}
      headerSelected={props.projectScopeId === project.id && activeProjectId === project.id}
      selectedCompletedId={selectedCompletedId}
      onSelectProject={props.onSelectProject}
      onToggleCollapsed={onToggleCollapsed}
      onTogglePinned={onTogglePinned}
      onToggleFold={onToggleFold}
      onNewAgent={props.onNewAgent}
      draggable={!!onReorder}
      onSelectAgent={props.onSelectAgent}
      onSelectCompleted={props.onSelectCompleted}
      onDismissCompleted={props.onDismissCompleted}
      onClearCompleted={props.onClearCompleted}
      dragHandlers={dragHandlers}
      dropIndicator={overId === project.id && dragId !== null && dragId !== project.id}
    />
  );

  return (
    <section aria-label="Projects" data-testid="agent-list" className="flex flex-col min-h-0">
      <div className="flex-shrink-0 flex items-center px-3 pt-2 pb-1 border-t border-surface-0">
        <span className="text-xs font-semibold text-ctp-subtext0">Projects</span>
        <span className="ml-auto text-xs text-ctp-overlay1">{projects.length}</span>
        <button
          type="button"
          data-testid="project-collapse-all"
          title={allCollapsed ? 'Expand all projects' : 'Collapse all projects'}
          aria-label={allCollapsed ? 'Expand all projects' : 'Collapse all projects'}
          onClick={() => { toggleCollapseAll(projectIds); reportChromeFeature('project_collapse_all'); }}
          className="ml-1.5 w-6 h-6 rounded flex items-center justify-center text-ctp-subtext0 hover:bg-surface-0 hover:text-ctp-text cursor-pointer"
          style={allCollapsed ? { transform: 'rotate(180deg)' } : undefined}
        >
          {CollapseAllIcon}
        </button>
      </div>
      <div data-testid="project-tree" aria-label="Projects and agents" className="flex-1 min-h-0 overflow-y-auto pb-2 flex flex-col gap-px">
        {pinned.map(renderGroup)}
        {pinned.length > 0 && rest.length > 0 && <div className="h-px mx-3 my-1 bg-surface-0 flex-shrink-0" />}
        {rest.map(renderGroup)}
      </div>
    </section>
  );
}
