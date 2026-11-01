import React, { useCallback, useMemo, useRef, useState } from 'react';
import type { Agent, AgentDetailedStatus, CompletedQuickAgent, Project } from '../../../shared/types';
import { getAgentColorHex } from '../../../shared/name-generator';
import { AgentRow } from './AgentRow';
import { agentDot, buildProjectTree, countDescendants, helperRollup, localParentId, moveWithinGroup, projectRollup, siblingGroups, type AgentNode } from './treeModel';
import type { ProjectFold } from '../chromeStore';
import { PopupMenu, type MenuItem } from '../../components/PopupMenu';
import { reportChromeFeature } from '../telemetry';
import type { ActionDef } from '../../features/agents/useAgentRowActions';
import type { AgentDragHandlers } from './AgentRow';
import { useRefocusAfterMove } from './useRefocusAfterMove';
import { Tooltip } from '../../components/Tooltip';
import { TruncatedLabel } from '../../components/TruncatedLabel';
import { markdownToPlainText } from '../../utils/safe-markdown';
import { OtherProjectParentLine } from '../../features/agents/helpers/OtherProjectParentLine';

/**
 * One project in the sidebar tree: a header (chevron, square, name, roll-up,
 * hover actions) and, when expanded, its agents. Sleeping agents and finished
 * quick agents each fold into one row (docs/chrome-redesign-spec.md §2).
 *
 * Tree semantics (§4.8): the header, rows and folds are treeitems with a
 * data-tree-key; ProjectTree owns focus (roving tabindex) and the arrow keys.
 *
 * Helpers (#2231) nest under their parent agent at any depth, hanging off a
 * thin guide line from under the parent's status dot. The parent's caret
 * folds them away (remembered per agent), and a folded parent shows how many
 * helpers it has and whether any needs you or is working. A helper whose
 * orchestrator is in another project (#2514) is a root here, with a muted line
 * naming the orchestrator and its project; it never nests across projects.
 */

const Chevron = ({ open }: { open: boolean }) => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
    style={{ transform: open ? 'rotate(90deg)' : undefined, transition: 'transform 120ms' }}>
    <path d="M9 6l6 6-6 6" />
  </svg>
);

const PinIcon = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M9 3h6l-1 6 4 4H6l4-4zM12 13v8" />
  </svg>
);

const MoreIcon = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" /></svg>
);

const PlusIcon = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
);

export function ProjectSquare({ project, iconUrl }: { project: Project; iconUrl?: string }) {
  const label = project.displayName || project.name;
  const hex = getAgentColorHex(project.color);
  if (project.emoji) {
    return <span className="w-4 h-4 rounded flex-shrink-0 flex items-center justify-center text-xs" style={{ backgroundColor: `${hex}26` }} aria-hidden="true">{project.emoji}</span>;
  }
  if (project.icon && iconUrl) {
    return <img src={iconUrl} alt="" draggable={false} className="w-4 h-4 rounded flex-shrink-0 object-cover" />;
  }
  return (
    <span className="w-4 h-4 rounded flex-shrink-0 flex items-center justify-center text-xs font-bold leading-none" style={{ backgroundColor: `${hex}33`, color: hex }} aria-hidden="true">
      {label.charAt(0).toUpperCase()}
    </span>
  );
}

