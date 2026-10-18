import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Agent, AgentDetailedStatus, CompletedQuickAgent, Project } from '../../../shared/types';
import { useChromeStore, foldKey, type ProjectFold } from '../chromeStore';
import { ProjectGroup } from './ProjectGroup';
import { moveProject, orderProjects } from './treeModel';
import { partitionIdle } from '../projectActivity';
import { reportChromeFeature } from '../telemetry';
import { Tooltip } from '../../components/Tooltip';

/**
 * The project tree (docs/chrome-redesign-spec.md §2, §4.2): pinned projects
 * first, then active ones in saved order, then one "N idle projects" row.
 * Projects collapse one by one or all at once, and reorder by drag or by Move
 * up / Move down in the project menu, within their section.
 *
 * Keyboard (§4.8): a tree with one tab stop (roving tabindex). Up and Down
 * move, Home and End jump, Right expands or steps in, Left collapses or steps
 * out to the parent, Enter opens, Shift+F10 opens the row's menu.
 */

const EMPTY_COMPLETED: CompletedQuickAgent[] = [];
const IDLE_KEY = 'idle';

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
  onOpenTerminal?: (agent: Agent) => void;
  /** Projects with the Terminal tab enabled; the hover card offers Open terminal only there. */
  terminalProjectIds?: ReadonlySet<string>;
  onSelectCompleted: (projectId: string, completedId: string) => void;
  onDismissCompleted: (projectId: string, completedId: string) => void;
  onClearCompleted: (projectId: string) => void;
  /** Absent on a satellite host. */
  onOpenSettings?: (projectId: string) => void;
  onReorderAgents?: (projectId: string, orderedIds: string[]) => void;
}

const CollapseAllIcon = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M7 15l5-5 5 5M7 9l5-5 5 5" />
  </svg>
);

const Chevron = ({ open }: { open: boolean }) => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
    style={{ transform: open ? 'rotate(90deg)' : undefined, transition: 'transform 120ms' }}>
    <path d="M9 6l6 6-6 6" />
  </svg>
);

