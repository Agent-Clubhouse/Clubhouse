import React from 'react';
import type { Agent, AgentDetailedStatus, CompletedQuickAgent, Project } from '../../../shared/types';
import { getAgentColorHex } from '../../../shared/name-generator';
import { AgentRow } from './AgentRow';
import { agentDot, groupProjectAgents, projectRollup } from './treeModel';
import type { ProjectFold } from '../chromeStore';

/**
 * One project in the sidebar tree: a header (chevron, square, name, roll-up,
 * hover actions) and, when expanded, its agents. Sleeping agents and finished
 * quick agents each fold into one row (docs/chrome-redesign-spec.md §2).
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

const PlusIcon = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
);

function ProjectSquare({ project, iconUrl }: { project: Project; iconUrl?: string }) {
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
}

const HEADER_INDENT = 6;
const ROW_INDENT = 26;

export const ProjectGroup = React.memo(function ProjectGroup(props: ProjectGroupProps) {
  const {
    project, iconUrl, agents, detailed, completed, collapsed, pinned, sleepingOpen, finishedOpen,
    activeProjectId, activeAgentId, headerSelected, selectedCompletedId,
    onSelectProject, onToggleCollapsed, onTogglePinned, onToggleFold, onNewAgent,
    onSelectAgent, onSelectCompleted, onDismissCompleted, onClearCompleted, dragHandlers, dropIndicator, draggable = true,
  } = props;
  const label = project.displayName || project.name;
  const groups = groupProjectAgents(agents);
  const rollup = projectRollup(agents, detailed);
  const isActiveProject = project.id === activeProjectId;
  const expanded = !collapsed;

  const renderAgent = (agent: Agent, indent = ROW_INDENT) => (
    <AgentRow
      key={agent.id}
      agent={agent}
      dot={agentDot(agent, detailed[agent.id])}
      active={agent.id === activeAgentId && isActiveProject}
      indent={indent}
      onSelect={onSelectAgent}
    />
  );

  return (
    <div
      data-testid={`project-group-${project.id}`}
      className="relative flex flex-col"
      onDragOver={(e) => dragHandlers.onDragOver(e, project.id)}
      onDrop={(e) => dragHandlers.onDrop(e, project.id)}
    >
      {dropIndicator && <div className="absolute -top-px left-2 right-2 h-0.5 rounded-full bg-ctp-accent" />}
      <div
        className={`group h-7 flex items-center rounded-md mx-1.5 ${headerSelected ? 'bg-surface-0' : 'hover:bg-surface-0/60'}`}
        style={{ paddingLeft: HEADER_INDENT }}
        draggable={draggable}
        onDragStart={(e) => dragHandlers.onDragStart(e, project.id)}
        onDragEnd={dragHandlers.onDragEnd}
      >
        <button
          type="button"
          aria-label={expanded ? `Collapse ${label}` : `Expand ${label}`}
          aria-expanded={expanded}
          onClick={() => onToggleCollapsed(project.id)}
          className="w-5 h-5 flex-shrink-0 flex items-center justify-center text-ctp-overlay1 hover:text-ctp-text cursor-pointer"
        >
          <Chevron open={expanded} />
        </button>
        <button
          type="button"
          data-testid={`project-${project.id}`}
          data-active={isActiveProject}
          aria-current={headerSelected ? 'true' : undefined}
          onClick={() => onSelectProject(project.id)}
          title={label}
          className="min-w-0 flex-1 h-full flex items-center gap-2 text-left cursor-pointer"
        >
          <ProjectSquare project={project} iconUrl={iconUrl} />
          <span className={`text-[13px] font-semibold truncate ${isActiveProject ? 'text-ctp-text' : 'text-ctp-subtext1'}`}>{label}</span>
        </button>
        {/* Actions show on hover and on keyboard focus anywhere in the header; the roll-up shows otherwise. */}
        <span className="flex-shrink-0 hidden group-hover:flex group-focus-within:flex items-center gap-1 pr-1.5 text-xs text-ctp-subtext0">
          <button
            type="button"
            title={pinned ? 'Unpin project' : 'Pin to top'}
            aria-label={pinned ? `Unpin ${label}` : `Pin ${label}`}
            aria-pressed={pinned}
            onClick={() => onTogglePinned(project.id)}
            className={`w-6 h-6 rounded flex items-center justify-center cursor-pointer hover:bg-surface-1 ${pinned ? 'text-ctp-text' : ''}`}
          >
            {PinIcon}
          </button>
          {onNewAgent && (
            <button
              type="button"
              title="New agent"
              aria-label={`New agent in ${label}`}
              onClick={() => onNewAgent(project.id)}
              className="w-6 h-6 rounded flex items-center justify-center cursor-pointer hover:bg-surface-1"
            >
              {PlusIcon}
            </button>
          )}
        </span>
        <span className="flex-shrink-0 flex group-hover:hidden group-focus-within:hidden items-center gap-1 pr-1.5 text-xs text-ctp-subtext0">
          {pinned && <span className="text-ctp-overlay0">pinned</span>}
          {rollup.working > 0 && <span className="flex items-center gap-1" title={`${rollup.working} working`}><span className="w-1.5 h-1.5 rounded-full bg-ctp-success" />{rollup.working}</span>}
          {rollup.waiting > 0 && <span className="flex items-center gap-1 text-ctp-warning" title={`${rollup.waiting} waiting on you`}><span className="w-1.5 h-1.5 rounded-full bg-ctp-warning" />{rollup.waiting}</span>}
          {rollup.working === 0 && rollup.waiting === 0 && collapsed && agents.length > 0 && <span>{agents.length}</span>}
        </span>
      </div>

      {expanded && (
        <div className="flex flex-col gap-px px-1.5">
          {groups.durable.map((a) => renderAgent(a))}
          {groups.quick.map((a) => renderAgent(a))}

          {groups.sleeping.length > 0 && (
            <>
              <button
                type="button"
                data-testid={`sleeping-fold-${project.id}`}
                aria-expanded={sleepingOpen}
                onClick={() => onToggleFold(project.id, 'sleeping')}
                className="h-[26px] flex items-center gap-1.5 rounded-md text-xs text-ctp-overlay1 hover:text-ctp-text cursor-pointer"
                style={{ paddingLeft: ROW_INDENT - 2 }}
              >
                <Chevron open={sleepingOpen} />
                <span>{groups.sleeping.length} sleeping</span>
              </button>
              {sleepingOpen && groups.sleeping.map((a) => renderAgent(a, ROW_INDENT + 12))}
            </>
          )}

          {completed.length > 0 && (
            <>
              <div className="h-[26px] flex items-center gap-1.5 text-xs text-ctp-overlay1" style={{ paddingLeft: ROW_INDENT - 2 }}>
                <button
                  type="button"
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
                    data-testid={`finished-quick-row-${c.id}`}
                    onClick={() => onSelectCompleted(project.id, c.id)}
                    title={c.summary || c.mission}
                    className="min-w-0 flex-1 h-full flex items-center gap-2 text-left cursor-pointer"
                  >
                    <span className={`w-2 h-2 rounded-full flex-shrink-0 ${c.exitCode === 0 ? 'bg-ctp-info' : 'bg-ctp-error'}`} aria-hidden="true" />
                    <span className="text-[13px] text-ctp-subtext1 truncate">{c.name}</span>
                    <span className="text-xs text-ctp-overlay1 truncate min-w-0">{c.summary || c.mission}</span>
                  </button>
                  <button
                    type="button"
                    title="Dismiss"
                    aria-label={`Dismiss ${c.name}`}
                    onClick={() => onDismissCompleted(project.id, c.id)}
                    className="w-6 h-6 flex-shrink-0 rounded flex items-center justify-center text-ctp-overlay1 hover:text-ctp-text hover:bg-surface-1 cursor-pointer"
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12" /></svg>
                  </button>
                </div>
              ))}
            </>
          )}

          {agents.length === 0 && completed.length === 0 && (
            <div className="h-[26px] flex items-center text-xs text-ctp-overlay0" style={{ paddingLeft: ROW_INDENT }}>No agents yet</div>
          )}
        </div>
      )}
    </div>
  );
});