export interface ProjectGroupProps {
  project: Project;
  iconUrl?: string;
  agents: Agent[];
  detailed: Record<string, AgentDetailedStatus>;
  completed: CompletedQuickAgent[];
  collapsed: boolean;
  pinned: boolean;
  sleepingOpen: boolean;
  finishedOpen: boolean;
  activeProjectId: string | null;
  activeAgentId: string | null;
  /** The header itself is the selection (project-root scope). */
  headerSelected: boolean;
  selectedCompletedId: string | null;
  onSelectProject: (projectId: string) => void;
  onToggleCollapsed: (projectId: string) => void;
  onTogglePinned: (projectId: string) => void;
  onToggleFold: (projectId: string, fold: ProjectFold) => void;
  /** Absent for a satellite's projects, which can't be changed from here. */
  onNewAgent?: (projectId: string) => void;
  draggable?: boolean;
  onSelectAgent: (agent: Agent) => void;
  onOpenTerminal?: (agent: Agent) => void;
  onSelectCompleted: (projectId: string, completedId: string) => void;
  onDismissCompleted: (projectId: string, completedId: string) => void;
  onClearCompleted: (projectId: string) => void;
  dragHandlers: {
    onDragStart: (e: React.DragEvent, projectId: string) => void;
    onDragOver: (e: React.DragEvent, projectId: string) => void;
    onDrop: (e: React.DragEvent, projectId: string) => void;
    onDragEnd: () => void;
  };
  dropIndicator: boolean;
  /** Move up / Move down, the keyboard equivalents of dragging; absent where reordering isn't possible. */
  onMoveProject?: (projectId: string, direction: -1 | 1) => void;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
  /** Opens the project's settings; absent for a satellite's projects. */
  onOpenSettings?: (projectId: string) => void;
  /** Saves a new durable-agent order; absent for a satellite's projects. */
  onReorderAgents?: (projectId: string, orderedIds: string[]) => void;
  /** Projects are in Recent order, so Move up / Move down are replaced by a note saying so (#2116). */
  sortedByRecent?: boolean;
  /** The tree section the project is shown in; idle projects offer Mark active. */
  inSection?: 'pinned' | 'active' | 'idle';
  /** Mark inactive / Mark active (#2116); absent for a satellite's projects. */
  onSetInactive?: (projectId: string, inactive: boolean) => void;
  /** Agents are in Recent order: dragging a row says how to reorder instead (#2116). */
  onAgentReorderHint?: () => void;
  /** Tree depth of the header: 1, or 2 inside the idle row. */
  level?: number;
  /** Agents whose helpers are folded away (#2231). */
  collapsedAgentIds?: ReadonlySet<string>;
  onToggleAgentCollapsed?: (agentId: string) => void;
  /** The header's tree parent: the idle row, when it is inside it. */
  parentKey?: string;
}

const HEADER_INDENT = 6;
/** Drag data type for agent rows, so a project drop never mistakes one for a project. */
const AGENT_DRAG_TYPE = 'application/x-clubhouse-agent';
const ROW_INDENT = 26;
/** How much further in each level of helpers sits (#2231). */
const HELPER_INDENT = 18;
/** Half a row: where the guide line's tick meets a helper row. */
const ROW_MID = 15;
const NO_COLLAPSED: ReadonlySet<string> = new Set();

/**
 * The guide line beside one helper (#2231): a vertical stroke under the
 * parent's status dot, down to this helper's middle if it is the last one and
 * on past it otherwise, with a short tick into the row. A helper with its own
 * caret gets no tick; the caret sits where the tick would end.
 */
function GuideLine({ x, first, last, tick }: { x: number; first: boolean; last: boolean; tick: boolean }) {
  // The first stroke reaches up into the parent row, to just under its dot.
  const top = first ? -(ROW_MID - 4) : -1;
  return (
    <>
      <span
        aria-hidden="true"
        data-testid="helper-guide-line"
        className="absolute w-px bg-surface-2 pointer-events-none"
        style={{ left: x, top, ...(last ? { height: ROW_MID - top } : { bottom: 0 }) }}
      />
      {tick && <span aria-hidden="true" className="absolute h-px w-2.5 bg-surface-2 pointer-events-none" style={{ left: x, top: ROW_MID }} />}
    </>
  );
}