/** Arrow-key handling for the tree, on the DOM order of its treeitems. */
export function useTreeKeyboard(treeRef: React.RefObject<HTMLDivElement | null>, selectedKey: string | null) {
  const focusKey = useRef<string | null>(null);

  const items = useCallback(
    () => [...(treeRef.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [])],
    [treeRef],
  );

  // One tab stop: the last focused item, else the selection, else the first item.
  // Applied to the DOM directly so memoized rows don't re-render on focus moves.
  const applyTabStop = useCallback(() => {
    const all = items();
    const want = [focusKey.current, selectedKey].find((k) => k && all.some((el) => el.dataset.treeKey === k));
    all.forEach((el, i) => { el.tabIndex = (want ? el.dataset.treeKey === want : i === 0) ? 0 : -1; });
  }, [items, selectedKey]);
  useLayoutEffect(applyTabStop);

  const focus = (el: HTMLElement | undefined) => {
    if (!el) return;
    focusKey.current = el.dataset.treeKey ?? null;
    applyTabStop();
    el.focus();
  };

  const onFocus = (e: React.FocusEvent) => {
    const item = (e.target as HTMLElement).closest<HTMLElement>('[role="treeitem"]');
    if (item?.dataset.treeKey && item.dataset.treeKey !== focusKey.current) {
      focusKey.current = item.dataset.treeKey;
      applyTabStop();
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const target = e.target as HTMLElement;
    if (target.getAttribute('role') !== 'treeitem') return;
    const all = items();
    const at = all.indexOf(target);
    const expanded = target.getAttribute('aria-expanded');
    const move = (el: HTMLElement | undefined) => { e.preventDefault(); focus(el); };
    switch (e.key) {
      case 'ArrowDown': return move(all[at + 1]);
      case 'ArrowUp': return move(all[at - 1]);
      case 'Home': return move(all[0]);
      case 'End': return move(all[all.length - 1]);
      case 'ArrowRight':
        e.preventDefault();
        if (expanded === 'false') (target.hasAttribute('data-tree-toggle') ? target : target.querySelector<HTMLElement>('[data-tree-toggle]'))?.click();
        // Step in only if there is a child: an expanded project with no agents stays put.
        else if (expanded === 'true' && all[at + 1]?.dataset.treeParent === target.dataset.treeKey) focus(all[at + 1]);
        return;
      case 'ArrowLeft': {
        e.preventDefault();
        if (expanded === 'true') {
          (target.hasAttribute('data-tree-toggle') ? target : target.querySelector<HTMLElement>('[data-tree-toggle]'))?.click();
          return;
        }
        const parent = target.dataset.treeParent;
        if (parent) focus(all.find((el) => el.dataset.treeKey === parent));
        return;
      }
    }
  };

  return { onKeyDown, onFocus };
}

export function ProjectTree(props: ProjectTreeProps) {
  const { projects, projectIcons, agentsByProject, detailed, completedByProject, activeProjectId, activeAgentId, selectedCompletedId, onReorder } = props;
  const pinnedProjectIds = useChromeStore((s) => s.pinnedProjectIds);
  const collapsedProjectIds = useChromeStore((s) => s.collapsedProjectIds);
  const expandedFolds = useChromeStore((s) => s.expandedFolds);
  const projectActivity = useChromeStore((s) => s.projectActivity);
  const idleDays = useChromeStore((s) => s.idleDays);
  const idleOpen = useChromeStore((s) => s.idleOpen);
  const toggleIdleOpen = useChromeStore((s) => s.toggleIdleOpen);
  const togglePinned = useChromeStore((s) => s.togglePinned);
  const toggleProjectCollapsed = useChromeStore((s) => s.toggleProjectCollapsed);
  const toggleCollapseAll = useChromeStore((s) => s.toggleCollapseAll);
  const toggleFold = useChromeStore((s) => s.toggleFold);

  const runningIds = useMemo(() => new Set(
    Object.entries(agentsByProject).filter(([, list]) => list.some((a) => a.status === 'running')).map(([id]) => id),
  ), [agentsByProject]);
  const { pinned, rest } = useMemo(() => orderProjects(projects, pinnedProjectIds), [projects, pinnedProjectIds]);
  const { active, idle } = useMemo(() => partitionIdle(rest, {
    activity: projectActivity, pinnedIds: pinnedProjectIds, runningIds, activeProjectId, idleDays, now: Date.now(),
  }), [rest, projectActivity, pinnedProjectIds, runningIds, activeProjectId, idleDays]);

  const collapsedSet = useMemo(() => new Set(collapsedProjectIds), [collapsedProjectIds]);
  const foldSet = useMemo(() => new Set(expandedFolds), [expandedFolds]);
  const projectIds = useMemo(() => projects.map((p) => p.id), [projects]);
  /** Which section each project is shown in; drags and moves stay inside it. */
  const sectionOf = useMemo(() => {
    const map = new Map<string, 'pinned' | 'active' | 'idle'>();
    pinned.forEach((p) => map.set(p.id, 'pinned'));
    active.forEach((p) => map.set(p.id, 'active'));
    idle.forEach((p) => map.set(p.id, 'idle'));
    return map;
  }, [pinned, active, idle]);
  /** Order as shown. Reordering works on this, so a drop lands where it looks like it will. */
  const displayIds = useMemo(() => [...pinned, ...active, ...idle].map((p) => p.id), [pinned, active, idle]);
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
      // Drops stay inside their section: pinned among pinned, and so on.
      if (!dragId || sectionOf.get(dragId) !== sectionOf.get(id)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setOverId(id);
    },
    onDrop: (e: React.DragEvent, id: string) => {
      e.preventDefault();
      const sameSection = !!dragId && sectionOf.get(dragId) === sectionOf.get(id);
      const next = dragId && sameSection ? moveProject(displayIds, dragId, id) : null;
      setDragId(null);
      setOverId(null);
      if (next) onReorder?.(next);
    },
    onDragEnd: () => { setDragId(null); setOverId(null); },
  }), [dragId, displayIds, sectionOf, onReorder]);

  /** Move up / Move down: the neighbour in the same section, as shown. */
  const neighbour = useCallback((id: string, direction: -1 | 1) => {
    const i = displayIds.indexOf(id);
    const other = displayIds[i + direction];
    return other && sectionOf.get(other) === sectionOf.get(id) ? other : null;
  }, [displayIds, sectionOf]);
  const onMoveProject = useCallback((id: string, direction: -1 | 1) => {
    const other = neighbour(id, direction);
    if (!other) return;
    const next = direction === -1 ? moveProject(displayIds, id, other) : moveProject(displayIds, other, id);
    if (next) {
      onReorder?.(next);
      reportChromeFeature('project_reorder');
    }
  }, [neighbour, displayIds, onReorder]);

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

  const treeRef = useRef<HTMLDivElement>(null);
  const selectedKey = props.projectScopeId && props.projectScopeId === activeProjectId
    ? `project:${props.projectScopeId}`
    : selectedCompletedId ? `finished:${selectedCompletedId}`
      : activeAgentId ? `agent:${activeAgentId}`
        : activeProjectId ? `project:${activeProjectId}` : null;
  const keyboard = useTreeKeyboard(treeRef, selectedKey);

  const renderGroup = (project: Project, underIdle = false) => (
    <ProjectGroup
      level={underIdle ? 2 : 1}
      parentKey={underIdle ? IDLE_KEY : undefined}
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
      onOpenTerminal={props.terminalProjectIds?.has(project.id) ? props.onOpenTerminal : undefined}
      onSelectCompleted={props.onSelectCompleted}
      onDismissCompleted={props.onDismissCompleted}
      onClearCompleted={props.onClearCompleted}
      dragHandlers={dragHandlers}
      dropIndicator={overId === project.id && dragId !== null && dragId !== project.id}
      onMoveProject={onReorder ? onMoveProject : undefined}
      canMoveUp={neighbour(project.id, -1) !== null}
      canMoveDown={neighbour(project.id, 1) !== null}
      onOpenSettings={props.onOpenSettings}
      onReorderAgents={props.onReorderAgents}
    />
  );

  return (
    <section aria-label="Projects" data-testid="agent-list" className="flex flex-col min-h-0">
      <div className="flex-shrink-0 flex items-center px-3 pt-2 pb-1 border-t border-surface-0">
        <span className="text-xs font-semibold text-ctp-subtext0">Projects</span>
        <span className="ml-auto text-xs text-ctp-overlay1">{projects.length}</span>
        <Tooltip content={allCollapsed ? 'Expand all projects' : 'Collapse all projects'}>
        <button
          type="button"
          data-testid="project-collapse-all"
          aria-label={allCollapsed ? 'Expand all projects' : 'Collapse all projects'}
          onClick={() => { toggleCollapseAll(projectIds); reportChromeFeature('project_collapse_all'); }}
          className="ml-1.5 w-6 h-6 rounded flex items-center justify-center text-ctp-subtext0 hover:bg-surface-0 hover:text-ctp-text cursor-pointer"
          style={allCollapsed ? { transform: 'rotate(180deg)' } : undefined}
        >
          {CollapseAllIcon}
        </button>
        </Tooltip>
      </div>
      <div
        ref={treeRef}
        role="tree"
        data-testid="project-tree"
        aria-label="Projects and agents"
        onKeyDown={keyboard.onKeyDown}
        onFocus={keyboard.onFocus}
        className="flex-1 min-h-0 overflow-y-auto pb-2 flex flex-col gap-px"
      >
        {pinned.map((p) => renderGroup(p))}
        {pinned.length > 0 && active.length > 0 && <div className="h-px mx-3 my-1 bg-surface-0 flex-shrink-0" role="separator" />}
        {active.map((p) => renderGroup(p))}
        {idle.length > 0 && (
          <>
            <Tooltip content={`No activity in ${idleDays} days`} disabled={idleDays <= 0} side="right">
            <button
              type="button"
              role="treeitem"
              aria-level={1}
              aria-expanded={idleOpen}
              data-tree-key={IDLE_KEY}
              data-tree-toggle
              data-testid="idle-projects"
              onClick={() => { toggleIdleOpen(); reportChromeFeature('idle_toggle'); }}
              className="h-7 mx-1.5 mt-1 px-1.5 rounded-md flex items-center gap-1.5 text-xs text-ctp-overlay1 hover:text-ctp-text hover:bg-surface-0/60 cursor-pointer focus-ring"
            >
              <Chevron open={idleOpen} />
              <span>{idle.length} idle project{idle.length === 1 ? '' : 's'}</span>
            </button>
            </Tooltip>
            {idleOpen && idle.map((p) => renderGroup(p, true))}
          </>
        )}
      </div>
    </section>
  );
}