export const ProjectGroup = React.memo(function ProjectGroup(props: ProjectGroupProps) {
  const {
    project, iconUrl, agents, detailed, completed, collapsed, pinned, sleepingOpen, finishedOpen,
    activeProjectId, activeAgentId, headerSelected, selectedCompletedId,
    onSelectProject, onToggleCollapsed, onTogglePinned, onToggleFold, onNewAgent,
    onSelectAgent, onOpenTerminal, onSelectCompleted, onDismissCompleted, onClearCompleted, dragHandlers, dropIndicator, draggable = true,
    onMoveProject, canMoveUp, canMoveDown, onOpenSettings, onReorderAgents, level = 1, parentKey,
    sortedByRecent, inSection, onSetInactive, onAgentReorderHint,
  } = props;
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const armRefocus = useRefocusAfterMove();
  const projectKey = `project:${project.id}`;
  const label = project.displayName || project.name;
  const tree = useMemo(() => buildProjectTree(agents), [agents]);
  const collapsedAgents = props.collapsedAgentIds ?? NO_COLLAPSED;
  const { onToggleAgentCollapsed } = props;
  const rollup = projectRollup(agents, detailed);
  const isActiveProject = project.id === activeProjectId;
  /** Everyone in the sleeping fold, helpers included. */
  const sleepingCount = tree.sleeping.reduce((n, node) => n + 1 + countDescendants(node), 0);
  const expanded = !collapsed;

  // Reordering durable agents (§4.8): by drag, by Move up / Move down in the
  // row menu, or by Alt+Up / Alt+Down on the row. A move stays inside the
  // agent's group: the awake top-level agents, the sleeping ones, or one
  // parent's helpers (#2231), so a helper never changes parent by a drag. The
  // group's new order goes back into the saved order at the same places
  // (moveWithinGroup). Memoized on the order, sleep and parent links, so
  // memoized rows don't re-render on every status change.
  const durableKey = JSON.stringify(agents.filter((a) => a.kind === 'durable').map((a) => [a.id, a.status === 'sleeping', localParentId(a) ?? null]));
  const reorder = useMemo(() => {
    const entries = (JSON.parse(durableKey) as [string, boolean, string | null][]).map(([id, sleeping, parent]) => ({
      id, kind: 'durable' as const, status: sleeping ? 'sleeping' as const : 'running' as const, parentAgentId: parent ?? undefined,
    }));
    const order = entries.map((e) => e.id);
    const groupOf = new Map<string, string[]>();
    for (const group of siblingGroups(buildProjectTree(entries))) group.forEach((id) => groupOf.set(id, group));
    const move = (draggedId: string, targetId: string): boolean => {
      const group = groupOf.get(draggedId);
      if (!onReorderAgents || !group || groupOf.get(targetId) !== group) return false;
      const next = moveWithinGroup(order, group, draggedId, targetId);
      if (next) onReorderAgents(project.id, next);
      return next !== null;
    };
    const actions = new Map<string, ActionDef[]>();
    if (onReorderAgents) {
      for (const [id, group] of groupOf) {
        const i = group.indexOf(id);
        const list: ActionDef[] = [];
        if (i > 0) list.push({ id: 'move-up', label: 'Move up', icon: null, hoverColor: '', visible: true, handler: () => { move(id, group[i - 1]); } });
        if (i < group.length - 1) list.push({ id: 'move-down', label: 'Move down', icon: null, hoverColor: '', visible: true, handler: () => { move(id, group[i + 1]); } });
        actions.set(id, list);
      }
    }
    return { groupOf, move, actions };
  }, [durableKey, onReorderAgents, project.id]);
  const moveActions = (agent: Agent) => reorder.actions.get(agent.id);

  // Drag to reorder agents, with a line where the row will land. The ref is
  // the live drag (dragover must decide synchronously); the state draws the line.
  const agentDragRef = useRef<string | null>(null);
  const [agentDrag, setAgentDrag] = useState<{ id: string; overId: string | null } | null>(null);
  const agentDragHandlers = useMemo<AgentDragHandlers>(() => ({
    onDragStart: (e, id) => {
      e.stopPropagation();
      agentDragRef.current = id;
      setAgentDrag({ id, overId: null });
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData(AGENT_DRAG_TYPE, id);
    },
    onDragOver: (e, id) => {
      const dragged = agentDragRef.current;
      // Only within the dragged agent's own group.
      if (!dragged || dragged === id || reorder.groupOf.get(dragged) !== reorder.groupOf.get(id)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      setAgentDrag((drag) => (drag && drag.overId !== id ? { ...drag, overId: id } : drag));
    },
    onDrop: (e, id) => {
      const dragged = agentDragRef.current;
      if (!dragged) return;
      e.preventDefault();
      e.stopPropagation();
      agentDragRef.current = null;
      setAgentDrag(null);
      reorder.move(dragged, id);
    },
    onDragEnd: () => { agentDragRef.current = null; setAgentDrag(null); },
    onDragLeave: (_e, id) => setAgentDrag((drag) => (drag && drag.overId === id ? { ...drag, overId: null } : drag)),
  }), [reorder]);
  /** In Recent order a drag only explains how to reorder. */
  const hintDragHandlers = useMemo<AgentDragHandlers | undefined>(() => (onAgentReorderHint ? {
    onDragStart: (e) => { e.preventDefault(); e.stopPropagation(); onAgentReorderHint(); },
    onDragOver: () => {},
    onDrop: () => {},
    onDragEnd: () => {},
  } : undefined), [onAgentReorderHint]);

  /** Where the drop line goes: above the target when moving up, below it when moving down. */
  const dropEdge = useCallback((agentId: string): 'top' | 'bottom' | undefined => {
    if (!agentDrag || agentDrag.overId !== agentId) return undefined;
    const group = reorder.groupOf.get(agentId) ?? [];
    return group.indexOf(agentDrag.id) < group.indexOf(agentId) ? 'bottom' : 'top';
  }, [agentDrag, reorder]);

  const renderAgent = (agent: Agent, indent = ROW_INDENT, parentKey = projectKey, depth = 1, node?: AgentNode) => {
    const hasHelpers = !!node && node.children.length > 0;
    const folded = hasHelpers && collapsedAgents.has(agent.id);
    // Only a folded parent shows the roll-up, so only it walks its helpers.
    const rolled = folded ? helperRollup(node!, detailed) : undefined;
    return (
      <AgentRow
        key={agent.id}
        agent={agent}
        helperCount={rolled ? rolled.count : hasHelpers ? node!.children.length : undefined}
        helpersExpanded={hasHelpers ? !folded : undefined}
        helperNeeds={rolled?.needs}
        helperWorking={rolled?.working}
        onToggleHelpers={hasHelpers ? onToggleAgentCollapsed : undefined}
        dot={agentDot(agent, detailed[agent.id])}
        detailed={detailed[agent.id]}
        projectPath={project.path}
        onOpenTerminal={onOpenTerminal}
        active={agent.id === activeAgentId && isActiveProject}
        indent={indent}
        level={level + depth}
        parentKey={parentKey}
        extraActions={moveActions(agent)}
        onSelect={onSelectAgent}
        drag={reorder.actions.has(agent.id) && reorder.groupOf.get(agent.id)!.length > 1 ? agentDragHandlers
          : agent.kind === 'durable' ? hintDragHandlers : undefined}
        dropEdge={dropEdge(agent.id)}
      />
    );
  };

  /** An agent and, unless folded, its helpers on a guide line, each a level deeper. */
  const renderNode = (node: AgentNode, indent: number, parentKey: string, depth: number): React.ReactNode => {
    const { agent, children } = node;
    const open = children.length > 0 && !collapsedAgents.has(agent.id);
    return (
      <React.Fragment key={agent.id}>
        {renderAgent(agent, indent, parentKey, depth, node)}
        {/* Lines up with the avatar, after the 8px status dot and its gap. */}
        {agent.parentProjectPath && <OtherProjectParentLine agent={agent} paddingLeft={indent + 16} className="-mt-1 pb-1" />}
        {open && children.map((child, i) => (
          <div key={child.agent.id} data-testid={`helper-of-${agent.id}`} className="relative flex flex-col gap-px">
            {/* The line sits under the middle of the parent's 8px status dot. */}
            <GuideLine x={indent + 4} first={i === 0} last={i === children.length - 1} tick={child.children.length === 0} />
            {renderNode(child, indent + HELPER_INDENT, `agent:${agent.id}`, depth + 1)}
          </div>
        ))}
      </React.Fragment>
    );
  };

  const menuItems: MenuItem[] = [
    ...(onMoveProject ? [
      { id: 'move-up', label: 'Move up', disabled: !canMoveUp, onSelect: () => onMoveProject(project.id, -1) },
      { id: 'move-down', label: 'Move down', disabled: !canMoveDown, onSelect: () => onMoveProject(project.id, 1) },
    ] : sortedByRecent ? [
      { id: 'sorted-recent', label: 'Sorted by recent activity', disabled: true, onSelect: () => {} },
    ] : []),
    { id: 'pin', label: pinned ? 'Unpin' : 'Pin to top', onSelect: () => onTogglePinned(project.id) },
    // Pinned projects can't be marked inactive: unpin first (#2116).
    ...(onSetInactive && inSection === 'idle' ? [{ id: 'mark-active', label: 'Mark active', onSelect: () => onSetInactive(project.id, false) }]
      : onSetInactive && !pinned ? [{ id: 'mark-inactive', label: 'Mark inactive', onSelect: () => onSetInactive(project.id, true) }]
        : []),
    { id: 'collapse', label: expanded ? 'Collapse' : 'Expand', onSelect: () => onToggleCollapsed(project.id) },
    ...(onNewAgent ? [{ id: 'new-agent', label: 'New agent…', onSelect: () => onNewAgent(project.id) }] : []),
    ...(onOpenSettings ? [{ id: 'settings', label: 'Project settings', onSelect: () => onOpenSettings(project.id) }] : []),
  ];
  const openMenu = (x: number, y: number) => {
    setMenu({ x, y });
    reportChromeFeature('project_menu_open');
  };

  return (
    <div
      data-testid={`project-group-${project.id}`}
      className="relative flex flex-col"
      onDragOver={(e) => dragHandlers.onDragOver(e, project.id)}
      onDrop={(e) => dragHandlers.onDrop(e, project.id)}
    >
      {dropIndicator && <div className="absolute -top-px left-2 right-2 h-0.5 rounded-full bg-ctp-accent" />}
      <div
        role="treeitem"
        aria-level={level}
        aria-expanded={expanded}
        aria-selected={headerSelected}
        aria-label={label}
        data-tree-key={projectKey}
        data-tree-parent={parentKey}
        aria-keyshortcuts={onMoveProject ? 'Alt+ArrowUp Alt+ArrowDown' : undefined}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectProject(project.id); }
          else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
            // Alt+Up / Alt+Down: Move up / Move down, as for agent rows.
            e.preventDefault();
            e.stopPropagation();
            const up = e.key === 'ArrowUp';
            if (onMoveProject && (up ? canMoveUp : canMoveDown)) {
              armRefocus(e.currentTarget);
              onMoveProject(project.id, up ? -1 : 1);
            }
          } else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
            e.preventDefault();
            const r = e.currentTarget.getBoundingClientRect();
            openMenu(r.left + 24, r.bottom);
          }
        }}
        onContextMenu={(e) => { e.preventDefault(); openMenu(e.clientX, e.clientY); }}
        className={`group h-7 flex items-center rounded-md mx-1.5 focus-ring ${headerSelected ? 'bg-surface-0' : 'hover:bg-surface-0/60'}`}
        style={{ paddingLeft: HEADER_INDENT }}
        draggable={draggable}
        onDragStart={(e) => dragHandlers.onDragStart(e, project.id)}
        onDragEnd={dragHandlers.onDragEnd}
      >
        <button
          type="button"
          tabIndex={-1}
          data-tree-toggle
          aria-label={expanded ? `Collapse ${label}` : `Expand ${label}`}
          onClick={() => onToggleCollapsed(project.id)}
          className="w-5 h-5 flex-shrink-0 flex items-center justify-center text-ctp-overlay1 hover:text-ctp-text cursor-pointer"
        >
          <Chevron open={expanded} />
        </button>
        <button
          type="button"
          tabIndex={-1}
          data-testid={`project-${project.id}`}
          data-active={isActiveProject}
          aria-current={headerSelected ? 'true' : undefined}
          onClick={() => onSelectProject(project.id)}
          className="min-w-0 flex-1 h-full flex items-center gap-2 text-left cursor-pointer"
        >
          <ProjectSquare project={project} iconUrl={iconUrl} />
          <TruncatedLabel text={label} className={`text-[13px] font-semibold ${isActiveProject ? 'text-ctp-text' : 'text-ctp-subtext1'}`} />
        </button>
        {/* Actions show on hover and on keyboard focus anywhere in the header; the roll-up shows otherwise. */}
        <span className="flex-shrink-0 hidden group-hover:flex group-focus-within:flex items-center gap-1 pr-1.5 text-xs text-ctp-subtext0">
          <Tooltip content={pinned ? 'Unpin project' : 'Pin to top'}>
            <button
              type="button"
              tabIndex={-1}
              aria-label={pinned ? `Unpin ${label}` : `Pin ${label}`}
              aria-pressed={pinned}
              onClick={() => onTogglePinned(project.id)}
              className={`w-6 h-6 rounded flex items-center justify-center cursor-pointer hover:bg-surface-1 ${pinned ? 'text-ctp-text' : ''}`}
            >
              {PinIcon}
            </button>
          </Tooltip>
          {onNewAgent && (
            <Tooltip content="New agent">
              <button
                type="button"
                tabIndex={-1}
                aria-label={`New agent in ${label}`}
                onClick={() => onNewAgent(project.id)}
                className="w-6 h-6 rounded flex items-center justify-center cursor-pointer hover:bg-surface-1"
              >
                {PlusIcon}
              </button>
            </Tooltip>
          )}
          <Tooltip content="Project menu">
            <button
              type="button"
              tabIndex={-1}
              aria-label={`Menu for ${label}`}
              data-testid={`project-menu-button-${project.id}`}
              onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); openMenu(r.right, r.bottom); }}
              className="w-6 h-6 rounded flex items-center justify-center cursor-pointer hover:bg-surface-1"
            >
              {MoreIcon}
            </button>
          </Tooltip>
        </span>
        <span className="flex-shrink-0 flex group-hover:hidden group-focus-within:hidden items-center gap-1 pr-1.5 text-xs text-ctp-subtext0">
          {pinned && <span className="text-ctp-overlay0">pinned</span>}
          {rollup.working > 0 && <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-ctp-success" aria-hidden="true" />{rollup.working}<span className="sr-only"> working</span></span>}
          {rollup.waiting > 0 && <span className="flex items-center gap-1 text-ctp-warning"><span className="w-1.5 h-1.5 rounded-full bg-ctp-warning" aria-hidden="true" />{rollup.waiting}<span className="sr-only"> waiting on you</span></span>}
          {rollup.working === 0 && rollup.waiting === 0 && collapsed && agents.length > 0 && <span>{agents.length}</span>}
        </span>
      </div>

      {expanded && (
        <div className="flex flex-col gap-px px-1.5">
          {tree.awake.map((n) => renderNode(n, ROW_INDENT, projectKey, 1))}
          {tree.quick.map((a) => renderAgent(a))}

          {tree.sleeping.length > 0 && (
            <>
              <button
                type="button"
                role="treeitem"
                aria-level={level + 1}
                data-tree-key={`fold:${project.id}:sleeping`}
                data-tree-parent={projectKey}
                data-tree-toggle
                data-testid={`sleeping-fold-${project.id}`}
                aria-expanded={sleepingOpen}
                onClick={() => onToggleFold(project.id, 'sleeping')}
                className="h-[26px] flex items-center gap-1.5 rounded-md text-xs text-ctp-overlay1 hover:text-ctp-text cursor-pointer"
                style={{ paddingLeft: ROW_INDENT - 2 }}
              >
                <Chevron open={sleepingOpen} />
                <span>{sleepingCount} sleeping</span>
              </button>
              {sleepingOpen && tree.sleeping.map((n) => renderNode(n, ROW_INDENT + 12, `fold:${project.id}:sleeping`, 2))}
            </>
          )}

          {completed.length > 0 && (
            <>
              <div className="h-[26px] flex items-center gap-1.5 text-xs text-ctp-overlay1" style={{ paddingLeft: ROW_INDENT - 2 }}>
                <button
                  type="button"
                  role="treeitem"
                  aria-level={level + 1}
                  data-tree-key={`fold:${project.id}:finished`}
                  data-tree-parent={projectKey}
                  data-tree-toggle
                  data-testid={`finished-quick-${project.id}`}
                  aria-expanded={finishedOpen}
                  onClick={() => onToggleFold(project.id, 'finished')}
                  className="flex items-center gap-1.5 hover:text-ctp-text cursor-pointer"
                >
                  <Chevron open={finishedOpen} />
                  <span>{completed.length} finished quick agent{completed.length === 1 ? '' : 's'}</span>
                </button>
                {finishedOpen && (
                  <button type="button" onClick={() => onClearCompleted(project.id)} className="ml-auto pr-2 text-ctp-accent hover:underline cursor-pointer">
                    Clear all
                  </button>
                )}
              </div>
              {finishedOpen && completed.map((c) => (
                <div
                  key={c.id}
                  className={`group/finished h-[30px] flex items-center gap-2 pr-1 rounded-md ${selectedCompletedId === c.id ? 'bg-surface-0' : 'hover:bg-surface-0/60'}`}
                  style={{ paddingLeft: ROW_INDENT + 12 }}
                >
                  <button
                    type="button"
                    role="treeitem"
                    aria-level={level + 2}
                    aria-selected={selectedCompletedId === c.id}
                    data-tree-key={`finished:${c.id}`}
                    data-tree-parent={`fold:${project.id}:finished`}
                    data-testid={`finished-quick-row-${c.id}`}
                    onClick={() => onSelectCompleted(project.id, c.id)}
                    onKeyDown={(e) => { if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); onDismissCompleted(project.id, c.id); } }}
                    className="min-w-0 flex-1 h-full flex items-center gap-2 text-left cursor-pointer"
                  >
                    <span className={`w-2 h-2 rounded-full flex-shrink-0 ${c.exitCode === 0 ? 'bg-ctp-info' : 'bg-ctp-error'}`} aria-hidden="true" />
                    <span className="text-[13px] text-ctp-subtext1 truncate">{c.name}</span>
                    <TruncatedLabel text={(c.summary && markdownToPlainText(c.summary)) || c.mission || ''} className="text-xs text-ctp-overlay1 min-w-0" />
                  </button>
                  <Tooltip content="Dismiss">
                    <button
                      type="button"
                      tabIndex={-1}
                      aria-label={`Dismiss ${c.name}`}
                      onClick={() => onDismissCompleted(project.id, c.id)}
                      className="w-6 h-6 flex-shrink-0 rounded flex items-center justify-center text-ctp-overlay1 hover:text-ctp-text hover:bg-surface-1 cursor-pointer"
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12" /></svg>
                    </button>
                  </Tooltip>
                </div>
              ))}
            </>
          )}

          {agents.length === 0 && completed.length === 0 && (
            <div className="h-[26px] flex items-center text-xs text-ctp-overlay0" style={{ paddingLeft: ROW_INDENT }}>No agents yet</div>
          )}
        </div>
      )}
      {menu && <PopupMenu items={menuItems} position={menu} label={`${label} menu`} testId="project-menu" onClose={() => setMenu(null)} />}
    </div>
  );
});
